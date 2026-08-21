-- ============================================================================
-- 0025 — Custom field values, made real and made append-only.
--
-- `custom_field_values` has existed since 0000 and nothing has ever read or
-- written it. Its doc comment describes a validate-on-write flow that was never
-- built, which makes it the most misleading kind of artefact: a table that
-- looks like a working feature. This migration is what a form designer needs
-- underneath it, and it corrects three things about the table as declared.
--
-- ── One document per REVISION, not one per record ───────────────────────────
--
-- The table held one mutable row per record. That is the natural shape and it
-- is the wrong one here, for a reason 21 CFR 11 §11.10(e) states directly: an
-- audit trail must record changes and "shall not obscure previously recorded
-- information". An in-place UPDATE obscures by definition.
--
-- It matters concretely because `field.onCertificate` exists. A custom field
-- can be printed on an issued certificate. With a mutable document, the value
-- that appeared on a certificate could be changed afterwards and the
-- certificate would no longer be explicable from the records — which is the
-- one thing this whole system is built not to allow.
--
-- The house already answers this the same way everywhere it arises:
-- `competence_records` supersede rather than edit, because "a signature made
-- under an earlier record must stay explicable"; `certificate_issues` keep
-- every issue; the ledger appends. Custom field values now do the same. The
-- JSONB-not-EAV decision in docs/architecture/LOW-CODE.md is untouched — a
-- revision is still one whole document, read and written with its parent.
--
-- ── The unique index could be violated by a row you cannot see ──────────────
--
-- `custom_field_values_record_unique` was UNIQUE (entity, record_id) with no
-- tenant_id — the only unique index in the schema shaped that way. Under
-- FORCED row-level security that means a collision can be raised by a row the
-- caller's policy hides, so the error says "already exists" about something
-- that, to that caller, does not. Replaced with a tenant-scoped index that also
-- carries the revision.
--
-- ── A value whose governing rules are unknown is not a record ───────────────
--
-- `config_version_id` was nullable. It answers "which field definitions was
-- this validated against", and a value that cannot answer it cannot be checked
-- by anybody later. It is now NOT NULL, and because revisions are append-only
-- the stamp is per revision and never rewritten: revision 1 written under v2
-- keeps v2 forever, even after revision 2 is written under v5. A single mutable
-- row restamped the whole document on every edit, so the provenance of the
-- earlier content was overwritten by the most recent write.
--
-- All of this is safe as written ONLY because the table is empty. Verified
-- before writing: 0 rows, and no code path in the repository inserts into it.
-- ============================================================================

/**
 * The revision, who recorded it, and why.
 *
 * `recorded_by` is NOT NULL and has no system fallback on purpose. Scheduled
 * work does not fill in forms; if a job ever needs to write a custom field
 * value, that is a design conversation, not a nullable column.
 */
ALTER TABLE "lotmark"."custom_field_values"
  ADD COLUMN "revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "recorded_by" uuid REFERENCES "lotmark"."users"("id"),
  ADD COLUMN "reason" text;

ALTER TABLE "lotmark"."custom_field_values"
  ALTER COLUMN "recorded_by" SET NOT NULL,
  ALTER COLUMN "config_version_id" SET NOT NULL;

ALTER TABLE "lotmark"."custom_field_values"
  ADD CONSTRAINT "custom_field_values_revision_positive" CHECK ("revision" >= 1);

/**
 * Tenant-scoped, and the thing that makes concurrent edits detectable.
 *
 * A caller writes revision N+1 having read revision N. If somebody else got
 * there first, this index refuses the insert and the service turns that into a
 * 409 rather than silently discarding one of the two edits. Optimistic
 * concurrency, enforced by the database rather than by remembering to lock.
 */
DROP INDEX IF EXISTS "lotmark"."custom_field_values_record_unique";

CREATE UNIQUE INDEX "custom_field_values_revision_unique"
  ON "lotmark"."custom_field_values" ("tenant_id", "entity", "record_id", "revision");

/** Serving "the current document for this record", which is the common read. */
CREATE INDEX "custom_field_values_current_idx"
  ON "lotmark"."custom_field_values" ("tenant_id", "entity", "record_id", "revision" DESC);

/**
 * Append-only, at BOTH layers.
 *
 * The trigger is the rule; the revoked privilege is what stops the rule being
 * dropped by whoever could drop the trigger. 0019 recorded the lesson: two new
 * tables were commented as append-only while the default grants from 0005 still
 * gave the application UPDATE and DELETE, so the comment was the only thing
 * enforcing it. `refuse_mutation()` is the same function the ledger, the
 * signatures and the state transitions use.
 */
REVOKE UPDATE, DELETE ON "lotmark"."custom_field_values" FROM lotmark_app;

CREATE TRIGGER custom_field_values_no_update
  BEFORE UPDATE ON "lotmark"."custom_field_values"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

CREATE TRIGGER custom_field_values_no_delete
  BEFORE DELETE ON "lotmark"."custom_field_values"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();

/**
 * The current document for one record, or NULL if it has never had one.
 *
 * INVOKER rights, deliberately: row-level security still applies, so this
 * cannot become a way to read another tenant's values. It exists so that
 * "current" is defined in one place rather than as a DISTINCT ON copied into
 * every caller.
 */
CREATE OR REPLACE FUNCTION "lotmark".current_custom_values(
  p_entity text, p_record_id uuid
) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT v."values"
  FROM "lotmark"."custom_field_values" v
  WHERE v.entity = p_entity AND v.record_id = p_record_id
  ORDER BY v.revision DESC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION "lotmark".current_custom_values(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".current_custom_values(text, uuid) TO lotmark_app;

COMMENT ON TABLE "lotmark"."custom_field_values" IS
  'Append-only revisions of the custom-field document for one record. The '
  'current document is the highest revision. Values are kept for fields later '
  'removed from configuration, because deleting a definition must not destroy '
  'recorded data — 21 CFR 11 §11.10(e).';

COMMENT ON COLUMN "lotmark"."custom_field_values"."config_version_id" IS
  'The configuration version whose field definitions THIS revision was '
  'validated against. Never restamped: it is what makes an old revision '
  'explicable after the definitions have moved on.';
