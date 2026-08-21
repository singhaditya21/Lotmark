/**
 * State machines.
 *
 * Every lifecycle in the product is declared here as an explicit transition
 * table rather than scattered `if` statements. Three reasons this matters in a
 * regulated system:
 *
 *  1. An assessor can be shown the permitted transitions directly.
 *  2. The API, the UI and the database CHECK constraints are generated from one
 *     declaration, so a state the UI offers is always one the server accepts.
 *  3. An illegal transition is a defect that gets caught at the boundary, not a
 *     corrupt record discovered months later during an audit.
 */
import type { Permission } from './permissions';
import { alwaysSigned, ALL_SIGNATURE_MEANINGS } from './signatures';

export interface Transition<S extends string> {
  readonly from: S;
  readonly to: S;
  /** The permission required when a PERSON makes this move. */
  readonly requires: Permission;
  /** Human-readable name of the act, used in the audit ledger. */
  readonly action: string;
  /**
   * May scheduled work make this move without a person?
   *
   * A job holds no ResolvedAuthority, so it cannot satisfy `requires` — and it
   * should not: the permission describes a human act. Without this flag the
   * only options were to give jobs a synthetic authority, which is a lie, or to
   * bypass the machine entirely, which is what the entitlement lapse job did.
   *
   * Marking the transition is the honest third option: the machine states which
   * moves the system is allowed to make on its own, and a job asserts it.
   */
  readonly systemInitiated?: boolean;

  /**
   * Ceremony a tenant added to this move, beyond the floor.
   *
   * Absent on the built-in machines, deliberately: their signature rule is
   * `ALWAYS_SIGNED`, and leaving these undefined means a tenant that has
   * configured nothing gets exactly the behaviour it had before configuration
   * was read at all. Present only on a machine resolved from configuration.
   */
  readonly requiresSignature?: boolean;
  readonly signatureMeanings?: readonly string[];
  readonly requiresReason?: boolean;
}

/**
 * Does this move demand an electronic signature?
 *
 * The floor OR the configuration — never the configuration alone. A tenant may
 * add a signature to a move; it may not take one away from an act 21 CFR 11
 * §11.50 makes the point of the record, and `publicationProblems()` refuses a
 * workflow that tries.
 */
export function signatureRequired(t: Transition<string>): boolean {
  return alwaysSigned(t.requires) || t.requiresSignature === true;
}

/** Meanings the signer may choose for this move, falling back to all of them. */
export function meaningsFor(t: Transition<string>): readonly string[] {
  return t.signatureMeanings && t.signatureMeanings.length > 0
    ? t.signatureMeanings
    : ALL_SIGNATURE_MEANINGS;
}

export function reasonRequired(t: Transition<string>): boolean {
  return t.requiresReason === true;
}

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly initial: S;
  /** States from which nothing may follow. */
  readonly terminal: readonly S[];
  readonly transitions: readonly Transition<S>[];
}

function machine<S extends string>(m: StateMachine<S>): StateMachine<S> {
  return m;
}

/* ── Production project ──────────────────────────────────────────────────── */

export type ProjectStage = 'design' | 'study' | 'authorisation' | 'released';

export const PROJECT_MACHINE = machine<ProjectStage>({
  name: 'project',
  states: ['design', 'study', 'authorisation', 'released'],
  initial: 'design',
  terminal: ['released'],
  transitions: [
    { from: 'design', to: 'study', requires: 'project:manage', action: 'Project moved to study' },
    { from: 'study', to: 'authorisation', requires: 'project:manage', action: 'Project moved to authorisation' },
    { from: 'authorisation', to: 'released', requires: 'lot:release', action: 'Project released' },
    { from: 'authorisation', to: 'study', requires: 'project:manage', action: 'Project returned to study' },
  ],
});

/* ── Study ───────────────────────────────────────────────────────────────── */

export type StudyState = 'draft' | 'signed';

export const STUDY_MACHINE = machine<StudyState>({
  name: 'study',
  states: ['draft', 'signed'],
  initial: 'draft',
  // Signed is terminal by design: a signed study is never edited, only superseded
  // by a further study. 21 CFR 11 §11.10(e) — the record and its signature stand.
  terminal: ['signed'],
  transitions: [
    { from: 'draft', to: 'signed', requires: 'study:sign', action: 'Study signed' },
  ],
});

/* ── Property value ──────────────────────────────────────────────────────── */

export type ValueState = 'draft' | 'assigned' | 'authorised';

export const VALUE_MACHINE = machine<ValueState>({
  name: 'property_value',
  states: ['draft', 'assigned', 'authorised'],
  initial: 'draft',
  terminal: ['authorised'],
  transitions: [
    { from: 'draft', to: 'assigned', requires: 'value:assign', action: 'Property value assigned' },
    { from: 'assigned', to: 'authorised', requires: 'value:authorise', action: 'Property value authorised' },
    // Returning is a first-class move, not a deletion: the ledger keeps both.
    { from: 'assigned', to: 'draft', requires: 'value:authorise', action: 'Property value returned to assigner' },
  ],
});

/* ── Lot ─────────────────────────────────────────────────────────────────── */

export type LotState = 'draft' | 'released' | 'superseded' | 'withdrawn';

