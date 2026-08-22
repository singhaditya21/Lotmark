-- ============================================================================
-- 0028 — A recovery drill that skipped its checks is not a pass.
--
-- `dr_drills.outcome` admitted `passed` and `failed`. The drill script computes
-- `passed = checks.every(c => c.ok)`, and two of its strongest checks — that
-- stored certificates match their recorded digest, and that one re-renders
-- byte-identically — recorded themselves as `ok: true` with the word "skipped"
-- in their detail text when the database held no rendered certificate.
--
-- So the terminal printed "skipped", the row said `passed`, and the conformance
-- view read `outcome = 'passed'` as a satisfied control. Every drill recorded
-- against this system so far is in that state: the assertion that a certificate
-- survives a restore has never actually executed in a recorded run.
--
-- ── Why a third outcome rather than a boolean beside it ─────────────────────
--
-- The outcome is the one field a person reads. A drill that could not run half
-- its checks has not failed — nothing broke — and it has not passed either, and
-- collapsing that into `passed` with a count hidden in the notes is how the
-- distinction got lost the first time.
--
-- Existing rows keep `passed`. They were written before the script could tell
-- the difference, and rewriting history to say what we now wish it had said is
-- not available to an append-only system. The `checks` JSONB on those rows
-- still carries the skipped checks with their original detail text, so the
-- earlier state is legible rather than restated.
-- ============================================================================

ALTER TABLE "lotmark"."dr_drills"
  DROP CONSTRAINT IF EXISTS "dr_drill_outcome_known";

ALTER TABLE "lotmark"."dr_drills"
  ADD CONSTRAINT "dr_drill_outcome_known" CHECK (
    "outcome" IS NULL OR "outcome" = ANY (ARRAY[
      'passed'::text,
      'failed'::text,
      -- Nothing broke, and something was not exercised. See migration 0028.
      'incomplete'::text
    ])
  );

COMMENT ON COLUMN "lotmark"."dr_drills"."outcome" IS
  'passed = every check ran and succeeded. failed = a check failed. '
  'incomplete = nothing failed, and at least one check could not run — most '
  'often the document checks, when the database held no rendered certificate. '
  'An incomplete drill has not demonstrated that a certificate survives a '
  'restore, and the conformance view does not report it as satisfied.';
