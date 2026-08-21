/**
 * Who holds which issue of a certificate.
 *
 * This decides who receives a withdrawal notice, which is the product's central
 * safety obligation. It is computed by `lotmark.certificate_holders`, and the
 * answer depends entirely on `vault_holdings.acquired_on` — a column that was
 * nullable until 0020 and that the seed never set, so it had never decided
 * anything.
 *
 * Every test rolls back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type Sql } from '../client';

const T = '11111111-1111-1111-1111-111111111111';
const PRODUCER = '22222222-2222-2222-2222-222222222222';
const EARLY = '55555555-5555-5555-5555-555555555555';
const LATE = '66666666-6666-6666-6666-666666666666';
const U1 = '33333333-3333-3333-3333-333333333333';
const PRJ = '77777777-7777-7777-7777-777777777777';
const LOT = '88888888-8888-8888-8888-888888888888';
const CERT = '99999999-9999-9999-9999-999999999999';

let sql: Sql;
beforeAll(async () => { sql = createClient(); await sql`SELECT 1`; });
afterAll(async () => { await sql.end(); });

/**
 * A lot with two certificate issues, six months apart.
 *
 * Issue 1 covers 2026-01-01 until issue 2 supersedes it on 2026-07-01. Issue 2
 * is current from then on.
 */
async function inRollback<R>(fn: (tx: Sql) => Promise<R>): Promise<R> {
  const ROLLBACK = Symbol('rollback');
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.audit_key', 'k-for-tests-not-a-secret', true)`;
      await tx`SELECT lotmark.provision_tenant(${T}, 't', 'T', 'T', 'ISO 17034', 'X-{SEQ}', 'local')`;
      await tx`SELECT set_config('lotmark.tenant_id', ${T}, true)`;
      await tx`INSERT INTO lotmark.organisations (id, tenant_id, code, name, kind) VALUES
        (${PRODUCER}, ${T}, 'P', 'Producer', 'producer'),
        (${EARLY}, ${T}, 'E', 'Early Laboratory', 'customer'),
        (${LATE}, ${T}, 'L', 'Late Laboratory', 'customer')`;
      await tx`INSERT INTO lotmark.users (id, tenant_id, organisation_id, code, email, display_name, password_hash)
               VALUES (${U1}, ${T}, ${PRODUCER}, 'u1', 'a@b.c', 'A', 'x')`;
      await tx`INSERT INTO lotmark.projects (id, tenant_id, code, material_name, sku, stage)
               VALUES (${PRJ}, ${T}, 'PRJ-1', 'Paracetamol', 'RM-P', 'released')`;
      await tx`INSERT INTO lotmark.lots
          (id, tenant_id, project_id, lot_code, expiry_date, state, stock_units,
           storage_condition, cold_chain, unit_price_minor, created_by, released_by, released_at)
        VALUES (${LOT}, ${T}, ${PRJ}, 'LOT-1', '2028-01-01', 'released', 100,
                '2-8', true, 5000, ${U1}, ${U1}, '2025-12-01')`;
      await tx`INSERT INTO lotmark.certificates (id, tenant_id, code, lot_id)
               VALUES (${CERT}, ${T}, 'CRT-1', ${LOT})`;
      await tx`INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty,
           coverage_factor, property_name, unit, issued_by_user_id, issued_at, reissue_reason)
        VALUES (${T}, ${CERT}, 1, 99.6, 0.5, 2, 'Assay', '%', ${U1}, '2026-01-01', NULL),
               -- A reissue must state why; the CHECK enforces it.
               (${T}, ${CERT}, 2, 99.7, 0.5, 2, 'Assay', '%', ${U1}, '2026-07-01',
                'Characterisation re-run')`;
      const out = await fn(tx as unknown as Sql);
      throw Object.assign(new Error('rollback'), { [ROLLBACK]: true, out });
    });
  } catch (e) {
    if (e && typeof e === 'object' && (e as Record<symbol, unknown>)[ROLLBACK]) {
      return (e as unknown as { out: R }).out;
    }
    throw e;
  }
}

const holdersOf = async (tx: Sql, issue: number): Promise<string[]> => {
  const rows = await tx`SELECT organisation_name FROM lotmark.certificate_holders(${CERT}, ${issue})`;
  return rows.map((r) => (r as { organisation_name: string }).organisation_name).sort();
};

const vault = (tx: Sql, org: string, on: string, basis = 'recorded') =>
  tx`INSERT INTO lotmark.vault_holdings
       (tenant_id, organisation_id, lot_id, quantity, acquired_on, acquired_on_basis)
     VALUES (${T}, ${org}, ${LOT}, 5, ${on}, ${basis})`;

