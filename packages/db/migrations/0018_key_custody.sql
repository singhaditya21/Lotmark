-- ============================================================================
-- 0018 — Key custody: constrain it, and make every change to it accountable.
--
-- `signing_keys.custody` is PRINTED ON EVERY CERTIFICATE, immediately after the
-- key version, so that nobody mistakes a key file on a laptop for a hardware
-- module. It is the product's own statement about how well its signing keys are
-- protected.
--
-- Until now that column was unconstrained text with no CHECK of any kind. A
-- single UPDATE could set it to 'hsm' on a machine with no HSM, and every
-- certificate issued afterwards would carry that claim. The value most relied
-- upon to be honest was the one with the least protection behind it.
--
-- Two things change here:
--
--   1. The vocabulary becomes a CHECK constraint, so a custody class that does
--      not exist cannot be written at all.
--
--   2. Changing custody becomes a RECORDED act. A key moved from a file into
--      the Keychain is a real event with a before and an after, and it must be
--      as explicable years later as any other act in this system. A trigger
--      refuses a bare UPDATE, so the only way through is the function that
--      writes the record.
--
-- What this migration deliberately does NOT do is claim that better custody
-- classes are available. `kms` and `hsm` remain in the vocabulary because the
-- column must be able to express them, and the application refuses to select
-- them until something implements them.
-- ============================================================================

/**
 * The custody vocabulary.
 *
 * 'keychain' is new: the macOS Keychain, which on a development machine is a
 * genuine improvement over a mode-0600 file in the working tree. It is NOT
 * production key custody and the application does not pretend otherwise.
 */
ALTER TABLE "lotmark"."signing_keys"
  ADD CONSTRAINT signing_key_custody_known
  CHECK (custody IN ('dev_file', 'env', 'keychain', 'kms', 'hsm'));

/**
 * Every move of a key from one custody class to another.
 *
 * Append-only. `fingerprint` is recorded so the record proves the thing that
 * actually matters: moving custody must move the SAME key. A "migration" that
 * quietly minted a new key pair would invalidate every signature made under the
 * old one, and the fingerprint is what makes that visible rather than
 * discovered later by a verification failure.
 */
CREATE TABLE "lotmark"."key_custody_events" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  key_version   text NOT NULL,
  from_custody  text NOT NULL,
  to_custody    text NOT NULL,
  -- The same key on both sides, or this is not a custody move.
  fingerprint   text NOT NULL,
  moved_at      timestamptz NOT NULL DEFAULT now(),
  -- Null for a move made by tooling with no person behind it, exactly as the
  -- audit ledger records a job as 'system' rather than inventing a user.
  moved_by      uuid REFERENCES "lotmark"."users"(id),
  reason        text NOT NULL,

  CONSTRAINT custody_move_is_a_change CHECK (from_custody <> to_custody),
  CONSTRAINT custody_move_from_known
    CHECK (from_custody IN ('dev_file', 'env', 'keychain', 'kms', 'hsm')),
  CONSTRAINT custody_move_to_known
    CHECK (to_custody IN ('dev_file', 'env', 'keychain', 'kms', 'hsm')),
  CONSTRAINT custody_move_has_reason CHECK (length(trim(reason)) > 0)
);

CREATE INDEX key_custody_events_key_idx
  ON "lotmark"."key_custody_events" (tenant_id, key_version, moved_at);

ALTER TABLE "lotmark"."key_custody_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."key_custody_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."key_custody_events"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT ON "lotmark"."key_custody_events" TO lotmark_app;

/**
 * The custody history is a record, not a working table.
 *
 * Same reasoning as the audit ledger and the competence records: an event that
 * can be edited afterwards is not evidence of anything. Enforced at two layers,
 * privilege and trigger, because a privilege can be granted back by anyone who
 * can grant privileges.
 */
CREATE OR REPLACE FUNCTION "lotmark".key_custody_events_are_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'lotmark.key_custody_events is append-only; a custody move is a record of '
    'something that happened and cannot be revised';
