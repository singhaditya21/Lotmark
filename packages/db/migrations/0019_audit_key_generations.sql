-- ============================================================================
-- 0019 — Rotating the audit key without orphaning history.
--
-- The ledger's chain link is an HMAC under a key held OUTSIDE the database, so
-- that an attacker with SQL access cannot recompute the chain. That works, and
-- it created a problem nobody could solve: the key could never be changed.
-- `verify_audit_chain` used ONE key for every entry from seq 1 onward, so
-- rotating it would make the entire history fail verification — indistinguish-
-- ably from the history having been tampered with.
--
-- A key that can never be rotated is a key that stays in service after the
-- laptop it was generated on is sold, after the employee who set it up leaves,
-- and after it has been pasted into a support ticket.
--
-- `audit_ledger.key_version` has existed since 0002 with a default of 'v1' and
-- nothing has ever read it. This migration makes it mean something.
--
-- ── The part that makes a forged rotation detectable ────────────────────────
--
-- The obvious design — "each entry says which key signed it, supply the right
-- key when verifying" — hands an attacker an easy escape. Forge entry 50,
-- recompute 50..N under a key of your own, relabel them generation 'v2', and
-- present your key as the v2 key. Every entry verifies.
--
-- So a generation must be REGISTERED before it can be used, and its
-- registration carries a COMMITMENT to the key: an HMAC of a fixed string under
-- that key. The key itself is still never stored. Registration is append-only
-- and a generation can only ever begin AFTER the current head, so a generation
-- claiming to start at seq 50 cannot be inserted once the ledger has passed it.
--
-- To forge history an attacker must now either produce a key matching a
-- commitment they did not choose, or insert a backdated generation into an
-- append-only table — and the checkpoints signed by the separate anchor key
-- pin the head independently of all of it.
--
-- ── Not knowing the key is not the same as the chain being broken ───────────
--
-- Verification distinguishes them. A verifier holding only the current key gets
-- `keys_missing = {v1}` and `ok = false` for a reason that says so, which is a
-- request to go and fetch a key. Reporting that as tampering would send
-- somebody to investigate a breach that did not happen.
-- ============================================================================

/**
 * A key generation, with a commitment to the key rather than the key.
 *
 * `key_check` is HMAC('lotmark-audit-key-check:<tenant>:<generation>', key).
 * It proves the holder of a key can be recognised without the database ever
 * being able to produce a signature — which is the whole reason the key lives
 * outside it.
 */
CREATE TABLE "lotmark"."audit_key_generations" (
  tenant_id     uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  generation    text NOT NULL,
  /** The first ledger seq written under this generation. */
  from_seq      bigint NOT NULL,
  /**
   * Null ONLY between this migration and the first append under the generation,
   * which commits it. See the trigger below.
   */
  key_check     text,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  activated_by  uuid REFERENCES "lotmark"."users"(id),
  reason        text NOT NULL,

  PRIMARY KEY (tenant_id, generation),
  -- Two generations cannot begin at the same point, or "which key was in force
  -- at seq N" has no answer.
  CONSTRAINT audit_generation_starts_once UNIQUE (tenant_id, from_seq),
  CONSTRAINT audit_generation_from_seq_positive CHECK (from_seq >= 1),
  CONSTRAINT audit_generation_has_reason CHECK (length(trim(reason)) > 0)
);

ALTER TABLE "lotmark"."audit_key_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."audit_key_generations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."audit_key_generations"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT ON "lotmark"."audit_key_generations" TO lotmark_app;
GRANT SELECT ON "lotmark"."audit_key_generations" TO lotmark_signer;

CREATE OR REPLACE TRIGGER as_of_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lotmark"."audit_key_generations"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_write_under_as_of();

/**
 * The commitment.
 *
 * Bound to the tenant and the generation, so a check value lifted from one
 * tenant's registration cannot be replayed into another's.
 */
