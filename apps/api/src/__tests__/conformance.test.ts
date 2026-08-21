import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction } from '../db';
import { buildAssessmentPack, canonicalJson } from '../services/conformance';

/**
 * Conformance reporting, and the pack an assessor takes away.
 *
 * The assertions worth having are the ones that stop this becoming a
 * specification with ticks beside it: that a declared-and-unenforced
 * requirement cannot present as satisfied, that the pack states its own limits,
 * and that its digest means something.
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
let neha: string;
let ravi: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  neha = await signIn('neha@producer.example');
  ravi = await signIn('ravi@producer.example');
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

async function tenantId(): Promise<string> {
  const [row] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  return (row as { id: string }).id;
}

const inTenant = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  tenantId().then((t) => inTenantTransaction(app.db, {
    tenantId: t,
    auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
    organisationKind: 'producer',
  }, fn as never));

describe('who may see conformance, and who may export it', () => {
  it('gives the Quality Manager the view', async () => {
    const res: LightMyRequestResponse = await app.inject({
      method: 'GET', url: '/api/v1/conformance', headers: { cookie: neha },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ clauses: unknown[] }>().clauses.length).toBeGreaterThan(10);
  });

  it('refuses somebody without conformance:read', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/conformance', headers: { cookie: ravi },
    });
    expect(res.statusCode).toBe(403);
  });

  it('treats exporting as a separate act from reading', async () => {
    /**
     * Assembling a bundle of the producer's records to send outside is not the
     * same act as looking at a screen, so it needs `audit:export` rather than
     * `conformance:read` — and it is audited.
     */
    const res = await app.inject({
      method: 'POST', url: '/api/v1/conformance/pack', headers: { cookie: ravi }, payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('the view refuses to round a gap up to a pass', () => {
  it('reports the subcontracting requirement as declared, not enforced', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/conformance', headers: { cookie: neha },
    });
    const body = res.json<{
      clauses: Array<{ clause: string; status: string;
        requirements: Array<{ id: string; status: string; note?: string }> }>;
    }>();
    const clause = body.clauses.find((c) => c.clause.includes('§7.4'))!;
    expect(clause.status).toBe('declared');
    const req = clause.requirements.find((r) => r.id === 'REQ-SUBCONTRACT')!;
    expect(req.note, 'and it says what is missing').toMatch(/does not exist/);
  });

  it('gives a clause the status of its WEAKEST requirement', async () => {
    // Averaging would let one enforced requirement hide a declared one, which
    // is precisely the report an assessor cannot use.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/conformance', headers: { cookie: neha },
    });
    const body = res.json<{
      clauses: Array<{ status: string; requirements: Array<{ status: string }> }>;
    }>();
    const rank: Record<string, number> = {
      not_implemented: 0, declared: 1, partial: 2, enforced: 3,
    };
    for (const c of body.clauses) {
      const worst = Math.min(...c.requirements.map((r) => rank[r.status]!));
      expect(rank[c.status]).toBe(worst);
    }
  });

  it('does not claim dev_file custody satisfies the key requirement', async () => {
    // dev_file is honest, not compliant. The distinction is the whole point of
    // separating the status of the CODE from the evidence in the RECORDS.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/conformance', headers: { cookie: neha },
    });
    const body = res.json<{
      clauses: Array<{ requirements: Array<{
        id: string; evidence: { summary: string; satisfied: boolean } | null }> }>;
    }>();
    const custody = body.clauses
      .flatMap((c) => c.requirements)
      .find((r) => r.id === 'REQ-KEY-CUSTODY')!;
    if (custody.evidence?.summary.includes('dev_file')) {
      expect(custody.evidence.satisfied,
        'a development key file must not read as satisfying key custody').toBe(false);
    }
  });
});

describe('the assessment pack', () => {
  const pack = () => inTenant((tx) =>
    tenantId().then((t) => buildAssessmentPack(tx, t, () => null)));

  it('carries the sections an assessor asks for', async () => {
    const p = await pack();
    for (const section of [
      'scope', 'competence', 'equipment', 'certificates', 'capa',
      'signatures', 'auditChain', 'anchors', 'drills', 'configuration',
    ]) {
      expect(Object.keys(p.sections), `missing section: ${section}`).toContain(section);
    }
    expect(p.requirements.length).toBeGreaterThan(20);
  });

  it('digests to the same value for the same records', async () => {
    /**
     * `generatedAt` is deliberately excluded from the digest. Including it
     * would make two exports of identical records differ, and the digest would
     * then prove nothing about the records — which is the only thing it is for.
     *
     * BOTH packs are built inside ONE transaction, so they read the same
     * snapshot. Built in two, this failed as soon as the suite ran in parallel:
     * another test file placed an order between them, the digest changed, and
     * the test was right to notice. The claim being made is about identical
     * records, so identical records are what it has to compare.
     */
    const [a, b] = await inTenant(async (tx) => {
      const t = await tenantId();
      const first = await buildAssessmentPack(tx, t, () => null);
      const second = await buildAssessmentPack(tx, t, () => null);
      return [first, second] as const;
    });
    expect(a.manifest.packDigest).toBe(b.manifest.packDigest);
    expect(a.manifest.sectionDigests).toEqual(b.manifest.sectionDigests);
  });

  it('digests each section separately as well as the whole', async () => {
    // So a dispute about one part does not require re-establishing all of it,
    // and a section can be quoted with a digest that means something alone.
    const p = await pack();
    for (const [name, d] of Object.entries(p.manifest.sectionDigests)) {
      expect(d, name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(p.manifest.sectionDigests).sort())
      .toEqual(Object.keys(p.sections).sort());
  });

  it('records the entry COUNT beside the chain verdict', async () => {
    /**
     * `verify_audit_chain` walks from seq 1 and checks continuity and the HMAC.
     * A ledger truncated at its END still returns ok. Only the recorded count,
     * compared against a previous pack or an anchor, makes that detectable.
     */
    const p = await pack();
    const chain = p.sections['auditChain'] as { entriesHeld: number; headSeq: number | null };
    expect(chain.entriesHeld).toBeGreaterThan(0);
    expect(chain.headSeq).toBe(chain.entriesHeld);
  });

  it('states its own limits rather than implying there are none', async () => {
    const p = await pack();
    expect(p.limits.length).toBeGreaterThan(2);
    const text = p.limits.join(' ');
    expect(text, 'the PDF/A limit must be stated').toMatch(/veraPDF/);
    expect(text, 'the truncation limit must be stated').toMatch(/truncated/);
    expect(text, 'it must not present itself as an accreditation finding')
      .toMatch(/not an accreditation body/);
  });

  it('canonicalises so key order cannot change the digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: [1, { d: 4, c: 3 }] }))
      .toBe(canonicalJson({ a: [1, { c: 3, d: 4 }] }));
  });
});
