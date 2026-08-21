-- ============================================================================
-- 0003 — Signing keys, signature integrity, and the state-transition history.
-- ============================================================================

ALTER TABLE "lotmark"."signing_keys"
  ADD CONSTRAINT signing_key_algorithm_known CHECK (algorithm IN ('ed25519'));

-- Exactly one key may be current per tenant. Two would make "which key signs
-- this" ambiguous, and a verifier could not tell a rotation from a compromise.
CREATE UNIQUE INDEX signing_keys_one_active_per_tenant
  ON "lotmark"."signing_keys" (tenant_id) WHERE retired_at IS NULL;

-- A retired key states why. Rotation and revocation look identical in the data
-- otherwise, and they are very different events during an investigation.
ALTER TABLE "lotmark"."signing_keys"
  ADD CONSTRAINT signing_key_retirement_states_reason CHECK (
    retired_at IS NULL OR retired_reason IS NOT NULL
  );

-- ── Signatures ─────────────────────────────────────────────────────────────

ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT signature_meaning_known CHECK (
    meaning IN ('authorship', 'review', 'approval', 'responsibility')
  );

ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT signature_subject_kind_known CHECK (
    subject_kind IN ('study', 'value', 'certificate', 'lot')
  );

-- A signature must carry its actual cryptographic value, not merely a digest.
-- The digest alone is what the prototype had, and it proved nothing.
ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT signature_has_a_value CHECK (
    signature_value IS NOT NULL AND length(signature_value) > 0
  );

-- The competence basis is frozen onto the signature, in full or not at all.
-- A half-copied basis cannot answer "was this person authorised on the day".
ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT signature_competence_basis_is_whole CHECK (
    competence_record_id IS NULL
    OR (competence_activity IS NOT NULL
        AND competence_valid_from IS NOT NULL
        AND competence_valid_to IS NOT NULL
        AND competence_checked_on IS NOT NULL)
  );

-- ...and if frozen, it must actually cover the day it was checked against.
-- The service checks this too; a constraint means no code path can bypass it.
ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT signature_competence_basis_covers_the_day CHECK (
    competence_record_id IS NULL
    OR (competence_valid_from <= competence_checked_on
        AND competence_valid_to >= competence_checked_on)
  );

-- One signature per (subject, signer, meaning). Signing the same record twice
-- with the same meaning is a double-submit, not a second act of judgement.
CREATE UNIQUE INDEX signatures_one_per_subject_signer_meaning
  ON "lotmark"."signatures" (subject_kind, subject_id, signer_user_id, meaning);

-- ── State transition history ───────────────────────────────────────────────
--
-- One polymorphic table rather than six per-aggregate children. Every workflow
-- move is recorded with who made it, from what to what, under which
-- configuration version, and which signature authorised it — so a state can
-- always be explained rather than merely observed.
CREATE TABLE "lotmark"."state_transitions" (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  from_state   text,
  to_state     text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES "lotmark"."users"(id),
  /** Required where the configured transition demands one. */
  reason       text,
  signature_id uuid REFERENCES "lotmark"."signatures"(id),
  config_version_id uuid REFERENCES "lotmark"."config_versions"(id),
  audit_seq    bigint,
  CONSTRAINT state_transition_moves CHECK (from_state IS DISTINCT FROM to_state)
);

CREATE INDEX state_transitions_subject_idx
  ON "lotmark"."state_transitions" (subject_type, subject_id, occurred_at);
CREATE INDEX state_transitions_tenant_time_idx
  ON "lotmark"."state_transitions" (tenant_id, occurred_at);

-- History is a record of what happened; it does not get revised.
CREATE TRIGGER state_transitions_no_update BEFORE UPDATE ON "lotmark"."state_transitions"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
CREATE TRIGGER state_transitions_no_delete BEFORE DELETE ON "lotmark"."state_transitions"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
