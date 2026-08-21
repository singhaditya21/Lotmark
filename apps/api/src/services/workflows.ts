import {
  workflowConfigSchema, machineFromConfig, machineFor, builtInMachine,
  type StateMachine,
} from '@lotmark/domain';
import type { Sql } from '../db';
import { activeVersion, entriesOf } from './config-admin';

/**
 * The machine a tenant's records actually run on.
 *
 * Configuration wins where a tenant has published a workflow; the code default
 * is the fallback. A tenant that has never touched workflow configuration
 * therefore behaves exactly as it did before any of this existed, which is what
 * makes turning it on safe.
 *
 * ── Validated on read ───────────────────────────────────────────────────────
 *
 * Every payload is `safeParse`d here, exactly as `session.ts` does with roles.
 * An entry that does not parse is IGNORED — the entity falls back to its
 * built-in machine — rather than throwing, because a single malformed workflow
 * must not take out every route that touches that entity. `publicationProblems`
 * is what stops one being published; this is what survives one that was.
 */

export async function configuredMachines(
  tx: Sql, tenantId: string, onProblem?: (msg: string) => void,
): Promise<Map<string, StateMachine<string>>> {
  const active = await activeVersion(tx, tenantId);
  if (!active) return new Map();
  return machinesFromVersion(tx, active.id, onProblem);
}

/**
 * The same resolution, against ANY version.
 *
 * So the flow designer can show what a draft would do, and so a test can prove
 * that configuration wins without publishing one — publishing would change the
 * tenant's active version underneath every other test file running beside it.
 */
export async function machinesFromVersion(
  tx: Sql, versionId: string, onProblem?: (msg: string) => void,
): Promise<Map<string, StateMachine<string>>> {
  const out = new Map<string, StateMachine<string>>();
  for (const e of (await entriesOf(tx, versionId)).filter((x) => x.kind === 'workflow')) {
    const parsed = workflowConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      onProblem?.(
        `workflow '${e.key}' in the active version does not parse and was ignored; ` +
        `${parsed.data ? '' : parsed.error.issues[0]?.message ?? ''}`,
      );
      continue;
    }
    out.set(parsed.data.entity, machineFromConfig(parsed.data, onProblem));
  }
  return out;
}

/**
 * One entity's machine, resolved.
 *
 * Returns the built-in when nothing is configured, and null only when the
 * entity has no machine at all — which is a programming error rather than a
 * configuration one, so callers may treat it as such.
 */
export async function machineForEntity(
  tx: Sql, tenantId: string, entity: string, onProblem?: (msg: string) => void,
): Promise<StateMachine<string> | null> {
  return machineFor(entity, await configuredMachines(tx, tenantId, onProblem));
}

/**
 * The built-in, for the few places that need a machine without a transaction.
 *
 * Kept deliberately narrow. Reaching for this where a tenant's own machine
 * could have been resolved is how configuration goes back to being decorative.
 */
export { builtInMachine };
