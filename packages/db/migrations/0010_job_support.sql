-- ============================================================================
-- 0010 — Support for scheduled work.
--
-- A job has no session and no tenant context, which collides with two things
-- that are deliberately strict: RLS forces a tenant on every query, and the
-- ledger requires an actor on every entry.
--
-- The tempting fix is a BYPASSRLS role for jobs. That is the wrong move — it
-- creates a privileged path where a bug leaks across tenants silently, and the
-- policies then go unexercised by exactly the code that runs unattended. A job
-- instead iterates tenants and runs inside each one's context, so it cannot see
-- across tenants because nothing can.
-- ============================================================================

/**
 * Enumerate tenants for a job to iterate.
 *
 * SECURITY DEFINER for the same reason as resolve_tenant: the caller has no
 * tenant context yet and the tenants table is under RLS. Returns only what a
 * job needs to establish context — no configuration, no residency posture.
 */
CREATE OR REPLACE FUNCTION "lotmark".all_tenants()
RETURNS TABLE (id uuid, slug text, time_source text, region text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
  SELECT t.id, t.slug, t.time_source, t.region
  FROM "lotmark"."tenants" t ORDER BY t.created_at;
$$;

GRANT EXECUTE ON FUNCTION "lotmark".all_tenants() TO lotmark_app;

-- job_runs is written on every run, success or failure. A job that silently
-- stopped is indistinguishable from a job with nothing to do unless the run
-- itself is recorded.
ALTER TABLE "lotmark"."job_runs"
  ADD CONSTRAINT job_run_outcome_is_recorded CHECK (
    finished_at IS NULL OR outcome IS NOT NULL
  );

CREATE INDEX job_runs_tenant_name_time_idx
  ON "lotmark"."job_runs" (tenant_id, job_name, started_at DESC);

-- ---------------------------------------------------------------------------
-- Idempotency for notice-sending jobs.
--
-- The property that matters most in a scheduled job is what happens when it
-- runs twice. An expiry notice sent daily for thirty days is not a reminder
-- system, it is a reason people filter your mail.
--
-- A notice is therefore keyed on what it is ABOUT plus the threshold that
-- triggered it, so the same threshold cannot fire twice while a later one still
-- can.
-- ---------------------------------------------------------------------------
CREATE TABLE "lotmark"."notice_log" (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  notice_kind  text NOT NULL,
  subject_table text NOT NULL,
  subject_id   uuid NOT NULL,
  -- The threshold that fired, e.g. '90' for a ninety-day expiry warning.
  threshold    text NOT NULL,
  organisation_id uuid REFERENCES "lotmark"."organisations"(id),
  sent_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notice_once_per_threshold
    UNIQUE (tenant_id, notice_kind, subject_table, subject_id, threshold, organisation_id)
);

ALTER TABLE "lotmark"."notice_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."notice_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."notice_log"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT ON "lotmark"."notice_log" TO lotmark_app;

-- History, not a working set: a notice that was sent stays sent.
CREATE TRIGGER notice_log_no_update BEFORE UPDATE ON "lotmark"."notice_log"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
CREATE TRIGGER notice_log_no_delete BEFORE DELETE ON "lotmark"."notice_log"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
