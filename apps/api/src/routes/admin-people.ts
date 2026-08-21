import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, generateSecret, enrolmentUri } from '@lotmark/security';
import { COMPETENCE_GATED } from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { activeVersion, entriesOf } from '../services/config-admin';
import {
  sendProblem, notFound, conflict, unprocessable, invalidRequest, forbidden,
} from '../http/problem';

/**
 * People: users, the roles they hold, the teams they work in, and what they are
 * competent to do.
 *
 * ── Two things that are not the same ────────────────────────────────────────
 *
 * TEAM MEMBERSHIP is belonging; ROLE ASSIGNMENT is authority. A person can be
 * in a team without holding anything in it, and can hold a role across the
 * tenant without being in any team. The schema has always kept them apart and
 * this API does too — collapsing them is how somebody gets authority by being
 * added to a group.
 *
 * ── Roles come from the ACTIVE configuration ────────────────────────────────
 *
 * Not from `roles.ts`. A role that exists in code but not in the tenant's
 * published configuration cannot be assigned, because sign-in resolves
 * authority from the configuration and would silently ignore the assignment.
 */

const userBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  code: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/,
    'A code is lowercase letters, digits and hyphens.'),
  organisationId: z.string().uuid(),
});

const assignmentBody = z.object({
  roleKey: z.string().min(1).max(60),
  /** null = tenant-wide. */
  teamId: z.string().uuid().nullable(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  reason: z.string().min(1, 'Say why this person is being given this role.').max(500),
});

const teamBody = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});

const competenceBody = z.object({
  userId: z.string().uuid(),
  activity: z.string().refine((a) => (COMPETENCE_GATED as readonly string[]).includes(a),
    `Competence records cover ${COMPETENCE_GATED.join(', ')}.`),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basis: z.string().min(1, 'Record the evidence: training, assessment, witnessed demonstration.').max(500),
});

