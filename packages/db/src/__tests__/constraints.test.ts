/**
 * Integration tests for the constraints in migrations/0001.
 *
 * These run against the real database, because that is the only place they
 * exist. A CHECK constraint that has never been violated in a test is a comment
 * with better syntax highlighting.
 *
 * Every test runs inside a transaction that is rolled back, so the suite is
 * order-independent and leaves nothing behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type Sql } from '../client';

const T = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const U1 = '33333333-3333-3333-3333-333333333333';
const U2 = '44444444-4444-4444-4444-444444444444';

let sql: Sql;

beforeAll(async () => {
  sql = createClient();
  await sql`SELECT 1`; // fail fast with a clear message if the db is not up
});
afterAll(async () => { await sql.end(); });

/** Run `fn` inside a transaction that always rolls back. */
async function inRollback<T2>(fn: (tx: Sql) => Promise<T2>): Promise<T2> {
  const ROLLBACK = Symbol('rollback');
  try {
    return await sql.begin(async (tx) => {
      await tx`INSERT INTO lotmark.tenants (id, slug, name, short_name, conformance_frame, lot_numbering_template, data_residency)
               VALUES (${T}, 't', 'T', 'T', 'ISO 17034', 'X-{SEQ}', 'local')`;
      await tx`INSERT INTO lotmark.organisations (id, tenant_id, code, name, kind)
               VALUES (${ORG}, ${T}, 'O', 'Org', 'producer')`;
      await tx`INSERT INTO lotmark.users (id, tenant_id, organisation_id, code, email, display_name, password_hash, role_id)
               VALUES (${U1}, ${T}, ${ORG}, 'u1', 'a@b.c', 'A', 'x', 'scientist'),
                      (${U2}, ${T}, ${ORG}, 'u2', 'd@e.f', 'B', 'x', 'techmgr')`;
      const out = await fn(tx as unknown as Sql);
      throw Object.assign(new Error('rollback'), { [ROLLBACK]: true, out });
    });
  } catch (e) {
    if (e && typeof e === 'object' && (e as Record<symbol, unknown>)[ROLLBACK]) {
      return (e as unknown as { out: T2 }).out;
    }
    throw e;
  }
}

const violates = (constraint: string) => (e: unknown) =>
  String((e as { message?: string })?.message ?? e).includes(constraint);

describe('competence windows cannot overlap (ISO 17034 6.3)', () => {
  const insert = (tx: Sql, code: string, from: string, to: string) =>
    tx`INSERT INTO lotmark.competence_records (tenant_id, code, user_id, activity, valid_from, valid_to)
       VALUES (${T}, ${code}, ${U1}, 'study:sign', ${from}, ${to})`;

  it('accepts the first window', async () => {
    await inRollback(async (tx) => {
      await expect(insert(tx, 'C1', '2024-01-01', '2026-12-31')).resolves.toBeDefined();
    });
  });

  it('REJECTS a window that overlaps an existing one', async () => {
    await inRollback(async (tx) => {
      await insert(tx, 'C1', '2024-01-01', '2026-12-31');
      await expect(insert(tx, 'C2', '2026-06-01', '2027-12-31'))
        .rejects.toSatisfy(violates('competence_no_overlap'));
    });
  });

  it('REJECTS an overlap of exactly one day — the range is inclusive', async () => {
    await inRollback(async (tx) => {
      await insert(tx, 'C1', '2024-01-01', '2026-12-31');
      await expect(insert(tx, 'C2', '2026-12-31', '2027-06-30'))
        .rejects.toSatisfy(violates('competence_no_overlap'));
    });
  });

  it('accepts an adjacent window starting the next day', async () => {
    await inRollback(async (tx) => {
      await insert(tx, 'C1', '2024-01-01', '2026-12-31');
      await expect(insert(tx, 'C2', '2027-01-01', '2028-12-31')).resolves.toBeDefined();
    });
  });

  it('allows overlap with a SUPERSEDED record, which keeps its historical range', async () => {
    await inRollback(async (tx) => {
      await tx`INSERT INTO lotmark.competence_records (tenant_id, code, user_id, activity, valid_from, valid_to, superseded_at)
               VALUES (${T}, 'C0', ${U1}, 'study:sign', '2024-01-01', '2026-12-31', now())`;
      await expect(insert(tx, 'C1', '2025-01-01', '2027-12-31')).resolves.toBeDefined();
    });
  });

  it('allows the same window for a DIFFERENT activity', async () => {
    await inRollback(async (tx) => {
      await insert(tx, 'C1', '2024-01-01', '2026-12-31');
      await expect(tx`INSERT INTO lotmark.competence_records (tenant_id, code, user_id, activity, valid_from, valid_to)
                      VALUES (${T}, 'C2', ${U1}, 'value:assign', '2024-01-01', '2026-12-31')`)
        .resolves.toBeDefined();
    });
  });

  it('REJECTS a window that ends before it starts', async () => {
    await inRollback(async (tx) => {
      await expect(insert(tx, 'C1', '2026-12-31', '2024-01-01'))
        .rejects.toSatisfy(violates('competence_range_ordered'));
    });
  });
});

