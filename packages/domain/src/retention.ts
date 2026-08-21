/**
 * Retention schedule.
 *
 * Four regimes disagree. DPDP says minimise. CERT-In says 180 days held in
 * India. 21 CFR Part 11 says as long as the record. ISO 17034 says the life of
 * the material. One global policy cannot satisfy all four, so retention is set
 * PER RECORD CLASS and the conflict is resolved in the open.
 *
 * This is what lets the producer refuse a DPDP erasure request and give a
 * lawful reason: a customer cannot erase a competence record that backs a
 * signature, or an order line that makes a certificate holder list computable.
 */
export interface RetentionClass {
  readonly id: string;
  readonly recordClass: string;
  readonly drivenBy: string;
  readonly minimum: string;
  readonly maximum: string;
  readonly conflictResolution: string;
  /** True when the class contains personal data subject to DPDP. */
  readonly personalData: boolean;
  /** True when copies must remain within India (CERT-In). */
  readonly indiaResident: boolean;
  /** True when an erasure request must be refused while the record is live. */
  readonly erasureRefusable: boolean;
}

export const RETENTION_SCHEDULE = [
  {
    id: 'audit_ledger_entry',
    recordClass: 'Audit ledger entry',
    drivenBy: 'CERT-In 2022 · ISO 17034 §8.4',
    minimum: '180 days minimum, in India',
    maximum: '10 years',
    conflictResolution: 'Longest driver wins; region-pinned so the CERT-In copy never leaves India',
    personalData: true, indiaResident: true, erasureRefusable: true,
  },
  {
    id: 'electronic_signature',
    recordClass: 'Electronic signature',
    drivenBy: '21 CFR 11 §11.10(e)',
    minimum: 'As long as the signed record',
    maximum: 'Life of the record + 10 years',
    conflictResolution: 'Cannot be erased under DPDP while the record it binds is live',
    personalData: true, indiaResident: false, erasureRefusable: true,
  },
  {
    id: 'study_and_property_value',
    recordClass: 'Study and property value',
    drivenBy: 'ISO 17034 §7.5–7.8',
    minimum: 'Life of the material + 5 years',
    maximum: 'Indefinite',
    conflictResolution: 'Scientific record, not personal data',
    personalData: false, indiaResident: false, erasureRefusable: true,
  },
  {
    id: 'certificate_issue',
    recordClass: 'Certificate issue',
    drivenBy: 'ISO Guide 31 · Part 11',
    minimum: 'Life of the lot + 10 years',
    maximum: 'Indefinite',
    conflictResolution: 'Every issue retained; reissue never overwrites',
    personalData: false, indiaResident: false, erasureRefusable: true,
  },
  {
    id: 'order_and_allocation',
    recordClass: 'Order and allocation',
    drivenBy: 'Tax law · ISO 17034 §7.10',
    minimum: '8 years',
    maximum: '8 years',
    conflictResolution: 'Needed to compute the certificate holder list',
    personalData: true, indiaResident: false, erasureRefusable: true,
  },
  {
    id: 'customer_contact_data',
    recordClass: 'Customer contact data',
    drivenBy: 'DPDP Act 2023',
    minimum: 'While the purpose is live',
    maximum: 'Purpose end + 90 days',
    conflictResolution: 'Minimised: erased once no order or entitlement is open',
    personalData: true, indiaResident: false, erasureRefusable: false,
  },
  {
    id: 'consent_artefact',
    recordClass: 'Consent artefact',
    drivenBy: 'DPDP Rules 2025',
    minimum: 'Life of consent + 3 years',
    maximum: 'Life of consent + 3 years',
    conflictResolution: 'Evidence that processing was lawful outlives the consent itself',
    personalData: true, indiaResident: false, erasureRefusable: true,
  },
  {
    id: 'competence_record',
    recordClass: 'Competence record',
    drivenBy: 'ISO 17034 §6.3',
    minimum: 'Life of every signature it backs',
    maximum: 'Indefinite',
    conflictResolution: 'Cannot be deleted; superseding is an edit, not a removal',
    personalData: true, indiaResident: false, erasureRefusable: true,
  },
  {
    id: 'session_and_access_log',
    recordClass: 'Session and access log',
    drivenBy: 'CERT-In 2022',
    minimum: '180 days, in India',
    maximum: '13 months',
    conflictResolution: 'Security telemetry, no scientific value beyond a year',
    personalData: true, indiaResident: true, erasureRefusable: true,
  },
] as const satisfies readonly RetentionClass[];

export type RetentionClassId = (typeof RETENTION_SCHEDULE)[number]['id'];

export function retentionClass(id: RetentionClassId): RetentionClass {
  const r = RETENTION_SCHEDULE.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown retention class: ${id}`);
  return r;
}

/** Classes whose deletion must be refused while the record is live. */
export const ERASURE_REFUSABLE: readonly RetentionClassId[] =
  RETENTION_SCHEDULE.filter((r) => r.erasureRefusable).map((r) => r.id);

/** Classes that must not leave India. */
export const INDIA_RESIDENT: readonly RetentionClassId[] =
  RETENTION_SCHEDULE.filter((r) => r.indiaResident).map((r) => r.id);


/**
 * The statutory MINIMUM, in days, per class.
 *
 * A floor, and law rather than policy — a tenant may retain longer and never
 * shorter. Kept beside the schedule it comes from rather than in `defaults.ts`,
 * because a number that encodes a regulation belongs next to the regulation it
 * encodes; `defaultRetentionFloorDays()` now reads it from here.
 *
 * Zero means the regime sets no floor: `customer_contact_data` is governed by
 * DPDP minimisation, which is a maximum and an obligation to erase, not a
 * minimum to keep.
 */
export const STATUTORY_FLOOR_DAYS: Readonly<Record<RetentionClassId, number>> = {
  audit_ledger_entry: 180,
  electronic_signature: 3650,
  study_and_property_value: 1825,
  certificate_issue: 3650,
  order_and_allocation: 2920,
  customer_contact_data: 0,
  consent_artefact: 1095,
  competence_record: 3650,
  session_and_access_log: 180,
};

export function statutoryFloorDays(classId: string): number | null {
  return classId in STATUTORY_FLOOR_DAYS
    ? STATUTORY_FLOOR_DAYS[classId as RetentionClassId]
    : null;
}

/**
 * How long this tenant keeps a class, given what it configured.
 *
 * The floor is applied HERE rather than trusted from configuration. Publication
 * refuses a period below it, so a stored value that is too short arrived some
 * other way — and the safe reading of an unlawfully short period is the lawful
 * one, not the stored one.
 */
export function effectiveRetentionDays(
  classId: string, configuredDays: number | undefined,
): number | null {
  const floor = statutoryFloorDays(classId);
  if (floor === null) return null;
  return Math.max(floor, configuredDays ?? floor);
}
