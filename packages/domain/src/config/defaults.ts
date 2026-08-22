import { ROLES, ALL_ROLES } from '../roles';
import { ALL_MACHINES } from '../state-machines';
import { SOD_RULES } from '../sod';
import { RETENTION_SCHEDULE, STATUTORY_FLOOR_DAYS } from '../retention';
import { requiresCompetence } from '../permissions';
import { alwaysSigned } from '../signatures';
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
      const signed = alwaysSigned(t.requires);
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
        // Carried, not dropped: without it a machine resolved back out of
        // configuration forbids the moves scheduled work is allowed to make.
        systemInitiated: t.systemInitiated === true,
      };
    }),
  }));
}

/**
 * The signature floor now lives in `signatures.ts`, beside the obligation it
 * comes from, and is enforced rather than merely described — see ALWAYS_SIGNED.
 */

/**
 * Transitions where a free-text reason is mandatory, as the PRODUCT ships it.
 *
 * A default, not a floor — unlike `ALWAYS_SIGNED`. A signature is a regulatory
 * obligation a tenant may not configure away; a reason is a quality practice a
 * tenant may reasonably decide differently about, so this is the starting point
 * and configuration governs from there.
 *
 * ── Every CAPA move, because that is what the product already did ───────────
 *
 * The CAPA route demanded a reason on EVERY move — "a nonconformity that moved
 * for reasons nobody wrote down is a nonconformity you cannot defend during an
 * assessment" — while this list named one of its transitions. Two rules for the
 * same question again, the stricter one in the route and the weaker one in the
 * configuration nothing read. Making the route read configuration without
 * fixing this would have QUIETLY DROPPED the requirement from four of the five
 * CAPA moves.
 *
 * The route was right, so the list now says what it did.
 */
const REASON_REQUIRED = new Set([
  'property_value:assigned->draft',   // returning work needs a stated reason
  'lot:released->withdrawn',
  'order:placed->cancelled',
  'order:packed->cancelled',
  'capa:open->investigation',
  'capa:investigation->root_cause',
  'capa:root_cause->capa',
  'capa:capa->effectiveness',
  'capa:effectiveness->closed',
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

/**
 * Flags whose feature exists but has not been built yet.
 *
 * The same distinction `sod.ts` draws with `pending-subject`: "declared and
 * visible in the register, but the record it constrains is not yet modelled.
 * Marking it beats omitting it: the gap is then visible rather than forgotten."
 *
 * `bilingual` waits on an i18n layer — every user-facing string is currently
 * hardcoded English, and the `translation` config kind is stored and read by
 * nothing. `gov_tier` waits on a price list: `organisations.price_tier` is a
 * label today and approving a tier changes no number, so a flag switching the
 * tier on would gate a decision with no consequence.
 *
 * `flags.test.ts` requires every flag to be EITHER consulted in the source OR
 * named here. That is what stops the next one being decoration.
 */
export const PENDING_FLAGS: Readonly<Record<string, string>> = {
  bilingual: 'no i18n layer exists; every string is hardcoded English',
  gov_tier: 'no price list exists, so a tier changes no number',
};

/**
 * Flags the product ships.
 *
 * Each one must GATE something, or be named in `PENDING_FLAGS` with the reason.
 * `adr` and `publications` were removed rather than wired: they named features
 * with no route, no table, no screen and no test anywhere in the repository,
 * and nobody could say what building them would even mean — which is the
 * difference between a gap and a name.
 */
export function defaultFlags(): FlagConfig[] {
  return [
    { key: 'bilingual', name: 'Bilingual interface and certificates', enabled: false },
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

/**
 * Does the PRODUCT ship a default for this artefact?
 *
 * `config_entries.overrides_default` is shown in the administration console, so
 * it has to be true. It was hardcoded to `true` on insert and left untouched on
 * update, which made two claims that are not so: that a layout — a kind with no
 * product default at all — replaces one, and that an entry seeded as `false`
 * still does not override after being edited.
 *
 * Only six kinds have defaults, and each is derived from the code constants
 * rather than listed again here, so the answer cannot drift from what a fresh
 * tenant is actually provisioned with.
 */
export function hasProductDefault(kind: string, entryKey: string): boolean {
  switch (kind) {
    case 'role': return defaultRoles().some((r) => r.key === entryKey);
    case 'workflow': return defaultWorkflows().some((w) => w.key === entryKey);
    // SoD entries are keyed by their rule id, not by a `key` property.
    case 'sod': return defaultSodConfig().some((r) => r.ruleId === entryKey);
    case 'numbering': return defaultNumbering().some((n) => n.key === entryKey);
    case 'flag': return defaultFlags().some((f) => f.key === entryKey);
    case 'retention': return entryKey in defaultRetentionFloorDays();
    /**
     * field, picklist, layout, view, dashboard, report, template, translation.
     * The product ships none of these — everything of these kinds is something
     * a tenant invented, and saying it overrides a default is simply false.
     */
    default: return false;
  }
}

function titleise(s: string): string {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
