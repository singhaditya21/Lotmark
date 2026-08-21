/**
 * Seeds a working demonstration tenant.
 *
 * The dataset is EXTRACTED from docs/artefacts/lotmark-app.html rather than
 * retyped (see extract-prototype.mjs), so the demo data provably matches the
 * prototype that packages/stats is golden-tested against. A certificate shown
 * in this application therefore carries the same assigned value the prototype
 * showed for the same lot.
 *
 * Run: pnpm --filter @lotmark/db seed
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashPassword, enrolmentUri } from '@lotmark/security';
import {
  defaultRoles, defaultWorkflows, defaultSodConfig, defaultNumbering, defaultFlags,
} from '@lotmark/domain';
import { createClient, ADMIN_URL, type Sql } from '../client';
import { uuidFor } from './ids';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'prototype-data.json'), 'utf8')) as Fixture;

interface Fixture {
  DB: Record<string, any>;
  USERS: Array<{ id: string; n: string; e: string; pw: string; role: string; org: string; col: string; mfa: boolean }>;
  ORGS: Array<{ id: string; n: string; kind: string; accred?: string; scope?: string; type?: string; ph?: string; tier?: string }>;
}

/**
 * The demo authenticator secret, shared by every seeded account.
 *
 * Valid base32. One entry in an authenticator app then works for all nine demo
 * users, which is what makes the demonstration usable. Real enrolment mints a
 * random secret per user and displays it exactly once.
 */
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** The demo HMAC key. Production supplies this from outside the database. */
const AUDIT_KEY = process.env.LOTMARK_AUDIT_KEY ?? 'dev-audit-key-change-me';
const TENANT = uuidFor('tenant:ipc');

/** Teams do not exist in the prototype; they are the new organisational axis. */
const TEAMS = [
  { key: 'organics', name: 'Organics Section', projects: ['PRJ-0412', 'PRJ-0414'] },
  { key: 'inorganics', name: 'Inorganics Section', projects: ['PRJ-0413', 'PRJ-0415'] },
] as const;

const teamOfProject = (prj: string) =>
  uuidFor(`team:${TEAMS.find((t) => (t.projects as readonly string[]).includes(prj))?.key ?? 'organics'}`);

async function main() {
  // The seed TRUNCATEs, which the application role must never be able to do.
  const sql = createClient(process.env.DATABASE_URL ?? ADMIN_URL);
  console.log('seeding into', process.env.DATABASE_URL ?? 'postgres://localhost:5432/lotmark_dev');

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.audit_key', ${AUDIT_KEY}, true)`;
    await reset(tx as unknown as Sql);
    // Every table is under RLS with FORCE, so even the seed must declare which
    // tenant it is acting for. Without this the policies match nothing and the
    // inserts silently affect zero rows.
    await tx`SELECT set_config('lotmark.tenant_id', ${TENANT}, true)`;
    // Order matters: config_versions.created_by references a user, and
    // role_assignments reference the tenant — so tenant, then people, then config.
    await seedTenantAndOrgs(tx as unknown as Sql);
    await seedPeople(tx as unknown as Sql);
    const configVersionId = await seedConfig(tx as unknown as Sql);
    await seedProduction(tx as unknown as Sql, configVersionId);
    await seedDistribution(tx as unknown as Sql);
    await seedCompliance(tx as unknown as Sql);
    await recordSeedInLedger(tx as unknown as Sql);
  });

  // The key is transaction-local (set_config(..., true)), so the verifying
  // connection must set it too. Verifying without it reports "not verifiable",
  // which is correct but would read as a broken chain.
  const [v] = await sql.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.audit_key', ${AUDIT_KEY}, true)`;
    return tx`SELECT * FROM lotmark.verify_audit_chain(${TENANT})`;
  }) as unknown as Array<{ ok: boolean; entries: string; broken_at: string | null; reason: string | null }>;

  console.log(
    v!.ok
      ? `audit chain: verifies across ${v!.entries} entries`
      : `audit chain: BROKEN at ${v!.broken_at} — ${v!.reason}`,
  );

  await sql.end();

  console.log('\n--- demonstration credentials ---');
  console.log('password (all accounts): demo-password-1234');
  console.log('authenticator secret   :', DEMO_TOTP_SECRET);
  console.log('enrolment URI          :',
    enrolmentUri({ secret: DEMO_TOTP_SECRET, accountEmail: 'ravi@producer.example', issuer: 'Lotmark' }));
  console.log('\naccounts:');
  for (const u of fixture.USERS) console.log(`  ${u.e.padEnd(28)} ${u.role}`);
  console.log('\ndone');
}

