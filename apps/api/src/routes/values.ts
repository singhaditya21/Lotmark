import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  oneWayAnova, linearStability, consensus, combineBudget,
  shelfLifeMonthsBetween, expandedUncertainty, type UncertaintyComponent,
} from '@lotmark/stats';
import {
  isSignatureMeaning, defaultSodSettings, assertTransition, signatureRequired,
  type SignatureMeaning, type CompetenceBasis, type AuthScope, type Permission,
} from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { machineForEntity } from '../services/workflows';
import { applySignature, SigningError } from '../services/signing';
import { loadLiveSession, hashToken, SESSION_COOKIE } from '../services/sessions';
import { conflict, forbidden, invalidRequest, notFound, sendProblem, stepUpRequired, unprocessable } from '../http/problem';

const body = z.object({
  meaning: z.string().refine(isSignatureMeaning),
  reason: z.string().max(1000).optional(),
});

/**
 * Property value assignment and authorisation.
 *
 * These are the two acts segregation of duties exists for. The person who
 * assigns a value may not be the person who authorises it — a control that only
 * means something because BOTH acts are signed, so "who did which" is not a
 * matter of trusting a field.
 */
export async function registerValueRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys } = app;

  async function competenceBasis(
    tx: Sql, tenantId: string, userId: string, activity: Permission, onDate: string,
  ): Promise<CompetenceBasis | null> {
    const [row] = await tx`
      SELECT id, activity, valid_from, valid_to FROM lotmark.competence_records
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND activity = ${activity}
        AND superseded_at IS NULL AND valid_from <= ${onDate} AND valid_to >= ${onDate}
      LIMIT 1`;
    const c = row as { id: string; activity: string; valid_from: string; valid_to: string } | undefined;
    return c ? {
      competenceRecordId: c.id, activity: c.activity,
      validFrom: c.valid_from, validTo: c.valid_to,
      checkedOn: onDate, personUserId: userId,
    } : null;
  }

  /** Recompute the budget for a project from its SIGNED studies only. */
  async function budgetFor(tx: Sql, tenantId: string, projectId: string, today: string) {
    const studies = await tx`
      SELECT id, code, study_type, signed_on, shelf_life_to
      FROM lotmark.studies
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND state = 'signed'`;

    const components: UncertaintyComponent[] = [];
    let assignedValue: number | null = null;

    for (const s of studies) {
      const st = s as { id: string; code: string; study_type: string; signed_on: string | null; shelf_life_to: string | null };
      const raw = await tx`
        SELECT unit_ref, replicate, elapsed_months, laboratory_ref, measured_value
        FROM lotmark.study_results WHERE study_id = ${st.id}`;
      if (raw.length === 0) continue;
      const rows = raw.map((r) => r as {
        unit_ref: number | null; replicate: number | null; elapsed_months: number | null;
        laboratory_ref: string | null; measured_value: number;
      });

      if (st.study_type === 'homogeneity') {
        const a = oneWayAnova(rows.map((r) => ({ unit: r.unit_ref!, replicate: r.replicate!, value: r.measured_value })));
        components.push({
          studyId: st.code, studyType: 'homogeneity', symbol: 'u(bb)', value: a.uBb,
          basis: `${a.units} units × ${a.replicatesPerUnit} replicates, one-way ANOVA` +
            (a.floored ? ', floored at the detection limit' : ''),
        });
      } else if (st.study_type === 'stability') {
        const months = st.shelf_life_to ? shelfLifeMonthsBetween(st.signed_on ?? today, st.shelf_life_to) : 24;
        const r = linearStability(rows.map((x) => ({ months: x.elapsed_months!, value: x.measured_value })), months);
        components.push({
          studyId: st.code, studyType: 'stability', symbol: 'u(lts)', value: r.uLts,
          basis: `${r.n} timepoints, slope ${r.slope.toFixed(5)}/month` +
            `${r.trendSignificant ? ' (SIGNIFICANT)' : ' (not significant)'}, over ${months} months`,
        });
      } else if (st.study_type === 'characterisation') {
        const c = consensus(rows.map((x) => ({ laboratory: x.laboratory_ref!, value: x.measured_value })));
        components.push({
          studyId: st.code, studyType: 'characterisation', symbol: 'u(char)', value: c.uChar,
          basis: `${c.laboratories} laboratories, s = ${c.standardDeviation.toFixed(4)}`,
        });
        // The assigned value IS the consensus mean. Nothing types it.
        assignedValue = c.value;
      }
    }
    return { budget: combineBudget(components), assignedValue };
  }

  /**
   * ASSIGN a property value.
   *
   * The value and its uncertainty are derived from signed studies; the request
   * carries only a meaning and an optional reason. There is deliberately no way
   * to submit a number.
   */
  app.post<{ Params: { id: string } }>('/values/:id/assign', async (req, reply) =>
    handleValueStep(req, reply, {
      permission: 'value:assign',
      from: 'draft', to: 'assigned',
      actionLabel: 'Property value assigned',
    }));

  /**
   * AUTHORISE a property value.
   *
   * SoD-1 is enforced here by the guard reading `assignedBy` off the loaded
   * record, and again by a CHECK constraint that makes assigner = authoriser
   * unstorable. Two mechanisms because the guard gives a good message and the
   * constraint makes the message impossible to bypass.
   */
  app.post<{ Params: { id: string } }>('/values/:id/authorise', async (req, reply) =>
    handleValueStep(req, reply, {
      permission: 'value:authorise',
      from: 'assigned', to: 'authorised',
      actionLabel: 'Property value authorised',
    }));

  /**
   * Both steps share one implementation: they differ only in which permission
   * they need and which transition they take. Duplicating them would let the
   * guard chain drift between assignment and authorisation, which is exactly
   * where a segregation control must not have two versions.
   */
  async function handleValueStep(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    step: { permission: Permission; from: string; to: string; actionLabel: string },
  ): Promise<FastifyReply | undefined> {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest('A signature meaning is required.'));
    }
    const meaning = parsed.data.meaning as SignatureMeaning;
    const token = req.cookies[SESSION_COOKIE]!;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [row] = await tx`
        SELECT v.*, p.code AS project_code, p.owner_team_id
        FROM lotmark.property_values v
        JOIN lotmark.projects p ON p.id = v.project_id
        WHERE v.tenant_id = ${ctx.tenantId} AND v.id = ${req.params.id}
        FOR UPDATE OF v`;
      const value = row as {
        id: string; code: string; project_id: string; project_code: string;
        property_name: string; unit: string; coverage_factor: number;
        state: string; assigned_by: string | null; owner_team_id: string | null;
      } | undefined;
      if (!value) return { status: 404 as const };

      if (value.state !== step.from) {
        return { status: 409 as const, message: `${value.code} is ${value.state}, not ${step.from}.` };
      }
      // The declared machine is the authority on what may follow what — and
      // which machine is declared is now the tenant's to say.
      const valueMachine = await machineForEntity(
        tx, ctx.tenantId, 'property_value', (m) => app.log.warn(m));
      if (!valueMachine) {
        return { status: 409 as const, message: 'No workflow governs property values.' };
      }
      const move = assertTransition(valueMachine, step.from, step.to);
      /**
       * The rule comes off the move, not out of this route.
       *
       * `signatureRequired` ORs the configured flag with the floor, so this is
       * true for assigning and authorising however a tenant configures them —
       * which is the point of the floor. What changes is that the route no
       * longer carries its own opinion about it.
       */
      const needsSignature = signatureRequired(move);

      const scope: AuthScope = value.owner_team_id
        ? { kind: 'team', teamId: value.owner_team_id } : { kind: 'tenant' };
      const basis = await competenceBasis(tx, ctx.tenantId, ctx.userId, step.permission, ctx.today);

      const verdict = decide({
        authority: ctx.authority,
        permission: step.permission,
        scope,
        // SoD-1 reads assignedBy from here.
        record: { assignedBy: value.assigned_by },
        sodSettings: defaultSodSettings(),
        onDate: ctx.today,
        requiresCompetence: step.permission,
        competenceFor: () => basis,
        requiresSignature: needsSignature,
      });

      if (!verdict.allowed) {
        await recordAudit(tx, auditCtxOf(ctx), {
          kind: 'DENY', action: `${step.actionLabel} refused`,
          detail: `${value.code}: ${verdict.message}`,
          subjectTable: 'property_values', subjectId: value.id,
          changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      const { budget, assignedValue } = await budgetFor(tx, ctx.tenantId, value.project_id, ctx.today);
      if (!budget.complete || assignedValue === null || budget.uCombined === null) {
        return {
          status: 422 as const,
          message: 'The uncertainty budget is incomplete: homogeneity, stability and ' +
            'characterisation must all be signed before a value can be assigned.',
        };
      }
      const expanded = expandedUncertainty(budget.uCombined, value.coverage_factor);

      const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return { status: 401 as const, message: 'Your session has ended.' };
      const key = await keys.active(tx, ctx.tenantId, (m) => app.log.info(m));

      let signature;
      try {
        signature = await applySignature(tx, {
          tenantId: ctx.tenantId,
          signable: {
            kind: 'value',
            record: {
              id: value.code, projectId: value.project_code, property: value.property_name,
              value: assignedValue, unit: value.unit, coverageFactor: value.coverage_factor,
            },
          },
          subjectId: value.id,
          signerUserId: ctx.userId,
          meaning, session,
          signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
          competenceBasis: verdict.competenceBasis,
          requiresCompetence: true,
          key, timeSource: ctx.timeSource, region: ctx.region,
        });
      } catch (e) {
        if (e instanceof SigningError) {
          return { status: e.code === 'step_up_required' ? 401 as const : 409 as const, message: e.message };
        }
        throw e;
      }

      if (step.to === 'assigned') {
        await tx`
          UPDATE lotmark.property_values
          SET state = 'assigned', assigned_value = ${assignedValue},
              combined_uncertainty = ${budget.uCombined}, expanded_uncertainty = ${expanded},
              components = ${tx.json(budget.components as never)},
              assigned_by = ${ctx.userId}, assigned_at = now(), version = version + 1
          WHERE id = ${value.id}`;
      } else {
        await tx`
          UPDATE lotmark.property_values
          SET state = 'authorised', authorised_by = ${ctx.userId}, authorised_at = now(),
              version = version + 1
          WHERE id = ${value.id}`;
      }

      await tx`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason, signature_id)
        VALUES (${ctx.tenantId}, 'property_value', ${value.id}, ${step.from}, ${step.to},
                ${ctx.userId}, ${parsed.data.reason ?? null}, ${signature.id})`;

      await recordAudit(tx, auditCtxOf(ctx), {
        kind: 'WORKFLOW', action: step.actionLabel,
        detail: `${value.code} · ${assignedValue.toPrecision(7)} ± ${expanded.toPrecision(4)} ${value.unit} (k=${value.coverage_factor}) · ${meaning}`,
        subjectTable: 'property_values', subjectId: value.id,
        changes: { state: { from: step.from, to: step.to }, assignedValue, expanded },
      });

      return {
        status: 200 as const,
        body: {
          value: {
            id: value.id, code: value.code, state: step.to,
            assignedValue, combinedUncertainty: budget.uCombined,
            expandedUncertainty: expanded, coverageFactor: value.coverage_factor,
            unit: value.unit,
          },
          components: budget.components,
          signature: {
            id: signature.id, meaning, signedAt: signature.signedAt,
            keyVersion: key.keyVersion, custody: key.custody,
          },
        },
      };
    });

    switch (result.status) {
      case 404: return sendProblem(reply, notFound('No such property value.'));
      case 403: return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
      case 409: return sendProblem(reply, conflict(result.message));
      case 422: return sendProblem(reply, unprocessable(result.message));
      case 401: return sendProblem(reply, stepUpRequired(result.message));
      default: return reply.send(result.body);
    }
  }

  /** Values for a project, with their state — the authorisation queue. */
  app.get<{ Params: { id: string } }>('/projects/:id/values', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;
    const rows = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      tx`SELECT v.id, v.code, v.property_name, v.unit, v.state, v.assigned_value,
                v.expanded_uncertainty, v.coverage_factor, v.assigned_by, v.authorised_by
         FROM lotmark.property_values v
         WHERE v.tenant_id = ${ctx.tenantId} AND v.project_id = ${req.params.id}
         ORDER BY v.code`);
    return reply.send({ values: rows });
  });
}

function auditCtxOf(ctx: RequestContext) {
  return {
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  };
}

