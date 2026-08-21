import type { Sql } from '../db';
import { inTenantTransaction } from '../db';
import type { AuditContext } from '../services/audit';

/**
 * Running work with no user and no request.
 *
 * Two problems that every scheduled job in this system runs into, solved once
 * here rather than badly in each job.
 *
 * ── Problem 1: who is the actor? ────────────────────────────────────────────
 *
 * The ledger requires an actor on every entry. A job has no session and no
 * signed-in person. Writing a plausible-looking user id would be a lie in the
 * audit trail — the worst possible place for one — so a job acts as `system`,
 * with a null user id and a job name that says which job did it. An assessor
 * reading "system · expiry-notices" learns more than they would from a service
 * account that looks like a person.
 *
 * ── Problem 2: which tenant? ────────────────────────────────────────────────
 *
 * Row-level security is FORCED on every table and `current_tenant()` returns
 * NULL when unset, so a job that simply queries sees nothing. The temptation is
 * a BYPASSRLS role for jobs. That is exactly the wrong move: it creates a
 * privileged path where a bug leaks across tenants silently, and it means the
 * policies are never exercised by the code that runs unattended at 3am.
 *
 * Instead a job runs ONCE PER TENANT, inside that tenant's context. Slower, and
 * correct: a job cannot see across tenants because nothing can.
 */

export const SYSTEM_ACTOR_LABEL = 'system';

export function systemAuditContext(args: {
  tenantId: string; jobName: string; timeSource: string; region: string;
}): AuditContext {
  return {
    tenantId: args.tenantId,
    // Null, not a synthetic user. A job is not a person and the ledger should
    // not imply otherwise.
    actorUserId: null,
    actorLabel: `${SYSTEM_ACTOR_LABEL} · ${args.jobName}`,
    actorRoleId: SYSTEM_ACTOR_LABEL,
    sessionId: null,
    timeSource: args.timeSource,
    region: args.region,
  };
}

export interface TenantContext {
  readonly id: string;
  readonly slug: string;
  readonly timeSource: string;
  readonly region: string;
}

/**
 * Every tenant, for a job to iterate.
 *
 * Reads through `resolve_tenant`-style SECURITY DEFINER access rather than
 * selecting the table, because the caller has no tenant context yet — the same
 * bootstrap problem the API has at sign-in.
 */
export async function allTenants(sql: Sql): Promise<TenantContext[]> {
  const rows = await sql`SELECT * FROM lotmark.all_tenants()`;
  return rows.map((r) => {
    const t = r as { id: string; slug: string; time_source: string; region: string };
    return { id: t.id, slug: t.slug, timeSource: t.time_source, region: t.region };
  });
}

export interface JobOutcome {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly itemsProcessed: number;
  readonly outcome: 'success' | 'failure' | 'partial';
  readonly error?: string;
}

/**
 * Run one job across every tenant, recording each run.
 *
 * A failure in one tenant must not abandon the rest: a producer whose data
 * happens to trip a bug should not stop expiry notices reaching everybody else.
 * Each tenant is its own transaction, and the aggregate outcome is `partial`
 * when some succeeded and some did not — which is a distinct fact from success
 * and from failure, and the one an operator needs.
 */
export async function forEachTenant(
  sql: Sql,
  args: { jobName: string; auditKey: string },
  work: (tx: Sql, tenant: TenantContext) => Promise<number>,
): Promise<JobOutcome[]> {
  const tenants = await allTenants(sql);
  const outcomes: JobOutcome[] = [];

  for (const tenant of tenants) {
    const startedAt = new Date().toISOString();
    try {
      const itemsProcessed = await inTenantTransaction(
        sql, { tenantId: tenant.id, auditKey: args.auditKey },
        (tx) => work(tx, tenant),
      );
      outcomes.push({
        tenantId: tenant.id, tenantSlug: tenant.slug,
        itemsProcessed, outcome: 'success',
      });
      await recordRun(sql, {
        tenantId: tenant.id, jobName: args.jobName, startedAt,
        outcome: 'success', itemsProcessed, error: null, auditKey: args.auditKey,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      outcomes.push({
        tenantId: tenant.id, tenantSlug: tenant.slug,
        itemsProcessed: 0, outcome: 'failure', error,
      });
      // Recorded on its own connection: the failing transaction has rolled
      // back, and a job run nobody can see is a job that silently stopped.
      await recordRun(sql, {
        tenantId: tenant.id, jobName: args.jobName, startedAt,
        outcome: 'failure', itemsProcessed: 0, error, auditKey: args.auditKey,
      });
    }
  }
  return outcomes;
}

async function recordRun(
  sql: Sql,
  args: {
    tenantId: string; jobName: string; startedAt: string;
    outcome: 'success' | 'failure'; itemsProcessed: number;
    error: string | null; auditKey: string;
  },
): Promise<void> {
  await inTenantTransaction(sql, { tenantId: args.tenantId, auditKey: args.auditKey }, async (tx) => {
    await tx`
      INSERT INTO lotmark.job_runs
        (tenant_id, job_name, started_at, finished_at, outcome, items_processed, error_text)
      VALUES (${args.tenantId}, ${args.jobName}, ${args.startedAt}, now(),
              ${args.outcome}, ${args.itemsProcessed}, ${args.error})`;
  });
}