END;
$$;

CREATE TRIGGER key_custody_events_no_update
  BEFORE UPDATE OR DELETE ON "lotmark"."key_custody_events"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".key_custody_events_are_append_only();

/**
 * Custody may only change through the function that records the change.
 *
 * The guard is a session setting rather than a role check, matching how
 * `lotmark.audit_key` and `lotmark.as_of` already work here: set inside the
 * function, local to the transaction, and therefore impossible to leave behind
 * on a pooled connection for the next borrower to inherit.
 */
CREATE OR REPLACE FUNCTION "lotmark".custody_change_must_be_recorded()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.custody IS DISTINCT FROM OLD.custody
     AND coalesce(current_setting('lotmark.custody_move', true), '') <> 'recording'
  THEN
    RAISE EXCEPTION
      'custody may not be changed by a direct UPDATE. Use '
      'lotmark.move_key_custody(), which records what moved, from where, to '
      'where, and why — the value is printed on every certificate this key signs';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_keys_custody_is_recorded
  BEFORE UPDATE ON "lotmark"."signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".custody_change_must_be_recorded();

/**
 * Move a key into a different custody class.
 *
 * Refuses if the key does not exist, if the class is unchanged, or if no reason
 * is given. Deliberately NOT SECURITY DEFINER: the caller must already be able
 * to see and update the key under row-level security, and a definer function
 * here would hand that ability to anyone who could call it.
 */
CREATE OR REPLACE FUNCTION "lotmark".move_key_custody(
  p_tenant uuid, p_key_version text, p_to_custody text,
  p_reason text, p_moved_by uuid
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_from text;
  v_fingerprint text;
BEGIN
  SELECT custody, fingerprint INTO v_from, v_fingerprint
  FROM "lotmark"."signing_keys"
  WHERE tenant_id = p_tenant AND key_version = p_key_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No signing key % for this tenant', p_key_version;
  END IF;

  IF v_from = p_to_custody THEN
    RAISE EXCEPTION 'Key % is already held as %', p_key_version, p_to_custody;
  END IF;

  -- The record first, so a failure of the constraint above leaves nothing
  -- half-done, and so the event exists even if the UPDATE then fails.
  INSERT INTO "lotmark"."key_custody_events"
    (tenant_id, key_version, from_custody, to_custody, fingerprint, moved_by, reason)
  VALUES (p_tenant, p_key_version, v_from, p_to_custody, v_fingerprint, p_moved_by, p_reason);

  PERFORM set_config('lotmark.custody_move', 'recording', true);
  UPDATE "lotmark"."signing_keys"
  SET custody = p_to_custody
  WHERE tenant_id = p_tenant AND key_version = p_key_version;
  PERFORM set_config('lotmark.custody_move', '', true);
END;
$$;

-- The tripwire in rls.test.ts: PUBLIC holds EXECUTE on new functions by
-- default, and ALTER DEFAULT PRIVILEGES does not retroactively cover them.
REVOKE EXECUTE ON FUNCTION "lotmark".move_key_custody(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".key_custody_events_are_append_only() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "lotmark".custody_change_must_be_recorded() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".move_key_custody(uuid, text, text, text, uuid) TO lotmark_app;

/**
 * The as-of read-only trigger, which every table in the schema carries.
 *
 * Migration 0014 swept the tables that existed then; a table added afterwards
 * has to attach it itself or a handler that strays into a write while the
 * session is reading history would succeed, producing a backdated record. The
 * test in as-of.test.ts checks every table and named this one the moment it
 * was created — which is the guard working.
 */
CREATE OR REPLACE TRIGGER as_of_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lotmark"."key_custody_events"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_write_under_as_of();

COMMENT ON TABLE "lotmark"."key_custody_events" IS
  'Append-only record of signing keys moving between custody classes. The '
  'fingerprint is recorded on both sides of the move so the record proves the '
  'same key moved, rather than a new one being minted.';
