import {
  can, findSodViolation, findThresholdViolation, isBasisValid,
  type Permission, type AuthScope, type ResolvedAuthority,
  type SodSettings, type SodThresholds, type CompetenceBasis, type SodViolation,
} from '@lotmark/domain';

/**
 * The authorisation decision point.
 *
 * Called by the APPLICATION SERVICE, never by route middleware. A background
 * job, a CLI command, an importer and a future mobile API all reach the domain
 * through the same services, so putting the decision in an HTTP hook would let
 * three of those four bypass it entirely.
 *
 * `decide()` is pure: it takes everything it needs as arguments and returns a
 * verdict. That makes every refusal reproducible in a test without a database,
 * a request or a clock, and it lets the UI ask the same question to grey out a
 * button and get the same answer the server will give.
 */

export type DenialReason =
  | 'not_authenticated'
  | 'permission_denied'
  | 'segregation_of_duties'
  | 'competence_missing'
  | 'competence_expired'
  | 'signature_required'
  | 'out_of_scope';

export interface Denial {
  readonly allowed: false;
  readonly reason: DenialReason;
  /** What the user is told. Specific enough to act on, never leaking what they cannot see. */
  readonly message: string;
  /** Structured detail for the denial ledger. */
  readonly detail: Record<string, unknown>;
}

export interface Allowance {
  readonly allowed: true;
  /** The competence authorisation relied on, to be frozen onto any signature. */
  readonly competenceBasis: CompetenceBasis | null;
  /** True when the caller must still collect a signature before committing. */
  readonly signatureRequired: boolean;
}

export type Verdict = Denial | Allowance;

export interface GuardRequest {
  readonly authority: ResolvedAuthority | null;
  readonly permission: Permission;
  readonly scope: AuthScope;
  /** The record being acted on; SoD rules read the earlier actor from it. */
  readonly record?: Readonly<Record<string, unknown>> | null;
  /**
   * Which segregation rules run.
   *
   * An absent entry falls back to the rule's `defaultEnabled`, so passing `{}`
   * and passing `defaultSodSettings()` are IDENTICAL — worth saying, because
   * both appear across the routes and a reader cannot otherwise tell whether
   * the difference matters. It never did.
   *
   * What matters is passing the TENANT'S settings, from `tenantSod()`, at any
   * call that also supplies a `record` or an `amountMinor`. Everywhere else no
   * rule can fire — `findSodViolation` returns null without a record — so the
   * argument is inert and the extra query would buy nothing.
   */
  readonly sodSettings: SodSettings;
  /**
   * The tenant's own figures for a threshold rule, where it set any.
   *
   * Separate from `sodSettings` because they answer different questions —
   * whether a rule runs, and what numbers it runs with — and collapsing them
   * would make the common case (enabled/disabled) carry a shape it does not
   * need.
   */
  readonly sodThresholds?: SodThresholds | undefined;
  /** The date the act is evaluated against — normally today, or an as-at date. */
  readonly onDate: string;
  /**
   * Competence lookup. Injected rather than queried here, so the decision stays
   * pure and the caller controls the transaction the read happens in.
   */
  readonly competenceFor?: (activity: Permission) => CompetenceBasis | null;
  /** Set when the configured transition demands a manifested signature. */
  readonly requiresSignature?: boolean;
  /** Set when the configured transition is competence-gated. */
  readonly requiresCompetence?: Permission;
  /** Threshold-approval inputs, when the act carries a monetary value. */
  readonly amountMinor?: number;
  readonly approverUserIds?: readonly string[];
}

export function decide(req: GuardRequest): Verdict {
  if (!req.authority) {
    return deny('not_authenticated', 'You are not signed in.', { permission: req.permission });
  }

  // 1. Does the actor hold the capability, in this scope?
  if (!can(req.authority, req.permission, req.scope)) {
    return deny(
      'permission_denied',
      `You do not hold '${req.permission}'${scopeSuffix(req.scope)}.`,
      { permission: req.permission, scope: req.scope, userId: req.authority.userId },
    );
  }

  // 2. Segregation of duties — actor-comparison rules.
  const sod = findSodViolation(req.permission, req.record, req.authority.userId, req.sodSettings);
  if (sod) return denySod(sod, req.permission);

  // 3. Segregation of duties — threshold rules.
  if (req.amountMinor !== undefined) {
    const threshold = findThresholdViolation(
      req.permission,
      req.amountMinor,
      req.approverUserIds ?? [req.authority.userId],
      req.sodSettings,
      req.sodThresholds ?? {},
    );
    if (threshold) return denySod(threshold, req.permission);
  }

  // 4. Competence — ISO 17034 6.3. Holding the permission is necessary but not
  //    sufficient: the person must be authorised for the activity ON THE DAY.
  let basis: CompetenceBasis | null = null;
  if (req.requiresCompetence) {
    basis = req.competenceFor?.(req.requiresCompetence) ?? null;
    if (!basis) {
      return deny(
        'competence_missing',
        `You hold no competence authorisation for '${req.requiresCompetence}' as at ${req.onDate}.`,
        { activity: req.requiresCompetence, onDate: req.onDate, userId: req.authority.userId },
      );
    }
    if (!isBasisValid(basis)) {
      return deny(
        'competence_expired',
        `Your competence authorisation for '${req.requiresCompetence}' does not cover ${req.onDate} ` +
          `(valid ${basis.validFrom} to ${basis.validTo}).`,
        { activity: req.requiresCompetence, onDate: req.onDate, validFrom: basis.validFrom, validTo: basis.validTo },
      );
    }
  }

  return {
    allowed: true,
    competenceBasis: basis,
    signatureRequired: req.requiresSignature === true,
  };
}

/** Thrown by `guard()`. Carries the verdict so the caller can record the denial. */
export class Forbidden extends Error {
  constructor(readonly denial: Denial) {
    super(denial.message);
    this.name = 'Forbidden';
  }
}

/**
 * Throwing form.
 *
 * Services call this. The verdict travels on the exception so the denial can be
 * written to the ledger with its structured detail — a refusal is evidence that
 * a control worked, and losing it wastes the control.
 */
export function guard(req: GuardRequest): Allowance {
  const verdict = decide(req);
  if (!verdict.allowed) throw new Forbidden(verdict);
  return verdict;
}

function deny(reason: DenialReason, message: string, detail: Record<string, unknown>): Denial {
  return { allowed: false, reason, message, detail };
}

function denySod(v: SodViolation, permission: Permission): Denial {
  return deny(
    'segregation_of_duties',
    `Segregation of duties (${v.rule.id}): ${v.reason}.`,
    { rule: v.rule.id, permission, provenance: v.rule.provenance },
  );
}

function scopeSuffix(scope: AuthScope): string {
  return scope.kind === 'team' ? ` in this team` : ' at tenant level';
}
