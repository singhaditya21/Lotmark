import postgres from 'postgres';

/**
 * The connection factory.
 *
 * `date` and `timestamp` columns are returned as STRINGS, never as JS `Date`.
 * The domain compares dates lexically and treats them as calendar facts; a
 * driver that hands back a `Date` reintroduces timezone drift, and in this
 * domain that drift can move a signature across a competence boundary.
 */
export function createClient(url = process.env.DATABASE_URL ?? DEFAULT_URL) {
  return postgres(url, {
    types: {
      // 1082 = date, 1114 = timestamp, 1184 = timestamptz
      date: { to: 1184, from: [1082, 1114, 1184], serialize: (x: string) => x, parse: (x: string) => x },
    },
    onnotice: () => {},
    max: 10,
  });
}

/**
 * The APPLICATION connection: `lotmark_app`, deliberately not a superuser and
 * not the schema owner, because a superuser bypasses row-level security
 * unconditionally. Connecting as one would mean tenant isolation is absent in
 * development and the test suite, and first exercised in production.
 */
export const DEFAULT_URL = 'postgres://lotmark_app@localhost:5432/lotmark_dev';

/**
 * The MIGRATION and SEED connection: the schema owner.
 *
 * Needed only for work the application must never be able to do — DDL, and
 * TRUNCATE, which bypasses the row triggers that make the ledger append-only.
 */
export const ADMIN_URL = 'postgres://localhost:5432/lotmark_dev';
export type Sql = ReturnType<typeof createClient>;
