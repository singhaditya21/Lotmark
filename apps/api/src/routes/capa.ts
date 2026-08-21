import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertTransition, canTransition, nextStates, CAPA_MACHINE, IllegalTransitionError,
  defaultSodSettings, type AuthScope,
} from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import {
  sendProblem, notFound, conflict, invalidRequest, forbidden, unprocessable,
} from '../http/problem';

/**
 * Complaints, nonconformities and corrective action — ISO 17034 7.11.
 *
 * The register existed; the workflow did not, so a CAPA could be raised and
 * never advanced. That matters beyond tidiness: a nonconformity nobody can
 * close is one an assessor finds open with no record of what was done, and
 * "we fixed it, we just could not record that" is not a defence.
 *
 * Closing is not deletion. A CAPA raised in error is closed with the reason
 * stated, not removed — a register you can delete from is not a register.
 */
const transitionBody = z.object({
  to: z.enum(['investigation', 'root_cause', 'capa', 'effectiveness', 'closed']),
  reason: z.string().min(1, 'Every move must state why.').max(2000),
  rootCause: z.string().max(2000).optional(),
  correctiveAction: z.string().max(2000).optional(),
  preventiveAction: z.string().max(2000).optional(),
  effectivenessCheck: z.string().max(2000).optional(),
});

export async function registerCapaRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  const auditOf = (ctx: RequestContext) => ({
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  });

  /** The register, with the moves available from each current state. */
  app.get('/capa', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const verdict = decide({
      authority: ctx.authority, permission: 'capa:manage',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    const rows = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      tx`SELECT c.id, c.code, c.source, c.severity, c.state, c.raised_on, c.due_on,
                c.root_cause, c.corrective_action, c.closed_at, t.name AS team
         FROM lotmark.capa c LEFT JOIN lotmark.teams t ON t.id = c.owner_team_id
         WHERE c.tenant_id = ${ctx.tenantId} ORDER BY c.raised_on DESC, c.code DESC`);

    return reply.send({
      capa: rows.map((r) => {
        const c = r as Record<string, unknown>;
        return {
          ...c,
          // The UI should offer only moves the machine permits, and the machine
          // is the authority on that — not a hardcoded list in the console.
          availableTransitions: nextStates(CAPA_MACHINE, c['state'] as never),
        };
      }),
    });
  });

  /**
   * Advance a CAPA.
   *
   * Every move goes through the declared machine, requires a stated reason, and
   * is recorded in state_transitions as well as the ledger. A nonconformity
   * that moved for reasons nobody wrote down is a nonconformity you cannot
   * defend during an assessment.
   */
  app.post<{ Params: { id: string } }>('/capa/:id/transition', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = transitionBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        parsed.error.issues[0]?.message ?? 'Invalid transition.'));
    }
    const body = parsed.data;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [row] = await tx`
        SELECT id, code, state, source, owner_team_id, root_cause, corrective_action
        FROM lotmark.capa
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} FOR UPDATE`;
      const capa = row as {
        id: string; code: string; state: string; source: string;
        owner_team_id: string | null; root_cause: string | null; corrective_action: string | null;
      } | undefined;
      if (!capa) return { status: 404 as const };

      const scope: AuthScope = capa.owner_team_id
        ? { kind: 'team', teamId: capa.owner_team_id } : { kind: 'tenant' };

      const verdict = decide({
        authority: ctx.authority, permission: 'capa:manage', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditOf(ctx), {
          kind: 'DENY', action: 'CAPA transition refused',
          detail: `${capa.code}: ${verdict.message}`,
          subjectTable: 'capa', subjectId: capa.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      try {
        assertTransition(CAPA_MACHINE, capa.state as never, body.to as never);
      } catch (e) {
        if (e instanceof IllegalTransitionError) {
          return {
            status: 409 as const,
            message: `${capa.code} is ${capa.state}; it cannot move to ${body.to}. ` +
              `Available: ${nextStates(CAPA_MACHINE, capa.state as never).join(', ') || 'none'}.`,
          };
        }
        throw e;
      }

      /**
       * A CAPA cannot close without a root cause and a corrective action.
       *
       * Closing one on the strength of "it stopped happening" is how the same
       * nonconformity returns next quarter with a new number.
       */
      const rootCause = body.rootCause ?? capa.root_cause;
      const corrective = body.correctiveAction ?? capa.corrective_action;
      if (body.to === 'closed' && (!rootCause || !corrective)) {
        return {
          status: 422 as const,
          message: 'A CAPA cannot be closed without a recorded root cause and corrective action. ' +
            'If it was raised in error, say so as the root cause — that is a legitimate finding, ' +
            'and it is still a finding.',
        };
      }

      await tx`
        UPDATE lotmark.capa
        SET state = ${body.to},
            root_cause = ${rootCause},
            corrective_action = ${corrective},
            preventive_action = COALESCE(${body.preventiveAction ?? null}, preventive_action),
            effectiveness_check = COALESCE(${body.effectivenessCheck ?? null}, effectiveness_check),
            closed_at = ${body.to === 'closed' ? tx`now()` : null},
            version = version + 1
        WHERE id = ${capa.id}`;

      await tx`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason)
        VALUES (${ctx.tenantId}, 'capa', ${capa.id}, ${capa.state}, ${body.to},
                ${ctx.userId}, ${body.reason})`;

      await recordAudit(tx, auditOf(ctx), {
        kind: 'WORKFLOW',
        action: body.to === 'closed' ? 'CAPA closed' : `CAPA moved to ${body.to}`,
        detail: `${capa.code} · ${capa.state} → ${body.to} · ${body.reason}`,
        subjectTable: 'capa', subjectId: capa.id,
        changes: { from: capa.state, to: body.to, reason: body.reason },
      });

      return {
        status: 200 as const,
        body: {
          capa: { id: capa.id, code: capa.code, state: body.to },
          from: capa.state,
          availableTransitions: nextStates(CAPA_MACHINE, body.to as never),
        },
      };
    });

    switch (result.status) {
      case 404: return sendProblem(reply, notFound('No such CAPA.'));
      case 403: return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
      case 409: return sendProblem(reply, conflict(result.message));
      case 422: return sendProblem(reply, unprocessable(result.message));
      default: return reply.send(result.body);
    }
  });

  /** The declared machine, so the console never hardcodes a workflow. */
  app.get('/capa/workflow', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;
    return reply.send({
      states: CAPA_MACHINE.states,
      initial: CAPA_MACHINE.initial,
      terminal: CAPA_MACHINE.terminal,
      transitions: CAPA_MACHINE.transitions.map((t) => ({
        from: t.from, to: t.to, action: t.action, requires: t.requires,
      })),
      // Proof the two agree, rather than two lists that drift.
      canCloseFromEffectiveness: canTransition(CAPA_MACHINE, 'effectiveness', 'closed') !== null,
    });
  });
}
