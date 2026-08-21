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
export type SignableKind = 'study' | 'value' | 'certificate' | 'lot';

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

export type SignableRecord =
  | { kind: 'study'; record: SignableStudy }
  | { kind: 'value'; record: SignableValue }
  | { kind: 'certificate'; record: SignableCertificateIssue }
  | { kind: 'lot'; record: SignableLot };

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
