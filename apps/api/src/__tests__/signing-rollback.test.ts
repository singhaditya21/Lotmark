import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction } from '../db';
import { SigningError, SigningRejection, rejectSigning } from '../services/signing';

/**
 * A signing refusal must leave NOTHING behind.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The record-creating routes insert their row and then sign it in one
 * transaction. When signing was refused they RETURNED a status object from
 * inside the transaction callback. postgres.js commits a callback that
 * resolves, so the unsigned row was committed.
 *
 * The trigger is not exotic. It is the ordinary step-up prompt that every user
 * meets on their first signing of a session: a reissue attempt would commit a
 * new certificate issue with no signature, no rendered PDF and no verification
 * token, and that phantom then became the CURRENT issue — superseding a real
 * signed document with one a holder would find nothing behind. Every retry made
 * another.
 *
 * This was masked by a second defect: the console's step-up detection was also
 * broken, so it never retried and nobody watched the phantoms accumulate.
 *
 * These tests perform the act rather than reasoning about it.
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
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** Sign in fully, including the second factor, and return the session cookie. */
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

/** Open a signing session, so the successful path can be exercised too. */
async function stepUp(cookie: string): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/step-up',
    headers: { cookie }, payload: { password: PASSWORD, code: currentTotp() },
  });
  expect(res.statusCode, `step-up: ${res.body}`).toBe(200);
}

async function tenantId(): Promise<string> {
  const [row] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  return (row as { id: string }).id;
}

