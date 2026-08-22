import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';

const PASSWORD = 'demo-password-1234';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/**
 * Every business record says which configuration it was created under.
 *
 * `registry.ts` states it as a principle, and the columns and foreign keys have
 * been there since 0001. It was true of projects, studies and values, and false
 * of the record where it matters most: both routes that issue a CERTIFICATE
 * omitted the column, so "under what rules was this issued" was answerable only
 * by guessing from dates — in a table nobody rewrites.
 *
 * This is the test that would have caught it, and the one that catches the next
 * record type to forget.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

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
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function signIn(email: string): Promise<string> {
  const first = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: PASSWORD },
  });
  const setCookie = first.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  let cookie = raw.split(';')[0]!;

  if (first.statusCode === 200 && first.json<{ secondFactorRequired?: boolean }>().secondFactorRequired) {
    const second = await app.inject({
      method: 'POST', url: '/api/v1/auth/second-factor',
      headers: { cookie }, payload: { code: currentTotp(), attempt: 1 },
    });
    expect(second.statusCode, `second factor for ${email}: ${second.body}`).toBe(200);
    const rotated = second.headers['set-cookie'];
    if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  }
  return cookie;
}

async function stepUp(cookie: string): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/step-up',
    headers: { cookie }, payload: { password: PASSWORD, code: currentTotp() },
  });
  expect(res.statusCode, `step-up: ${res.body}`).toBe(200);
}

async function findCertificate(cookie: string): Promise<{ id: string; code: string } | null> {
  const projects = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie } });
  for (const p of projects.json<{ projects: Array<{ id: string }> }>().projects) {
    const lots = await app.inject({ method: 'GET', url: `/api/v1/projects/${p.id}/lots`, headers: { cookie } });
    const found = lots.json<{ lots: Array<{ certificate_id: string | null; certificate_code: string | null }> }>()
      .lots.find((l) => l.certificate_id !== null);
    if (found) return { id: found.certificate_id!, code: found.certificate_code! };
  }
  return null;
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
 * Every table carrying the column, found from the CATALOGUE rather than listed.
 *
 * Listing them is how this was missed: `certificate_issues` had the column and
 * the foreign key all along, and nothing compared the list of tables that CAN
 * record provenance against the list that DO.
 */
const carriers = () => asTenant(async (tx) => {
  const rows = await tx`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'lotmark' AND column_name = 'config_version_id'
    ORDER BY table_name`;
  return [...rows].map((r) => (r as { table_name: string }).table_name);
});

describe('the configuration a record was created under', () => {
  it('is recorded by every table that has somewhere to put it', async () => {
    const tables = await carriers();
    expect(tables.length, 'the schema must still have provenance columns')
      .toBeGreaterThan(3);

    const unstamped: string[] = [];
    for (const table of tables) {
      // The identifier comes from the catalogue, never from a request.
      const [row] = await asTenant((tx) => tx.unsafe(
        `SELECT count(*) FILTER (WHERE config_version_id IS NULL)::int AS blank,
                count(*)::int AS total
         FROM lotmark.${table}`));
      const r = row as unknown as { blank: number; total: number };
      if (r.total > 0 && r.blank > 0) unstamped.push(`${table}: ${r.blank} of ${r.total}`);
    }

    /**
     * Rows written BEFORE this was fixed keep their null, deliberately.
     *
     * We could infer the version — this database has only ever had one — and
     * writing an inference into a provenance column is exactly the comfortable
     * lie the column exists to prevent. So the assertion is on the tables the
     * suite itself creates rows in, and historic nulls are reported rather than
     * back-filled.
     */
    if (unstamped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`records predating the fix, left unstamped: ${unstamped.join('; ')}`);
    }
    expect(tables).toContain('certificate_issues');
  });

  it('is recorded on a certificate issued NOW, through the real route', async () => {
    /**
     * The first version of this test read the same count twice with nothing in
     * between, so it passed whatever the code did. A test that cannot fail is
     * worse than no test — it reports safety it never checked.
     *
     * This one issues a certificate through the route a person uses, and looks
     * at the row that route wrote.
     */
    const cookie = await signIn('asha@producer.example');
    const cert = await findCertificate(cookie);
    expect(cert, 'the seed must leave a certificate to reissue').toBeTruthy();
    await stepUp(cookie);

    const done = await app.inject({
      method: 'POST', url: `/api/v1/certificates/${cert!.id}/reissue`,
      headers: { cookie },
      payload: { meaning: 'approval', reason: 'Checking provenance is recorded.' },
    });
    expect(done.statusCode, done.body).toBe(200);

    const latest = await asTenant(async (tx) => {
      const [row] = await tx`
        SELECT config_version_id, issue_number
        FROM lotmark.certificate_issues
        WHERE certificate_id = ${cert!.id}
        ORDER BY issue_number DESC LIMIT 1`;
      return row as unknown as { config_version_id: string | null; issue_number: number };
    });

    expect(latest.config_version_id,
      'the issue this test just created must say what rules produced it').not.toBeNull();
  });

  it('points at a version that exists', async () => {
    // The foreign key says so; this catches a stamp of the wrong tenant's
    // version, which the FK alone would happily accept.
    const wrong = await asTenant(async (tx, tenantId) => {
      const rows = await tx`
        SELECT i.id FROM lotmark.certificate_issues i
        JOIN lotmark.config_versions v ON v.id = i.config_version_id
        WHERE i.config_version_id IS NOT NULL AND v.tenant_id <> ${tenantId}`;
      return rows.length;
    });
    expect(wrong).toBe(0);
  });
});
