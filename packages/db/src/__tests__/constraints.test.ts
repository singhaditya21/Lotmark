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
      // Tenants are under RLS; provision_tenant is SECURITY DEFINER and is the
      // only way to create one without an existing tenant context.
      await tx`SELECT lotmark.provision_tenant(${T}, 't', 'T', 'T', 'ISO 17034', 'X-{SEQ}', 'local')`;
      await tx`SELECT set_config('lotmark.tenant_id', ${T}, true)`;
      /**
       * These fixtures act on the PRODUCER'S side.
       *
       * Migration 0022 added restrictive organisation policies that fail
       * closed, so an insert into orders or vault_holdings with no
       * organisation context is refused — which is the policy working. Real
       * producer-side code says the same thing; see db.ts.
       */
      await tx`SELECT set_config('lotmark.organisation_kind', 'producer', true)`;
      await tx`INSERT INTO lotmark.organisations (id, tenant_id, code, name, kind)
               VALUES (${ORG}, ${T}, 'O', 'Org', 'producer')`;
      await tx`INSERT INTO lotmark.users (id, tenant_id, organisation_id, code, email, display_name, password_hash)
               VALUES (${U1}, ${T}, ${ORG}, 'u1', 'a@b.c', 'A', 'x'),
                      (${U2}, ${T}, ${ORG}, 'u2', 'd@e.f', 'B', 'x')`;
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
      // acquired_on is NOT NULL since 0020 and has no default, deliberately —
      // so it has to be supplied here for this test to reach the constraint it
      // is actually about.
      await tx`INSERT INTO lotmark.vault_holdings
                 (tenant_id, organisation_id, lot_id, storage_location, quantity, acquired_on)
               VALUES (${T}, ${ORG}, ${lotId}, 'Cold room A', 2, '2026-01-01')`;
      await expect(tx`INSERT INTO lotmark.vault_holdings
                        (tenant_id, organisation_id, lot_id, storage_location, quantity, acquired_on)
                      VALUES (${T}, ${ORG}, ${lotId}, 'Cold room A', 1, '2026-01-01')`)
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