describe('acquired_on is required, and never invented', () => {
  it('REFUSES a holding with no acquisition date', async () => {
    await inRollback(async (tx) => {
      await expect(tx`
        INSERT INTO lotmark.vault_holdings (tenant_id, organisation_id, lot_id, quantity)
        VALUES (${T}, ${EARLY}, ${LOT}, 5)`)
        .rejects.toThrow(/acquired_on/);
    });
  });

  it('has NO default, so a caller cannot omit it by accident', async () => {
    /**
     * `DEFAULT CURRENT_DATE` would be the convenient choice and would stamp
     * today onto every historical row an import or a seed inserted — a date
     * nobody stated, indistinguishable afterwards from one somebody did.
     */
    await inRollback(async (tx) => {
      const [col] = await tx`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'lotmark' AND table_name = 'vault_holdings'
          AND column_name = 'acquired_on'`;
      expect((col as { column_default: string | null }).column_default).toBeNull();
    });
  });

  it('derives from the supplying order, and says so', async () => {
    await inRollback(async (tx) => {
      await tx`INSERT INTO lotmark.orders (id, tenant_id, code, organisation_id, placed_by_user_id, state, placed_on)
               VALUES (gen_random_uuid(), ${T}, 'ORD-1', ${EARLY}, ${U1}, 'delivered', '2026-02-15')`;
      await tx`INSERT INTO lotmark.order_lines (tenant_id, order_id, lot_id, quantity, unit_price_minor)
               SELECT ${T}, id, ${LOT}, 5, 5000 FROM lotmark.orders WHERE code = 'ORD-1'`;

      const [d] = await tx`SELECT * FROM lotmark.vault_acquisition_for(${EARLY}, ${LOT})`;
      const derived = d as { acquired_on: string; basis: string };
      expect(derived.acquired_on).toBe('2026-02-15');
      expect(derived.basis).toBe('derived_from_order');
    });
  });

  it('falls back to the earliest the holding could have existed', async () => {
    // The lot's release. A LOWER BOUND, flagged as such, rather than a claim
    // about a date nobody recorded.
    await inRollback(async (tx) => {
      const [d] = await tx`SELECT * FROM lotmark.vault_acquisition_for(${LATE}, ${LOT})`;
      const derived = d as { acquired_on: string; basis: string };
      expect(derived.acquired_on).toBe('2025-12-01');
      expect(derived.basis).toBe('earliest_possible');
    });
  });
});

describe('a holding belongs to the issue current when it was acquired', () => {
  it('does not put a late holder on an early issue’s notice list', async () => {
    /**
     * The asymmetry 0020 fixes. The vault half of the holder query had only an
     * upper bound, so a holding acquired in 2026-08 matched issue 1 as well as
     * issue 2 — and withdrawing issue 1 notified a laboratory that had been
     * holding issue 2 for a month, about a document it never had.
     */
    await inRollback(async (tx) => {
      await vault(tx, LATE, '2026-08-01');
      expect(await holdersOf(tx, 1), 'issue 1 predates this holding').toEqual([]);
      expect(await holdersOf(tx, 2)).toEqual(['Late Laboratory']);
    });
  });

  it('puts a holder acquired within the window on that issue', async () => {
    await inRollback(async (tx) => {
      await vault(tx, EARLY, '2026-03-01');
      expect(await holdersOf(tx, 1)).toEqual(['Early Laboratory']);
      expect(await holdersOf(tx, 2), 'and not on the later one').toEqual([]);
    });
  });

  it('counts material held BEFORE the first issue against the first issue', async () => {
    /**
     * Deliberately open at the bottom for issue 1 only. Material distributed as
     * a sample before the certificate existed belongs to the first issue —
     * counting it against nothing would drop a real holder off every notice
     * list there is, which is the one direction that must never happen.
     */
    await inRollback(async (tx) => {
      await vault(tx, EARLY, '2025-12-15');
      expect(await holdersOf(tx, 1)).toEqual(['Early Laboratory']);
    });
  });

  it('separates two laboratories that acquired in different windows', async () => {
    await inRollback(async (tx) => {
      await vault(tx, EARLY, '2026-02-01');
      await vault(tx, LATE, '2026-09-01');
      expect(await holdersOf(tx, 1)).toEqual(['Early Laboratory']);
      expect(await holdersOf(tx, 2)).toEqual(['Late Laboratory']);
    });
  });
});
