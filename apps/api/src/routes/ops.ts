import type { FastifyInstance } from 'fastify';
import { inTenantTransaction } from '../db';
import { requireSession } from '../plugins/session';
import { decide } from '../services/guard';
import { jobStatuses, needsAttention, recentDrills } from '../services/ops';
import { sendProblem, forbidden } from '../http/problem';

/**
 * Operational health.
 *
 * ── Why `audit:read` and not a new permission ───────────────────────────────
 *
 * No `ops:read` was invented. Roles are stored configuration, so a permission
 * added in code would exist in the vocabulary and be granted to nobody in any
 * tenant that already exists — it would gate this shut and look like a bug.
 *
 * `audit:read` is the right fit rather than a convenient one: this IS what the
 * system did, in the half of it nobody watches. The Quality Manager who reads
 * the ledger is the person who most needs to know that the job which raises a
 * CAPA for overdue stability monitoring has not run since Tuesday.
 */
export async function registerOpsRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  app.get('/ops', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const verdict = decide({
      authority: ctx.authority, permission: 'audit:read',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    const body = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, async (tx) => {
      const jobs = await jobStatuses(tx, ctx.tenantId);
      const drills = await recentDrills(tx, ctx.tenantId);
      return {
        jobs,
        attention: needsAttention(jobs).map((j) => j.name),
        drills: drills.map((d) => ({
          id: d.id,
          startedAt: d.started_at,
          finishedAt: d.finished_at,
          source: d.source_label,
          outcome: d.outcome,
          checks: d.checks ?? [],
          notes: d.notes,
        })),
        /**
         * The honest gap. Everything above is observed from INSIDE the process
         * being observed, so it cannot report its own absence: if the API is
         * down, nobody is asking it anything. Closing that needs a watcher
         * somewhere else, which does not exist here.
         */
        limits: [
          'These checks run inside the API, so they cannot detect the API being down.',
          'Nothing pages anyone. A failing job is visible to whoever opens this page.',
        ],
      };
    });

    return reply.send(body);
  });

  /**
   * `/ops/alive` used to live here. It returned 200 whether or not the database
   * answered, with the bad news in the body — so an orchestrator reading the
   * status code kept sending traffic to an instance that could not serve it.
   * It was replaced by /health/live and /health/ready in app.ts, which are
   * separate because a liveness probe that fails on a database outage restarts
   * every instance at once.
   */
}
