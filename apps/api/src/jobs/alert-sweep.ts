import type { Sql } from '../db';
import { jobStatuses, needsAttention, recentDrills } from '../services/ops';
import { raiseAlert, resolveAlertsExcept, recordSweep, type Alert } from '../services/alerts';
import type { TenantContext } from './context';

/**
 * Turn what the system already knows into alerts somebody could be told about.
 *
 * Nothing here does new detection. `jobStatuses` has known for a long time when
 * a scheduled job is failing, stale or has never run, and writes a sentence of
 * advice good enough to act on; `dr_drills` has recorded whether the last
 * rehearsed restore worked. Both were only ever true on a screen. This sweep
 * moves those facts into `operational_alerts`, where they are deduplicated,
 * resolvable, and one query away from a delivery sink.
 *
 * ── What it will not tell you ───────────────────────────────────────────────
 *
 * That it is not running. A sweep cannot alert on its own absence any more than
 * a stopped worker can report that it has stopped, and pretending otherwise is
 * how monitoring gets trusted for a job it never did. `recordSweep` stamps when
 * it last finished so that something OUTSIDE this process can find the stamp
 * old — see scripts/prober.mts. That is the only shape this fact can take.
 */

/** `job:` keys are auto-resolved as a group, so they share a prefix. */
const JOB_PREFIX = 'job:';
const DRILL_KEY = 'recovery:last-drill';

/**
 * A never-run job is worse than a stale one, not better.
 *
 * `never_run` reads like "new" and is usually "the worker has never been
 * started in this deployment" — which means nothing any scheduled job does has
 * ever happened here, including the retention deletions a regulator asks about.
 */
const JOB_SEVERITY: Record<string, Alert['severity']> = {
  failing: 'critical',
  never_run: 'critical',
  stale: 'warning',
};

export async function sweepAlerts(tx: Sql, tenant: TenantContext): Promise<number> {
  const open: string[] = [];

  /* ── Scheduled jobs ─────────────────────────────────────────────────────── */
  const statuses = await jobStatuses(tx, tenant.id);
  for (const job of needsAttention(statuses)) {
    const key = `${JOB_PREFIX}${job.name}:${job.state}`;
    open.push(key);
    await raiseAlert(tx, tenant.id, {
      key,
      severity: JOB_SEVERITY[job.state] ?? 'warning',
      summary: `Scheduled job '${job.name}' is ${job.state.replace('_', ' ')}.`,
      // The advice `jobStatuses` already wrote. Making the reader go and find
      // it is how an alert becomes something to acknowledge rather than act on.
      detail: job.advice ?? job.description,
    });
  }
  /*
   * Keyed on state, so a job moving from `stale` to `failing` closes the first
   * alert and opens a second rather than silently changing meaning under a key
   * somebody has already looked at and decided about.
   */
  await resolveAlertsExcept(tx, tenant.id, JOB_PREFIX, open);

  /* ── The last rehearsed restore ─────────────────────────────────────────── */
  const [drill] = await recentDrills(tx, tenant.id, 1);
  const drillAlert = ((): Alert | null => {
    if (!drill) {
      return {
        key: DRILL_KEY, severity: 'warning',
        summary: 'No restore has ever been rehearsed.',
        detail:
          'Whether the backups can be restored is unknown, and will stay unknown ' +
          'until it is tried. Run `pnpm --filter @lotmark/api exec tsx scripts/dr-drill.mts`.',
      };
    }
    if (drill.outcome === 'failed') {
      return {
        key: DRILL_KEY, severity: 'critical',
        summary: `The rehearsed restore of ${drill.source_label} FAILED.`,
        detail: drill.notes ?? 'See the drill record for which checks failed.',
      };
    }
    if (drill.outcome === 'incomplete') {
      return {
        key: DRILL_KEY, severity: 'warning',
        summary: `The rehearsed restore of ${drill.source_label} could not finish.`,
        detail:
          'Nothing failed and something was not exercised — most often the ' +
          'document checks, because the database held no rendered certificate. ' +
          'An incomplete drill has not shown that a certificate survives a restore.',
      };
    }
    return null;
  })();

  if (drillAlert) {
    open.push(DRILL_KEY);
    await raiseAlert(tx, tenant.id, drillAlert);
  }
  await resolveAlertsExcept(tx, tenant.id, DRILL_KEY, drillAlert ? [DRILL_KEY] : []);

  await recordSweep(tx, tenant.id, open.length);
  return open.length;
}
