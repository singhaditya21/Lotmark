import {
  boolean, doublePrecision, index, integer, jsonb, text, timestamp, uuid, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { lotmark, timestamps, version, isoDate } from './_shared';
import { tenantsTable } from './tenancy';
import { usersTable } from './people';

export const projectsTable = lotmark.table('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),

  materialName: text('material_name').notNull(),
  casNumber: text('cas_number'),
  sku: text('sku').notNull(),

  /** design | study | authorisation | released — see PROJECT_MACHINE. */
  stage: text('stage').notNull().default('design'),
  ownerUserId: uuid('owner_user_id').references(() => usersTable.id),

  /** Nominal unit of sale, e.g. '50 mg'. */
  intakeQuantity: text('intake_quantity'),
  /** Target relative expanded uncertainty, e.g. '0.5%'. */
  targetUncertainty: text('target_uncertainty'),

  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('projects_tenant_code_unique').on(t.tenantId, t.code),
  stageIdx: index('projects_stage_idx').on(t.tenantId, t.stage),
}));

/** Equipment, with dated calibration intervals. */
export const equipmentTable = lotmark.table('equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  equipmentType: text('equipment_type').notNull(),
  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('equipment_tenant_code_unique').on(t.tenantId, t.code),
}));

/**
 * A calibration interval. Coverage is a CLOSED date range.
 *
 * A study performed outside every interval for its equipment is an impact
 * event: it propagates to every lot built on that study and every certificate
 * issued for those lots. See `lotsAffectedByEquipment` in the API.
 *
 * Overlapping intervals for the same equipment are rejected by an exclusion
 * constraint in the migration — two overlapping certificates of calibration
 * would make "was it calibrated on this date" ambiguous.
 */
export const calibrationsTable = lotmark.table('calibrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  equipmentId: uuid('equipment_id').notNull().references(() => equipmentTable.id, { onDelete: 'cascade' }),
  validFrom: isoDate('valid_from').notNull(),
  validTo: isoDate('valid_to').notNull(),
  certificateReference: text('certificate_reference'),
  performedBy: text('performed_by'),
  ...timestamps,
}, (t) => ({
  equipmentIdx: index('calibrations_equipment_idx').on(t.equipmentId, t.validFrom, t.validTo),
}));

export const studiesTable = lotmark.table('studies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  projectId: uuid('project_id').notNull().references(() => projectsTable.id, { onDelete: 'restrict' }),

  /** homogeneity | stability | characterisation | confirmatory retest */
  studyType: text('study_type').notNull(),
  /** draft | signed — see STUDY_MACHINE. Signed is terminal. */
  state: text('state').notNull().default('draft'),

  /**
   * The uncertainty contribution, COMPUTED from raw results by @lotmark/stats
   * and written here on signing. Never typed by a person. Held as double
   * precision to match the IEEE-754 arithmetic the golden tests pin.
   */
  uncertainty: doublePrecision('uncertainty'),

  /** Which estimator produced it, so a future change of method is visible. */
  estimatorVersion: text('estimator_version').notNull().default('guide35-v1'),

  signedByUserId: uuid('signed_by_user_id').references(() => usersTable.id),
  signedOn: isoDate('signed_on'),

  /** Stability only. */
  shelfLifeTo: isoDate('shelf_life_to'),
  storageCondition: text('storage_condition'),
  transportCondition: text('transport_condition'),

  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('studies_tenant_code_unique').on(t.tenantId, t.code),
  projectIdx: index('studies_project_idx').on(t.projectId, t.studyType, t.state),
}));

/** Which equipment a study used. Drives the calibration impact trace. */
export const studyEquipmentTable = lotmark.table('study_equipment', {
  studyId: uuid('study_id').notNull().references(() => studiesTable.id, { onDelete: 'cascade' }),
  equipmentId: uuid('equipment_id').notNull().references(() => equipmentTable.id, { onDelete: 'restrict' }),
}, (t) => ({
  pk: uniqueIndex('study_equipment_pk').on(t.studyId, t.equipmentId),
  equipmentIdx: index('study_equipment_equipment_idx').on(t.equipmentId),
}));

/**
 * Raw measurements. The uncertainty budget is derived from THESE, never from a
 * typed summary — which is the difference between a reference material producer
 * and a spreadsheet.
 *
 * One table serves all three designs; which columns are populated depends on
 * the study type, and a CHECK constraint in the migration enforces that:
 *   homogeneity    -> unitRef + replicate
 *   stability      -> elapsedMonths
 *   characterisation -> laboratoryRef
 *
 * Append-only once the study is signed.
 */
