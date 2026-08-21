-- ============================================================================
-- 0021 — Seeing that the unattended parts are working.
--
-- Four scheduled jobs run at 3am and 7am. `forEachTenant` records each run in
-- `job_runs` and the scheduler logs failures, and NOTHING SURFACES THEM. A job
-- that has failed every night for a week looks exactly like one that has never
-- run, which looks exactly like one with nothing to do. The expiry-notice job
-- is the one that tells a laboratory its material is about to go out of date.
--
-- Three things here: a way to ask how the jobs are doing, a place to record
-- rehearsed disaster-recovery drills, and a numbering counter fix that has to
-- land before anything else starts raising CAPAs automatically.
-- ============================================================================

/**
 * A run that started is recorded before it finishes.
 *
 * `job_runs` is written AFTER the work completes, so a process killed
 * mid-run leaves no trace at all — the worst case looks like the best case.
 * The columns already allow an open row (`finished_at` and `outcome` are
 * nullable, and the CHECK only requires an outcome once finished); what was
 * missing is a vocabulary for the outcome and an index for finding the
 * stragglers.
 */
ALTER TABLE "lotmark"."job_runs"
  ADD CONSTRAINT job_run_outcome_known
  CHECK (outcome IS NULL OR outcome IN ('success', 'failure', 'partial'));

CREATE INDEX job_runs_unfinished_idx
  ON "lotmark"."job_runs" (tenant_id, started_at)
  WHERE finished_at IS NULL;

/**
 * How each job is doing.
 *
 * Reports FACTS and leaves judgement to the caller: the expected cadence lives
 * in the job definitions in code, so "overdue" is not something the database
 * can decide. What it can say is when each job last ran, how it went, and how
 * many times in a row it has failed since it last succeeded.
 *
 * A job that has NEVER run appears nowhere here, because there is no row for
 * it. That is not an oversight — the caller compares this against the list of
 * jobs it knows about, and a job missing from this result is the most serious
 * state of all.
 */
CREATE OR REPLACE FUNCTION "lotmark".job_health(p_tenant uuid)
RETURNS TABLE (
  job_name text,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_outcome text,
  last_error text,
  last_success_at timestamptz,
  consecutive_failures bigint,
  running boolean
)
LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON (r.job_name)
           r.job_name, r.started_at, r.finished_at, r.outcome, r.error_text
    FROM "lotmark"."job_runs" r
    WHERE r.tenant_id = p_tenant
    ORDER BY r.job_name, r.started_at DESC
  ),
  last_ok AS (
    SELECT r.job_name, max(r.started_at) AS at
    FROM "lotmark"."job_runs" r
    WHERE r.tenant_id = p_tenant AND r.outcome = 'success'
    GROUP BY r.job_name
  )
  SELECT l.job_name, l.started_at, l.finished_at, l.outcome, l.error_text,
         ok.at,
         -- Runs since the last success. Counted from job_runs rather than kept
         -- as a column, so it cannot drift from the runs it describes.
         (SELECT count(*) FROM "lotmark"."job_runs" f
           WHERE f.tenant_id = p_tenant AND f.job_name = l.job_name
             AND (ok.at IS NULL OR f.started_at > ok.at)
             AND f.outcome IS DISTINCT FROM 'success'),
         l.finished_at IS NULL
  FROM latest l
  LEFT JOIN last_ok ok ON ok.job_name = l.job_name;
$$;

/**
 * Rehearsed disaster-recovery drills.
 *
 * A backup that has never been restored is a hypothesis. This table records
 * drills that actually ran, what they proved, and what they could not — so
 * "we have backups" becomes a dated claim with evidence rather than a belief.
 *
 * `checks` holds the individual assertions and their results, because "the
 * drill passed" is not useful six months later when somebody asks whether the
 * restore verified the audit chain or merely counted rows.
 */
CREATE TABLE "lotmark"."dr_drills" (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  /** What was restored: a label for the backup set. */
  source_label   text NOT NULL,
  outcome        text,
  /** [{name, ok, detail}] — every assertion, not just the failures. */
  checks         jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes          text,

  CONSTRAINT dr_drill_outcome_known
    CHECK (outcome IS NULL OR outcome IN ('passed', 'failed')),
  CONSTRAINT dr_drill_finished_has_outcome
    CHECK (finished_at IS NULL OR outcome IS NOT NULL)
);

CREATE INDEX dr_drills_tenant_time_idx ON "lotmark"."dr_drills" (tenant_id, started_at DESC);

ALTER TABLE "lotmark"."dr_drills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."dr_drills" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."dr_drills"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT, UPDATE ON "lotmark"."dr_drills" TO lotmark_app;

CREATE OR REPLACE TRIGGER as_of_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lotmark"."dr_drills"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_write_under_as_of();

-- ---------------------------------------------------------------------------
-- Priming the numbering counters.
--
-- `capa` is configured as NCR-{SEQ} with a YEARLY reset and startAt 1, and the
-- only counter row is the un-scoped ('capa','all',300). So the first automatic
-- CAPA would create the current year's scope at 1 and render NCR-0001 — behind
-- the seeded NCR-0231, and colliding with it outright on the 231st CAPA of the
-- year, at which point capa_tenant_code_unique fails a job nobody is watching.
--
-- Every yearly-reset entity is primed above the highest number already in use,
-- so a code can never be reissued. Generic rather than capa-specific, because
-- `order` has the same configuration and the same latent problem.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  e record;
  v_scope text := to_char(current_date, 'YYYY');
  v_table regclass;
  v_max bigint;
BEGIN
  FOR e IN
    SELECT DISTINCT v.tenant_id, en.payload ->> 'entity' AS entity
    FROM "lotmark"."config_entries" en
    JOIN "lotmark"."config_versions" v ON v.id = en.version_id
    WHERE v.status = 'active' AND en.kind = 'numbering'
      AND en.payload ->> 'resetPolicy' = 'yearly'
  LOOP
    /**
     * An entity is not a table name.
     *
     * The numbering entity for orders is `order` and the table is `orders`;
     * for CAPAs both are `capa`. Resolving through to_regclass rather than
     * assuming either convention means a new entity that follows neither is
     * SKIPPED with a notice instead of aborting the migration — and skipping
     * is safe, because an unprimed counter is the state we are already in.
     */
    v_table := coalesce(
      to_regclass(format('lotmark.%I', e.entity)),
      to_regclass(format('lotmark.%I', e.entity || 's'))
    );
    IF v_table IS NULL THEN
      RAISE NOTICE 'numbering entity % has no obvious table; its counter is not primed', e.entity;
      CONTINUE;
    END IF;

    -- The highest number already used by that entity, whatever the year.
    EXECUTE format(
      'SELECT coalesce(max(nullif(regexp_replace(code, ''\D'', '''', ''g''), ''''))::bigint, 0)
         FROM %s WHERE tenant_id = $1', v_table)
      INTO v_max USING e.tenant_id;

    INSERT INTO "lotmark"."numbering_counters" (tenant_id, entity, scope, next_value)
    VALUES (e.tenant_id, e.entity, v_scope, v_max + 1)
    ON CONFLICT (tenant_id, entity, scope) DO UPDATE
      SET next_value = GREATEST("lotmark"."numbering_counters".next_value, EXCLUDED.next_value);
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION "lotmark".job_health(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "lotmark".job_health(uuid) TO lotmark_app;

COMMENT ON TABLE "lotmark"."dr_drills" IS
  'Rehearsed restores. A backup that has never been restored is a hypothesis; '
  'this is where it becomes a dated claim with the individual assertions '
  'recorded, so what a drill did and did not prove is answerable later.';
