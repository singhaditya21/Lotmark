/**
 * Point-in-time querying.
 *
 * The property under test is not "reads return historical answers" — it is
 * "NOTHING can be written while the session believes it is in the past". A
 * write under as_of is a backdated record: a signature, a value or a lot that
 * appears to have existed at a time it did not, and no downstream check can
 * undo one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, ADMIN_URL, type Sql } from '../client';

const T = 'cccccccc-0000-4000-8000-000000000003';

let sql: Sql;
let admin: Sql;
beforeAll(async () => {
  sql = createClient();
  admin = createClient(ADMIN_URL);
  await sql`SELECT 1`;
});
afterAll(async () => { await sql.end(); await admin.end(); });

async function inTenant<R>(fn: (tx: Sql) => Promise<R>): Promise<R> {
  const MARK = Symbol('rollback');
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.audit_key', 'k', true)`;
      await tx`SELECT lotmark.provision_tenant(${T}, 'asof', 'AsOf', 'AsOf', 'ISO 17034', 'X-{SEQ}', 'local')`;
      await tx`SELECT set_config('lotmark.tenant_id', ${T}, true)`;
      const out = await fn(tx as unknown as Sql);
      throw Object.assign(new Error('rollback'), { [MARK]: true, out });
    });
  } catch (e) {
    if (e && typeof e === 'object' && (e as Record<symbol, unknown>)[MARK]) {
      return (e as unknown as { out: R }).out;
    }
    throw e;
  }
}

describe('as-of refuses every write', () => {
  it('refuses an INSERT', async () => {
    await inTenant(async (tx) => {
      await tx`SELECT lotmark.set_as_of(current_date - 30)`;
      await expect(tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                      VALUES (${T}, 'PRJ-X', 'Backdated', 'RM-X')`)
        .rejects.toThrow(/reading as at/);
    });
  });

  it('refuses an UPDATE', async () => {
    await inTenant(async (tx) => {
      await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
               VALUES (${T}, 'PRJ-Y', 'Present', 'RM-Y')`;
      await tx`SELECT lotmark.set_as_of(current_date - 30)`;
      await expect(tx`UPDATE lotmark.projects SET material_name = 'Rewritten' WHERE tenant_id = ${T}`)
        .rejects.toThrow(/reading as at/);
    });
  });

  it('refuses a DELETE', async () => {
    await inTenant(async (tx) => {
      await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
               VALUES (${T}, 'PRJ-Z', 'Present', 'RM-Z')`;
      await tx`SELECT lotmark.set_as_of(current_date - 30)`;
      await expect(tx`DELETE FROM lotmark.projects WHERE tenant_id = ${T}`)
        .rejects.toThrow(/reading as at/);
    });
  });

  it('refuses a write to the LEDGER, which is the one that would matter most', async () => {
    await inTenant(async (tx) => {
      await tx`SELECT lotmark.set_as_of(current_date - 30)`;
      // A ledger entry written under as_of would be an act recorded as having
      // happened at a time it did not — the worst possible backdating.
      await expect(tx`INSERT INTO lotmark.audit_ledger
                        (tenant_id, actor_label, actor_role_id, kind, action, time_source, region)
                      VALUES (${T}, 'x', 'x', 'SYSTEM', 'backdated', 'ntp', 'local')`)
        .rejects.toThrow(/reading as at/);
    });
  });

  it('allows writes again once as_of is cleared', async () => {
    await inTenant(async (tx) => {
      await tx`SELECT lotmark.set_as_of(current_date - 30)`;
      await tx`SELECT lotmark.set_as_of(NULL)`;
      await expect(tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                      VALUES (${T}, 'PRJ-OK', 'Present', 'RM-OK')`).resolves.toBeDefined();
    });
  });

  it('covers every table in the schema', async () => {
    const missing = await admin`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'lotmark' AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = c.oid AND tg.tgname = 'as_of_read_only')`;
    // A table added without the trigger is a hole straight through the rule.
    expect(missing.map((r) => (r as { relname: string }).relname)).toEqual([]);
  });
});

describe('as-of cannot be set into the future', () => {
  it('refuses tomorrow', async () => {
    await inTenant(async (tx) => {
      // There is no legitimate question a future as-of answers, and combined
      // with any path that escaped the read-only trigger it would permit a
      // record dated after now.
      await expect(tx`SELECT lotmark.set_as_of(current_date + 1)`)
        .rejects.toThrow(/in the future/);
    });
  });

  it('allows today', async () => {
    await inTenant(async (tx) => {
      await expect(tx`SELECT lotmark.set_as_of(current_date)`).resolves.toBeDefined();
    });
  });

  it('refuses a malformed setting rather than silently meaning "now"', async () => {
    await inTenant(async (tx) => {
      await tx`SELECT set_config('lotmark.as_of', 'not-a-date', true)`;
      // Falling back to today would answer a different question than the one
      // asked, and the caller would have no way to notice.
      await expect(tx`SELECT lotmark.effective_date()`).rejects.toThrow(/not a date/);
    });
  });
});

describe('temporal answers change with the date', () => {
  it('reports competence as it stood, not as it stands', async () => {
    await inTenant(async (tx) => {
      const [org] = await tx`INSERT INTO lotmark.organisations (tenant_id, code, name, kind)
                             VALUES (${T}, 'O', 'Org', 'producer') RETURNING id`;
      const [user] = await tx`INSERT INTO lotmark.users
          (tenant_id, organisation_id, code, email, display_name, password_hash)
        VALUES (${T}, ${(org as { id: string }).id}, 'u', 'a@b.c', 'A', 'x') RETURNING id`;
      const uid = (user as { id: string }).id;

      // Authorised for a window that ENDED a fortnight ago.
      await tx`INSERT INTO lotmark.competence_records
                 (tenant_id, code, user_id, activity, valid_from, valid_to)
               VALUES (${T}, 'C1', ${uid}, 'study:sign',
                       (current_date - 400)::date, (current_date - 14)::date)`;

      const today = await tx`SELECT * FROM lotmark.competence_as_of(${uid}, 'study:sign')`;
      expect(today, 'lapsed as at today').toHaveLength(0);

      await tx`SELECT lotmark.set_as_of(current_date - 30)`;
      const then = await tx`SELECT * FROM lotmark.competence_as_of(${uid}, 'study:sign')`;
      // The whole point: "was this person authorised ON THE DAY they signed"
      // is a different question from "are they authorised now".
      expect(then, 'authorised as at 30 days ago').toHaveLength(1);
    });
  });
});
