import { ROLES, ALL_ROLES } from '../roles';
import { ALL_MACHINES } from '../state-machines';
import { SOD_RULES } from '../sod';
import { RETENTION_SCHEDULE } from '../retention';
import { requiresCompetence } from '../permissions';
import type {
  RoleConfig, WorkflowConfig, SodConfig, NumberingConfig, FlagConfig,
} from './schemas';

/**
 * The product's default configuration.
 *
 * DERIVED from the code constants rather than retyped beside them. Two reasons:
 *
 *  1. They cannot drift. A permission added to a role in `roles.ts` appears in
 *     the seeded configuration automatically.
 *  2. It PROVES the configuration model can express everything that used to be
 *     hardcoded. If some rule could not survive the round trip into config, the
 *     derivation would fail to compile or fail its schema — which is exactly
 *     the check worth having when moving from code to a low-code platform.
 *
 * A fresh tenant is provisioned with these as configuration version 1, marked
 * `system: true`. From then on a tenant edits configuration, never code.
 */

export function defaultRoles(): RoleConfig[] {
  return ALL_ROLES.map((roleKey) => ({
    key: roleKey,
    name: ROLES[roleKey].name,
    kind: ROLES[roleKey].kind,
    permissions: [...ROLES[roleKey].permissions],
    inherits: [],
    system: true,
  }));
}

/**
 * The seven built-in state machines as workflow configuration.
 *
 * Signature and competence requirements are attached here rather than inferred:
 * signing a study and authorising a value are the two acts 21 CFR 11 §11.50
 * requires a manifested signature for, and both are competence-gated under
 * ISO 17034 6.3. A tenant may add signature requirements to further
 * transitions; the product does not let them remove these two.
 */
export function defaultWorkflows(): WorkflowConfig[] {
  return ALL_MACHINES.map((m) => ({
    key: m.name,
    name: titleise(m.name),
    entity: m.name,
    states: m.states.map((s) => ({ key: s, name: titleise(s) })),
    initial: m.initial,
    terminal: [...m.terminal],
    transitions: m.transitions.map((t) => {
      const signed = SIGNATURE_REQUIRED.has(t.requires);
      return {
        from: t.from,
        to: t.to,
        requires: t.requires,
        action: t.action,
        requiresSignature: signed,
        signatureMeanings: signed
          ? (['authorship', 'review', 'approval', 'responsibility'] as const).slice()
          : [],
        ...(requiresCompetence(t.requires) ? { requiresCompetence: t.requires } : {}),
        requiresReason: REASON_REQUIRED.has(`${m.name}:${t.from}->${t.to}`),
        guards: [],
      };
    }),
  }));
}

/**
 * Acts that always manifest a signature. Not configurable downward.
 * These are the four the competence model already gates.
 */
const SIGNATURE_REQUIRED = new Set([
  'study:sign', 'value:assign', 'value:authorise', 'cert:issue', 'cert:reissue',
]);

/** Transitions where a free-text reason is mandatory. */
const REASON_REQUIRED = new Set([
  'property_value:assigned->draft',   // returning work needs a stated reason
  'lot:released->withdrawn',
  'order:placed->cancelled',
  'order:packed->cancelled',
  'capa:effectiveness->capa',         // a failed effectiveness check must say why
]);

export function defaultSodConfig(): SodConfig[] {
  return SOD_RULES.map((r) => ({
    ruleId: r.id,
    enabled: r.defaultEnabled,
    ...(r.kind === 'threshold-approval'
      ? { thresholdMinor: r.thresholdMinor, approversRequired: r.approversRequired }
      : {}),
  }));
}

export function defaultNumbering(): NumberingConfig[] {
  return [
    { key: 'lot', entity: 'lot', template: 'RMP-{MAT}-{SEQ}', resetPolicy: 'never', padTo: 4, startAt: 1 },
    { key: 'certificate', entity: 'certificate', template: 'CRT-{SEQ}', resetPolicy: 'never', padTo: 4, startAt: 1 },
    { key: 'project', entity: 'project', template: 'PRJ-{SEQ}', resetPolicy: 'never', padTo: 4, startAt: 1 },
    { key: 'study', entity: 'study', template: 'ST-{SEQ}', resetPolicy: 'never', padTo: 4, startAt: 1 },
    { key: 'property_value', entity: 'property_value', template: 'PV-{SEQ}', resetPolicy: 'never', padTo: 2, startAt: 1 },
    { key: 'order', entity: 'order', template: 'ORD-{SEQ}', resetPolicy: 'yearly', padTo: 4, startAt: 1 },
    { key: 'capa', entity: 'capa', template: 'NCR-{SEQ}', resetPolicy: 'yearly', padTo: 4, startAt: 1 },
  ];
}

export function defaultFlags(): FlagConfig[] {
  return [
    { key: 'bilingual', name: 'Bilingual interface and certificates', enabled: false },
    { key: 'adr', name: 'Alternative dispute resolution workflow', enabled: false },
    { key: 'publications', name: 'Publications catalogue', enabled: false },
    { key: 'gov_tier', name: 'Government price tier', enabled: false },
    { key: 'public_verification', name: 'Public certificate verification endpoint', enabled: true },
  ];
}

/**
 * Retention defaults are the STATUTORY FLOOR, not a starting point.
 * A tenant may configure longer retention; publishing a shorter one is refused,
 * because the floor is law and configuration cannot lower it.
 */
export function defaultRetentionFloorDays(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of RETENTION_SCHEDULE) out[r.id] = STATUTORY_FLOOR_DAYS[r.id] ?? 0;
  return out;
}

const STATUTORY_FLOOR_DAYS: Record<string, number> = {
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

function titleise(s: string): string {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
