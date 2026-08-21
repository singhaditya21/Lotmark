import { mean, standardDeviation, assertAllFinite, StatisticsError } from './descriptive.js';

/** One characterisation result from one laboratory. */
export interface CharacterisationResult {
  readonly laboratory: string;
  readonly value: number;
}

export interface ConsensusResult {
  readonly laboratories: number;
  /** The consensus mean — this becomes the assigned property value. */
  readonly value: number;
  readonly standardDeviation: number;
  /** u(char) = s / sqrt(p), the standard error of the consensus mean. */
  readonly uChar: number;
}

/**
 * Interlaboratory consensus — ISO Guide 35 characterisation.
 *
 * Produces BOTH u(char) and the assigned value itself. Nothing in the system
 * lets a person type an assigned value: it is computed from the raw results of
 * a signed characterisation study, which is the point.
 *
 * Note for a future hardening pass: this is an unweighted mean with no outlier
 * treatment. ISO Guide 35 also permits robust estimators (Algorithm A / Q-Hampel)
 * and weighting by each laboratory's own reported uncertainty. Adding those is a
 * change to how values are assigned and must be a versioned, auditable decision
 * rather than a silent improvement, so the estimator in use is recorded on the
 * study alongside the result.
 */
export function consensus(rows: readonly CharacterisationResult[]): ConsensusResult {
  if (rows.length === 0) {
    throw new StatisticsError('A characterisation study needs results.', 'EMPTY_DATASET');
  }
  const values = rows.map((r) => r.value);
  assertAllFinite(values, 'Characterisation study');

  const s = standardDeviation(values);
  return {
    laboratories: values.length,
    value: mean(values),
    standardDeviation: s,
    uChar: s / Math.sqrt(values.length),
  };
}
