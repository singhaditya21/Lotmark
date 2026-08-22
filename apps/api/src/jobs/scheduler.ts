import { PgBoss } from 'pg-boss';
import type { AppConfig } from '../config';
import type { Sql } from '../db';
import { forEachTenant, type JobOutcome } from './context';
import { lotExpiryNotices, monitoringDue, lapseEntitlements, pruneSessions } from './notices';
import { sweepAlerts } from './alert-sweep';

/**
 * The scheduler.
 *
 * pg-boss keeps its queues in Postgres, so there is no Redis, no broker, and no
 * second durability story to back up and restore. On a laptop that is the
 * difference between `pnpm dev` working and a page of setup instructions.
 *
 * pg-boss owns its own `pgboss` schema and needs DDL to maintain it, so it
 * connects as the OWNER. Job handlers do their business work on the ordinary
 * application connection, which is a non-superuser and fully subject to RLS.
 * The queue is infrastructure; the work is not, and mixing the two privileges
 * would hand every job a bypass it does not need.
 */
export interface JobDefinition {
  readonly name: string;
  /** Standard five-field cron. */
  readonly cron: string;
  /**
   * How long may pass without a successful run before something is wrong.
   *
   * Declared rather than derived from the cron expression. Parsing cron to
   * work out a cadence is a small amount of code that is subtly wrong for the
   * interesting cases, and the number wanted here is not the schedule anyway —
   * it is the tolerance, which includes retries, restarts and a night where
   * the machine was asleep.
   */
  readonly expectedEveryHours: number;
  readonly description: string;
  readonly run: (sql: Sql, cfg: AppConfig) => Promise<JobOutcome[]>;
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'lot-expiry-notices',
    expectedEveryHours: 36,
    cron: '0 7 * * *',
    description: 'Tell holders when a lot approaches expiry, at 90, 30 and 7 days.',
    run: (sql, cfg) => forEachTenant(sql,
      { jobName: 'lot-expiry-notices', auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx, tenant) => lotExpiryNotices(tx, tenant)),
  },
  {
    name: 'monitoring-due',
    expectedEveryHours: 36,
    cron: '15 7 * * *',
    description: 'Raise a CAPA where stability monitoring has fallen overdue (ISO 17034 7.8).',
    run: (sql, cfg) => forEachTenant(sql,
      { jobName: 'monitoring-due', auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx, tenant) => monitoringDue(tx, tenant)),
  },
  {
    name: 'entitlement-revalidation',
    expectedEveryHours: 36,
    cron: '30 7 * * *',
    description: 'Lapse approved price tiers past their revalidation date, and revert pricing.',
    run: (sql, cfg) => forEachTenant(sql,
      { jobName: 'entitlement-revalidation', auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx, tenant) => lapseEntitlements(tx, tenant)),
  },
  {
    name: 'alert-sweep',
    /**
     * The only job here that is not daily.
     *
     * Everything else in this list DOES something on a human timescale — a
     * notice, a lapse, a prune — and a few hours either way changes nothing.
     * This one only notices, and the value of noticing decays fast: an alert
     * about a worker that died on Friday is worth much less on Monday. Fifteen
     * minutes is the cadence; an hour is the tolerance, so a restart or a slow
     * run is not itself reported as a fault.
     */
    expectedEveryHours: 1,
    cron: '*/15 * * * *',
    description:
      'Turn what the system already knows — failing jobs, an unrehearsed or '
      + 'incomplete restore — into deduplicated alerts. It cannot report its own '
      + 'absence: see alert_sweeps.last_swept_at and scripts/prober.mts.',
    run: (sql, cfg) => forEachTenant(sql,
      { jobName: 'alert-sweep', auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx, tenant) => sweepAlerts(tx, tenant)),
  },
  {
    name: 'session-prune',
    expectedEveryHours: 36,
    cron: '0 3 * * *',
    description:
      'Remove sessions expired or revoked beyond the tenant\'s configured '
      + 'session_and_access_log retention. Seven days was hard-coded here once; '
      + 'CERT-In requires 180, and the window is a retention policy now, not a constant.',
    run: (sql, cfg) => forEachTenant(sql,
      { jobName: 'session-prune', auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx, tenant) => pruneSessions(tx, tenant)),
  },
];

export class Scheduler {
  private boss: PgBoss | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly cfg: AppConfig,
    private readonly log: (msg: string, meta?: unknown) => void,
  ) {}

  async start(): Promise<void> {
    // The OWNER connection: pg-boss maintains its own schema and needs DDL.
    this.boss = new PgBoss({
      connectionString: this.cfg.DATABASE_ADMIN_URL,
      schema: 'pgboss',
    });

    this.boss.on('error', (e: unknown) => this.log('scheduler error', e));
    await this.boss.start();

    for (const job of JOBS) {
      // Retry policy is per-queue in pg-boss 12. Two attempts with backoff: a
      // transient database hiccup should not skip a day's notices, but a job
      // that is genuinely broken must stop rather than pile up queued
      // duplicates that hide the fact it has stalled.
      await this.boss.createQueue(job.name, {
        retryLimit: 2, retryDelay: 60, retryBackoff: true,
      });
      await this.boss.work(job.name, async () => {
        const started = Date.now();
        const outcomes = await job.run(this.sql, this.cfg);
        const items = outcomes.reduce((n, o) => n + o.itemsProcessed, 0);
        const failed = outcomes.filter((o) => o.outcome === 'failure');
        this.log(
          `job ${job.name}: ${items} item(s) across ${outcomes.length} tenant(s) ` +
          `in ${Date.now() - started} ms` +
          (failed.length > 0 ? ` — ${failed.length} TENANT(S) FAILED` : ''),
          failed.length > 0 ? failed : undefined,
        );
      });
      await this.boss.schedule(job.name, job.cron, undefined, { tz: 'UTC' });
    }

    this.log(`scheduler started with ${JOBS.length} job(s)`);
  }

  /** Run one job immediately, by name. For operators and for tests. */
  async runNow(name: string): Promise<JobOutcome[]> {
    const job = JOBS.find((j) => j.name === name);
    if (!job) throw new Error(`No job named '${name}'. Known: ${JOBS.map((j) => j.name).join(', ')}`);
    return job.run(this.sql, this.cfg);
  }

  async stop(): Promise<void> {
    await this.boss?.stop({ graceful: true });
    this.boss = null;
  }
}
