import { createHash } from 'node:crypto';
import {
  REQUIREMENTS, byClause, SOD_RULES,
  type Requirement, type RequirementStatus,
} from '@lotmark/domain';
import type { Sql } from '../db';
import { retentionSettings } from './retention';

/**
 * Conformance, evidenced from the records rather than asserted.
 *
 * ── The difference this draws ───────────────────────────────────────────────
 *
 * A requirement register says what the SYSTEM does. This says what the RECORDS
 * show — how many competence authorisations are live, whether the chain
 * verifies today, how many certificates were issued, whether the monitoring job
 * has run. An assessor asks the second question, and a page that answered only
 * the first would be a specification with a tick beside each line.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * Turn a gap into a pass. `REQ-SUBCONTRACT` is declared and not enforced, and
 * the live evidence for it is the absence of an enforcement point — reported as
 * such. A conformance view that showed everything green would be the least
 * useful screen in the product.
 */

export interface LiveEvidence {
  /** The requirement's `live` key. */
  readonly key: string;
  readonly summary: string;
  /** Numbers an assessor can check against the records themselves. */
  readonly figures: Record<string, string | number | null>;
  /** True when the records support the claim right now. */
  readonly satisfied: boolean;
}

export interface ClauseView {
  readonly clause: string;
  readonly requirements: Array<Requirement & { evidence: LiveEvidence | null }>;
  /** The weakest status among them — a clause is only as good as its worst part. */
  readonly status: RequirementStatus;
}

const RANK: Record<RequirementStatus, number> = {
  not_implemented: 0, declared: 1, partial: 2, enforced: 3,
};

/**
 * KNOWN COST: about fifteen sequential round trips, ~700 ms on an idle
 * database. Each statement is a few milliseconds; the cost is how many there
 * are, and they cannot run concurrently because a transaction is one
 * connection. Acceptable for a screen somebody opens deliberately, and worth
 * knowing before this is put anywhere that renders on every request.
 */
