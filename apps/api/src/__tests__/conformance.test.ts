import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction } from '../db';
import { buildAssessmentPack, canonicalJson, liveEvidence } from '../services/conformance';

/**
 * Conformance reporting, and the pack an assessor takes away.
 *
 * The assertions worth having are the ones that stop this becoming a
 * specification with ticks beside it: that a declared-and-unenforced
 * requirement cannot present as satisfied, that the pack states its own limits,
 * and that its digest means something.
 */

/**
 * This suite needs longer than the 5-second default, and the reason is measured
 * rather than assumed.
 *
 * `liveEvidence` makes about fifteen sequential round trips — it is a whole
 * assessment, not a page of one table — and takes roughly 700 ms on an idle
 * database. Each SQL statement is a few milliseconds; the cost is the number of
 * them, and they cannot be issued concurrently because a transaction is one
 * connection. Under a parallel suite with fourteen workers competing for one
 * PostgreSQL and for the CPU that Argon2id sign-ins want, that reliably passes
 * five seconds.
 *
 * Raising the limit here rather than globally, so the next slow test is still
 * asked to justify itself.
 */
vi.setConfig({ testTimeout: 30_000 });

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

/**
 * REPEATABLE READ, exactly as the export route uses.
 *
 * Not a test convenience. Under the default READ COMMITTED every STATEMENT
 * takes a fresh snapshot, so being inside one transaction does not stop two
 * reads disagreeing — and the whole suite runs in parallel against one
 * database, which is what surfaced it. The claim under test is about identical
 * RECORDS, so the records must hold still while both packs are built.
 */
const inTenant = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  tenantId().then((t) => inTenantTransaction(app.db, {
    tenantId: t,
    auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
    organisationKind: 'producer',
    isolation: 'repeatable read',
  }, fn as never));

/**
 * Runs `fn` inside a tenant transaction and then throws the work away.
 *
 * A drill row is the newest row the moment it is written, and the conformance
 * view reads the newest one — so a test that inserted one and left it there
 * would decide what every later assertion in this file sees. Rolling back is
 * the only way to ask "what would the view say about this row" without the row
 * becoming a fact about the database.
 */
class Rollback extends Error {
  constructor(readonly value: unknown) { super('deliberate rollback'); }
}

const inDiscardedTenant = async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
  try {
    await inTenant(async (tx) => { throw new Rollback(await fn(tx)); });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('the transaction committed, which it was supposed not to');
};

describe('a recovery drill that could not run its checks', () => {
  /**
   * The bug this pins down shipped and was recorded twice.
   *
   * The drill script marked a check it could not run as `ok: true` with the
   * word "skipped" in its detail text, computed `passed = checks.every(c =>
   * c.ok)`, and wrote `outcome: 'passed'`. The two checks that skip are the two
   * that matter — that stored certificates still match their digest, and that
   * one re-renders byte-identically — and they skip exactly when the database
   * holds no rendered certificate, which is the state a fresh seed leaves. So
   * the strongest evidence in the drill was the evidence most likely to be
   * silently absent, and the conformance view read `passed` and reported
   * recovery as demonstrated.
   *
   * Migration 0028 gave the outcome a third value for it.
   */
  const drillVerdict = (outcome: string) =>
    tenantId().then((t) => inDiscardedTenant(async (tx) => {
      const sql = tx as unknown as typeof app.db;
      await sql`
        INSERT INTO lotmark.dr_drills (tenant_id, source_label, finished_at, outcome)
        VALUES (${t}, 'proving test', now(), ${outcome})`;
      const [newest] = await sql`
        SELECT outcome FROM lotmark.dr_drills
        WHERE tenant_id = ${t} ORDER BY started_at DESC LIMIT 1`;
      expect((newest as { outcome: string }).outcome,
        'the inserted row must be the one the view reads, or this proves nothing')
        .toBe(outcome);
      return (await liveEvidence(tx, t)).get('drills')?.satisfied;
    }));

  it('is not evidence that recovery works', async () => {
    expect(await drillVerdict('incomplete')).toBe(false);
  });

  it('is still distinguished from one that failed and one that passed', async () => {
    expect(await drillVerdict('passed'), 'the control').toBe(true);
    expect(await drillVerdict('failed')).toBe(false);
  });
});