/** Straight to the database: the API's own view is what is under suspicion. */
async function issueCount(certificateId: string): Promise<number> {
  const tenant = await tenantId();
  return inTenantTransaction(
    app.db, { tenantId: tenant, auditKey: app.cfg.LOTMARK_AUDIT_KEY },
    async (tx) => {
      const [row] = await tx`
        SELECT count(*)::int AS n FROM lotmark.certificate_issues
        WHERE certificate_id = ${certificateId}`;
      return (row as { n: number }).n;
    },
  );
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

describe('a reissue refused at the signing step leaves no record behind', () => {
  it('returns a step-up prompt and creates NO new issue', async () => {
    // Asha holds cert:reissue and the competence for cert:issue. Her session is
    // authenticated but has NOT been stepped up, which is the state every
    // session is in until the first signing of that session.
    const cookie = await signIn('asha@producer.example');
    const cert = await findCertificate(cookie);
    if (!cert) {
      throw new Error('No certificate in the seeded data; run pnpm db:setup before this suite.');
    }

    const before = await issueCount(cert.id);

    const attempt = await app.inject({
      method: 'POST', url: `/api/v1/certificates/${cert.id}/reissue`,
      headers: { cookie },
      payload: { meaning: 'approval', reason: 'Deliberate refusal, exercising the rollback path.' },
    });

    expect(attempt.statusCode, attempt.body).toBe(401);
    expect(attempt.json<{ code: string }>().code).toBe('step_up_required');

    // THE assertion. The status code was already correct before the fix; what
    // was wrong is what the database was left holding.
    const after = await issueCount(cert.id);
    expect(after, 'a refused reissue must not create a certificate issue').toBe(before);
  });

  it('creates no issue however many times it is retried', async () => {
    // The console retries after a step-up, so a leak here compounds. Three
    // attempts previously produced three phantom issues.
    const cookie = await signIn('asha@producer.example');
    const cert = await findCertificate(cookie);
    if (!cert) throw new Error('No certificate in the seeded data.');

    const before = await issueCount(cert.id);
    for (let i = 0; i < 3; i++) {
      const attempt = await app.inject({
        method: 'POST', url: `/api/v1/certificates/${cert.id}/reissue`,
        headers: { cookie },
        payload: { meaning: 'approval', reason: `Retry ${i + 1}` },
      });
      expect(attempt.statusCode).toBe(401);
    }
    expect(await issueCount(cert.id), 'three refusals, three phantoms, before the fix').toBe(before);
  });

  it('still RECORDS the refusal, on its own transaction', async () => {
    /**
     * The rollback must not take the evidence with it. An audit entry written
     * inside the doomed transaction would vanish along with the row it
     * described, and a control that fired silently is indistinguishable from
     * one that never ran.
     */
    const cookie = await signIn('asha@producer.example');
    const cert = await findCertificate(cookie);
    if (!cert) throw new Error('No certificate in the seeded data.');

    const tenant = await tenantId();
    const countRefusals = () => inTenantTransaction(
      app.db, { tenantId: tenant, auditKey: app.cfg.LOTMARK_AUDIT_KEY },
      async (tx) => {
        const [row] = await tx`
          SELECT count(*)::int AS n FROM lotmark.audit_ledger
          WHERE tenant_id = ${tenant} AND kind = 'SECURITY'
            AND action = 'Signing refused; the unsigned record was discarded'`;
        return (row as { n: number }).n;
      },
    );

    const before = await countRefusals();
    await app.inject({
      method: 'POST', url: `/api/v1/certificates/${cert.id}/reissue`,
      headers: { cookie },
      payload: { meaning: 'approval', reason: 'Refusal must still be recorded.' },
    });
    expect(await countRefusals(), 'the refusal must survive the rollback').toBe(before + 1);
  });
});

describe('rejectSigning', () => {
  it('converts a signing error into a rejection that rolls back', () => {
    try {
      rejectSigning(new SigningError('step up first', 'step_up_required'),
        { table: 'certificate_issues', label: 'CRT-1 issue #2' });
      expect.unreachable('rejectSigning must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SigningRejection);
      const r = e as SigningRejection;
      expect(r.httpStatus).toBe(401);
      expect(r.subject.table).toBe('certificate_issues');
    }
  });

  it('maps every non-step-up signing failure to a conflict', () => {
    for (const code of ['competence_basis_missing', 'competence_basis_invalid', 'already_signed'] as const) {
      try {
        rejectSigning(new SigningError('no', code), { table: 't', label: 'l' });
        expect.unreachable('must throw');
      } catch (e) {
        expect((e as SigningRejection).httpStatus).toBe(409);
      }
    }
  });

  it('re-throws anything that is not a signing failure, untouched', () => {
    // An unexpected error must not be laundered into a tidy 409 — that would
    // turn a bug into a message telling the user to try again.
    const boom = new TypeError('something else went wrong');
    expect(() => rejectSigning(boom, { table: 't', label: 'l' })).toThrow(boom);
  });
});


describe('a reissue that succeeds records the custody the key is actually held under', () => {
  it('writes the configured custody class onto the issue it renders', async () => {
    /**
     * The certificate PRINTS this. It is the product's own statement about how
     * well the signing key is protected, and the one value most relied upon to
     * be honest — so it is asserted as a RELATIONSHIP rather than against a
     * literal: whatever class this machine is configured for is the class the
     * document must claim. A test pinned to 'dev_file' would pass on a laptop
     * and say nothing about a deployment.
     */
    const cookie = await signIn('asha@producer.example');
    const cert = await findCertificate(cookie);
    if (!cert) throw new Error('No certificate in the seeded data; run pnpm db:setup.');

    await stepUp(cookie);

    const before = await issueCount(cert.id);
    const done = await app.inject({
      method: 'POST', url: `/api/v1/certificates/${cert.id}/reissue`,
      headers: { cookie },
      payload: { meaning: 'approval', reason: 'Exercising the successful signing path.' },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await issueCount(cert.id), 'a successful reissue DOES create an issue').toBe(before + 1);

    const tenant = await tenantId();
    const recorded = await inTenantTransaction(
      app.db, { tenantId: tenant, auditKey: app.cfg.LOTMARK_AUDIT_KEY },
      async (tx) => {
        const [row] = await tx`
          SELECT i.data_snapshot ->> 'keyCustody' AS snapshot_custody,
                 i.data_snapshot ->> 'verificationOrigin' AS snapshot_origin,
                 i.document_sha256, i.renderer_version,
                 k.custody AS key_custody
          FROM lotmark.certificate_issues i
          JOIN lotmark.signing_keys k
            ON k.tenant_id = i.tenant_id AND k.key_version = i.document_key_version
          WHERE i.certificate_id = ${cert.id}
          ORDER BY i.issue_number DESC LIMIT 1`;
        return row as {
          snapshot_custody: string; snapshot_origin: string | null;
          document_sha256: string | null;
          renderer_version: string; key_custody: string;
        };
      },
    );

    expect(recorded.snapshot_custody, 'the document must not overclaim its key custody')
      .toBe(recorded.key_custody);
    expect(recorded.document_sha256, 'a signed issue must have a rendered document').not.toBeNull();
    expect(recorded.renderer_version).toBe('lotmark-pdf-3');

    /*
     * The last link in the chain, and the one that was actually broken.
     *
     * certificate-pdf.test.ts proves the RENDERER honours the origin it is
     * given. This proves the ROUTE gives it the configured one — the join that
     * did not exist, and could not have, because CertificateSnapshot had no
     * origin field at all. Read from the stored snapshot rather than from the
     * response body, because the snapshot is what a re-render years from now
     * will use.
     */
    expect(recorded.snapshot_origin,
      'the issued certificate did not record the origin it was issued under')
      .toBe(app.cfg.PUBLIC_ORIGIN);
  });
});


describe('a key that was never committed must never sign anything', () => {
  it('does not carry a rolled-back key forward in memory', async () => {
    /**
     * The bug this reproduces.
     *
     * `KeyProvider.active()` mints a key inside the CALLER'S transaction and
     * used to cache it in memory immediately. A refused signing rolls that
     * transaction back — so the registration vanished while the cache kept the
     * key, and the next request signed with a key the database had no record
     * of. `publicKeyFor` returns null for such a key, which makes the signature
     * unverifiable by anyone, including the assessor it exists for.
     *
     * The sequence below is exactly how it happened: a refused reissue, then a
     * successful one.
     */
    const cookie = await signIn('asha@producer.example');
    const cert = await findCertificate(cookie);
    if (!cert) throw new Error('No certificate in the seeded data; run pnpm db:setup.');

    // A refusal. If a key is minted here, its registration rolls back with it.
    const refused = await app.inject({
      method: 'POST', url: `/api/v1/certificates/${cert.id}/reissue`,
      headers: { cookie },
      payload: { meaning: 'approval', reason: 'Refused, so any minted key rolls back.' },
    });
    expect(refused.statusCode).toBe(401);

    await stepUp(cookie);
    const done = await app.inject({
      method: 'POST', url: `/api/v1/certificates/${cert.id}/reissue`,
      headers: { cookie },
      payload: { meaning: 'approval', reason: 'And now one that succeeds.' },
    });
    expect(done.statusCode, done.body).toBe(200);

    // THE invariant: nothing signed may reference a key that is not registered.
    const tenant = await tenantId();
    const orphans = await inTenantTransaction(
      app.db, { tenantId: tenant, auditKey: app.cfg.LOTMARK_AUDIT_KEY },
      (tx) => tx`
        SELECT i.issue_number, i.document_key_version
        FROM lotmark.certificate_issues i
        WHERE i.document_key_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM lotmark.signing_keys k
            WHERE k.tenant_id = i.tenant_id AND k.key_version = i.document_key_version)`,
    );
    expect(
      orphans,
      'a signed document referencing an unregistered key can never be verified',
    ).toEqual([]);
  });
});