/**
 * TRUNCATE, not DELETE.
 *
 * audit_ledger refuses DELETE by trigger — correctly, because a delete path is
 * exactly what an append-only ledger must not have. TRUNCATE is a DDL operation
 * and bypasses row triggers, which is what makes it usable here and unusable as
 * an application code path: no service ever holds the privilege to run it.
 */
async function reset(sql: Sql) {
  await sql`
    TRUNCATE TABLE
      lotmark.audit_ledger, lotmark.audit_head, lotmark.audit_checkpoints, lotmark.signatures,
      lotmark.config_entries, lotmark.config_versions,
      lotmark.role_assignments, lotmark.team_memberships, lotmark.teams,
      lotmark.competence_records, lotmark.sessions, lotmark.users,
      lotmark.custom_field_values,
      lotmark.study_results, lotmark.study_equipment, lotmark.studies,
      lotmark.property_values, lotmark.process_steps, lotmark.calibrations, lotmark.equipment,
      lotmark.certificate_issues, lotmark.certificates, lotmark.lots, lotmark.projects,
      lotmark.logger_readings, lotmark.shipments, lotmark.order_lines, lotmark.orders,
      lotmark.entitlements, lotmark.vault_holdings, lotmark.notifications,
      lotmark.monitoring_points, lotmark.facility_excursions, lotmark.facility_lots,
      lotmark.facilities, lotmark.subcontractors, lotmark.capa, lotmark.legal_holds,
      lotmark.job_runs, lotmark.organisations, lotmark.tenants
    RESTART IDENTITY CASCADE`;
}

async function seedTenantAndOrgs(sql: Sql): Promise<void> {
  // The tenants table is itself under RLS, and a caller creating the FIRST
  // tenant has no tenant context to be granted by. provision_tenant is
  // SECURITY DEFINER and is the only sanctioned way in.
  await sql`SELECT lotmark.provision_tenant(
      ${TENANT}, 'ipc', 'Indian Pharmacopoeia Commission', 'IPC tenant',
      'ISO 17034 + GIGW 3.0 + DPDP', 'IPRS{MAT}{SEQ}', 'NIC / MeitY, in-country')`;

  await sql`UPDATE lotmark.tenants SET
      bilingual = true, adr = true, publications = true, gov_tier = true,
      out_of_scope =
        ${sql.json([
          'GIGW 3.0 portal and CMS', 'Bilingual content authoring',
          'PvPI outreach pages', 'Events, forum, recruitment',
        ] as never)},
      time_source = 'nic.ntp.gov.in (stratum 1)', region = 'ap-south-1'
    WHERE id = ${TENANT}`;

  for (const o of fixture.ORGS) {
    await sql`INSERT INTO lotmark.organisations
        (id, tenant_id, code, name, kind, organisation_type, accreditation, accreditation_scope, phone, price_tier)
      VALUES (${uuidFor(`org:${o.id}`)}, ${TENANT}, ${o.id}, ${o.n}, ${o.kind},
              ${o.type ?? null}, ${o.accred ?? null}, ${o.scope ?? null}, ${o.ph ?? null},
              ${o.tier === 'government' ? 'government' : 'private'})`;
  }

}

async function seedConfig(sql: Sql): Promise<string> {
  // Configuration version 1: the product defaults, derived from the code
  // constants so they cannot drift from what the engine actually enforces.
  const versionId = uuidFor('config:v1');
  const admin = uuidFor('user:u-admin');

  await sql`INSERT INTO lotmark.config_versions
      (id, tenant_id, version_number, status, change_reason, created_by, published_by, published_at)
    VALUES (${versionId}, ${TENANT}, 1, 'draft',
            'Initial product configuration, derived from the built-in defaults', ${admin}, NULL, NULL)`;

  const entries: Array<[string, string, unknown]> = [
    ...defaultRoles().map((r) => ['role', r.key, r] as [string, string, unknown]),
    ...defaultWorkflows().map((w) => ['workflow', w.key, w] as [string, string, unknown]),
    ...defaultSodConfig().map((s) => ['sod', s.ruleId, s] as [string, string, unknown]),
    ...defaultNumbering().map((n) => ['numbering', n.key, n] as [string, string, unknown]),
    ...defaultFlags().map((f) => ['flag', f.key, f] as [string, string, unknown]),
  ];
  for (const [kind, key, payload] of entries) {
    // sql.json(), not JSON.stringify(...)::jsonb — postgres.js serialises the
    // parameter itself, so pre-stringifying stores a JSON *string* rather than
    // an object, and every reader then gets a string where it expects a record.
    await sql`INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
              VALUES (${TENANT}, ${versionId}, ${kind}, ${key}, ${sql.json(payload as never)})`;
  }
  console.log(`config: ${entries.length} entries in version 1`);
  return versionId;
}

