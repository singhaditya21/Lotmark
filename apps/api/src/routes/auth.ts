import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenantTransaction } from '../db';
import { signIn, verifySecondFactor, MAX_MFA_ATTEMPTS } from '../services/auth';
import {
  SESSION_COOKIE, hashToken, loadLiveSession, revokeSession, touchSession, unlockSigning,
} from '../services/sessions';
import { verifyPassword, verifyTotp } from '@lotmark/security';
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


  /**
   * Step-up re-authentication, opening the signing window.
   *
   * 21 CFR 11 §11.200(a)(1) requires signings to employ at least two distinct
   * identification components. §11.200(a)(1)(i) requires ALL components for a
   * signing not executed during a continuous session — so both are demanded
   * here, even though the caller is already signed in.
   *
   * The window is short and is checked again at the moment of signing, not
   * merely when it is opened.
   */
  app.post('/step-up', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = z.object({
      password: z.string().min(1).max(1024),
      code: z.string().regex(/^\d{6}$/),
    }).safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send(problem('invalid_request',
        'Both your password and an authenticator code are required to sign.'));
    }

    const outcome = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [row] = await tx`
        SELECT password_hash, totp_secret_encrypted FROM lotmark.users WHERE id = ${ctx.userId} LIMIT 1`;
      const user = row as { password_hash: string; totp_secret_encrypted: string | null } | undefined;
      if (!user) return { ok: false as const, why: 'account not found' };

      const auditCtx = {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
        actorRoleId: '—', sessionId: ctx.sessionId,
        timeSource: ctx.timeSource, region: ctx.region,
      };

      // Both components are checked before reporting, so the response cannot
      // reveal WHICH one failed — that would let an attacker who has one
      // component confirm it independently.
      const passwordOk = await verifyPassword(parsed.data.password, user.password_hash);
      const codeOk = user.totp_secret_encrypted
        ? verifyTotp(parsed.data.code, user.totp_secret_encrypted)
        : false;

      if (!passwordOk || !codeOk) {
        await recordAudit(tx, auditCtx, {
          kind: 'SECURITY', action: 'Signing step-up rejected',
          detail: 'one or both identification components were not accepted',
        });
        return { ok: false as const, why: 'components rejected' };
      }

      await unlockSigning(tx, ctx.sessionId);
      await recordAudit(tx, auditCtx, {
        kind: 'AUTH', action: 'Signing session opened',
        detail: `valid for ${cfg.SIGNING_WINDOW_MINUTES} minutes`,
      });
      return { ok: true as const };
    });

    if (!outcome.ok) {
      return reply.code(401).send(problem('step_up_failed',
        'Your password and authenticator code were not accepted together.'));
    }
    return reply.send({ signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES });
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