export async function liveEvidence(tx: Sql, tenantId: string): Promise<Map<string, LiveEvidence>> {
  const out = new Map<string, LiveEvidence>();
  const add = (e: LiveEvidence) => out.set(e.key, e);
  const today = new Date().toISOString().slice(0, 10);

  const [competence] = await tx`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE valid_from <= ${today} AND valid_to >= ${today})::int AS live,
           count(DISTINCT user_id)::int AS people
    FROM lotmark.competence_records
    WHERE tenant_id = ${tenantId} AND superseded_at IS NULL`;
  const c = competence as { total: number; live: number; people: number };
  add({
    key: 'competence',
    summary: `${c.live} authorisation(s) valid today, across ${c.people} person(s)`,
    figures: { live: c.live, total: c.total, people: c.people },
    satisfied: c.live > 0,
  });

  for (const [key, type] of [
    ['homogeneity', 'homogeneity'], ['stability', 'stability'],
    ['characterisation', 'characterisation'],
  ] as const) {
    const [row] = await tx`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'signed')::int AS signed
      FROM lotmark.studies WHERE tenant_id = ${tenantId} AND study_type = ${type}`;
    const s = row as { total: number; signed: number };
    add({
      key,
      summary: `${s.signed} signed ${type} stud${s.signed === 1 ? 'y' : 'ies'} of ${s.total}`,
      figures: { signed: s.signed, total: s.total },
      satisfied: s.signed > 0,
    });
  }

  const [values] = await tx`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE state = 'authorised')::int AS authorised,
           count(*) FILTER (WHERE state = 'authorised' AND expanded_uncertainty IS NOT NULL)::int AS with_u
    FROM lotmark.property_values WHERE tenant_id = ${tenantId}`;
  const v = values as { total: number; authorised: number; with_u: number };
  add({
    key: 'uncertainty',
    summary: `${v.with_u} of ${v.authorised} authorised value(s) carry an expanded uncertainty`,
    figures: { authorised: v.authorised, withUncertainty: v.with_u },
    // Every authorised value must carry one. A single value without is a
    // certificate that could be issued stating a figure with no uncertainty.
    satisfied: v.authorised > 0 && v.with_u === v.authorised,
  });

  const [certs] = await tx`
    SELECT count(*)::int AS issues,
           count(*) FILTER (WHERE withdrawn)::int AS withdrawn,
           count(*) FILTER (WHERE document_sha256 IS NOT NULL)::int AS rendered,
           count(DISTINCT certificate_id)::int AS certificates
    FROM lotmark.certificate_issues WHERE tenant_id = ${tenantId}`;
  const cert = certs as { issues: number; withdrawn: number; rendered: number; certificates: number };
  add({
    key: 'certificates',
    summary: `${cert.certificates} certificate(s), ${cert.issues} issue(s), ${cert.withdrawn} withdrawn`,
    figures: {
      certificates: cert.certificates, issues: cert.issues,
      rendered: cert.rendered, withdrawn: cert.withdrawn,
    },
    satisfied: cert.issues > 0,
  });

  const [notices] = await tx`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE unreachable_reason IS NOT NULL)::int AS unreachable
    FROM lotmark.notifications
    WHERE tenant_id = ${tenantId} AND subject_table IN ('reissue', 'withdrawal')`;
  const n = notices as { total: number; unreachable: number };
  add({
    key: 'holders',
    summary: n.total === 0
      ? 'No reissue or withdrawal has been notified yet'
      : `${n.total} notice(s), ${n.unreachable} to organisations with nobody to address`,
    figures: { notices: n.total, unreachable: n.unreachable },
    // Unreachable holders do not make the control fail — they are the control
    // reporting honestly. What would fail is notices that were never attempted.
    satisfied: true,
  });

  const [capa] = await tx`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE state <> 'closed')::int AS open,
           count(*) FILTER (WHERE state <> 'closed' AND due_on < ${today})::int AS overdue
    FROM lotmark.capa WHERE tenant_id = ${tenantId}`;
  const q = capa as { total: number; open: number; overdue: number };
  add({
    key: 'capa',
    summary: `${q.open} open of ${q.total}, ${q.overdue} past due`,
    figures: { total: q.total, open: q.open, overdue: q.overdue },
    satisfied: q.overdue === 0,
  });

  const [monitoring] = await tx`
    SELECT count(*)::int AS points,
           count(*) FILTER (WHERE next_due_on < ${today})::int AS overdue
    FROM lotmark.monitoring_points WHERE tenant_id = ${tenantId}`;
  const m = monitoring as { points: number; overdue: number };
  add({
    key: 'monitoring',
    summary: `${m.points} monitoring point(s), ${m.overdue} overdue`,
    figures: { points: m.points, overdue: m.overdue },
    satisfied: true,
  });

  const [chain] = await tx`SELECT * FROM lotmark.verify_audit_chain(${tenantId})`;
  const ch = chain as {
    ok: boolean; entries: string; reason: string | null;
    generations: string[]; keys_missing: string[];
  };
  add({
    key: 'chain',
    summary: ch.ok
      ? `Intact across ${ch.entries} entries, generation(s) ${ch.generations.join(', ')}`
      : ch.keys_missing.length > 0
        ? `UNVERIFIED — no key held for ${ch.keys_missing.join(', ')}. Not evidence of tampering.`
        : `BROKEN — ${ch.reason}`,
    figures: {
      entries: Number(ch.entries),
      generations: ch.generations.join(', '),
      keysMissing: ch.keys_missing.join(', ') || null,
    },
    satisfied: ch.ok,
  });

  const [signatures] = await tx`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE signature_value IS NOT NULL)::int AS bound,
           count(DISTINCT meaning)::int AS meanings
    FROM lotmark.signatures WHERE tenant_id = ${tenantId}`;
  const sg = signatures as { total: number; bound: number; meanings: number };
  add({
    key: 'signatures',
    summary: `${sg.bound} of ${sg.total} signature(s) carry a cryptographic binding`,
    figures: { total: sg.total, bound: sg.bound, distinctMeanings: sg.meanings },
    satisfied: sg.total === 0 || sg.bound === sg.total,
  });

  const [custody] = await tx`
    SELECT string_agg(DISTINCT custody, ', ') AS classes, count(*)::int AS keys
    FROM lotmark.signing_keys WHERE tenant_id = ${tenantId} AND retired_at IS NULL`;
  const ky = custody as { classes: string | null; keys: number };
  add({
    key: 'custody',
    summary: ky.keys === 0
      ? 'No signing key is registered'
      : `${ky.keys} active key(s), custody ${ky.classes}`,
    figures: { keys: ky.keys, classes: ky.classes },
    // dev_file is honest, not compliant. The view says so rather than ticking.
    satisfied: ky.keys > 0 && ky.classes !== null && !ky.classes.includes('dev_file'),
  });

  const [drill] = await tx`
    SELECT outcome, started_at::date AS on_date FROM lotmark.dr_drills
    WHERE tenant_id = ${tenantId} ORDER BY started_at DESC LIMIT 1`;
  const dr = drill as { outcome: string | null; on_date: string } | undefined;
  add({
    key: 'drills',
    summary: dr
      ? `Last rehearsed restore ${dr.on_date}: ${dr.outcome}`
      : 'No restore has ever been rehearsed. Whether the backups work is unknown.',
    figures: { lastDrill: dr?.on_date ?? null, outcome: dr?.outcome ?? null },
    satisfied: dr?.outcome === 'passed',
  });

  const [jobs] = await tx`
    SELECT count(*)::int AS reporting,
           count(*) FILTER (WHERE last_outcome <> 'success')::int AS unhealthy
    FROM lotmark.job_health(${tenantId})`;
  const jb = jobs as { reporting: number; unhealthy: number };
  add({
    key: 'jobs',
    summary: `${jb.reporting} job(s) have run; ${jb.unhealthy} did not last succeed`,
    figures: { reporting: jb.reporting, unhealthy: jb.unhealthy },
    satisfied: jb.reporting > 0 && jb.unhealthy === 0,
  });

  const [config] = await tx`
    SELECT count(*)::int AS versions,
           count(*) FILTER (WHERE status = 'active')::int AS active,
           count(*) FILTER (WHERE signature_id IS NOT NULL)::int AS signed
    FROM lotmark.config_versions WHERE tenant_id = ${tenantId}`;
  const cf = config as { versions: number; active: number; signed: number };
  add({
    key: 'config',
    summary: `${cf.versions} configuration version(s), ${cf.signed} signed, ${cf.active} active`,
    figures: { versions: cf.versions, active: cf.active, signed: cf.signed },
    satisfied: cf.active === 1,
  });

  const [credentials] = await tx`
    SELECT count(*)::int AS accounts,
           count(*) FILTER (WHERE password_change_required)::int AS owing,
           count(*) FILTER (WHERE password_changed_at IS NOT NULL)::int AS self_chosen
    FROM lotmark.users
    WHERE tenant_id = ${tenantId} AND deactivated_at IS NULL`;
  const cr = credentials as { accounts: number; owing: number; self_chosen: number };
  add({
    key: 'credentials',
    summary: cr.owing === 0
      ? `no account is holding an issued password (${cr.accounts} active)`
      : `${cr.owing} of ${cr.accounts} account(s) still hold the password they were issued`,
    figures: { accounts: cr.accounts, owing: cr.owing, selfChosen: cr.self_chosen },
    /**
     * Reports the RECORDS, not the control. An account provisioned five minutes
     * ago legitimately owes a change and will show here until it is paid —
     * which is the honest reading, because at this instant somebody can
     * authenticate with a credential two people know.
     */
    satisfied: cr.owing === 0,
  });

  /**
   * What the tenant has actually decided about segregation.
   *
   * A register that says "six rules" tells an assessor nothing; which are ON
   * here, today, is the question they ask. Read from the active configuration,
   * which is what the guard reads.
   */
  const sodRows = await tx`
    SELECT e.key, e.payload
    FROM lotmark.config_entries e
    JOIN lotmark.config_versions v ON v.id = e.version_id
    WHERE v.tenant_id = ${tenantId} AND v.status = 'active' AND e.kind = 'sod'`;
  const decided = sodRows.map((r) => r as { key: string; payload: { enabled?: boolean } });
  const on = decided.filter((r) => r.payload?.enabled === true);
  const enforceable = SOD_RULES.filter((r) => r.status === 'enforced').length;
  add({
    key: 'segregation',
    summary: `${on.length} of ${decided.length} configured rule(s) on; `
      + `${SOD_RULES.length - enforceable} declared without an enforceable subject`,
    figures: {
      configured: decided.length,
      enabled: on.length,
      enforceable,
      declaredOnly: SOD_RULES.length - enforceable,
    },
    /**
     * Satisfied when the tenant has actually decided — an unconfigured register
     * falls back to product defaults, which is a defensible position and not a
     * decision anybody made.
     */
    satisfied: decided.length === SOD_RULES.length,
  });

  /**
   * What this tenant keeps, and for how long.
   *
   * An assessor asks "show me your retention schedule and show me that you
   * follow it". The schedule is code; this is the second half — the period
   * actually in force per class, and whether any is below the law.
   */
  const retention = await retentionSettings(tx, tenantId);
  const belowFloor = retention.filter(
    (r) => r.configuredDays !== null && r.floorDays !== null && r.configuredDays < r.floorDays);
  const withPeriod = retention.filter((r) => r.configuredDays !== null);
  add({
    key: 'retention',
    summary: belowFloor.length > 0
      ? `${belowFloor.length} class(es) configured below the statutory minimum`
      : `${retention.length} class(es) scheduled, ${withPeriod.length} with a tenant period`,
    figures: {
      classes: retention.length,
      tenantSet: withPeriod.length,
      belowFloor: belowFloor.length,
      /** The shortest period in force, which is the one an assessor probes. */
      shortestDays: Math.min(...retention.map((r) => r.effectiveDays ?? Infinity)),
    },
    /**
     * A stored period below the floor does not take effect — the runtime takes
     * the greater of the two — but it must not read as satisfied, because
     * somebody wrote it down and believes it.
     */
    satisfied: belowFloor.length === 0,
  });

  const [coldchain] = await tx`
    SELECT count(*)::int AS shipments,
           coalesce(sum((SELECT count(*) FROM lotmark.logger_readings r
                          WHERE r.shipment_id = s.id))::int, 0) AS readings
    FROM lotmark.shipments s WHERE s.tenant_id = ${tenantId}`;
  const cc = coldchain as { shipments: number; readings: number };
  add({
    key: 'coldchain',
    summary: `${cc.shipments} shipment(s), ${cc.readings} logger reading(s) held as data`,
    figures: { shipments: cc.shipments, readings: cc.readings },
    satisfied: true,
  });

  return out;
}

