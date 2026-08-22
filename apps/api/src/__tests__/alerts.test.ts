import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { raiseAlert, resolveAlertsExcept, openAlerts, recordSweep } from '../services/alerts';
import { sweepAlerts } from '../jobs/alert-sweep';

/**
 * Alerting.
 *
 * The detection was never the missing part — `jobStatuses` has known when a job
 * is failing or stale for a long time, and says what to do about it. What was
 * missing was anywhere for that to go except a screen. These tests are about
 * the two properties that decide whether such a record is worth having: that
 * repeating an alert does not repeat it, and that a condition which stops being
 * true stops being reported.
 */

let app: FastifyInstance;
let tenantId: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  const [row] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  tenantId = (row as { id: string }).id;
});
afterAll(async () => { await app.close(); });

/**
 * Every case runs inside a tenant transaction that is then discarded.
 *
 * `operational_alerts` is under FORCE row-level security, so a bare `app.db`
 * write would match zero rows and report success — a mistake made three times
 * in this codebase already. And an alert left behind is one the next test's
 * `openAlerts` would find.
 */
class Rollback extends Error {
  constructor(readonly value: unknown) { super('deliberate rollback'); }
}

const discarded = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
  try {
    await inTenantTransaction(app.db, {
      tenantId,
      auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, (async (tx: Sql) => { throw new Rollback(await fn(tx)); }) as never);
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('the transaction committed, which it was supposed not to');
};

const ALERT = {
  key: 'test:condition', severity: 'warning' as const,
  summary: 'Something is wrong.', detail: 'Do the thing.',
};

describe('raising the same alert twice', () => {
  it('is one alert that has happened twice, not two alerts', async () => {
    /*
     * The property the whole design rests on. A sweep every fifteen minutes
     * against a worker that died on Friday would otherwise write 288 rows by
     * Monday, and a channel that repeats itself is one people filter — which is
     * worse than no channel, because it is also a reason not to build one.
     */
    const found = await discarded(async (tx) => {
      for (let i = 0; i < 5; i++) await raiseAlert(tx, tenantId, ALERT);
      return openAlerts(tx, tenantId);
    });
    const mine = found.filter((a) => a.key === ALERT.key);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.occurrences).toBe(5);
  });

  it('shows the condition as it is now, not as it first appeared', async () => {
    /*
     * A job that was stale and is now failing is the same condition getting
     * worse. An operator looking at it should read the current sentence.
     */
    const a = await discarded(async (tx) => {
      await raiseAlert(tx, tenantId, ALERT);
      await raiseAlert(tx, tenantId, {
        ...ALERT, severity: 'critical', summary: 'It got worse.',
      });
      return (await openAlerts(tx, tenantId)).find((x) => x.key === ALERT.key);
    });
    expect(a?.severity).toBe('critical');
    expect(a?.summary).toBe('It got worse.');
    expect(a?.occurrences, 'still the same condition').toBe(2);
  });

  it('keeps the first sighting, which is how long it has been broken', async () => {
    /*
     * `first_seen_at` is the answer to "since when", and a re-raise must not
     * move it — otherwise an alert that has been open all weekend reads as
     * fifteen minutes old, which is the opposite of the fact wanted.
     *
     * Only `first_seen_at` is asserted here. `last_seen_at` is written with
     * `now()`, which in PostgreSQL is TRANSACTION start time and therefore
     * identical for every statement in this test — the first version of this
     * asserted it had advanced and failed by exactly zero milliseconds. Across
     * real sweeps, each in its own transaction, it advances. That is the right
     * semantics (the stamp belongs to the sweep, not to the statement), so the
     * code is unchanged and the assertion is the part that was wrong.
     */
    const [before, after] = await discarded(async (tx) => {
      await raiseAlert(tx, tenantId, ALERT);
      const first = (await openAlerts(tx, tenantId)).find((x) => x.key === ALERT.key);
      await raiseAlert(tx, tenantId, { ...ALERT, summary: 'changed' });
      const second = (await openAlerts(tx, tenantId)).find((x) => x.key === ALERT.key);
      return [first, second];
    });
    expect(after?.firstSeenAt).toBe(before?.firstSeenAt);
    expect(after?.summary, 'the rest of the row did update').toBe('changed');
  });
});

