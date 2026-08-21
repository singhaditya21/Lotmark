import { rootSumSquare } from './descriptive';

export type StudyType =
  | 'homogeneity'
  | 'stability'
  | 'characterisation'
  | 'confirmatory retest';

/** One named contribution to the combined uncertainty, as an assessor expects to see it. */
export interface UncertaintyComponent {
  readonly studyId: string;
  readonly studyType: StudyType;
  /** u(bb) | u(lts) | u(char) */
  readonly symbol: string;
  readonly value: number;
  /** Plain-language statement of how this number was obtained. */
  readonly basis: string;
}

export interface UncertaintyBudget {
  readonly uBb: number | null;
  readonly uLts: number | null;
  readonly uChar: number | null;
  /** Combined standard uncertainty, root-sum-square of the present components. */
  readonly uCombined: number | null;
  /**
   * True only when all three components are present. A budget missing a
   * component is NOT an error — it is an incomplete project, and the lot
   * cannot be released until it completes.
   */
  readonly complete: boolean;
  readonly components: readonly UncertaintyComponent[];
}

/**
 * Combine the components into u_c.
 *
 * Only components from SIGNED studies may be passed in; an unsigned study has
 * no standing. That filtering is the caller's job because study state lives in
 * the database, not in this package — keeping this module pure and testable.
 */
export function combineBudget(components: readonly UncertaintyComponent[]): UncertaintyBudget {
  const pick = (symbol: string): number | null =>
    components.find((c) => c.symbol === symbol)?.value ?? null;

  const uBb = pick('u(bb)');
  const uLts = pick('u(lts)');
  const uChar = pick('u(char)');

  const present = [uBb, uLts, uChar].filter((x): x is number => x !== null);
  const uCombined = present.length > 0 ? rootSumSquare(present) : null;

  return {
    uBb,
    uLts,
    uChar,
    uCombined,
    complete: uBb !== null && uLts !== null && uChar !== null,
    components,
  };
}

/**
 * Expanded uncertainty U = k * u_c.
 *
 * k is stored per property value rather than assumed, because the coverage
 * factor is a documented choice (k=2 for ~95% under a normal assumption; a
 * t-based k is required when effective degrees of freedom are low).
 */
export function expandedUncertainty(uCombined: number, coverageFactor: number): number {
  if (!Number.isFinite(coverageFactor) || coverageFactor <= 0) {
    throw new Error(`Coverage factor must be a positive number; got ${String(coverageFactor)}.`);
  }
  return coverageFactor * uCombined;
}

/** Relative expanded uncertainty as a percentage of the assigned value. */
export function relativeExpandedUncertainty(
  expanded: number,
  assignedValue: number,
): number {
  if (assignedValue === 0) throw new Error('Cannot express uncertainty relative to a zero value.');
  return (expanded / assignedValue) * 100;
}
