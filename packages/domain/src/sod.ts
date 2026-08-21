import type { Permission } from './permissions';

/**
 * Segregation of duties.
 *
 * ── Why the ids are words, not numbers ──────────────────────────────────────
 *
 * The two source artefacts NUMBER DIFFERENT RULES THE SAME WAY:
 *
 *   id      wireframe                              prototype
 *   SoD-2   author may not authorise a document    may not decide a claim you raised
 *   SoD-3   may not decide a claim you raised      value assigner may not issue the cert
 *   SoD-4   refund above threshold needs 2 eyes    lot creator may not release it
 *
 * Picking either numbering silently contradicts one artefact, and an assessor
 * reading the wireframe would look up "SoD-4" and find the wrong rule. So the
 * canonical id is a stable semantic slug, and each rule records how BOTH source
 * artefacts referred to it. The mapping is data, and it is testable.
 *
 * ── Three rule shapes ───────────────────────────────────────────────────────
 *
 * The prototype only had one shape — "the person named in field F may not now
 * perform action A". The wireframe's refund rule is a different shape entirely
 * (a monetary threshold and a count of approvers), and its competence rule is a
 * third. Modelling all three keeps the register honest: an assessor asks "show
 * me your segregation rules", not "show me the ones that fit your data model".
 *
 * Definitions live in code because they carry the conformance argument.
 * Whether each is ENABLED is per-tenant configuration in the database, because
 * a smaller laboratory may legitimately find one impractical — and switching
 * one off is itself an auditable governance act.
 */

export type SodRuleKind =
  /** The person named in `field` on the subject record may not now act. */
  | 'actor-comparison'
  /** Above `thresholdMinor`, at least `approversRequired` distinct people must approve. */
  | 'threshold-approval'
  /** The actor must hold a current dated competence authorisation. */
  | 'competence-gate';

/**
 * Whether the rule can actually run today.
 *
 * `pending-subject` means the rule is declared and visible in the register, but
 * the record it constrains is not yet modelled — currently true of the refund
 * rule, because refunds and cancellations are not in the schema at all. Marking
 * it beats omitting it: the gap is then visible rather than forgotten.
 */
export type SodRuleStatus = 'enforced' | 'pending-subject';

export type SodSource = 'wireframe' | 'prototype';
export type SodProvenance = Readonly<Partial<Record<SodSource, string>>>;

interface SodRuleCommon {
  readonly id: string;
  readonly kind: SodRuleKind;
  readonly action: Permission;
  readonly defaultEnabled: boolean;
  readonly owner: string;
  readonly message: string;
  readonly status: SodRuleStatus;
  /** How each source artefact numbered this rule. Empty when only one names it. */
  readonly provenance: SodProvenance;
}

export interface ActorComparisonRule extends SodRuleCommon {
  readonly kind: 'actor-comparison';
  /** Field on the subject record holding the earlier actor's id. */
  readonly field: string;
}

export interface ThresholdApprovalRule extends SodRuleCommon {
  readonly kind: 'threshold-approval';
  /** Minor units. At or above this, extra approvers are required. */
  readonly thresholdMinor: number;
  readonly currency: string;
  /** Total distinct approvers required, including the initiator. */
  readonly approversRequired: number;
}

export interface CompetenceGateRule extends SodRuleCommon {
  readonly kind: 'competence-gate';
  /** The activity a dated competence record must cover. */
  readonly activity: Permission;
}

export type SodRule = ActorComparisonRule | ThresholdApprovalRule | CompetenceGateRule;

