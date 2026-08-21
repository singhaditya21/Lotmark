import { bigint, bigserial, index, jsonb, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { lotmark } from './_shared';
import { tenantsTable } from './tenancy';
import { usersTable } from './people';

/**
 * The audit ledger — tamper-EVIDENT, append-only, hash-chained.
 *
 * Each entry commits to the entry before it, so altering any historical row
 * breaks every hash after it. This does not PREVENT tampering by someone with
 * database write access; it makes tampering detectable, which is what
 * 21 CFR 11 §11.10(e) and ISO 17034 §8.4 actually require.
 *
 * Three things the prototype could not do, added here:
 *
 *  1. The chain link is HMAC-SHA256 under a server-held key, not a plain hash.
 *     With a plain hash anyone who can edit a row can also recompute every
 *     subsequent link and leave no trace. With a keyed MAC they cannot, unless
 *     they also hold the key — which lives outside the database.
 *
 *  2. `seq` is a gap-free sequence per tenant. A DELETE is then visible as a
 *     hole even if the chain were somehow recomputed.
 *
 *  3. Entries are periodically NOTARISED: a head hash is written to a separate
 *     append-only store (see auditCheckpointsTable), so a wholesale replacement
 *     of the entire ledger is still detectable.
 *
 * INSERT-only. UPDATE and DELETE are revoked at the role level and blocked by
 * trigger; see migrations.
 */
export const auditLedgerTable = lotmark.table('audit_ledger', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),

  /**
   * Gap-free per-tenant ordinal, assigned by the chain trigger while holding
   * the head lock. Deliberately NOT a bigserial: a sequence is per-table, and
   * it leaves gaps on rollback — which would make a deleted row
   * indistinguishable from an aborted transaction, destroying the one property
   * the sequence exists to provide.
   */
  seq: bigint('seq', { mode: 'bigint' }).notNull(),

  /** Who acted. 'system' for scheduled jobs; never null, never anonymous-by-accident. */
  actorUserId: uuid('actor_user_id').references(() => usersTable.id),
  actorLabel: text('actor_label').notNull(),
  actorRoleId: text('actor_role_id').notNull(),
  sessionId: uuid('session_id'),

  /** Coarse classification: AUTH, DENY, WORKFLOW, SIGNATURE, CERTIFICATE, PII, SECURITY... */
  kind: text('kind').notNull(),
  /** What happened, in the words an assessor will read. */
  action: text('action').notNull(),
  /** Free-text detail carried from the prototype's `meta`. */
  detail: text('detail').notNull().default(''),

  /** The record acted upon, when there is one. */
  subjectTable: text('subject_table'),
  subjectId: text('subject_id'),

  /** Structured before/after for mutations, for reconstruction during an audit. */
  changes: jsonb('changes').$type<Record<string, unknown>>(),

  /**
   * Trusted time. `occurredAt` is the server's clock; `timeSource` and `region`
   * record WHERE that clock came from, because a signature timestamp is only as
   * good as its source. Carried from the prototype's TIME_SOURCES.
   */
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
    .notNull().default(sql`now()`),
  timeSource: text('time_source').notNull(),
  region: text('region').notNull(),

  /** HMAC of (prevHash || this entry's canonical fields). */
  entryHash: text('entry_hash').notNull(),
  prevHash: text('prev_hash').notNull(),
  /** Key generation, so the HMAC key can be rotated without invalidating history. */
  keyVersion: text('key_version').notNull().default('v1'),
}, (t) => ({
  tenantSeqUnique: uniqueIndex('audit_tenant_seq_unique').on(t.tenantId, t.seq),
  tenantTimeIdx: index('audit_tenant_time_idx').on(t.tenantId, t.occurredAt),
  subjectIdx: index('audit_subject_idx').on(t.subjectTable, t.subjectId),
  actorIdx: index('audit_actor_idx').on(t.actorUserId),
  kindIdx: index('audit_kind_idx').on(t.tenantId, t.kind),
}));

