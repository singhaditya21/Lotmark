import type { Sql } from '../db';
import { JOBS } from '../jobs/scheduler';

/**
 * Is the unattended half of the system working?
 *
 * Four jobs run overnight. `forEachTenant` has always recorded each run and the
 * scheduler has always logged failures, and nothing ever SURFACED them — so a
 * job that had failed every night for a week looked exactly like one that had
 * never run, which looked exactly like one with nothing to do. One of those
 * jobs is what tells a laboratory its material is about to expire.
 *
 * ── The state nobody was reporting ──────────────────────────────────────────
 *
 * `lotmark.job_health()` reports one row per job that has EVER run. A job that
 * has never run at all appears nowhere in it — which is the most serious state
 * of the lot, and the easiest to miss, because an empty result reads as "no
 * problems". So the known job list is joined against it here, in code, and a
 * job with no rows is reported as `never_run` rather than omitted.
 */

export type JobState = 'healthy' | 'running' | 'failing' | 'stale' | 'never_run';

export interface JobStatus {
  readonly name: string;
  readonly description: string;
  readonly cron: string;
  readonly state: JobState;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastOutcome: string | null;
  readonly lastError: string | null;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  /** Hours since the last SUCCESSFUL run, null when there has never been one. */
  readonly hoursSinceSuccess: number | null;
  readonly expectedEveryHours: number;
  /** What an operator should do about it, when there is something to do. */
  readonly advice: string | null;
}

interface HealthRow {
  job_name: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  last_success_at: string | null;
  consecutive_failures: string;
  /** The database's own answer; the service derives its own — see below. */
  running: boolean;
}

export async function jobStatuses(
  tx: Sql, tenantId: string, now = new Date(),
): Promise<JobStatus[]> {
  const rows = (await tx`SELECT * FROM lotmark.job_health(${tenantId})`) as unknown as HealthRow[];
  const byName = new Map(rows.map((r) => [r.job_name, r]));

  return JOBS.map((job) => {
    const r = byName.get(job.name);

    if (!r) {
      return {
        name: job.name, description: job.description, cron: job.cron,
        state: 'never_run' as const,
        lastStartedAt: null, lastFinishedAt: null, lastOutcome: null, lastError: null,
        lastSuccessAt: null, consecutiveFailures: 0, hoursSinceSuccess: null,
        expectedEveryHours: job.expectedEveryHours,
        advice:
          'This job has never run for this tenant. Check that the worker process is ' +
          'started (pnpm worker) — nothing it does has ever happened.',
      };
    }

    const hoursSinceSuccess = r.last_success_at === null
      ? null
      : (now.getTime() - new Date(r.last_success_at).getTime()) / 3_600_000;

    const failures = Number(r.consecutive_failures);
    const overdue = hoursSinceSuccess === null || hoursSinceSuccess > job.expectedEveryHours;

    /**
     * Derived from the row itself, not from the `running` column beside it.
     *
     * `job_health()` computes that column as `finished_at IS NULL`, so trusting
     * it here would give one fact two sources that can disagree — and the one
     * that disagrees is always the one nobody reads.
     */
    const running = r.last_started_at !== null && r.last_finished_at === null;

    /**
     * Order matters: a job can be several of these at once, and the operator
     * needs the most actionable one. A currently-running job is reported as
     * running even if its last attempt failed, because the answer may be about
     * to change; a failing one is reported as failing rather than stale,
     * because an error message beats "it has not run lately".
     */
    let state: JobState;
    let advice: string | null = null;
    if (running) {
      state = 'running';
      const startedHoursAgo = (now.getTime() - new Date(r.last_started_at!).getTime()) / 3_600_000;
      if (startedHoursAgo > 2) {
        advice =
          `It has been running for ${startedHoursAgo.toFixed(1)} hours. A run that never ` +
          'closes usually means the process was killed — the row stays open because ' +
          'nothing was left alive to finish it.';
      }
    } else if (failures > 0) {
      state = 'failing';
      advice =
        `${failures} run(s) have failed since the last success. ` +
        (r.last_error ? `Most recent error: ${r.last_error}` : 'No error text was recorded.');
    } else if (overdue) {
      state = 'stale';
      advice =
        `It last succeeded ${hoursSinceSuccess === null ? 'never' : `${Math.round(hoursSinceSuccess)} hours ago`}, ` +
        `and is expected at least every ${job.expectedEveryHours}. Check the worker is running.`;
    } else {
      state = 'healthy';
    }

    return {
      name: job.name, description: job.description, cron: job.cron, state,
      lastStartedAt: r.last_started_at,
      lastFinishedAt: r.last_finished_at,
      lastOutcome: r.last_outcome,
      lastError: r.last_error,
      lastSuccessAt: r.last_success_at,
      consecutiveFailures: failures,
      hoursSinceSuccess: hoursSinceSuccess === null ? null : Number(hoursSinceSuccess.toFixed(1)),
      expectedEveryHours: job.expectedEveryHours,
      advice,
    };
  });
}

/** Anything an operator should act on. */
export function needsAttention(statuses: readonly JobStatus[]): JobStatus[] {
  return statuses.filter((s) => s.state === 'failing' || s.state === 'stale' || s.state === 'never_run');
}

export interface DrillRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  source_label: string;
  outcome: string | null;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  notes: string | null;
}

export async function recentDrills(tx: Sql, tenantId: string, limit = 10): Promise<DrillRow[]> {
  const rows = await tx`
    SELECT id, started_at, finished_at, source_label, outcome, checks, notes
    FROM lotmark.dr_drills WHERE tenant_id = ${tenantId}
    ORDER BY started_at DESC LIMIT ${limit}`;
  return rows as unknown as DrillRow[];
}
