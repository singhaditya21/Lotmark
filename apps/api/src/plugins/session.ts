import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  resolveAuthority, resolveRoleKinds, roleConfigSchema,
  type ResolvedAuthority, type RoleConfig, type RoleAssignment, type RoleKind,
} from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { SESSION_COOKIE, hashToken, loadLiveSession } from '../services/sessions';
import {
  notAuthenticated, notProvisioned, passwordChangeRequired, secondFactorRequired,
  sendProblem, sessionExpired,
} from '../http/problem';

/**
 * The authenticated request context.
 *
 * Resolved ONCE per request. Recomputing authority mid-request would let a
 * single request see two different answers as configuration or assignments
 * change underneath it — which is how a half-applied permission change turns
 * into a half-authorised action.
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly authority: ResolvedAuthority;
  /**
   * Which half of the product this person belongs in — see resolveRoleKinds.
   * Advisory routing only; it authorises nothing.
   */
  readonly roleKinds: readonly RoleKind[];
  /**
   * The organisation the user belongs to. A DIFFERENT question from roleKinds:
   * this is the data boundary, that is the product boundary.
   */
  readonly organisation: { id: string; kind: string; name: string };
  readonly teams: ReadonlyArray<{ id: string; key: string; name: string }>;
  readonly mfaSatisfied: boolean;
  /**
   * The account still carries a password somebody else chose for it.
   *
   * Carried on the context rather than checked at each route, so the gate below
   * is the only place that decides — and so `/auth/me` can TELL the console,
   * which is what lets it show the change-password screen instead of a shell
   * full of controls that would all return 403.
   */
  readonly passwordChangeRequired: boolean;
  readonly timeSource: string;
  readonly region: string;
  readonly today: string;
}

/**
 * Load the session and resolve authority, or reply 401 and return null.
 *
 * Deliberately a function the route calls rather than a preHandler hook: a
 * route that forgets to call it has no context at all and cannot accidentally
 * act as somebody. A hook that silently does nothing on some paths fails open.
 */
export interface SessionOptions {
  /**
   * Let the request through even though the account owes a password change.
   *
   * Opt-IN, and named for what it permits rather than what it skips, because
   * the default has to be the safe one: a route added tomorrow that forgets
   * this option is gated, not exempt. Exactly three callers pass it — asking
   * who you are, changing the password, and signing out — and each says why.
   */
  readonly allowPasswordChangePending?: boolean;
}

