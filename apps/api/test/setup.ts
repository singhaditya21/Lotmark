import { WORKERS, workerDatabase, workerKeyDir } from './global-setup';

/**
 * Point this worker at its own database and its own key directory.
 *
 * Runs before any test file in the worker imports anything, so `loadConfig()`
 * — which reads `process.env` when it is called — sees these.
 *
 * The connection is `lotmark_app`, NOT the owner. That is the whole point of
 * the exercise: `lotmark_app` is not a superuser and not the schema owner, so
 * row-level security applies to it. Connecting as the owner would mean tenant
 * isolation is absent in the test suite and first exercised in production.
 */
const id = Number(process.env['VITEST_POOL_ID'] ?? 1);

/**
 * Fail with the reason rather than with "database lotmark_test_5 does not
 * exist", which is what a mismatch between the pool limit and the number of
 * databases actually looks like from here.
 */
if (!Number.isInteger(id) || id < 1 || id > WORKERS) {
  throw new Error(
    `Vitest gave this worker pool id ${id}, and global setup created ${WORKERS} ` +
    'databases. The pool limit in vitest.config.ts and WORKERS must agree.',
  );
}

process.env['DATABASE_URL'] =
  `postgres://lotmark_app@localhost:5432/${workerDatabase(id)}`;
process.env['SIGNING_KEY_DIR'] = workerKeyDir(id);
