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

  /**
   * WHO is acting, for organisation isolation — migration 0022.
   *
   * The producer and its customers share a tenant, so tenant isolation alone
   * put every customer's orders in front of every other customer. The
   * restrictive policies added in 0022 fail CLOSED: with no organisation
   * context, `orders`, `order_lines`, `entitlements`, `shipments`,
   * `logger_readings`, `vault_holdings` and `notifications` return NOTHING.
   *
   * So any transaction that touches those tables must say who it is acting as:
   *
   *   'producer' — a producer-side session or a scheduled job. Sees the whole
   *                tenant's commercial data, which is the job.
   *   'customer' — a laboratory's session. Must also set organisationId.
   *
   * Omitting this is not a security risk — it is a correctness one, and it
   * shows up as an empty list rather than an error.
   */
  readonly organisationKind?: 'producer' | 'customer' | undefined;
  readonly organisationId?: string | undefined;

  /**
   * Read every statement from ONE snapshot.
   *
   * PostgreSQL's default is READ COMMITTED, where each STATEMENT takes a fresh
   * snapshot. Being inside a transaction is therefore not enough to see a
   * consistent picture: two queries a millisecond apart can disagree, and a
   * report assembled from a dozen of them can contradict itself — a
   * certificates section counted before a record landed, an audit chain counted
   * after it.
   *
   * Found by the assessment pack's own reproducibility test, which builds two
   * packs inside one transaction and requires identical digests. It failed as
   * soon as a concurrent test created a user, and it was right to: the claim
   * being made is about the records, so the records have to hold still.
   *
   * Use for multi-query READS that must agree with each other. NOT for ordinary
   * write paths — under REPEATABLE READ a write that collides with a concurrent
   * one raises a serialization failure instead of waiting, and the audit chain's
   * head row is exactly the kind of row every writer touches.
   */
  readonly isolation?: 'repeatable read' | undefined;
}

export async function inTenantTransaction<T>(
  sql: Sql,
  args: TenantTransactionArgs,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  /**
   * The level goes on BEGIN, not in a SET afterwards. `SET TRANSACTION` has to
   * precede every query in the transaction, and the `set_config` calls below
   * are queries — so a SET would arrive too late and be rejected.
   */
  const body = async (tx: Sql): Promise<T> => {
    await tx`SELECT set_config('lotmark.tenant_id', ${args.tenantId}, true)`;
    await tx`SELECT set_config('lotmark.audit_key', ${args.auditKey}, true)`;
    if (args.auditKeyGeneration) {
      await tx`SELECT set_config('lotmark.audit_key_generation', ${args.auditKeyGeneration}, true)`;
    }
    if (args.auditKeys) {
      await tx`SELECT set_config('lotmark.audit_keys', ${args.auditKeys}, true)`;
    }
    if (args.organisationKind) {
      await tx`SELECT set_config('lotmark.organisation_kind', ${args.organisationKind}, true)`;
    }
    if (args.organisationId) {
      await tx`SELECT set_config('lotmark.organisation_id', ${args.organisationId}, true)`;
    }
    return fn(tx as unknown as Sql);
  };

  return (args.isolation
    ? sql.begin(`isolation level ${args.isolation}`, body as never)
    : sql.begin(body as never)) as Promise<T>;
}

/**
 * Run `fn` inside a SAVEPOINT, so an expected constraint violation can be
 * caught without poisoning the transaction around it.
 *
 * PostgreSQL aborts the WHOLE transaction on any statement error. Catching a
 * unique violation and carrying on therefore does not work: every later
 * statement returns "current transaction is aborted", and the COMMIT re-raises
 * the original error — so an expected conflict arrives at the client as a 500,
 * and anything the handler meant to write afterwards is lost with it. Measured,
 * not assumed.
 *
 * The cast is here rather than at the call sites. `Sql` is the top-level
 * connection type and has no `savepoint`; the object a transaction callback
 * actually receives is postgres.js's `TransactionSql`, which does, and
 * `inTenantTransaction` widens it back to `Sql` so that every service takes one
 * type. One cast in one place, with the reason attached, beats the same cast
 * scattered wherever a savepoint is needed.
 */
export async function inSavepoint(tx: Sql, fn: (sp: Sql) => Promise<void>): Promise<void> {
  const t = tx as unknown as { savepoint?: (f: (sp: Sql) => Promise<void>) => Promise<void> };
  if (typeof t.savepoint !== 'function') {
    // Not inside a transaction. Failing loudly beats running the body without
    // the protection its caller is relying on.
    throw new Error('inSavepoint was called outside a transaction.');
  }
  await t.savepoint(fn);
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
