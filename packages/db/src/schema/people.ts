import { boolean, integer, text, timestamp, uuid, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { lotmark, timestamps, version, isoDate } from './_shared';
import { tenantsTable, organisationsTable } from './tenancy';

export const usersTable = lotmark.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  organisationId: uuid('organisation_id').notNull()
    .references(() => organisationsTable.id, { onDelete: 'restrict' }),

  /** Stable machine key carried over from the prototype, e.g. 'u-ravi'. */
  code: text('code').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),

  /**
   * Argon2id hash. NOT the prototype's iterated FNV, which is a fast
   * non-cryptographic hash and offers no resistance to offline cracking.
   * Parameters are stored alongside so they can be raised over time without
   * invalidating existing hashes.
   */
  passwordHash: text('password_hash').notNull(),

  /** Base32 TOTP secret, encrypted at rest. Null until the user enrols. */
  totpSecretEncrypted: text('totp_secret_encrypted'),
  mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true, mode: 'string' }),
  mfaRequired: boolean('mfa_required').notNull().default(true),

  /**
   * NOTE: there is no `role_id` column.
   *
   * A person is routinely a Scientist on one laboratory section and a reviewer
   * on another, and one column cannot say so. Authority lives in
   * `role_assignments`, scoped to a team or to the whole tenant, and dated so
   * that leave cover expires without anyone remembering to revoke it.
   */

  /** Avatar tint carried from the prototype; cosmetic only. */
  colour: text('colour'),

  /** Sign-in throttling. Cleared on a successful authentication. */
  failedSignInCount: integer('failed_sign_in_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'string' }),

  /**
   * Deactivation, never deletion. A user id is referenced by signatures and
   * ledger entries that must remain resolvable for the life of the record;
   * see retention class `competence_record` and `electronic_signature`.
   */
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true, mode: 'string' }),

  version: version(),
  ...timestamps,
}, (t) => ({
  emailUnique: uniqueIndex('users_tenant_email_unique').on(t.tenantId, t.email),
  codeUnique: uniqueIndex('users_tenant_code_unique').on(t.tenantId, t.code),
  orgIdx: index('users_organisation_idx').on(t.organisationId),
}));

/**
 * Server-side sessions.
 *
 * Cookie sessions rather than JWTs: this domain needs IMMEDIATE revocation
 * (a locked account, an idle timeout, a withdrawn competence) and a stateless
 * token cannot be withdrawn before it expires. The cookie carries only an
 * opaque id; everything of consequence is here, where it can be deleted.
 */
export const sessionsTable = lotmark.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),

  /** SHA-256 of the cookie value. The raw token is never stored. */
  tokenHash: text('token_hash').notNull(),

  /** Idle timeout is enforced against this, refreshed on each request. */
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'string' })
    .notNull().default(sql`now()`),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

  /**
   * Set once the second factor is verified. A session that has passed the
   * password but not the OTP exists but authorises nothing.
   */
  mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true, mode: 'string' }),

  /**
   * Step-up window for signing. 21 CFR 11 §11.200(a)(1)(i): the first signing
   * of a continuous session requires all components; subsequent signings within
   * the session may use one. This stamp is what makes the session "continuous".
   */
  signingUnlockedAt: timestamp('signing_unlocked_at', { withTimezone: true, mode: 'string' }),

  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  revokedReason: text('revoked_reason'),
  ...timestamps,
}, (t) => ({
  tokenUnique: uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
  userIdx: index('sessions_user_idx').on(t.userId),
  expiryIdx: index('sessions_expires_idx').on(t.expiresAt),
}));

/**
 * Competence records — ISO 17034 6.3.
 *
 * A dated authorisation for one person to perform one activity. Validity is a
 * CLOSED interval [validFrom, validTo] compared lexically as ISO dates.
 *
 * Append-only in effect: superseding is a new row, never an edit, because a
 * signature made under an earlier record must stay explicable. Enforced by
 * trigger in the migrations, and by retention class `competence_record`.
 */
export const competenceRecordsTable = lotmark.table('competence_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'restrict' }),

  /** The permission this record authorises, e.g. 'study:sign'. */
  activity: text('activity').notNull(),

  validFrom: isoDate('valid_from').notNull(),
  validTo: isoDate('valid_to').notNull(),

  /** Evidence: training record, assessment, witnessed demonstration. */
  basis: text('basis'),
  grantedByUserId: uuid('granted_by_user_id').references(() => usersTable.id),

  /** Set when a later record replaces this one. Never deleted. */
  supersededByRecordId: uuid('superseded_by_record_id'),
  supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'string' }),

  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('competence_tenant_code_unique').on(t.tenantId, t.code),
  lookupIdx: index('competence_lookup_idx').on(t.userId, t.activity, t.validFrom, t.validTo),
}));
