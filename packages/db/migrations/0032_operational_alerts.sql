-- ============================================================================
-- 0032 — Something noticing is not the same as somebody being told.
--
-- This system already detects its own operational failures, and detects them
-- well. `job_health()` knows when a scheduled job is failing, overdue, or has
-- never run; `jobHealth()` in services/ops.ts turns that into a state and a
-- sentence of advice good enough to act on; `dr_drills` records whether the
-- last rehearsed restore passed, failed, or (since 0028) could not finish.
--
-- All of it is PULL. Every one of those facts is available to somebody who
-- opens the operations screen and looks. Nothing reaches anybody who does not.
-- A producer whose nightly worker died on a Friday finds out on Monday, from
-- the absence of something rather than the presence of a message.
--
-- ── What this table is ──────────────────────────────────────────────────────
--
-- The durable record of a condition that needs a person, with the property that
-- makes alerting survivable: raising the same alert twice is not two alerts.
-- `alert_key` identifies the CONDITION ('job:session-prune:stale'), not the
-- observation, and a partial unique index makes at most one open row per key
-- per tenant. A sweep that runs every ten minutes against a broken worker
-- therefore produces one row with a rising `occurrences`, not 144 a day.
--
-- That is the whole reason this is a table rather than a log line. An alerting
-- system that repeats itself gets filtered, and a filtered alert is worse than
-- no alert because it is also a reason not to build a real one — the same
-- argument `notices.ts` makes for thresholds, in its own words: "an expiry
-- notice sent every day for ninety days is not a reminder system, it is a
-- reason people filter your mail".
--
-- ── What this table is NOT ──────────────────────────────────────────────────
--
-- Delivery. Nothing here sends anything, because there is no email, SMS or
-- webhook path anywhere in this codebase — an alert written here is still only
-- visible to somebody who looks, and this migration does not change that. It
-- makes the record deduplicated, resolvable and queryable so that a delivery
-- sink is a small thing to add on top rather than a redesign.
--
-- ── The limit no sweep can fix ──────────────────────────────────────────────
--
-- The sweep that writes these rows cannot report that the sweep is not running,
-- for the same reason the worker cannot report that the worker is down. That is
-- what an external prober is for, and it is why `last_swept_at` exists on
-- `alert_sweeps` below: a prober outside this process can ask when the sweep
-- last completed and alert on the answer being old. Detecting silence needs
-- somebody who is not the one being silent.
-- ============================================================================

CREATE TABLE "lotmark"."operational_alerts" (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,

  -- The CONDITION, not the observation. Stable across sweeps, which is what
  -- makes deduplication and auto-resolution possible.
  alert_key       text NOT NULL,
  severity        text NOT NULL,

  -- What is wrong, and what to do. `detail` carries the advice `jobHealth()`
  -- already writes, rather than making the reader go and find it.
  summary         text NOT NULL,
  detail          text,

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  occurrences     integer NOT NULL DEFAULT 1,

  resolved_at     timestamptz,
  -- Why it closed. 'cleared' when the sweep stopped seeing it; anything else
  -- is a person saying so.
  resolved_reason text,

  CONSTRAINT alert_severity_known
    CHECK (severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])),
  CONSTRAINT alert_resolution_states_reason
    CHECK (resolved_at IS NULL OR resolved_reason IS NOT NULL),
  CONSTRAINT alert_seen_in_order
    CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT alert_occurrences_positive
    CHECK (occurrences >= 1)
);

/*
 * At most one OPEN alert per condition per tenant.
 *
 * Partial, so the history of resolved alerts is kept — "this has broken four
 * times this month" is the question an operator asks next, and a table that
 * only holds what is currently wrong cannot answer it.
 */
CREATE UNIQUE INDEX operational_alerts_one_open_per_key
  ON "lotmark"."operational_alerts" (tenant_id, alert_key)
  WHERE resolved_at IS NULL;

CREATE INDEX operational_alerts_open_idx
  ON "lotmark"."operational_alerts" (tenant_id, severity, last_seen_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE "lotmark"."operational_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."operational_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."operational_alerts"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT, UPDATE ON "lotmark"."operational_alerts" TO lotmark_app;

/*
 * No writing while reading the past.
 *
 * Required on EVERY table in this schema — as-of.test.ts asserts exactly that,
 * because one table without the trigger is a hole straight through the rule.
 * Both tables here were added without it on the first attempt and the test said
 * so, which is what it is for.
 */
CREATE OR REPLACE TRIGGER as_of_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lotmark"."operational_alerts"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_write_under_as_of();

/*
 * When the sweep last finished.
 *
 * One row per tenant, overwritten. This is not history — it answers exactly one
 * question, asked from OUTSIDE this process: is the thing that raises alerts
 * still running? A sweep cannot raise an alert about its own absence, so the
 * only useful form of that fact is a timestamp somebody else can read and find
 * stale.
 */
CREATE TABLE "lotmark"."alert_sweeps" (
  tenant_id     uuid PRIMARY KEY REFERENCES "lotmark"."tenants"(id) ON DELETE RESTRICT,
  last_swept_at timestamptz NOT NULL DEFAULT now(),
  -- How many alerts were open when it finished, so a reader gets the headline
  -- without a second query.
  open_alerts   integer NOT NULL DEFAULT 0,
  CONSTRAINT sweep_open_alerts_not_negative CHECK (open_alerts >= 0)
);

ALTER TABLE "lotmark"."alert_sweeps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lotmark"."alert_sweeps" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lotmark"."alert_sweeps"
  USING (tenant_id = "lotmark".current_tenant())
  WITH CHECK (tenant_id = "lotmark".current_tenant());

GRANT SELECT, INSERT, UPDATE ON "lotmark"."alert_sweeps" TO lotmark_app;

CREATE OR REPLACE TRIGGER as_of_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON "lotmark"."alert_sweeps"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_write_under_as_of();

COMMENT ON TABLE "lotmark"."operational_alerts" IS
  'Conditions needing a person, deduplicated by alert_key while open. Writing a '
  'row here is not delivery — nothing in this system sends anything.';