export const studyResultsTable = lotmark.table('study_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  studyId: uuid('study_id').notNull().references(() => studiesTable.id, { onDelete: 'cascade' }),

  /** Homogeneity: which unit (bottle/vial) and which replicate within it. */
  unitRef: integer('unit_ref'),
  replicate: integer('replicate'),
  /** Stability: months elapsed from the study start. */
  elapsedMonths: integer('elapsed_months'),
  /** Characterisation: which laboratory reported it. */
  laboratoryRef: text('laboratory_ref'),

  measuredValue: doublePrecision('measured_value').notNull(),
  measuredUnit: text('measured_unit'),

  recordedByUserId: uuid('recorded_by_user_id').references(() => usersTable.id),
  ...timestamps,
}, (t) => ({
  studyIdx: index('study_results_study_idx').on(t.studyId),
}));

export const propertyValuesTable = lotmark.table('property_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  projectId: uuid('project_id').notNull().references(() => projectsTable.id, { onDelete: 'restrict' }),

  propertyName: text('property_name').notNull(),
  unit: text('unit').notNull(),

  /** The assigned value: the characterisation consensus mean. Computed, not typed. */
  assignedValue: doublePrecision('assigned_value'),
  /** Combined standard uncertainty, root-sum-square of the components. */
  combinedUncertainty: doublePrecision('combined_uncertainty'),
  /** Coverage factor. Stored, not assumed — a documented choice. */
  coverageFactor: doublePrecision('coverage_factor').notNull().default(2),
  /** U = k * u_c, denormalised for certificate rendering and holder queries. */
  expandedUncertainty: doublePrecision('expanded_uncertainty'),

  /** The component breakdown an assessor asks to see, as computed. */
  components: jsonb('components').$type<Array<{
    studyId: string; studyType: string; symbol: string; value: number; basis: string;
  }>>().notNull().default([]),

  /** draft | assigned | authorised — see VALUE_MACHINE. */
  state: text('state').notNull().default('draft'),

  /** SoD-1 reads this: the assigner may not authorise. */
  assignedBy: uuid('assigned_by').references(() => usersTable.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }),
  authorisedBy: uuid('authorised_by').references(() => usersTable.id),
  authorisedAt: timestamp('authorised_at', { withTimezone: true, mode: 'string' }),

  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('property_values_tenant_code_unique').on(t.tenantId, t.code),
  projectIdx: index('property_values_project_idx').on(t.projectId, t.state),
}));

/** Production process steps — drying, milling, blending. Part of traceability. */
export const processStepsTable = lotmark.table('process_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').notNull().references(() => projectsTable.id, { onDelete: 'cascade' }),
  stepName: text('step_name').notNull(),
  equipmentId: uuid('equipment_id').references(() => equipmentTable.id),
  performedByUserId: uuid('performed_by_user_id').references(() => usersTable.id),
  performedOn: isoDate('performed_on'),
  note: text('note'),
  ...timestamps,
}, (t) => ({
  projectIdx: index('process_steps_project_idx').on(t.projectId),
}));

export const lotsTable = lotmark.table('lots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').notNull().references(() => projectsTable.id, { onDelete: 'restrict' }),

  /** Rendered from the tenant's numbering template, e.g. RMP-PARA-0421. */
  lotCode: text('lot_code').notNull(),
  /** The lot this one supersedes, forming the supersession chain. */
  previousLotId: uuid('previous_lot_id'),

  expiryDate: isoDate('expiry_date').notNull(),
  /** draft | released | superseded | withdrawn — see LOT_MACHINE. */
  state: text('state').notNull().default('draft'),

  stockUnits: integer('stock_units').notNull().default(0),
  storageCondition: text('storage_condition').notNull(),
  coldChain: boolean('cold_chain').notNull().default(false),

  /** Minor units (paise) — never floating point for money. */
  unitPriceMinor: integer('unit_price_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),
  /** Whether a government price tier may be applied to this lot. */
  tierable: boolean('tierable').notNull().default(true),

  /** SoD-4 reads this: the creator may not release. */
  createdBy: uuid('created_by').references(() => usersTable.id),
  releasedBy: uuid('released_by').references(() => usersTable.id),
  releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),

  version: version(),
  ...timestamps,
}, (t) => ({
  lotCodeUnique: uniqueIndex('lots_tenant_code_unique').on(t.tenantId, t.lotCode),
  projectIdx: index('lots_project_idx').on(t.projectId, t.state),
  stateIdx: index('lots_state_idx').on(t.tenantId, t.state),
}));
