import { index, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { lotmark, timestamps } from './_shared';
import { tenantsTable } from './tenancy';

/**
 * Public signing keys.
 *
 * ONLY the public half is stored. The private key lives outside the database
 * entirely — if an attacker who compromised the database also obtained the
 * signing key, every signature it protects would be forgeable and the whole
 * §11.70 argument would collapse.
 *
 * Keys are versioned rather than replaced. A signature made under `v1` must
 * stay verifiable after rotation to `v2`, so the old public key is retired but
 * never deleted; `retiredAt` records when it stopped being used for new
 * signatures, not when it stopped being trusted for old ones.
 */
export const signingKeysTable = lotmark.table('signing_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),

  /** Stable short identifier stored on every signature, e.g. 'v1'. */
  keyVersion: text('key_version').notNull(),
  algorithm: text('algorithm').notNull().default('ed25519'),
  publicKeyPem: text('public_key_pem').notNull(),
  /** SHA-256 of the SPKI DER, truncated — for display and rotation records. */
  fingerprint: text('fingerprint').notNull(),

  /**
   * How the private key is held. Reported everywhere a signature is shown, so
   * nobody mistakes a development key file for an HSM.
   */
  custody: text('custody', { enum: ['dev_file', 'env', 'kms', 'hsm'] })
    .notNull().default('dev_file'),

  activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'string' }).notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
  retiredReason: text('retired_reason'),

  ...timestamps,
}, (t) => ({
  versionUnique: uniqueIndex('signing_keys_tenant_version_unique').on(t.tenantId, t.keyVersion),
  activeIdx: index('signing_keys_active_idx').on(t.tenantId, t.retiredAt),
}));
