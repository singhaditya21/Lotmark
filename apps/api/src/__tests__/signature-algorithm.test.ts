import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { signaturePayload, type SignableRecord } from '@lotmark/domain';
import { signPayload, payloadDigest } from '@lotmark/security';
import { verifyStoredSignature } from '../services/signing';

/**
 * A signature this build cannot check is not a signature that failed.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `verifyStoredSignature` never read `signatures.algorithm`. The query says
 * `s.*`, but the row cast omitted the column, so an ed25519 verification was
 * attempted on every stored signature whatever it claimed to be — and the
 * boolean that came back was the whole verdict.
 *
 * `signatures.algorithm` is free text: 0003 constrains
 * `signing_keys.algorithm` to ed25519 and leaves the signature's own copy
 * unconstrained, holding whatever was inserted. A row written by a newer build,
 * a retired algorithm, and a typo therefore all produced one of two wrong
 * answers, both measured before the fix:
 *
 *   algorithm 'ml-dsa-65', bytes that are not an ed25519 signature
 *     → {"ok":false,"reason":"the record was altered after it was signed"}
 *
 *   algorithm 'ml-dsa-65', bytes that ARE a valid ed25519 signature
 *     → {"ok":true,"signedBy":"Dr. Asha Pillai",...}
 *
 * The first is a false accusation of tampering with a Part 11 signature, which
 * is the most damaging finding this system can produce. The second is the same
 * defect failing open, which is worse.
 *
 * These tests store rows rather than reasoning about them. `signatures` refuses
 * UPDATE and DELETE (0002), so each case is a fresh INSERT over its own
 * synthetic subject id — `subject_id` is polymorphic and carries no foreign
 * key, so no study has to be manufactured to hang one off.
 */

let app: FastifyInstance;
let tenantId: string;
let signerUserId: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  const [t] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  tenantId = (t as { id: string }).id;
  // Under forced row-level security a bare `app.db` read returns nothing, so
  // the signer is fetched inside a tenant transaction like everything else.
  signerUserId = await inTenant(async (tx) => {
    const [u] = await tx`SELECT id FROM lotmark.users ORDER BY id LIMIT 1`;
    return (u as { id: string }).id;
  });
});

afterAll(async () => { await app.close(); });

const inTenant = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
  inTenantTransaction(app.db, {
    tenantId, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
  }, fn);

/**
 * Store a signature row directly, so the algorithm column can be dictated.
 *
 * `applySignature` hardcodes the one algorithm this build signs with, which is
 * correct and also means it cannot produce the row under test. The row that
 * matters here is one this build did not write.
 */
async function storeSignature(args: {
  readonly algorithm: string;
  /** false stores bytes that are not a valid ed25519 signature over the payload. */
  readonly genuine?: boolean;
}): Promise<{ subjectId: string; signable: SignableRecord }> {
  const subjectId = randomUUID();
  const signable: SignableRecord = {
    kind: 'study',
    record: {
      id: `ALG-${subjectId.slice(0, 8)}`,
      projectId: 'PRJ-ALG',
      type: 'homogeneity',
      equipmentIds: ['EQ-1'],
      uncertainty: 0.25,
    },
  };

  await inTenant(async (tx) => {
    const key = await app.keys.active(tx, tenantId);
    // The same clock and the same rendering `applySignature` uses, because
    // `normaliseInstant` has to reproduce this instant byte for byte or the
    // payload differs and every case below fails for the wrong reason.
    const [clock] = await tx`
      SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
    const signedAt = (clock as { t: string }).t;
    const payload = signaturePayload({
      signable, signerUserId, meaning: 'approval', signedAt,
    });
    const value = args.genuine === false
      ? Buffer.alloc(64, 7).toString('base64')
      : signPayload(payload, key.privateKey);

    await tx`
      INSERT INTO lotmark.signatures
        (tenant_id, subject_kind, subject_id, signer_user_id, meaning, signed_at,
         time_source, region, binding_hash, signature_value, algorithm,
         canonical_version, key_version)
      VALUES (${tenantId}, 'study', ${subjectId}, ${signerUserId}, 'approval',
              ${signedAt}::timestamptz, 'local', 'test',
              ${payloadDigest(payload)}, ${value}, ${args.algorithm},
              '1', ${key.keyVersion})`;
  });

  return { subjectId, signable };
}

const verify = (stored: { subjectId: string; signable: SignableRecord }) =>
  inTenant((tx) => verifyStoredSignature(tx, app.keys, {
    tenantId, signable: stored.signable, subjectId: stored.subjectId,
  }));

describe('a signature stored under an algorithm this build does not implement', () => {
  it('is reported as unverifiable, never as an altered record', async () => {
    const result = await verify(await storeSignature({
      algorithm: 'ml-dsa-65', genuine: false,
    }));

    /**
     * FIRST, deliberately. This sentence is the one an assessor reads as
     * "somebody tampered with a Part 11 signature", and an unrecognised
     * algorithm must never produce it — so it is the assertion that should
     * fire before any about the result's shape.
     */
    expect(result.reason, 'an unknown algorithm is not evidence of tampering')
      .not.toMatch(/altered/i);

    expect(result.status).toBe('unverifiable');
    expect(result.ok, 'fail closed — unverifiable is not verified').toBe(false);

    // And it must name what it could not do, so the reader can tell a newer
    // build from a retired algorithm from a typo.
    expect(result.reason).toMatch(/ml-dsa-65/);
    expect(result.reason).toMatch(/ed25519/);
  });

  /**
   * The fail-OPEN half, and the reason the algorithm is checked before the
   * signature rather than after.
   *
   * These bytes verify perfectly well as ed25519 — they were made that way.
   * The row says they are something else. Nothing here has established that
   * this signature is what it claims to be, so nothing may report that it is.
   */
  it('is not reported valid merely because ed25519 happens to accept the bytes', async () => {
    const result = await verify(await storeSignature({
      algorithm: 'ml-dsa-65', genuine: true,
    }));

    expect(result.ok, 'a signature this build cannot check is not a verified one').toBe(false);
    expect(result.status).toBe('unverifiable');
    expect(result.signedBy, 'no signer is attested to on an unchecked signature').toBeUndefined();
  });
});

describe('a signature stored under the algorithm this build does implement', () => {
  it('verifies, and says who signed it', async () => {
    const result = await verify(await storeSignature({ algorithm: 'ed25519' }));

    expect(result.status).toBe('valid');
    expect(result.ok).toBe(true);
    expect(result.signedBy).toBeTruthy();
    expect(result.keyVersion).toBe('rec-v1');
  });

  /**
   * The control. Distinguishing the cases is worth nothing if it also blunts
   * the finding that matters — a real ed25519 signature that does not verify
   * is still an altered record, and still says so.
   */
  it('still reports an alteration when the signature does not verify', async () => {
    const result = await verify(await storeSignature({
      algorithm: 'ed25519', genuine: false,
    }));

    expect(result.status).toBe('invalid');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/altered after it was signed/);
  });
});
