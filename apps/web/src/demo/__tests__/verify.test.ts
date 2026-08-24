import { describe, it, expect } from 'vitest';
import fixture from '../fixture.json';

/**
 * Public certificate verification, the feature the empty VERIFY column hid.
 *
 * The seed mints no verification tokens, so every holding's token was null and
 * the vault's "check" link never appeared — faithful to the seed, but it hid
 * one of the product's better stories: an auditor checks a printed certificate
 * with no account. The capture now synthesises a token per issued certificate
 * and records the facts a verification page shows. These tests hold that wiring
 * together: a broken token means a dead link on camera.
 */

const bodies = fixture as unknown as Record<string, { body?: unknown }>;
const verifyMap = () => bodies['__verify']?.body as Record<string, Record<string, unknown>>;

describe('verification tokens', () => {
  it('are minted for every holding that has a certificate', () => {
    const holdings = (bodies['GET /vault']?.body as
      { holdings?: Array<Record<string, unknown>> }).holdings ?? [];
    const withCert = holdings.filter((h) => h['certificate_code']);
    expect(withCert.length).toBeGreaterThan(0);
    for (const h of withCert) {
      expect(h['verification_token'],
        `${String(h['certificate_code'])} has a certificate but no token — its check link is dead`)
        .toBeTruthy();
    }
  });

  it('are URL-safe and the shape the real route accepts', () => {
    // apps/api/src/routes/public.ts bounds the token: [A-Za-z0-9_-]{16,64}.
    for (const token of Object.keys(verifyMap())) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    }
  });

  it('resolve to the same certificate the holding and the detail name', () => {
    const holdings = (bodies['GET /vault']?.body as
      { holdings?: Array<Record<string, unknown>> }).holdings ?? [];
    const map = verifyMap();
    for (const h of holdings) {
      const token = h['verification_token'];
      if (typeof token !== 'string') continue;
      const facts = map[token];
      expect(facts, 'the holding points at a token with no facts behind it').toBeTruthy();
      expect(facts!['certificateCode']).toBe(h['certificate_code']);
      expect(facts!['issueNumber']).toBe(h['issue_number']);
    }

    // The same token is on the certificate's own issue, so both links agree.
    const issues = (bodies['GET /certificates/:id']?.body as
      { issues?: Array<Record<string, unknown>> }).issues ?? [];
    const tokened = issues.filter((i) => i['verificationToken']);
    for (const i of tokened) {
      expect(map[String(i['verificationToken'])]).toBeTruthy();
    }
  });

  it('carry the facts a verifier needs, and nothing about a customer', () => {
    for (const facts of Object.values(verifyMap())) {
      for (const key of ['materialName', 'lotCode', 'assignedValue', 'unit', 'producerName']) {
        expect(facts[key], `verification facts are missing ${key}`).toBeDefined();
      }
      // The public page must not carry who holds it — that is the whole point
      // of a lookup an auditor can run without an account.
      const json = JSON.stringify(facts).toLowerCase();
      for (const leak of ['organisation', 'customer', 'order', 'holder', 'email']) {
        expect(json, `verification facts leak ${leak}`).not.toContain(leak);
      }
    }
  });
});

describe('looking up a certificate by its code', () => {
  it('resolves a real code to its token, case-insensitively', async () => {
    const { tokenForCode } = await import('../Verify');
    const map = verifyMap();
    const someCode = String(Object.values(map)[0]!['certificateCode']);
    const token = tokenForCode(someCode.toLowerCase());
    expect(token, 'a code a holder types should resolve').toBeTruthy();
    expect(map[token!]!['certificateCode']).toBe(someCode);
  });

  it('returns null for a code that was never issued', async () => {
    const { tokenForCode } = await import('../Verify');
    expect(tokenForCode('CRT-9999')).toBeNull();
  });
});
