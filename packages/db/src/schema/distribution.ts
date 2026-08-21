import {
  doublePrecision, index, integer, text, timestamp, uuid, uniqueIndex, jsonb,
} from 'drizzle-orm/pg-core';
import { lotmark, timestamps, version, isoDate } from './_shared';
import { tenantsTable, organisationsTable } from './tenancy';
import { usersTable } from './people';
import { lotsTable } from './production';

export const ordersTable = lotmark.table('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  organisationId: uuid('organisation_id').notNull()
    .references(() => organisationsTable.id, { onDelete: 'restrict' }),
  placedByUserId: uuid('placed_by_user_id').notNull().references(() => usersTable.id),

  /** placed | packed | dispatched | delivered | cancelled — see ORDER_MACHINE. */
  state: text('state').notNull().default('placed'),
  placedOn: isoDate('placed_on').notNull(),

  /** The team responsible for fulfilling this order. */
  ownerTeamId: uuid('owner_team_id'),

  totalMinor: integer('total_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),
  courier: text('courier'),
  trackingReference: text('tracking_reference'),

  /**
   * Optimistic concurrency matters here specifically: two dispatchers advancing
   * the same order concurrently must not both succeed. The prototype
   * demonstrated exactly this rejection.
   */
  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('orders_tenant_code_unique').on(t.tenantId, t.code),
  orgIdx: index('orders_organisation_idx').on(t.organisationId),
  stateIdx: index('orders_state_idx').on(t.tenantId, t.state),
}));

/**
 * An order line allocates specific UNITS of a specific lot.
 *
 * This table is what makes the certificate holder list computable: "who held
 * issue N of certificate C" is answered by joining allocations to the issue
 * date window. Retention class `order_and_allocation` — it cannot be erased
 * under DPDP while any certificate it supports is live.
 */
export const orderLinesTable = lotmark.table('order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  orderId: uuid('order_id').notNull().references(() => ordersTable.id, { onDelete: 'cascade' }),
  lotId: uuid('lot_id').notNull().references(() => lotsTable.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  unitPriceMinor: integer('unit_price_minor').notNull(),
  ...timestamps,
}, (t) => ({
  orderIdx: index('order_lines_order_idx').on(t.orderId),
  lotIdx: index('order_lines_lot_idx').on(t.lotId),
}));

/**
 * A claim to a government price tier, with supporting documentation.
 * SoD-2 reads `raisedBy`: you cannot decide a claim you raised.
 */
export const entitlementsTable = lotmark.table('entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  organisationId: uuid('organisation_id').notNull()
    .references(() => organisationsTable.id, { onDelete: 'restrict' }),

  raisedBy: uuid('raised_by').notNull().references(() => usersTable.id),
  raisedOn: isoDate('raised_on').notNull(),
  supportingDocument: text('supporting_document').notNull(),

  /** under_review | approved | rejected | lapsed — see ENTITLEMENT_MACHINE. */
  state: text('state').notNull().default('under_review'),
  decidedBy: uuid('decided_by').references(() => usersTable.id),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  decisionNote: text('decision_note'),

  /** An approved tier is not permanent; a job lapses it on this date. */
  revalidationDue: isoDate('revalidation_due'),

  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('entitlements_tenant_code_unique').on(t.tenantId, t.code),
  orgIdx: index('entitlements_organisation_idx').on(t.organisationId, t.state),
}));

/** A physical shipment, carrying cold-chain evidence. */
export const shipmentsTable = lotmark.table('shipments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  orderId: uuid('order_id').notNull().references(() => ordersTable.id, { onDelete: 'restrict' }),
  /** The storage class the shipment must hold, e.g. '2-8'. */
  temperatureClass: text('temperature_class').notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'string' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('shipments_tenant_code_unique').on(t.tenantId, t.code),
  orderIdx: index('shipments_order_idx').on(t.orderId),
}));

/**
 * Temperature logger readings.
 *
 * An excursion beyond the class limits raises a CAPA automatically and puts the
 * delivered units under assessment — which is why these are stored as data
 * rather than as an attached PDF.
 */
export const loggerReadingsTable = lotmark.table('logger_readings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  shipmentId: uuid('shipment_id').notNull().references(() => shipmentsTable.id, { onDelete: 'cascade' }),
  readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }).notNull(),
  celsius: doublePrecision('celsius').notNull(),
}, (t) => ({
  shipmentIdx: index('logger_readings_shipment_idx').on(t.shipmentId, t.readAt),
}));

/**
 * The customer's own holdings — the laboratory vault.
 * A customer sees only their organisation's rows; RLS enforces it.
 */
export const vaultHoldingsTable = lotmark.table('vault_holdings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  organisationId: uuid('organisation_id').notNull()
    .references(() => organisationsTable.id, { onDelete: 'cascade' }),
  lotId: uuid('lot_id').notNull().references(() => lotsTable.id, { onDelete: 'restrict' }),
  storageLocation: text('storage_location'),
  quantity: integer('quantity').notNull().default(0),
  /**
   * How this holding was acquired.
   *
   * Not every vial arrives through an order — samples, replacements and
   * proficiency-testing distributions do not. A withdrawal notice derived only
   * from order lines would miss every one of them, which is why the holder
   * query is order_lines UNION vault_holdings.
   */
  source: text('source', { enum: ['order', 'qr_scan', 'upload', 'import', 'sample'] })
    .notNull().default('order'),
  acquiredOn: isoDate('acquired_on'),
  ...timestamps,
}, (t) => ({
  orgIdx: index('vault_holdings_organisation_idx').on(t.organisationId),
}));

/** Outbound notices: reissue alerts, expiry warnings, order state changes. */
export const notificationsTable = lotmark.table('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  recipientUserId: uuid('recipient_user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  /** What it concerns, so the UI can deep-link. */
  subjectTable: text('subject_table'),
  subjectId: text('subject_id'),
  /**
   * Acknowledgement key, precise per ISSUE.
   *
   * The prototype keyed reissue acknowledgements on (order, certificate), so
   * acknowledging issue 2 silently marked issue 3 acknowledged too — the
   * holder appeared to have seen a document they had never been shown.
   */
  certificateId: uuid('certificate_id'),
  issueNumber: integer('issue_number'),
  organisationId: uuid('organisation_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
  /** Acknowledgement is required for reissue notices; nulls are chased by a job. */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'string' }),
  ...timestamps,
}, (t) => ({
  recipientIdx: index('notifications_recipient_idx').on(t.recipientUserId, t.readAt),
}));
