import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CUSTOM_FIELD_PERMISSIONS, isCustomFieldEntity, isPermission, anyPermissions,
  type AuthScope, type Permission,
} from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import {
  activeDefinitions, renderableForm, currentRevision, revisionHistory, saveValues,
  parentRecord, type ParentRecord,
} from '../services/custom-fields';
import {
  sendProblem, forbidden, notFound, conflict, unprocessable, invalidRequest,
} from '../http/problem';

/**
 * Custom fields, on the records they belong to.
 *
 * ── There is no `customfield:write` permission ──────────────────────────────
 *
 * A custom field is part of its parent record, so the authority over it is the
 * authority over that record — `CUSTOM_FIELD_PERMISSIONS` maps each entity to
 * the permissions that already govern it. A new permission would be granted to
 * nobody in every tenant that already exists, because roles are stored
 * configuration; and it would let somebody who cannot edit a lot change what a
 * lot says, which is the same thing by another route.
 *
 * ── Reading the definitions is not reading the values ───────────────────────
 *
 * `GET /custom-fields/:entity` returns what the form LOOKS like and no data at
 * all, so it is gated on the entity's read permission. The value routes are
 * gated separately, and writing is gated on the write permission.
 */

const saveBody = z.object({
  values: z.record(z.string(), z.unknown()),
  /**
   * Which revision the client had in front of it. Required, not optional: a
   * missing one would have to default, and every sensible default silently
   * overwrites somebody. 0 means "there was no document".
   */
  basedOnRevision: z.number().int().min(0),
  reason: z.string().max(500).optional(),
});

