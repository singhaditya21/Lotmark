import { describe, it, expect } from 'vitest';
import { merkleRoot, statementBytes, parseStatement, type AnchorStatement } from '../services/anchor';

const S: AnchorStatement = {
  version: 1, tenantId: '11111111-1111-1111-1111-111111111111',
  fromSeq: '1', toSeq: '42', entryCount: '42',
  headHash: 'a'.repeat(64), merkleRoot: 'b'.repeat(64),
  takenAt: '2026-08-21T09:15:00Z', prevSignature: null,
};

describe('merkle root', () => {
  it('is stable and 64 hex characters', () => {
    expect(merkleRoot(['a', 'b', 'c'])).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(['a', 'b', 'c'])).toBe(merkleRoot(['a', 'b', 'c']));
  });

  it('changes when any leaf changes, is added, or is removed', () => {
    const base = merkleRoot(['a', 'b', 'c', 'd']);
    expect(merkleRoot(['a', 'b', 'c', 'e'])).not.toBe(base);
    expect(merkleRoot(['a', 'b', 'c'])).not.toBe(base);
    expect(merkleRoot(['a', 'b', 'c', 'd', 'e'])).not.toBe(base);
  });

  it('changes when leaves are reordered', () => {
    expect(merkleRoot(['a', 'b'])).not.toBe(merkleRoot(['b', 'a']));
  });

  it('PROMOTES an odd node rather than duplicating it (CVE-2012-2459)', () => {
    // Duplicating the last leaf makes [a,b,c] and [a,b,c,c] produce the same
    // root, so an attacker can append a duplicate and keep the root intact.
    expect(merkleRoot(['a', 'b', 'c'])).not.toBe(merkleRoot(['a', 'b', 'c', 'c']));
  });

  it('distinguishes a leaf from an internal node', () => {
    // Domain separation: without the leaf:/node: prefixes, a crafted leaf could
    // impersonate an internal hash.
    expect(merkleRoot(['a'])).not.toBe(merkleRoot(['a', 'a']));
  });

  it('handles the empty segment without throwing', () => {
    expect(merkleRoot([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the signed statement', () => {
  it('round-trips through parse', () => {
    const parsed = parseStatement(statementBytes(S));
    expect(parsed).toEqual(S);
  });

  it('round-trips with a previous signature present', () => {
    const chained = { ...S, prevSignature: 'AbCd+/12==' };
    expect(parseStatement(statementBytes(chained))).toEqual(chained);
  });

  it('is length-prefixed, so no field can forge a boundary', () => {
    const sneaky = { ...S, headHash: `x|${'9'.repeat(10)}|y` };
    const parsed = parseStatement(statementBytes(sneaky));
    // A delimiter-joined encoding would mis-split here and parse would either
    // fail or silently produce different fields.
    expect(parsed?.headHash).toBe(sneaky.headHash);
  });

  it('refuses a truncated or malformed statement', () => {
    expect(parseStatement('nonsense')).toBeNull();
    expect(parseStatement(statementBytes(S).slice(0, 20))).toBeNull();
    // A length prefix that disagrees with the body is rejected, not trusted.
    expect(parseStatement('v1|99:short|1:a|1:a|1:a|1:a|1:a|1:a|0:')).toBeNull();
  });

  it('changes when any committed field changes', () => {
    const base = statementBytes(S);
    for (const m of [
      { toSeq: '43' }, { entryCount: '41' }, { headHash: 'c'.repeat(64) },
      { merkleRoot: 'd'.repeat(64) }, { takenAt: '2026-08-21T09:16:00Z' },
      { prevSignature: 'x' },
    ]) {
      expect(statementBytes({ ...S, ...m })).not.toBe(base);
    }
  });
});