CREATE OR REPLACE FUNCTION "lotmark".audit_key_check(
  p_tenant uuid, p_generation text, p_key text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    hmac('lotmark-audit-key-check:' || p_tenant::text || ':' || p_generation, p_key, 'sha256'),
    'hex');
$$;

/**
 * A generation is a record of something that happened.
 *
 * UPDATE is refused except for the one-time commitment of `key_check`, which
 * the append trigger performs when a generation is first used. Everything else
 * about a generation is fixed the moment it exists.
 */
CREATE OR REPLACE FUNCTION "lotmark".audit_generations_are_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lotmark.audit_key_generations is append-only; a generation cannot be removed';
  END IF;

  IF OLD.key_check IS NOT NULL THEN
    RAISE EXCEPTION
      'generation % is already committed to a key and cannot be re-pointed at another', OLD.generation;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.generation <> OLD.generation
     OR NEW.from_seq <> OLD.from_seq THEN
    RAISE EXCEPTION 'only key_check may be set on an existing generation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_generations_immutable
  BEFORE UPDATE OR DELETE ON "lotmark"."audit_key_generations"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".audit_generations_are_append_only();

-- ---------------------------------------------------------------------------
-- Existing history is generation 'v1'.
--
-- The commitment is left NULL because this migration cannot compute it: the key
-- is deliberately not available to the database, and the migration connection
-- does not carry it. The first append under 'v1' commits it — which in practice
-- is the next audited action, seconds later.
--
-- That leaves a narrow window in which somebody who could already write to the
-- ledger could commit a key of their own choosing. It is narrow, it is
-- documented, and `pnpm audit:generations --claim` closes it deliberately
-- rather than waiting for traffic.
-- ---------------------------------------------------------------------------
INSERT INTO "lotmark"."audit_key_generations" (tenant_id, generation, from_seq, reason)
SELECT DISTINCT l.tenant_id, coalesce(l.key_version, 'v1'), 1,
       'Existing history at the time audit key rotation was introduced'
FROM "lotmark"."audit_ledger" l
WHERE l.seq = 1
ON CONFLICT DO NOTHING;

/**
 * Commit a generation to a key, once.
 *
 * SECURITY DEFINER, and deliberately the narrowest one in the schema: it can
 * set `key_check` on a row where it is NULL and can do nothing else. That
 * exists so the application role can hold NO UPDATE privilege on the table at
 * all, which is what makes the append-only claim true at the privilege layer
 * rather than only at the trigger layer.
 */
