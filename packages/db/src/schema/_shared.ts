import { pgSchema, timestamp, text, integer, date } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Everything lives in the `lotmark` schema, never `public`. Row-level security
 * policies and the append-only triggers are attached per table in the hand
 * written migrations under ../../migrations.
 */
export const lotmark = pgSchema('lotmark');

/**
 * Tenant scoping.
 *
 * Multi-tenancy is enforced by PostgreSQL ROW-LEVEL SECURITY on `tenant_id`,
 * not by remembering to add a WHERE clause. The API sets
 * `SET LOCAL lotmark.tenant_id = '...'` on every transaction; the policy does
 * the rest. A forgotten filter then returns nothing rather than another
 * tenant's data.
 *
 * Chosen over schema-per-tenant (migrations multiply by tenant count, and
 * cross-tenant product analytics become impossible) and over database-per-tenant
 * (no shared catalogue, heavy on one laptop).
 *
 * Each table declares its own `tenant_id` column with an explicit foreign key,
 * rather than sharing a helper that would import the tenants table and create a
 * module cycle. The RLS policy is what actually enforces isolation; the column
 * is only its subject.
 */

/** Created/updated stamps. `updatedAt` is maintained by a trigger, not the app. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull().default(sql`now()`),
};

/**
 * Optimistic concurrency.
 *
 * The prototype demonstrated a concurrent-update rejection on orders; here every
 * mutable record carries it. An UPDATE must supply the version it read, and a
 * trigger increments it. Two dispatchers advancing the same order cannot both win.
 */
export const version = () => integer('version').notNull().default(1);

/**
 * A calendar date: a real Postgres `date`, surfaced to TypeScript as an ISO
 * `YYYY-MM-DD` string.
 *
 * Two requirements pull in opposite directions and this satisfies both.
 *
 * The domain compares dates LEXICALLY everywhere — competence intervals,
 * calibration coverage, "as at" queries — and these are calendar facts (the day
 * a person was authorised), not instants. Round-tripping through a JS `Date`
 * reintroduces timezone drift, and in this domain that drift can move a
 * signature across a competence boundary. `mode: 'string'` keeps the driver
 * from ever constructing a `Date`, so the lexical comparisons stay exact.
 *
 * But the column must ALSO be a real `date`, not `text`, because the database
 * has to enforce that two competence windows for the same person and activity
 * cannot overlap. That is an `EXCLUDE USING gist (... daterange(...) WITH &&)`
 * constraint, and it cannot be written against text.
 *
 * An earlier revision used `text` and could express only the first requirement.
 */
export const isoDate = (name: string) => date(name, { mode: 'string' });

/** Who did it — a user id, or the literal 'system' for scheduled jobs. */
export const actorRef = (name: string) => text(name);
