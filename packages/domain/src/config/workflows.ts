import { ALL_MACHINES, type StateMachine, type Transition } from '../state-machines';
import { isPermission, type Permission } from '../permissions';
import type { WorkflowConfig } from './schemas';

/**
 * Turning a configured workflow into the machine the product runs on.
 *
 * ── What was true before this ───────────────────────────────────────────────
 *
 * `state-machines.ts` declared seven machines in TypeScript and every route
 * passed one of them to `assertTransition`. `defaultWorkflows()` derived
 * configuration entries FROM those declarations and seeded them, which proved
 * the model could express them — and then nothing read the entries back. The
 * configuration described the machine; the code was the machine.
 *
 * ── One machine per entity, at any moment ───────────────────────────────────
 *
 * The active version governs every record of an entity, not the version each
 * record was created under. Two records of the same kind following different
 * rules because they were made on different days is not something an operator
 * can hold in their head, and it is not something an assessor can be shown.
 *
 * The cost of that choice is that a published change could strand a record in a
 * state the new machine does not have. So `publicationProblems()` refuses it —
 * exactly as it already refuses removing a role somebody holds. The danger
 * becomes a sentence at publish time rather than a record that quietly has
 * nowhere to go.
 *
 * History stays explicable regardless: `state_transitions.config_version_id`
 * pins the version each past move was judged under.
 */

/** The code defaults, by entity. What a tenant gets before it configures anything. */
const BUILT_IN = new Map<string, StateMachine<string>>(
  ALL_MACHINES.map((m) => [m.name, m as unknown as StateMachine<string>]),
);

export function builtInMachine(entity: string): StateMachine<string> | null {
  return BUILT_IN.get(entity) ?? null;
}

/**
 * A configured workflow, as a machine.
 *
 * `requires` is re-checked against the permission vocabulary even though the
 * schema already did: this is stored JSONB, and it is validated on read for the
 * same reason `session.ts` re-parses roles. A transition demanding a permission
 * the system does not enforce is dropped rather than trusted — dropping it
 * means the move cannot be made, which is the safe direction.
 */
export function machineFromConfig(
  wf: WorkflowConfig,
  onDropped?: (reason: string) => void,
): StateMachine<string> {
  const transitions: Transition<string>[] = [];
  for (const t of wf.transitions) {
    if (!isPermission(t.requires)) {
      onDropped?.(
        `workflow '${wf.key}': transition ${t.from} → ${t.to} requires '${t.requires}', ` +
        'which is not a permission this system enforces; the move was dropped',
      );
      continue;
    }
    transitions.push({
      from: t.from,
      to: t.to,
      requires: t.requires as Permission,
      action: t.action,
      ...(t.systemInitiated ? { systemInitiated: true as const } : {}),
      /**
       * Carried onto the machine, so the route that makes the move reads the
       * tenant's rule rather than a constant of its own. `signatureRequired()`
       * ORs this with the floor: configuration adds ceremony, never removes it.
       */
      requiresSignature: t.requiresSignature,
      signatureMeanings: t.signatureMeanings,
      requiresReason: t.requiresReason,
    });
  }

  return {
    name: wf.entity,
    states: wf.states.map((s) => s.key),
    initial: wf.initial,
    terminal: wf.terminal,
    transitions,
  };
}

/**
 * The machine that governs one entity right now.
 *
 * Configuration wins where it exists; the built-in is the fallback. A tenant
 * that has never touched workflow configuration therefore behaves exactly as
 * before, which is what makes this safe to turn on.
 */
export function machineFor(
  entity: string,
  configured: ReadonlyMap<string, StateMachine<string>>,
): StateMachine<string> | null {
  return configured.get(entity) ?? builtInMachine(entity);
}

/**
 * States a machine's DDL cannot hold.
 *
 * `studies.state` carries `study_state_known CHECK (state IN ('draft','signed'))`
 * from migration 0001 — the only state vocabulary in the schema welded into
 * DDL. A configured study workflow that adds a state would therefore fail at
 * the INSERT with a constraint violation, which reaches a user as a 500.
 *
 * Listed here so publication can refuse it with a sentence instead. A database
 * test asserts this matches the constraint the schema actually carries, so the
 * two cannot drift; making study states extensible means dropping that
 * constraint for a trigger, which is its own migration.
 */
export const DDL_CONSTRAINED_STATES: Readonly<Record<string, readonly string[]>> = {
  study: ['draft', 'signed'],
};

/** States this workflow declares that the database could not store. */
export function statesTheDatabaseRefuses(wf: WorkflowConfig): string[] {
  const allowed = DDL_CONSTRAINED_STATES[wf.entity];
  if (!allowed) return [];
  return wf.states.map((s) => s.key).filter((k) => !allowed.includes(k));
}
