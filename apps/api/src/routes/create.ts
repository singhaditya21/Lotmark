import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultSodSettings, type AuthScope } from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { nextCode } from '../services/numbering';
import {
  sendProblem, notFound, conflict, unprocessable, invalidRequest, forbidden, fieldErrors,
} from '../http/problem';

/**
 * Creating records.
 *
 * Until this file existed, every project, study and measurement in the system
 * originated in the seed script — the signing spine was real and there was no
 * way to put anything into it. These are the routes that make Lotmark a system
 * somebody can use rather than a demonstration of one.
 *
 * Everything here goes through the same guard as the signing acts: permission,
 * team scope, segregation of duties. Creating is not a lesser act — a project
 * created in the wrong team is invisible to the people who should see it, and a
 * measurement attributed to the wrong study is a data-integrity finding.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const projectBody = z.object({
  materialName: z.string().min(1).max(200),
  casNumber: z.string().max(40).optional(),
  sku: z.string().min(1).max(40).regex(/^[A-Z0-9-]+$/, 'Upper-case letters, digits and hyphens.'),
  intakeQuantity: z.string().max(40).optional(),
  targetUncertainty: z.string().max(40).optional(),
  teamId: z.string().uuid().optional(),
});

const studyBody = z.object({
  studyType: z.enum(['homogeneity', 'stability', 'characterisation', 'confirmatory retest']),
  equipmentIds: z.array(z.string().uuid()).min(1, 'A study must name the equipment it used.'),
  shelfLifeTo: isoDate.optional(),
  storageCondition: z.string().max(80).optional(),
  transportCondition: z.string().max(80).optional(),
});

/**
 * Measurement entry.
 *
 * The shape required depends on the study design, and the server checks it
 * rather than trusting the client: a homogeneity row with no unit reference
 * would silently become a one-unit ANOVA, which is the defect the database
 * CHECK constraints were added to make impossible.
 */
const resultsBody = z.object({
  measurements: z.array(z.object({
    unit: z.number().int().positive().optional(),
    replicate: z.number().int().positive().optional(),
    elapsedMonths: z.number().int().nonnegative().optional(),
    laboratory: z.string().min(1).max(40).optional(),
    value: z.number().finite(),
  })).min(1, 'Record at least one measurement.'),
  unit: z.string().max(20).default('% w/w'),
  replace: z.boolean().default(false),
});

const valueBody = z.object({
  propertyName: z.string().min(1).max(120),
  unit: z.string().min(1).max(20),
  coverageFactor: z.number().positive().max(10).default(2),
});

