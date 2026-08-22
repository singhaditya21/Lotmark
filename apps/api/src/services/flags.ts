import { flagConfigSchema, defaultFlags } from '@lotmark/domain';
import type { Sql } from '../db';
import { activeVersion, entriesOf } from './config-admin';

/**
 * Feature flags, resolved from the tenant's active configuration.
 *
 * ── There is one store, now ─────────────────────────────────────────────────
 *
 * `tenants` carried four boolean columns holding the same facts as the `flag`
 * config entries, and the two already disagreed — columns true, entries false.
 * Migration 0027 dropped the columns. A flag is a tenant DECISION and decisions
 * belong in the versioned model: drafted, diffed, signed, published, reversible.
 *
 * ── A flag must gate something ──────────────────────────────────────────────
 *
 * `adr` and `publications` were deleted rather than wired, because they named
 * features that do not exist. A flag that gates nothing is indistinguishable,
 * from the configuration console, from a flag that gates something — which is
 * the same failure as a checkbox nothing reads, one level up.
 */

export type Flags = ReadonlyMap<string, boolean>;

/** What the product does before a tenant says otherwise. */
export function productFlags(): Map<string, boolean> {
  return new Map(defaultFlags().map((f) => [f.key, f.enabled]));
}

export async function tenantFlags(
  tx: Sql, tenantId: string, onProblem?: (msg: string) => void,
): Promise<Flags> {
  const active = await activeVersion(tx, tenantId);
  if (!active) return productFlags();

  const out = productFlags();
  for (const e of (await entriesOf(tx, active.id)).filter((x) => x.kind === 'flag')) {
    const parsed = flagConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      // Validated on read, as everywhere. An unreadable flag keeps its product
      // default rather than silently switching a feature on.
      onProblem?.(`flag '${e.key}' does not parse and was ignored`);
      continue;
    }
    out.set(parsed.data.key, parsed.data.enabled);
  }
  return out;
}

/**
 * Is this flag on?
 *
 * Defaults to OFF for a name nobody has heard of. A flag the product does not
 * ship cannot have been reasoned about, and turning an unknown feature on
 * because its name appeared in configuration is the wrong direction to fail.
 */
export function flagEnabled(flags: Flags, key: string): boolean {
  return flags.get(key) ?? false;
}
