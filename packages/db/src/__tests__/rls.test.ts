/**
 * Row-Level Security.
 *
 * The property under test is not "the query returns the right rows" — it is
 * "the query CANNOT return the wrong rows even when the code forgets to ask
 * correctly". So these tests deliberately issue unfiltered queries, the kind a
 * developer writes by mistake, and assert the database refuses to leak.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type Sql } from '../client';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

let sql: Sql;
beforeAll(async () => { sql = createClient(); await sql`SELECT 1`; });
afterAll(async () => { await sql.end(); });

/** Set up two tenants, each with one project, then run `fn`. Always rolls back. */
async function twoTenants<R>(fn: (tx: Sql) => Promise<R>): Promise<R> {
  const MARK = Symbol('rollback');
  try {
    return await sql.begin(async (tx) => {
      for (const [id, slug] of [[A, 'alpha'], [B, 'beta']] as const) {
        await tx`SELECT lotmark.provision_tenant(${id}, ${slug}, ${slug}, ${slug}, 'ISO 17034', 'X-{SEQ}', 'local')`;
        await tx`SELECT set_config('lotmark.tenant_id', ${id}, true)`;
        await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                 VALUES (${id}, ${'PRJ-' + slug}, ${'Material ' + slug}, ${'SKU-' + slug})`;
      }
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

describe('tenant isolation', () => {
  it('an UNFILTERED select returns only the acting tenant\'s rows', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${A}, true)`;
      // No WHERE clause at all — the mistake RLS exists to make harmless.
      const rows = await tx`SELECT code FROM lotmark.projects`;
      expect(rows.map((r) => (r as { code: string }).code)).toEqual(['PRJ-alpha']);
    });
  });

  it('switching tenant switches the visible rows', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${B}, true)`;
      const rows = await tx`SELECT code FROM lotmark.projects`;
      expect(rows.map((r) => (r as { code: string }).code)).toEqual(['PRJ-beta']);
    });
  });

  it('an explicit filter for ANOTHER tenant still returns nothing', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${A}, true)`;
      // Even asking for it by name does not help. The policy is not a default.
      const rows = await tx`SELECT code FROM lotmark.projects WHERE tenant_id = ${B}`;
      expect(rows).toHaveLength(0);
    });
  });

  it('FAILS CLOSED when no tenant is set — empty, not everything', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', '', true)`;
      const rows = await tx`SELECT code FROM lotmark.projects`;
      // A forgotten inTenantTransaction shows a developer an empty screen,
      // which surfaces in testing. Failing open would surface as a breach.
      expect(rows).toHaveLength(0);
    });
  });

  it('REFUSES to write a row into another tenant', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${A}, true)`;
      // WITH CHECK is what stops this. A USING-only policy would allow it.
      await expect(tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                      VALUES (${B}, 'PRJ-smuggled', 'X', 'SKU-X')`)
        .rejects.toThrow(/row-level security/i);
    });
  });

  it('REFUSES to move an existing row to another tenant', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${A}, true)`;
      const moved = await tx`UPDATE lotmark.projects SET tenant_id = ${B} WHERE code = 'PRJ-alpha' RETURNING id`
        .catch((e: Error) => e);
      // Either refused outright, or invisible and therefore zero rows — both
      // are correct; silently succeeding would not be.
      if (Array.isArray(moved)) expect(moved).toHaveLength(0);
      else expect(String(moved)).toMatch(/row-level security/i);
    });
  });

  it('hides the tenant record itself from other tenants', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${A}, true)`;
      const rows = await tx`SELECT slug FROM lotmark.tenants`;
      expect(rows.map((r) => (r as { slug: string }).slug)).toEqual(['alpha']);
    });
  });

  it('covers the join tables, which carry no tenant_id of their own', async () => {
    await twoTenants(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${A}, true)`;
      const [p] = await tx`SELECT id FROM lotmark.projects LIMIT 1`;
      const [s] = await tx`INSERT INTO lotmark.studies (tenant_id, code, project_id, study_type)
                           VALUES (${A}, 'ST-A', ${(p as { id: string }).id}, 'homogeneity') RETURNING id`;
      const [e] = await tx`INSERT INTO lotmark.equipment (tenant_id, code, name, equipment_type)
                           VALUES (${A}, 'EQ-A', 'Balance', 'Balance') RETURNING id`;
      await tx`INSERT INTO lotmark.study_equipment (study_id, equipment_id)
               VALUES (${(s as { id: string }).id}, ${(e as { id: string }).id})`;

      expect(await tx`SELECT * FROM lotmark.study_equipment`).toHaveLength(1);
      await tx`SELECT set_config('lotmark.tenant_id', ${B}, true)`;
      // study_equipment has no tenant_id column; its policy reaches through
      // the study. Without that, join tables would be a hole straight through.
      expect(await tx`SELECT * FROM lotmark.study_equipment`).toHaveLength(0);
    });
  });

  it('is enabled AND forced on every table, so the owner cannot bypass it', async () => {
    const rows = await sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'lotmark' AND c.relkind = 'r'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;
    // A new table added without RLS is the failure this catches.
    expect(rows.map((r) => (r as { relname: string }).relname)).toEqual([]);
  });

  it('every table has a policy', async () => {
    const rows = await sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'lotmark' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = 'lotmark' AND p.tablename = c.relname)`;
    expect(rows.map((r) => (r as { relname: string }).relname)).toEqual([]);
  });
});