export async function conformanceView(tx: Sql, tenantId: string): Promise<ClauseView[]> {
  const evidence = await liveEvidence(tx, tenantId);
  return byClause().map(({ clause, requirements }) => ({
    clause,
    requirements: requirements.map((r) => ({
      ...r,
      evidence: r.live ? evidence.get(r.live) ?? null : null,
    })),
    // The weakest status wins: a clause is only as good as its worst part, and
    // averaging would let one enforced requirement hide a declared one.
    status: requirements.reduce<RequirementStatus>(
      (worst, r) => (RANK[r.status] < RANK[worst] ? r.status : worst), 'enforced'),
  }));
}

/* ── The assessment pack ──────────────────────────────────────────────────── */

export interface AssessmentPack {
  readonly generatedAt: string;
  readonly tenant: { id: string; slug: string; name: string; conformanceFrame: string };
  readonly requirements: readonly unknown[];
  readonly sections: Record<string, unknown>;
  readonly limits: readonly string[];
  readonly manifest: {
    readonly sectionDigests: Record<string, string>;
    readonly packDigest: string;
    readonly signature: string | null;
    readonly keyVersion: string | null;
    readonly keyCustody: string | null;
  };
}

/** Canonical JSON: keys sorted, so an equivalent object always digests the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

/**
 * The bundle an assessor actually asks for.
 *
 * Each section is digested separately as well as the whole, so a dispute about
 * one part does not require re-establishing all of it — and so a section can be
 * quoted with a digest that means something on its own.
 *
 * The pack is REPRODUCIBLE for a given database state: `generatedAt` is
 * excluded from the digest, because otherwise two exports of the same records
 * would differ and the digest would prove nothing about the records.
 */
