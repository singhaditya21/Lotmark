-- ============================================================================
-- 0002 — The tamper-evident audit chain, and append-only enforcement.
--
-- The prototype chained a 32-bit FNV checksum. Anyone who could edit a row
-- could recompute every subsequent link and leave no trace, so the chain proved
-- nothing to anyone who did not already trust the data.
--
-- Here each entry is linked by HMAC-SHA256 under a key supplied per-session by
-- the application and never stored in the database. An attacker with full SQL
-- access can still delete or alter rows — nothing in a database can prevent
-- that — but they cannot produce a chain that verifies, which is what
-- 21 CFR 11 §11.10(e) and ISO 17034 §8.4 actually require.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- The chain head, one row per (tenant, ledger).
--
-- Separate from audit_ledger so the append can take a row lock on a single
-- known row rather than scanning for the maximum seq, which under concurrency
-- would let two transactions read the same predecessor and fork the chain.
-- ---------------------------------------------------------------------------
CREATE TABLE "lotmark"."audit_head" (
  tenant_id  uuid   NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  ledger     text   NOT NULL,
  seq        bigint NOT NULL DEFAULT 0,
  head_hash  text   NOT NULL DEFAULT repeat('0', 64),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ledger),
  CONSTRAINT audit_head_ledger_known CHECK (ledger IN ('audit', 'denial'))
);

-- ---------------------------------------------------------------------------
-- The canonical payload an entry commits to.
--
-- Length-prefixed, not delimiter-joined. With 'a|b' a field containing '|'
-- could impersonate a boundary and two different entries could hash
-- identically; length prefixes make that impossible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".lp(v text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT length(coalesce(v, '')) || ':' || coalesce(v, '');
$$;