describe('the snapshot the pack is read from', () => {
  /**
   * Everything above rests on `isolation: 'repeatable read'` actually reaching
   * PostgreSQL. It is passed as a string appended to BEGIN, so a typo or a
   * driver that quietly ignored the option would leave the plumbing looking
   * right and doing nothing — and the only symptom would be a digest test that
   * fails once a month under load.
   *
   * So the level is asked for directly, and the default is asserted too: if the
   * database were globally REPEATABLE READ, the first assertion would pass
   * while proving nothing about our code.
   */
  it('is REPEATABLE READ when asked for, and READ COMMITTED when not', async () => {
    const t = await tenantId();
    const base = {
      tenantId: t,
      auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
      organisationKind: 'producer' as const,
    };
    const levelOf = (extra: { isolation?: 'repeatable read' }) =>
      inTenantTransaction(app.db, { ...base, ...extra }, async (tx) => {
        const [row] = await tx`SHOW transaction_isolation`;
        return (row as { transaction_isolation: string }).transaction_isolation;
      });

    expect(await levelOf({ isolation: 'repeatable read' })).toBe('repeatable read');
    expect(await levelOf({}), 'the option must be what changes it').toBe('read committed');
  });
});

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
     * BOTH packs are built inside ONE REPEATABLE READ transaction, so they read
     * the same snapshot. Neither half of that is optional, and each was learned
     * the hard way:
     *
     *   · built in two transactions, this failed as soon as the suite ran in
     *     parallel — another file placed an order between them;
     *   · built in one transaction at the DEFAULT isolation, it failed again
     *     when a concurrent file created a user, because READ COMMITTED takes a
     *     fresh snapshot per STATEMENT, not per transaction.
     *
     * The claim being made is about identical records, so identical records are
     * what it has to compare. The export route reads at the same level for the
     * same reason — a signed pack that disagrees with itself is worse than no
     * pack.
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

  /**
   * The digest is only worth carrying if somebody OUTSIDE can arrive at it.
   *
   * So this recomputes it the way an assessor does: from the published document
   * and nothing else — no database, no reach into the objects the service was
   * holding while it built the pack — applying the rule the pack states about
   * itself in `manifest.howToVerify`.
   *
   * It failed before the fix, and the two numbers are worth recording. The
   * digest was taken over the raw tenant ROW, whose key is `conformance_frame`,
   * while the pack published `conformanceFrame`: the bytes hashed were not the
   * bytes handed over. Against the seeded `ipc` tenant the pack carried
   * 6e1c8007625a6257… and this recomputation produced 954148be61657eed…, so the
   * pack's own digest disagreed with the pack.
   *
   * The pack is serialised HERE rather than fetched from POST
   * /conformance/pack, and the reason is not convenience: that route
   * deliberately will not MINT a signing key while exporting, and a freshly
   * seeded database has none, so it would fail for a reason unrelated to this
   * claim. The bytes are the same either way — the route registers no response
   * schema, so Fastify serialises the pack with `JSON.stringify`, which is the
   * line below.
   */
  it('carries a digest an outsider can recompute from the pack alone', async () => {
    const held = JSON.parse(JSON.stringify(await pack())) as {
      tenant: unknown; requirements: unknown; sections: Record<string, unknown>;
      manifest: { packDigest: string; sectionDigests: Record<string, string> };
    };

    const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

    expect(
      sha({ tenant: held.tenant, requirements: held.requirements, sections: held.sections }),
      'an assessor recomputing from the published pack must get the digest it carries',
    ).toBe(held.manifest.packDigest);

    // Each section digest has to stand on its own too, or quoting one section
    // with its digest means nothing.
    for (const [name, d] of Object.entries(held.manifest.sectionDigests)) {
      expect(sha(held.sections[name]), `section ${name}`).toBe(d);
    }
  });

  it('states the rule for recomputing its own digest', async () => {
    // The assessor has the document and not this repository. Sorted keys and an
    // excluded `generatedAt` are not guessable from the JSON, so a pack that
    // does not say them leaves its digest as a number to be taken on trust.
    const p = await pack();
    const rule = p.manifest.howToVerify.join(' ');
    expect(rule).toMatch(/SHA-256/);
    expect(rule, 'the canonicalisation must be stated').toMatch(/sorted/);
    expect(rule, 'and so must what the digest leaves out').toMatch(/generatedAt/);
  });

  it('canonicalises so key order cannot change the digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: [1, { d: 4, c: 3 }] }))
      .toBe(canonicalJson({ a: [1, { c: 3, d: 4 }] }));
  });
});