/**
 * Periodic notarisation of the ledger head.
 *
 * Without this, an attacker who can rewrite the whole table can also rebuild a
 * self-consistent chain from entry 1. A checkpoint pins the head at a moment in
 * time; exporting checkpoints off-box (or to WORM storage) is what makes the
 * wholesale rewrite detectable. Written by a scheduled job.
 */
export const auditCheckpointsTable = lotmark.table('audit_checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  /** The ledger seq this checkpoint covers up to, inclusive. */
  throughSeq: bigint('through_seq', { mode: 'bigint' }).notNull(),
  headHash: text('head_hash').notNull(),
  entryCount: bigint('entry_count', { mode: 'bigint' }).notNull(),
  takenAt: timestamp('taken_at', { withTimezone: true, mode: 'string' })
    .notNull().default(sql`now()`),
  /** Set once this checkpoint has been copied somewhere the database cannot reach. */
  exportedAt: timestamp('exported_at', { withTimezone: true, mode: 'string' }),
  exportTarget: text('export_target'),
}, (t) => ({
  tenantTimeIdx: index('audit_checkpoints_tenant_time_idx').on(t.tenantId, t.takenAt),
}));

/**
 * Electronic signatures — 21 CFR Part 11 §11.50 and §11.70.
 *
 * One row per signing act, referencing its subject polymorphically. Append-only:
 * a signature is never edited. Withdrawing a signed record is a new act with its
 * own entry, never a mutation of this row.
 */
export const signaturesTable = lotmark.table('signatures', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),

  /** 'study' | 'value' | 'certificate' | 'lot' */
  subjectKind: text('subject_kind').notNull(),
  subjectId: uuid('subject_id').notNull(),

  signerUserId: uuid('signer_user_id').notNull().references(() => usersTable.id, { onDelete: 'restrict' }),
  /** §11.50(a)(3) — chosen by the signer, never inferred. */
  meaning: text('meaning').notNull(),

  signedAt: timestamp('signed_at', { withTimezone: true, mode: 'string' })
    .notNull().default(sql`now()`),
  timeSource: text('time_source').notNull(),
  region: text('region').notNull(),

  /**
   * §11.70 binding.
   *
   * `signatureValue` is an Ed25519 signature over the canonical payload from
   * @lotmark/domain — the record's material, the signer, the meaning and the
   * instant. Asymmetric on purpose: an assessor or a certificate holder can
   * verify with the public key alone, holding nothing that could produce a
   * signature. Every HMAC verifier is also a forger; this is the property that
   * makes the signature evidence rather than a checksum.
   *
   * `bindingHash` is a SHA-256 digest of the same payload. Not the security
   * mechanism — it exists so an operator can see WHICH payload a signature
   * covers without reconstructing it.
   *
   * `canonicalVersion` lets the material format evolve without making every
   * historical signature appear tampered with.
   */
  bindingHash: text('binding_hash').notNull(),
  signatureValue: text('signature_value'),
  algorithm: text('algorithm').notNull().default('ed25519'),
  canonicalVersion: text('canonical_version').notNull().default('1'),
  keyVersion: text('key_version').notNull().default('v1'),

  /**
   * The competence authorisation this signing relied on, COPIED not joined.
   * ISO 17034 6.3 asks whether the signer was authorised on the day; editing
   * the competence record later must not rewrite the past.
   */
  competenceRecordId: uuid('competence_record_id'),
  competenceActivity: text('competence_activity'),
  /**
   * Deliberately `text`, not `date`, unlike every other date in the schema.
   *
   * These are a FROZEN COPY of what the competence record said at the instant
   * of signing — evidence, not a queryable date. Storing them as `date` invites
   * a driver, a migration or a timezone setting to reinterpret them later, and
   * the one thing this snapshot must never do is change its meaning.
   */
  competenceValidFrom: text('competence_valid_from'),
  competenceValidTo: text('competence_valid_to'),
  competenceCheckedOn: text('competence_checked_on'),

  /** The ledger entry recording this signing. */
  auditSeq: bigint('audit_seq', { mode: 'bigint' }),
}, (t) => ({
  subjectIdx: index('signatures_subject_idx').on(t.subjectKind, t.subjectId),
  signerIdx: index('signatures_signer_idx').on(t.signerUserId),
}));