export async function requireSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  options: SessionOptions = {},
): Promise<RequestContext | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) {
    await sendProblem(reply, notAuthenticated('Sign in to continue.'));
    return null;
  }

  // Same bootstrap path as sign-in: RLS blocks a direct read before the
  // request has a tenant context to be judged against.
  const [tenantRow] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  const tenant = tenantRow as { id: string; time_source: string; region: string } | undefined;
  if (!tenant) {
    await sendProblem(reply, notProvisioned('No tenant is provisioned.'));
    return null;
  }

  const ctx = await inTenantTransaction(
    app.db,
    { tenantId: tenant.id, auditKey: app.cfg.LOTMARK_AUDIT_KEY },
    async (tx): Promise<RequestContext | null> => {
      const session = await loadLiveSession(tx, hashToken(token), app.cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return null;

      const [userRow] = await tx`
        SELECT u.id, u.display_name, u.email, u.password_change_required,
               o.id AS organisation_id, o.kind AS organisation_kind, o.name AS organisation_name
        FROM lotmark.users u
        JOIN lotmark.organisations o ON o.id = u.organisation_id
        WHERE u.id = ${session.user_id} LIMIT 1`;
      const user = userRow as {
        id: string; display_name: string; email: string;
        password_change_required: boolean;
        organisation_id: string; organisation_kind: string; organisation_name: string;
      } | undefined;
      if (!user) return null;

      // Roles come from the ACTIVE configuration version, not from code.
      const roleRows = await tx`
        SELECT e.key, e.payload
        FROM lotmark.config_entries e
        JOIN lotmark.config_versions v ON v.id = e.version_id
        WHERE v.tenant_id = ${tenant.id} AND v.status = 'active' AND e.kind = 'role'`;
      /**
       * Stored configuration is VALIDATED on read, never trusted.
       *
       * The payload is JSONB written by a previous version of this code, by a
       * migration, or by an administrator through the configuration screens.
       * Casting it and hoping produces failures like "role.inherits is not
       * iterable" deep inside a resolver, which is where this check came from:
       * a seed wrote a JSON string instead of an object and nothing noticed
       * until authorisation itself fell over.
       *
       * Parsing also applies the schema's defaults, so a payload written before
       * a field existed still resolves.
       */
      const roles = new Map<string, RoleConfig>();
      for (const r of roleRows) {
        const row = r as { key: string; payload: unknown };
        const parsed = roleConfigSchema.safeParse(row.payload);
        if (!parsed.success) {
          app.log.error(
            { roleKey: row.key, issues: parsed.error.issues },
            'Stored role configuration is invalid and was ignored',
          );
          continue;
        }
        roles.set(row.key, parsed.data);
      }
      if (roles.size === 0) {
        // Every role being unreadable means the tenant has no usable
        // configuration. Failing closed is the only safe answer: proceeding
        // would authorise nothing, which looks identical to a permissions bug.
        throw new Error('No valid role configuration found for the active version.');
      }

      const assignmentRows = await tx`
        SELECT user_id, role_key, team_id, valid_from, valid_to
        FROM lotmark.role_assignments
        WHERE tenant_id = ${tenant.id} AND user_id = ${user.id} AND revoked_at IS NULL`;
      const assignments: RoleAssignment[] = assignmentRows.map((r) => {
        const row = r as { user_id: string; role_key: string; team_id: string | null; valid_from: string | null; valid_to: string | null };
        return {
          userId: row.user_id, roleKey: row.role_key, teamId: row.team_id,
          validFrom: row.valid_from, validTo: row.valid_to,
        };
      });

      const teamRows = await tx`
        SELECT t.id, t.key, t.name
        FROM lotmark.teams t
        JOIN lotmark.team_memberships m ON m.team_id = t.id
        WHERE m.user_id = ${user.id} AND m.left_on IS NULL AND t.archived_at IS NULL`;

      const today = new Date().toISOString().slice(0, 10);

      return {
        tenantId: tenant.id,
        sessionId: session.id,
        userId: user.id,
        displayName: user.display_name,
        email: user.email,
        authority: resolveAuthority({ userId: user.id, assignments, roles, asOf: today }),
        roleKinds: resolveRoleKinds({ userId: user.id, assignments, roles, asOf: today }),
        organisation: {
          id: user.organisation_id,
          kind: user.organisation_kind,
          name: user.organisation_name,
        },
        teams: teamRows.map((t) => t as { id: string; key: string; name: string }),
        mfaSatisfied: session.mfa_satisfied_at !== null,
        passwordChangeRequired: user.password_change_required,
        timeSource: tenant.time_source,
        region: tenant.region,
        today,
      };
    },
  );

  if (!ctx) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await sendProblem(reply, sessionExpired('Your session has ended. Sign in again.'));
    return null;
  }

  /**
   * A session that has passed the password but not the second factor exists,
   * but authorises nothing. Enforced here rather than per-route, so a new route
   * cannot forget it.
   */
  if (!ctx.mfaSatisfied) {
    await sendProblem(reply, secondFactorRequired('Complete the second factor to continue.'));
    return null;
  }

  /**
   * An account provisioned with a password somebody else chose may authenticate
   * and may replace that password. It may not yet act.
   *
   * AFTER the second-factor gate, not before, and the order is the control. If
   * the password alone let you reach the change screen, then whoever learned
   * the issued password — the administrator who generated it, anyone who saw
   * the channel it travelled through — could set a new one and take the account
   * before its owner ever signed in. Demanding the second factor first means
   * the person replacing the password is the person holding the authenticator.
   */
  if (ctx.passwordChangeRequired && options.allowPasswordChangePending !== true) {
    await sendProblem(reply, passwordChangeRequired(
      'This account is still using the password it was issued. Set your own password to continue.'));
    return null;
  }

  return ctx;
}

