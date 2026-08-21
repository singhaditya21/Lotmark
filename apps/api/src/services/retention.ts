import {
  retentionConfigSchema, RETENTION_SCHEDULE, effectiveRetentionDays, statutoryFloorDays,
  type RetentionClass,
} from '@lotmark/domain';
import type { Sql } from '../db';
import { activeVersion, entriesOf } from './config-admin';

/**
 * How long this tenant keeps each class of record.
 *
 * The schedule itself is code, because it is where four regimes that disagree —
 * DPDP, CERT-In, 21 CFR Part 11, ISO 17034 — are reconciled in the open, and
 * that reconciliation is the conformance argument. What a tenant may set is how
 * much LONGER than the statutory floor it keeps something.
 *
 * ── The floor is applied here, not trusted from configuration ───────────────
 *
 * `publicationProblems()` refuses a period below it, so a stored value that is
 * too short arrived some other way — a migration, an older version of this
 * code, a direct write. The safe reading of an unlawfully short period is the
 * lawful one, so `effectiveRetentionDays` takes the maximum of the two. Two
 * layers, the same shape as everywhere else here: the publish path refuses it
 * and the runtime survives it.
 */

export interface RetentionSetting {
  readonly klass: RetentionClass;
  /** What the tenant configured, if anything. */
  readonly configuredDays: number | null;
  /** The statutory minimum. Null when the regime sets no floor. */
  readonly floorDays: number | null;
  /** What actually applies — the greater of the two. */
  readonly effectiveDays: number | null;
  readonly reason: string | null;
}

export async function retentionSettings(
  tx: Sql, tenantId: string, onProblem?: (msg: string) => void,
): Promise<RetentionSetting[]> {
  const active = await activeVersion(tx, tenantId);
  const entries = active ? await entriesOf(tx, active.id) : [];

  const configured = new Map<string, { days: number; reason: string }>();
  for (const e of entries.filter((x) => x.kind === 'retention')) {
    const parsed = retentionConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      onProblem?.(`retention setting '${e.key}' does not parse and was ignored`);
      continue;
    }
    configured.set(parsed.data.key, {
      days: parsed.data.retainForDays, reason: parsed.data.reason,
    });
  }

  return RETENTION_SCHEDULE.map((klass) => {
    const own = configured.get(klass.id);
    return {
      klass,
      configuredDays: own?.days ?? null,
      floorDays: statutoryFloorDays(klass.id),
      effectiveDays: effectiveRetentionDays(klass.id, own?.days),
      reason: own?.reason ?? null,
    };
  });
}

/** The period for one class, in days — the number a job should actually use. */
export async function retentionDaysFor(
  tx: Sql, tenantId: string, classId: string, onProblem?: (msg: string) => void,
): Promise<number | null> {
  const all = await retentionSettings(tx, tenantId, onProblem);
  return all.find((r) => r.klass.id === classId)?.effectiveDays ?? null;
}
