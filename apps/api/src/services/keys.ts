import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { KeyObject } from 'node:crypto';
import {
  generateSigningKeyPair, loadPrivateKey, loadPublicKey,
  publicKeyFingerprint, publicKeyOf,
} from '@lotmark/security';
import type { Sql } from '../db';

/**
 * Signing key custody.
 *
 * The private key NEVER enters the database. An attacker who compromises
 * Postgres must not thereby be able to forge signatures, or the §11.70 argument
 * collapses — every signature would be reproducible by whoever holds the data.
 *
 * On localhost the key lives in a mode-0600 file under `.keys/`, which is
 * gitignored. That is `dev_file` custody and it is reported as such wherever a
 * signature is displayed, so nobody mistakes a laptop for a hardware module.
 * The `custody` column exists precisely so that upgrading to KMS or an HSM is a
 * recorded fact about each key rather than a claim in a document.
 */
export type Custody = 'dev_file' | 'env' | 'kms' | 'hsm';

/**
 * What a key is FOR.
 *
 * `record` signs studies, values, lots and certificates — the API holds it.
 * `anchor` signs statements about the ledger, and the API must never hold it:
 * a component that can rewrite the ledger and also sign attestations about it
 * proves nothing.
 *
 * This distinction is load-bearing. `active()` below previously had no purpose
 * filter and no ORDER BY, working only because a unique index guaranteed one
 * un-retired key per tenant. Registering an anchor key would have made it
 * return that key at random and then fail to find a private half the API
 * deliberately does not hold — breaking every signing act nondeterministically.
 */
export type KeyPurpose = 'record' | 'anchor';

export const RECORD_KEY_VERSION = 'rec-v1';

export interface ActiveKey {
  readonly keyVersion: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  readonly fingerprint: string;
  readonly custody: Custody;
}

export class KeyProvider {
  private cache = new Map<string, ActiveKey>();

  constructor(private readonly keyDir: string) {}

  /**
   * Load the tenant's current key, generating one on first use in development.
   *
   * Generation is deliberately NOT silent: it logs, and the public half is
   * registered in the database as an auditable act. A signing key appearing
   * from nowhere is exactly the event an investigator needs to be able to see.
   */
  async active(sql: Sql, tenantId: string, log?: (msg: string) => void): Promise<ActiveKey> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;

    const [row] = await sql`
      SELECT key_version, public_key_pem, fingerprint, custody
      FROM lotmark.signing_keys
      WHERE tenant_id = ${tenantId} AND retired_at IS NULL
        -- Explicit, not implied by an index. See KeyPurpose above.
        AND purpose = 'record'
      LIMIT 1`;
    const registered = row as
      | { key_version: string; public_key_pem: string; fingerprint: string; custody: Custody }
      | undefined;

    if (registered) {
      const pem = this.readPrivate(tenantId, registered.key_version);
      if (!pem) {
        // The database says a key is active but the private half is missing.
        // Failing loudly beats quietly minting a new one: signatures made under
        // the registered key would silently stop being reproducible.
        throw new Error(
          `Signing key ${registered.key_version} is registered for tenant ${tenantId} ` +
          `but its private half is not present in ${this.keyDir}. ` +
          `Restore it, or retire the key with a stated reason before issuing a new one.`,
        );
      }
      if (publicKeyOf(pem).trim() !== registered.public_key_pem.trim()) {
        throw new Error(
          `The private key on disk does not match the public key registered for ` +
          `${registered.key_version}. Refusing to sign with a mismatched pair.`,
        );
      }
      const key: ActiveKey = {
        keyVersion: registered.key_version,
        privateKey: loadPrivateKey(pem),
        publicKeyPem: registered.public_key_pem,
        fingerprint: registered.fingerprint,
        custody: registered.custody,
      };
      this.cache.set(tenantId, key);
      return key;
    }

    // First use: mint and register. The version is purpose-prefixed so a record
    // key and an anchor key can never collide on key_version, which remains
    // unique per tenant.
    const kp = generateSigningKeyPair(RECORD_KEY_VERSION);
    this.writePrivate(tenantId, kp.keyVersion, kp.privateKeyPem);
    const fingerprint = publicKeyFingerprint(kp.publicKeyPem);

    await sql`
      INSERT INTO lotmark.signing_keys
        (tenant_id, key_version, algorithm, public_key_pem, fingerprint, custody,
         purpose, activated_at)
      VALUES (${tenantId}, ${kp.keyVersion}, 'ed25519', ${kp.publicKeyPem},
              ${fingerprint}, 'dev_file', 'record', now())`;

    log?.(`minted signing key ${kp.keyVersion} for tenant ${tenantId} (fingerprint ${fingerprint}, custody dev_file)`);

    const key: ActiveKey = {
      keyVersion: kp.keyVersion,
      privateKey: loadPrivateKey(kp.privateKeyPem),
      publicKeyPem: kp.publicKeyPem,
      fingerprint,
      custody: 'dev_file',
    };
    this.cache.set(tenantId, key);
    return key;
  }

  /** Public key for verification, including retired ones. */
  async publicKeyFor(sql: Sql, tenantId: string, keyVersion: string): Promise<KeyObject | null> {
    const [row] = await sql`
      SELECT public_key_pem FROM lotmark.signing_keys
      WHERE tenant_id = ${tenantId} AND key_version = ${keyVersion} LIMIT 1`;
    const found = row as { public_key_pem: string } | undefined;
    // Retired keys still verify. Retirement stops a key signing NEW records; it
    // does not invalidate everything it ever signed.
    return found ? loadPublicKey(found.public_key_pem) : null;
  }

  private keyPath(tenantId: string, version: string): string {
    return path.join(this.keyDir, `${tenantId}.${version}.pem`);
  }

  private readPrivate(tenantId: string, version: string): string | null {
    const p = this.keyPath(tenantId, version);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  private writePrivate(tenantId: string, version: string, pem: string): void {
    mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const p = this.keyPath(tenantId, version);
    writeFileSync(p, pem, { mode: 0o600 });
    chmodSync(p, 0o600);
  }
}
