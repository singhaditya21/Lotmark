import {
  signaturePayload, canonicalMaterial, CANONICAL_VERSION,
  type SignableRecord, type SignatureMeaning, type CompetenceBasis,
} from '@lotmark/domain';
import { signPayload, verifyPayload, payloadDigest, SIGNING_ALGORITHM } from '@lotmark/security';
import type { Sql } from '../db';
import type { ActiveKey, KeyProvider } from './keys';
import { signingWindowOpen, type SessionRow } from './sessions';

/**
 * Applying an electronic signature.
 *
 * 21 CFR Part 11 obligations this satisfies, and how:
 *
 *  §11.50  The signature manifests the signer, the instant, and the MEANING —
 *          all three are stored, and the meaning is chosen by the signer.
 *  §11.70  The signature is bound to its record: the Ed25519 signature covers
 *          the canonical material, so it cannot be excised, copied to another
 *          record, relabelled, or transferred to another signer.
 *  §11.200 Two identification components are required. Outside a continuous
 *          signing session, both must be supplied again — enforced by the
 *          step-up window, not by trusting the client to ask.
 *
 * ISO 17034 6.3 adds the competence basis, FROZEN onto the signature. Editing
 * the competence record afterwards cannot rewrite the validity of a past act.
 */

export class SigningError extends Error {
  constructor(message: string, readonly code: SigningErrorCode) {
    super(message);
    this.name = 'SigningError';
  }
}

export type SigningErrorCode =
  | 'step_up_required'
  | 'competence_basis_missing'
  | 'competence_basis_invalid'
  | 'already_signed';

/**
 * A signing refusal that must DISCARD the record it was going to sign.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 *
 * The record-creating routes insert their row and then sign it, both inside one
 * transaction. When signing was refused they caught `SigningError` and
 * RETURNED a status object from inside the transaction callback — and returning
 * resolves the callback, which COMMITS. Only throwing rolls back.
 *
 * So a reissue that hit the ordinary step-up prompt — the one every user meets
 * on their first signing of a session — committed a new certificate issue with
 * no signature, no rendered PDF and no verification token. That issue then
 * became the CURRENT one, superseding a real signed document with a phantom
 * that a holder verifying the certificate would find nothing behind. Every
 * retry made another. The same shape applied to releasing a lot and to issuing
 * a certificate.
 *
 * Throwing this instead rolls the whole thing back. The refusal is still
 * recorded — see `recordSigningRefusal`, which writes it on a FRESH
 * transaction, because an audit entry written inside the doomed one would roll
 * back with it and the evidence that a control fired would be lost.
 */
export class SigningRejection extends Error {
  constructor(
    readonly httpStatus: 401 | 409,
    readonly code: SigningErrorCode,
    message: string,
    /** What was being signed, for the refusal record. */
    readonly subject: { readonly table: string; readonly label: string },
  ) {
    super(message);
    this.name = 'SigningRejection';
  }
}

/**
 * Re-throw a signing failure so its transaction rolls back.
 *
 * Called from the catch around `applySignature`. Anything that is not a
 * SigningError is re-thrown untouched — an unexpected failure must not be
 * quietly turned into a tidy 409.
 */
export function rejectSigning(
  e: unknown,
  subject: { readonly table: string; readonly label: string },
): never {
  if (e instanceof SigningError) {
    throw new SigningRejection(
      e.code === 'step_up_required' ? 401 : 409,
      e.code,
      e.message,
      subject,
    );
  }
  throw e;
}

export interface SignatureRecord {
  readonly id: string;
  readonly signatureValue: string;
  readonly bindingHash: string;
  readonly keyVersion: string;
  readonly signedAt: string;
  readonly meaning: SignatureMeaning;
}

