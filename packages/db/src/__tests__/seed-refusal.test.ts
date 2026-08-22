import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The seed must not be able to run against production.
 *
 * ── Why this is a spawned process and not a unit test ───────────────────────
 *
 * The property under test is not "a function throws" — it is "the seed refuses
 * BEFORE it opens a connection". Importing run.ts would execute `main()` on
 * import, and a refusal that happened after the first TRUNCATE would still pass
 * an assertion about the error while having destroyed the ledger.
 *
 * So the seed is run for real, with DATABASE_URL pointing at a database that
 * does not exist. If it were to get as far as connecting, the failure would be
 * a connection error and would not match the message asserted below — which is
 * what makes this a test of the ORDER of events and not just of the text.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SEED = path.resolve(REPO, 'packages/db/src/seed/run.ts');

/** A database nothing can connect to, so "it connected" and "it refused" cannot be confused. */
const NOWHERE = 'postgres://localhost:5432/lotmark_seed_refusal_no_such_db';

const runSeed = (nodeEnv: string | undefined) => spawnSync(
  'pnpm', ['exec', 'tsx', SEED],
  {
    cwd: path.resolve(REPO, 'packages/db'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: NOWHERE,
      ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
    },
  },
);

describe('the seed under NODE_ENV=production', () => {
  it('refuses, and says why, before touching anything', () => {
    const run = runSeed('production');
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status, 'a refusal has to be a non-zero exit or a script will run on past it')
      .not.toBe(0);
    expect(output).toMatch(/refuses to run with NODE_ENV=production/);

    /**
     * The two facts an operator needs, both asserted because either alone
     * understates it: this destroys the append-only record 21 CFR 11 exists to
     * protect, and it mints accounts whose password is published in the file.
     */
    expect(output).toMatch(/audit_ledger/);
    expect(output).toMatch(/one password/);
    expect(output, 'and it says what to do instead').toMatch(/provision_tenant/);

    // It never got as far as the database. If it had, this is the error there
    // would have been instead.
    expect(output).not.toMatch(/does not exist|ECONNREFUSED|CONNECT_TIMEOUT/);
    expect(output, 'the banner is printed after the connection is opened').not.toMatch(/seeding into/);
  }, 60_000);

  it('does not refuse when the environment is not production', () => {
    /**
     * The other half: the guard must not have made the seed unusable. This one
     * is EXPECTED to fail, at the connection, because DATABASE_URL points at
     * nothing — which is proof that it got past the refusal and no further.
     */
    const run = runSeed('development');
    const output = `${run.stdout}${run.stderr}`;
    expect(output).not.toMatch(/refuses to run/);
    expect(output).toMatch(/seeding into/);
  }, 60_000);
});