const SOD_RULES_LITERAL = [
  {
    id: 'value-assigner-may-not-authorise',
    kind: 'actor-comparison',
    action: 'value:authorise',
    field: 'assignedBy',
    defaultEnabled: true,
    owner: 'Quality Manager',
    message: 'the account that assigned this value cannot authorise it',
    status: 'enforced',
    provenance: { wireframe: 'SoD-1', prototype: 'SoD-1' },
  },
  {
    id: 'claim-raiser-may-not-decide',
    kind: 'actor-comparison',
    action: 'entitlement:decide',
    field: 'raisedBy',
    defaultEnabled: true,
    owner: 'Commercial',
    message: 'you cannot decide a claim you raised',
    status: 'enforced',
    provenance: { wireframe: 'SoD-3', prototype: 'SoD-2' },
  },
  {
    id: 'value-assigner-may-not-issue-certificate',
    kind: 'actor-comparison',
    action: 'cert:issue',
    field: 'assignedBy',
    // Off by default, as in the prototype: a small laboratory may have one
    // person holding both roles, and forcing this would stop work rather than
    // improve control.
    defaultEnabled: false,
    owner: 'Technical Manager',
    message: 'the assigner of the value cannot issue the certificate carrying it',
    status: 'enforced',
    provenance: { wireframe: 'SoD-2', prototype: 'SoD-3' },
  },
  {
    id: 'lot-creator-may-not-release',
    kind: 'actor-comparison',
    action: 'lot:release',
    field: 'createdBy',
    defaultEnabled: false,
    owner: 'Production Lead',
    message: 'the creator of a lot cannot release it',
    /**
     * PENDING-SUBJECT, not enforced, and the distinction is the point.
     *
     * There is one path that releases a lot — `POST /projects/:id/release-lot`
     * — and it CREATES the lot in the same request. So the creator is always
     * the releaser, and enabling this rule would refuse every release rather
     * than separate two duties. A rule that can only ever say no is not a
     * control.
     *
     * The route carried `record: { createdBy: value.assigned_by }`, which is
     * the value's assigner wearing the lot creator's name — so enabling the
     * rule would have enforced something other than what it says, which is
     * worse than not enforcing it. Marking it beats quietly approximating it:
     * the gap is visible in the register an assessor reads, and it becomes
     * enforceable the day a lot can be created in one act and released in
     * another.
     */
    status: 'pending-subject',
    // The wireframe does not carry this rule at all; it is the prototype's own.
    provenance: { prototype: 'SoD-4' },
  },
  {
    id: 'refund-above-threshold-needs-second-approver',
    kind: 'threshold-approval',
    action: 'order:refund',
    thresholdMinor: 5_000_00, // INR 5,000.00
    currency: 'INR',
    approversRequired: 2,
    defaultEnabled: true,
    owner: 'Commercial',
    message: 'a refund at or above the threshold needs a second approver',
    // Declared and visible, but refunds are not yet modelled — see the register.
    status: 'pending-subject',
    provenance: { wireframe: 'SoD-4' },
  },
  {
    id: 'study-signer-must-hold-competence',
    kind: 'competence-gate',
    action: 'study:sign',
    activity: 'study:sign',
    defaultEnabled: true,
    owner: 'Quality Manager',
    message: 'a study may only be signed by someone holding current competence for signing',
    status: 'enforced',
    // Enforced by the competence gate rather than by findSodViolation. Declared
    // here so the segregation register an assessor reads matches the wireframe.
    provenance: { wireframe: 'SoD-5' },
  },
] as const satisfies readonly SodRule[];

/**
 * Exported widened. The literal tuple above gives us exact `id` types; widening
 * the rest keeps the discriminated union usable — otherwise TypeScript narrows
 * a single-member kind to `never` inside the evaluators and every field access
 * becomes an error.
 */
export const SOD_RULES: readonly SodRule[] = SOD_RULES_LITERAL;

export type SodRuleId = (typeof SOD_RULES_LITERAL)[number]['id'];

export const ALL_SOD_RULE_IDS: readonly SodRuleId[] = SOD_RULES_LITERAL.map((r) => r.id);