export async function applySignature(
  tx: Sql,
  args: {
    readonly tenantId: string;
    readonly signable: SignableRecord;
    readonly subjectId: string;
    readonly signerUserId: string;
    readonly meaning: SignatureMeaning;
    readonly session: SessionRow;
    readonly signingWindowMinutes: number;
    readonly competenceBasis: CompetenceBasis | null;
    readonly requiresCompetence: boolean;
    readonly key: ActiveKey;
    readonly timeSource: string;
    readonly region: string;
  },
): Promise<SignatureRecord> {
  /**
   * §11.200(a)(1)(ii). The window is checked HERE, at the moment of signing,
   * rather than at the route. A signing that arrives after the window closed
   * must be refused even if the request was authorised when it was composed.
   */
  if (!signingWindowOpen(args.session, args.signingWindowMinutes)) {
    throw new SigningError(
      'Re-enter your password and authenticator code before signing.',
      'step_up_required',
    );
  }

  if (args.requiresCompetence) {
    if (!args.competenceBasis) {
      throw new SigningError(
        'No competence authorisation was resolved for this act.',
        'competence_basis_missing',
      );
    }
    const b = args.competenceBasis;
    if (!(b.validFrom <= b.checkedOn && b.validTo >= b.checkedOn)) {
      throw new SigningError(
        `The competence authorisation does not cover ${b.checkedOn}.`,
        'competence_basis_invalid',
      );
    }
  }

  /**
   * The instant comes from the DATABASE clock, not this process.
   *
   * Two API instances can disagree by seconds; the ledger and the signature
   * must not. Taking the time from the same source that orders the chain keeps
   * a signature's timestamp consistent with its audit entry.
   */
  const [clock] = await tx`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
  const signedAt = (clock as { t: string }).t;

  const payload = signaturePayload({
    signable: args.signable,
    signerUserId: args.signerUserId,
    meaning: args.meaning,
    signedAt,
  });

  const signatureValue = signPayload(payload, args.key.privateKey);
  const bindingHash = payloadDigest(payload);

  try {
    const [row] = await tx`
      INSERT INTO lotmark.signatures
        (tenant_id, subject_kind, subject_id, signer_user_id, meaning, signed_at,
         time_source, region, binding_hash, signature_value, algorithm,
         canonical_version, key_version,
         competence_record_id, competence_activity, competence_valid_from,
         competence_valid_to, competence_checked_on)
      VALUES (${args.tenantId}, ${args.signable.kind}, ${args.subjectId}, ${args.signerUserId},
              ${args.meaning}, ${signedAt}::timestamptz,
              ${args.timeSource}, ${args.region}, ${bindingHash}, ${signatureValue},
              ${SIGNING_ALGORITHM},
              ${String(CANONICAL_VERSION)}, ${args.key.keyVersion},
              ${args.competenceBasis?.competenceRecordId ?? null},
              ${args.competenceBasis?.activity ?? null},
              ${args.competenceBasis?.validFrom ?? null},
              ${args.competenceBasis?.validTo ?? null},
              ${args.competenceBasis?.checkedOn ?? null})
      RETURNING id`;

    return {
      id: (row as { id: string }).id,
      signatureValue, bindingHash,
      keyVersion: args.key.keyVersion,
      signedAt, meaning: args.meaning,
    };
  } catch (e) {
    if (String((e as { message?: string }).message ?? '')
      .includes('signatures_one_per_subject_signer_meaning')) {
      throw new SigningError(
        'You have already signed this record with that meaning.',
        'already_signed',
      );
    }
    throw e;
  }
}

/**
 * What a verification ESTABLISHED — which is not the same question as whether
 * it came out true.
 *
 * ── The defect this replaced ────────────────────────────────────────────────
 *
 * The result was a bare `{ ok, reason }`. `ok` has two values and there are
 * four answers, so every outcome that was not a clean pass collapsed into one
 * — and the reason attached to that collapse read "the record was altered
 * after it was signed". That sentence is a finding an assessor acts on: it
 * says somebody tampered with a Part 11 electronic signature.
 *
 * `signatures.algorithm` is free text. 0003 constrains
 * `signing_keys.algorithm` to ed25519; nothing constrains the signature's copy,
 * which only ever carried a default. So a row can hold an algorithm this build
 * does not implement — written by a newer version, retired since, or simply
 * mistyped — and none of those three is tampering.
 *
 *  valid        — checked, and it holds.
 *  invalid      — checked, and it does not. The ONLY verdict that says the
 *                 record no longer matches what was signed.
 *  unverifiable — NOT checked, because this build cannot check it. Says
 *                 nothing about the record in either direction.
 *  unsigned     — there is nothing bound to the record to check.
 */
export type VerificationStatus = 'valid' | 'invalid' | 'unverifiable' | 'unsigned';

export interface VerificationResult {
  /** The verdict. Only `invalid` implicates the record. */
  readonly status: VerificationStatus;
  /**
   * True for `valid` and nothing else.
   *
   * Kept so a caller that reads only this fails CLOSED — a signature this
   * build could not check is not a signature it verified. It is no longer
   * sufficient on its own: `ok: false` now spans three different incidents,
   * and only one of them is worth waking anybody up for.
   */
  readonly ok: boolean;
  readonly reason?: string;
  readonly signedBy?: string;
  readonly signedAt?: string;
  readonly meaning?: string;
  readonly keyVersion?: string;
  readonly custody?: string;
}

/**
 * Build every verdict that is not `valid`, so `ok` cannot drift out of step
 * with `status` as branches are added.
 */
function inconclusive(
  status: Exclude<VerificationStatus, 'valid'>, reason: string,
): VerificationResult {
  return { status, ok: false, reason };
}

/**
 * Show a stored free-text value in a reason string.
 *
 * Quoted, because one of the incidents this has to distinguish is a typo —
 * `'ed25519 '` and `'Ed25519'` are invisible differences unquoted and obvious
 * quoted. Clipped, because the column takes anything and a reason string ends
 * up in an HTTP response an operator reads.
 */
function quoted(value: string): string {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
}

/**
 * Verify a stored signature against the record AS IT IS NOW.
 *
 * This is the check that convicts. If the record was altered after signing, the
 * canonical material no longer matches what was signed and verification fails —
 * which is the entire point of §11.70 and the thing the prototype's unkeyed
 * digest could not deliver.
 *
 * It convicts only where it has actually checked. Every condition that would
 * stop the check from happening at all is ruled out first and returned as
 * `unverifiable`, so the one sentence that names alteration is reached only
 * when the cryptography, and nothing else, said no. See `VerificationStatus`.
 */
export async function verifyStoredSignature(
  tx: Sql,
  keys: KeyProvider,
  args: {
    readonly tenantId: string;
    readonly signable: SignableRecord;
    readonly subjectId: string;
  },
): Promise<VerificationResult> {
  const [row] = await tx`
    SELECT s.*,
           -- The instant, rendered by POSTGRES in the exact form the payload
           -- was built with -- see the matching to_char in applySignature. The
           -- driver's own rendering of a timestamptz follows the session
           -- timezone, and reconstructing this string from it in JS was where a
           -- UTC session broke: postgres renders a zero offset as plus-zero-zero,
           -- which Date.parse rejects as NaN, so verification threw "Invalid
           -- time value" on every server not on a half-hour offset. Read it back
           -- the way it was written and there is nothing to reconstruct.
           to_char(s.signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS signed_at_utc,
           u.display_name, k.custody
    FROM lotmark.signatures s
    JOIN lotmark.users u ON u.id = s.signer_user_id
    LEFT JOIN lotmark.signing_keys k
      ON k.tenant_id = s.tenant_id AND k.key_version = s.key_version
    WHERE s.tenant_id = ${args.tenantId}
      AND s.subject_kind = ${args.signable.kind}
      AND s.subject_id = ${args.subjectId}
    ORDER BY s.signed_at DESC LIMIT 1`;

  const sig = row as {
    signer_user_id: string; display_name: string; meaning: string;
    signed_at_utc: string; signature_value: string | null; key_version: string;
    algorithm: string; canonical_version: string; custody: string | null;
  } | undefined;

  if (!sig) return inconclusive('unsigned', 'no signature is bound to this record');

  if (!sig.signature_value) {
    // Unreachable for anything written since 0003 added `signature_has_a_value`;
    // kept for rows that predate it. `unsigned` rather than `invalid`: a row
    // with no cryptographic value binds nothing, which is the same practical
    // state as no row at all and is not evidence that anything was altered.
    return inconclusive('unsigned', 'a signature row exists but carries no cryptographic value');
  }

  if (sig.algorithm !== SIGNING_ALGORITHM) {
    /**
     * Checked BEFORE verifying, and this order is the point.
     *
     * The algorithm used not to be read at all — the query says `s.*` but the
     * cast above omitted the column, so an ed25519 verification was attempted
     * on every row whatever it claimed to be. Both directions were wrong, and
     * both were observed:
     *
     *   algorithm 'ml-dsa-65', bytes that are not an ed25519 signature
     *     → `{ ok: false, reason: 'the record was altered after it was signed' }`
     *       An accusation of tampering, over a signature nobody had checked.
     *
     *   algorithm 'ml-dsa-65', bytes that ARE a valid ed25519 signature
     *     → `{ ok: true, signedBy: 'Dr. Asha Pillai', … }`
     *       A signature this build cannot check, presented as one it had.
     *
     * Inspecting the algorithm after verifying would fix only the first.
     */
    return inconclusive(
      'unverifiable',
      `the signature is stored under algorithm ${quoted(sig.algorithm)}; ` +
      `this build can verify ${SIGNING_ALGORITHM} only, so it cannot check this signature`,
    );
  }

  if (sig.canonical_version !== String(CANONICAL_VERSION)) {
    // Verifying a v1 signature with a v2 canonicaliser would fail for a reason
    // that has nothing to do with tampering. Say so plainly.
    return inconclusive(
      'unverifiable',
      `signature uses canonical format v${sig.canonical_version}, this build canonicalises v${CANONICAL_VERSION}`,
    );
  }

  const publicKey = await keys.publicKeyFor(tx, args.tenantId, sig.key_version);
  if (!publicKey) {
    // The key is missing, not the record's integrity. Nothing can be concluded
    // about the record until somebody restores or accounts for the key.
    return inconclusive('unverifiable', `signing key ${sig.key_version} is not registered`);
  }

  const signedAt = sig.signed_at_utc;
  const payload = signaturePayload({
    signable: args.signable,
    signerUserId: sig.signer_user_id,
    meaning: sig.meaning as SignatureMeaning,
    signedAt,
  });

  /**
   * Everything that could make this fail for a reason OTHER than the record
   * changing has been ruled out above. Only now does a false result mean what
   * the sentence says.
   */
  const verified = verifyPayload(payload, sig.signature_value, publicKey);
  return verified
    ? {
        status: 'valid', ok: true, signedBy: sig.display_name, signedAt,
        meaning: sig.meaning, keyVersion: sig.key_version,
        custody: sig.custody ?? 'unknown',
      }
    : inconclusive('invalid', 'the record was altered after it was signed');
}

export { canonicalMaterial };