export async function registerAdminPeopleRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  const auditOf = (ctx: RequestContext) => ({
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  });

  const tx = <T>(ctx: RequestContext, fn: (t: Sql) => Promise<T>): Promise<T> =>
    inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, fn);

  async function requireAdmin(
    req: FastifyRequest, reply: FastifyReply,
  ): Promise<RequestContext | null> {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return null;
    const verdict = decide({
      authority: ctx.authority, permission: 'user:manage',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) {
      await sendProblem(reply, forbidden(verdict.reason, verdict.message));
      return null;
    }
    return ctx;
  }

  /** Role keys the ACTIVE configuration defines, with their kind. */
  async function assignableRoles(t: Sql, tenantId: string) {
    const active = await activeVersion(t, tenantId);
    if (!active) return [];
    const entries = await entriesOf(t, active.id);
    return entries
      .filter((e) => e.kind === 'role')
      .map((e) => {
        const p = e.payload as { name?: string; kind?: string; permissions?: string[] };
        return {
          key: e.key,
          name: p.name ?? e.key,
          kind: p.kind ?? 'producer',
          permissions: p.permissions ?? [],
        };
      });
  }

  /* ── The directory ────────────────────────────────────────────────────── */

  app.get('/admin/people', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const body = await tx(ctx, async (t) => {
      const users = await t`
        SELECT u.id, u.code, u.email, u.display_name, u.deactivated_at,
               u.mfa_enrolled_at IS NOT NULL AS mfa_enrolled,
               o.id AS organisation_id, o.name AS organisation_name, o.kind AS organisation_kind
        FROM lotmark.users u
        JOIN lotmark.organisations o ON o.id = u.organisation_id
        WHERE u.tenant_id = ${ctx.tenantId}
        ORDER BY u.deactivated_at NULLS FIRST, u.display_name`;

      const assignments = await t`
        SELECT ra.id, ra.user_id, ra.role_key, ra.team_id, ra.valid_from, ra.valid_to,
               ra.granted_reason, tm.name AS team_name
        FROM lotmark.role_assignments ra
        LEFT JOIN lotmark.teams tm ON tm.id = ra.team_id
        WHERE ra.tenant_id = ${ctx.tenantId} AND ra.revoked_at IS NULL`;

      const teams = await t`
        SELECT tm.id, tm.key, tm.name, tm.description, tm.archived_at,
               (SELECT count(*)::int FROM lotmark.team_memberships m
                 WHERE m.team_id = tm.id AND m.left_on IS NULL) AS members
        FROM lotmark.teams tm WHERE tm.tenant_id = ${ctx.tenantId}
        ORDER BY tm.archived_at NULLS FIRST, tm.name`;

      const memberships = await t`
        SELECT m.id, m.team_id, m.user_id, m.joined_on
        FROM lotmark.team_memberships m
        WHERE m.tenant_id = ${ctx.tenantId} AND m.left_on IS NULL`;

      const organisations = await t`
        SELECT id, name, kind FROM lotmark.organisations
        WHERE tenant_id = ${ctx.tenantId} ORDER BY kind, name`;

      const competence = await t`
        SELECT c.id, c.user_id, c.activity, c.valid_from, c.valid_to, c.basis, c.code
        FROM lotmark.competence_records c
        WHERE c.tenant_id = ${ctx.tenantId} AND c.superseded_at IS NULL
        ORDER BY c.valid_from DESC`;

      return {
        users, assignments, teams, memberships, organisations, competence,
        roles: await assignableRoles(t, ctx.tenantId),
        competenceActivities: COMPETENCE_GATED,
      };
    });

    return reply.send(body);
  });

  /* ── Creating a user ──────────────────────────────────────────────────── */

  app.post('/admin/users', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = userBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid user.'));
    }

    /**
     * A random initial password and a fresh TOTP secret.
     *
     * Both are returned ONCE and never stored in readable form — the password
     * as an Argon2id hash, the secret for enrolment. They are deliberately kept
     * out of the audit ledger: it records that an account was created and by
     * whom, which is the auditable fact. The credential is not.
     *
     * The account is created owing a password change. Until it is paid, the
     * session may ask who it is, replace the password and sign out; every other
     * route refuses it. So the issued password is a one-time enrolment
     * credential rather than a standing one — 21 CFR 11 §11.300(b) and (d).
     *
     * The obligation is recorded on the row rather than inferred from the
     * absence of a change, so an account imported from elsewhere is not
     * mistaken for one that was provisioned here. See migration 0024.
     */
    const initialPassword = randomBytes(18).toString('base64url');
    const totpSecret = generateSecret();

    const result = await tx(ctx, async (t) => {
      const [clash] = await t`
        SELECT 1 FROM lotmark.users
        WHERE tenant_id = ${ctx.tenantId}
          AND (email = ${parsed.data.email} OR code = ${parsed.data.code}) LIMIT 1`;
      if (clash) return { status: 409 as const };

      const [org] = await t`
        SELECT id FROM lotmark.organisations
        WHERE tenant_id = ${ctx.tenantId} AND id = ${parsed.data.organisationId} LIMIT 1`;
      if (!org) return { status: 422 as const, message: 'No such organisation in this tenant.' };

      const [row] = await t`
        INSERT INTO lotmark.users
          (tenant_id, organisation_id, code, email, display_name, password_hash,
           totp_secret_encrypted, mfa_required, password_change_required)
        VALUES (${ctx.tenantId}, ${parsed.data.organisationId}, ${parsed.data.code},
                ${parsed.data.email}, ${parsed.data.displayName},
                ${await hashPassword(initialPassword)}, ${totpSecret}, true, true)
        RETURNING id`;
      const userId = (row as { id: string }).id;

      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'User account created',
        detail: `${parsed.data.displayName} <${parsed.data.email}> · holds no role yet`,
        subjectTable: 'users', subjectId: userId,
        // The credential is deliberately absent from this record.
        changes: { code: parsed.data.code, organisationId: parsed.data.organisationId },
      });

      return { status: 200 as const, userId };
    });

    if (result.status === 409) {
      return sendProblem(reply, conflict('That email address or code is already in use in this tenant.'));
    }
    if (result.status === 422) return sendProblem(reply, unprocessable(result.message));

    return reply.send({
      userId: result.userId,
      /** Shown once. Not recoverable, and not in the ledger. */
      initialPassword,
      enrolment: enrolmentUri({
        secret: totpSecret, accountEmail: parsed.data.email, issuer: 'Lotmark',
      }),
      note:
        'This password and authenticator secret are shown once and cannot be recovered. ' +
        'It is an enrolment credential: the account must replace it on first sign-in before ' +
        'it can do anything else. The account holds no role yet, so it will see nothing ' +
        'until one is granted.',
    });
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/deactivate', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    if (req.params.id === ctx.userId) {
      // Not paternalism: `user:manage` may be held by exactly one person, and
      // deactivating yourself would leave the tenant with nobody able to
      // administer it and no way back in.
      return sendProblem(reply, unprocessable(
        'You cannot deactivate your own account. Ask another administrator to do it.',
      ));
    }

    const out = await tx(ctx, async (t) => {
      const [user] = await t`
        SELECT id, display_name, deactivated_at FROM lotmark.users
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const found = user as { id: string; display_name: string; deactivated_at: string | null } | undefined;
      if (!found) return { status: 404 as const };
      if (found.deactivated_at) return { status: 409 as const };

      /**
       * Deactivation, never deletion. The user id is referenced by signatures
       * and ledger entries that must stay resolvable for the life of the
       * record — retention classes `electronic_signature` and
       * `competence_record`.
       */
      await t`
        UPDATE lotmark.users SET deactivated_at = now(), version = version + 1
        WHERE id = ${found.id}`;
      // Live sessions end immediately; a deactivated account that keeps working
      // until its cookie expires is not deactivated.
      await t`
        UPDATE lotmark.sessions SET revoked_at = now(), revoked_reason = 'account deactivated'
        WHERE user_id = ${found.id} AND revoked_at IS NULL`;
      await t`
        UPDATE lotmark.role_assignments
        SET revoked_at = now(), revoked_by = ${ctx.userId}
        WHERE user_id = ${found.id} AND revoked_at IS NULL`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'User account deactivated',
        detail: `${found.display_name} · sessions ended and role assignments revoked`,
        subjectTable: 'users', subjectId: found.id,
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such user.'));
    if (out.status === 409) return sendProblem(reply, conflict('That account is already deactivated.'));
    return reply.send({ ok: true });
  });

  /* ── Roles ────────────────────────────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/admin/users/:id/roles', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = assignmentBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid assignment.'));
    }

    const out = await tx(ctx, async (t) => {
      const [user] = await t`
        SELECT id, display_name FROM lotmark.users
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id}
          AND deactivated_at IS NULL LIMIT 1`;
      const found = user as { id: string; display_name: string } | undefined;
      if (!found) return { status: 404 as const };

      /**
       * The role must exist in the ACTIVE configuration.
       *
       * Assigning a role that only exists in code produces an assignment that
       * `resolveAuthority` cannot resolve — the person holds nothing and the
       * row looks perfectly valid.
       */
      const roles = await assignableRoles(t, ctx.tenantId);
      if (!roles.some((r) => r.key === parsed.data.roleKey)) {
        return {
          status: 422 as const,
          message:
            `'${parsed.data.roleKey}' is not a role in the active configuration. ` +
            `Available: ${roles.map((r) => r.key).join(', ')}.`,
        };
      }

      if (parsed.data.teamId) {
        const [team] = await t`
          SELECT id FROM lotmark.teams
          WHERE tenant_id = ${ctx.tenantId} AND id = ${parsed.data.teamId}
            AND archived_at IS NULL LIMIT 1`;
        if (!team) return { status: 422 as const, message: 'No such active team in this tenant.' };
      }

      const [row] = await t`
        INSERT INTO lotmark.role_assignments
          (tenant_id, user_id, role_key, team_id, valid_from, valid_to, granted_by, granted_reason)
        VALUES (${ctx.tenantId}, ${found.id}, ${parsed.data.roleKey}, ${parsed.data.teamId},
                ${parsed.data.validFrom}, ${parsed.data.validTo}, ${ctx.userId}, ${parsed.data.reason})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (!row) return { status: 409 as const };

      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'Role granted',
        detail:
          `${found.display_name} → ${parsed.data.roleKey}` +
          `${parsed.data.teamId ? ' (team-scoped)' : ' (tenant-wide)'}` +
          `${parsed.data.validTo ? ` until ${parsed.data.validTo}` : ''} · ${parsed.data.reason}`,
        subjectTable: 'role_assignments', subjectId: (row as { id: string }).id,
        changes: { userId: found.id, ...parsed.data },
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such active user.'));
    if (out.status === 422) return sendProblem(reply, unprocessable(out.message));
    if (out.status === 409) {
      return sendProblem(reply, conflict('That person already holds this role at this scope.'));
    }
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string; assignmentId: string } }>(
    '/admin/users/:id/roles/:assignmentId', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const out = await tx(ctx, async (t) => {
      const [row] = await t`
        SELECT ra.id, ra.role_key, u.display_name
        FROM lotmark.role_assignments ra JOIN lotmark.users u ON u.id = ra.user_id
        WHERE ra.tenant_id = ${ctx.tenantId} AND ra.id = ${req.params.assignmentId}
          AND ra.revoked_at IS NULL LIMIT 1`;
      const found = row as { id: string; role_key: string; display_name: string } | undefined;
      if (!found) return { status: 404 as const };

      // Revoked, not deleted: the assignment is the reason a past act was
      // authorised, and an as-of view has to be able to find it.
      await t`
        UPDATE lotmark.role_assignments
        SET revoked_at = now(), revoked_by = ${ctx.userId}
        WHERE id = ${found.id}`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'Role revoked',
        detail: `${found.display_name} no longer holds ${found.role_key}`,
        subjectTable: 'role_assignments', subjectId: found.id,
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such live role assignment.'));
    return reply.send({ ok: true });
  });

  /* ── Teams ────────────────────────────────────────────────────────────── */

  app.post('/admin/teams', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = teamBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid team.'));
    }

    const out = await tx(ctx, async (t) => {
      const [row] = await t`
        INSERT INTO lotmark.teams (tenant_id, key, name, description)
        VALUES (${ctx.tenantId}, ${parsed.data.key}, ${parsed.data.name},
                ${parsed.data.description ?? null})
        ON CONFLICT (tenant_id, key) DO NOTHING
        RETURNING id`;
      if (!row) return { status: 409 as const };

      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'Team created',
        detail: `${parsed.data.name} (${parsed.data.key})`,
        subjectTable: 'teams', subjectId: (row as { id: string }).id,
      });
      return { status: 200 as const, id: (row as { id: string }).id };
    });

    if (out.status === 409) return sendProblem(reply, conflict('A team with that key already exists.'));
    return reply.send({ id: out.id });
  });

  app.post<{ Params: { id: string } }>('/admin/teams/:id/members', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, invalidRequest('A user is required.'));

    const out = await tx(ctx, async (t) => {
      const [user] = await t`
        SELECT id, display_name FROM lotmark.users
        WHERE tenant_id = ${ctx.tenantId} AND id = ${parsed.data.userId}
          AND deactivated_at IS NULL LIMIT 1`;
      const found = user as { id: string; display_name: string } | undefined;
      if (!found) return { status: 404 as const };

      const [team] = await t`
        SELECT id, name FROM lotmark.teams
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id}
          AND archived_at IS NULL LIMIT 1`;
      const t2 = team as { id: string; name: string } | undefined;
      if (!t2) return { status: 404 as const };

      const [existing] = await t`
        SELECT id FROM lotmark.team_memberships
        WHERE team_id = ${t2.id} AND user_id = ${found.id} AND left_on IS NULL LIMIT 1`;
      if (existing) return { status: 409 as const };

      await t`
        INSERT INTO lotmark.team_memberships (tenant_id, team_id, user_id, joined_on)
        VALUES (${ctx.tenantId}, ${t2.id}, ${found.id}, ${ctx.today})`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'Team membership added',
        detail:
          `${found.display_name} joined ${t2.name}. ` +
          'Membership is belonging, not authority — it grants nothing on its own.',
        subjectTable: 'team_memberships', subjectId: t2.id,
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such active user or team.'));
    if (out.status === 409) return sendProblem(reply, conflict('They are already in that team.'));
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/admin/teams/:id/members/:userId', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const out = await tx(ctx, async (t) => {
      const [row] = await t`
        UPDATE lotmark.team_memberships SET left_on = ${ctx.today}
        WHERE tenant_id = ${ctx.tenantId} AND team_id = ${req.params.id}
          AND user_id = ${req.params.userId} AND left_on IS NULL
        RETURNING id`;
      if (!row) return { status: 404 as const };
      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'Team membership ended',
        detail: 'Any role held only within that team no longer applies.',
        subjectTable: 'team_memberships', subjectId: req.params.id,
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such live membership.'));
    return reply.send({ ok: true });
  });

  /* ── Competence — ISO 17034 6.3 ───────────────────────────────────────── */

  app.post('/admin/competence', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = competenceBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid record.'));
    }
    if (parsed.data.validFrom > parsed.data.validTo) {
      return sendProblem(reply, invalidRequest('The validity window ends before it begins.'));
    }

    const out = await tx(ctx, async (t) => {
      const [user] = await t`
        SELECT id, display_name FROM lotmark.users
        WHERE tenant_id = ${ctx.tenantId} AND id = ${parsed.data.userId}
          AND deactivated_at IS NULL LIMIT 1`;
      const found = user as { id: string; display_name: string } | undefined;
      if (!found) return { status: 404 as const };

      const [seq] = await t`
        SELECT count(*)::int + 1 AS n FROM lotmark.competence_records
        WHERE tenant_id = ${ctx.tenantId}`;
      const code = `CMP-${String((seq as { n: number }).n).padStart(4, '0')}`;

      try {
        const [row] = await t`
          INSERT INTO lotmark.competence_records
            (tenant_id, code, user_id, activity, valid_from, valid_to, basis, granted_by_user_id)
          VALUES (${ctx.tenantId}, ${code}, ${found.id}, ${parsed.data.activity},
                  ${parsed.data.validFrom}, ${parsed.data.validTo}, ${parsed.data.basis}, ${ctx.userId})
          RETURNING id`;
        await recordAudit(t, auditOf(ctx), {
          kind: 'CONFIGURATION', action: 'Competence authorisation granted',
          detail:
            `${found.display_name} authorised for ${parsed.data.activity}, ` +
            `${parsed.data.validFrom} to ${parsed.data.validTo} · ${parsed.data.basis}`,
          subjectTable: 'competence_records', subjectId: (row as { id: string }).id,
        });
        return { status: 200 as const };
      } catch (e) {
        // The no-overlap constraint. Two live windows for the same activity
        // would make "was this person authorised on the day" ambiguous, which
        // is the one question the record exists to answer.
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('competence_no_overlap')) {
          return {
            status: 409 as const,
            message:
              'That window overlaps an existing authorisation for the same activity. ' +
              'Supersede the existing record instead — two live windows make ' +
              '"were they authorised on the day" ambiguous.',
          };
        }
        throw e;
      }
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such active user.'));
    if (out.status === 409) return sendProblem(reply, conflict(out.message));
    return reply.send({ ok: true });
  });
}