export async function registerCustomFieldRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  const tx = <T>(ctx: RequestContext, fn: (t: Sql) => Promise<T>): Promise<T> =>
    inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      organisationKind: 'producer',
    }, fn);

  /**
   * The permission governing this entity, or null having already replied.
   */
  function permissionFor(
    reply: FastifyReply, entity: string, verb: 'read' | 'write',
  ): Permission | null {
    if (!isCustomFieldEntity(entity)) {
      void sendProblem(reply, notFound(
        `'${entity}' is not a record type that can carry custom fields.`));
      return null;
    }
    const permission = CUSTOM_FIELD_PERMISSIONS[entity][verb];
    // A domain test asserts every mapped permission is one the system enforces.
    // This is the runtime half of that, and it fails closed.
    if (!isPermission(permission)) {
      void sendProblem(reply, forbidden('misconfigured',
        `The permission governing ${entity} is not one this system enforces.`));
      return null;
    }
    return permission;
  }

  /**
   * Reading the SHAPE of a form, which carries no data.
   *
   * Asked as "do you hold this anywhere" rather than "do you hold it
   * tenant-wide", because holding it on one team is enough to be shown what the
   * form looks like — and every scientist in this product holds `project:read`
   * on a team and nowhere else. There is no record to scope against here, and
   * inventing a tenant-wide question would refuse everybody who is not an
   * administrator.
   */
  async function allowShape(
    req: FastifyRequest, reply: FastifyReply, entity: string,
  ): Promise<RequestContext | null> {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return null;
    const permission = permissionFor(reply, entity, 'read');
    if (!permission) return null;

    if (!anyPermissions(ctx.authority).has(permission)) {
      await sendProblem(reply, forbidden('permission_denied',
        `You do not hold '${permission}' anywhere.`));
      return null;
    }
    return ctx;
  }

  /**
   * A session, a real record, and the authority over THAT record.
   *
   * The scope comes from the record — `projects.owner_team_id`, reached
   * directly or through the project. Asking the tenant-wide question instead
   * refuses the production lead on his own team's lots, which is what the first
   * version of these routes did and what the certificate-holders endpoint did
   * before it. It is the same mistake twice, so it is worth naming: authority
   * here is scoped, and the scope is a property of the record, never a default.
   */
  async function allowOnRecord(
    req: FastifyRequest, reply: FastifyReply,
    entity: string, recordId: string, verb: 'read' | 'write',
  ): Promise<{ ctx: RequestContext; parent: ParentRecord } | null> {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return null;
    const permission = permissionFor(reply, entity, verb);
    if (!permission || !isCustomFieldEntity(entity)) return null;

    const parent = await tx(ctx, (t) => parentRecord(t, ctx.tenantId, entity, recordId));
    if (!parent) {
      await sendProblem(reply, notFound('No such record in this tenant.'));
      return null;
    }

    const scope: AuthScope = parent.ownerTeamId
      ? { kind: 'team', teamId: parent.ownerTeamId }
      : { kind: 'tenant' };

    const verdict = decide({
      authority: ctx.authority, permission, scope, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) {
      await sendProblem(reply, forbidden(verdict.reason, verdict.message));
      return null;
    }
    return { ctx, parent };
  }

  /** What a form for this entity looks like, with no data in it. */
  app.get<{ Params: { entity: string } }>('/custom-fields/:entity', async (req, reply) => {
    const ctx = await allowShape(req, reply, req.params.entity);
    if (!ctx) return;

    const form = await tx(ctx, async (t) => {
      const defs = await activeDefinitions(t, ctx.tenantId, (m) => app.log.warn(m));
      return defs ? renderableForm(defs, req.params.entity, ctx.roleKeys) : null;
    });

    if (!form) return sendProblem(reply, unprocessable('This tenant has no active configuration.'));
    return reply.send({ form });
  });

  /** The form and what this record currently holds. */
  app.get<{ Params: { entity: string; recordId: string } }>(
    '/custom-fields/:entity/:recordId', async (req, reply) => {
      const allowed = await allowOnRecord(
        req, reply, req.params.entity, req.params.recordId, 'read');
      if (!allowed) return;
      const { ctx, parent } = allowed;

      const out = await tx(ctx, async (t) => {
        const defs = await activeDefinitions(t, ctx.tenantId, (m) => app.log.warn(m));
        if (!defs) return null;
        return {
          form: renderableForm(defs, req.params.entity, ctx.roleKeys),
          current: await currentRevision(t, req.params.entity, req.params.recordId),
        };
      });

      if (!out) return sendProblem(reply, unprocessable('This tenant has no active configuration.'));
      return reply.send({
        form: out.form,
        values: out.current?.values ?? {},
        /** 0 when nothing has been recorded yet — what a save must be based on. */
        revision: out.current?.revision ?? 0,
        recordedBy: out.current?.recordedByName ?? null,
        recordedAt: out.current?.recordedAt ?? null,
        /**
         * Told, not inferred. The console renders the form read-only rather
         * than letting somebody fill it in and be refused on submit — the
         * server refuses either way, this is so the refusal is not a surprise.
         */
        frozen: parent.frozen,
        parentState: parent.state,
      });
    });

  /** Every revision, so a change can be explained rather than merely noticed. */
  app.get<{ Params: { entity: string; recordId: string } }>(
    '/custom-fields/:entity/:recordId/history', async (req, reply) => {
      const allowed = await allowOnRecord(
        req, reply, req.params.entity, req.params.recordId, 'read');
      if (!allowed) return;
      const { ctx } = allowed;
      const revisions = await tx(ctx, (t) =>
        revisionHistory(t, req.params.entity, req.params.recordId));
      return reply.send({ revisions });
    });

  app.put<{ Params: { entity: string; recordId: string } }>(
    '/custom-fields/:entity/:recordId', async (req, reply) => {
      const allowed = await allowOnRecord(
        req, reply, req.params.entity, req.params.recordId, 'write');
      if (!allowed) return;
      const { ctx } = allowed;

      const parsed = saveBody.safeParse(req.body);
      if (!parsed.success) {
        return sendProblem(reply, invalidRequest(
          parsed.error.issues[0]?.message ?? 'Values and the revision they are based on are required.'));
      }

      const result = await tx(ctx, async (t) => {
        const out = await saveValues(t, {
          tenantId: ctx.tenantId,
          entity: req.params.entity,
          recordId: req.params.recordId,
          submitted: parsed.data.values,
          basedOnRevision: parsed.data.basedOnRevision,
          recordedBy: ctx.userId,
          reason: parsed.data.reason ?? null,
          roleKeys: ctx.roleKeys,
          onBadEntry: (m) => app.log.warn(m),
        });

        if (out.outcome === 'saved') {
          /**
           * Audited on the PARENT record, not on the values table.
           *
           * An assessor reads the ledger by subject, and "what happened to lot
           * X" has to include what its custom fields say. `changes` carries the
           * revision and the field keys touched, never the values: the ledger
           * says an act happened, and the append-only revision is where the
           * content lives.
           */
          await recordAudit(t, {
            tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
            actorRoleId: '—', sessionId: ctx.sessionId,
            timeSource: ctx.timeSource, region: ctx.region,
          }, {
            kind: 'WORKFLOW',
            action: 'Custom fields recorded',
            detail: `${req.params.entity} · revision ${out.revision}`
              + (parsed.data.reason ? ` · ${parsed.data.reason}` : ''),
            subjectTable: req.params.entity,
            subjectId: req.params.recordId,
            changes: {
              revision: out.revision,
              fields: Object.keys(parsed.data.values).sort(),
            },
          });
        }
        return out;
      });

      switch (result.outcome) {
        case 'saved':
          return reply.send({ revision: result.revision });
        case 'conflict':
          return sendProblem(reply, conflict(
            'Somebody else saved this record while you were editing it. Reload to see their ' +
            `changes — the current revision is ${result.currentRevision}.`));
        case 'no_such_record':
          return sendProblem(reply, notFound('No such record in this tenant.'));
        case 'not_configurable':
          return sendProblem(reply, notFound('That record type cannot carry custom fields.'));
        case 'frozen':
          return sendProblem(reply, conflict(
            `This ${req.params.entity} is ${result.state} and no longer accepts changes. ` +
            'Its custom fields are part of a record somebody has attested to.'));
        default:
          return sendProblem(reply, unprocessable(
            result.problems?.[0] ?? 'Those values were not accepted.'));
      }
    });
}
