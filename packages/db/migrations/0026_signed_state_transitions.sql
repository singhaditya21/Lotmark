-- ============================================================================
-- 0026 — A move through a workflow can be signed.
--
-- `signature_subject_kind_known` admitted four kinds: study, value, certificate
-- and lot. Those are the acts the PRODUCT decided must be signed, and while
-- that list was fixed in code the constraint was a faithful copy of it.
--
-- It is no longer fixed in code. A tenant's published workflow can now demand a
-- signature on any transition — the seeded tenant demands one to close a
-- nonconformity, which its quality manual requires and 21 CFR 11 does not — and
-- `capa` is not one of the four. Signing such a move failed the CHECK and
-- reached the user as a 500.
--
-- ── Why one kind and not one per entity ─────────────────────────────────────
--
-- `state_transition` covers every entity rather than adding `capa`, `order`,
-- `entitlement` and the rest. Which moves are signed is the tenant's to decide,
-- so a per-entity vocabulary would mean a migration every time somebody ticked
-- a box on a machine that had never had one — configuration that requires a
-- schema change to take effect is not configuration.
--
-- The four existing kinds stay as they are. They are not workflow moves:
-- issuing a certificate is not a state change of anything, and collapsing them
-- into `state_transition` would lose the distinction between signing a RECORD
-- and signing a MOVE, which is exactly what §11.50 asks a signature to manifest.
-- ============================================================================

ALTER TABLE "lotmark"."signatures"
  DROP CONSTRAINT "signature_subject_kind_known";

ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT "signature_subject_kind_known" CHECK (
    "subject_kind" = ANY (ARRAY[
      'study'::text, 'value'::text, 'certificate'::text, 'lot'::text,
      -- A move through a configured workflow. The canonical material commits to
      -- the entity, the record, both states and the stated reason — see
      -- SignableStateTransition.
      'state_transition'::text
    ])
  );

COMMENT ON CONSTRAINT "signature_subject_kind_known" ON "lotmark"."signatures" IS
  'The kinds of thing a signature may be about. `state_transition` is generic '
  'across entities on purpose: which moves demand a signature is configuration, '
  'and a per-entity vocabulary would need a migration to change it.';
