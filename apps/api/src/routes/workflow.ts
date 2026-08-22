import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  oneWayAnova, linearStability, consensus, combineBudget,
  shelfLifeMonthsBetween, expandedUncertainty, type UncertaintyComponent,
} from '@lotmark/stats';
import {
  ALL_SIGNATURE_MEANINGS, isSignatureMeaning, defaultSodSettings,
  type SignatureMeaning, type CompetenceBasis, type AuthScope,
} from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { tenantSod } from '../services/sod';
import { applySignature, verifyStoredSignature, SigningError } from '../services/signing';
import { loadLiveSession, hashToken, SESSION_COOKIE } from '../services/sessions';
import { conflict, forbidden, invalidRequest, notFound, sendProblem, stepUpRequired, unprocessable } from '../http/problem';

const signBody = z.object({
  meaning: z.string().refine(isSignatureMeaning, {
    message: `meaning must be one of: ${ALL_SIGNATURE_MEANINGS.join(', ')}`,
  }),
  reason: z.string().max(1000).optional(),
});

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys } = app;

  /**
   * Look up a competence record valid on the acting date.
   * Returns the BASIS, which is frozen onto the signature.
   */
  async function competenceBasis(
    tx: Sql, tenantId: string, userId: string, activity: string, onDate: string,
  ): Promise<CompetenceBasis | null> {
    const [row] = await tx`
      SELECT id, activity, valid_from, valid_to
      FROM lotmark.competence_records
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND activity = ${activity}
        AND superseded_at IS NULL
        AND valid_from <= ${onDate} AND valid_to >= ${onDate}
      LIMIT 1`;
    const c = row as { id: string; activity: string; valid_from: string; valid_to: string } | undefined;
    if (!c) return null;
    return {
      competenceRecordId: c.id, activity: c.activity,
      validFrom: c.valid_from, validTo: c.valid_to,
      checkedOn: onDate, personUserId: userId,
    };
  }

  /**
   * SIGN A STUDY.
   *
   * The act the whole trust spine exists for. In order:
   *   1. the guard decides — permission, scope, segregation, competence;
   *   2. the uncertainty is COMPUTED from raw measurements, never accepted
   *      from the request;
   *   3. the signature is applied over the computed value, so the signer
   *      commits to the number the data actually supports;
   *   4. the state moves, the transition is recorded, the ledger is appended.
   *
   * All of it in ONE transaction. A signature that survives a failed state
   * change, or a state change with no signature, would each be worse than the
   * whole thing failing.
   */
  app.post<{ Params: { id: string } }>('/studies/:id/sign', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = signBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid request.'));
    }
    const meaning = parsed.data.meaning as SignatureMeaning;

    const token = req.cookies[SESSION_COOKIE]!;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [studyRow] = await tx`
        SELECT s.*, p.code AS project_code
        FROM lotmark.studies s
        JOIN lotmark.projects p ON p.id = s.project_id
        WHERE s.tenant_id = ${ctx.tenantId} AND s.id = ${req.params.id}
        FOR UPDATE OF s`;
      const study = studyRow as {
        id: string; code: string; project_id: string; project_code: string;
        study_type: string; state: string; owner_team_id: string | null;
        shelf_life_to: string | null; signed_on: string | null;
      } | undefined;
      if (!study) return { status: 404 as const };

      if (study.state !== 'draft') {
        return { status: 409 as const, message: `Study ${study.code} is already ${study.state}.` };
      }

      const scope: AuthScope = study.owner_team_id
        ? { kind: 'team', teamId: study.owner_team_id }
        : { kind: 'tenant' };
      const sod = await tenantSod(tx, ctx.tenantId, (m) => app.log.warn(m));

      const basis = await competenceBasis(tx, ctx.tenantId, ctx.userId, 'study:sign', ctx.today);

      const verdict = decide({
        authority: ctx.authority,
        permission: 'study:sign',
        scope,
        record: study as unknown as Record<string, unknown>,
        sodSettings: sod.settings, sodThresholds: sod.thresholds,
        onDate: ctx.today,
        requiresCompetence: 'study:sign',
        competenceFor: () => basis,
        requiresSignature: true,
      });

      if (!verdict.allowed) {
        // A refusal is evidence a control worked. Recorded, then returned.
        await recordAudit(tx, auditCtxOf(ctx), {
          kind: 'DENY', action: 'Study signing refused',
          detail: `${study.code}: ${verdict.message}`,
          subjectTable: 'studies', subjectId: study.id,
          changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      // ── The uncertainty is computed here, from the raw data ──────────────
      const raw = await tx`
        SELECT unit_ref, replicate, elapsed_months, laboratory_ref, measured_value
        FROM lotmark.study_results WHERE study_id = ${study.id}`;
      if (raw.length === 0) {
        return { status: 422 as const, message: 'This study has no recorded measurements to sign.' };
      }
      const rows = raw.map((r) => r as {
        unit_ref: number | null; replicate: number | null;
        elapsed_months: number | null; laboratory_ref: string | null; measured_value: number;
      });

      let uncertainty: number;
      let basisText: string;
      try {
        if (study.study_type === 'homogeneity') {
          const a = oneWayAnova(rows.map((r) => ({ unit: r.unit_ref!, replicate: r.replicate!, value: r.measured_value })));
          uncertainty = a.uBb;
          basisText = `${a.units} units × ${a.replicatesPerUnit} replicates` + (a.floored ? ', floored at the detection limit' : '');
        } else if (study.study_type === 'stability') {
          if (!study.shelf_life_to) {
            return { status: 422 as const, message: 'A stability study needs a shelf life before it can be signed.' };
          }
          const months = shelfLifeMonthsBetween(ctx.today, study.shelf_life_to);
          const r = linearStability(rows.map((x) => ({ months: x.elapsed_months!, value: x.measured_value })), months);
          uncertainty = r.uLts;
          basisText = `${r.n} timepoints over ${months} months, slope ${r.slope.toFixed(5)}/month`;
        } else {
          const c = consensus(rows.map((x) => ({ laboratory: x.laboratory_ref!, value: x.measured_value })));
          uncertainty = c.uChar;
          basisText = `${c.laboratories} laboratories, s = ${c.standardDeviation.toFixed(4)}`;
        }
      } catch (e) {
        // A statistical refusal is a data problem the scientist must fix, not a
        // server fault. Report it in their language.
        return { status: 422 as const, message: (e as Error).message };
      }

      const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return { status: 401 as const, message: 'Your session has ended.' };

      const key = await keys.active(tx, ctx.tenantId, (m) => app.log.info(m));

      let signature;
      try {
        signature = await applySignature(tx, {
          tenantId: ctx.tenantId,
          signable: {
            kind: 'study',
            record: {
              id: study.code, projectId: study.project_code, type: study.study_type,
              equipmentIds: await equipmentCodes(tx, study.id),
              uncertainty,
            },
          },
          subjectId: study.id,
          signerUserId: ctx.userId,
          meaning,
          session,
          signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
          competenceBasis: verdict.competenceBasis,
          requiresCompetence: true,
          key,
          timeSource: ctx.timeSource,
          region: ctx.region,
        });
      } catch (e) {
        if (e instanceof SigningError) {
          await recordAudit(tx, auditCtxOf(ctx), {
            kind: 'SECURITY', action: 'Study signing refused at the signing step',
            detail: `${study.code}: ${e.message}`,
            subjectTable: 'studies', subjectId: study.id,
          });
          return { status: e.code === 'step_up_required' ? 401 as const : 409 as const, message: e.message };
        }
        throw e;
      }

      await tx`
        UPDATE lotmark.studies
        SET state = 'signed', uncertainty = ${uncertainty},
            signed_by_user_id = ${ctx.userId}, signed_on = ${ctx.today},
            version = version + 1
        WHERE id = ${study.id}`;

      await tx`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason, signature_id)
        VALUES (${ctx.tenantId}, 'study', ${study.id}, 'draft', 'signed',
                ${ctx.userId}, ${parsed.data.reason ?? null}, ${signature.id})`;

      await recordAudit(tx, auditCtxOf(ctx), {
        kind: 'SIGNATURE',
        action: 'Study signed',
        detail: `${study.code} · ${meaning} · u = ${uncertainty.toPrecision(6)} (${basisText}) · key ${key.keyVersion}`,
        subjectTable: 'studies', subjectId: study.id,
        changes: { state: { from: 'draft', to: 'signed' }, uncertainty, signatureId: signature.id },
      });

      return {
        status: 200 as const,
        body: {
          study: { id: study.id, code: study.code, state: 'signed' },
          uncertainty, basis: basisText,
          signature: {
            id: signature.id, meaning: signature.meaning, signedAt: signature.signedAt,
            keyVersion: signature.keyVersion, custody: key.custody,
            bindingHash: signature.bindingHash,
          },
          competence: verdict.competenceBasis,
        },
      };
    });

    switch (result.status) {
      case 404: return sendProblem(reply, notFound('No such study.'));
      case 403: return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
      case 409: return sendProblem(reply, conflict(result.message));
      case 422: return sendProblem(reply, unprocessable(result.message));
      case 401: return sendProblem(reply, stepUpRequired(result.message));
      default: return reply.send(result.body);
    }
  });

  /** Verify a study's signature against the record as it stands now. */
  app.get<{ Params: { id: string } }>('/studies/:id/signature', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const out = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [row] = await tx`
        SELECT s.*, p.code AS project_code FROM lotmark.studies s
        JOIN lotmark.projects p ON p.id = s.project_id
        WHERE s.tenant_id = ${ctx.tenantId} AND s.id = ${req.params.id}`;
      const study = row as {
        id: string; code: string; project_code: string; study_type: string;
        uncertainty: number | null; owner_team_id: string | null;
      } | undefined;
      if (!study) return null;

      const verdict = decide({
        authority: ctx.authority, permission: 'project:read',
        scope: study.owner_team_id ? { kind: 'team', teamId: study.owner_team_id } : { kind: 'tenant' },
        sodSettings: {}, onDate: ctx.today,
      });
      if (!verdict.allowed) return { forbidden: verdict };

      return verifyStoredSignature(tx, keys, {
        tenantId: ctx.tenantId,
        signable: {
          kind: 'study',
          record: {
            id: study.code, projectId: study.project_code, type: study.study_type,
            equipmentIds: await equipmentCodes(tx, study.id),
            uncertainty: study.uncertainty ?? 0,
          },
        },
        subjectId: study.id,
      });
    });

    if (!out) return sendProblem(reply, notFound('No such study.'));
    if ('forbidden' in out) return sendProblem(reply, forbidden(out.forbidden.reason, out.forbidden.message));

    /**
     * The verdict IS the response, at 200, whatever it says.
     *
     * Including `unverifiable`. That is not a fault of this request and not
     * something to retry — it is a durable fact about the stored row that the
     * operator needs put in front of them, so a 5xx would be both wrong and
     * unhelpful.
     *
     * `status` is the field that carries the meaning; `ok` only distinguishes
     * `valid` from everything else, and a consumer that renders `reason` as a
     * tamper alert whenever `ok` is false is wrong for three of the four
     * statuses. That was exactly the defect: an unrecognised algorithm arrived
     * here as "the record was altered after it was signed".
     */
    return reply.send(out);
  });

  async function equipmentCodes(tx: Sql, studyId: string): Promise<string[]> {
    const rows = await tx`
      SELECT e.code FROM lotmark.study_equipment se
      JOIN lotmark.equipment e ON e.id = se.equipment_id
      WHERE se.study_id = ${studyId} ORDER BY e.code`;
    return rows.map((r) => (r as { code: string }).code);
  }
}

function auditCtxOf(ctx: RequestContext) {
  return {
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  };
}

