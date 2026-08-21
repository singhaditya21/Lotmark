-- ============================================================================
-- 0017 — Administering configuration, safely.
--
-- The configuration model has been enforced from the start: entries are
-- writable only on a DRAFT version (`config_entries_draft_only`), a published
-- version cannot be edited (`config_versions_immutable_once_published`), and
-- exactly one version is active per tenant. What has never existed is a way to
-- USE it. Roles, teams, users and every configurable artefact have only ever
-- been created by the seed, so "everything is configurable" has been true of
-- the schema and false of the product.
--
-- This migration adds the two rules the administration console needs and cannot
-- enforce for itself, because a console is one caller among several.
--
-- ── One draft at a time ─────────────────────────────────────────────────────
--
-- Two open drafts is a fork. Both are based on the active version, both are
-- edited, and whichever publishes second silently discards the other's changes
-- while reporting success — with a `change_summary` that describes a diff
-- against a version that is no longer active, and therefore a re-validation
-- scope that covers the wrong things.
--
-- ── A risky change cannot be published unsigned ─────────────────────────────
--
-- `requiresSignatureToPublish()` in @lotmark/domain already says which kinds
-- need one: anything that is not `presentation`. That was a rule in TypeScript,
-- which means it was a rule in ONE caller. A change to who may authorise a
-- value is exactly the kind of change that must not be publishable by a script
-- someone wrote in a hurry.
-- ============================================================================

/**
 * One draft per tenant.
 *
 * A partial unique index rather than a constraint, because the rule applies
 * only to drafts — superseded versions accumulate forever and must.
 */
CREATE UNIQUE INDEX config_versions_one_draft_per_tenant
  ON "lotmark"."config_versions" (tenant_id)
  WHERE status = 'draft';

/**
 * Does this change summary contain anything that needs a signature?
 *
 * IMMUTABLE so it can be used in a CHECK. It reads only its argument, which is
 * what makes that honest — a function that consulted another table here would
 * be a constraint that changes its mind about rows already written.
 *
 * The risk classification itself is set by the code that computes the diff
 * (CONFIG_RISK in @lotmark/domain). This does not re-derive it; it asks whether
 * anything in the summary is above `presentation`.
 */
CREATE OR REPLACE FUNCTION "lotmark".config_change_needs_signature(p_summary jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_summary, '[]'::jsonb)) e
    WHERE e ->> 'risk' IS DISTINCT FROM 'presentation'
  );
$$;

/**
 * A published version carrying a security or behaviour change must be signed.
 *
 * Presentation changes are audited but unsigned on purpose: demanding a
 * signature to move a field on a form trains people to sign without reading,
 * which is worse than not asking.
 *
 * Safe against existing data: the seeded version 1 is active with an empty
 * change summary, so the function returns false and the constraint passes.
 */
ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_version_risky_change_is_signed
  CHECK (
    status = 'draft'
    OR signature_id IS NOT NULL
    OR NOT "lotmark".config_change_needs_signature(change_summary)
  );

/**
 * The signature is a real signature.
 *
 * The column has existed since 0000 with no foreign key, so it could name a
 * signature that does not exist — and the whole point of the column is that
 * somebody can be shown the signature it names.
 */
ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_versions_signature_fk
  FOREIGN KEY (signature_id) REFERENCES "lotmark"."signatures"(id) ON DELETE RESTRICT;

/**
 * A draft says what it was based on.
 *
 * Without it the diff has no defined baseline, and `change_summary` becomes a
 * claim rather than a derivation. Version 1 is the exception: it is based on
 * nothing because there was nothing.
 */
ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_versions_based_on_fk
  FOREIGN KEY (based_on_version_id) REFERENCES "lotmark"."config_versions"(id) ON DELETE RESTRICT;

ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_version_after_first_has_a_base
  CHECK (version_number = 1 OR based_on_version_id IS NOT NULL);

REVOKE EXECUTE ON FUNCTION "lotmark".config_change_needs_signature(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".config_change_needs_signature(jsonb) TO lotmark_app;

COMMENT ON CONSTRAINT config_version_risky_change_is_signed ON "lotmark"."config_versions" IS
  'A published version containing a security or behaviour change must carry an '
  'electronic signature. Presentation-only changes are audited but unsigned, '
  'because demanding a signature to move a field on a form trains people to '
  'sign without reading.';
