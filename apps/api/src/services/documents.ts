import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Content-addressed document storage.
 *
 * The path IS the digest, so a stored document cannot be silently swapped for a
 * different one: reading back the file and hashing it must reproduce the name.
 * Writing the same bytes twice is a no-op rather than a duplicate, which falls
 * out of the addressing for free and matters because a reissue that changes
 * nothing should not consume storage or produce a second artefact.
 *
 * Local filesystem on purpose. An object store is a driver swap behind this
 * interface, and adding one before there is a second deployment would be
 * infrastructure with no observable benefit.
 */
export class DocumentStore {
  constructor(private readonly root: string) {}

  /** Returns the digest; writes only if absent. */
  put(bytes: Uint8Array): { sha256: string; relativePath: string; bytes: number } {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relativePath = this.pathFor(sha256);
    const full = path.join(this.root, relativePath);
    if (!existsSync(full)) {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    }
    return { sha256, relativePath, bytes: bytes.byteLength };
  }

  /**
   * Read back, verifying the digest.
   *
   * A silent mismatch would serve a document that is not the one the
   * certificate record attests to — precisely the failure the addressing exists
   * to prevent, so it throws rather than returning bytes.
   */
  get(sha256: string): Uint8Array {
    const full = path.join(this.root, this.pathFor(sha256));
    if (!existsSync(full)) throw new DocumentMissingError(sha256);
    const bytes = readFileSync(full);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw new Error(
        `Stored document ${sha256} hashes to ${actual}. The file on disk is not the ` +
        'document this certificate attests to. Refusing to serve it.',
      );
    }
    return bytes;
  }

  has(sha256: string): boolean {
    return existsSync(path.join(this.root, this.pathFor(sha256)));
  }

  /** Two-level fan-out: a flat directory of millions of files is a bad time. */
  private pathFor(sha256: string): string {
    return path.join(sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.pdf`);
  }
}

export class DocumentMissingError extends Error {
  constructor(readonly sha256: string) {
    super(`No stored document with digest ${sha256}.`);
    this.name = 'DocumentMissingError';
  }
}

/**
 * A public verification handle.
 *
 * 192 bits of randomness, base64url. Unguessable, and — unlike the certificate
 * number — it reveals no tenant, no customer and no position in a sequence, so
 * publishing it on a printed certificate leaks nothing.
 */
export function mintVerificationToken(): string {
  return randomBytes(24).toString('base64url');
}
