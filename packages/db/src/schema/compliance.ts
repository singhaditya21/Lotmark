import { index, jsonb, text, timestamp, uuid, uniqueIndex, integer } from 'drizzle-orm/pg-core';
import { lotmark, timestamps, version, isoDate } from './_shared';
import { tenantsTable } from './tenancy';
import { usersTable } from './people';
import { lotsTable, studiesTable } from './production';

/** A storage facility with a declared condition band. */
export const facilitiesTable = lotmark.table('facilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** e.g. '2–8 °C', '15–25 °C', '−20 °C'. */
  condition: text('condition').notNull(),
  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('facilities_tenant_code_unique').on(t.tenantId, t.code),
}));

/** Which lots are stored where — drives `lotsExposedTo(facility)`. */
export const facilityLotsTable = lotmark.table('facility_lots', {
  facilityId: uuid('facility_id').notNull().references(() => facilitiesTable.id, { onDelete: 'cascade' }),
  lotId: uuid('lot_id').notNull().references(() => lotsTable.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: uniqueIndex('facility_lots_pk').on(t.facilityId, t.lotId),
  lotIdx: index('facility_lots_lot_idx').on(t.lotId),
}));

/**
 * A departure from the declared condition band.
 *
 * Every lot in the facility during the window is exposed, and its disposition
 * must be decided. Left open, this blocks release and dispatch.
 */
export const facilityExcursionsTable = lotmark.table('facility_excursions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  facilityId: uuid('facility_id').notNull().references(() => facilitiesTable.id, { onDelete: 'cascade' }),
  fromDate: isoDate('from_date').notNull(),
  toDate: isoDate('to_date').notNull(),
  peakReading: text('peak_reading'),
  durationText: text('duration_text'),
  /** under assessment | accepted | rejected */
  disposition: text('disposition').notNull().default('under assessment'),
  dispositionByUserId: uuid('disposition_by_user_id').references(() => usersTable.id),
  dispositionAt: timestamp('disposition_at', { withTimezone: true, mode: 'string' }),
  ...timestamps,
}, (t) => ({
  facilityIdx: index('facility_excursions_facility_idx').on(t.facilityId, t.fromDate),
}));

/**
 * Subcontractors — ISO 17034 7.4.
 *
 * Certain activities may NEVER be subcontracted; the forbidden list lives in
 * @lotmark/domain and is enforced at the service boundary, because it is a
 * conformance rule rather than tenant preference.
 */
export const subcontractorsTable = lotmark.table('subcontractors', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** The activity subcontracted, e.g. 'Characterisation testing'. */
  activity: text('activity').notNull(),
  /** Their accreditation, e.g. 'ISO/IEC 17025 · TC-9981'. */
  accreditation: text('accreditation').notNull(),
  accreditationValidTo: isoDate('accreditation_valid_to').notNull(),
  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('subcontractors_tenant_code_unique').on(t.tenantId, t.code),
}));

/**
 * Complaints, nonconformities and corrective/preventive action.
 * The prototype had a register with computed impact but no workflow; the state
 * machine (CAPA_MACHINE) supplies the workflow.
 */
export const capaTable = lotmark.table('capa', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),

  /** What raised it, e.g. 'Temperature excursion', 'Customer complaint'. */
  source: text('source').notNull(),
  /** What it concerns, polymorphic: an order, a lot, a shipment. */
  subjectTable: text('subject_table'),
  subjectId: text('subject_id'),

  severity: text('severity', { enum: ['Minor', 'Major', 'Critical'] }).notNull(),
  /** open | investigation | root_cause | capa | effectiveness | closed */
  state: text('state').notNull().default('open'),

  ownerUserId: uuid('owner_user_id').references(() => usersTable.id),
  raisedOn: isoDate('raised_on').notNull(),
  dueOn: isoDate('due_on'),

  rootCause: text('root_cause'),
  correctiveAction: text('corrective_action'),
  preventiveAction: text('preventive_action'),
  effectivenessCheck: text('effectiveness_check'),
  closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),

  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('capa_tenant_code_unique').on(t.tenantId, t.code),
  stateIdx: index('capa_state_idx').on(t.tenantId, t.state),
}));

/**
 * Ongoing stability monitoring — ISO 17034 7.8.
 *
 * A released material must keep being checked. Each point records the
 * measurement and schedules the next; a scheduled job raises a CAPA when one
 * falls overdue, which is the part the prototype could not do without a server.
 */
export const monitoringPointsTable = lotmark.table('monitoring_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  studyId: uuid('study_id').notNull().references(() => studiesTable.id, { onDelete: 'restrict' }),
  checkedOn: isoDate('checked_on').notNull(),
  measuredValue: text('measured_value'),
  withinExpectation: text('within_expectation'),
  nextDueOn: isoDate('next_due_on').notNull(),
  recordedByUserId: uuid('recorded_by_user_id').references(() => usersTable.id),
  ...timestamps,
}, (t) => ({
  studyIdx: index('monitoring_points_study_idx').on(t.studyId, t.checkedOn),
  dueIdx: index('monitoring_points_due_idx').on(t.tenantId, t.nextDueOn),
}));

/**
 * A legal hold suspends retention deletion for specific records.
 * Without this, a scheduled retention sweep can destroy evidence needed for an
 * open investigation or dispute.
 */
export const legalHoldsTable = lotmark.table('legal_holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  /** Retention class ids frozen by this hold. */
  retentionClasses: jsonb('retention_classes').$type<string[]>().notNull().default([]),
  subjectTable: text('subject_table'),
  subjectId: text('subject_id'),
  placedByUserId: uuid('placed_by_user_id').notNull().references(() => usersTable.id),
  placedAt: timestamp('placed_at', { withTimezone: true, mode: 'string' }).notNull(),
  releasedByUserId: uuid('released_by_user_id').references(() => usersTable.id),
  releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
  ...timestamps,
}, (t) => ({
  activeIdx: index('legal_holds_active_idx').on(t.tenantId, t.releasedAt),
}));

/** Background job runs, so a missed expiry notice is diagnosable. */
export const jobRunsTable = lotmark.table('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenantsTable.id, { onDelete: 'cascade' }),
  jobName: text('job_name').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  outcome: text('outcome', { enum: ['success', 'failure', 'partial'] }),
  itemsProcessed: integer('items_processed').notNull().default(0),
  errorText: text('error_text'),
}, (t) => ({
  nameIdx: index('job_runs_name_idx').on(t.jobName, t.startedAt),
}));
