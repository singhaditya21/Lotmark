import type { Sql } from '../db';

/**
 * Raising and clearing operational alerts.
 *
 * The system already detects its own failures — `jobHealth()` knows when a job
 * is failing, stale or has never run, and says what to do about it. All of that
 * is pull: true on a screen nobody has open. These functions are the push half,
 * or as much of it as exists, which is a durable deduplicated record rather
 * than a message anybody receives. See migration 0032 for why that distinction
 * is drawn explicitly rather than quietly.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  /**
   * The CONDITION, not the observation.
   *
   * Two sweeps that find the same thing wrong must produce the same key, or
   * deduplication does nothing. So keys are built from stable parts —
   * `job:session-prune:stale`, not `job:session-prune:stale:2026-08-22`.
   */
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly detail?: string | null;
}

/**
 * Record that a condition is currently true.
 *
 * Idempotent by construction. The partial unique index admits one open row per
 * key, so a re-raise lands in `DO UPDATE` and moves `last_seen_at` instead of
 * making a second alert. A sweep every ten minutes against a worker that has
 * been down all weekend leaves one row saying so, with `occurrences` counting
 * how long it has been saying it.
 *
 * Severity and text are refreshed on re-raise: a job that was stale and is now
 * failing is the same condition getting worse, and an operator should see the
 * current sentence rather than the first one.
 */
export async function raiseAlert(tx: Sql, tenantId: string, alert: Alert): Promise<void> {
  await tx`
    INSERT INTO lotmark.operational_alerts
      (tenant_id, alert_key, severity, summary, detail)
    VALUES (${tenantId}, ${alert.key}, ${alert.severity}, ${alert.summary},
            ${alert.detail ?? null})
    ON CONFLICT (tenant_id, alert_key) WHERE resolved_at IS NULL
    DO UPDATE SET
      last_seen_at = now(),
      occurrences  = lotmark.operational_alerts.occurrences + 1,
      severity     = EXCLUDED.severity,
      summary      = EXCLUDED.summary,
      detail       = EXCLUDED.detail`;
}

/**
 * Close any open alert whose key is not in `stillTrue`.
 *
 * Auto-resolution is what stops the table becoming a list of things that used
 * to be wrong, which is the state in which people stop reading it. It is
 * deliberately keyed off the sweep's complete view rather than off individual
 * `clearAlert` calls: a condition that stops being detected because the CHECK
 * for it was deleted should also close, and be visible as having closed.
 *
 * `prefix` scopes it, so a sweep that only looked at jobs cannot resolve an
 * alert about drills by not mentioning it.
 */
export async function resolveAlertsExcept(
  tx: Sql, tenantId: string, prefix: string, stillTrue: readonly string[],
): Promise<number> {
  const rows = await tx`
    UPDATE lotmark.operational_alerts
       SET resolved_at = now(), resolved_reason = 'cleared'
     WHERE tenant_id = ${tenantId}
       AND resolved_at IS NULL
       AND alert_key LIKE ${prefix + '%'}
       AND NOT (alert_key = ANY(${stillTrue as string[]}))
    RETURNING id`;
  return rows.length;
}

export interface OpenAlert {
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly detail: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrences: number;
}

/** Every open alert, worst first, then longest-standing. */
export async function openAlerts(tx: Sql, tenantId: string): Promise<OpenAlert[]> {
  const rows = await tx`
    SELECT alert_key, severity, summary, detail,
           first_seen_at, last_seen_at, occurrences
      FROM lotmark.operational_alerts
     WHERE tenant_id = ${tenantId} AND resolved_at IS NULL
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
              first_seen_at`;
  return (rows as unknown as Array<{
    alert_key: string; severity: AlertSeverity; summary: string; detail: string | null;
    first_seen_at: string; last_seen_at: string; occurrences: number;
  }>).map((r) => ({
    key: r.alert_key, severity: r.severity, summary: r.summary, detail: r.detail,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    occurrences: Number(r.occurrences),
  }));
}

/**
 * Stamp that the sweep completed.
 *
 * Read from outside this process. The sweep cannot raise an alert saying the
 * sweep is not running, so the only useful form of that fact is a timestamp
 * somebody else can find stale — see `scripts/prober.mts`.
 */
export async function recordSweep(
  tx: Sql, tenantId: string, openCount: number,
): Promise<void> {
  await tx`
    INSERT INTO lotmark.alert_sweeps (tenant_id, last_swept_at, open_alerts)
    VALUES (${tenantId}, now(), ${openCount})
    ON CONFLICT (tenant_id)
    DO UPDATE SET last_swept_at = now(), open_alerts = EXCLUDED.open_alerts`;
}
