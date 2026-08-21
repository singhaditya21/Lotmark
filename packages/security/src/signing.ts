import {
  generateKeyPairSync, sign, verify, createHash,
  createPrivateKey, createPublicKey, type KeyObject,
} from 'node:crypto';

/**
 * Record signatures — Ed25519.
 *
 * The prototype "bound" a signature with an unkeyed 64-bit FNV digest. Anyone
 * who could edit the record could recompute the digest, so the binding proved
 * nothing: it detected accidental corruption and no attack at all.
 *
 * Ed25519 is asymmetric, and that asymmetry is the point. Verification needs
 * only the public key, so an assessor — or a customer holding a certificate —
 * can check a signature without holding anything that could produce one. An
 * HMAC cannot offer that: every verifier is also a forger.
 *
 * 21 CFR 11 §11.70 requires the signature be bound to its record so it cannot
 * be excised, copied or transferred. Signing the canonical material (which
 * includes the record's identity, the signer, the meaning and the instant)
 * satisfies all three: move it to another record and the material differs;
 * relabel the meaning and the material differs; reassign the signer and the
 * material differs.
 */

export const SIGNING_ALGORITHM = 'ed25519' as const;

export interface KeyPair {
  /** PKCS#8 PEM. Never stored in the database. */
  readonly privateKeyPem: string;
  /** SPKI PEM. Stored, published, and used by every verifier. */
  readonly publicKeyPem: string;
  /** Short stable identifier for the key, so signatures survive rotation. */
  readonly keyVersion: string;
}

export function generateSigningKeyPair(keyVersion: string): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyVersion,
  };
}

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function loadPublicKey(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** Derive the public key from a private one, so the two cannot be mismatched. */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/**
 * Sign the canonical payload.
 *
 * Ed25519 hashes internally, so the payload is passed whole rather than
 * pre-hashed — pre-hashing would discard length information and open the door
 * to the collision games that pre-hashed schemes have to defend against.
 */
export function signPayload(payload: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

export function verifyPayload(
  payload: string,
  signatureBase64: string,
  publicKey: KeyObject,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(payload, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    // A malformed signature is an invalid signature, never a system fault a
    // caller might retry around.
    return false;
  }
}

/**
 * A digest of what was signed, stored alongside the signature.
 *
 * Not the security mechanism — the Ed25519 signature is. This exists so an
 * operator can see at a glance WHICH payload a signature covers, and so two
 * signatures over the same material are visibly over the same material,
 * without having to reconstruct the payload to find out.
 */
export function payloadDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** A stable fingerprint of a public key, for display and key-rotation records. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}
