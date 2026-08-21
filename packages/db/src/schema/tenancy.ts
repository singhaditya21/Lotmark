import { boolean, jsonb, text, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { lotmark, timestamps, version } from './_shared';

/**
 * A tenant is a reference material producer.
 *
 * IPC is a PROFILE of this product, not a fork. Everything that distinguishes
 * one producer from another — numbering scheme, bilingual output, which
 * conformance frame applies, where data rests — is a column here, so a new
 * producer is a row rather than a branch.
 */
export const tenantsTable = lotmark.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stable machine key, e.g. 'ipc', 'generic'. */
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),

  /** Render every label in English and Hindi. */
  bilingual: boolean('bilingual').notNull().default(false),
  /** Alternative dispute resolution flow enabled. */
  adr: boolean('adr').notNull().default(false),
  publications: boolean('publications').notNull().default(false),
  /** Government price tier available to eligible customers. */
  govTier: boolean('gov_tier').notNull().default(false),

  /** The conformance frame claimed, e.g. 'ISO 17034 + GIGW 3.0 + DPDP'. */
  conformanceFrame: text('conformance_frame').notNull(),
  /** Lot numbering template, e.g. 'RMP-{MAT}-{SEQ}' or 'IPRS{MAT}{SEQ}'. */
  lotNumberingTemplate: text('lot_numbering_template').notNull(),
  /** Where this tenant's data rests, e.g. 'NIC / MeitY, in-country'. */
  dataResidency: text('data_residency').notNull(),

  /** Capabilities explicitly OUT of product scope for this tenant. */
  outOfScope: jsonb('out_of_scope').$type<string[]>().notNull().default([]),

  /**
   * Segregation-of-duties switches, keyed by rule id (SoD-1..SoD-4).
   * Rule definitions live in @lotmark/domain; only the on/off state is data,
   * because turning one off is a governance act that must be auditable.
   */
  sodSettings: jsonb('sod_settings').$type<Record<string, boolean>>().notNull().default({}),

  /** Trusted time source description and region, stamped onto signatures. */
  timeSource: text('time_source').notNull().default('pool.ntp.org (stratum 2)'),
  region: text('region').notNull().default('eu-central-1'),

  version: version(),
  ...timestamps,
}, (t) => ({
  slugUnique: uniqueIndex('tenants_slug_unique').on(t.slug),
}));

/**
 * An organisation: either the producer itself or a customer laboratory.
 * Customers belong to a tenant because a customer of one producer is not
 * automatically a customer of another.
 */
export const organisationsTable = lotmark.table('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenantsTable.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['producer', 'customer'] }).notNull(),

  /** Customer classification, e.g. 'Government laboratory'. */
  organisationType: text('organisation_type'),
  /** Producer accreditation, e.g. 'NABL RMP-0042'. */
  accreditation: text('accreditation'),
  accreditationScope: text('accreditation_scope'),

  /**
   * Contact telephone — PERSONAL DATA under DPDP.
   * Reading it requires `pii:contact`; a break-glass read is written to the
   * audit ledger against the reader. Retention class: customer_contact_data.
   */
  phone: text('phone'),

  /** Current price tier. Government tier requires an approved entitlement. */
  priceTier: text('price_tier', { enum: ['private', 'government'] })
    .notNull().default('private'),

  version: version(),
  ...timestamps,
}, (t) => ({
  codeUnique: uniqueIndex('organisations_tenant_code_unique').on(t.tenantId, t.code),
}));
