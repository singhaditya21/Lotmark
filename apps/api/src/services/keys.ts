import type { KeyObject } from 'node:crypto';
import {
  generateSigningKeyPair, loadPrivateKey, loadPublicKey,
  publicKeyFingerprint, publicKeyOf,
} from '@lotmark/security';
import type { Sql } from '../db';
import type { KeyCustody, CustodyClass } from './custody';

/**
 * Signing key custody.
 *
 * The private key NEVER enters the database. An attacker who compromises
 * Postgres must not thereby be able to forge signatures, or the §11.70 argument
 * collapses — every signature would be reproducible by whoever holds the data.
 *
 * WHERE it lives is decided by a KeyCustody provider — see ./custody.ts — and
 * the class is reported wherever a signature is displayed, so nobody mistakes a
 * laptop for a hardware module. The `custody` column exists precisely so that
 * moving to a KMS or an HSM is a recorded fact about each key rather than a
 * claim in a document, and migration 0018 makes each move an auditable event.
 */
export type Custody = CustodyClass;

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

  /**
   * ── Where a key lives is a fact about the KEY, not about this process ──────
   *
   * `signing_keys.custody` records where each key is actually held, and it is
   * the value printed on every certificate that key signs. So the provider
   * reads a registered key through the class the DATABASE names, and
   * `mintUnder` decides only what class a brand-new key is created in.
   *
   * The first version of this required the configured class to match the
   * registered one and refused otherwise. That check is gone because it is no
   * longer needed: reading through the registered class makes it impossible to
   * print one custody class while having read the key from another. An
   * invariant that holds by construction beats one enforced by comparison —
   * and the comparison version meant moving a key to the Keychain broke every
   * process that had not also had its configuration changed, including the
   * test suite.
   */
  constructor(
    private readonly custodyFor: (kind: CustodyClass) => KeyCustody,
    private readonly mintUnder: CustodyClass,
  ) {}

  /** The class NEW keys are minted under. */
  get mintingCustody(): CustodyClass {
    return this.mintUnder;
  }

  /**
   * Load the tenant's current key, generating one on first use in development.
   *
   * Generation is deliberately NOT silent: it logs, and the public half is
   * registered in the database as an auditable act. A signing key appearing
   * from nowhere is exactly the event an investigator needs to be able to see.
   */
  async active(
    sql: Sql, tenantId: string, log?: (msg: string) => void,
    opts: { readonly mint?: boolean } = {},
  ): Promise<ActiveKey> {
    const { mint = true } = opts;
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
      // Read through the class the DATABASE names for this key, not the one
      // this process would mint under. See the constructor.
      const custody = this.custodyFor(registered.custody);
      const pem = custody.read(tenantId, registered.key_version);
      if (!pem) {
        // The database says a key is active but the private half is missing.
        // Failing loudly beats quietly minting a new one: signatures made under
        // the registered key would silently stop being reproducible.
        throw new Error(
          `Signing key ${registered.key_version} is registered for tenant ${tenantId} ` +
          `but its private half is not present in ${custody.describe}. ` +
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

    if (mint === false) {
      /**
       * The caller has asked NOT to mint, and means it.
       *
       * Used where minting would be both surprising and unsafe — building an
       * assessment pack, which reads at REPEATABLE READ. Creating a tenant's
       * first signing key should not be a side effect of exporting a report,
       * and under REPEATABLE READ the conflict handling below raises a
       * serialization failure instead of resolving.
       */
      throw new Error(
        `No signing key is registered for tenant ${tenantId}, and this operation ` +
        'will not create one. Issue or reissue a certificate first, or mint a key ' +
        'deliberately.',
      );
    }

    // First use: mint and register. The version is purpose-prefixed so a record
    // key and an anchor key can never collide on key_version, which remains
    // unique per tenant.
    const kp = generateSigningKeyPair(RECORD_KEY_VERSION);
    const minting = this.custodyFor(this.mintUnder);
    const fingerprint = publicKeyFingerprint(kp.publicKeyPem);

    /**
     * REGISTER FIRST, then write the private half. The order is the whole fix.
     *
     * It was the other way round, with a bare INSERT and no `ON CONFLICT`, and
     * `DevFileCustody.write` is an unconditional overwrite. Two processes
     * reaching first-use together therefore BOTH wrote the file, one INSERT
     * raised 23505 and aborted its transaction, and the tenant was left with
     * one racer's public key registered against the other's private key on
     * disk — a permanent 500 at the mismatch check above, needing manual
     * intervention. It happened twice here in one day, because the test suite
     * runs files in parallel forks against one key directory.
     *
     * `DO NOTHING` rather than a savepoint: a conflict is no longer an error to
     * contain, so there is nothing for a savepoint to protect. And a concurrent
     * uncommitted insert makes this statement WAIT rather than skip, so by the
     * time no row comes back the winner has committed — and had written its
     * private half before committing, which is why that write moved above the
     * commit and below the insert.
     */
    const [claimed] = await sql`
      INSERT INTO lotmark.signing_keys
        (tenant_id, key_version, algorithm, public_key_pem, fingerprint, custody,
         purpose, activated_at)
      VALUES (${tenantId}, ${kp.keyVersion}, 'ed25519', ${kp.publicKeyPem},
              ${fingerprint}, ${this.mintUnder}, 'record', now())
      ON CONFLICT DO NOTHING
      RETURNING key_version`;

    if (!claimed) {
      /**
       * Somebody else registered first. Use THEIR key, never ours — the private
       * half we generated has no registration and never will, and writing it to
       * disk would clobber the key that does.
       */
      log?.(`another process registered a signing key for tenant ${tenantId} first; using it`);
      this.cache.delete(tenantId);
      return this.active(sql, tenantId, log, { mint: false });
    }

    minting.write(tenantId, kp.keyVersion, kp.privateKeyPem);

    log?.(
      `minted signing key ${kp.keyVersion} for tenant ${tenantId} ` +
      `(fingerprint ${fingerprint}, custody ${this.mintUnder}: ${minting.describe})`,
    );

    /**
     * A freshly minted key is NOT cached.
     *
     * The INSERT above is inside the CALLER'S transaction, which may roll back —
     * and a refused signing does exactly that. Caching here meant the key
     * survived in memory while its registration vanished, so the next request
     * signed with a key the database had no record of. `publicKeyFor` then
     * returns null for it, which makes the signature unverifiable by anyone,
     * including the assessor it exists for.
     *
     * It surfaced as certificate issues carrying `document_key_version` that
     * joined to nothing in `signing_keys`.
     *
     * Not caching costs one extra read on the next request. If the transaction
     * committed, that read finds the registered key and caches it then; if it
     * rolled back, a new key is minted, which is correct because the previous
     * one never existed.
     */
    return {
      keyVersion: kp.keyVersion,
      privateKey: loadPrivateKey(kp.privateKeyPem),
      publicKeyPem: kp.publicKeyPem,
      fingerprint,
      custody: this.mintUnder,
    };
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

}