describe('calibration intervals cannot overlap', () => {
  const setup = async (tx: Sql) => {
    const [eq] = await tx`INSERT INTO lotmark.equipment (tenant_id, code, name, equipment_type)
                          VALUES (${T}, 'EQ-01', 'Balance', 'Balance') RETURNING id`;
    return (eq as { id: string }).id;
  };
  const cal = (tx: Sql, eqId: string, from: string, to: string) =>
    tx`INSERT INTO lotmark.calibrations (tenant_id, equipment_id, valid_from, valid_to)
       VALUES (${T}, ${eqId}, ${from}, ${to})`;

  it('REJECTS overlapping calibration certificates for one instrument', async () => {
    await inRollback(async (tx) => {
      const eqId = await setup(tx);
      await cal(tx, eqId, '2025-04-01', '2026-03-31');
      await expect(cal(tx, eqId, '2026-01-01', '2027-01-01'))
        .rejects.toSatisfy(violates('calibration_no_overlap'));
    });
  });

  it('accepts consecutive intervals', async () => {
    await inRollback(async (tx) => {
      const eqId = await setup(tx);
      await cal(tx, eqId, '2025-04-01', '2026-03-31');
      await expect(cal(tx, eqId, '2026-04-01', '2027-03-31')).resolves.toBeDefined();
    });
  });
});

describe('property values', () => {
  const project = async (tx: Sql) => {
    const [p] = await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                         VALUES (${T}, 'PRJ-1', 'Paracetamol', 'RM-PARA') RETURNING id`;
    return (p as { id: string }).id;
  };

  it('REJECTS the assigner also being the authoriser (SoD-1, at the database)', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.property_values
          (tenant_id, code, project_id, property_name, unit, assigned_value, state, assigned_by, authorised_by)
          VALUES (${T}, 'PV-1', ${prj}, 'Assay', '% w/w', 99.62, 'authorised', ${U1}, ${U1})`)
        .rejects.toSatisfy(violates('property_value_assigner_is_not_authoriser'));
    });
  });

  it('accepts a value authorised by a different person', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.property_values
          (tenant_id, code, project_id, property_name, unit, assigned_value, state, assigned_by, authorised_by)
          VALUES (${T}, 'PV-1', ${prj}, 'Assay', '% w/w', 99.62, 'authorised', ${U1}, ${U2})`)
        .resolves.toBeDefined();
    });
  });

  it('REJECTS a negative combined uncertainty', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.property_values
          (tenant_id, code, project_id, property_name, unit, combined_uncertainty)
          VALUES (${T}, 'PV-1', ${prj}, 'Assay', '% w/w', -0.1)`)
        .rejects.toSatisfy(violates('property_value_uncertainty_non_negative'));
    });
  });

  it('REJECTS an authorised value with nobody named', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.property_values
          (tenant_id, code, project_id, property_name, unit, state)
          VALUES (${T}, 'PV-1', ${prj}, 'Assay', '% w/w', 'authorised')`)
        .rejects.toSatisfy(violates('property_value_authorised_is_complete'));
    });
  });
});

describe('studies', () => {
  const project = async (tx: Sql) => {
    const [p] = await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                         VALUES (${T}, 'PRJ-1', 'Paracetamol', 'RM-PARA') RETURNING id`;
    return (p as { id: string }).id;
  };

  it('REJECTS a signed study with no signer, date or uncertainty', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.studies (tenant_id, code, project_id, study_type, state)
                      VALUES (${T}, 'ST-1', ${prj}, 'homogeneity', 'signed')`)
        .rejects.toSatisfy(violates('study_signed_is_complete'));
    });
  });

  it('REJECTS a signed stability study with no shelf life', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.studies
          (tenant_id, code, project_id, study_type, state, signed_by_user_id, signed_on, uncertainty)
          VALUES (${T}, 'ST-1', ${prj}, 'stability', 'signed', ${U1}, '2026-01-01', 0.22)`)
        .rejects.toSatisfy(violates('stability_has_shelf_life'));
    });
  });

  it('REJECTS an unknown study type', async () => {
    await inRollback(async (tx) => {
      const prj = await project(tx);
      await expect(tx`INSERT INTO lotmark.studies (tenant_id, code, project_id, study_type)
                      VALUES (${T}, 'ST-1', ${prj}, 'vibes')`)
        .rejects.toSatisfy(violates('study_type_known'));
    });
  });
});

