import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { createCustody } from '../services/custody';
import { publicKeyOf, generateSigningKeyPair, publicKeyFingerprint } from '@lotmark/security';

/**
 * First use of a signing key, by two processes at once.
 *
 * ── What this is a regression for ───────────────────────────────────────────
 *
 * `active()` used to write the private half to custody and THEN register the
 * public half with a bare INSERT and no `ON CONFLICT`. `DevFileCustody.write`
 * is an unconditional overwrite. So two processes reaching first use together
 * both wrote the file, one INSERT raised 23505 and aborted its transaction, and
 * the tenant was left with one racer's public key registered against the
 * other's private key on disk — a permanent 500 on every signature, needing
 * somebody to notice and intervene.
 *
 * It happened twice here in one day, because the test suite runs files in
 * parallel forks against one key directory. In production the same shape is two
 * API instances starting against a tenant whose key has never been used.
 *
 * ── Why a synthetic tenant ──────────────────────────────────────────────────
 *
 * The race only exists at FIRST use, so it has to be tested on a tenant that
 * has no key — and clearing the demonstration tenant's registration mid-suite
 * would break every other file that signs while this one runs.
 */

let app: FastifyInstance;

/**
 * FIXED ids, not random ones.
 *
 * The first version generated a fresh uuid per run and deleted it afterwards —
 * except the delete ran on a bare connection, which under FORCED row-level
 * security removes nothing and reports success. Seventeen abandoned tenants
 * later, the lesson is the same one this suite keeps relearning: a bare
 * `app.db` write is a silent no-op.
 *
 * Fixed ids mean a re-run REUSES the tenant instead of leaving another, so the
 * count is bounded at two however many times the suite runs. What gets cleared
 * is the signing key, because first use is the thing under test.
 */
const TENANT = '00000000-0000-4000-8000-0000000000e1';
const NO_MINT_TENANT = '00000000-0000-4000-8000-0000000000e2';

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  await ensureTenant(TENANT, 'keyrace', 'Key Race');
  await ensureTenant(NO_MINT_TENANT, 'nomint', 'No Mint');

  // First use is the thing under test, so there must be no key to find.
  await inTenant((tx) => tx`DELETE FROM lotmark.signing_keys WHERE tenant_id = ${TENANT}`);
  for (const f of keyFiles()) rmSync(f, { force: true });
});

async function ensureTenant(id: string, slug: string, name: string): Promise<void> {
  const [existing] = await app.db`SELECT * FROM lotmark.resolve_tenant(${slug})`;
  if (existing) return;
  await app.db`
    SELECT lotmark.provision_tenant(
      ${id}, ${slug}, ${name}, ${`${name} Ltd`}, 'ISO 17034', 'KR-{SEQ}', 'local')`;
}

afterAll(async () => {
  // The tenants stay — they are fixed and reused. The KEY does not, so the next
  // run tests first use rather than the already-registered path.
  await inTenant((tx) => tx`DELETE FROM lotmark.signing_keys WHERE tenant_id = ${TENANT}`);
  for (const f of keyFiles()) rmSync(f, { force: true });
  await app.close();
});

const keyFiles = () => ['rec-v1', 'v1'].map((v) =>
  path.resolve(app.cfg.SIGNING_KEY_DIR, `${TENANT}.${v}.pem`));

const inTenant = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
  inTenantTransaction(app.db, {
    tenantId: TENANT, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
  }, fn);

