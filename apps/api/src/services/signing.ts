import {
  signaturePayload, canonicalMaterial, CANONICAL_VERSION,
  type SignableRecord, type SignatureMeaning, type CompetenceBasis,
} from '@lotmark/domain';
import { signPayload, verifyPayload, payloadDigest } from '@lotmark/security';
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
              ${args.timeSource}, ${args.region}, ${bindingHash}, ${signatureValue}, 'ed25519',
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

export interface VerificationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly signedBy?: string;
  readonly signedAt?: string;
  readonly meaning?: string;
  readonly keyVersion?: string;
  readonly custody?: string;
}

/**
 * Verify a stored signature against the record AS IT IS NOW.
 *
 * This is the check that convicts. If the record was altered after signing, the
 * canonical material no longer matches what was signed and verification fails —
 * which is the entire point of §11.70 and the thing the prototype's unkeyed
 * digest could not deliver.
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
    SELECT s.*, u.display_name, k.custody
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
    signed_at: string; signature_value: string | null; key_version: string;
    canonical_version: string; custody: string | null;
  } | undefined;

  if (!sig) return { ok: false, reason: 'no signature is bound to this record' };
  if (!sig.signature_value) return { ok: false, reason: 'the signature carries no cryptographic value' };

  if (sig.canonical_version !== String(CANONICAL_VERSION)) {
    // Verifying a v1 signature with a v2 canonicaliser would fail for a reason
    // that has nothing to do with tampering. Say so plainly.
    return {
      ok: false,
      reason: `signature uses canonical format v${sig.canonical_version}, this build canonicalises v${CANONICAL_VERSION}`,
    };
  }

  const publicKey = await keys.publicKeyFor(tx, args.tenantId, sig.key_version);
  if (!publicKey) return { ok: false, reason: `signing key ${sig.key_version} is not registered` };

  const signedAt = normaliseInstant(sig.signed_at);
  const payload = signaturePayload({
    signable: args.signable,
    signerUserId: sig.signer_user_id,
    meaning: sig.meaning as SignatureMeaning,
    signedAt,
  });

  const ok = verifyPayload(payload, sig.signature_value, publicKey);
  return ok
    ? {
        ok: true, signedBy: sig.display_name, signedAt,
        meaning: sig.meaning, keyVersion: sig.key_version,
        custody: sig.custody ?? 'unknown',
      }
    : { ok: false, reason: 'the record was altered after it was signed' };
}

/** Render a stored instant in the exact form the payload was built with. */
function normaliseInstant(value: string): string {
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export { canonicalMaterial };