export async function registerCreateRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  const auditOf = (ctx: RequestContext) => ({
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  });

  /** The active configuration version, stamped onto everything created under it. */
  async function activeConfigVersion(tx: Sql, tenantId: string): Promise<string | null> {
    const [row] = await tx`
      SELECT id FROM lotmark.config_versions
      WHERE tenant_id = ${tenantId} AND status = 'active' LIMIT 1`;
    return (row as { id: string } | undefined)?.id ?? null;
  }

  /* ── Create a project ─────────────────────────────────────────────────── */

  app.post('/projects', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = projectBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        'The project could not be created.', fieldErrors(parsed.error.issues)));
    }
    const body = parsed.data;

    /**
     * The owning team must be one the caller can actually act in. Defaulting
     * to "their first team" would quietly put work somewhere they did not
     * choose, so a caller in more than one team must say which.
     */
    const teamId = body.teamId ?? (ctx.teams.length === 1 ? ctx.teams[0]!.id : null);
    if (!teamId) {
      return sendProblem(reply, unprocessable(
        ctx.teams.length === 0
          ? 'You are not a member of any team, so there is nowhere to file this project.'
          : 'You belong to more than one team. Name the one this project belongs to.'));
    }

    const scope: AuthScope = { kind: 'team', teamId };

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const verdict = decide({
        authority: ctx.authority, permission: 'project:manage', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditOf(ctx), {
          kind: 'DENY', action: 'Project creation refused',
          detail: verdict.message, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      const [teamRow] = await tx`SELECT id, name FROM lotmark.teams WHERE id = ${teamId}`;
      if (!teamRow) return { status: 404 as const, message: 'No such team.' };

      const code = await nextCode(tx, {
        tenantId: ctx.tenantId, entity: 'project',
        material: body.sku.split('-')[1] ?? body.sku, today: ctx.today,
      });
      const configVersionId = await activeConfigVersion(tx, ctx.tenantId);

      const [row] = await tx`
        INSERT INTO lotmark.projects
          (tenant_id, code, material_name, cas_number, sku, stage, owner_user_id,
           owner_team_id, intake_quantity, target_uncertainty)
        VALUES (${ctx.tenantId}, ${code}, ${body.materialName}, ${body.casNumber ?? null},
                ${body.sku}, 'design', ${ctx.userId}, ${teamId},
                ${body.intakeQuantity ?? null}, ${body.targetUncertainty ?? null})
        RETURNING id, code, stage, material_name, cas_number, sku`;
      const project = row as {
        id: string; code: string; stage: string;
        material_name: string; cas_number: string | null; sku: string;
      };

      await tx`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, config_version_id)
        VALUES (${ctx.tenantId}, 'project', ${project.id}, NULL, 'design',
                ${ctx.userId}, ${configVersionId})`;

      await recordAudit(tx, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Project created',
        detail: `${project.code} · ${body.materialName} · ${(teamRow as { name: string }).name}`,
        subjectTable: 'projects', subjectId: project.id,
        changes: { code: project.code, material: body.materialName, sku: body.sku },
      });

      // The console navigates straight to the detail view on success, so the
      // response must carry everything that view renders. Returning a partial
      // object showed "CAS — · no team" on a project that had both.
      return {
        status: 201 as const,
        body: {
          project: {
            id: project.id, code: project.code, stage: project.stage,
            material: project.material_name, cas: project.cas_number,
            sku: project.sku, team: (teamRow as { name: string }).name,
          },
        },
      };
    });

    if (result.status === 403) {
      return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
    }
    if (result.status === 404) return sendProblem(reply, notFound(result.message));
    return reply.code(201).send(result.body);
  });

  /* ── Create a study on a project ──────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/projects/:id/studies', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = studyBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        'The study could not be created.', fieldErrors(parsed.error.issues)));
    }
    const body = parsed.data;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [projectRow] = await tx`
        SELECT id, code, sku, owner_team_id, stage FROM lotmark.projects
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const project = projectRow as {
        id: string; code: string; sku: string; owner_team_id: string | null; stage: string;
      } | undefined;
      if (!project) return { status: 404 as const, message: 'No such project.' };

      const scope: AuthScope = project.owner_team_id
        ? { kind: 'team', teamId: project.owner_team_id } : { kind: 'tenant' };

      const verdict = decide({
        authority: ctx.authority, permission: 'study:run', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditOf(ctx), {
          kind: 'DENY', action: 'Study creation refused',
          detail: `${project.code}: ${verdict.message}`,
          subjectTable: 'projects', subjectId: project.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      // A stability study without a shelf life cannot produce u(lts); the
      // database refuses to let it be SIGNED, and refusing it here means the
      // scientist finds out now rather than after recording the measurements.
      if (body.studyType === 'stability' && !body.shelfLifeTo) {
        return { status: 422 as const, message: 'A stability study needs a shelf-life date.' };
      }

      const equipment = await tx`
        SELECT id, code FROM lotmark.equipment
        WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${body.equipmentIds})`;
      if (equipment.length !== body.equipmentIds.length) {
        return { status: 422 as const, message: 'One or more pieces of equipment do not exist.' };
      }

      const code = await nextCode(tx, { tenantId: ctx.tenantId, entity: 'study', today: ctx.today });
      const configVersionId = await activeConfigVersion(tx, ctx.tenantId);

      const [row] = await tx`
        INSERT INTO lotmark.studies
          (tenant_id, code, project_id, study_type, state, shelf_life_to,
           storage_condition, transport_condition, owner_team_id, config_version_id)
        VALUES (${ctx.tenantId}, ${code}, ${project.id}, ${body.studyType}, 'draft',
                ${body.shelfLifeTo ?? null}, ${body.storageCondition ?? null},
                ${body.transportCondition ?? null}, ${project.owner_team_id}, ${configVersionId})
        RETURNING id, code, study_type, state`;
      const study = row as { id: string; code: string; study_type: string; state: string };

      for (const e of equipment) {
        await tx`INSERT INTO lotmark.study_equipment (study_id, equipment_id)
                 VALUES (${study.id}, ${(e as { id: string }).id})`;
      }

      // A project acquires studies, so it is no longer merely designed.
      if (project.stage === 'design') {
        await tx`UPDATE lotmark.projects SET stage = 'study', version = version + 1 WHERE id = ${project.id}`;
        await tx`
          INSERT INTO lotmark.state_transitions
            (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason)
          VALUES (${ctx.tenantId}, 'project', ${project.id}, 'design', 'study',
                  ${ctx.userId}, ${'first study ' + study.code + ' created'})`;
      }

      await recordAudit(tx, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Study created',
        detail: `${study.code} · ${body.studyType} · ${project.code} · equipment ` +
          equipment.map((e) => (e as { code: string }).code).join(', '),
        subjectTable: 'studies', subjectId: study.id,
        changes: { code: study.code, type: body.studyType, project: project.code },
      });

      return { status: 201 as const, body: { study } };
    });

    if (result.status === 403) {
      return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
    }
    if (result.status === 404) return sendProblem(reply, notFound(result.message));
    if (result.status === 422) return sendProblem(reply, unprocessable(result.message));
    return reply.code(201).send(result.body);
  });

  /* ── Record measurements ──────────────────────────────────────────────── */

  app.put<{ Params: { id: string } }>('/studies/:id/results', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = resultsBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        'The measurements could not be recorded.', fieldErrors(parsed.error.issues)));
    }
    const body = parsed.data;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [studyRow] = await tx`
        SELECT id, code, study_type, state, owner_team_id FROM lotmark.studies
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} FOR UPDATE`;
      const study = studyRow as {
        id: string; code: string; study_type: string; state: string; owner_team_id: string | null;
      } | undefined;
      if (!study) return { status: 404 as const, message: 'No such study.' };

      // Signed is terminal. A measurement added afterwards would change the
      // data the signature was computed over without breaking the signature,
      // because the signature commits to the uncertainty, not to the row count.
      if (study.state !== 'draft') {
        return { status: 409 as const,
                 message: `Study ${study.code} is ${study.state}; its measurements are fixed.` };
      }

      const scope: AuthScope = study.owner_team_id
        ? { kind: 'team', teamId: study.owner_team_id } : { kind: 'tenant' };

      const verdict = decide({
        authority: ctx.authority, permission: 'study:run', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditOf(ctx), {
          kind: 'DENY', action: 'Measurement entry refused',
          detail: `${study.code}: ${verdict.message}`,
          subjectTable: 'studies', subjectId: study.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      // Shape must match the design. Checked here so the scientist gets a
      // sentence rather than a constraint violation.
      const wrong = body.measurements.findIndex((m) => {
        if (study.study_type === 'homogeneity') return m.unit == null || m.replicate == null;
        if (study.study_type === 'stability') return m.elapsedMonths == null;
        return m.laboratory == null;
      });
      if (wrong >= 0) {
        const needs = study.study_type === 'homogeneity'
          ? 'a unit number and a replicate number'
          : study.study_type === 'stability'
            ? 'the months elapsed'
            : 'a laboratory reference';
        return { status: 422 as const,
                 message: `Measurement ${wrong + 1} is missing ${needs}, which a ${study.study_type} study requires.` };
      }

      const existing = await tx`SELECT count(*)::int AS n FROM lotmark.study_results WHERE study_id = ${study.id}`;
      const had = (existing[0] as { n: number }).n;
      if (had > 0 && !body.replace) {
        return { status: 409 as const,
                 message: `${study.code} already has ${had} measurements. Send replace: true to overwrite them.` };
      }
      if (body.replace && had > 0) await tx`DELETE FROM lotmark.study_results WHERE study_id = ${study.id}`;

      for (const m of body.measurements) {
        await tx`
          INSERT INTO lotmark.study_results
            (tenant_id, study_id, unit_ref, replicate, elapsed_months, laboratory_ref,
             measured_value, measured_unit, recorded_by_user_id)
          VALUES (${ctx.tenantId}, ${study.id}, ${m.unit ?? null}, ${m.replicate ?? null},
                  ${m.elapsedMonths ?? null}, ${m.laboratory ?? null},
                  ${m.value}, ${body.unit}, ${ctx.userId})`;
      }

      await recordAudit(tx, auditOf(ctx), {
        kind: 'WORKFLOW',
        action: had > 0 ? 'Measurements replaced' : 'Measurements recorded',
        detail: `${study.code} · ${body.measurements.length} measurement(s)` +
          (had > 0 ? ` · ${had} previous discarded` : ''),
        subjectTable: 'studies', subjectId: study.id,
        changes: { count: body.measurements.length, replaced: had },
      });

      return { status: 200 as const, body: { study: study.code, recorded: body.measurements.length, replaced: had } };
    });

    if (result.status === 403) {
      return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
    }
    if (result.status === 404) return sendProblem(reply, notFound(result.message));
    if (result.status === 409) return sendProblem(reply, conflict(result.message));
    if (result.status === 422) return sendProblem(reply, unprocessable(result.message));
    return reply.send(result.body);
  });

  /* ── Create a draft property value ────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/projects/:id/values', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = valueBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        'The property value could not be created.', fieldErrors(parsed.error.issues)));
    }
    const body = parsed.data;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [projectRow] = await tx`
        SELECT id, code, owner_team_id FROM lotmark.projects
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const project = projectRow as { id: string; code: string; owner_team_id: string | null } | undefined;
      if (!project) return { status: 404 as const, message: 'No such project.' };

      const scope: AuthScope = project.owner_team_id
        ? { kind: 'team', teamId: project.owner_team_id } : { kind: 'tenant' };

      const verdict = decide({
        authority: ctx.authority, permission: 'value:assign', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
      });
      if (!verdict.allowed) return { status: 403 as const, verdict };

      const code = await nextCode(tx, { tenantId: ctx.tenantId, entity: 'property_value', today: ctx.today });
      const configVersionId = await activeConfigVersion(tx, ctx.tenantId);

      const [row] = await tx`
        INSERT INTO lotmark.property_values
          (tenant_id, code, project_id, property_name, unit, coverage_factor, state, config_version_id)
        VALUES (${ctx.tenantId}, ${code}, ${project.id}, ${body.propertyName}, ${body.unit},
                ${body.coverageFactor}, 'draft', ${configVersionId})
        RETURNING id, code, property_name, unit, coverage_factor, state`;

      await recordAudit(tx, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Property value created',
        detail: `${(row as { code: string }).code} · ${body.propertyName} · ${project.code}`,
        subjectTable: 'property_values', subjectId: (row as { id: string }).id,
      });

      return { status: 201 as const, body: { value: row } };
    });

    if (result.status === 403) {
      return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
    }
    if (result.status === 404) return sendProblem(reply, notFound(result.message));
    return reply.code(201).send(result.body);
  });

  /* ── Reference data the create forms need ─────────────────────────────── */

  app.get('/equipment', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;
    const rows = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      tx`SELECT e.id, e.code, e.name, e.equipment_type,
                (SELECT max(c.valid_to) FROM lotmark.calibrations c WHERE c.equipment_id = e.id) AS calibrated_to
         FROM lotmark.equipment e WHERE e.tenant_id = ${ctx.tenantId} ORDER BY e.code`);
    return reply.send({ equipment: rows });
  });

  app.get('/teams', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;
    // Only the teams the caller belongs to — the picker must not enumerate the
    // producer's organisational structure to somebody outside it.
    return reply.send({ teams: ctx.teams });
  });
}
