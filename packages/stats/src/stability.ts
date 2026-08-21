import { mean, assertAllFinite, StatisticsError } from './descriptive';

/** One stability timepoint: months elapsed, measured value. */
export interface StabilityPoint {
  readonly months: number;
  readonly value: number;
}

export interface StabilityResult {
  readonly n: number;
  readonly slope: number;
  readonly intercept: number;
  /** Standard error of the slope, per month. */
  readonly slopeStandardError: number;
  readonly shelfLifeMonths: number;
  /** u(lts) = SE(slope) x shelf life. */
  readonly uLts: number;
  /**
   * |slope| > 2 x SE(slope). A significant trend means the material is drifting
   * and the shelf life claim needs review — it does NOT invalidate u(lts).
   */
  readonly trendSignificant: boolean;
}

/**
 * Least-squares regression of value against time — ISO Guide 35 long-term
 * stability. u(lts) is the standard error of the slope projected across the
 * whole shelf life, which is how the guide treats an undetected drift.
 *
 * Needs at least 3 timepoints: the residual variance divides by (n - 2), so
 * two points give a division by zero and a meaningless zero uncertainty. The
 * prototype did not guard this.
 */
export function linearStability(
  points: readonly StabilityPoint[],
  shelfLifeMonths: number,
): StabilityResult {
  if (points.length === 0) {
    throw new StatisticsError('A stability study needs measurements.', 'EMPTY_DATASET');
  }
  if (points.length < 3) {
    throw new StatisticsError(
      `A stability regression needs at least 3 timepoints; got ${points.length}. ` +
        'With 2 points the residual variance is undefined.',
      'INSUFFICIENT_TIMEPOINTS',
    );
  }
  assertAllFinite(points.map((p) => p.value), 'Stability study');
  assertAllFinite(points.map((p) => p.months), 'Stability timepoints');

  const x = points.map((p) => p.months);
  const y = points.map((p) => p.value);
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);

  let sxx = 0;
  for (const v of x) sxx += (v - mx) * (v - mx);
  if (sxx === 0) {
    throw new StatisticsError(
      'Every stability timepoint is at the same elapsed time; no trend can be estimated.',
      'NO_TIME_VARIATION',
    );
  }

  let sxy = 0;
  for (let i = 0; i < n; i++) sxy += (x[i]! - mx) * (y[i]! - my);

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let ssResidual = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i]! - (intercept + slope * x[i]!);
    ssResidual += r * r;
  }
  const residualVariance = ssResidual / (n - 2);
  const slopeStandardError = Math.sqrt(residualVariance / sxx);

  return {
    n,
    slope,
    intercept,
    slopeStandardError,
    shelfLifeMonths,
    uLts: slopeStandardError * shelfLifeMonths,
    trendSignificant: Math.abs(slope) > 2 * slopeStandardError,
  };
}

/** Shelf life in whole months between two ISO dates, floored at 1. */
export function shelfLifeMonthsBetween(studyDate: string, expiryDate: string): number {
  const from = Date.parse(studyDate);
  const to = Date.parse(expiryDate);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new StatisticsError('Shelf life needs two parseable ISO dates.', 'NON_FINITE_VALUE');
  }
  const MS_PER_MONTH = 2_592_000_000; // 30 days, matching the prototype
  return Math.max(1, Math.round((to - from) / MS_PER_MONTH));
}