async function activateConfig(sql: Sql, versionId: string, admin: string) {
  // Entries can only be written while the version is a draft; publishing is a
  // separate, deliberate step — which is the whole point of the two states.
  await sql`UPDATE lotmark.config_versions
            SET status = 'active', published_by = ${admin}, published_at = now()
            WHERE id = ${versionId}`;
}

async function seedPeople(sql: Sql) {
  const admin = uuidFor('user:u-admin');

  for (const t of TEAMS) {
    await sql`INSERT INTO lotmark.teams (id, tenant_id, key, name)
              VALUES (${uuidFor(`team:${t.key}`)}, ${TENANT}, ${t.key}, ${t.name})`;
  }

  // One shared demo password. Long enough to clear the policy floor, and
  // obviously a demo credential rather than something that looks production-ish.
  const passwordHash = await hashPassword('demo-password-1234');

  // Two passes: every user must exist before any role_assignment can name the
  // admin as its grantor. One pass would depend on the admin appearing first in
  // the fixture, which is a silent ordering dependency waiting to break.
  for (const u of fixture.USERS) {
    // A FIXED demo TOTP secret, the same for every seeded account, so one
    // authenticator entry covers the whole demonstration. Deliberately a
    // constant and deliberately published: this is demo data, and pretending
    // otherwise would be security theatre. Real enrolment mints a random secret
    // per user and shows it once.
    await sql`INSERT INTO lotmark.users
        (id, tenant_id, organisation_id, code, email, display_name, password_hash,
         colour, mfa_required, totp_secret_encrypted, mfa_enrolled_at)
      VALUES (${uuidFor(`user:${u.id}`)}, ${TENANT}, ${uuidFor(`org:${u.org}`)}, ${u.id}, ${u.e}, ${u.n},
              ${passwordHash}, ${u.col}, ${u.mfa}, ${DEMO_TOTP_SECRET}, now())`;
  }

  const ORGANICS_STAFF = ['u-ravi', 'u-sunil', 'u-asha'];
  /** Roles that legitimately span the whole producer rather than one section. */
  const TENANT_WIDE_ROLES = ['quality', 'commercial', 'dispatch', 'tenantadmin'];

  for (const u of fixture.USERS) {
    const id = uuidFor(`user:${u.id}`);
    const producer = u.org === 't-ipc';
    const teamKey = ORGANICS_STAFF.includes(u.id) ? 'organics' : 'inorganics';

    if (producer) {
      await sql`INSERT INTO lotmark.team_memberships (tenant_id, team_id, user_id, joined_on)
                VALUES (${TENANT}, ${uuidFor(`team:${teamKey}`)}, ${id}, '2024-01-01')`;
    }

    const tenantWide = TENANT_WIDE_ROLES.includes(u.role) || !producer;
    await sql`INSERT INTO lotmark.role_assignments
        (tenant_id, user_id, role_key, team_id, granted_by, granted_reason)
      VALUES (${TENANT}, ${id}, ${u.role}, ${tenantWide ? null : uuidFor(`team:${teamKey}`)},
              ${admin}, 'Initial provisioning')`;
  }

  // Ravi also covers Inorganics until the end of the year — the dated,
  // self-expiring assignment the competence model already uses.
  await sql`INSERT INTO lotmark.role_assignments
      (tenant_id, user_id, role_key, team_id, valid_from, valid_to, granted_by, granted_reason)
    VALUES (${TENANT}, ${uuidFor('user:u-ravi')}, 'scientist', ${uuidFor('team:inorganics')},
            '2026-01-01', '2026-12-31', ${admin}, 'Leave cover for the Inorganics section')`;

  for (const [i, c] of (fixture.DB['competence'] as Array<any>).entries()) {
    await sql`INSERT INTO lotmark.competence_records
        (id, tenant_id, code, user_id, activity, valid_from, valid_to, basis, granted_by_user_id)
      VALUES (${uuidFor(`comp:${i}`)}, ${TENANT}, ${'CMP-' + String(i + 1).padStart(3, '0')},
              ${uuidFor(`user:${c.p}`)}, ${c.act}, ${c.from}, ${c.to},
              'Assessed competence record migrated from the prototype', ${admin})`;
  }
  console.log(`people: ${fixture.USERS.length} users, ${TEAMS.length} teams`);
}

