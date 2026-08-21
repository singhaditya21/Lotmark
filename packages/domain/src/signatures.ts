/**
 * Electronic signatures — 21 CFR Part 11.
 *
 * Three obligations shape this module:
 *
 *  §11.50  A signature must manifest the SIGNER, the DATE AND TIME, and the
 *          MEANING of the signing. Meaning is chosen by the signer, never
 *          inferred from context.
 *  §11.70  The signature must be BOUND to its record so it cannot be excised,
 *          copied or transferred to another record.
 *  §11.200 Signing uses at least two distinct identification components, and
 *          all components must be supplied for a signing performed outside a
 *          continuous session.
 *
 * This module owns only the part that must be deterministic and identical
 * everywhere: the CANONICAL MATERIAL of a record — the exact byte sequence a
 * signature commits to. The cryptography that turns material into a binding
 * lives in the API layer, because it needs a server-held key that must never
 * reach a browser.
 */

/** The meanings a signer may attach. §11.50(a)(3). */
export const SIGNATURE_MEANINGS = {
  authorship: 'Authorship — I produced this record',
  review: 'Review — I have reviewed this record',
  approval: 'Approval — I approve this record',
  responsibility: 'Responsibility — I accept responsibility for this record',
} as const satisfies Record<string, string>;

export type SignatureMeaning = keyof typeof SIGNATURE_MEANINGS;

export const ALL_SIGNATURE_MEANINGS = Object.keys(SIGNATURE_MEANINGS) as SignatureMeaning[];

export function isSignatureMeaning(v: string): v is SignatureMeaning {
  return v in SIGNATURE_MEANINGS;
}

/** The kinds of record that can carry a signature. */
export type SignableKind =
  | 'study' | 'value' | 'certificate' | 'lot' | 'config_version' | 'state_transition';

/**
 * The canonical material version.
 *
 * Stored on every signature. If the canonical form ever has to change, old
 * signatures keep verifying under the version they were made with, instead of
 * every historical signature appearing to have been tampered with. The
 * prototype had no version and could never have changed its format.
 */
export const CANONICAL_VERSION = 1 as const;

export interface SignableStudy {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly equipmentIds: readonly string[];
  readonly uncertainty: number;
}

export interface SignableValue {
  readonly id: string;
  readonly projectId: string;
  readonly property: string;
  readonly value: number;
  readonly unit: string;
  readonly coverageFactor: number;
}

export interface SignableCertificateIssue {
  readonly certificateId: string;
  readonly lotId: string;
  readonly issueNumber: number;
  readonly value: number;
  readonly expandedUncertainty: number;
}

export interface SignableLot {
  readonly id: string;
  readonly lotCode: string;
  readonly projectId: string;
  readonly expiryDate: string;
}

/**
 * A configuration version being published.
 *
 * The material is the version's IDENTITY plus a digest of exactly what changed,
 * not the whole configuration. Two reasons: the configuration can be large, and
 * what the signer is attesting to is the CHANGE they reviewed — a signature
 * over the whole document would still verify after an unrelated entry moved,
 * and would fail to verify a change they did approve if anything else shifted.
 *
 * `changeDigest` is computed from the same diff shown on the approval screen,
 * so the signature covers precisely what was on it.
 */
export interface SignableConfigVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly basedOnVersionId: string | null;
  readonly changeDigest: string;
  readonly changeCount: number;
}

/**
 * A move through a configured workflow.
 *
 * One shape for every entity rather than one per entity, because which moves
 * demand a signature is now the TENANT'S to declare — a per-entity shape would
 * mean a code change every time somebody ticked the box on a new machine, which
 * is the opposite of what configuring it is for.
 *
 * The material commits to the entity, the record, both states and the stated
 * reason. All five are what the signature is about: "I attest that this CAPA
 * moved from investigation to closed, for this reason." Omitting the reason
 * would let the same signature stand over a different justification.
 */
