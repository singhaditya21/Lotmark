import { z } from 'zod';

/**
 * The configuration registry — the spine of the low-code platform.
 *
 * ── The fixed floor ─────────────────────────────────────────────────────────
 *
 * Three things are CODE and can never become configuration, because the
 * conformance argument rests on them:
 *
 *   1. The permission vocabulary. A permission is a capability the code
 *      actually enforces at a specific call site. A tenant inventing a
 *      permission would invent a capability nothing checks.
 *   2. The statistics engine. A configurable uncertainty calculation is an
 *      uncertainty nobody can reproduce.
 *   3. The audit chain and signature binding. Configurable integrity is not
 *      integrity.
 *
 * Everything above that floor is configuration, and configuration is DATA.
 *
 * ── Why configuration is versioned ──────────────────────────────────────────
 *
 * Under GAMP 5 and 21 CFR Part 11, validation evidence attests what the system
 * does. If a tenant reconfigures a workflow at runtime, the evidence for that
 * workflow is stale the moment they do, and records created yesterday were
 * created under different rules than today's.
 *
 * The product already solves this shape of problem three times — a signature
 * freezes the competence basis it relied on, a certificate reissue never
 * overwrites its predecessor, and every act writes to an append-only chain. The
 * same pattern applies here: a configuration VERSION is immutable once
 * published, and every business record stamps the version it was created under.
 *
 * "Under what rules was this certificate issued" is then always answerable, and
 * re-validation is scoped to what actually changed between two versions rather
 * than to the whole system.
 */

/** Every kind of thing a tenant can configure. */
export const CONFIG_KINDS = {
  role: 'Role definitions and their permission grants',
  workflow: 'State machines: states, transitions and the permission each requires',
  field: 'Custom fields added to a built-in entity',
  picklist: 'Named lists of allowed values',
  layout: 'Form and detail-view arrangement',
  view: 'Table columns, default filters and sort',
  dashboard: 'Dashboard composition and widgets',
  report: 'Report definitions and their schedules',
  numbering: 'Identifier templates, e.g. lot and certificate codes',
  template: 'Document and notification templates',
  translation: 'Interface strings per locale',
  sod: 'Segregation-of-duties enablement and thresholds',
  retention: 'Retention overrides above the statutory floor',
  flag: 'Feature switches',
} as const;

export type ConfigKind = keyof typeof CONFIG_KINDS;
export const ALL_CONFIG_KINDS = Object.keys(CONFIG_KINDS) as ConfigKind[];

/**
 * How risky a change to this kind is, which decides the ceremony required to
 * publish it.
 *
 * `security` and `behaviour` changes require an electronic signature, because
 * they alter who may act and what the system does. `presentation` changes are
 * audited but do not, because moving a field on a form does not change an
 * outcome — and demanding a signature for it trains people to sign without
 * reading, which is worse than not asking.
 */
export type ConfigRisk = 'security' | 'behaviour' | 'presentation';

export const CONFIG_RISK: Record<ConfigKind, ConfigRisk> = {
  role: 'security',
  sod: 'security',
  retention: 'security',
  workflow: 'behaviour',
  field: 'behaviour',
  picklist: 'behaviour',
  numbering: 'behaviour',
  template: 'behaviour',
  report: 'behaviour',
  flag: 'behaviour',
  layout: 'presentation',
  view: 'presentation',
  dashboard: 'presentation',
  translation: 'presentation',
};

export function requiresSignatureToPublish(kind: ConfigKind): boolean {
  return CONFIG_RISK[kind] !== 'presentation';
}

/** A configuration version's lifecycle. */
export const configStatusSchema = z.enum(['draft', 'active', 'superseded']);
export type ConfigStatus = z.infer<typeof configStatusSchema>;

/**
 * One configuration version.
 *
 * Immutable once `active`. Editing means creating a new draft from it, which is
 * why there is no update path — only `publish`, which supersedes.
 */
export const configVersionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  status: configStatusSchema,
  /** Why this version exists. Required — a change with no stated reason is a
   *  change nobody can review. */
  changeReason: z.string().min(1),
  basedOnVersionId: z.string().uuid().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  publishedBy: z.string().uuid().nullable(),
  publishedAt: z.string().nullable(),
  /** Signature id when the version contained a security or behaviour change. */
  signatureId: z.string().uuid().nullable(),
});
export type ConfigVersion = z.infer<typeof configVersionSchema>;

/**
 * One configuration entry: a single artefact of one kind, within one version.
 *
 * `payload` is validated against the Zod schema registered for its kind, so
 * adding a new configurable thing is a schema registration rather than a
 * database migration. That property is what makes this a platform rather than
 * an application with a settings screen.
 */
export const configEntrySchema = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
  kind: z.enum(ALL_CONFIG_KINDS as [ConfigKind, ...ConfigKind[]]),
  /** Stable identifier within its kind, e.g. the role key or workflow name. */
  key: z.string().min(1),
  payload: z.unknown(),
  /** Set when this entry is a tenant override of a product default. */
  overridesDefault: z.boolean(),
});
export type ConfigEntry = z.infer<typeof configEntrySchema>;

/** A diff between two versions, used to scope re-validation. */
export interface ConfigChange {
  readonly kind: ConfigKind;
  readonly key: string;
  readonly change: 'added' | 'removed' | 'modified';
  readonly risk: ConfigRisk;
}

/**
 * What changed between two sets of entries.
 *
 * Drives three things: the approval ceremony (does this need a signature), the
 * re-validation scope (which OQ tests must re-run), and the human-readable
 * summary an approver reads before signing.
 */
export function diffConfig(
  before: readonly Pick<ConfigEntry, 'kind' | 'key' | 'payload'>[],
  after: readonly Pick<ConfigEntry, 'kind' | 'key' | 'payload'>[],
): ConfigChange[] {
  const keyOf = (e: { kind: ConfigKind; key: string }) => `${e.kind}::${e.key}`;
  const beforeMap = new Map(before.map((e) => [keyOf(e), e]));
  const afterMap = new Map(after.map((e) => [keyOf(e), e]));
  const changes: ConfigChange[] = [];

  for (const [k, entry] of afterMap) {
    const prior = beforeMap.get(k);
    if (!prior) {
      changes.push({ kind: entry.kind, key: entry.key, change: 'added', risk: CONFIG_RISK[entry.kind] });
    } else if (!deepEqual(prior.payload, entry.payload)) {
      changes.push({ kind: entry.kind, key: entry.key, change: 'modified', risk: CONFIG_RISK[entry.kind] });
    }
  }
  for (const [k, entry] of beforeMap) {
    if (!afterMap.has(k)) {
      changes.push({ kind: entry.kind, key: entry.key, change: 'removed', risk: CONFIG_RISK[entry.kind] });
    }
  }
  return changes.sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key));
}

export function changesRequireSignature(changes: readonly ConfigChange[]): boolean {
  return changes.some((c) => c.risk !== 'presentation');
}

/**
 * Structural equality with stable key ordering.
 *
 * Not JSON.stringify comparison: object key order differs between two payloads
 * that mean the same thing, and a spurious "modified" would demand a signature
 * and a re-validation cycle for a change that did not happen.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length || !ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}
