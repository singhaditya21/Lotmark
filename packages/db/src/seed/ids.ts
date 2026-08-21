import { createHash } from 'node:crypto';

/**
 * Deterministic UUIDs derived from the prototype's own keys.
 *
 * `uuidFor('u-ravi')` returns the same UUID on every seed run, so re-seeding is
 * idempotent, cross-references resolve without a lookup table, and a failing
 * test names an id a human can trace back to the artefact. Random ids would
 * make every seed produce a different database and every bug report unhelpful.
 *
 * RFC 4122 version-5 shape (SHA-1 would be the letter of the spec; SHA-256
 * truncated is stronger and the version nibbles are set the same way). These
 * identify demo rows — they are not a security boundary.
 */
const NAMESPACE = 'lotmark.seed.v1';

export function uuidFor(key: string): string {
  const h = createHash('sha256').update(`${NAMESPACE}:${key}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