export interface SignableStateTransition {
  readonly entity: string;
  readonly recordId: string;
  readonly code: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export type SignableRecord =
  | { kind: 'study'; record: SignableStudy }
  | { kind: 'value'; record: SignableValue }
  | { kind: 'certificate'; record: SignableCertificateIssue }
  | { kind: 'lot'; record: SignableLot }
  | { kind: 'config_version'; record: SignableConfigVersion }
  | { kind: 'state_transition'; record: SignableStateTransition };

/** Escape field separators so no field can impersonate a boundary. */
function field(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * The exact string a signature commits to.
 *
 * Every field that an assessor would consider material to the record is
 * included. A field NOT included here can be edited after signing without
 * breaking verification — so the choice of fields is a compliance decision,
 * not a convenience. Equipment ids are sorted so that a reordering of the same
 * set is not treated as a different record.
 */
export function canonicalMaterial(signable: SignableRecord): string {
  const v = `v${CANONICAL_VERSION}`;
  switch (signable.kind) {
    case 'study': {
      const r = signable.record;
      return [
        v, 'study', field(r.id), field(r.projectId), field(r.type),
        field([...r.equipmentIds].sort().join(',')), field(r.uncertainty),
      ].join('|');
    }
    case 'value': {
      const r = signable.record;
      return [
        v, 'value', field(r.id), field(r.projectId), field(r.property),
        field(r.value), field(r.unit), field(r.coverageFactor),
      ].join('|');
    }
    case 'certificate': {
      const r = signable.record;
      return [
        v, 'certificate', field(r.certificateId), field(r.lotId),
        field(r.issueNumber), field(r.value), field(r.expandedUncertainty),
      ].join('|');
    }
    case 'lot': {
      const r = signable.record;
      return [
        v, 'lot', field(r.id), field(r.lotCode), field(r.projectId), field(r.expiryDate),
      ].join('|');
    }
    case 'config_version': {
      const r = signable.record;
      return [
        v, 'config_version', field(r.id), field(r.versionNumber),
        field(r.basedOnVersionId ?? ''), field(r.changeDigest), field(r.changeCount),
      ].join('|');
    }
    case 'state_transition': {
      const r = signable.record;
      return [
        v, 'state_transition', field(r.entity), field(r.recordId), field(r.code),
        field(r.from), field(r.to), field(r.reason),
      ].join('|');
    }
  }
}

/**
 * The full payload committed to by the binding: the record's material, plus who
 * signed it, with what meaning, and when. Binding the signer and meaning is what
 * stops a valid signature being transferred to another record or re-labelled
 * with a different meaning (§11.70).
 */
export function signaturePayload(args: {
  readonly signable: SignableRecord;
  readonly signerUserId: string;
  readonly meaning: SignatureMeaning;
  /** RFC 3339 UTC instant, from the server's trusted time source. */
  readonly signedAt: string;
}): string {
  return [
    canonicalMaterial(args.signable),
    field(args.signerUserId),
    field(args.meaning),
    field(args.signedAt),
  ].join('|');
}

/**
 * The competence authorisation a signature relied on, frozen at signing time.
 *
 * ISO 17034 6.3 asks whether the signer was authorised ON THE DAY. Editing or
 * withdrawing the competence record afterwards must not retroactively invalidate
 * past acts, nor silently legitimise them — so the basis is copied onto the
 * signature rather than joined to at read time.
 */
export interface CompetenceBasis {
  readonly competenceRecordId: string;
  readonly activity: string;
  readonly validFrom: string;
  readonly validTo: string;
  /** The date the check was performed against. */
  readonly checkedOn: string;
  readonly personUserId: string;
}

export function isBasisValid(b: CompetenceBasis | null | undefined): boolean {
  if (!b) return false;
  return b.validFrom <= b.checkedOn && b.validTo >= b.checkedOn;
}


/**
 * Acts that ALWAYS manifest a signature, whatever a tenant configures.
 *
 * The floor, not the default. Configuration may add a signature requirement to
 * a move; it may never take one of these away. 21 CFR 11 §11.50 makes signing
 * these acts the point of the record, and a tenant that could switch it off
 * would be configuring its way out of the regulation rather than into it — so
 * `publicationProblems()` refuses a workflow that tries.
 *
 * ── `lot:release` is here because two places disagreed ──────────────────────
 *
 * This list lived in `defaults.ts` as `SIGNATURE_REQUIRED`, described as "not
 * configurable downward" and read by nothing but the derivation. Meanwhile the
 * release route hardcoded `requiresSignature: true`. So the routes demanded a
 * signature for releasing a lot and the derived configuration said it needed
 * none — two sources of truth for the same question, disagreeing, with the
 * comment claiming the weaker one was authoritative. Found when making the
 * routes read the configured value: doing so naively would have REMOVED the
 * signature from lot release.
 *
 * The route was right. Releasing a lot puts material on the catalogue under a
 * certificate, and it is signed.
 */
export const ALWAYS_SIGNED = [
  'study:sign', 'value:assign', 'value:authorise',
  'cert:issue', 'cert:reissue', 'lot:release',
] as const;

export function alwaysSigned(permission: string): boolean {
  return (ALWAYS_SIGNED as readonly string[]).includes(permission);
}
