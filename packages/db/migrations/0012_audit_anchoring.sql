-- ============================================================================
-- 0012 — Audit anchoring: making the tamper-evidence argument non-circular.
--
-- Today audit_checkpoints exists, is never written, carries no signature, and
-- lives inside the database it is supposed to notarise. An attacker who can
-- rewrite the ledger can rewrite the checkpoints too, so the chain proves
-- ordering to somebody who already trusts the database and nothing to anybody
-- who does not.
--
-- An anchor breaks the circle: a signed statement about the ledger's state,
-- made by a key the application cannot read, chained to its predecessor, and
-- copied somewhere the database cannot reach.
--
-- WHAT THIS PROVES, precisely: that the ledger at anchor time contained exactly
-- the entries the anchor commits to. WHAT IT DOES NOT PROVE: anything about
-- entries written after the last anchor, which is why the anchor interval is
-- itself the exposure window and is reported.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Close the PUBLIC EXECUTE hole BEFORE creating any new role.
--
-- PostgreSQL grants EXECUTE on functions to PUBLIC by default. Verified on this
-- database: every SECURITY DEFINER function shows `=X/owner` in its ACL, which
-- is PUBLIC. It is currently unreachable only because USAGE ON SCHEMA lotmark
-- gates it — and the signer role created below needs exactly that USAGE.
--
-- Without this, lotmark_signer would silently gain EXECUTE on provision_tenant
-- and all_tenants: a role whose entire purpose is to be less privileged than
-- the application would be able to create tenants.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "lotmark" FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "lotmark" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- lotmark_app had EXECUTE only via ALL FUNCTIONS at 0005 and via PUBLIC. Make
-- it explicit, and set a default so a function added in a later migration does
-- not silently become uncallable by the application.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "lotmark" TO lotmark_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "lotmark" GRANT EXECUTE ON FUNCTIONS TO lotmark_app;

-- ---------------------------------------------------------------------------
-- 1. Keys have a PURPOSE.
--
-- signing_keys_one_active_per_tenant guarantees exactly one un-retired key per
-- tenant, and KeyProvider.active() relies on that guarantee without stating it:
-- no purpose filter, no ORDER BY, just LIMIT 1. Registering an anchor key under
-- the old index would make active() return it at random, and it would then look
-- for a private half the API deliberately does not hold — failing every
-- study:sign, value:authorise and cert:issue nondeterministically.
--
-- The index becomes per-purpose and the application filters explicitly.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."signing_keys"
  ADD COLUMN purpose text NOT NULL DEFAULT 'record',
  ADD CONSTRAINT signing_key_purpose_known CHECK (purpose IN ('record', 'anchor'));

DROP INDEX "lotmark"."signing_keys_one_active_per_tenant";
CREATE UNIQUE INDEX signing_keys_one_active_per_purpose
  ON "lotmark"."signing_keys" (tenant_id, purpose) WHERE retired_at IS NULL;

-- A verifier asking for a key by version must be told what it is FOR, or it
-- could check a record signature against an anchor key and report a failure it
-- cannot explain.
-- CREATE OR REPLACE cannot change a function's OUT parameters, so the old
-- signature is dropped first. Same name and arguments, so every caller is
-- unaffected — but note this briefly removes the function inside the migration
-- transaction, which is safe because migrations hold the lock throughout.
DROP FUNCTION IF EXISTS "lotmark".public_signing_key(text, text);

CREATE FUNCTION "lotmark".public_signing_key(p_tenant_name text, p_key_version text)
RETURNS TABLE (public_key_pem text, algorithm text, custody text, fingerprint text, purpose text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
  SELECT k.public_key_pem, k.algorithm, k.custody, k.fingerprint, k.purpose
  FROM "lotmark"."signing_keys" k
  JOIN "lotmark"."tenants" t ON t.id = k.tenant_id
  WHERE t.name = p_tenant_name AND k.key_version = p_key_version;
$$;
GRANT EXECUTE ON FUNCTION "lotmark".public_signing_key(text, text) TO lotmark_app;

-- ---------------------------------------------------------------------------
-- 2. The anchor itself.
--
-- audit_checkpoints already had through_seq, head_hash and entry_count. It
-- gains what makes it evidence: a Merkle root, a signature, the key that made
-- it, and a link to the previous anchor — so anchors form their own chain and
-- removing one is as visible as removing a ledger entry.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."audit_checkpoints"
  ADD COLUMN from_seq bigint,
  -- Merkle root over the segment's entry hashes. A head hash alone proves the
  -- segment's final state; a root additionally lets a holder prove ONE entry
  -- was included, without being shown the rest of the ledger.
  ADD COLUMN merkle_root text,
  ADD COLUMN signature text,
  ADD COLUMN key_version text,
  ADD COLUMN algorithm text NOT NULL DEFAULT 'ed25519',
  ADD COLUMN prev_checkpoint_signature text,
  -- What the signer actually signed, so a verifier reconstructs it exactly.
  ADD COLUMN signed_statement text;

ALTER TABLE "lotmark"."audit_checkpoints"
  ADD CONSTRAINT anchor_is_signed_or_absent CHECK (
    signature IS NULL
    OR (merkle_root IS NOT NULL AND key_version IS NOT NULL
        AND signed_statement IS NOT NULL AND from_seq IS NOT NULL)
  );

-- Truly immutable. The previous design set exported_at on the row afterwards,
-- which needs UPDATE — and refuse_mutation() raises for EVERY role, so that
-- column could never have been set by anyone. Exports move to their own
-- insert-only table instead, which keeps the anchor row genuinely unchangeable.
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE ON "lotmark"."audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

-- ---------------------------------------------------------------------------
-- 3. Exports, recorded separately.
--
-- An anchor only breaks the circle once a copy exists somewhere the database
-- cannot reach. Recording that fact is itself append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE "lotmark"."audit_checkpoint_exports" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  checkpoint_id uuid NOT NULL REFERENCES "lotmark"."audit_checkpoints"(id) ON DELETE RESTRICT,
  -- Where it went, and the digest of what was written there.
  target        text NOT NULL,
  content_sha256 text NOT NULL,
  exported_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id, target)
);

