import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertTransition, canTransition, nextStates, IllegalTransitionError,
  defaultSodSettings, signatureRequired, meaningsFor, reasonRequired, isSignatureMeaning,
  parseGuard, evaluateGuard,
  type AuthScope, type SignatureMeaning,
} from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { machineForEntity } from '../services/workflows';
import { currentCustomValues } from '../services/custom-fields';
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
  /**
   * Optional HERE, and demanded by the move.
   *
   * This was `min(1)` — every CAPA move stated why, whatever the configured
   * workflow said. That rule was right and is now where it belongs: the
   * product's default declares a reason on all five CAPA moves, so the
   * behaviour is unchanged, and a tenant that decides otherwise is obeyed
   * instead of overruled by a schema.
   */
  reason: z.string().max(2000).optional(),
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
        SELECT id, code, state, source, severity, owner_team_id,
               root_cause, corrective_action, preventive_action, effectiveness_check
        FROM lotmark.capa
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} FOR UPDATE`;
      const capa = row as {
        id: string; code: string; state: string; source: string; severity: string;
        owner_team_id: string | null; root_cause: string | null; corrective_action: string | null;
        preventive_action: string | null; effectiveness_check: string | null;
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

      /**
       * The values as they WILL be after this move, not as they were.
       *
       * A guard asking "is there a preventive action" must see the one being
       * supplied in this very request, or the rule is unsatisfiable: the person
       * would have to save the field in one move and satisfy the condition in a
       * later one that no longer needs it.
       */
      const rootCauseNow = body.rootCause ?? capa.root_cause;
      const correctiveNow = body.correctiveAction ?? capa.corrective_action;
      const needsSignature = signatureRequired(step);

      /**
       * Guards, evaluated against facts THIS route builds.
       *
       * The object below is the whole world a guard can see. It is not a query
       * interface and not the record — it is a handful of values chosen here,
       * in code, which is what makes "a guard cannot read anything else" a
       * property of the system rather than a promise about an expression
       * language.
       *
       * A guard that cannot be evaluated REFUSES the move. Publication reads
       * every guard first, so reaching this with a broken one means the entry
       * arrived another way, and the safe reading of a rule nobody can apply is
       * that the move is not allowed.
       *
       * Checked before the reason and the signature. There is no point asking
       * somebody to justify and then attest a move that is not permitted at
       * all, and a step-up spent on a refusal is a step-up they have to repeat.
       */
      for (const expression of step.guards ?? []) {
        const facts = {
          record: {
            severity: capa.severity,
            source: capa.source,
            root_cause: rootCauseNow,
            corrective_action: correctiveNow,
            preventive_action: body.preventiveAction ?? capa.preventive_action,
            effectiveness_check: body.effectivenessCheck ?? capa.effectiveness_check,
          },
          custom: await currentCustomValues(tx, 'capa', capa.id),
        };

        let holds: boolean;
        try {
          holds = evaluateGuard(parseGuard(expression), facts);
        } catch (e) {
          return {
            status: 422 as const,
            message: `A condition on this move could not be applied, so the move is refused: `
              + `${e instanceof Error ? e.message : 'the condition could not be read'}. `
              + 'An administrator can correct it under Flow designer.',
          };
        }
        if (!holds) {
          return {
            status: 422 as const,
            message: `${capa.code} does not meet a condition this move requires: `
              + `${expression}.`,
          };
        }
      }

      /**
       * A reason, when the move asks for one.
       *
       * Checked before the signature: being told to re-authenticate and THEN
       * that the reason was missing is two round trips for one mistake — and
       * the second one costs a step-up the person now has to repeat.
       */
      if (reasonRequired(step) && !body.reason?.trim()) {
        return {
          status: 422 as const,
          message: `Moving ${capa.code} from ${capa.state} to ${body.to} must state why. `
            + 'A nonconformity that moved for reasons nobody wrote down is one you cannot '
            + 'defend during an assessment.',
        };
      }

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
      const rootCause = rootCauseNow;
      const corrective = correctiveNow;
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
                from: capa.state as string, to: body.to, reason: body.reason ?? '',
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
                ${ctx.userId}, ${body.reason ?? null}, ${signatureId})`;

      await recordAudit(tx, auditOf(ctx), {
        kind: 'WORKFLOW',
        action: body.to === 'closed' ? 'CAPA closed' : `CAPA moved to ${body.to}`,
        detail: `${capa.code} · ${capa.state} → ${body.to}`
          + (body.reason ? ` · ${body.reason}` : ''),
        subjectTable: 'capa', subjectId: capa.id,
        changes: { from: capa.state, to: body.to, reason: body.reason ?? null },
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
