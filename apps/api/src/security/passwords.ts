import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing — Argon2id.
 *
 * The prototype ran 2,000 rounds of a 64-bit FNV variant. FNV is a
 * non-cryptographic hash designed to be FAST, which is the opposite of what a
 * password hash needs: a GPU evaluates it billions of times per second, so the
 * whole user table falls to an offline attack in minutes.
 *
 * Argon2id is the OWASP first choice. It is memory-hard, so the attacker's
 * advantage from parallel hardware is bounded by memory bandwidth rather than
 * by core count.
 *
 * Parameters follow OWASP's 2024 guidance (19 MiB, t=2, p=1). They are recorded
 * inside the hash string itself, so raising them later re-hashes users on their
 * next sign-in without invalidating anyone's existing password.
 */
/**
 * `Algorithm.Argon2id` is an ambient `const enum`, which cannot be referenced
 * under `verbatimModuleSyntax`. The literal 2 is its value. Rather than assert
 * that in a comment and hope, `passwords.test.ts` checks that the produced hash
 * actually carries the `$argon2id$` prefix — if the value ever changed, the
 * test fails rather than silently downgrading everyone to Argon2d.
 */
const ARGON2ID = 2;

const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  assertUsable(plain);
  return hash(plain, PARAMS);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, plain, PARAMS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an
    // exception that a caller might mistake for a system fault and retry around.
    return false;
  }
}

/**
 * Does this hash use parameters weaker than current policy?
 * Callers re-hash on successful sign-in when it does.
 */
export function needsRehash(stored: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true; // not argon2id at all — definitely re-hash
  const [, mem, time, par] = m;
  return (
    Number(mem) < PARAMS.memoryCost ||
    Number(time) < PARAMS.timeCost ||
    Number(par) < PARAMS.parallelism
  );
}

export class WeakPasswordError extends Error {
  constructor(message: string) { super(message); this.name = 'WeakPasswordError'; }
}

/**
 * 21 CFR 11 §11.300(b) requires password aging and revision. The length floor
 * here is NIST SP 800-63B's: length beats composition rules, which mostly
 * produce `Passw0rd!` and a sticky note.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

function assertUsable(plain: string): void {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`A password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    // Unbounded input into a memory-hard function is a denial-of-service vector.
    throw new WeakPasswordError(`A password may be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}
