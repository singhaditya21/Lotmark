import { describe, it, expect } from 'vitest';
import type { Sql } from '../db';
import { jobStatuses, needsAttention } from '../services/ops';
import { JOBS } from '../jobs/scheduler';

/**
 * Reading job health.
 *
 * The derivation is what matters here, not the SQL: `lotmark.job_health()`
 * reports one row per job that has EVER run, and the interesting states are the
 * ones with no row at all or a row that never closed.
 *
 * The query is stubbed so each state can be constructed exactly. The function
 * under test is the part that decides what an operator is told.
 */

interface HealthRow {
  job_name: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  last_success_at: string | null;
  consecutive_failures: string;
  running: boolean;
}

/** A `tx` that answers the one query jobStatuses makes. */
const stub = (rows: HealthRow[]): Sql =>
  (() => Promise.resolve(rows)) as unknown as Sql;

const NOW = new Date('2026-08-21T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (over: Partial<HealthRow> & { job_name: string }): HealthRow => ({
  last_started_at: hoursAgo(2),
  last_finished_at: hoursAgo(2),
  last_outcome: 'success',
  last_error: null,
  last_success_at: hoursAgo(2),
  consecutive_failures: '0',
  running: false,
  ...over,
});

const NAME = JOBS[0]!.name;

describe('a job that has never run', () => {
  it('is reported, not omitted', async () => {
    /**
     * The state that is easiest to miss and worst to miss. `job_health()`
     * returns nothing for a job with no runs, and an empty result reads as
     * "no problems" — so the known job list is joined against it in code.
     */
    const statuses = await jobStatuses(stub([]), 't', NOW);
    expect(statuses).toHaveLength(JOBS.length);
    expect(statuses.every((s) => s.state === 'never_run')).toBe(true);
    expect(statuses[0]!.advice).toMatch(/never run/);
    expect(statuses[0]!.advice, 'and it says what to do').toMatch(/pnpm worker/);
  });

  it('counts as needing attention', async () => {
    const statuses = await jobStatuses(stub([]), 't', NOW);
    expect(needsAttention(statuses)).toHaveLength(JOBS.length);
  });
});

describe('the states an operator has to tell apart', () => {
  const only = async (r: HealthRow) => {
    const all = await jobStatuses(stub([r]), 't', NOW);
    return all.find((s) => s.name === r.job_name)!;
  };

  it('healthy: succeeded inside its window', async () => {
    const s = await only(row({ job_name: NAME }));
    expect(s.state).toBe('healthy');
    expect(s.advice).toBeNull();
    expect(needsAttention([s])).toEqual([]);
  });

  it('failing: reports the count and the error', async () => {
    const s = await only(row({
      job_name: NAME, last_outcome: 'failure', consecutive_failures: '5',
      last_error: 'connection refused', last_success_at: hoursAgo(120),
    }));
    expect(s.state).toBe('failing');
    expect(s.advice).toMatch(/5 run\(s\) have failed/);
    expect(s.advice).toMatch(/connection refused/);
  });

  it('stale: succeeded, but too long ago', async () => {
    // A job that has not failed and has not run is not healthy. Nothing is
    // wrong with the last run; the problem is that there has not been one.
    const s = await only(row({
      job_name: NAME,
      last_started_at: hoursAgo(100), last_finished_at: hoursAgo(100),
      last_success_at: hoursAgo(100),
    }));
    expect(s.state).toBe('stale');
    expect(s.hoursSinceSuccess).toBe(100);
    expect(s.advice).toMatch(/expected at least every/);
  });

  it('running: a fresh run is not a problem', async () => {
    const s = await only(row({
      job_name: NAME, last_started_at: hoursAgo(0.1), last_finished_at: null, last_outcome: null,
    }));
    expect(s.state).toBe('running');
    expect(s.advice, 'a job that started a moment ago needs no advice').toBeNull();
    expect(needsAttention([s]), 'and is not something to act on').toEqual([]);
  });

  it('running: one that never closed IS a problem', async () => {
    /**
     * The reason runs are opened before the work starts. A row that stays open
     * long after its cadence is the clearest evidence there is that the process
     * was killed — nothing was left alive to close it.
     */
    const s = await only(row({
      job_name: NAME, last_started_at: hoursAgo(9), last_finished_at: null, last_outcome: null,
    }));
    expect(s.state).toBe('running');
    expect(s.advice).toMatch(/running for 9\.0 hours/);
    expect(s.advice).toMatch(/killed/);
  });

  it('reports failing ahead of stale when a job is both', async () => {
    // They usually coincide, and only one of them tells the operator what to
    // do. An error message beats "it has not run lately".
    const s = await only(row({
      job_name: NAME, last_outcome: 'failure', consecutive_failures: '3',
      last_error: 'permission denied', last_success_at: hoursAgo(400),
    }));
    expect(s.state).toBe('failing');
  });

  it('treats a job that has never succeeded as overdue rather than healthy', async () => {
    const s = await only(row({
      job_name: NAME, last_outcome: 'partial', last_success_at: null, consecutive_failures: '0',
    }));
    expect(s.hoursSinceSuccess).toBeNull();
    expect(s.state).not.toBe('healthy');
  });
});

describe('every job declares how often it is expected', () => {
  it('has a tolerance greater than its schedule', async () => {
    // The tolerance is not the schedule: it has to allow for retries, a restart
    // and a night the machine was asleep. All four jobs are daily.
    for (const job of JOBS) {
      expect(job.expectedEveryHours, job.name).toBeGreaterThan(24);
    }
  });
});