async function seedProduction(sql: Sql, configVersionId: string) {
  const D = fixture.DB;

  for (const e of D['equipment'] as Array<any>) {
    await sql`INSERT INTO lotmark.equipment (id, tenant_id, code, name, equipment_type)
              VALUES (${uuidFor(`eq:${e.id}`)}, ${TENANT}, ${e.id}, ${e.n}, ${e.type})`;
    for (const [i, c] of (e.cal as Array<any>).entries()) {
      await sql`INSERT INTO lotmark.calibrations
          (tenant_id, equipment_id, valid_from, valid_to, certificate_reference)
        VALUES (${TENANT}, ${uuidFor(`eq:${e.id}`)}, ${c.from}, ${c.to}, ${`CAL-${e.id}-${i + 1}`})`;
    }
  }

  for (const p of D['projects'] as Array<any>) {
    await sql`INSERT INTO lotmark.projects
        (id, tenant_id, code, material_name, cas_number, sku, stage, owner_user_id,
         owner_team_id, intake_quantity, target_uncertainty)
      VALUES (${uuidFor(`prj:${p.id}`)}, ${TENANT}, ${p.id}, ${p.mat}, ${p.cas}, ${p.sku},
              ${p.stage}, ${uuidFor(`user:${p.owner}`)}, ${teamOfProject(p.id)},
              ${p.intake}, ${p.target})`;
  }

  for (const s of D['studies'] as Array<any>) {
    await sql`INSERT INTO lotmark.studies
        (id, tenant_id, code, project_id, study_type, state, uncertainty,
         signed_by_user_id, signed_on, shelf_life_to, storage_condition, transport_condition,
         owner_team_id, config_version_id)
      VALUES (${uuidFor(`st:${s.id}`)}, ${TENANT}, ${s.id}, ${uuidFor(`prj:${s.prj}`)},
              ${s.type}, ${s.state}, ${s.state === 'signed' ? s.u : null},
              ${s.by ? uuidFor(`user:${s.by}`) : null}, ${s.at ?? null},
              ${s.shelf ?? null}, ${s.storage ?? null}, ${s.transport ?? null},
              ${teamOfProject(s.prj)}, ${configVersionId})`;
    for (const eq of s.eq as string[]) {
      await sql`INSERT INTO lotmark.study_equipment (study_id, equipment_id)
                VALUES (${uuidFor(`st:${s.id}`)}, ${uuidFor(`eq:${eq}`)})`;
    }
    for (const r of (D['results'][s.id] ?? []) as Array<any>) {
      await sql`INSERT INTO lotmark.study_results
          (tenant_id, study_id, unit_ref, replicate, elapsed_months, laboratory_ref, measured_value, measured_unit)
        VALUES (${TENANT}, ${uuidFor(`st:${s.id}`)},
                ${r.u ?? null}, ${r.r ?? null}, ${r.m ?? null}, ${r.lab ?? null},
                ${r.v}, '% w/w')`;
    }
  }

  for (const v of D['values'] as Array<any>) {
    await sql`INSERT INTO lotmark.property_values
        (id, tenant_id, code, project_id, property_name, unit, assigned_value, coverage_factor,
         state, assigned_by, authorised_by, config_version_id)
      VALUES (${uuidFor(`pv:${v.id}`)}, ${TENANT}, ${v.id}, ${uuidFor(`prj:${v.prj}`)},
              ${v.prop}, ${v.unit}, ${v.val}, ${v.k}, ${v.state},
              ${v.assigned ? uuidFor(`user:${v.assigned}`) : null},
              ${v.auth ? uuidFor(`user:${v.auth}`) : null}, ${configVersionId})`;
  }

  // Lots in dependency order: a superseded predecessor must exist first.
  const lots = [...(D['lots'] as Array<any>)].sort((a, b) => (a.prev === '—' ? -1 : 1) - (b.prev === '—' ? -1 : 1));
  const lotIdByCode = new Map<string, string>();
  for (const l of lots) lotIdByCode.set(l.lot, uuidFor(`lot:${l.id}`));
  for (const l of lots) {
    await sql`INSERT INTO lotmark.lots
        (id, tenant_id, project_id, lot_code, previous_lot_id, expiry_date, state, stock_units,
         storage_condition, cold_chain, unit_price_minor, tierable, created_by, released_by,
         owner_team_id, config_version_id)
      VALUES (${uuidFor(`lot:${l.id}`)}, ${TENANT}, ${uuidFor(`prj:${l.prj}`)}, ${l.lot},
              ${lotIdByCode.get(l.prev) ?? null}, ${l.exp}, ${l.state}, ${l.stock},
              ${l.storage}, ${l.cold}, ${l.price * 100}, ${l.tierable},
              ${uuidFor('user:u-sunil')}, ${uuidFor('user:u-asha')},
              ${teamOfProject(l.prj)}, ${configVersionId})`;
  }

  for (const c of D['certs'] as Array<any>) {
    await sql`INSERT INTO lotmark.certificates (id, tenant_id, code, lot_id)
              VALUES (${uuidFor(`cert:${c.id}`)}, ${TENANT}, ${c.id}, ${uuidFor(`lot:${c.lot}`)})`;
    for (const i of c.issues as Array<any>) {
      await sql`INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty,
           property_name, unit, issued_by_user_id, issued_at, reissue_reason, withdrawn, config_version_id)
        VALUES (${TENANT}, ${uuidFor(`cert:${c.id}`)}, ${i.n}, ${i.val}, ${i.U},
                'Assay (as is)', '% w/w', ${uuidFor(`user:${i.by}`)}, ${i.at},
                ${i.n > 1 ? 'Migrated from the prototype' : null}, ${i.withdrawn}, ${configVersionId})`;
    }
  }

  for (const p of D['process'] as Array<any>) {
    await sql`INSERT INTO lotmark.process_steps
        (tenant_id, project_id, step_name, equipment_id, performed_by_user_id, performed_on, note)
      VALUES (${TENANT}, ${uuidFor(`prj:${p.prj}`)}, ${p.step}, ${uuidFor(`eq:${p.eq}`)},
              ${uuidFor(`user:${p.by}`)}, ${p.at}, ${p.note})`;
  }
  console.log(`production: ${(D['projects'] as []).length} projects, ${(D['studies'] as []).length} studies, ${(D['lots'] as []).length} lots`);
}

