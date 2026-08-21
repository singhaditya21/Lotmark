import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { tenantSod, resolveSod, PRODUCT_SOD, type TenantSod } from '../services/sod';
import { findSodViolation, findThresholdViolation, defaultSodSettings } from '@lotmark/domain';

/**
 * Segregation of duties, as the TENANT configured it.
 *
 * The rules live in code because they carry the conformance argument an
 * assessor is shown. Whether each is enabled has been per-tenant configuration
 * since the first release — `sod.ts` says so: "a smaller laboratory may
 * legitimately find one impractical, and switching one off is itself an
 * auditable governance act."
 *
 * It was auditable and it was not applied. Six `sod` entries have been seeded
 * all along and nothing read one, so a laboratory that turned a rule on got the
 * product's default and no sign its decision had not taken.
 */

const PASSWORD = 'demo-password-1234';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
function currentTotp(): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32(TOTP_SECRET)).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  const code = ((mac[o]! & 127) << 24) | ((mac[o + 1]! & 255) << 16)
    | ((mac[o + 2]! & 255) << 8) | (mac[o + 3]! & 255);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  admin = await signIn('admin@producer.example');
});
afterAll(async () => { await app.close(); });

async function signIn(email: string): Promise<string> {
  const first = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: PASSWORD },
  });
  const raw = first.headers['set-cookie'];
  let cookie = (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
  if (first.json<{ secondFactorRequired?: boolean }>().secondFactorRequired) {
    const second = await app.inject({
      method: 'POST', url: '/api/v1/auth/second-factor',
      headers: { cookie }, payload: { code: currentTotp(), attempt: 1 },
    });
    expect(second.statusCode, second.body).toBe(200);
    const rotated = second.headers['set-cookie'];
    if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  }
  return cookie;
}

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

/**
 * The seeded entries, with one setting replaced.
 *
 * Built in memory and handed to the resolver, so this needs no draft. There is
 * ONE draft per tenant, so a test file that opened one to prove something about
 * resolution fought every other file that opens one — which is exactly what
 * happened the first time this was written: it passed alone and failed in the
 * suite.
 */
const seededEntries = () => asTenant(async (tx, tenantId) => {
  const rows = await tx`
    SELECT e.kind, e.key, e.payload
    FROM lotmark.config_entries e
    JOIN lotmark.config_versions v ON v.id = e.version_id
    WHERE v.tenant_id = ${tenantId} AND v.status = 'active'`;
  return [...rows] as Array<{ kind: string; key: string; payload: unknown }>;
});

async function sodWith(
  entry: Record<string, unknown>, onProblem?: (m: string) => void,
): Promise<TenantSod> {
  const entries = await seededEntries();
  const key = String(entry['ruleId']);
  const without = entries.filter((e) => !(e.kind === 'sod' && e.key === key));
  return resolveSod([...without, { kind: 'sod', key, payload: entry }], onProblem);
}

describe('what the tenant configured is what runs', () => {
  it('reads the seeded settings rather than assuming the defaults', async () => {
    const sod = await asTenant((tx, tenantId) => tenantSod(tx, tenantId));
    // The seed writes every rule at its product default, so the two agree —
    // which is the point: a tenant that has configured nothing behaves exactly
    // as it did before any of this was read.
    expect(sod.settings).toEqual(defaultSodSettings());
  });

  it('turns a rule ON when the tenant says so, and the guard obeys', async () => {
    /**
     * SoD-3 — the assigner of a value may not issue the certificate carrying it
     * — ships OFF, because a small laboratory may have one person holding both
     * roles. A larger one turns it on. Until now that decision did nothing.
     */
    const rule = 'value-assigner-may-not-issue-certificate';
    const off = await asTenant((tx, t) => tenantSod(tx, t));
    expect(findSodViolation('cert:issue', { assignedBy: 'u-1' }, 'u-1', off.settings)).toBeNull();

    const on = await sodWith({ ruleId: rule, enabled: true });
    const violation = findSodViolation('cert:issue', { assignedBy: 'u-1' }, 'u-1', on.settings);
    expect(violation, 'the tenant enabled it, so it must fire').not.toBeNull();
    expect(violation!.reason).toMatch(/cannot issue the certificate/);
  });

  it('turns a rule OFF when the tenant says so', async () => {
    // The four-eyes rule on authorising a value ships ON. Switching it off is a
    // signed, audited governance act — and it has to actually take effect, or
    // the act was theatre.
    const rule = 'value-assigner-may-not-authorise';
    const waived = await sodWith({ ruleId: rule, enabled: false });
    expect(findSodViolation('value:authorise', { assignedBy: 'u-1' }, 'u-1', waived.settings))
      .toBeNull();

    // And the active configuration is untouched by that draft.
    const active = await asTenant((tx, t) => tenantSod(tx, t));
    expect(findSodViolation('value:authorise', { assignedBy: 'u-1' }, 'u-1', active.settings))
      .not.toBeNull();
  });

  it('uses the tenant’s threshold figures, not the product’s', async () => {
    /**
     * `sodConfigSchema` has carried `thresholdMinor` and `approversRequired`
     * since it was written and the evaluator used the numbers in the code — so
     * a tenant that set its refund threshold to a lakh got the product's five
     * thousand and no indication otherwise.
     */
    const rule = 'refund-above-threshold-needs-second-approver';
    const sod = await sodWith({
      ruleId: rule, enabled: true, thresholdMinor: 100_000_00, approversRequired: 3,
    });
    expect(sod.thresholds[rule]).toEqual({ thresholdMinor: 100_000_00, approversRequired: 3 });

    /**
     * And the evaluator stays SILENT, which is also correct and worth pinning
     * down: the only threshold rule is `pending-subject` because refunds are
     * not in the schema at all, and the evaluator skips a rule whose subject
     * does not exist. So the tenant's figures are resolved and carried, and
     * nothing consults them until there is a refund to consult them about.
     *
     * Asserting the silence rather than leaving it unmentioned is the point. A
     * test that expected a violation here would be asserting a feature that
     * does not exist, and passing it would have meant faking one.
     */
    expect(findThresholdViolation(
      'order:refund', 100_000_00, ['a', 'b'], sod.settings, sod.thresholds),
      'refunds are not modelled, so no threshold rule can fire yet').toBeNull();
  });

  it('ignores a setting for a rule this system does not have', async () => {
    // Publication refuses one; this is what happens to an entry that arrived
    // another way. It is skipped with a reason, and every real rule is
    // unaffected — one bad entry cannot disable the register.
    const said: string[] = [];
    const sod = await sodWith({ ruleId: 'invented-rule', enabled: false }, (m) => said.push(m));
    expect(said.join(' ')).toMatch(/no such rule/);
    expect(findSodViolation('value:authorise', { assignedBy: 'u-1' }, 'u-1', sod.settings),
      'every real rule keeps its default').not.toBeNull();
  });

  it('falls back to the product when a tenant has no configuration at all', () => {
    expect(PRODUCT_SOD.settings).toEqual(defaultSodSettings());
    expect(PRODUCT_SOD.thresholds).toEqual({});
  });
});