describe('configuration versioning', () => {
  const draft = (tx: Sql, n: number, basedOn: string | null = null, status = 'draft') =>
    tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, status, change_reason, created_by,
                                            published_by, published_at, based_on_version_id)
       VALUES (${T}, ${n}, ${status}, 'initial', ${U1},
               ${status === 'draft' ? null : U2}, ${status === 'draft' ? null : 'now()'},
               ${basedOn})`;

  it('allows exactly one ACTIVE version per tenant', async () => {
    await inRollback(async (tx) => {
      const [first] = await tx`
        INSERT INTO lotmark.config_versions (tenant_id, version_number, status, change_reason, created_by, published_by, published_at)
        VALUES (${T}, 1, 'active', 'initial', ${U1}, ${U2}, now()) RETURNING id`;
      // A second active version would make "which rules apply" ambiguous.
      // `based_on_version_id` is supplied because 0017 requires every version
      // after the first to name its baseline — without it the CHECK fires
      // before the unique index, and this would pass for the wrong reason.
      await expect(tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, status, change_reason, created_by, published_by, published_at, based_on_version_id)
                      VALUES (${T}, 2, 'active', 'second', ${U1}, ${U2}, now(), ${(first as { id: string }).id})`)
        .rejects.toSatisfy(violates('config_versions_one_active_per_tenant'));
    });
  });

  it('allows only ONE draft alongside the active version', async () => {
    /**
     * CHANGED in 0017, deliberately. This previously asserted that many drafts
     * were allowed, which documented the absence of a constraint rather than a
     * decision to permit them.
     *
     * Two open drafts are a fork. Both are based on the version that was active
     * when they were created; whichever publishes second supersedes the first
     * and silently discards its changes, while carrying a `change_summary` that
     * describes a diff against a version no longer active — so the
     * re-validation scope it implies covers the wrong things.
     */
    await inRollback(async (tx) => {
      const [first] = await tx`
        INSERT INTO lotmark.config_versions (tenant_id, version_number, status, change_reason, created_by, published_by, published_at)
        VALUES (${T}, 1, 'active', 'initial', ${U1}, ${U2}, now()) RETURNING id`;
      const base = (first as { id: string }).id;
      await expect(draft(tx, 2, base)).resolves.toBeDefined();
      await expect(draft(tx, 3, base))
        .rejects.toSatisfy(violates('config_versions_one_draft_per_tenant'));
    });
  });

  it('REJECTS a version after the first that names no baseline', async () => {
    // Without a baseline the diff has no defined starting point, and
    // `change_summary` becomes a claim rather than a derivation.
    await inRollback(async (tx) => {
      await tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, status, change_reason, created_by, published_by, published_at)
               VALUES (${T}, 1, 'active', 'initial', ${U1}, ${U2}, now())`;
      await expect(tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, change_reason, created_by)
                      VALUES (${T}, 2, 'no baseline', ${U1})`)
        .rejects.toSatisfy(violates('config_version_after_first_has_a_base'));
    });
  });

  it('REJECTS a published version that names nobody', async () => {
    await inRollback(async (tx) => {
      await expect(tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, status, change_reason, created_by)
                      VALUES (${T}, 1, 'active', 'initial', ${U1})`)
        .rejects.toSatisfy(violates('config_version_publication_is_accountable'));
    });
  });

  it('REJECTS a configuration entry of an unknown kind', async () => {
    await inRollback(async (tx) => {
      const [v] = await tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, change_reason, created_by)
                           VALUES (${T}, 1, 'initial', ${U1}) RETURNING id`;
      await expect(tx`INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
                      VALUES (${T}, ${(v as { id: string }).id}, 'arbitrary_nonsense', 'k', '{}'::jsonb)`)
        .rejects.toSatisfy(violates('config_entry_kind_known'));
    });
  });

  it('REJECTS two entries with the same kind and key in one version', async () => {
    await inRollback(async (tx) => {
      const [v] = await tx`INSERT INTO lotmark.config_versions (tenant_id, version_number, change_reason, created_by)
                           VALUES (${T}, 1, 'initial', ${U1}) RETURNING id`;
      const vid = (v as { id: string }).id;
      const ins = () => tx`INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
                           VALUES (${T}, ${vid}, 'role', 'scientist', '{}'::jsonb)`;
      await ins();
      await expect(ins()).rejects.toSatisfy(violates('config_entries_version_kind_key_unique'));
    });
  });
});

