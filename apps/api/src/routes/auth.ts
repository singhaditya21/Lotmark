import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenantTransaction } from '../db';
import { signIn, verifySecondFactor, MAX_MFA_ATTEMPTS } from '../services/auth';
import {
  SESSION_COOKIE, hashToken, loadLiveSession, revokeSession, touchSession,
} from '../services/sessions';
import { recordAudit } from '../services/audit';
import { requireSession } from '../plugins/session';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

const mfaBody = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the six digits from your authenticator.'),
  attempt: z.number().int().min(1).max(MAX_MFA_ATTEMPTS).default(1),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  /**
   * The tenant is resolved from the host in production. On localhost there is
   * one demonstration tenant, so it is looked up by slug.
   */
  async function currentTenant(): Promise<{ id: string; timeSource: string; region: string }> {
    const [row] = await db`SELECT id, time_source, region FROM lotmark.tenants ORDER BY created_at LIMIT 1`;
    const t = row as { id: string; time_source: string; region: string } | undefined;
    if (!t) throw new Error('No tenant is provisioned. Run: pnpm db:seed');
    return { id: t.id, timeSource: t.time_source, region: t.region };
  }

  app.post('/sign-in', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(problem('invalid_request', 'Email and password are required.'));

    const tenant = await currentTenant();
    const result = await inTenantTransaction(db, { tenantId: tenant.id, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      signIn(tx, {
        tenantId: tenant.id,
        email: parsed.data.email,
        password: parsed.data.password,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        sessionTtlMinutes: cfg.SESSION_TTL_MINUTES,
        timeSource: tenant.timeSource,
        region: tenant.region,
      }));

    if (result.outcome === 'rejected') {
      return reply.code(401).send(problem('authentication_failed', result.message));
    }

    reply.setCookie(SESSION_COOKIE, result.sessionToken, {
      maxAge: cfg.SESSION_TTL_MINUTES * 60,
    });
    return reply.send({
      outcome: result.outcome,
      // The client learns only whether a second factor is needed. It is never
      // told which accounts have MFA enrolled, for anyone but itself.
      secondFactorRequired: result.outcome === 'mfa_required',
    });
  });

  app.post('/second-factor', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = mfaBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(problem('invalid_request', parsed.error.issues[0]?.message ?? 'Invalid code.'));
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send(problem('no_session', 'Sign in again.'));

    const tenant = await currentTenant();
    const result = await inTenantTransaction(db, { tenantId: tenant.id, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return { outcome: 'rejected' as const, message: 'Sign in again.', sessionRevoked: true };
      return verifySecondFactor(tx, {
        sessionId: session.id,
        userId: session.user_id,
        tenantId: tenant.id,
        token: parsed.data.code,
        attemptNumber: parsed.data.attempt,
        timeSource: tenant.timeSource,
        region: tenant.region,
      });
    });

    if (result.outcome === 'rejected') {
      if (result.sessionRevoked) reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(401).send(problem('second_factor_failed', result.message));
    }
    return reply.send({ outcome: 'signed_in' });
  });

  app.post('/sign-out', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const tenant = await currentTenant();
      await inTenantTransaction(db, { tenantId: tenant.id, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
        const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
        if (!session) return;
        await revokeSession(tx, session.id, 'user action');
        await recordAudit(tx, {
          tenantId: tenant.id, actorUserId: session.user_id, actorLabel: 'user',
          actorRoleId: '—', sessionId: session.id,
          timeSource: tenant.timeSource, region: tenant.region,
        }, { kind: 'AUTH', action: 'Signed out', detail: 'user action' });
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ outcome: 'signed_out' });
  });

  /** Who am I, and what may I do — the console's bootstrap call. */
  app.get('/me', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return; // requireSession has already replied

    await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx) => touchSession(tx, ctx.sessionId));

    return reply.send({
      user: { id: ctx.userId, name: ctx.displayName, email: ctx.email },
      teams: ctx.teams,
      // Permissions are sent so the console can hide what the user cannot do.
      // They are advisory: every act is re-checked server-side by the guard.
      permissions: [...ctx.authority.tenantWide],
      permissionsByTeam: Object.fromEntries(
        [...ctx.authority.byTeam].map(([team, perms]) => [team, [...perms]]),
      ),
      secondFactorSatisfied: ctx.mfaSatisfied,
    });
  });
}

/** RFC 9457 problem detail. */
function problem(code: string, detail: string) {
  return { type: `https://lotmark.local/problems/${code}`, title: code, detail };
}
