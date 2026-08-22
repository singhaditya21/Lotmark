import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import postgres from 'postgres';

/**
 * A database per test worker, cloned from a template.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * Every test file used to run against `lotmark_dev` — which is also the
 * demonstration database somebody browses, and the one the PQ protocol assumes.
 * The suite is destructive: `signing-rollback.test.ts` performs a real reissue
 * of a seeded certificate on every run, into an append-only table. The drift
 * was measured: the seed defines 1 CAPA and the database held 15, 9 users and
 * it held 12, 3 lots and it held 5.
 *
 * That drift is why fixtures kept breaking on state another tool had changed,
 * why the PQ needed a reseed to pass twice, and why turning on CI would have
 * made it permanently red rather than useful.
 *
 * ── Why a template rather than a transaction ────────────────────────────────
 *
 * `packages/db`'s tests roll back — they open a transaction, do their work and
 * abort it, so they leave nothing behind. `apps/api` cannot: `app.inject` drives
 * the real Fastify request path, which opens its OWN connections from its own
 * pool, and a request cannot join a transaction the test is holding open.
 *
 * So each worker gets a real database, made with `CREATE DATABASE ... TEMPLATE`,
 * which is a file copy and takes about as long as it sounds. The template is
 * built once per run: migrate, then seed.
 */

const TEMPLATE = 'lotmark_test_tpl';

/**
 * A namespace, so two suites can run at once without sharing a database.
 *
 * Default is empty, which keeps the names exactly as they were. Set
 * `LOTMARK_TEST_NS` to run a second suite concurrently — several agents working
 * on separate parts of the codebase, each wanting to prove its own test fails
 * without its fix. Without this they all get `lotmark_test_1` and quietly
 * corrupt each other's fixtures, which is precisely the class of false result
 * this whole test-database arrangement exists to remove.
 *
 * The template is shared and read-only during a run (`CREATE DATABASE ...
 * TEMPLATE` only reads it), so namespaced runs still clone the same one — but a
 * run that REBUILDS the template while another is cloning it would fail. Only
 * the un-namespaced run rebuilds; a namespaced one requires it to exist.
 */
const NS = process.env['LOTMARK_TEST_NS'] ?? '';
const suffix = NS ? `_${NS}` : '';

/**
 * Fixed, and matched to `poolOptions` in vitest.config.ts.
 *
 * Databases are created up front rather than on demand because `CREATE
 * DATABASE ... TEMPLATE` takes a lock on the template: four workers racing to
 * clone the same one is the kind of intermittent failure this whole exercise
 * exists to remove.
 */
export const WORKERS = 4;

export const workerDatabase = (id: number) => `lotmark_test${suffix}_${id}`;
export const workerKeyDir = (id: number) => `.keys-test${suffix}-${id}`;

/** The OWNER connection — DDL, and the TRUNCATE the seed needs. */
const ownerUrl = (db: string) => `postgres://localhost:5432/${db}`;

export async function setup(): Promise<() => Promise<void>> {
  const admin = postgres('postgres://localhost:5432/postgres', {
    onnotice: () => {}, max: 1,
  });

  const drop = async (db: string) => {
    // FORCE, because a worker that crashed may have left a connection behind
    // and a DROP that fails here fails the whole run for no good reason.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  };

  try {
    if (NS) {
      // A namespaced run borrows the template rather than rebuilding it —
      // dropping it would pull the floor out from under a concurrent run.
      const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE}`;
      if (found.length === 0) {
        throw new Error(
          `LOTMARK_TEST_NS=${NS} needs the template ${TEMPLATE}, which does not exist. ` +
          'Run the suite once without LOTMARK_TEST_NS to build it.');
      }
    } else {
      await drop(TEMPLATE);
      await admin.unsafe(`CREATE DATABASE "${TEMPLATE}"`);

      const env = { ...process.env, DATABASE_URL: ownerUrl(TEMPLATE) };
      execSync('pnpm --filter @lotmark/db migrate', { env, stdio: 'pipe' });
      execSync('pnpm --filter @lotmark/db seed', { env, stdio: 'pipe' });
    }

    for (let id = 1; id <= WORKERS; id++) {
      await drop(workerDatabase(id));
      await admin.unsafe(
        `CREATE DATABASE "${workerDatabase(id)}" TEMPLATE "${TEMPLATE}"`);
      // A key directory each. The signing key is registered per DATABASE and
      // written per DIRECTORY, so sharing one directory across four databases
      // recreates by hand the mismatch that keys.ts was just fixed to prevent.
      rmSync(workerKeyDir(id), { recursive: true, force: true });
    }
  } finally {
    await admin.end();
  }

  return async () => {
    const teardown = postgres('postgres://localhost:5432/postgres', {
      onnotice: () => {}, max: 1,
    });
    try {
      for (let id = 1; id <= WORKERS; id++) {
        await teardown.unsafe(`DROP DATABASE IF EXISTS "${workerDatabase(id)}" WITH (FORCE)`);
        rmSync(workerKeyDir(id), { recursive: true, force: true });
      }
      // The template stays. It costs a rebuild next run either way, and leaving
      // it makes a failed run inspectable.
    } finally {
      await teardown.end();
    }
  };
}