describe("the prototype's vault double-counting defect", () => {
  it('REJECTS a second holding row for the same org, lot and location', async () => {
    await inRollback(async (tx) => {
      const [p] = await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                           VALUES (${T}, 'PRJ-1', 'Paracetamol', 'RM-PARA') RETURNING id`;
      const [l] = await tx`INSERT INTO lotmark.lots (tenant_id, project_id, lot_code, expiry_date, storage_condition)
                           VALUES (${T}, ${(p as { id: string }).id}, 'L-1', '2028-03-31', '2-8') RETURNING id`;
      const lotId = (l as { id: string }).id;
      await tx`INSERT INTO lotmark.vault_holdings (tenant_id, organisation_id, lot_id, storage_location, quantity)
               VALUES (${T}, ${ORG}, ${lotId}, 'Cold room A', 2)`;
      await expect(tx`INSERT INTO lotmark.vault_holdings (tenant_id, organisation_id, lot_id, storage_location, quantity)
                      VALUES (${T}, ${ORG}, ${lotId}, 'Cold room A', 1)`)
        .rejects.toSatisfy(violates('vault_holding_unique_per_location'));
    });
  });
});

describe('certificate issues', () => {
  const setupCert = async (tx: Sql) => {
    const [p] = await tx`INSERT INTO lotmark.projects (tenant_id, code, material_name, sku)
                         VALUES (${T}, 'PRJ-1', 'Paracetamol', 'RM-PARA') RETURNING id`;
    const [l] = await tx`INSERT INTO lotmark.lots (tenant_id, project_id, lot_code, expiry_date, storage_condition)
                         VALUES (${T}, ${(p as { id: string }).id}, 'L-1', '2028-03-31', '2-8') RETURNING id`;
    const [c] = await tx`INSERT INTO lotmark.certificates (tenant_id, code, lot_id)
                         VALUES (${T}, 'CRT-1', ${(l as { id: string }).id}) RETURNING id`;
    return (c as { id: string }).id;
  };

  it('REJECTS a reissue that states no reason', async () => {
    await inRollback(async (tx) => {
      const cert = await setupCert(tx);
      await expect(tx`INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty, property_name, unit, issued_by_user_id, issued_at)
          VALUES (${T}, ${cert}, 2, 99.62, 0.84, 'Assay', '% w/w', ${U2}, now())`)
        .rejects.toSatisfy(violates('certificate_reissue_states_reason'));
    });
  });

  it('REJECTS a negative expanded uncertainty on a certificate', async () => {
    await inRollback(async (tx) => {
      const cert = await setupCert(tx);
      await expect(tx`INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty, property_name, unit, issued_by_user_id, issued_at)
          VALUES (${T}, ${cert}, 1, 99.62, -0.84, 'Assay', '% w/w', ${U2}, now())`)
        .rejects.toSatisfy(violates('certificate_uncertainty_non_negative'));
    });
  });

  it('REJECTS a withdrawal with no reason or person', async () => {
    await inRollback(async (tx) => {
      const cert = await setupCert(tx);
      await expect(tx`INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty, property_name, unit, issued_by_user_id, issued_at, withdrawn)
          VALUES (${T}, ${cert}, 1, 99.62, 0.84, 'Assay', '% w/w', ${U2}, now(), true)`)
        .rejects.toSatisfy(violates('certificate_withdrawal_is_accountable'));
    });
  });

  it('REJECTS two issues with the same number', async () => {
    await inRollback(async (tx) => {
      const cert = await setupCert(tx);
      const ins = (n: number) => tx`INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty, property_name, unit, issued_by_user_id, issued_at, reissue_reason)
          VALUES (${T}, ${cert}, ${n}, 99.62, 0.84, 'Assay', '% w/w', ${U2}, now(), 'r')`;
      await ins(1);
      await expect(ins(1)).rejects.toSatisfy(violates('certificate_issues_cert_number_unique'));
    });
  });
});
