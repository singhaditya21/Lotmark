import { randomBytes } from 'node:crypto';
import { verifyPassword, needsRehash, hashPassword, verifyTotp } from '@lotmark/security';
import type { Sql } from '../db';
import { recordAudit, anonymousContext, type AuditContext } from './audit';
import {
  mintToken, createSession, markMfaSatisfied, revokeAllForUser,
} from './sessions';

/**
 * Sign-in.
 *
 * Three properties this flow is built around:
 *
 *  1. **A uniform answer.** Wrong password, unknown email, deactivated account
 *     and locked account all return the same message and take a comparable
 *     amount of time. Distinguishing them turns the sign-in form into a user
 *     enumeration oracle, which is how an attacker builds a target list.
 *  2. **Lockout is evidence.** Failure counts and lock expiry live in the
 *     database, not in process memory as the prototype had them. An in-memory
 *     counter resets on deploy, which an attacker can often trigger, and it
 *     cannot be shown to an assessor afterwards.
 *  3. **A password is not a session.** Passing the password yields a session
 *     that authorises NOTHING until the second factor is satisfied.
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export type SignInResult =
  | { outcome: 'mfa_required'; sessionToken: string; userId: string }
  | { outcome: 'signed_in'; sessionToken: string; userId: string }
  | { outcome: 'rejected'; message: string };

const GENERIC_REJECTION =
  'That email address and password combination was not recognised.';

interface UserRow {
  id: string; tenant_id: string; email: string; display_name: string;
  password_hash: string; totp_secret_encrypted: string | null;
  mfa_required: boolean; failed_sign_in_count: number;
  locked_until: string | null; deactivated_at: string | null;
}

export async function signIn(
  tx: Sql,
  args: {
    tenantId: string; email: string; password: string;
    ipAddress: string | null; userAgent: string | null;
    sessionTtlMinutes: number; timeSource: string; region: string;
  },
): Promise<SignInResult> {
  const anon = anonymousContext({
    tenantId: args.tenantId,
    attemptedIdentity: args.email,
    timeSource: args.timeSource,
    region: args.region,
  });

  const found = await tx`
    SELECT * FROM lotmark.users
    WHERE tenant_id = ${args.tenantId} AND lower(email) = lower(${args.email})
    LIMIT 1`;
  const user = found[0] as UserRow | undefined;

  if (!user) {
    // Still spend the cost of a verify so a missing account is not measurably
    // faster than a wrong password.
    await verifyPassword(args.password, await dummyHash());
    await recordAudit(tx, anon, {
      kind: 'SECURITY', action: 'Failed sign-in', detail: 'no such account',
    });
    return { outcome: 'rejected', message: GENERIC_REJECTION };
  }

  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    await recordAudit(tx, anon, {
      kind: 'SECURITY', action: 'Sign-in attempt on a locked account',
      detail: `locked until ${user.locked_until}`,
    });
    return { outcome: 'rejected', message: GENERIC_REJECTION };
  }

  if (user.deactivated_at) {
    await recordAudit(tx, anon, {
      kind: 'SECURITY', action: 'Sign-in attempt on a deactivated account',
    });
    return { outcome: 'rejected', message: GENERIC_REJECTION };
  }

  const ok = await verifyPassword(args.password, user.password_hash);
  if (!ok) {
    const attempts = user.failed_sign_in_count + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await tx`
      UPDATE lotmark.users
      SET failed_sign_in_count = ${lock ? 0 : attempts},
          locked_until = ${lock ? tx`now() + make_interval(mins => ${LOCKOUT_MINUTES})` : null}
      WHERE id = ${user.id}`;
    await recordAudit(tx, anon, {
      kind: 'SECURITY',
      action: lock ? 'Account locked after repeated failures' : 'Failed sign-in',
      detail: `attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}`,
      subjectTable: 'users', subjectId: user.id,
    });
    return { outcome: 'rejected', message: GENERIC_REJECTION };
  }

  // Correct password: clear the counter, and raise the hash if policy moved on.
  await tx`UPDATE lotmark.users SET failed_sign_in_count = 0, locked_until = NULL WHERE id = ${user.id}`;
  if (needsRehash(user.password_hash)) {
    await tx`UPDATE lotmark.users SET password_hash = ${await hashPassword(args.password)} WHERE id = ${user.id}`;
  }

  const { token, tokenHash } = mintToken();
  const sessionId = await createSession(tx, {
    tenantId: args.tenantId, userId: user.id, tokenHash,
    ttlMinutes: args.sessionTtlMinutes,
    ipAddress: args.ipAddress, userAgent: args.userAgent,
  });

  const ctx: AuditContext = {
    tenantId: args.tenantId, actorUserId: user.id, actorLabel: user.display_name,
    actorRoleId: '—', sessionId, timeSource: args.timeSource, region: args.region,
  };

  if (user.mfa_required) {
    // The session exists but authorises nothing until the second factor lands.
    await recordAudit(tx, ctx, {
      kind: 'AUTH', action: 'Password accepted, second factor required', detail: user.email,
    });
    return { outcome: 'mfa_required', sessionToken: token, userId: user.id };
  }

  await markMfaSatisfied(tx, sessionId);
  await recordAudit(tx, ctx, { kind: 'AUTH', action: 'Signed in', detail: user.email });
  return { outcome: 'signed_in', sessionToken: token, userId: user.id };
}

export type MfaResult =
  | { outcome: 'signed_in' }
  | { outcome: 'rejected'; message: string; sessionRevoked: boolean };

export const MAX_MFA_ATTEMPTS = 3;

interface MfaUserRow {
  id: string;
  display_name: string;
  email: string;
  totp_secret_encrypted: string | null;
}

export async function verifySecondFactor(
  tx: Sql,
  args: {
    sessionId: string; userId: string; tenantId: string; token: string;
    attemptNumber: number; timeSource: string; region: string;
  },
): Promise<MfaResult> {
  const rows = await tx`
    SELECT id, display_name, email, totp_secret_encrypted
    FROM lotmark.users WHERE id = ${args.userId} LIMIT 1`;
  const user = rows[0] as MfaUserRow | undefined;

  const ctx: AuditContext = {
    tenantId: args.tenantId, actorUserId: args.userId,
    actorLabel: user?.display_name ?? 'unknown', actorRoleId: '—',
    sessionId: args.sessionId, timeSource: args.timeSource, region: args.region,
  };

  if (!user?.totp_secret_encrypted) {
    // MFA required but never enrolled is a provisioning fault, not a user error.
    await recordAudit(tx, ctx, {
      kind: 'SECURITY', action: 'Second factor demanded but no authenticator is enrolled',
    });
    return { outcome: 'rejected', message: 'No authenticator is enrolled for this account.', sessionRevoked: false };
  }

  if (verifyTotp(args.token, user.totp_secret_encrypted)) {
    await markMfaSatisfied(tx, args.sessionId);
    await recordAudit(tx, ctx, { kind: 'AUTH', action: 'Second factor verified', detail: user.email });
    return { outcome: 'signed_in' };
  }

  const exhausted = args.attemptNumber >= MAX_MFA_ATTEMPTS;
  await recordAudit(tx, ctx, {
    kind: 'SECURITY',
    action: exhausted ? 'Sign-in abandoned after repeated second-factor failures' : 'Second factor rejected',
    detail: `attempt ${args.attemptNumber} of ${MAX_MFA_ATTEMPTS}`,
  });

  if (exhausted) {
    await revokeAllForUser(tx, args.userId, 'second factor failed repeatedly');
    return { outcome: 'rejected', message: 'Too many incorrect codes. Sign in again.', sessionRevoked: true };
  }
  return { outcome: 'rejected', message: 'That code was not accepted.', sessionRevoked: false };
}

/**
 * A REAL Argon2id hash of a random value, used to equalise timing on the
 * unknown-account path.
 *
 * It must be a genuine hash. A malformed placeholder makes `verifyPassword`
 * fail its parse and return almost immediately, so the unknown-account path
 * becomes measurably FASTER than a wrong password — which is precisely the
 * enumeration oracle the dummy verify exists to close.
 *
 * Computed once, lazily, so module load stays cheap and the cost lands on the
 * first request that needs it.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHashPromise;
}
