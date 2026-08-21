import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenantTransaction } from '../db';
import { signIn, verifySecondFactor, MAX_MFA_ATTEMPTS } from '../services/auth';
import {
  SESSION_COOKIE, hashToken, loadLiveSession, revokeOtherSessions, revokeSession,
  touchSession, unlockSigning,
} from '../services/sessions';
import {
  verifyPassword, verifyTotp, hashPassword,
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} from '@lotmark/security';
import { recordAudit } from '../services/audit';
import { requireSession } from '../plugins/session';
import {
  authenticationFailed, fieldErrors, invalidRequest, sendProblem, sessionExpired, unprocessable,
} from '../http/problem';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

/**
 * Replacing your own password.
 *
 * The length floor comes from `@lotmark/security` rather than being repeated
 * here, so the form's inline message and the hash function's refusal cannot
 * disagree about what the policy is. `hashPassword` still enforces it — this
 * check exists to produce a FIELD error the form can render, not to be the
 * control.
 */
const passwordChangeBody = z.object({
  currentPassword: z.string().min(1, 'Your current password is required.').max(MAX_PASSWORD_LENGTH),
  newPassword: z.string()
    .min(MIN_PASSWORD_LENGTH, `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(MAX_PASSWORD_LENGTH),
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
    // Through resolve_tenant, not a direct SELECT: the tenants table is under
    // RLS and a request that has not yet identified its tenant cannot satisfy
    // the policy. This is the one sanctioned bootstrap path.
    const [row] = await db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
    const t = row as { id: string; time_source: string; region: string } | undefined;
    if (!t) throw new Error('No tenant is provisioned. Run: pnpm db:seed');
    return { id: t.id, timeSource: t.time_source, region: t.region };
  }

  app.post('/sign-in', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, invalidRequest('Email and password are required.'));

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
      return sendProblem(reply, authenticationFailed(result.message));
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
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid code.'));
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return sendProblem(reply, sessionExpired('Sign in again.'));

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
      return sendProblem(reply, authenticationFailed(result.message));
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
      return sendProblem(reply, invalidRequest(
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
      return sendProblem(reply, authenticationFailed(
        'Your password and authenticator code were not accepted together.'));
    }
    return reply.send({ signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES });
  });

  /**
   * Replacing your own password.
   *
   * Reachable while the account still owes a password change — one of exactly
   * three routes that are, and the only one that can clear the debt.
   *
   * ── Why the current password, when the session is already trusted ─────────
   *
   * The session proves someone got past the password and the authenticator at
   * sign-in. It does not prove the person at the keyboard NOW is the same one:
   * an unlocked screen is the ordinary case, not an exotic one. Demanding the
   * current password makes taking over an account require knowing the
   * credential being replaced, which is the whole point of replacing it.
   *
   * ── Why other sessions end ────────────────────────────────────────────────
   *
   * See `revokeOtherSessions`. A password change that leaves the old sessions
   * running has not removed anybody's access, it has only made them re-read the
   * sticky note.
   *
   * ── What is not recorded ──────────────────────────────────────────────────
   *
   * The ledger records that this person changed their own password, when, and
   * from which session. Neither password appears in it, in the `changes` object
   * or in the detail — the auditable fact is the act, never the credential.
   */
  app.post('/password', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const ctx = await requireSession(app, req, reply, { allowPasswordChangePending: true });
    if (!ctx) return;

    const parsed = passwordChangeBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        parsed.error.issues[0]?.message ?? 'A current and a new password are required.',
        fieldErrors(parsed.error.issues)));
    }
    const { currentPassword, newPassword } = parsed.data;

    if (newPassword === currentPassword) {
      // Checked before touching the database: "change it" and "type it again"
      // are different acts, and accepting the second as the first would clear
      // the obligation without replacing the credential.
      return sendProblem(reply, unprocessable(
        'The new password must be different from your current one.'));
    }

    const outcome = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, async (tx) => {
      const auditCtx = {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
        actorRoleId: '—', sessionId: ctx.sessionId,
        timeSource: ctx.timeSource, region: ctx.region,
      };

      const [row] = await tx`
        SELECT password_hash FROM lotmark.users WHERE id = ${ctx.userId} LIMIT 1`;
      const user = row as { password_hash: string } | undefined;
      if (!user) return { ok: false as const };

      if (!await verifyPassword(currentPassword, user.password_hash)) {
        await recordAudit(tx, auditCtx, {
          kind: 'SECURITY', action: 'Password change rejected',
          detail: 'the current password was not accepted',
          subjectTable: 'users', subjectId: ctx.userId,
        });
        return { ok: false as const };
      }

      await tx`
        UPDATE lotmark.users
        SET password_hash = ${await hashPassword(newPassword)},
            password_change_required = false,
            password_changed_at = now(),
            failed_sign_in_count = 0,
            locked_until = NULL
        WHERE id = ${ctx.userId}`;

      const ended = await revokeOtherSessions(
        tx, ctx.userId, ctx.sessionId, 'password changed');

      await recordAudit(tx, auditCtx, {
        kind: 'SECURITY', action: 'Password changed by its holder',
        detail: ended > 0
          ? `${ended} other session(s) ended`
          : 'no other sessions were open',
        subjectTable: 'users', subjectId: ctx.userId,
        // Deliberately empty of anything derived from either password.
        changes: { wasIssued: ctx.passwordChangeRequired },
      });

      return { ok: true as const, ended };
    });

    if (!outcome.ok) {
      return sendProblem(reply, authenticationFailed(
        'Your current password was not accepted.'));
    }
    return reply.send({ changed: true, otherSessionsEnded: outcome.ended });
  });

  /** Who am I, and what may I do — the console's bootstrap call. */
  app.get('/me', async (req, reply) => {
    /**
     * Reachable while a password change is outstanding, because this is the
     * call that TELLS the console so. Gating it would leave the client unable
     * to distinguish "your password must change" from "you are signed out", and
     * it would show the sign-in screen to somebody who is already signed in.
     */
    const ctx = await requireSession(app, req, reply, { allowPasswordChangePending: true });
    if (!ctx) return; // requireSession has already replied

    await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx) => touchSession(tx, ctx.sessionId));

    return reply.send({
      user: { id: ctx.userId, name: ctx.displayName, email: ctx.email },
      /**
       * Which half of the product to show, and which organisation the user
       * belongs to. Two different boundaries — see resolveRoleKinds. Both are
       * advisory to the client; the server re-decides every act regardless.
       */
      roleKinds: ctx.roleKinds,
      organisation: ctx.organisation,
      teams: ctx.teams,
      // Permissions are sent so the console can hide what the user cannot do.
      // They are advisory: every act is re-checked server-side by the guard.
      permissions: [...ctx.authority.tenantWide],
      permissionsByTeam: Object.fromEntries(
        [...ctx.authority.byTeam].map(([team, perms]) => [team, [...perms]]),
      ),
      secondFactorSatisfied: ctx.mfaSatisfied,
      /**
       * NOT advisory, unlike `permissions` above. Every other route is refusing
       * this session until the password is replaced, so the console showing the
       * change screen is agreement with the server, not a courtesy.
       */
      passwordChangeRequired: ctx.passwordChangeRequired,
    });
  });
}

