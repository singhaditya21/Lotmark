import { mean, assertAllFinite, StatisticsError } from './descriptive.js';

/** One measurement: unit (bottle/vial) identifier, replicate number, value. */
export interface HomogeneityMeasurement {
  readonly unit: number | string;
  readonly replicate: number;
  readonly value: number;
}

export interface HomogeneityResult {
  readonly units: number;
  readonly replicatesPerUnit: number;
  readonly grandMean: number;
  /** Mean square between units. */
  readonly msBetween: number;
  /** Mean square within units (repeatability). */
  readonly msWithin: number;
  /** Between-unit standard deviation = u(bb). */
  readonly sBetween: number;
  readonly uBb: number;
  /**
   * True when MS(between) <= MS(within), so the between-unit variance estimate
   * came out negative and u(bb) was replaced by the detection limit instead.
   * An assessor will ask about this, so it is reported, never hidden.
   */
  readonly floored: boolean;
  readonly withinStandardDeviation: number;
}

/**
 * One-way ANOVA over units — ISO Guide 35 homogeneity assessment.
 *
 * u(bb) is the between-unit standard deviation. When MS(between) falls below
 * MS(within) the variance estimate (MSb - MSw)/n is negative, which is
 * physically impossible; the conventional treatment substitutes the *detection
 * limit* of the design:
 *
 *     u*(bb) = sqrt(MSw / n) * (2 / (df_within))^(1/4)
 *
 * This is the same expression the prototype used, preserved exactly so that
 * historical results stay reproducible.
 *
 * Requires a BALANCED design (equal replicates per unit). Unbalanced data is
 * rejected rather than silently mis-analysed: the prototype read the replicate
 * count off the first group and would have produced a wrong answer for ragged
 * input without ever saying so.
 */
export function oneWayAnova(rows: readonly HomogeneityMeasurement[]): HomogeneityResult {
  if (rows.length === 0) {
    throw new StatisticsError('A homogeneity study needs measurements.', 'EMPTY_DATASET');
  }
  assertAllFinite(rows.map((r) => r.value), 'Homogeneity study');

  const unitIds = [...new Set(rows.map((r) => r.unit))];
  if (unitIds.length < 2) {
    throw new StatisticsError(
      `A homogeneity ANOVA needs at least 2 units; got ${unitIds.length}.`,
      'INSUFFICIENT_UNITS',
    );
  }

  const groups = unitIds.map((u) => rows.filter((r) => r.unit === u).map((r) => r.value));

  const reps = groups[0]!.length;
  if (reps < 2) {
    throw new StatisticsError(
      `A homogeneity ANOVA needs at least 2 replicates per unit; got ${reps}.`,
      'INSUFFICIENT_REPLICATES',
    );
  }
  const ragged = groups.filter((g) => g.length !== reps).length;
  if (ragged > 0) {
    throw new StatisticsError(
      `Unbalanced design: ${ragged} of ${groups.length} units do not have ${reps} replicates. ` +
        'Balanced replication is required for this analysis.',
      'UNBALANCED_DESIGN',
    );
  }

  const all = rows.map((r) => r.value);
  const grandMean = mean(all);

  let ssBetween = 0;
  for (const g of groups) {
    const d = mean(g) - grandMean;
    ssBetween += reps * d * d;
  }
  const msBetween = ssBetween / (unitIds.length - 1);

  let ssWithin = 0;
  for (const g of groups) {
    const gm = mean(g);
    for (const v of g) ssWithin += (v - gm) * (v - gm);
  }
  const msWithin = ssWithin / (all.length - unitIds.length);

  const varianceBetween = (msBetween - msWithin) / reps;
  const floored = varianceBetween <= 0;

  const dfWithin = (unitIds.length - 1) * (reps - 1) || 1;
  const sBetween = floored
    ? Math.sqrt(msWithin / reps) * Math.pow(2 / dfWithin, 0.25)
    : Math.sqrt(varianceBetween);

  return {
    units: unitIds.length,
    replicatesPerUnit: reps,
    grandMean,
    msBetween,
    msWithin,
    sBetween,
    uBb: sBetween,
    floored,
    withinStandardDeviation: Math.sqrt(msWithin),
  };
}
