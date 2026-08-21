import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { retentionSettings, retentionDaysFor } from '../services/retention';
import { pruneSessions } from '../jobs/notices';
import { effectiveRetentionDays, statutoryFloorDays, RETENTION_SCHEDULE } from '@lotmark/domain';

/**
 * Retention — how long records are kept, and who decides.
 *
 * Four regimes disagree, so the schedule resolves them per record class and the
 * conflict is settled in the open. What a tenant may set is how much LONGER
 * than the statutory minimum it keeps something; the minimum is law.
 *
 * Both halves of that had been written down and neither was applied.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

function asTenant<T>(fn: (tx: Sql, tenantId: string) => Promise<T>): Promise<T> {
  return app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`.then(([t]) => {
    const tenantId = (t as { id: string }).id;
    return inTenantTransaction(app.db, {
      tenantId, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
      organisationKind: 'producer',
    }, (tx) => fn(tx, tenantId));
  });
}

describe('the floor is law', () => {
  it('takes the longer of what the law requires and what the tenant set', () => {
    // A tenant may keep records longer than the law requires and never less.
    expect(effectiveRetentionDays('electronic_signature', 5000)).toBe(5000);
    expect(effectiveRetentionDays('electronic_signature', 30)).toBe(3650);
    expect(effectiveRetentionDays('electronic_signature', undefined)).toBe(3650);
  });

  it('applies the floor at RUNTIME as well as at publication', () => {
    /**
     * Publication refuses a period below the floor, so a stored value that is
     * too short arrived some other way — a migration, an older version of this
     * code, a direct write. The safe reading of an unlawfully short period is
     * the lawful one. Two layers, as everywhere else here.
     */
    expect(effectiveRetentionDays('session_and_access_log', 7)).toBe(180);
  });

  it('knows a class with no floor from one it has never heard of', () => {
    // DPDP governs customer contact data by MINIMISATION — a maximum and an
    // obligation to erase, not a minimum to keep. Zero is a real answer.
    expect(statutoryFloorDays('customer_contact_data')).toBe(0);
    expect(statutoryFloorDays('invented_class')).toBeNull();
    expect(effectiveRetentionDays('invented_class', 100)).toBeNull();
  });

  it('has a floor for every class in the schedule', () => {
    for (const klass of RETENTION_SCHEDULE) {
      expect(statutoryFloorDays(klass.id), klass.id).not.toBeNull();
    }
  });
});

describe('what this tenant actually keeps', () => {
  it('reports every class, with the law beside the tenant’s choice', async () => {
    const settings = await asTenant((tx, t) => retentionSettings(tx, t));
    expect(settings).toHaveLength(RETENTION_SCHEDULE.length);

    for (const s of settings) {
      expect(s.effectiveDays, s.klass.id).not.toBeNull();
      expect(s.effectiveDays!, `${s.klass.id} may not fall below its floor`)
        .toBeGreaterThanOrEqual(s.floorDays ?? 0);
    }
  });

  it('answers the question a job actually asks', async () => {
    const days = await asTenant((tx, t) =>
      retentionDaysFor(tx, t, 'session_and_access_log'));
    expect(days).toBeGreaterThanOrEqual(180);
  });
});

describe('the access log CERT-In asks for', () => {
  /**
   * `pruneSessions` deleted sessions after SEVEN DAYS, with a comment calling
   * them "housekeeping, not evidence". That is the product's view and not the
   * regulator's: CERT-In 2022 names 180 days precisely because access logs are
   * the evidence it wants available for an investigation, and the retention
   * schedule has classified them that way all along.
   *
   * So the schedule said 180 and the code did 7, and nothing read the schedule.
   */
  const aSession = (ageDays: number) => asTenant(async (tx, tenantId) => {
    const [user] = await tx`SELECT id FROM lotmark.users LIMIT 1`;
    const [row] = await tx`
      INSERT INTO lotmark.sessions
        (tenant_id, user_id, token_hash, expires_at, revoked_at, revoked_reason)
      VALUES (${tenantId}, ${(user as { id: string }).id},
              ${`retention-test-${ageDays}-${Date.now()}`},
              now() - make_interval(days => ${ageDays}),
              now() - make_interval(days => ${ageDays}), 'retention test')
      RETURNING id`;
    return (row as { id: string }).id;
  });

  const stillThere = (id: string) => asTenant(async (tx) => {
    const rows = await tx`SELECT 1 FROM lotmark.sessions WHERE id = ${id}`;
    return rows.length === 1;
  });

  it('keeps a session the regulator still wants', async () => {
    // Thirty days old: long gone under the old seven-day rule, and well inside
    // the 180 days CERT-In requires.
    const id = await aSession(30);
    await asTenant((tx, tenantId) => pruneSessions(tx, {
      id: tenantId, slug: 'ipc', timeSource: 'ntp', region: 'in',
    }));
    expect(await stillThere(id),
      'CERT-In 2022 requires 180 days; this was deleted after 7').toBe(true);
  });

  it('removes one that has outlived its retention', async () => {
    const id = await aSession(400);
    await asTenant((tx, tenantId) => pruneSessions(tx, {
      id: tenantId, slug: 'ipc', timeSource: 'ntp', region: 'in',
    }));
    expect(await stillThere(id)).toBe(false);
  });
});
