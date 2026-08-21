import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import {
  generateSigningKeyPair, loadPrivateKey, loadPublicKey, publicKeyOf,
  signPayload, verifyPayload, publicKeyFingerprint,
} from '@lotmark/security';
import type { Sql } from '../db';

/**
 * Audit anchoring.
 *
 * ── The circle this breaks ──────────────────────────────────────────────────
 *
 * The HMAC chain proves ordering to somebody who trusts the database. It proves
 * nothing to anybody who does not, because an attacker who can rewrite rows can
 * also rewrite the checkpoints attesting to them.
 *
 * An anchor is a signed statement ABOUT the ledger, made by a key the
 * application cannot read, chained to its predecessor, and exported somewhere
 * the database cannot reach. Rewriting the ledger now requires also forging a
 * signature the attacker has no key for, and replacing an exported file they
 * have no access to.
 *
 * ── The signer never signs caller-supplied bytes ────────────────────────────
 *
 * It reads the ledger itself and builds its own statement. If it signed
 * whatever it was handed, a compromised application could hand it a statement
 * about a ledger that never existed, and the signature would be perfectly valid
 * over a lie. This is a deliberate strengthening over the original design and
 * it is why the signer needs its own database access rather than a queue.
 *
 * ── What this proves, and what it does not ──────────────────────────────────
 *
 * PROVES: the ledger at anchor time contained exactly the entries the anchor
 * commits to, in that order.
 *
 * DOES NOT PROVE: anything about entries written since the last anchor. The
 * anchor interval IS the exposure window, and it is reported rather than
 * glossed over.
 *
 * On this machine the anchor key is a mode-0600 file under its own directory,
 * held by a separate process running as a separate database role. That is
 * `dev_file` custody and it is recorded as such. It is a real separation of
 * duty — the API genuinely cannot read the key or write the table — and it is
 * NOT an HSM. Saying so is the difference between a control and a claim.
 */

export const ANCHOR_KEY_VERSION = 'anc-v1';
export const ANCHOR_STATEMENT_VERSION = 1;

export class AnchorKeyStore {
  constructor(private readonly dir: string) {}

  private keyPath(tenantId: string): string {
    return path.join(this.dir, `${tenantId}.${ANCHOR_KEY_VERSION}.pem`);
  }

  read(tenantId: string): string | null {
    const p = this.keyPath(tenantId);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  write(tenantId: string, pem: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = this.keyPath(tenantId);
    writeFileSync(p, pem, { mode: 0o600 });
    chmodSync(p, 0o600);
  }
}

/**
 * A Merkle root over the segment's entry hashes.
 *
 * A head hash alone proves the segment's final state. A root additionally lets
 * a holder prove that ONE entry was included, without being shown the rest of
 * the ledger — which matters when the ledger contains other customers' acts.
 *
 * Odd nodes are promoted rather than duplicated: duplicating the last leaf is
 * the classic CVE-2012-2459 shape, where two different trees produce the same
 * root.
 */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return createHash('sha256').update('').digest('hex');
  let level = leaves.map((l) => createHash('sha256').update(`leaf:${l}`).digest('hex'));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]!);            // promote, never duplicate
      } else {
        next.push(createHash('sha256').update(`node:${level[i]}${level[i + 1]}`).digest('hex'));
      }
    }
    level = next;
  }
  return level[0]!;
}

export interface AnchorStatement {
  readonly version: number;
  readonly tenantId: string;
  readonly fromSeq: string;
  readonly toSeq: string;
  readonly entryCount: string;
  readonly headHash: string;
  readonly merkleRoot: string;
  readonly takenAt: string;
  readonly prevSignature: string | null;
}

/** The exact bytes signed. Length-prefixed so no field can forge a boundary. */
export function statementBytes(s: AnchorStatement): string {
  const lp = (v: string | null) => `${(v ?? '').length}:${v ?? ''}`;
  return [
    `v${s.version}`, lp(s.tenantId), lp(s.fromSeq), lp(s.toSeq), lp(s.entryCount),
    lp(s.headHash), lp(s.merkleRoot), lp(s.takenAt), lp(s.prevSignature),
  ].join('|');
}

export interface AnchorResult {
  readonly tenantId: string;
  readonly created: boolean;
  readonly fromSeq?: string;
  readonly toSeq?: string;
  readonly entryCount?: number;
  readonly reason?: string;
}

/**
 * Anchor everything written since the previous anchor.
 *
 * Runs on the SIGNER's connection, which holds SELECT on the ledger and INSERT
 * on audit_checkpoints, and nothing else. The application role has had those
 * INSERT rights revoked.
 */