describe('two processes reaching first use together', () => {
  /**
   * The interleaving is FORCED, not hoped for.
   *
   * A first attempt ran two `active()` calls under `Promise.all` and asserted
   * the outcome. It passed against the broken code as well as the fixed one —
   * the two transactions simply did not overlap in the window that matters, so
   * the test proved nothing. A test that cannot fail is worse than none.
   *
   * This one holds a winner's registration UNCOMMITTED while the loser runs.
   * The loser sees no committed registration, mints its own, and its INSERT
   * then BLOCKS on the winner's uncommitted row — which is exactly the window
   * the defect lived in. When the winner commits, `ON CONFLICT DO NOTHING`
   * returns no row and the loser must adopt the winner's key.
   *
   * Under the old code the loser had already written its private half to disk
   * before blocking, and its INSERT then raised 23505.
   */
  it('adopts the winner’s key rather than clobbering it', async () => {
    const winner = generateSigningKeyPair('rec-v1');
    const custody = createCustody(app.keys.mintingCustody, {
      keyDir: app.cfg.SIGNING_KEY_DIR,
    });
    custody.write(TENANT, winner.keyVersion, winner.privateKeyPem);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    // The winner: registers, then waits, holding the row uncommitted.
    const winning = inTenantTransaction(app.db, {
      tenantId: TENANT, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    }, async (tx) => {
      await tx`
        INSERT INTO lotmark.signing_keys
          (tenant_id, key_version, algorithm, public_key_pem, fingerprint, custody,
           purpose, activated_at)
        VALUES (${TENANT}, ${winner.keyVersion}, 'ed25519', ${winner.publicKeyPem},
                ${publicKeyFingerprint(winner.publicKeyPem)}, ${app.keys.mintingCustody},
                'record', now())`;
      await held;
    });

    // The loser: starts while the winner's row is invisible and uncommitted.
    const losing = inTenant((tx) => app.keys.active(tx, TENANT));

    // Give the loser time to reach its own INSERT and block there.
    await new Promise((r) => setTimeout(r, 250));
    release();
    await winning;

    const adopted = await losing;

    expect(adopted.keyVersion).toBe(winner.keyVersion);
    expect(adopted.publicKeyPem.trim(),
      'the loser must adopt the registered key, not its own')
      .toBe(winner.publicKeyPem.trim());

    /**
     * THE assertion. The old failure was never a duplicate row — the unique
     * index always prevented that. It was the loser's private half sitting on
     * disk beneath the winner's public half, and every later signature failing.
     */
    const onDisk = keyFiles().find((f) => existsSync(f));
    expect(onDisk, 'the winner wrote a private half').toBeTruthy();
    expect(publicKeyOf(readFileSync(onDisk!, 'utf8')).trim(),
      'the loser must not have overwritten the winner’s private key')
      .toBe(winner.publicKeyPem.trim());

    const registrations = await inTenant((tx) => tx`
      SELECT key_version FROM lotmark.signing_keys
      WHERE tenant_id = ${TENANT} AND purpose = 'record'`);
    expect(registrations.length, 'one key, not two').toBe(1);
  });

  it('then keeps returning that key, without minting again', async () => {
    const count = () => inTenant(async (tx) => {
      const [r] = await tx`
        SELECT count(*)::int AS n FROM lotmark.signing_keys WHERE tenant_id = ${TENANT}`;
      return (r as { n: number }).n;
    });
    const before = await count();
    await inTenant((tx) => app.keys.active(tx, TENANT));
    expect(await count()).toBe(before);
  });
});

describe('a caller that will not mint', () => {
  it('refuses rather than creating a key as a side effect', async () => {
    /**
     * The assessment pack reads at REPEATABLE READ, where the `ON CONFLICT DO
     * NOTHING` that makes first use race-safe raises a serialization failure
     * instead of resolving. Beyond that, a tenant's first signing key should
     * not come into existence because somebody exported a report.
     */
    await inTenant((tx) => tx`
      DELETE FROM lotmark.signing_keys WHERE tenant_id = ${NO_MINT_TENANT}`);

    await expect(inTenantTransaction(app.db, {
      tenantId: NO_MINT_TENANT, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    }, (tx) => app.keys.active(tx, NO_MINT_TENANT, undefined, { mint: false })))
      .rejects.toThrow(/will not create one/);

    const rows = await inTenantTransaction(app.db, {
      tenantId: NO_MINT_TENANT, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
    }, (tx) => tx`SELECT 1 FROM lotmark.signing_keys WHERE tenant_id = ${NO_MINT_TENANT}`);
    expect(rows.length, 'and it must not have minted one anyway').toBe(0);
  });
});