export const LOT_MACHINE = machine<LotState>({
  name: 'lot',
  states: ['draft', 'released', 'superseded', 'withdrawn'],
  initial: 'draft',
  terminal: ['superseded', 'withdrawn'],
  transitions: [
    { from: 'draft', to: 'released', requires: 'lot:release', action: 'Lot released' },
    // Releasing a successor supersedes the predecessor; done by the system as
    // part of the release, which is why it carries the same permission.
    { from: 'released', to: 'superseded', requires: 'lot:release', action: 'Lot superseded' },
    { from: 'released', to: 'withdrawn', requires: 'cert:reissue', action: 'Lot withdrawn' },
  ],
});

/* ── Order ───────────────────────────────────────────────────────────────── */

export type OrderState = 'placed' | 'packed' | 'dispatched' | 'delivered' | 'cancelled';

export const ORDER_MACHINE = machine<OrderState>({
  name: 'order',
  states: ['placed', 'packed', 'dispatched', 'delivered', 'cancelled'],
  initial: 'placed',
  terminal: ['delivered', 'cancelled'],
  transitions: [
    { from: 'placed', to: 'packed', requires: 'order:advance', action: 'Order packed' },
    { from: 'packed', to: 'dispatched', requires: 'order:advance', action: 'Order dispatched' },
    { from: 'dispatched', to: 'delivered', requires: 'order:advance', action: 'Order delivered' },
    { from: 'placed', to: 'cancelled', requires: 'order:advance', action: 'Order cancelled' },
    { from: 'packed', to: 'cancelled', requires: 'order:advance', action: 'Order cancelled' },
  ],
});

/* ── Entitlement claim ───────────────────────────────────────────────────── */

export type EntitlementState = 'under_review' | 'approved' | 'rejected' | 'lapsed';

export const ENTITLEMENT_MACHINE = machine<EntitlementState>({
  name: 'entitlement',
  states: ['under_review', 'approved', 'rejected', 'lapsed'],
  initial: 'under_review',
  terminal: ['rejected', 'lapsed'],
  transitions: [
    { from: 'under_review', to: 'approved', requires: 'entitlement:decide', action: 'Tier approved' },
    { from: 'under_review', to: 'rejected', requires: 'entitlement:decide', action: 'Tier rejected' },
    // An approved tier carries a revalidation date, and lapsing is done by a
    // job with no person behind it — so it is marked system-initiated. The
    // permission still describes who may do it by hand.
    {
      from: 'approved', to: 'lapsed', requires: 'entitlement:decide',
      action: 'Tier lapsed at revalidation', systemInitiated: true,
    },
  ],
});

/* ── Complaint / CAPA ────────────────────────────────────────────────────── */

export type CapaState =
  | 'open' | 'investigation' | 'root_cause' | 'capa' | 'effectiveness' | 'closed';

export const CAPA_MACHINE = machine<CapaState>({
  name: 'capa',
  states: ['open', 'investigation', 'root_cause', 'capa', 'effectiveness', 'closed'],
  initial: 'open',
  terminal: ['closed'],
  transitions: [
    { from: 'open', to: 'investigation', requires: 'capa:manage', action: 'Investigation opened' },
    { from: 'investigation', to: 'root_cause', requires: 'capa:manage', action: 'Root cause identified' },
    { from: 'root_cause', to: 'capa', requires: 'capa:manage', action: 'Corrective action raised' },
    { from: 'capa', to: 'effectiveness', requires: 'capa:manage', action: 'Effectiveness check started' },
    { from: 'effectiveness', to: 'closed', requires: 'capa:manage', action: 'CAPA closed' },
    { from: 'effectiveness', to: 'capa', requires: 'capa:manage', action: 'Effectiveness check failed, action reopened' },
  ],
});

/* ── Generic helpers ─────────────────────────────────────────────────────── */

export function canTransition<S extends string>(
  m: StateMachine<S>,
  from: S,
  to: S,
): Transition<S> | null {
  return m.transitions.find((t) => t.from === from && t.to === to) ?? null;
}

export function nextStates<S extends string>(m: StateMachine<S>, from: S): readonly S[] {
  return m.transitions.filter((t) => t.from === from).map((t) => t.to);
}

export function isTerminal<S extends string>(m: StateMachine<S>, state: S): boolean {
  return (m.terminal as readonly string[]).includes(state);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly machineName: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machineName}: ${from} cannot move to ${to}.`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition<S extends string>(
  m: StateMachine<S>,
  from: S,
  to: S,
): Transition<S> {
  const t = canTransition(m, from, to);
  if (!t) throw new IllegalTransitionError(m.name, from, to);
  return t;
}

export class NotSystemInitiatedError extends Error {
  constructor(machineName: string, from: string, to: string) {
    super(
      `${machineName}: ${from} → ${to} is not marked systemInitiated, so scheduled ` +
      'work may not make it. A person holding the required permission must.',
    );
    this.name = 'NotSystemInitiatedError';
  }
}

/**
 * The job-shaped equivalent of the guard.
 *
 * A job cannot satisfy `requires`, so this asserts the move exists AND that the
 * machine permits the system to make it unattended. Without this a job either
 * fakes an authority or skips the machine — the entitlement lapse did the
 * latter, which is how a state change happened that the declared machine said
 * needed a permission nobody had checked.
 */
export function assertSystemTransition<S extends string>(
  m: StateMachine<S>,
  from: S,
  to: S,
): Transition<S> {
  const t = assertTransition(m, from, to);
  if (t.systemInitiated !== true) throw new NotSystemInitiatedError(m.name, from, to);
  return t;
}

export const ALL_MACHINES = [
  PROJECT_MACHINE, STUDY_MACHINE, VALUE_MACHINE, LOT_MACHINE,
  ORDER_MACHINE, ENTITLEMENT_MACHINE, CAPA_MACHINE,
] as const;
