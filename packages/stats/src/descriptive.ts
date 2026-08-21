/** Descriptive statistics. Shared by every study type. */

export class StatisticsError extends Error {
  constructor(message: string, readonly code: StatisticsErrorCode) {
    super(message);
    this.name = 'StatisticsError';
  }
}

export type StatisticsErrorCode =
  | 'EMPTY_DATASET'
  | 'INSUFFICIENT_UNITS'
  | 'INSUFFICIENT_REPLICATES'
  | 'UNBALANCED_DESIGN'
  | 'INSUFFICIENT_TIMEPOINTS'
  | 'NO_TIME_VARIATION'
  | 'NON_FINITE_VALUE';

export function assertAllFinite(values: readonly number[], what: string): void {
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new StatisticsError(
        `${what} contains a non-finite measurement (${String(v)}).`,
        'NON_FINITE_VALUE',
      );
    }
  }
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new StatisticsError('Cannot take the mean of an empty dataset.', 'EMPTY_DATASET');
  }
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Sample standard deviation (n-1). Returns 0 for a single observation, as the prototype does. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) {
    throw new StatisticsError('Cannot take the standard deviation of an empty dataset.', 'EMPTY_DATASET');
  }
  if (values.length < 2) return 0;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (values.length - 1));
}

/** Root sum of squares — how independent uncertainty contributions combine (GUM). */
export function rootSumSquare(values: readonly number[]): number {
  let ss = 0;
  for (const v of values) ss += v * v;
  return Math.sqrt(ss);
}