async function seedDistribution(sql: Sql) {
  const D = fixture.DB;
  for (const o of D['orders'] as Array<any>) {
    await sql`INSERT INTO lotmark.orders
        (id, tenant_id, code, organisation_id, placed_by_user_id, state, placed_on,
         total_minor, courier, owner_team_id)
      VALUES (${uuidFor(`ord:${o.id}`)}, ${TENANT}, ${o.id}, ${uuidFor(`org:${o.org}`)},
              ${uuidFor(`user:${o.by}`)}, ${o.state}, ${o.placed}, ${o.total * 100},
              ${o.courier === '—' ? null : o.courier}, ${uuidFor('team:organics')})`;
    for (const l of o.lines as Array<any>) {
      await sql`INSERT INTO lotmark.order_lines (tenant_id, order_id, lot_id, quantity, unit_price_minor)
                VALUES (${TENANT}, ${uuidFor(`ord:${o.id}`)}, ${uuidFor(`lot:${l.lot}`)}, ${l.q}, ${l.unit * 100})`;
    }
  }

  for (const e of D['entitlements'] as Array<any>) {
    await sql`INSERT INTO lotmark.entitlements
        (tenant_id, code, organisation_id, raised_by, raised_on, supporting_document, state)
      VALUES (${TENANT}, ${e.id}, ${uuidFor(`org:${e.org}`)}, ${uuidFor(`user:${e.by}`)},
              ${e.raised}, ${e.doc}, ${e.state})`;
  }

  for (const lg of D['loggers'] as Array<any>) {
    await sql`INSERT INTO lotmark.shipments (id, tenant_id, code, order_id, temperature_class)
              VALUES (${uuidFor(`shp:${lg.ship}`)}, ${TENANT}, ${lg.ship}, ${uuidFor(`ord:${lg.order}`)}, ${lg.cls})`;
    for (const r of lg.readings as Array<any>) {
      await sql`INSERT INTO lotmark.logger_readings (tenant_id, shipment_id, read_at, celsius)
                VALUES (${TENANT}, ${uuidFor(`shp:${lg.ship}`)}, ${r.t}, ${r.c})`;
    }
  }

  for (const v of D['vault'] as Array<any>) {
    await sql`INSERT INTO lotmark.vault_holdings
        (tenant_id, organisation_id, lot_id, storage_location, quantity)
      VALUES (${TENANT}, ${uuidFor(`org:${v.org}`)}, ${uuidFor(`lot:${v.lot}`)}, ${v.loc}, ${v.qty})`;
  }
  console.log(`distribution: ${(D['orders'] as []).length} orders`);
}