describe('teams and role assignments', () => {
  const team = async (tx: Sql, key: string) => {
    const [t] = await tx`INSERT INTO lotmark.teams (tenant_id, key, name)
                         VALUES (${T}, ${key}, ${key}) RETURNING id`;
    return (t as { id: string }).id;
  };

  it('REJECTS joining the same team twice while still a member', async () => {
    await inRollback(async (tx) => {
      const teamId = await team(tx, 'organics');
      const join = () => tx`INSERT INTO lotmark.team_memberships (tenant_id, team_id, user_id, joined_on)
                            VALUES (${T}, ${teamId}, ${U1}, '2026-01-01')`;
      await join();
      await expect(join()).rejects.toSatisfy(violates('team_memberships_one_live'));
    });
  });

  it('allows re-joining after leaving', async () => {
    await inRollback(async (tx) => {
      const teamId = await team(tx, 'organics');
      await tx`INSERT INTO lotmark.team_memberships (tenant_id, team_id, user_id, joined_on, left_on)
               VALUES (${T}, ${teamId}, ${U1}, '2024-01-01', '2025-06-30')`;
      await expect(tx`INSERT INTO lotmark.team_memberships (tenant_id, team_id, user_id, joined_on)
                      VALUES (${T}, ${teamId}, ${U1}, '2026-01-01')`).resolves.toBeDefined();
    });
  });

  it('REJECTS leaving before joining', async () => {
    await inRollback(async (tx) => {
      const teamId = await team(tx, 'organics');
      await expect(tx`INSERT INTO lotmark.team_memberships (tenant_id, team_id, user_id, joined_on, left_on)
                      VALUES (${T}, ${teamId}, ${U1}, '2026-01-01', '2024-01-01')`)
        .rejects.toSatisfy(violates('membership_range_ordered'));
    });
  });

  it('allows the same person different roles on different teams', async () => {
    await inRollback(async (tx) => {
      const organics = await team(tx, 'organics');
      const inorganics = await team(tx, 'inorganics');
      await tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, team_id)
               VALUES (${T}, ${U1}, 'scientist', ${organics})`;
      await expect(tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, team_id)
                      VALUES (${T}, ${U1}, 'techmgr', ${inorganics})`).resolves.toBeDefined();
    });
  });

  it('REJECTS granting the same role twice at the same scope', async () => {
    await inRollback(async (tx) => {
      const organics = await team(tx, 'organics');
      const grant = () => tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, team_id)
                             VALUES (${T}, ${U1}, 'scientist', ${organics})`;
      await grant();
      // Revoking one would leave the other silently in force.
      await expect(grant()).rejects.toSatisfy(violates('role_assignments_no_duplicate_live'));
    });
  });

  it('REJECTS a duplicate TENANT-WIDE grant, where team_id is null', async () => {
    await inRollback(async (tx) => {
      const grant = () => tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, team_id)
                             VALUES (${T}, ${U1}, 'quality', NULL)`;
      await grant();
      // The COALESCE in the index is what makes NULL scopes comparable at all;
      // without it Postgres would treat every tenant-wide grant as distinct.
      await expect(grant()).rejects.toSatisfy(violates('role_assignments_no_duplicate_live'));
    });
  });

  it('allows re-granting a role that was revoked', async () => {
    await inRollback(async (tx) => {
      await tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, team_id, revoked_at, revoked_by)
               VALUES (${T}, ${U1}, 'quality', NULL, now(), ${U2})`;
      await expect(tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, team_id)
                      VALUES (${T}, ${U1}, 'quality', NULL)`).resolves.toBeDefined();
    });
  });

  it('REJECTS a revocation that names nobody', async () => {
    await inRollback(async (tx) => {
      await expect(tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, revoked_at)
                      VALUES (${T}, ${U1}, 'quality', now())`)
        .rejects.toSatisfy(violates('role_assignment_revocation_is_accountable'));
    });
  });

  it('REJECTS an assignment whose validity ends before it starts', async () => {
    await inRollback(async (tx) => {
      await expect(tx`INSERT INTO lotmark.role_assignments (tenant_id, user_id, role_key, valid_from, valid_to)
                      VALUES (${T}, ${U1}, 'quality', '2026-12-31', '2026-01-01')`)
        .rejects.toSatisfy(violates('role_assignment_range_ordered'));
    });
  });
});

describe('signature integrity constraints (migration 0003)', () => {
  const sig = (tx: Sql, over: Record<string, unknown> = {}) => {
    const base = {
      meaning: 'approval', subject_kind: 'study',
      signature_value: 'ZmFrZS1zaWduYXR1cmU',
      competence_record_id: null, competence_activity: null,
      competence_valid_from: null, competence_valid_to: null, competence_checked_on: null,
      ...over,
    };
    return tx`INSERT INTO lotmark.signatures
        (tenant_id, subject_kind, subject_id, signer_user_id, meaning, time_source, region,
         binding_hash, signature_value, competence_record_id, competence_activity,
         competence_valid_from, competence_valid_to, competence_checked_on)
      VALUES (${T}, ${base.subject_kind as string}, ${U1}, ${U1}, ${base.meaning as string},
              'ntp', 'local', ${'a'.repeat(64)}, ${base.signature_value as string | null},
              ${base.competence_record_id as string | null}, ${base.competence_activity as string | null},
              ${base.competence_valid_from as string | null}, ${base.competence_valid_to as string | null},
              ${base.competence_checked_on as string | null})`;
  };

  it('accepts a well-formed signature', async () => {
    await inRollback(async (tx) => { await expect(sig(tx)).resolves.toBeDefined(); });
  });

  it('REJECTS a signature carrying no cryptographic value', async () => {
    await inRollback(async (tx) => {
      await expect(sig(tx, { signature_value: null }))
        .rejects.toSatisfy(violates('signature_has_a_value'));
    });
  });

  it('REJECTS an unrecognised meaning — §11.50(a)(3)', async () => {
    await inRollback(async (tx) => {
      await expect(sig(tx, { meaning: 'because I said so' }))
        .rejects.toSatisfy(violates('signature_meaning_known'));
    });
  });

  it('REJECTS a half-copied competence basis', async () => {
    await inRollback(async (tx) => {
      // A partial basis cannot answer "was this person authorised on the day",
      // which is the only question it exists to answer.
      await expect(sig(tx, {
        competence_record_id: U1, competence_activity: 'study:sign',
        competence_valid_from: '2024-01-01', competence_valid_to: null,
        competence_checked_on: '2026-08-21',
      })).rejects.toSatisfy(violates('signature_competence_basis_is_whole'));
    });
  });

  it('REJECTS a frozen basis that does not cover the day it was checked against', async () => {
    await inRollback(async (tx) => {
      await expect(sig(tx, {
        competence_record_id: U1, competence_activity: 'study:sign',
        competence_valid_from: '2024-01-01', competence_valid_to: '2026-06-30',
        competence_checked_on: '2026-08-21',
      })).rejects.toSatisfy(violates('signature_competence_basis_covers_the_day'));
    });
  });

  it('accepts a whole basis that does cover the day', async () => {
    await inRollback(async (tx) => {
      await expect(sig(tx, {
        competence_record_id: U1, competence_activity: 'study:sign',
        competence_valid_from: '2024-01-01', competence_valid_to: '2027-12-31',
        competence_checked_on: '2026-08-21',
      })).resolves.toBeDefined();
    });
  });

  it('REJECTS signing the same record twice with the same meaning', async () => {
    await inRollback(async (tx) => {
      await sig(tx);
      // A double submit, not a second act of judgement.
      await expect(sig(tx)).rejects.toSatisfy(violates('signatures_one_per_subject_signer_meaning'));
    });
  });

  it('allows the same signer to add a DIFFERENT meaning', async () => {
    await inRollback(async (tx) => {
      await sig(tx, { meaning: 'authorship' });
      await expect(sig(tx, { meaning: 'approval' })).resolves.toBeDefined();
    });
  });
});

describe('signing keys (migration 0003)', () => {
  const key = (tx: Sql, version: string, retired = false, purpose = 'record') =>
    tx`INSERT INTO lotmark.signing_keys
         (tenant_id, key_version, public_key_pem, fingerprint, purpose,
          activated_at, retired_at, retired_reason)
       VALUES (${T}, ${version}, 'PEM', ${'f' + version}, ${purpose}, now(),
               ${retired ? tx`now()` : null}, ${retired ? 'rotation' : null})`;

  it('allows exactly one active key per tenant PER PURPOSE', async () => {
    await inRollback(async (tx) => {
      await key(tx, 'rec-v1');
      // Two current record keys would make "which key signs this" ambiguous,
      // and a verifier could not tell a rotation from a compromise.
      await expect(key(tx, 'rec-v2'))
        .rejects.toSatisfy(violates('signing_keys_one_active_per_purpose'));
    });
  });

  it('allows a record key and an anchor key to be active at once', async () => {
    await inRollback(async (tx) => {
      await key(tx, 'rec-v1', false, 'record');
      // They are different keys for different jobs. The API holds the record
      // key; the signer holds the anchor key and the API must never see it.
      await expect(key(tx, 'anc-v1', false, 'anchor')).resolves.toBeDefined();
    });
  });

  it('REJECTS an unrecognised key purpose', async () => {
    await inRollback(async (tx) => {
      await expect(key(tx, 'x-v1', false, 'whatever'))
        .rejects.toSatisfy(violates('signing_key_purpose_known'));
    });
  });

  it('allows a new key once the previous one is retired', async () => {
    await inRollback(async (tx) => {
      await key(tx, 'v1', true);
      await expect(key(tx, 'v2')).resolves.toBeDefined();
    });
  });

  it('REJECTS retiring a key without stating why', async () => {
    await inRollback(async (tx) => {
      await expect(tx`INSERT INTO lotmark.signing_keys
             (tenant_id, key_version, public_key_pem, fingerprint, activated_at, retired_at)
           VALUES (${T}, 'v1', 'PEM', 'fp', now(), now())`)
        .rejects.toSatisfy(violates('signing_key_retirement_states_reason'));
    });
  });
});
