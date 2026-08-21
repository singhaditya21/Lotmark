import postgres from 'postgres';
import type { AppConfig } from './config';

export type Sql = ReturnType<typeof postgres>;

/**
 * The database connection.
 *
 * `date` and `timestamp` values are returned as STRINGS, never JS `Date`. The
 * domain compares dates lexically and treats them as calendar facts; a driver
 * that constructs a `Date` reintroduces timezone drift, and in this domain that
 * drift can move a signature across a competence boundary.
 */
export function createDb(cfg: AppConfig): Sql {
  return postgres(cfg.DATABASE_URL, {
    max: 10,
    onnotice: () => {},
    types: {
      date: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
  });
}

/**
 * Run `fn` in a transaction carrying the request's tenant and the audit key.
 *
 * Both are session-local settings (`set_config(..., true)`), so they vanish
 * when the transaction ends and cannot leak into the next borrower of a pooled
 * connection. Every write path goes through here: the chain trigger REFUSES to
 * append without the key, which means a code path that forgets this wrapper
 * fails loudly at its first audited act rather than silently writing
 * unverifiable history.
 */
export async function inTenantTransaction<T>(
  sql: Sql,
  args: { readonly tenantId: string; readonly auditKey: string },
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.tenant_id', ${args.tenantId}, true)`;
    await tx`SELECT set_config('lotmark.audit_key', ${args.auditKey}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