ALTER TABLE "lotmark"."audit_checkpoint_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."audit_checkpoint_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."audit_checkpoint_exports"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

CREATE TRIGGER audit_checkpoint_exports_no_update BEFORE UPDATE
  ON "lotmark"."audit_checkpoint_exports"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
CREATE TRIGGER audit_checkpoint_exports_no_delete BEFORE DELETE
  ON "lotmark"."audit_checkpoint_exports"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

-- ---------------------------------------------------------------------------
-- 4. The signer role.
--
-- Reads the ledger, writes anchors, and can do nothing else. The APPLICATION
-- loses INSERT on audit_checkpoints: if the component that writes the ledger
-- could also write the statements attesting to it, the attestation would be
-- worth exactly as much as the ledger.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotmark_signer') THEN
    CREATE ROLE lotmark_signer LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA "lotmark" TO lotmark_signer;
GRANT SELECT ON "lotmark"."audit_ledger"       TO lotmark_signer;
GRANT SELECT ON "lotmark"."audit_head"         TO lotmark_signer;
GRANT SELECT ON "lotmark"."tenants"            TO lotmark_signer;
GRANT SELECT ON "lotmark"."signing_keys"       TO lotmark_signer;
GRANT SELECT, INSERT ON "lotmark"."audit_checkpoints" TO lotmark_signer;
GRANT SELECT, INSERT ON "lotmark"."audit_checkpoint_exports" TO lotmark_signer;
-- It must enumerate tenants to anchor each one, and resolve nothing else.
GRANT EXECUTE ON FUNCTION "lotmark".all_tenants() TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".current_tenant() TO lotmark_signer;

-- The signer is not a superuser and not the owner, so RLS applies to it exactly
-- as it does to the application.
REVOKE INSERT, UPDATE, DELETE ON "lotmark"."audit_checkpoints" FROM lotmark_app;
REVOKE INSERT, UPDATE, DELETE ON "lotmark"."audit_checkpoint_exports" FROM lotmark_app;

-- ---------------------------------------------------------------------------
-- 5. Ranged verification.
--
-- verify_audit_chain(tenant) rescans from seq 1 every time, which is fine for a
-- demonstration and useless hourly on a real ledger. The ranged form lets a
-- verifier check only what has happened since the last anchor.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS "lotmark".verify_audit_chain(uuid, bigint, bigint);

CREATE FUNCTION "lotmark".verify_audit_chain(
  p_tenant uuid, p_from_seq bigint, p_to_seq bigint
)
RETURNS TABLE (ok boolean, entries bigint, broken_at bigint, reason text, head_hash text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_key text := current_setting('lotmark.audit_key', true);
  r record;
  v_prev text;
  v_count bigint := 0;
  v_expected text;
  v_seq_expected bigint := p_from_seq;
BEGIN
  IF v_key IS NULL OR length(v_key) = 0 THEN
    RETURN QUERY SELECT false, 0::bigint, NULL::bigint, 'lotmark.audit_key is not set'::text, NULL::text;
    RETURN;
  END IF;

  -- Starting mid-chain needs the predecessor's hash as the seed.
  IF p_from_seq <= 1 THEN
    v_prev := repeat('0', 64);
  ELSE
    SELECT e.entry_hash INTO v_prev FROM "lotmark"."audit_ledger" e
    WHERE e.tenant_id = p_tenant AND e.seq = p_from_seq - 1;
    IF v_prev IS NULL THEN
      RETURN QUERY SELECT false, 0::bigint, p_from_seq - 1,
        format('entry %s is missing, so the range cannot be seeded', p_from_seq - 1)::text, NULL::text;
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
        NULL::text;
      RETURN;
    END IF;
    IF r.prev_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'predecessor hash does not match'::text, NULL::text;
      RETURN;
    END IF;

    v_expected := encode(hmac("lotmark".audit_payload(
      v_prev, r.tenant_id, r.seq, r.actor_label, r.actor_role_id, r.kind, r.action,
      r.detail, r.subject_table, r.subject_id, r.occurred_at, r.time_source, r.region, r.changes
    ), v_key, 'sha256'), 'hex');

    IF v_expected <> r.entry_hash THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'entry was altered after it was written'::text, NULL::text;
      RETURN;
    END IF;

    v_prev := r.entry_hash;
    v_seq_expected := v_seq_expected + 1;
  END LOOP;

  RETURN QUERY SELECT true, v_count, NULL::bigint, NULL::text, v_prev;
END;
$$;

GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid, bigint, bigint) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid, bigint, bigint) TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".verify_audit_chain(uuid) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".audit_payload(text, uuid, bigint, text, text, text, text, text,
  text, text, timestamptz, text, text, jsonb) TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".lp(text) TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".jsonb_canonical(jsonb) TO lotmark_signer;