export function sodRule(id: SodRuleId): SodRule {
  const r = SOD_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown segregation rule: ${id}`);
  return r;
}

/** Look a rule up by how an artefact numbered it, e.g. wireframe 'SoD-4'. */
export function sodRuleByProvenance(source: SodSource, label: string): SodRule | null {
  return SOD_RULES.find((r) => r.provenance[source] === label) ?? null;
}

/** Per-tenant enabled state, keyed by rule id. */
export type SodSettings = Readonly<Partial<Record<SodRuleId, boolean>>>;

export function defaultSodSettings(): Record<SodRuleId, boolean> {
  const out = {} as Record<SodRuleId, boolean>;
  for (const r of SOD_RULES_LITERAL) out[r.id] = r.defaultEnabled;
  return out;
}

export function isSodEnabled(settings: SodSettings, id: SodRuleId): boolean {
  return ruleEnabled(settings, sodRule(id));
}

/**
 * Internal form taking the rule object.
 *
 * The evaluators iterate the WIDENED `SOD_RULES`, whose `id` is `string`, so
 * they cannot call the public `isSodEnabled` without a cast. Reading the
 * setting off the rule itself keeps the public signature strictly typed while
 * the loops stay honest.
 */
function ruleEnabled(settings: SodSettings, rule: SodRule): boolean {
  const bag = settings as Readonly<Record<string, boolean | undefined>>;
  return bag[rule.id] ?? rule.defaultEnabled;
}

export interface SodViolation {
  readonly rule: SodRule;
  readonly reason: string;
}

/**
 * Evaluate the actor-comparison rules for `action` against `record`.
 *
 * Pure by construction: actor and tenant settings are arguments, not ambient
 * state, so this is callable identically from the API guard, a background job,
 * and the UI when deciding whether to disable a button.
 *
 * `threshold-approval` rules are NOT evaluated here — they need the transaction
 * amount and the approval set, so they have their own entry point below.
 * `competence-gate` rules are enforced by the competence check, which needs a
 * date and the competence table.
 */
export function findSodViolation(
  action: Permission,
  record: Readonly<Record<string, unknown>> | null | undefined,
  actorUserId: string,
  settings: SodSettings,
): SodViolation | null {
  if (!record) return null;
  for (const rule of SOD_RULES) {
    if (rule.kind !== 'actor-comparison') continue;
    if (rule.action !== action) continue;
    if (rule.status !== 'enforced') continue;
    if (!ruleEnabled(settings, rule)) continue;
    const earlierActor = record[rule.field];
    if (typeof earlierActor === 'string' && earlierActor === actorUserId) {
      return { rule, reason: rule.message };
    }
  }
  return null;
}

/**
 * Evaluate threshold-approval rules.
 *
 * `approverUserIds` is the set of DISTINCT people who have approved so far,
 * including the person now acting. Distinctness matters: one person approving
 * twice is exactly the control this rule exists to prevent.
 */
/**
 * A tenant's own threshold and approver count for a threshold rule.
 *
 * `sodConfigSchema` has carried these since it was written and nothing read
 * them: the evaluator used the figures in the code, so a tenant that set its
 * refund threshold to a lakh got the product's five thousand.
 */
/**
 * NOTE ON REACH: no threshold rule is `enforced` today — the only one is the
 * refund rule, and refunds are not in the schema — so the override below is
 * resolved, carried and never consulted. It is here because the configuration
 * has always offered the figures and using the code's instead would be the same
 * quiet lie the rest of this work has been removing; the day refunds are
 * modelled it is already right rather than newly remembered.
 */
export type SodThresholds = Readonly<Partial<Record<SodRuleId, {
  readonly thresholdMinor: number;
  readonly approversRequired: number;
}>>>;

export function findThresholdViolation(
  action: Permission,
  amountMinor: number,
  approverUserIds: readonly string[],
  settings: SodSettings,
  thresholds: SodThresholds = {},
): SodViolation | null {
  const distinct = new Set(approverUserIds).size;
  const bag = thresholds as Readonly<Record<string, {
    thresholdMinor: number; approversRequired: number;
  } | undefined>>;

  for (const rule of SOD_RULES) {
    if (rule.kind !== 'threshold-approval') continue;
    if (rule.action !== action) continue;
    if (rule.status !== 'enforced') continue;
    if (!ruleEnabled(settings, rule)) continue;

    // The tenant's figures where it set them, the product's where it did not.
    const over = bag[rule.id];
    const threshold = over?.thresholdMinor ?? rule.thresholdMinor;
    const required = over?.approversRequired ?? rule.approversRequired;

    if (amountMinor < threshold) continue;
    if (distinct < required) {
      return {
        rule,
        reason: `${rule.message} — ${required} required, ${distinct} so far`,
      };
    }
  }
  return null;
}

/** Rules declared but not yet enforceable, for the segregation register screen. */
export const PENDING_SOD_RULES: readonly SodRule[] =
  SOD_RULES.filter((r) => r.status === 'pending-subject');
