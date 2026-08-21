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
export interface TenantTransactionArgs {
  readonly tenantId: string;
  readonly auditKey: string;
  /**
   * The generation the audit key belongs to. Defaults to 'v1' in the database,
   * which is what every ledger written before rotation existed used.
   */
  readonly auditKeyGeneration?: string | undefined;
  /**
   * Retired keys, as JSON mapping generation to key, for VERIFYING history
   * written under an earlier key. Never needed to write.
   */
  readonly auditKeys?: string | undefined;
}

export async function inTenantTransaction<T>(
  sql: Sql,
  args: TenantTransactionArgs,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.tenant_id', ${args.tenantId}, true)`;
    await tx`SELECT set_config('lotmark.audit_key', ${args.auditKey}, true)`;
    if (args.auditKeyGeneration) {
      await tx`SELECT set_config('lotmark.audit_key_generation', ${args.auditKeyGeneration}, true)`;
    }
    if (args.auditKeys) {
      await tx`SELECT set_config('lotmark.audit_keys', ${args.auditKeys}, true)`;
    }
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/**
 * Read the records as they stood on a past date.
 *
 * Separate from `inTenantTransaction` on purpose, and READ-ONLY by
 * construction: every table carries a trigger refusing writes while
 * `lotmark.as_of` is set, so a handler that strays into a write fails loudly
 * rather than producing a backdated record.
 *
 * THE GUARD MUST NEVER SEE THIS DATE. Authorisation asks "may this person do
 * this NOW" — evaluating it against a past date would let somebody act on the
 * strength of a competence that has since lapsed, or a role they no longer
 * hold. `RequestContext.today` therefore stays the real date, and this
 * parameter is threaded only into the query layer.
 */
export async function inTenantAsOf<T>(
  sql: Sql,
  args: { readonly tenantId: string; readonly auditKey: string; readonly asOf: string },
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.tenant_id', ${args.tenantId}, true)`;
    await tx`SELECT set_config('lotmark.audit_key', ${args.auditKey}, true)`;
    // Rejects a future date, so a caller cannot ask what the records will say.
    await tx`SELECT lotmark.set_as_of(${args.asOf}::date)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
