-- ============================================================================
-- 0030 — A published configuration version can carry the signature it is
--        already required to have.
--
-- ── The bug ─────────────────────────────────────────────────────────────────
--
-- `SignableKind` in packages/domain/src/signatures.ts has listed six kinds for
-- some time, and `signature_subject_kind_known` admitted five of them.
-- `config_version` was the missing one.
--
-- apps/api/src/routes/admin-config.ts refuses to publish a version that changes
-- behaviour or security unless it is signed, and then signs it with
-- `kind: 'config_version'`. `applySignature` writes `signable.kind` straight
-- into `subject_kind`. So the INSERT violated this CHECK, the transaction
-- rolled back, and publishing failed.
--
-- `changesRequireSignature` is `changes.some(c => c.risk !== 'presentation')`,
-- so this was not a corner. Every substantive configuration change — a
-- workflow, a separation-of-duties rule, a retention period, a guard, a custom
-- field — took that branch. Only a purely cosmetic change could be published.
--
-- ── Why nobody noticed ──────────────────────────────────────────────────────
--
-- The configuration tests stop one call short of it, and say so: they assert
-- against the publish PREVIEW (`publishable`, `problems`, `needsSignature`)
-- because, in the words of the comment at config-admin.test.ts:471, "publishing
-- would swap the tenant's active version". So the preview was thoroughly
-- covered and the act was never performed.
--
-- Migration 0026 fixed the identical failure for workflow transitions — its
-- header records that signing an unlisted kind "reached the user as a 500" —
-- and did not notice that `config_version` was sitting in the same enum,
-- already unlisted. Two occurrences of one mistake is a reason to stop relying
-- on noticing: 'every kind the domain can sign is accepted by the database' in
-- apps/api/src/__tests__/signable-kinds.test.ts now reads SignableKind and this
-- constraint and compares them, so a seventh kind cannot be added in code
-- alone.
--
-- ── Why config_version belongs here at all ──────────────────────────────────
--
-- Under §11.10(k) a change to a system that produces regulated records is
-- itself a controlled act, and under §11.50 the signature has to say what it
-- meant. The canonical material for this kind commits to the DIFF that was
-- reviewed rather than the whole configuration — see SignableConfigVersion — so
-- the signature says "I approved these changes", not "I approved this state".
-- ============================================================================

ALTER TABLE "lotmark"."signatures"
  DROP CONSTRAINT "signature_subject_kind_known";

ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT "signature_subject_kind_known" CHECK (
    "subject_kind" = ANY (ARRAY[
      'study'::text, 'value'::text, 'certificate'::text, 'lot'::text,
      -- A move through a configured workflow. See migration 0026.
      'state_transition'::text,
      -- The publication of a configuration version. The canonical material
      -- covers the reviewed diff, not the resulting configuration.
      'config_version'::text
    ])
  );
