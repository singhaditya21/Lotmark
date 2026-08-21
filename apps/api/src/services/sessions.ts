import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from '../db';

/**
 * Server-side sessions.
 *
 * Cookie sessions rather than JWTs, because this domain needs IMMEDIATE
 * revocation — a locked account, an idle timeout, a withdrawn competence — and
 * a stateless token cannot be withdrawn before it expires. The cookie carries
 * an opaque random token; everything of consequence lives in the database where
 * it can be deleted.
 */

export const SESSION_COOKIE = 'lm_sid';

/** The raw token is returned once, to be set as a cookie, and never stored. */
export function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: string;
  last_activity_at: string;
  mfa_satisfied_at: string | null;
  signing_unlocked_at: string | null;
  revoked_at: string | null;
}

export async function createSession(
  tx: Sql,
  args: {
    tenantId: string; userId: string; tokenHash: string;
    ttlMinutes: number; ipAddress: string | null; userAgent: string | null;
  },
): Promise<string> {
  const [row] = await tx`
    INSERT INTO lotmark.sessions
      (tenant_id, user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (${args.tenantId}, ${args.userId}, ${args.tokenHash},
            now() + make_interval(mins => ${args.ttlMinutes}),
            ${args.ipAddress}, ${args.userAgent})
    RETURNING id`;
  return (row as { id: string }).id;
}

/**
 * Load a live session.
 *
 * Returns null for anything not currently usable — expired, revoked, or idle
 * past the window. The idle check is HERE rather than in a background job so a
 * session cannot be used in the gap between falling idle and being swept.
 */
export async function loadLiveSession(
  tx: Sql,
  tokenHash: string,
  idleMinutes: number,
): Promise<SessionRow | null> {
  const [row] = await tx`
    SELECT * FROM lotmark.sessions
    WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL
      AND expires_at > now()
      AND last_activity_at > now() - make_interval(mins => ${idleMinutes})
    LIMIT 1`;
  return (row as SessionRow | undefined) ?? null;
}

export async function touchSession(tx: Sql, sessionId: string): Promise<void> {
  await tx`UPDATE lotmark.sessions SET last_activity_at = now() WHERE id = ${sessionId}`;
}

export async function markMfaSatisfied(tx: Sql, sessionId: string): Promise<void> {
  await tx`UPDATE lotmark.sessions SET mfa_satisfied_at = now() WHERE id = ${sessionId}`;
}

/** Open the step-up window after a successful re-authentication. */
export async function unlockSigning(tx: Sql, sessionId: string): Promise<void> {
  await tx`UPDATE lotmark.sessions SET signing_unlocked_at = now() WHERE id = ${sessionId}`;
}

export async function revokeSession(tx: Sql, sessionId: string, reason: string): Promise<void> {
  await tx`UPDATE lotmark.sessions
           SET revoked_at = now(), revoked_reason = ${reason}
           WHERE id = ${sessionId} AND revoked_at IS NULL`;
}

/** Revoke every session for a user — on lockout, or a role change that removes authority. */
export async function revokeAllForUser(tx: Sql, userId: string, reason: string): Promise<number> {
  const rows = await tx`UPDATE lotmark.sessions
                        SET revoked_at = now(), revoked_reason = ${reason}
                        WHERE user_id = ${userId} AND revoked_at IS NULL
                        RETURNING id`;
  return rows.length;
}

/**
 * Is this session inside its continuous signing window?
 * §11.200(a)(1)(ii) — outside it, all identification components are required again.
 */
/**
 * Revoke every other live session this user holds, keeping the caller's own.
 *
 * Used when a credential changes. Sessions minted under the OLD password must
 * not survive it: if the reason for the change is that somebody else knows the
 * password, leaving their session alive means the change accomplished nothing.
 *
 * The current session is kept deliberately. Revoking it too would sign the user
 * out at the exact moment they did the right thing, and the most likely
 * response to that is to assume the change failed and try again.
 *
 * Returns how many were ended, so the caller can tell the user — "you were
 * signed out of 2 other places" is information somebody can act on.
 */
export async function revokeOtherSessions(
  tx: Sql, userId: string, keepSessionId: string, reason: string,
): Promise<number> {
  const rows = await tx`UPDATE lotmark.sessions
                        SET revoked_at = now(), revoked_reason = ${reason}
                        WHERE user_id = ${userId}
                          AND id <> ${keepSessionId}
                          AND revoked_at IS NULL
                        RETURNING id`;
  return rows.length;
}

export function signingWindowOpen(session: SessionRow, windowMinutes: number): boolean {
  if (!session.signing_unlocked_at) return false;
  const opened = Date.parse(session.signing_unlocked_at);
  if (!Number.isFinite(opened)) return false;
  return Date.now() - opened < windowMinutes * 60_000;
}
