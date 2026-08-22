import type { Sql } from '../db';

/**
 * Which tenant this deployment serves.
 *
 * ── THE DECISION: one tenant per deployment ─────────────────────────────────
 *
 * Lotmark is single-tenant, and the multi-tenant machinery in the schema is
 * defence in depth rather than a deployment model. That is a decision, taken
 * deliberately, and this is where it is written down.
 *
 * The reasoning:
 *
 *  1. The multi-party boundary that actually exists is PRODUCER against
 *     CUSTOMER, not producer against producer. A laboratory that buys a
 *     reference material and the producer that made it share a tenant, and the
 *     restrictive `organisation_id` policies from migration 0022 are what keep
 *     one customer's orders away from another's. That boundary is real,
 *     exercised on every request, and tested. Tenant isolation guards a second
 *     boundary nobody has asked for.
 *
 *  2. A reference material producer is an accredited institution. The natural
 *     unit of deployment is one producer, which is also the unit CERT-In cares
 *     about for data residency and the unit an ISO 17034 assessment covers. Two
 *     producers sharing an instance would have to agree on a retention
 *     schedule, a signing key custody class and an audit key — and each of
 *     those is a governance decision an accredited body makes for itself.
 *
 *  3. It answers three architectural questions at once, and answering them was
 *     blocking a week of work each: how a request identifies its tenant (it
 *     does not — there is one), who may create one (a deployment, through the
 *     seed, not a product feature), and whether the audit HMAC key is per
 *     tenant or per deployment (per deployment, because they are the same
 *     thing).
 *
 * ── It stays reversible ─────────────────────────────────────────────────────
 *
 * Nothing is being removed to make this true. Every table keeps `tenant_id`,
 * every policy keeps `current_tenant()`, and `lotmark.resolve_tenant` keeps the
 * `p_slug` parameter it has always had. Going multi-tenant later means
 * answering those three questions and changing THIS function — not unpicking
 * isolation from a schema that never had it.
 *
 * That is the whole point of resolving in one place. It was three: the session
 * plugin, sign-in, and public verification, each with its own copy of the same
 * query and its own silence about the assumption.
 */

export interface CurrentTenant {
  readonly id: string;
  readonly slug: string;
  readonly timeSource: string;
  readonly region: string;
}

export class NoTenantError extends Error {
  constructor() {
    super('No tenant is provisioned. Run: pnpm db:seed');
    this.name = 'NoTenantError';
  }
}

/**
 * Resolve it, or null if the deployment has not been provisioned.
 *
 * Through `resolve_tenant`, never a direct SELECT: `tenants` is under forced
 * row-level security and a request that has not yet established a tenant
 * context cannot satisfy the policy. This is the one sanctioned bootstrap path,
 * and it is SECURITY DEFINER precisely so that it can be.
 */
export async function currentTenant(sql: Sql): Promise<CurrentTenant | null> {
  const [row] = await sql`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  const t = row as
    { id: string; slug: string; time_source: string; region: string } | undefined;
  return t
    ? { id: t.id, slug: t.slug, timeSource: t.time_source, region: t.region }
    : null;
}

/** The same, for callers that cannot sensibly continue without one. */
export async function requireTenant(sql: Sql): Promise<CurrentTenant> {
  const t = await currentTenant(sql);
  if (!t) throw new NoTenantError();
  return t;
}
