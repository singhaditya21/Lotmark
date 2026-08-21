import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair, loadPrivateKey, loadPublicKey, publicKeyOf,
  signPayload, verifyPayload, payloadDigest, publicKeyFingerprint,
} from '../signing';

const kp = generateSigningKeyPair('v1');
const priv = loadPrivateKey(kp.privateKeyPem);
const pub = loadPublicKey(kp.publicKeyPem);

const PAYLOAD = 'v1|study|ST-1001|PRJ-0412|homogeneity|EQ-01,EQ-02|0.18|u-ravi|approval|2026-01-08T10:15:00Z';

describe('Ed25519 record signatures', () => {
  it('verifies a signature it produced', () => {
    expect(verifyPayload(PAYLOAD, signPayload(PAYLOAD, priv), pub)).toBe(true);
  });

  it('REJECTS a signature over different material — §11.70 excision resistance', () => {
    const sig = signPayload(PAYLOAD, priv);
    // Move the signature to another record: the material differs, so it fails.
    expect(verifyPayload(PAYLOAD.replace('ST-1001', 'ST-1002'), sig, pub)).toBe(false);
    // Relabel the meaning: fails.
    expect(verifyPayload(PAYLOAD.replace('approval', 'review'), sig, pub)).toBe(false);
    // Reassign the signer: fails.
    expect(verifyPayload(PAYLOAD.replace('u-ravi', 'u-asha'), sig, pub)).toBe(false);
    // Change the value the record asserts: fails.
    expect(verifyPayload(PAYLOAD.replace('0.18', '0.19'), sig, pub)).toBe(false);
  });

  it('REJECTS a signature from another key', () => {
    const other = generateSigningKeyPair('v2');
    const sig = signPayload(PAYLOAD, loadPrivateKey(other.privateKeyPem));
    expect(verifyPayload(PAYLOAD, sig, pub)).toBe(false);
  });

  it('treats a malformed signature as invalid, not as a fault', () => {
    expect(verifyPayload(PAYLOAD, 'not-base64-!!', pub)).toBe(false);
    expect(verifyPayload(PAYLOAD, '', pub)).toBe(false);
  });

  it('a verifier cannot forge — the public key alone signs nothing', () => {
    // The property an HMAC cannot provide: every HMAC verifier is also a forger.
    expect(() => signPayload(PAYLOAD, pub as never)).toThrow();
  });

  it('derives the public key from the private one, so they cannot be mismatched', () => {
    expect(publicKeyOf(kp.privateKeyPem).trim()).toBe(kp.publicKeyPem.trim());
  });

  it('produces distinct keys each time', () => {
    const a = generateSigningKeyPair('v1');
    const b = generateSigningKeyPair('v1');
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
    expect(publicKeyFingerprint(a.publicKeyPem)).not.toBe(publicKeyFingerprint(b.publicKeyPem));
  });
});

describe('payload digest', () => {
  it('is stable and 64 hex characters', () => {
    expect(payloadDigest(PAYLOAD)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadDigest(PAYLOAD)).toBe(payloadDigest(PAYLOAD));
  });

  it('differs for different payloads', () => {
    expect(payloadDigest(PAYLOAD)).not.toBe(payloadDigest(`${PAYLOAD} `));
  });
});

describe('key fingerprints', () => {
  it('is stable for one key', () => {
    expect(publicKeyFingerprint(kp.publicKeyPem)).toBe(publicKeyFingerprint(kp.publicKeyPem));
    expect(publicKeyFingerprint(kp.publicKeyPem)).toHaveLength(32);
  });
});
