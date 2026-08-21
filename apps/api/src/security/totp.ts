import { authenticator } from 'otplib';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords — RFC 6238.
 *
 * The prototype accepted any six digits except '000000'. That is not a second
 * factor; it is a second text box.
 *
 * 21 CFR 11 §11.200(a)(1) requires signings to use at least two distinct
 * identification components, and §11.200(a)(3) requires that using someone
 * else's components demand collaboration between individuals. A real TOTP
 * secret satisfies both; a shape check on the input satisfies neither.
 */
authenticator.options = {
  digits: 6,
  step: 30,
  /**
   * Accept the immediately preceding and following steps. Tolerating clock
   * skew is necessary; a wider window multiplies the number of codes valid at
   * any instant, which is exactly what the factor exists to keep small.
   */
  window: 1,
};

export function generateSecret(): string {
  return authenticator.generateSecret();
}

/** The otpauth:// URI a authenticator app scans. */
export function enrolmentUri(args: {
  readonly secret: string;
  readonly accountEmail: string;
  readonly issuer: string;
}): string {
  return authenticator.keyuri(args.accountEmail, args.issuer, args.secret);
}

export function verifyTotp(token: string, secret: string): boolean {
  // Reject shape before doing crypto, so a malformed token cannot reach the
  // library and cannot be distinguished by timing from a wrong-but-valid one.
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}

/**
 * Replay protection.
 *
 * A TOTP code stays valid for its whole step. Without a replay cache, an
 * attacker who observes a code — over the shoulder, in a log, in a phishing
 * proxy — can reuse it within that window. RFC 6238 §5.2 requires that each
 * code be accepted at most once.
 *
 * The cache key is a digest of the secret and the code, never either in clear,
 * so the store itself does not become a source of live credentials.
 */
export function replayKey(secret: string, token: string): string {
  return createHash('sha256').update(`${secret}:${token}`).digest('hex');
}

/** How long a used code must stay remembered: the step plus the skew window. */
export const REPLAY_TTL_SECONDS = 30 * 3 + 5;

/**
 * Recovery codes, for the authenticator-lost case that §11.300(c) requires a
 * procedure for. Stored hashed, shown once, single-use.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'),
  );
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

export function recoveryCodeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecoveryCode(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