export async function buildAssessmentPack(
  tx: Sql,
  tenantId: string,
  sign: (payload: string) => { signature: string; keyVersion: string; custody: string } | null,
): Promise<AssessmentPack> {
  const [tenantRow] = await tx`
    SELECT id, slug, name, conformance_frame FROM lotmark.tenants WHERE id = ${tenantId}`;
  const tenant = tenantRow as
    { id: string; slug: string; name: string; conformance_frame: string };

  const view = await conformanceView(tx, tenantId);

  const sections: Record<string, unknown> = {};

  sections['scope'] = {
    producer: tenant.name,
    conformanceFrame: tenant.conformance_frame,
    accreditation: (await tx`
      SELECT accreditation FROM lotmark.organisations
      WHERE tenant_id = ${tenantId} AND kind = 'producer' LIMIT 1`)
      .map((r) => (r as { accreditation: string | null }).accreditation)[0] ?? null,
  };

  sections['competence'] = await tx`
    SELECT c.code, u.display_name, c.activity, c.valid_from, c.valid_to, c.basis
    FROM lotmark.competence_records c JOIN lotmark.users u ON u.id = c.user_id
    WHERE c.tenant_id = ${tenantId} AND c.superseded_at IS NULL
    ORDER BY u.display_name, c.activity`;

  /**
   * Equipment with its calibration window.
   *
   * `calibrations` records a validity INTERVAL rather than a date and a due
   * date — which is the same shape as a competence record, and for the same
   * reason: the question an assessor asks is "was this instrument in
   * calibration on the day the measurement was taken", and an interval answers
   * it directly.
   */
  sections['equipment'] = await tx`
    SELECT e.code, e.name, e.equipment_type,
           (SELECT max(cal.valid_from) FROM lotmark.calibrations cal WHERE cal.equipment_id = e.id) AS calibrated_from,
           (SELECT max(cal.valid_to) FROM lotmark.calibrations cal WHERE cal.equipment_id = e.id) AS calibrated_to,
           (SELECT cal.certificate_reference FROM lotmark.calibrations cal
             WHERE cal.equipment_id = e.id ORDER BY cal.valid_from DESC LIMIT 1) AS certificate_reference
    FROM lotmark.equipment e WHERE e.tenant_id = ${tenantId} ORDER BY e.code`;

  sections['certificates'] = await tx`
    SELECT c.code, i.issue_number, i.issued_at::date AS issued_on,
           i.property_name, i.assigned_value, i.expanded_uncertainty, i.coverage_factor, i.unit,
           i.withdrawn, i.withdrawn_reason, i.reissue_reason,
           i.document_sha256, i.renderer_version, i.template_key, i.template_version,
           i.data_snapshot_digest, u.display_name AS issued_by
    FROM lotmark.certificate_issues i
    JOIN lotmark.certificates c ON c.id = i.certificate_id
    LEFT JOIN lotmark.users u ON u.id = i.issued_by_user_id
    WHERE i.tenant_id = ${tenantId} ORDER BY c.code, i.issue_number`;

  sections['capa'] = await tx`
    SELECT code, source, severity, state, raised_on, due_on, root_cause, corrective_action, closed_at
    FROM lotmark.capa WHERE tenant_id = ${tenantId} ORDER BY raised_on DESC`;

  sections['signatures'] = await tx`
    SELECT s.subject_kind, s.meaning, s.signed_at::date AS signed_on, s.algorithm,
           s.key_version, s.canonical_version, s.competence_activity,
           s.competence_valid_from, s.competence_valid_to, u.display_name AS signer
    FROM lotmark.signatures s JOIN lotmark.users u ON u.id = s.signer_user_id
    WHERE s.tenant_id = ${tenantId} ORDER BY s.signed_at`;

  const [chain] = await tx`SELECT * FROM lotmark.verify_audit_chain(${tenantId})`;
  const [ledgerCount] = await tx`
    SELECT count(*)::int AS n, max(seq)::int AS head FROM lotmark.audit_ledger WHERE tenant_id = ${tenantId}`;
  sections['auditChain'] = {
    verification: chain,
    /**
     * The COUNT matters as much as the verdict.
     *
     * `verify_audit_chain` walks from seq 1 and checks continuity and the HMAC;
     * a ledger truncated at the end still returns ok. Only a recorded count,
     * compared against a previous pack or an anchor, catches that.
     */
    entriesHeld: (ledgerCount as { n: number }).n,
    headSeq: (ledgerCount as { head: number | null }).head,
  };

  sections['anchors'] = await tx`
    SELECT through_seq, head_hash, entry_count, taken_at::date AS taken_on, exported_at, export_target
    FROM lotmark.audit_checkpoints WHERE tenant_id = ${tenantId} ORDER BY through_seq`;

  sections['drills'] = await tx`
    SELECT started_at::date AS on_date, source_label, outcome, checks
    FROM lotmark.dr_drills WHERE tenant_id = ${tenantId} ORDER BY started_at DESC`;

  sections['configuration'] = await tx`
    SELECT version_number, status, change_reason, published_at::date AS published_on,
           signature_id IS NOT NULL AS signed, change_summary
    FROM lotmark.config_versions WHERE tenant_id = ${tenantId} ORDER BY version_number`;

  const requirements = view.flatMap((c) => c.requirements.map((r) => ({
    id: r.id, clause: r.clause, statement: r.statement, status: r.status,
    note: r.note ?? null,
    code: r.code, tests: r.tests,
    liveEvidence: r.evidence,
  })));

  const sectionDigests = Object.fromEntries(
    Object.entries(sections).map(([k, v]) => [k, digest(v)]),
  );

  const body = { tenant, requirements, sections };
  const packDigest = digest(body);
  const signed = sign(packDigest);

  return {
    // Excluded from the digest on purpose — see the doc comment.
    generatedAt: new Date().toISOString(),
    tenant: {
      id: tenant.id, slug: tenant.slug, name: tenant.name,
      conformanceFrame: tenant.conformance_frame,
    },
    requirements,
    sections,
    limits: [
      'The requirement statuses are the producer\'s own, checked against the ' +
      'repository by an automated test — they are not an accreditation body\'s ' +
      'finding.',
      'Certificates are built to PDF/A-2b and checked against the structural ' +
      'subset this system can verify. They are NOT veraPDF-verified.',
      'The audit chain verification walks from the first entry; a ledger ' +
      'truncated at its END would still verify. The recorded entry count and ' +
      'the anchors are what make that detectable.',
      'This pack is signed with the producer\'s record key. Its custody class ' +
      'is stated in the manifest and may not be production-grade.',
    ],
    manifest: {
      sectionDigests,
      packDigest,
      signature: signed?.signature ?? null,
      keyVersion: signed?.keyVersion ?? null,
      keyCustody: signed?.custody ?? null,
    },
  };
}
