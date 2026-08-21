import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertTransition, canTransition, nextStates, IllegalTransitionError,
  defaultSodSettings, signatureRequired, meaningsFor, isSignatureMeaning,
  type AuthScope, type SignatureMeaning,
} from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { machineForEntity } from '../services/workflows';
import { applySignature, rejectSigning, SigningRejection } from '../services/signing';
import { refuseSigning } from '../services/signing-refusal';
import { loadLiveSession, hashToken, SESSION_COOKIE } from '../services/sessions';
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
  /**
   * Any state name; the MACHINE decides whether it is reachable from here.
   *
   * This was an enum of the five built-in CAPA states, which meant a tenant
   * could configure a sixth and then be unable to move anything into it — the
   * workflow said yes and the route said "invalid". The machine is the
   * authority on what may follow what, and `assertTransition` below is where
   * that is asked.
   */
  to: z.string().min(1).max(64),
  reason: z.string().min(1, 'Every move must state why.').max(2000),
  /**
   * Required only when the move demands a signature, which is now a property of
   * the configured transition rather than of this route.
   */
  meaning: z.string().optional(),
  rootCause: z.string().max(2000).optional(),
  correctiveAction: z.string().max(2000).optional(),
  preventiveAction: z.string().max(2000).optional(),
  effectivenessCheck: z.string().max(2000).optional(),
});

export async function registerCapaRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys } = app;

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

    const { rows, machine } = await inTenantTransaction(
      db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => ({
        rows: await tx`SELECT c.id, c.code, c.source, c.severity, c.state, c.raised_on, c.due_on,
                              c.root_cause, c.corrective_action, c.closed_at, t.name AS team
                       FROM lotmark.capa c LEFT JOIN lotmark.teams t ON t.id = c.owner_team_id
                       WHERE c.tenant_id = ${ctx.tenantId} ORDER BY c.raised_on DESC, c.code DESC`,
        // Resolved from THIS tenant's configuration, falling back to the code
        // machine. Read in the same transaction as the rows, so the moves
        // offered belong to the same configuration the states were read under.
        machine: await machineForEntity(tx, ctx.tenantId, 'capa', (m) => app.log.warn(m)),
      }));

    return reply.send({
      capa: rows.map((r) => {
        const c = r as Record<string, unknown>;
        return {
          ...c,
          // The UI should offer only moves the machine permits, and the machine
          // is the authority on that — not a hardcoded list in the console.
          availableTransitions: machine ? nextStates(machine, c['state'] as string) : [],
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

    let result;
    try {
      result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
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

      const machine = await machineForEntity(tx, ctx.tenantId, 'capa', (m) => app.log.warn(m));
      if (!machine) {
        // No machine at all is a programming error, not a configuration one.
        return { status: 409 as const, message: 'No workflow governs complaints and CAPA.' };
      }

      try {
        assertTransition(machine, capa.state as string, body.to);
      } catch (e) {
        if (e instanceof IllegalTransitionError) {
          return {
            status: 409 as const,
            message: `${capa.code} is ${capa.state}; it cannot move to ${body.to}. ` +
              `Available: ${nextStates(machine, capa.state as string).join(', ') || 'none'}.`,
          };
        }
        throw e;
      }

      /**
       * Does THIS move demand a signature?
       *
       * `signatureRequired` ORs the configured flag with the floor in
       * `ALWAYS_SIGNED`, so a tenant can add ceremony to a CAPA move and cannot
       * remove it from an act 21 CFR 11 §11.50 makes the point of the record.
       * Until now nothing read the configured flag at all: the flow designer
       * offered a checkbox that changed what the configuration SAID and not
       * what the system did.
       */
      const step = canTransition(machine, capa.state as string, body.to)!;
      const needsSignature = signatureRequired(step);

      if (needsSignature) {
        const offered = meaningsFor(step);
        if (!body.meaning || !isSignatureMeaning(body.meaning)) {
          return {
            status: 422 as const,
            message: 'This move must be signed, and a signature manifests a meaning. '
              + `Choose one of: ${offered.join(', ')}.`,
          };
        }
        if (!offered.includes(body.meaning)) {
          return {
            status: 422 as const,
            message: `'${body.meaning}' is not a meaning this move offers. `
              + `Choose one of: ${offered.join(', ')}.`,
          };
        }
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

      /**
       * Signed AFTER the record is written and BEFORE the transaction resolves.
       *
       * `rejectSigning` throws rather than returning: returning from inside the
       * callback resolves it, and a resolved callback COMMITS — which is how a
       * refused signing once persisted an unsigned record. The whole move rolls
       * back, and the refusal is recorded on its own transaction.
       */
      let signatureId: string | null = null;
      if (needsSignature) {
        const token = req.cookies[SESSION_COOKIE];
        const session = token
          ? await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES) : null;
        if (!session) return { status: 401 as const, message: 'Your session has ended.' };
        const key = await keys.active(tx, ctx.tenantId, (m: string) => app.log.info(m));

        try {
          const signature = await applySignature(tx, {
            tenantId: ctx.tenantId,
            signable: {
              kind: 'state_transition',
              record: {
                entity: 'capa', recordId: capa.id, code: capa.code,
                from: capa.state as string, to: body.to, reason: body.reason,
              },
            },
            subjectId: capa.id, signerUserId: ctx.userId,
            meaning: body.meaning as SignatureMeaning,
            session, signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
            competenceBasis: null, requiresCompetence: false,
            key, timeSource: ctx.timeSource, region: ctx.region,
          });
          signatureId = signature.id;
        } catch (e) {
          rejectSigning(e, { table: 'capa', label: `${capa.code} ${capa.state} → ${body.to}` });
        }
      }

      await tx`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason,
           signature_id)
        VALUES (${ctx.tenantId}, 'capa', ${capa.id}, ${capa.state}, ${body.to},
                ${ctx.userId}, ${body.reason}, ${signatureId})`;

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
          availableTransitions: nextStates(machine, body.to),
        },
      };
    });

    } catch (e) {
      /**
       * A refused signing arrives as a THROW, not a return.
       *
       * `rejectSigning` throws precisely so the transaction rolls back — a
       * return would resolve the callback and a resolved callback COMMITS,
       * which is how a refused signing once persisted the record it was
       * refusing to sign. The refusal is then recorded on its own transaction
       * and answered as a 401 asking for the step-up.
       *
       * This route needed it only once a signature could be demanded by
       * CONFIGURATION rather than by the route, which is why it was not here
       * before: without the catch the rejection reached the client as a 500,
       * with the correct message and the wrong status, and nothing offering the
       * user a way to re-authenticate.
       */
      if (e instanceof SigningRejection) {
        return refuseSigning({
          db, auditKey: cfg.LOTMARK_AUDIT_KEY, audit: auditOf(ctx), rejection: e, reply,
        });
      }
      throw e;
    }

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

    const machine = await inTenantTransaction(
      db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx) => machineForEntity(tx, ctx.tenantId, 'capa', (m) => app.log.warn(m)));

    if (!machine) return sendProblem(reply, notFound('No workflow governs complaints and CAPA.'));

    return reply.send({
      states: machine.states,
      initial: machine.initial,
      terminal: machine.terminal,
      transitions: machine.transitions.map((t) => ({
        from: t.from, to: t.to, action: t.action, requires: t.requires,
      })),
      // Proof the two agree, rather than two lists that drift. Now answered
      // from the tenant's own machine, so a tenant that removed that move gets
      // `false` and a console that stops offering it.
      canCloseFromEffectiveness: canTransition(machine, 'effectiveness', 'closed') !== null,
    });
  });
}
