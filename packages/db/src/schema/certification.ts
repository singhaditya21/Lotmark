import {
  boolean, doublePrecision, index, integer, text, timestamp, uuid, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { lotmark, timestamps, version } from './_shared';
import { tenantsTable } from './tenancy';
import { usersTable } from './people';
import { lotsTable } from './production';

/**
 * A certificate belongs to exactly one lot and accumulates ISSUES.
 *
 * Reissue NEVER overwrites. Issue 2 is a new row; issue 1 remains, verifiable,
 * forever. This is what makes "who holds which issue" answerable years later,
 * and it is the retention class `certificate_issue`.
 */
export const certificatesTable = lotmark.table('certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  lotId: uuid('lot_id').notNull().references(() => lotsTable.id, { onDelete: 'restrict' }),
  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('certificates_tenant_code_unique').on(t.tenantId, t.code),
  lotUnique: uniqueIndex('certificates_lot_unique').on(t.lotId),
}));

/**
 * One issue of a certificate. APPEND-ONLY — enforced by trigger.
 *
 * `withdrawnAt` is the single permitted mutation, and even that is applied by a
 * dedicated function that writes the ledger entry in the same transaction.
 */
export const certificateIssuesTable = lotmark.table('certificate_issues', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  certificateId: uuid('certificate_id').notNull()
    .references(() => certificatesTable.id, { onDelete: 'restrict' }),

  /** 1, 2, 3... Unique per certificate. */
  issueNumber: integer('issue_number').notNull(),

  /** Frozen at issue: the certificate states these, whatever the project later says. */
  assignedValue: doublePrecision('assigned_value').notNull(),
  expandedUncertainty: doublePrecision('expanded_uncertainty').notNull(),
  coverageFactor: doublePrecision('coverage_factor').notNull().default(2),
  propertyName: text('property_name').notNull(),
  unit: text('unit').notNull(),

  issuedByUserId: uuid('issued_by_user_id').notNull().references(() => usersTable.id),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull(),

  /** Why this issue exists. Required from issue 2 onward. */
  reissueReason: text('reissue_reason'),

  withdrawn: boolean('withdrawn').notNull().default(false),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'string' }),
  withdrawnReason: text('withdrawn_reason'),
  withdrawnByUserId: uuid('withdrawn_by_user_id').references(() => usersTable.id),

  /** Rendered PDF, content-addressed. Null until the render job completes. */
  documentSha256: text('document_sha256'),
  documentPath: text('document_path'),

  ...timestamps,
}, (t) => ({
  issueUnique: uniqueIndex('certificate_issues_cert_number_unique').on(t.certificateId, t.issueNumber),
  certIdx: index('certificate_issues_cert_idx').on(t.certificateId),
}));
