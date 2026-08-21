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

export const DEFAULT_URL = 'postgres://localhost:5432/lotmark_dev';
export type Sql = ReturnType<typeof createClient>;
