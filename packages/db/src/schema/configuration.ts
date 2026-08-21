import {
  boolean, index, integer, jsonb, text, timestamp, uuid, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { lotmark, timestamps, isoDate } from './_shared';
import { tenantsTable } from './tenancy';
import { usersTable } from './people';

/**
 * A configuration version — immutable once published.
 *
 * There is deliberately no update path for a published version. Editing means
 * creating a new draft based on it, which is what makes "under what rules was
 * this certificate issued" answerable years later.
 */
export const configVersionsTable = lotmark.table('config_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  versionNumber: integer('version_number').notNull(),
  /** draft | active | superseded. Exactly one active row per tenant. */
  status: text('status').notNull().default('draft'),

  /** Required. A configuration change with no stated reason cannot be reviewed. */
  changeReason: text('change_reason').notNull(),
  basedOnVersionId: uuid('based_on_version_id'),

  createdBy: uuid('created_by').notNull().references(() => usersTable.id),
  publishedBy: uuid('published_by').references(() => usersTable.id),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),

  /**
   * Set when the version contained a security or behaviour change. Presentation
   * changes are audited but unsigned — demanding a signature to move a field on
   * a form trains people to sign without reading, which is worse than not asking.
   */
  signatureId: uuid('signature_id'),

  /** Machine-readable diff against the base version; drives re-validation scope. */
  changeSummary: jsonb('change_summary').$type<Array<{
    kind: string; key: string; change: string; risk: string;
  }>>().notNull().default([]),

  ...timestamps,
}, (t) => ({
  versionUnique: uniqueIndex('config_versions_tenant_number_unique').on(t.tenantId, t.versionNumber),
  statusIdx: index('config_versions_status_idx').on(t.tenantId, t.status),
}));

/**
 * One configuration artefact within a version.
 *
 * `payload` is validated against the Zod schema registered for its `kind` in
 * @lotmark/domain. Adding a new configurable thing is a schema registration,
 * not a migration — which is the property that makes this a platform rather
 * than an application with a settings screen.
 */
export const configEntriesTable = lotmark.table('config_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  versionId: uuid('version_id').notNull()
    .references(() => configVersionsTable.id, { onDelete: 'cascade' }),

  /** role | workflow | field | picklist | layout | view | dashboard | report | ... */
  kind: text('kind').notNull(),
  /** Stable identifier within its kind. */
  key: text('key').notNull(),
  payload: jsonb('payload').notNull(),
  /** True when this entry overrides a product default rather than adding to it. */
  overridesDefault: boolean('overrides_default').notNull().default(false),

  ...timestamps,
}, (t) => ({
  entryUnique: uniqueIndex('config_entries_version_kind_key_unique').on(t.versionId, t.kind, t.key),
  kindIdx: index('config_entries_kind_idx').on(t.tenantId, t.kind),
}));

/**
 * A team — an organisational unit that OWNS records.
 *
 * Teams are the data scope. A study belongs to a team, and a user sees it only
 * if they hold the relevant permission in that team or tenant-wide. This is
 * operational data rather than configuration: reorganising a laboratory is not
 * a change to what the software does, so it does not need a config version.
 */
export const teamsTable = lotmark.table('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Retained for reporting; a disbanded team's records keep their owner. */
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  ...timestamps,
}, (t) => ({
  keyUnique: uniqueIndex('teams_tenant_key_unique').on(t.tenantId, t.key),
}));

/** Membership. Separate from role assignment: belonging is not authority. */
export const teamMembershipsTable = lotmark.table('team_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  teamId: uuid('team_id').notNull().references(() => teamsTable.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  joinedOn: isoDate('joined_on').notNull(),
  leftOn: isoDate('left_on'),
  ...timestamps,
}, (t) => ({
  membershipIdx: index('team_memberships_lookup_idx').on(t.userId, t.teamId),
  teamIdx: index('team_memberships_team_idx').on(t.teamId),
}));

/**
 * A role held by a user, at a scope.
 *
 * `teamId IS NULL` means tenant-wide. Time-boxed assignments cover leave and
 * expire on their own, rather than depending on somebody remembering to revoke
 * them — the same dated-validity pattern as competence records.
 *
 * This replaces the single `users.role_id` column: a person is routinely a
 * Scientist on one section and a reviewer on another, and one column cannot say so.
 */
export const roleAssignmentsTable = lotmark.table('role_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  /** Role key resolved against the active configuration version. */
  roleKey: text('role_key').notNull(),
  /** null = tenant-wide. */
  teamId: uuid('team_id').references(() => teamsTable.id, { onDelete: 'cascade' }),

  validFrom: isoDate('valid_from'),
  validTo: isoDate('valid_to'),

  grantedBy: uuid('granted_by').references(() => usersTable.id),
  grantedReason: text('granted_reason'),
  revokedBy: uuid('revoked_by').references(() => usersTable.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),

  ...timestamps,
}, (t) => ({
  userIdx: index('role_assignments_user_idx').on(t.userId, t.teamId),
  teamIdx: index('role_assignments_team_idx').on(t.teamId),
}));

/**
 * Values for tenant-defined custom fields.
 *
 * Held as one JSONB document per record rather than as an EAV table: the whole
 * document is read and written with its parent, it is never joined across
 * records, and JSONB gives GIN indexing for the cases where it must be searched.
 * EAV would turn every detail view into an N-row join for no benefit.
 *
 * Validated on write against the field definitions in the ACTIVE config version.
 * Records keep values for fields later removed from configuration, because
 * deleting a field definition must not silently destroy recorded data.
 */
export const customFieldValuesTable = lotmark.table('custom_field_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  /** Which built-in entity, e.g. 'lot', 'study'. */
  entity: text('entity').notNull(),
  recordId: uuid('record_id').notNull(),
  values: jsonb('values').$type<Record<string, unknown>>().notNull().default({}),
  /** The config version whose field definitions these values were validated against. */
  configVersionId: uuid('config_version_id').references(() => configVersionsTable.id),
  ...timestamps,
}, (t) => ({
  recordUnique: uniqueIndex('custom_field_values_record_unique').on(t.entity, t.recordId),
  entityIdx: index('custom_field_values_entity_idx').on(t.tenantId, t.entity),
}));