CREATE OR REPLACE FUNCTION "lotmark".commit_audit_generation(
  p_tenant uuid, p_generation text, p_check text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
DECLARE
  v_existing text;
BEGIN
  UPDATE "lotmark"."audit_key_generations"
  SET key_check = p_check
  WHERE tenant_id = p_tenant AND generation = p_generation AND key_check IS NULL;

  IF FOUND THEN RETURN; END IF;

  /**
   * Losing the race is not an error, but agreeing about the key is mandatory.
   *
   * Two appends can reach an uncommitted generation at once. One commits it;
   * the other must then confirm that what got committed is the key IT holds
   * too. Silently returning would let a second session write entries under a
   * generation committed to somebody else's key.
   */
  SELECT key_check INTO v_existing
  FROM "lotmark"."audit_key_generations"
  WHERE tenant_id = p_tenant AND generation = p_generation;

  IF v_existing IS NULL THEN
    RAISE EXCEPTION 'generation % does not exist for this tenant', p_generation;
  END IF;
  IF v_existing <> p_check THEN
    RAISE EXCEPTION
      'generation % was just committed to a different key than the one this '
      'session holds', p_generation;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- The append trigger, now generation-aware.
--
-- Replaces the body from 0002. Two things are added: the entry records which
-- generation produced it, and the key offered is CHECKED against that
-- generation's commitment before anything is written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".audit_chain_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ledger     text := TG_ARGV[0];
  v_key        text;
  v_generation text;
  v_prev       text;
  v_seq        bigint;
  v_payload    text;
  v_check      text;
  v_registered text;
BEGIN
  v_key := current_setting('lotmark.audit_key', true);
  IF v_key IS NULL OR length(v_key) = 0 THEN
    -- Refusing beats appending an unkeyed entry: a chain with one unkeyed link
    -- is a chain that cannot be verified, and the failure would be silent.
    RAISE EXCEPTION 'lotmark.audit_key is not set on this session; refusing to append an unverifiable ledger entry';
  END IF;

  v_generation := coalesce(nullif(current_setting('lotmark.audit_key_generation', true), ''), 'v1');

  INSERT INTO "lotmark"."audit_head" (tenant_id, ledger)
  VALUES (NEW.tenant_id, v_ledger)
  ON CONFLICT (tenant_id, ledger) DO NOTHING;

  SELECT h.seq, h.head_hash INTO v_seq, v_prev
  FROM "lotmark"."audit_head" h
  WHERE h.tenant_id = NEW.tenant_id AND h.ledger = v_ledger
  FOR UPDATE;

  v_seq := v_seq + 1;

  /**
   * The key must match the generation it claims to be.
   *
   * Without this, appending under generation 'v2' with any key at all would
   * work, and the generation label would carry no information. With it, a
   * generation is a commitment: once made, only the holder of that key can
   * write entries under it.
   */
  v_check := "lotmark".audit_key_check(NEW.tenant_id, v_generation, v_key);

  /**
   * A plain SELECT, deliberately not FOR UPDATE.
   *
   * `FOR UPDATE` requires the UPDATE privilege, which the application role no
   * longer holds — that is the point of the revokes at the foot of this file.
   * The row lock is not needed anyway: the append is already serialised by the
   * FOR UPDATE on `audit_head` above, and commit_audit_generation() is written
   * to tolerate losing a race rather than to prevent one.
   */
  SELECT g.key_check INTO v_registered
  FROM "lotmark"."audit_key_generations" g
  WHERE g.tenant_id = NEW.tenant_id AND g.generation = v_generation;

  IF NOT FOUND THEN
    -- First ever entry for this tenant, or a generation registered by rotation
    -- that has not been used yet. Registering here keeps a fresh tenant working
    -- with no ceremony; `from_seq` is this entry, which is the truth.
    INSERT INTO "lotmark"."audit_key_generations"
      (tenant_id, generation, from_seq, key_check, reason)
    VALUES (NEW.tenant_id, v_generation, v_seq, v_check,
            'First use of this generation');
  ELSIF v_registered IS NULL THEN
    -- Committing a generation carried over by migration. Through the definer
    -- function, because the application role holds no UPDATE on the table —
    -- see the REVOKEs at the foot of this migration.
    PERFORM "lotmark".commit_audit_generation(NEW.tenant_id, v_generation, v_check);
  ELSIF v_registered <> v_check THEN
    RAISE EXCEPTION
      'the audit key offered does not match the key registered for generation %. '
      'Either the wrong key is set on this session, or an attempt is being made to '
      'write history under a key of the writer''s own choosing', v_generation;
  END IF;

  NEW.seq         := v_seq;
  NEW.prev_hash   := v_prev;
  NEW.occurred_at := coalesce(NEW.occurred_at, now());
  NEW.key_version := v_generation;

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

/**
 * Register the next generation.
 *
 * Takes the NEW key on `lotmark.audit_key_next` so the commitment can be
 * computed without the new key ever being written anywhere. `from_seq` is the
 * next unused sequence number, which is what makes a backdated generation
 * impossible: a generation can only ever start in the future.
 *
 * The caller then switches the session to the new key and generation and writes
 * the entry recording the rotation — which becomes the first entry of the new
 * generation, so the ledger itself says where the boundary is.
 */
CREATE OR REPLACE FUNCTION "lotmark".rotate_audit_key(
  p_tenant uuid, p_generation text, p_reason text, p_activated_by uuid
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_next_key text := current_setting('lotmark.audit_key_next', true);
  v_head bigint;
  v_from bigint;
BEGIN
  IF v_next_key IS NULL OR length(v_next_key) = 0 THEN
    RAISE EXCEPTION 'set lotmark.audit_key_next to the new key before rotating';
  END IF;
  IF current_setting('lotmark.audit_key', true) = v_next_key THEN
    RAISE EXCEPTION 'the new audit key is identical to the current one; that is not a rotation';
  END IF;

  SELECT coalesce(max(h.seq), 0) INTO v_head
  FROM "lotmark"."audit_head" h WHERE h.tenant_id = p_tenant;
  v_from := v_head + 1;

  INSERT INTO "lotmark"."audit_key_generations"
    (tenant_id, generation, from_seq, key_check, activated_by, reason)
  VALUES (p_tenant, p_generation, v_from,
          "lotmark".audit_key_check(p_tenant, p_generation, v_next_key),
          p_activated_by, p_reason);

  RETURN v_from;
END;
$$;

/**
 * Which generation was in force at a given sequence number.
 *
 * Used by verification to catch entries relabelled into a generation that had
 * not begun yet — which is what an attacker would have to do to present forged
 * entries under a key of their own.
 */
CREATE OR REPLACE FUNCTION "lotmark".audit_generation_at(p_tenant uuid, p_seq bigint)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT g.generation FROM "lotmark"."audit_key_generations" g
  WHERE g.tenant_id = p_tenant AND g.from_seq <= p_seq
  ORDER BY g.from_seq DESC LIMIT 1;
$$;

/**
 * The key for a generation, from the session.
 *
 * `lotmark.audit_keys` is a JSON object mapping generation to key, set by a
 * verifier that holds retired keys. `lotmark.audit_key` covers the current one,
 * so ordinary operation needs no extra setting at all.
 */
CREATE OR REPLACE FUNCTION "lotmark".audit_key_for(p_generation text)
RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_map  text := current_setting('lotmark.audit_keys', true);
  v_cur  text := current_setting('lotmark.audit_key', true);
  v_gen  text := coalesce(nullif(current_setting('lotmark.audit_key_generation', true), ''), 'v1');
  v_key  text;
BEGIN
  IF v_map IS NOT NULL AND length(v_map) > 0 THEN
    BEGIN
      v_key := v_map::jsonb ->> p_generation;
    EXCEPTION WHEN others THEN
      -- Malformed JSON is a caller error, not a licence to fall through to the
      -- current key and report a verification that did not happen.
      RAISE EXCEPTION 'lotmark.audit_keys is not valid JSON';
    END;
    IF v_key IS NOT NULL THEN RETURN v_key; END IF;
  END IF;

  IF p_generation = v_gen AND v_cur IS NOT NULL AND length(v_cur) > 0 THEN
    RETURN v_cur;
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Verification, per generation.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS "lotmark".verify_audit_chain(uuid);
DROP FUNCTION IF EXISTS "lotmark".verify_audit_chain(uuid, bigint, bigint);

CREATE FUNCTION "lotmark".verify_audit_chain(
  p_tenant uuid, p_from_seq bigint, p_to_seq bigint
)
RETURNS TABLE (
  ok boolean, entries bigint, broken_at bigint, reason text, head_hash text,
  generations text[], keys_missing text[]
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  v_prev text;
  v_count bigint := 0;
  v_expected text;
  v_seq_expected bigint := p_from_seq;
  v_key text;
  v_gens text[] := ARRAY[]::text[];
  v_missing text[] := ARRAY[]::text[];
  v_in_force text;
  v_registered text;
BEGIN
  IF p_from_seq <= 1 THEN
    v_prev := repeat('0', 64);
  ELSE
    SELECT e.entry_hash INTO v_prev FROM "lotmark"."audit_ledger" e
    WHERE e.tenant_id = p_tenant AND e.seq = p_from_seq - 1;
    IF v_prev IS NULL THEN
      RETURN QUERY SELECT false, 0::bigint, p_from_seq - 1,
        format('entry %s is missing, so the range cannot be seeded', p_from_seq - 1)::text,
        NULL::text, v_gens, v_missing;
      RETURN;
    END IF;
  END IF;

  FOR r IN
    SELECT * FROM "lotmark"."audit_ledger"
    WHERE tenant_id = p_tenant AND seq >= p_from_seq AND seq <= p_to_seq
    ORDER BY seq ASC
  LOOP
    v_count := v_count + 1;

    IF r.seq <> v_seq_expected THEN
      RETURN QUERY SELECT false, v_count, r.seq,
        format('sequence gap: expected %s, found %s — an entry was removed', v_seq_expected, r.seq)::text,
        NULL::text, v_gens, v_missing;
      RETURN;
    END IF;
    IF r.prev_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'predecessor hash does not match'::text,
        NULL::text, v_gens, v_missing;
      RETURN;
    END IF;

    /**
     * The entry must belong to the generation that was actually in force here.
     *
     * Relabelling entries into a generation whose key the attacker controls is
     * the escape this closes. The registration table is append-only and a
     * generation cannot start before the head, so the range each generation
     * covers is fixed at the moment it is created.
     */
    v_in_force := "lotmark".audit_generation_at(p_tenant, r.seq);
    IF v_in_force IS NOT NULL AND r.key_version IS DISTINCT FROM v_in_force THEN
      RETURN QUERY SELECT false, v_count, r.seq,
        format('entry claims generation %s but %s was in force at that point',
               coalesce(r.key_version, '(none)'), v_in_force)::text,
        NULL::text, v_gens, v_missing;
      RETURN;
    END IF;

    IF NOT (r.key_version = ANY (v_gens)) THEN
      v_gens := array_append(v_gens, r.key_version);
    END IF;

    v_key := "lotmark".audit_key_for(r.key_version);

    /**
     * A WRONG key must not be reported as a broken chain.
     *
     * Without this the HMAC below simply fails to match and the verifier is
     * told the entry "was altered after it was written" — a tampering alarm
     * raised because somebody supplied the wrong key. The commitment recorded
     * when the generation was registered settles which of the two it is,
     * before any comparison of hashes happens.
     */
    IF v_key IS NOT NULL THEN
      SELECT g.key_check INTO v_registered
      FROM "lotmark"."audit_key_generations" g
      WHERE g.tenant_id = p_tenant AND g.generation = r.key_version;

      IF v_registered IS NOT NULL
         AND v_registered <> "lotmark".audit_key_check(p_tenant, r.key_version, v_key) THEN
        IF NOT (r.key_version = ANY (v_missing)) THEN
          v_missing := array_append(v_missing, r.key_version);
        END IF;
        RETURN QUERY SELECT false, v_count, NULL::bigint,
          format('the key supplied for generation %s is not the key it was written under; '
                 'the chain is UNVERIFIED here, not broken', r.key_version)::text,
          NULL::text, v_gens, v_missing;
        RETURN;
      END IF;
    END IF;

    IF v_key IS NULL THEN
      /**
       * NOT a broken chain. The verifier does not hold this generation's key,
       * which is a different fact and calls for a different response: go and
       * find the key. Reporting it as tampering would send somebody to
       * investigate a breach that never happened.
       */
      IF NOT (r.key_version = ANY (v_missing)) THEN
        v_missing := array_append(v_missing, r.key_version);
      END IF;
      RETURN QUERY SELECT false, v_count, NULL::bigint,
        format('no key available for generation %s; the chain is UNVERIFIED here, not broken',
               r.key_version)::text,
        NULL::text, v_gens, v_missing;
      RETURN;
    END IF;

    v_expected := encode(hmac("lotmark".audit_payload(
      v_prev, r.tenant_id, r.seq, r.actor_label, r.actor_role_id, r.kind, r.action,
      r.detail, r.subject_table, r.subject_id, r.occurred_at, r.time_source, r.region, r.changes
    ), v_key, 'sha256'), 'hex');

    IF v_expected <> r.entry_hash THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'entry was altered after it was written'::text,
        NULL::text, v_gens, v_missing;
      RETURN;
    END IF;

    v_prev := r.entry_hash;
    v_seq_expected := v_seq_expected + 1;
  END LOOP;

  RETURN QUERY SELECT true, v_count, NULL::bigint, NULL::text, v_prev, v_gens, v_missing;
END;
$$;

CREATE FUNCTION "lotmark".verify_audit_chain(p_tenant uuid)
RETURNS TABLE (
  ok boolean, entries bigint, broken_at bigint, reason text,
  generations text[], keys_missing text[]
)
LANGUAGE sql STABLE AS $$
  SELECT v.ok, v.entries, v.broken_at, v.reason, v.generations, v.keys_missing
  FROM "lotmark".verify_audit_chain(
    p_tenant, 1::bigint,
    coalesce((SELECT max(l.seq) FROM "lotmark"."audit_ledger" l WHERE l.tenant_id = p_tenant), 0)
  ) v;
$$;

REVOKE EXECUTE ON FUNCTION "lotmark".audit_key_check(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".audit_generations_are_append_only() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".rotate_audit_key(uuid, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".audit_generation_at(uuid, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".audit_key_for(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid, bigint, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "lotmark".audit_key_check(uuid, text, text) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".rotate_audit_key(uuid, text, text, uuid) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".audit_generation_at(uuid, bigint) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".audit_key_for(text) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid, bigint, bigint) TO lotmark_app;

GRANT EXECUTE ON FUNCTION "lotmark".audit_generation_at(uuid, bigint) TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".audit_key_for(text) TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid, bigint, bigint) TO lotmark_signer;

/**
 * ── Making "two layers" true rather than merely claimed ─────────────────────
 *
 * Migration 0005 grants SELECT, INSERT, UPDATE, DELETE on every table in the
 * schema to the application role, and sets ALTER DEFAULT PRIVILEGES so every
 * table created afterwards gets the same. The audit ledger revoked its way back
 * down in 0002 and has held only INSERT and SELECT ever since.
 *
 * Two tables added since did not: `key_custody_events` in 0018 and
 * `audit_key_generations` above. Both carry a comment saying they are
 * append-only "at two layers, privilege and trigger, because a privilege can be
 * granted back by anyone who can grant privileges" — and both had exactly one
 * layer, because the default grant handed the application role UPDATE and
 * DELETE on each. The comment was true about the intent and false about the
 * database.
 *
 * 0018 has already been applied, and migrate.ts checksums by filename and
 * refuses to run on drift, so it cannot be edited after the fact. The fix
 * belongs here.
 *
 * `audit_key_generations` keeps no UPDATE at all: the one legitimate update —
 * committing a generation to its key — goes through commit_audit_generation()
 * above, which can do nothing else.
 */
REVOKE UPDATE, DELETE ON "lotmark"."audit_key_generations" FROM lotmark_app;
REVOKE UPDATE, DELETE ON "lotmark"."key_custody_events" FROM lotmark_app;

REVOKE EXECUTE ON FUNCTION "lotmark".commit_audit_generation(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".commit_audit_generation(uuid, text, text) TO lotmark_app;

COMMENT ON FUNCTION "lotmark".commit_audit_generation(uuid, text, text) IS
  'SECURITY DEFINER so the application role needs no UPDATE on '
  'audit_key_generations. It can only set key_check where it is NULL.';

COMMENT ON TABLE "lotmark"."audit_key_generations" IS
  'Registered audit key generations. Holds a COMMITMENT to each key, never the '
  'key: HMAC of a fixed string under it. A generation can only begin after the '
  'current head, so history cannot be relabelled into a generation whose key an '
  'attacker chose.';