export async function anchorTenant(
  tx: Sql,
  args: {
    tenantId: string; tenantName: string;
    keys: AnchorKeyStore; auditKey: string;
    log?: (m: string) => void;
  },
): Promise<AnchorResult> {
  /**
   * The key file and its registration are checked INDEPENDENTLY.
   *
   * Writing a file and inserting a row are not one atomic act. An earlier
   * version treated "the file exists" as proof that the public half was
   * registered; a run that wrote the file and then failed the insert left the
   * next run skipping registration entirely — and it went on to produce a
   * signed anchor whose public key was nowhere, which nobody could verify.
   *
   * A signed statement no one can check is worse than no statement: it looks
   * like evidence.
   */
  let pem = args.keys.read(args.tenantId);
  if (!pem) {
    const kp = generateSigningKeyPair(ANCHOR_KEY_VERSION);
    args.keys.write(args.tenantId, kp.privateKeyPem);
    pem = kp.privateKeyPem;
    args.log?.(`minted anchor key ${ANCHOR_KEY_VERSION} for ${args.tenantName}`);
  }
  const privateKey = loadPrivateKey(pem);

  // Registered? Ask the database, not the filesystem.
  const [registered] = await tx`
    SELECT public_key_pem FROM lotmark.signing_keys
    WHERE tenant_id = ${args.tenantId} AND purpose = 'anchor'
      AND key_version = ${ANCHOR_KEY_VERSION}`;
  if (!registered) {
    const publicPem = publicKeyOf(pem);
    await tx`
      INSERT INTO lotmark.signing_keys
        (tenant_id, key_version, algorithm, public_key_pem, fingerprint, custody,
         purpose, activated_at)
      VALUES (${args.tenantId}, ${ANCHOR_KEY_VERSION}, 'ed25519', ${publicPem},
              ${publicKeyFingerprint(publicPem)}, 'dev_file', 'anchor', now())`;
    args.log?.(`registered the anchor public key for ${args.tenantName}`);
  } else if ((registered as { public_key_pem: string }).public_key_pem.trim() !== publicKeyOf(pem).trim()) {
    // The private key on disk does not match what was registered. Signing with
    // it would produce anchors that fail against the published key.
    return {
      tenantId: args.tenantId, created: false,
      reason: 'the anchor key on disk does not match the registered public key — refusing to sign',
    };
  }

  const [prevRow] = await tx`
    SELECT through_seq, signature FROM lotmark.audit_checkpoints
    WHERE tenant_id = ${args.tenantId} AND signature IS NOT NULL
    ORDER BY through_seq DESC LIMIT 1`;
  const prev = prevRow as { through_seq: string; signature: string } | undefined;
  const fromSeq = prev ? BigInt(prev.through_seq) + 1n : 1n;

  const entries = await tx`
    SELECT seq, entry_hash FROM lotmark.audit_ledger
    WHERE tenant_id = ${args.tenantId} AND seq >= ${String(fromSeq)}::bigint
    ORDER BY seq ASC`;

  if (entries.length === 0) {
    return { tenantId: args.tenantId, created: false, reason: 'nothing new to anchor' };
  }

  const rows = entries.map((e) => e as { seq: string; entry_hash: string });
  const toSeq = BigInt(rows[rows.length - 1]!.seq);

  // Verify the segment BEFORE attesting to it. Signing an unverified segment
  // would produce a valid signature over a broken chain, which is worse than no
  // anchor at all — it would launder the tampering.
  const [check] = await tx`
    SELECT * FROM lotmark.verify_audit_chain(
      ${args.tenantId}, ${String(fromSeq)}::bigint, ${String(toSeq)}::bigint)`;
  const verdict = check as {
    ok: boolean; entries: string; broken_at: string | null; reason: string | null; head_hash: string | null;
  };
  if (!verdict.ok) {
    return {
      tenantId: args.tenantId, created: false,
      reason: `LEDGER_DISCONTINUITY at ${verdict.broken_at}: ${verdict.reason}`,
    };
  }

  const [clock] = await tx`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;

  const statement: AnchorStatement = {
    version: ANCHOR_STATEMENT_VERSION,
    tenantId: args.tenantId,
    fromSeq: String(fromSeq),
    toSeq: String(toSeq),
    entryCount: String(rows.length),
    headHash: verdict.head_hash!,
    merkleRoot: merkleRoot(rows.map((r) => r.entry_hash)),
    takenAt: (clock as { t: string }).t,
    // Chained: removing an anchor is as visible as removing a ledger entry.
    prevSignature: prev?.signature ?? null,
  };

  const payload = statementBytes(statement);
  const signature = signPayload(payload, privateKey);

  await tx`
    INSERT INTO lotmark.audit_checkpoints
      (tenant_id, from_seq, through_seq, head_hash, entry_count, merkle_root,
       signature, key_version, algorithm, prev_checkpoint_signature,
       signed_statement, taken_at)
    VALUES (${args.tenantId}, ${statement.fromSeq}::bigint, ${statement.toSeq}::bigint,
            ${statement.headHash}, ${statement.entryCount}::bigint, ${statement.merkleRoot},
            ${signature}, ${ANCHOR_KEY_VERSION}, 'ed25519', ${statement.prevSignature},
            ${payload}, now())`;

  return {
    tenantId: args.tenantId, created: true,
    fromSeq: statement.fromSeq, toSeq: statement.toSeq, entryCount: rows.length,
  };
}

export interface AnchorVerification {
  readonly ok: boolean;
  readonly anchors: number;
  readonly failedAt?: string;
  readonly reason?: string;
  readonly coversThrough?: string;
  readonly unanchoredEntries?: number;
}

/**
 * Read the fields back out of a signed statement.
 *
 * The statement is the length-prefixed encoding `statementBytes` produced. It
 * is parsed rather than re-derived from the row's columns on purpose: the
 * columns are what an attacker would edit, the statement is what the signature
 * covers.
 */
export function parseStatement(encoded: string): AnchorStatement | null {
  /**
   * Walked using the length prefixes, NOT split on the delimiter.
   *
   * The encoding is length-prefixed exactly so a field may contain '|'.
   * An earlier version split on '|' first, which threw that property away and
   * mis-parsed any statement whose head hash or signature contained one —
   * silently, returning wrong fields rather than failing. Caught by the test
   * that exists for precisely this.
   */
  if (!encoded.startsWith('v')) return null;
  let i = encoded.indexOf('|');
  if (i < 0) return null;
  const version = Number(encoded.slice(1, i));
  if (!Number.isFinite(version)) return null;

  const fields: string[] = [];
  let pos = i + 1;
  for (let f = 0; f < 8; f++) {
    const colon = encoded.indexOf(':', pos);
    if (colon < 0) return null;
    const len = Number(encoded.slice(pos, colon));
    if (!Number.isInteger(len) || len < 0) return null;
    const body = encoded.slice(colon + 1, colon + 1 + len);
    if (body.length !== len) return null;
    fields.push(body);
    pos = colon + 1 + len;
    // Every field but the last is followed by the delimiter.
    if (f < 7) {
      if (encoded[pos] !== '|') return null;
      pos += 1;
    }
  }
  if (pos !== encoded.length) return null;

  const [tenantId, fromSeq, toSeq, entryCount, headHash, root, takenAt, prevSig] = fields;
  return {
    version,
    tenantId: tenantId!, fromSeq: fromSeq!, toSeq: toSeq!,
    entryCount: entryCount!, headHash: headHash!, merkleRoot: root!,
    takenAt: takenAt!, prevSignature: prevSig === '' ? null : prevSig!,
  };
}

/**
 * Verify every anchor, and report the exposure window.
 *
 * Needs only the PUBLIC key, so a verifier can run this without any ability to
 * create an anchor.
 */
export async function verifyAnchors(
  tx: Sql, tenantId: string,
): Promise<AnchorVerification> {
  const [keyRow] = await tx`
    SELECT public_key_pem FROM lotmark.signing_keys
    WHERE tenant_id = ${tenantId} AND purpose = 'anchor' AND key_version = ${ANCHOR_KEY_VERSION}`;
  const keyPem = (keyRow as { public_key_pem: string } | undefined)?.public_key_pem;
  if (!keyPem) return { ok: false, anchors: 0, reason: 'no anchor key is registered' };
  const publicKey = loadPublicKey(keyPem);

  const anchors = await tx`
    SELECT from_seq, through_seq, signature, signed_statement, prev_checkpoint_signature
    FROM lotmark.audit_checkpoints
    WHERE tenant_id = ${tenantId} AND signature IS NOT NULL
    ORDER BY through_seq ASC`;

  let expectedPrev: string | null = null;
  for (const a of anchors) {
    const anchor = a as {
      from_seq: string; through_seq: string; signature: string;
      signed_statement: string; prev_checkpoint_signature: string | null;
    };

    if (!verifyPayload(anchor.signed_statement, anchor.signature, publicKey)) {
      return {
        ok: false, anchors: anchors.length, failedAt: anchor.through_seq,
        reason: 'anchor signature does not verify — the statement was altered',
      };
    }
    if (anchor.prev_checkpoint_signature !== expectedPrev) {
      // An anchor was removed or reordered. The chain of anchors is what makes
      // deleting one as visible as deleting a ledger entry.
      return {
        ok: false, anchors: anchors.length, failedAt: anchor.through_seq,
        reason: 'anchor chain is broken — a preceding anchor is missing or was reordered',
      };
    }

    /**
     * THE STEP THAT MATTERS.
     *
     * A valid signature over a statement proves the STATEMENT was not altered.
     * It says nothing about whether the ledger still matches what the statement
     * described — and that is the entire question.
     *
     * An earlier version of this function stopped at the signature check, which
     * would have reported "anchors verify" over a ledger whose entries had been
     * rewritten underneath them. Recomputing the root and head from the CURRENT
     * ledger and comparing against what was signed is what turns an anchor from
     * a decoration into evidence.
     */
    const current = await tx`
      SELECT seq, entry_hash FROM lotmark.audit_ledger
      WHERE tenant_id = ${tenantId}
        AND seq >= ${anchor.from_seq}::bigint AND seq <= ${anchor.through_seq}::bigint
      ORDER BY seq ASC`;
    const rows = current.map((r) => r as { seq: string; entry_hash: string });

    const parsedStatement = parseStatement(anchor.signed_statement);
    if (!parsedStatement) {
      return {
        ok: false, anchors: anchors.length, failedAt: anchor.through_seq,
        reason: 'the signed statement could not be parsed',
      };
    }

    if (String(rows.length) !== parsedStatement.entryCount) {
      return {
        ok: false, anchors: anchors.length, failedAt: anchor.through_seq,
        reason: `LEDGER_DISCONTINUITY — the anchor attests to ${parsedStatement.entryCount} ` +
          `entries in seq ${anchor.from_seq}–${anchor.through_seq}, the ledger now holds ${rows.length}`,
      };
    }

    const recomputedRoot = merkleRoot(rows.map((r) => r.entry_hash));
    if (recomputedRoot !== parsedStatement.merkleRoot) {
      return {
        ok: false, anchors: anchors.length, failedAt: anchor.through_seq,
        reason: 'LEDGER_DISCONTINUITY — entries in this anchored range have been altered ' +
          'since the anchor was made',
      };
    }

    const head = rows[rows.length - 1]?.entry_hash;
    if (head !== undefined && head !== parsedStatement.headHash) {
      return {
        ok: false, anchors: anchors.length, failedAt: anchor.through_seq,
        reason: 'LEDGER_DISCONTINUITY — the head of this anchored range does not match',
      };
    }

    /**
     * And the chain itself, over the same range.
     *
     * The Merkle root commits to ENTRY HASHES. It catches an entry added,
     * removed or reordered — but NOT an entry whose content was edited while
     * its stored hash was left alone, because the leaves are unchanged.
     *
     * Found by testing exactly that attack: rewriting `detail` on an anchored
     * entry passed root, head and signature checks and reported "anchors
     * verify". The HMAC chain is what recomputes the hash FROM the content, so
     * the two checks are complementary and neither is sufficient alone.
     */
    const [chain] = await tx`
      SELECT * FROM lotmark.verify_audit_chain(
        ${tenantId}, ${anchor.from_seq}::bigint, ${anchor.through_seq}::bigint)`;
    const chainVerdict = chain as {
      ok: boolean; broken_at: string | null; reason: string | null;
    };
    if (!chainVerdict.ok) {
      return {
        ok: false, anchors: anchors.length,
        failedAt: chainVerdict.broken_at ?? anchor.through_seq,
        reason: `LEDGER_DISCONTINUITY — ${chainVerdict.reason} (within an anchored range, ` +
          'so this is provably a change made after the anchor was signed)',
      };
    }

    expectedPrev = anchor.signature;
  }

  const last = anchors[anchors.length - 1] as { through_seq: string } | undefined;
  const [headRow] = await tx`
    SELECT COALESCE(max(seq), 0)::text AS s FROM lotmark.audit_ledger WHERE tenant_id = ${tenantId}`;
  const head = BigInt((headRow as { s: string }).s);
  const covered = last ? BigInt(last.through_seq) : 0n;

  return {
    ok: true, anchors: anchors.length,
    coversThrough: String(covered),
    // The exposure window, stated rather than glossed over.
    unanchoredEntries: Number(head - covered),
  };
}
