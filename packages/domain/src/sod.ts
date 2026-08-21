import type { Permission } from './permissions.js';

/**
 * Segregation of duties.
 *
 * A rule says: for permission `action`, if the record's `field` names the same
 * person who is now acting, refuse. "You cannot check your own work."
 *
 * The *definitions* live in code because they are part of the product's
 * conformance argument. Whether each is ENABLED is tenant configuration held in
 * the database, because a tenant may legitimately run a smaller lab where one
 * rule is impractical — and disabling one is itself an auditable governance act.
 */
export interface SodRule {
  readonly id: string;
  readonly action: Permission;
  /** The field on the subject record holding the id of the earlier actor. */
  readonly field: string;
  /** Whether this rule is on by default when a tenant is provisioned. */
  readonly defaultEnabled: boolean;
  /** The role accountable for the rule being in force. */
  readonly owner: string;
  readonly message: string;
}

export const SOD_RULES = [
  {
    id: 'SoD-1',
    action: 'value:authorise',
    field: 'assignedBy',
    defaultEnabled: true,
    owner: 'Quality Manager',
    message: 'the account that assigned this value cannot authorise it',
  },
  {
    id: 'SoD-2',
    action: 'entitlement:decide',
    field: 'raisedBy',
    defaultEnabled: true,
    owner: 'Commercial',
    message: 'you cannot decide a claim you raised',
  },
  {
    id: 'SoD-3',
    action: 'cert:issue',
    field: 'assignedBy',
    defaultEnabled: false,
    owner: 'Technical Manager',
    message: 'the assigner of the value cannot issue the certificate carrying it',
  },
  {
    id: 'SoD-4',
    action: 'lot:release',
    field: 'createdBy',
    defaultEnabled: false,
    owner: 'Production Lead',
    message: 'the creator of a lot cannot release it',
  },
] as const satisfies readonly SodRule[];

/** Derived from SOD_RULES so a new rule cannot be added without the type widening. */
export type SodRuleId = (typeof SOD_RULES)[number]['id'];

export const ALL_SOD_RULE_IDS: readonly SodRuleId[] = SOD_RULES.map((r) => r.id);

export function sodRule(id: SodRuleId): SodRule {
  const r = SOD_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown segregation rule: ${id}`);
  return r;
}

/** The enabled/disabled state for one tenant, keyed by rule id. */
export type SodSettings = Readonly<Partial<Record<SodRuleId, boolean>>>;

export function defaultSodSettings(): Record<SodRuleId, boolean> {
  const out = {} as Record<SodRuleId, boolean>;
  for (const r of SOD_RULES) out[r.id] = r.defaultEnabled;
  return out;
}

export function isSodEnabled(settings: SodSettings, id: SodRuleId): boolean {
  return settings[id] ?? sodRule(id).defaultEnabled;
}

/**
 * Evaluate every enabled rule for `action` against `record`.
 *
 * `record` is any object that may carry the earlier actor's id under the rule's
 * field. Returns the first violated rule, or null when the act is permitted.
 *
 * Deliberately pure: it takes the actor and the tenant's settings as arguments
 * rather than reading ambient state, so it is callable identically from the API
 * guard, from a background job, and from the UI to pre-disable a button.
 */
export function findSodViolation(
  action: Permission,
  record: Readonly<Record<string, unknown>> | null | undefined,
  actorUserId: string,
  settings: SodSettings,
): SodRule | null {
  if (!record) return null;
  for (const rule of SOD_RULES) {
    if (rule.action !== action) continue;
    if (!isSodEnabled(settings, rule.id)) continue;
    const earlierActor = record[rule.field];
    if (typeof earlierActor === 'string' && earlierActor === actorUserId) return rule;
  }
  return null;
}
