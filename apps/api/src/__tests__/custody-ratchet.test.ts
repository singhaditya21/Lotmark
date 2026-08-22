import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { PRODUCTION_GRADE, ALL_CUSTODY_CLASSES } from '../services/custody';

/**
 * The custody ratchet, and the two places it is written down.
 *
 * `loadConfig` already refuses to start a production process on a custody class
 * unfit for one. What it cannot see is a DEVELOPMENT process pointed at a
 * production database — NODE_ENV says `development`, the guard is satisfied,
 * and a `dev_file` key is registered against the production tenant. Custody is
 * printed on every certificate that key signs, into an append-only table.
 *
 * Migration 0029 puts the invariant in the database, which is the only party to
 * that accident that can see where the tenant's keys have already been.
 */

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is not set; test/setup.ts should have.');

let sql: Sql;
let tenantId: string;

beforeAll(async () => {
  sql = postgres(url, { onnotice: () => {}, max: 2 });
  const [row] = await sql`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  tenantId = (row as { id: string }).id;
});

afterAll(async () => { await sql?.end(); });

/**
 * Every case here writes signing keys and then throws the transaction away.
 *
 * A registered key is not a thing a test may leave behind: `signing_keys` has a
 * unique index on one active key per purpose, the key provider caches by
 * tenant, and the private half lives on disk rather than in the row — so a
 * stray row is a key the rest of the suite can find and cannot use.
 */
class Rollback extends Error {
  constructor(readonly value: unknown) { super('deliberate rollback'); }
}

const discarded = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${tenantId}, true)`;
      throw new Rollback(await fn(tx as unknown as Sql));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('the transaction committed, which it was supposed not to');
};

const register = (tx: Sql, version: string, custody: string, purpose = 'record') => tx`
  INSERT INTO lotmark.signing_keys
    (tenant_id, key_version, public_key_pem, fingerprint, custody, activated_at, purpose)
  VALUES (${tenantId}, ${version}, 'pem', ${'fp-' + version}, ${custody}, now(), ${purpose})`;

/** Free the one-active-key-per-purpose index so a case can register its own. */
const retireEverything = (tx: Sql) => tx`
  UPDATE lotmark.signing_keys SET retired_at = now(), retired_reason = 'test'
  WHERE tenant_id = ${tenantId} AND retired_at IS NULL`;

describe('custody does not silently go backwards', () => {
  it('refuses a dev_file key for a tenant that already holds a production-grade one', async () => {
    const err = await discarded(async (tx) => {
      await retireEverything(tx);
      await register(tx, 'ratchet-env', 'env');
      return register(tx, 'ratchet-dev', 'dev_file', 'anchor')
        .then(() => null, (e: Error) => e.message);
    });
    expect(err, 'the downgrade was accepted').not.toBeNull();
    // The operator reading this is nearly always looking at the wrong database.
    expect(err).toContain('DATABASE_URL');
    expect(err).toContain('dev_file');
  });

  it('counts a class the tenant has moved away from, not only one it holds', async () => {
    /*
     * A key moved into a KMS and later retired still proves the tenant had
     * somewhere better to put it. Reading only the CURRENT custody of live keys
     * would let a tenant retire its way back down to dev_file.
     */
    const err = await discarded(async (tx) => {
      await retireEverything(tx);
      await tx`
        INSERT INTO lotmark.key_custody_events
          (tenant_id, key_version, fingerprint, from_custody, to_custody, moved_by, reason)
        VALUES (${tenantId}, 'moved-v1', 'fp-moved', 'dev_file', 'kms',
                NULL, 'proving the ratchet reads history')`;
      return register(tx, 'ratchet-after-move', 'dev_file')
        .then(() => null, (e: Error) => e.message);
    });
    expect(err).toContain('kms');
  });

  it('leaves a tenant that has only ever used dev_file alone', async () => {
    /*
     * The whole test suite, the seed and every developer machine are in this
     * state. A ratchet that fired here would be indistinguishable from a bug.
     */
    const ok = await discarded(async (tx) => {
      await retireEverything(tx);
      await register(tx, 'ratchet-first', 'dev_file');
      const rows = await tx`
        SELECT custody FROM lotmark.signing_keys WHERE key_version = 'ratchet-first'`;
      return (rows[0] as { custody: string } | undefined)?.custody;
    });
    expect(ok).toBe('dev_file');
  });

  it('never blocks a move UP, whatever the tenant holds', async () => {
    const ok = await discarded(async (tx) => {
      await retireEverything(tx);
      await register(tx, 'ratchet-low', 'dev_file');
      await retireEverything(tx);
      await register(tx, 'ratchet-high', 'env');
      const rows = await tx`
        SELECT custody FROM lotmark.signing_keys WHERE key_version = 'ratchet-high'`;
      return (rows[0] as { custody: string } | undefined)?.custody;
    });
    expect(ok).toBe('env');
  });
});

describe('the database and custody.ts agree about which classes are production grade', () => {
  /**
   * The reason this test exists.
   *
   * The trigger has to run where the INSERT happens, so the list of
   * production-grade classes is written in SQL as well as in TypeScript. Two
   * stores for one fact is precisely the defect this codebase has been removing
   * all week — the difference is that this pair is checked. If the two ever
   * disagree, the database is the one that decides, and it would decide
   * silently.
   */
  it('agrees class by class', async () => {
    for (const cls of ALL_CUSTODY_CLASSES) {
      const [row] = await sql`
        SELECT lotmark.custody_is_production_grade(${cls}) AS grade`;
      expect((row as { grade: boolean }).grade,
        `the database and PRODUCTION_GRADE disagree about '${cls}'`)
        .toBe(PRODUCTION_GRADE[cls]);
    }
  });

  it('knows about every class the schema allows', async () => {
    /*
     * The CHECK constraint on signing_keys.custody is a third copy of the
     * vocabulary. If a class is added there and nowhere else, the ratchet would
     * treat it as not production grade and refuse keys nobody meant to refuse.
     */
    const [row] = await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'signing_key_custody_known'`;
    const def = (row as { def: string }).def;
    const inSchema = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(new Set(inSchema)).toEqual(new Set(ALL_CUSTODY_CLASSES));
  });
});