async function seedCompliance(sql: Sql) {
  const D = fixture.DB;
  for (const f of D['facilities'] as Array<any>) {
    await sql`INSERT INTO lotmark.facilities (id, tenant_id, code, name, condition)
              VALUES (${uuidFor(`fac:${f.id}`)}, ${TENANT}, ${f.id}, ${f.n}, ${f.cond})`;
    for (const lot of f.lots as string[]) {
      await sql`INSERT INTO lotmark.facility_lots (facility_id, lot_id)
                VALUES (${uuidFor(`fac:${f.id}`)}, ${uuidFor(`lot:${lot}`)})`;
    }
    for (const x of f.excursions as Array<any>) {
      await sql`INSERT INTO lotmark.facility_excursions
          (tenant_id, facility_id, from_date, to_date, peak_reading, duration_text, disposition)
        VALUES (${TENANT}, ${uuidFor(`fac:${f.id}`)}, ${x.from}, ${x.to}, ${x.peak}, ${x.dur}, 'under assessment')`;
    }
  }

  for (const s of D['subs'] as Array<any>) {
    await sql`INSERT INTO lotmark.subcontractors
        (tenant_id, code, name, activity, accreditation, accreditation_valid_to)
      VALUES (${TENANT}, ${s.id}, ${s.n}, ${s.act}, ${s.accred}, ${s.to})`;
  }

  for (const c of D['capa'] as Array<any>) {
    await sql`INSERT INTO lotmark.capa
        (tenant_id, code, source, subject_table, subject_id, severity, state,
         owner_user_id, owner_team_id, raised_on)
      VALUES (${TENANT}, ${c.id}, ${c.src}, 'orders', ${c.obj}, ${c.sev}, ${c.state},
              ${uuidFor(`user:${c.owner}`)}, ${uuidFor('team:organics')}, ${c.raised})`;
  }
  console.log(`compliance: ${(D['facilities'] as []).length} facilities, ${(D['capa'] as []).length} CAPA`);
}

async function recordSeedInLedger(sql: Sql) {
  await sql`INSERT INTO lotmark.audit_ledger
      (tenant_id, actor_user_id, actor_label, actor_role_id, kind, action, detail, time_source, region)
    VALUES (${TENANT}, ${uuidFor('user:u-admin')}, 'Tenant Administrator', 'tenantadmin',
            'SYSTEM', 'Demonstration tenant seeded',
            'Dataset extracted from docs/artefacts/lotmark-app.html',
            'nic.ntp.gov.in (stratum 1)', 'ap-south-1')`;

  await activateConfig(sql, uuidFor('config:v1'), uuidFor('user:u-admin'));

  await sql`INSERT INTO lotmark.audit_ledger
      (tenant_id, actor_user_id, actor_label, actor_role_id, kind, action, detail, subject_table, subject_id, time_source, region)
    VALUES (${TENANT}, ${uuidFor('user:u-admin')}, 'Tenant Administrator', 'tenantadmin',
            'CONFIGURATION', 'Configuration version 1 published',
            'Product defaults, derived from the built-in constants',
            'config_versions', ${uuidFor('config:v1')},
            'nic.ntp.gov.in (stratum 1)', 'ap-south-1')`;
}

main().catch((e) => { console.error(e); process.exit(1); });
