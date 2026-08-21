import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, needsRehash, WeakPasswordError,
  MIN_PASSWORD_LENGTH,
} from '../security/passwords';

describe('password hashing', () => {
  const good = 'correct-horse-battery-staple';

  it('produces an Argon2ID hash, not Argon2d or Argon2i', async () => {
    // Guards the ARGON2ID = 2 literal, which cannot be type-checked against the
    // library's ambient const enum.
    const h = await hashPassword(good);
    expect(h.startsWith('$argon2id$')).toBe(true);
  });

  it('records its parameters in the hash string', async () => {
    const h = await hashPassword(good);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(good), hashPassword(good)]);
    expect(a).not.toBe(b);
    // ...and both still verify.
    expect(await verifyPassword(good, a)).toBe(true);
    expect(await verifyPassword(good, b)).toBe(true);
  });

  it('accepts the right password and rejects the wrong one', async () => {
    const h = await hashPassword(good);
    expect(await verifyPassword(good, h)).toBe(true);
    expect(await verifyPassword('correct-horse-battery-stapl', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('treats a malformed stored hash as a wrong password, not a fault', async () => {
    // A caller must never mistake corruption for a system error and retry
    // around it into an authenticated state.
    expect(await verifyPassword(good, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(good, '')).toBe(false);
    expect(await verifyPassword(good, '$argon2id$truncated')).toBe(false);
  });

  it('refuses a password below the length floor', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)))
      .rejects.toThrow(WeakPasswordError);
  });

  it('refuses an unbounded password — a DoS vector into a memory-hard function', async () => {
    await expect(hashPassword('a'.repeat(2000))).rejects.toThrow(WeakPasswordError);
  });

  it('flags weaker or foreign hashes for re-hashing', async () => {
    expect(needsRehash(await hashPassword(good))).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('$2b$12$bcrypthashhere')).toBe(true);
    // The prototype's iterated-FNV digest is not even a recognised format.
    expect(needsRehash('a3f19c22')).toBe(true);
  });
});
