import { defineConfig } from 'vitest/config';
import { WORKERS } from './test/global-setup';

/**
 * The API suite runs against a database per worker, not against `lotmark_dev`.
 * See `test/global-setup.ts` for why, and what it replaces.
 */
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    /**
     * `forks` named explicitly, and its limit pinned.
     *
     * Vitest 2 defaults to the forks pool, so a `poolOptions.threads` block is
     * silently ignored — which is how the first attempt handed a worker
     * `VITEST_POOL_ID=5` against four databases and failed with "database
     * lotmark_test_5 does not exist". Naming the pool means the limit below
     * applies to the pool actually in use.
     *
     * Four is enough to keep the suite quick, and small enough that four
     * connection pools stay well inside PostgreSQL's `max_connections`.
     */
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: WORKERS } },
  },
});