-- Deterministic jsonb rendering, independent of server version.
CREATE OR REPLACE FUNCTION "lotmark".jsonb_canonical(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN j IS NULL THEN ''
    WHEN jsonb_typeof(j) <> 'object' THEN j::text
    ELSE coalesce(
      (SELECT string_agg("lotmark".lp(kv.key) || "lotmark".lp(kv.value::text), '' ORDER BY kv.key)
       FROM jsonb_each(j) AS kv), '')
  END;
$$;

CREATE OR REPLACE FUNCTION "lotmark".audit_payload(
  prev_hash text, tenant_id uuid, seq bigint, actor_label text, actor_role text,
  kind text, action text, detail text, subject_table text, subject_id text,
  occurred_at timestamptz, time_source text, region text, changes jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT "lotmark".lp(prev_hash)
      || "lotmark".lp(tenant_id::text)
      || "lotmark".lp(seq::text)
      || "lotmark".lp(actor_label)
      || "lotmark".lp(actor_role)
      || "lotmark".lp(kind)
      || "lotmark".lp(action)
      || "lotmark".lp(detail)
      || "lotmark".lp(subject_table)
      || "lotmark".lp(subject_id)
      -- Fixed ISO-8601 UTC rendering: the default text cast follows DateStyle,
      -- so a session with a different setting would hash the same instant
      -- differently and break verification for everyone else.
      || "lotmark".lp(to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      || "lotmark".lp(time_source)
      || "lotmark".lp(region)
      -- jsonb::text normalises key order within a major version but that is not
      -- a documented cross-version guarantee, and this chain must verify for a
      -- decade. Hash the sorted key/value pairs explicitly instead.
      || "lotmark".lp("lotmark".jsonb_canonical(changes));
$$;

-- ---------------------------------------------------------------------------
-- The append trigger.
--
-- BEFORE INSERT so it can assign seq, prev_hash and entry_hash on the row
-- itself. The head row is locked FOR UPDATE, which serialises concurrent
-- appends within a tenant and ledger without blocking other tenants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".audit_chain_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ledger    text := TG_ARGV[0];
  v_key       text;
  v_prev      text;
  v_seq       bigint;
  v_payload   text;
BEGIN
  v_key := current_setting('lotmark.audit_key', true);
  IF v_key IS NULL OR length(v_key) = 0 THEN
    -- Refusing beats appending an unkeyed entry: a chain with one unkeyed link
    -- is a chain that cannot be verified, and the failure would be silent.
    RAISE EXCEPTION 'lotmark.audit_key is not set on this session; refusing to append an unverifiable ledger entry';
  END IF;

  -- Seed the head on first use. The prototype-era bug this avoids: selecting a
  -- head that does not exist yet leaves seq at 1 and prev_hash at zero forever,
  -- so the chain never advances and every entry looks like the first.
  INSERT INTO "lotmark"."audit_head" (tenant_id, ledger)
  VALUES (NEW.tenant_id, v_ledger)
  ON CONFLICT (tenant_id, ledger) DO NOTHING;

  SELECT h.seq, h.head_hash INTO v_seq, v_prev
  FROM "lotmark"."audit_head" h
  WHERE h.tenant_id = NEW.tenant_id AND h.ledger = v_ledger
  FOR UPDATE;

  v_seq := v_seq + 1;

  NEW.seq       := v_seq;
  NEW.prev_hash := v_prev;
  NEW.occurred_at := coalesce(NEW.occurred_at, now());

  v_payload := "lotmark".audit_payload(
    v_prev, NEW.tenant_id, v_seq, NEW.actor_label, NEW.actor_role_id,
    NEW.kind, NEW.action, NEW.detail, NEW.subject_table, NEW.subject_id,
    NEW.occurred_at, NEW.time_source, NEW.region, NEW.changes
  );

  NEW.entry_hash := encode(hmac(v_payload, v_key, 'sha256'), 'hex');

  UPDATE "lotmark"."audit_head"
  SET seq = v_seq, head_hash = NEW.entry_hash, updated_at = now()
  WHERE tenant_id = NEW.tenant_id AND ledger = v_ledger;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_ledger_append
  BEFORE INSERT ON "lotmark"."audit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".audit_chain_append('audit');

-- ---------------------------------------------------------------------------
-- Append-only enforcement.
--
-- A trigger rather than only a REVOKE, because the migration runs as the owner
-- and table owners bypass their own grants. This refuses regardless of role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted. Record a new entry instead.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER audit_ledger_no_update BEFORE UPDATE ON "lotmark"."audit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
CREATE TRIGGER audit_ledger_no_delete BEFORE DELETE ON "lotmark"."audit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

-- A signature is never edited. Withdrawing a signed record is a new act with
-- its own entry, not a mutation of the signature that stands.
CREATE TRIGGER signatures_no_update BEFORE UPDATE ON "lotmark"."signatures"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
CREATE TRIGGER signatures_no_delete BEFORE DELETE ON "lotmark"."signatures"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

CREATE TRIGGER audit_checkpoints_no_delete BEFORE DELETE ON "lotmark"."audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

-- A published configuration version is immutable. Editing means a new draft.
CREATE OR REPLACE FUNCTION "lotmark".refuse_published_config_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'configuration version % is % and cannot be deleted', OLD.version_number, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  -- Only the draft -> active -> superseded walk is allowed on a published row.
  IF OLD.status <> 'draft'
     AND (NEW.version_number <> OLD.version_number
          OR NEW.change_reason <> OLD.change_reason
          OR NEW.created_by    <> OLD.created_by
          OR NEW.change_summary::text <> OLD.change_summary::text) THEN
    RAISE EXCEPTION 'configuration version % is published and immutable; create a new draft instead', OLD.version_number;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER config_versions_immutable_once_published
  BEFORE UPDATE OR DELETE ON "lotmark"."config_versions"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_published_config_change();

-- Entries of a published version cannot change either — that is where the
-- actual configuration lives, so an immutable header alone proves nothing.
CREATE OR REPLACE FUNCTION "lotmark".refuse_published_entry_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM "lotmark"."config_versions"
  WHERE id = COALESCE(NEW.version_id, OLD.version_id);
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'configuration entries can only be changed while the version is a draft (version is %)', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER config_entries_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lotmark"."config_entries"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_published_entry_change();

-- ---------------------------------------------------------------------------
-- Chain verification, callable from the application and from a job.
-- Returns the first broken seq, or NULL when the chain is intact.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".verify_audit_chain(p_tenant uuid)
RETURNS TABLE (ok boolean, entries bigint, broken_at bigint, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_key text := current_setting('lotmark.audit_key', true);
  r record;
  v_prev text := repeat('0', 64);
  v_count bigint := 0;
  v_expected text;
BEGIN
  IF v_key IS NULL OR length(v_key) = 0 THEN
    RETURN QUERY SELECT false, 0::bigint, NULL::bigint, 'lotmark.audit_key is not set'::text;
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM "lotmark"."audit_ledger"
    WHERE tenant_id = p_tenant ORDER BY seq ASC
  LOOP
    v_count := v_count + 1;

    IF r.seq <> v_count THEN
      RETURN QUERY SELECT false, v_count, r.seq,
        format('sequence gap: expected %s, found %s — an entry was removed', v_count, r.seq);
      RETURN;
    END IF;

    IF r.prev_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'predecessor hash does not match'::text;
      RETURN;
    END IF;

    v_expected := encode(hmac("lotmark".audit_payload(
      v_prev, r.tenant_id, r.seq, r.actor_label, r.actor_role_id, r.kind, r.action,
      r.detail, r.subject_table, r.subject_id, r.occurred_at, r.time_source, r.region, r.changes
    ), v_key, 'sha256'), 'hex');

    IF v_expected <> r.entry_hash THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'entry was altered after it was written'::text;
      RETURN;
    END IF;

    v_prev := r.entry_hash;
  END LOOP;

  RETURN QUERY SELECT true, v_count, NULL::bigint, NULL::text;
END;
$$;
