import { pgSchema, timestamp, text, integer } from 'drizzle-orm/pg-core';
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
 * A calendar date held as text in ISO `YYYY-MM-DD` form.
 *
 * Deliberate: the whole domain compares dates lexically (competence intervals,
 * calibration coverage, "as at" queries) and a date here is a CALENDAR fact —
 * the day a person was authorised — not an instant. Storing it as `date` and
 * letting a driver convert through a JS Date reintroduces timezone drift that
 * has, in this domain, moved a signature across a competence boundary.
 */
export const isoDate = (name: string) => text(name);

/** Who did it — a user id, or the literal 'system' for scheduled jobs. */
export const actorRef = (name: string) => text(name);
