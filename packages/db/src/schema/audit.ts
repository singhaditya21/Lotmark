import { bigserial, index, jsonb, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
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

  /** Gap-free per-tenant ordinal. Assigned by trigger inside the insert lock. */
  seq: bigserial('seq', { mode: 'bigint' }).notNull(),

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
  throughSeq: text('through_seq').notNull(),
  headHash: text('head_hash').notNull(),
  entryCount: text('entry_count').notNull(),
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
   * §11.70 binding. HMAC over the canonical material from @lotmark/domain, plus
   * signer, meaning and instant. `canonicalVersion` lets the material format
   * evolve without making historical signatures appear tampered with.
   */
  bindingHash: text('binding_hash').notNull(),
  canonicalVersion: text('canonical_version').notNull().default('1'),
  keyVersion: text('key_version').notNull().default('v1'),

  /**
   * The competence authorisation this signing relied on, COPIED not joined.
   * ISO 17034 6.3 asks whether the signer was authorised on the day; editing
   * the competence record later must not rewrite the past.
   */
  competenceRecordId: uuid('competence_record_id'),
  competenceActivity: text('competence_activity'),
  competenceValidFrom: text('competence_valid_from'),
  competenceValidTo: text('competence_valid_to'),
  competenceCheckedOn: text('competence_checked_on'),

  /** The ledger entry recording this signing. */
  auditSeq: text('audit_seq'),
}, (t) => ({
  subjectIdx: index('signatures_subject_idx').on(t.subjectKind, t.subjectId),
  signerIdx: index('signatures_signer_idx').on(t.signerUserId),
}));
