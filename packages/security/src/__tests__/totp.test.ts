import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';
import {
  generateSecret, verifyTotp, enrolmentUri, replayKey,
  generateRecoveryCodes, hashRecoveryCode, recoveryCodeMatches,
} from '../totp';

describe('TOTP', () => {
  const secret = generateSecret();

  it('accepts the current code', () => {
    expect(verifyTotp(authenticator.generate(secret), secret)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const wrong = authenticator.generate(generateSecret());
    const current = authenticator.generate(secret);
    if (wrong !== current) expect(verifyTotp(wrong, secret)).toBe(false);
  });

  it("rejects the prototype's 'any six digits' inputs", () => {
    // The prototype accepted every six-digit string except 000000, which is a
    // second text box rather than a second factor.
    const current = authenticator.generate(secret);
    for (const t of ['123456', '000000', '999999', '111111']) {
      if (t === current) continue;
      expect(verifyTotp(t, secret), t).toBe(false);
    }
  });

  it('rejects malformed input before reaching the crypto', () => {
    for (const t of ['', '12345', '1234567', 'abcdef', '12 34 56', '12345a']) {
      expect(verifyTotp(t, secret), JSON.stringify(t)).toBe(false);
    }
  });

  it('produces a scannable enrolment URI', () => {
    const uri = enrolmentUri({ secret, accountEmail: 'ravi@producer.example', issuer: 'Lotmark' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('Lotmark');
    expect(uri).toContain(secret);
  });

  it('generates distinct secrets', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateSecret()));
    expect(secrets.size).toBe(20);
  });
});

describe('TOTP replay protection', () => {
  it('keys on a digest, never on the secret or the code in clear', () => {
    const secret = generateSecret();
    const k = replayKey(secret, '123456');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    // The replay store must not itself become a source of live credentials.
    expect(k).not.toContain(secret);
    expect(k).not.toContain('123456');
  });

  it('gives the same key for the same pair and a different one otherwise', () => {
    const s = generateSecret();
    expect(replayKey(s, '123456')).toBe(replayKey(s, '123456'));
    expect(replayKey(s, '123456')).not.toBe(replayKey(s, '123457'));
    expect(replayKey(s, '123456')).not.toBe(replayKey(generateSecret(), '123456'));
  });
});

describe('recovery codes', () => {
  it('generates ten distinct codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('matches regardless of spacing or case', () => {
    const [code] = generateRecoveryCodes(1);
    const stored = hashRecoveryCode(code!);
    expect(recoveryCodeMatches(code!, stored)).toBe(true);
    expect(recoveryCodeMatches(code!.toLowerCase(), stored)).toBe(true);
    expect(recoveryCodeMatches(code!.replace('-', ' '), stored)).toBe(true);
  });

  it('rejects a code that was not issued', () => {
    const stored = hashRecoveryCode(generateRecoveryCodes(1)[0]!);
    expect(recoveryCodeMatches('AAAAA-BBBBB', stored)).toBe(false);
  });

  it('compares in constant time without throwing on a length mismatch', () => {
    expect(recoveryCodeMatches('x', 'deadbeef')).toBe(false);
  });
});