describe('a condition that stops being true', () => {
  it('stops being reported', async () => {
    const after = await discarded(async (tx) => {
      await raiseAlert(tx, tenantId, ALERT);
      await resolveAlertsExcept(tx, tenantId, 'test:', []);
      return openAlerts(tx, tenantId);
    });
    expect(after.find((a) => a.key === ALERT.key)).toBeUndefined();
  });

  it('is not resolved by a sweep that was not looking at it', async () => {
    /*
     * Scoping by prefix, so a sweep that only examined jobs cannot close an
     * alert about recovery drills merely by not mentioning it. Without this,
     * every partial sweep silently clears everything it did not look at.
     */
    const still = await discarded(async (tx) => {
      await raiseAlert(tx, tenantId, ALERT);
      await resolveAlertsExcept(tx, tenantId, 'job:', []);
      return openAlerts(tx, tenantId);
    });
    expect(still.find((a) => a.key === ALERT.key)).toBeDefined();
  });

  it('reopens as a new alert rather than reviving the closed one', async () => {
    /*
     * The unique index is partial, so history survives. "This has broken four
     * times this month" is the next question an operator asks, and a table
     * holding only what is currently wrong cannot answer it.
     */
    const rows = await discarded(async (tx) => {
      await raiseAlert(tx, tenantId, ALERT);
      await resolveAlertsExcept(tx, tenantId, 'test:', []);
      await raiseAlert(tx, tenantId, ALERT);
      return tx`
        SELECT resolved_at, occurrences FROM lotmark.operational_alerts
        WHERE tenant_id = ${tenantId} AND alert_key = ${ALERT.key}`;
    }) as unknown as Array<{ resolved_at: string | null; occurrences: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.resolved_at === null)).toHaveLength(1);
  });
});

describe('the prober can see across tenants and the application cannot', () => {
  /**
   * `ops_probe_summary` is SECURITY DEFINER, so it reads past the per-tenant
   * policies — which is the whole point of it, and exactly why who may call it
   * is load-bearing. Cross-tenant reachability is the property FORCE row-level
   * security exists to deny the application; a function it can call that
   * enumerates tenants gives it back quietly.
   *
   * NOT granting was not enough. 0012 set `ALTER DEFAULT PRIVILEGES ... GRANT
   * EXECUTE ON FUNCTIONS TO lotmark_app`, so every function in this schema is
   * app-callable the moment it exists, and migration 0034 as first written
   * handed the application the ability it said in its own comment it withheld.
   * It takes an explicit REVOKE, and this is what stops the next one drifting.
   */
  it('refuses the application role', async () => {
    /*
     * The suite connects as lotmark_app, so this is the real principal rather
     * than a simulated one.
     */
    await expect(app.db`SELECT * FROM lotmark.ops_probe_summary()`)
      .rejects.toThrow(/permission denied/i);
  });

  it('grants exactly one role, and it is not the application', async () => {
    const [row] = await app.db`
      SELECT array_to_string(p.proacl, ',') AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'lotmark' AND p.proname = 'ops_probe_summary'`;
    const acl = (row as { acl: string }).acl;
    expect(acl, 'the probe role must be able to call it').toContain('lotmark_probe=X');
    expect(acl, 'the application must not').not.toContain('lotmark_app=X');
    expect(acl, 'and certainly not everybody').not.toMatch(/(^|,)=X/);
  });
});

describe('the sweep', () => {
  it('raises an alert for a job that has never run', async () => {
    /*
     * The seeded database has never run a scheduled job, which is exactly the
     * state a fresh deployment is in — and the state in which nothing any job
     * does, including the retention deletions a regulator asks about, has ever
     * happened. `never_run` is treated as critical for that reason.
     */
    const alerts = await discarded(async (tx) => {
      await sweepAlerts(tx, {
        id: tenantId, slug: 'test', timeSource: 'server', region: 'in',
      });
      return openAlerts(tx, tenantId);
    });
    const jobs = alerts.filter((a) => a.key.startsWith('job:'));
    expect(jobs.length, 'the sweep found nothing wrong with any job').toBeGreaterThan(0);
    expect(jobs.every((a) => a.detail && a.detail.length > 0),
      'an alert with no advice is something to acknowledge, not something to act on')
      .toBe(true);
  });

  it('is idempotent, which is the only reason it can run every fifteen minutes', async () => {
    const [first, second] = await discarded(async (tx) => {
      const t = { id: tenantId, slug: 'test', timeSource: 'server', region: 'in' };
      await sweepAlerts(tx, t);
      const a = (await openAlerts(tx, tenantId)).length;
      await sweepAlerts(tx, t);
      const b = (await openAlerts(tx, tenantId)).length;
      return [a, b];
    });
    expect(second).toBe(first);
  });

  it('stamps when it finished, because it cannot report its own absence', async () => {
    /*
     * A sweep cannot raise an alert saying the sweep is not running, for the
     * same reason a stopped worker cannot report that it stopped. The only
     * useful form of that fact is a timestamp something OUTSIDE this process
     * can read and find stale.
     */
    const stamped = await discarded(async (tx) => {
      await recordSweep(tx, tenantId, 3);
      const rows = await tx`
        SELECT last_swept_at, open_alerts FROM lotmark.alert_sweeps
        WHERE tenant_id = ${tenantId}`;
      return (rows as unknown as Array<{ last_swept_at: string; open_alerts: number }>)[0];
    });
    expect(stamped?.open_alerts).toBe(3);
    expect(Date.now() - new Date(stamped!.last_swept_at).getTime()).toBeLessThan(60_000);
  });
});
