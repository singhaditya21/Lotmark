import {
  sodConfigSchema, SOD_RULES, defaultSodSettings,
  type SodSettings, type SodThresholds,
} from '@lotmark/domain';
import type { Sql } from '../db';
import { activeVersion, entriesOf } from './config-admin';

/**
 * A tenant's segregation of duties, as configured.
 *
 * The rules themselves live in code, because they carry the conformance
 * argument an assessor is shown. Whether each is ENABLED, and what figures a
 * threshold rule uses, are per-tenant — `sod.ts` has said so since it was
 * written: "a smaller laboratory may legitimately find one impractical, and
 * switching one off is itself an auditable governance act."
 *
 * It was auditable and it was not applied. Six `sod` entries have been seeded
 * since the first release and nothing ever read one, so a tenant that turned a
 * rule on got the product's default and no warning that its decision had not
 * taken.
 *
 * ── Absent means default, and that is not the same as {} ────────────────────
 *
 * A rule with no entry falls back to `defaultEnabled`, which is what
 * `ruleEnabled` already did. So a tenant with no `sod` configuration behaves
 * exactly as before — the same property that made the workflow change safe to
 * turn on. Worth stating because passing `{}` and passing
 * `defaultSodSettings()` have always been identical for that reason, and the
 * mixture of both across the routes was style rather than a defect.
 */

export interface TenantSod {
  readonly settings: SodSettings;
  readonly thresholds: SodThresholds;
}

/** What the product does before a tenant says otherwise. */
export const PRODUCT_SOD: TenantSod = { settings: defaultSodSettings(), thresholds: {} };

const KNOWN = new Set(SOD_RULES.map((r) => r.id));

export async function tenantSod(
  tx: Sql, tenantId: string, onProblem?: (msg: string) => void,
): Promise<TenantSod> {
  const active = await activeVersion(tx, tenantId);
  if (!active) return PRODUCT_SOD;
  return sodFromVersion(tx, active.id, onProblem);
}

/**
 * The same resolution, against ANY version.
 *
 * So a draft can be previewed, and so a test can prove that configuration is
 * obeyed without publishing — publishing swaps the tenant's active version
 * underneath every other test file running beside it, and a published version
 * cannot be edited afterwards, which is the trigger doing its job.
 */
export async function sodFromVersion(
  tx: Sql, versionId: string, onProblem?: (msg: string) => void,
): Promise<TenantSod> {
  return resolveSod(await entriesOf(tx, versionId), onProblem);
}

/**
 * The resolution itself — a pure function of the entries.
 *
 * Pure so it can be tested without a database and, more to the point, without a
 * DRAFT. There is one draft per tenant, so a test file that opened one to prove
 * something about resolution fought every other file that opens one. Taking the
 * entries directly removes the contention and the question.
 */
export function resolveSod(
  entries: ReadonlyArray<{ kind: string; key: string; payload: unknown }>,
  onProblem?: (msg: string) => void,
): TenantSod {
  const settings: Record<string, boolean> = { ...defaultSodSettings() };
  const thresholds: Record<string, { thresholdMinor: number; approversRequired: number }> = {};

  for (const e of entries.filter((x) => x.kind === 'sod')) {
    const parsed = sodConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      // Validated on read, as everywhere: a malformed entry is ignored and the
      // rule keeps its product default rather than silently switching off.
      onProblem?.(`segregation rule '${e.key}' does not parse and was ignored`);
      continue;
    }
    if (!KNOWN.has(parsed.data.ruleId)) {
      onProblem?.(
        `segregation rule '${parsed.data.ruleId}' is configured but this system has no such rule`,
      );
      continue;
    }

    settings[parsed.data.ruleId] = parsed.data.enabled;

    const { thresholdMinor, approversRequired } = parsed.data;
    if (thresholdMinor !== undefined && approversRequired !== undefined) {
      thresholds[parsed.data.ruleId] = { thresholdMinor, approversRequired };
    }
  }

  return { settings, thresholds };
}
