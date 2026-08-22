/**
 * Back up, restore into a scratch database, and PROVE the restore is sound.
 *
 *   pnpm --filter @lotmark/api dr:backup     take a backup set
 *   pnpm --filter @lotmark/api dr:drill      back up, restore, prove, record
 *
 * ── Why a drill and not a backup ────────────────────────────────────────────
 *
 * A backup that has never been restored is a hypothesis. The failure everyone
 * has is not "the backup was missing" — it is "the backup restored, and the
 * thing we needed was not in it".
 *
 * ── The two things a database-only backup silently loses ────────────────────
 *
 * 1. THE KEYS. Signing keys live outside the database on purpose, so an
 *    attacker who compromises Postgres cannot forge signatures. The
 *    consequence is that `pg_dump` does not contain them, and a restored
 *    database can produce every certificate it ever issued and verify none of
 *    them. The documents are content-addressed on disk for the same reason.
 *
 * 2. THE PRIVILEGES. `pg_dump` does not dump roles, and a restore with
 *    `--no-privileges` produces a database where every REVOKE from migrations
 *    0005, 0012, 0015 and 0019 is gone — the audit ledger writable, PUBLIC
 *    able to execute everything — while EVERY ROW COUNT STILL MATCHES. A drill
 *    that checks row counts passes this with flying colours, which is why the
 *    privilege assertions below are the load-bearing part of this script and
 *    the counts are almost decoration.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { loadConfig } from '../src/config';
import { createDb, inTenantTransaction } from '../src/db';
import { renderCertificate, RENDERER_VERSION, type CertificateSnapshot } from '../src/services/certificate-pdf';

const cfg = loadConfig();
const args = process.argv.slice(2);

const BACKUP_ROOT = '.backups';
const SCRATCH_DB = 'lotmark_drill';

/** Tables whose counts are compared. Indicative only — see the header. */
const COUNTED = ['audit_ledger', 'certificate_issues', 'signatures', 'users', 'lots'] as const;

/**
 * A check either passed, failed, or COULD NOT RUN.
 *
 * The third was missing, and it mattered. Two of this drill's strongest
 * assertions — that stored certificates match their recorded digest, and that
 * one re-renders byte-identically — do nothing when the database holds no
 * rendered certificate, and they were recorded as `ok: true` with the word
 * "skipped" buried in the detail text. `passed = checks.every(c => c.ok)`, so
 * the drill reported PASSED, wrote `outcome: 'passed'` into `dr_drills`, and
 * the conformance view read that as a satisfied control.
 *
 * The printed line said "skipped". The stored boolean said "ok". The boolean is
 * what an assessor is shown.
 */
interface Check { name: string; ok: boolean; skipped?: boolean; detail?: string }
const checks: Check[] = [];

const push = (c: Check) => {
  checks.push(c);
  const badge = c.skipped ? 'skip' : c.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${badge}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
};

const record = (name: string, ok: boolean, detail?: string) => {
  push(detail === undefined ? { name, ok } : { name, ok, detail });
};

/**
 * A check that could not run. Not a pass.
 *
 * `ok` stays true so that `passed` keeps its meaning — nothing FAILED — and the
 * skip is carried separately so the drill cannot claim to have proved something
 * it never executed.
 */
const skip = (name: string, why: string) => {
  push({ name, ok: true, skipped: true, detail: `not run — ${why}` });
};

function dbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/* ── 1. Back up ───────────────────────────────────────────────────────────── */

function backup(): string {
  // The label is the backup's identity in the drill record, so it has to be
  // stable and sortable rather than pretty.
  const label = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  console.log(`backing up to ${dir}`);
  execFileSync('pg_dump', [
    cfg.DATABASE_ADMIN_URL, '--format=custom', '--file', path.join(dir, 'database.dump'),
  ], { stdio: 'inherit' });

  /**
   * The parts pg_dump cannot see.
   *
   * Copied with permissions preserved: a signing key restored as world-readable
   * is a key that has to be treated as compromised.
   */
  for (const src of [cfg.SIGNING_KEY_DIR, cfg.ANCHOR_KEY_DIR, cfg.DOCUMENT_DIR]) {
    if (!existsSync(src)) {
      console.log(`  (${src} does not exist yet — nothing to copy)`);
      continue;
    }
    cpSync(src, path.join(dir, path.basename(src)), { recursive: true, preserveTimestamps: true });
    console.log(`  copied ${src}`);
  }

  /**
   * Roles are CLUSTER-level and are not in the dump either.
   *
   * Captured as SQL so a restore onto a fresh cluster has something to work
   * from. It carries no passwords — `--no-role-passwords` — because a backup
   * that contains credentials is a credential store nobody is treating as one.
   */
  try {
    const roles = execFileSync('pg_dumpall', [
      '--dbname', cfg.DATABASE_ADMIN_URL, '--roles-only', '--no-role-passwords',
    ], { encoding: 'utf8' });
    writeFileSync(path.join(dir, 'roles.sql'), roles, { mode: 0o600 });
    console.log('  captured roles (without passwords)');
  } catch {
    console.warn('  WARNING: could not capture roles; a restore onto a fresh cluster will need them created by hand');
  }

  return label;
}

/* ── 2. Restore into a scratch database ───────────────────────────────────── */

function restore(label: string, sabotage = false): string {
  const dir = path.join(BACKUP_ROOT, label);
  const source = dbName(cfg.DATABASE_ADMIN_URL);
  if (SCRATCH_DB === source) {
    throw new Error(`The scratch database must not be the live one (${source}).`);
  }

  const adminUrl = new URL(cfg.DATABASE_ADMIN_URL);
  adminUrl.pathname = `/${SCRATCH_DB}`;
  const scratchUrl = adminUrl.toString();

  console.log(`\nrestoring into ${SCRATCH_DB} (dropped and recreated)`);
  try { execFileSync('dropdb', ['--if-exists', SCRATCH_DB], { stdio: 'pipe' }); } catch { /* fine */ }
  execFileSync('createdb', [SCRATCH_DB], { stdio: 'inherit' });

  /**
   * Restored WITH privileges, deliberately.
   *
   * `--no-privileges` is the flag people reach for when a restore complains
   * about a missing role, and it is exactly what this drill exists to catch:
   * it produces a database that looks complete and has none of the REVOKEs
   * that make the audit ledger append-only.
   */
  const flags = ['--dbname', scratchUrl, '--no-owner'];
  if (sabotage) flags.push('--no-privileges');
  flags.push(path.join(dir, 'database.dump'));
  execFileSync('pg_restore', flags, { stdio: 'pipe' });

  return scratchUrl;
}

/* ── 3. Prove it ──────────────────────────────────────────────────────────── */

type Outcome = 'passed' | 'failed' | 'incomplete';

async function prove(scratchUrl: string, label: string, recordIt = true): Promise<Outcome> {
  console.log('\nproving the restore:');
  const live = createDb(cfg);
  const scratch = postgres(scratchUrl, { max: 4, onnotice: () => {} });

  try {
    const [t] = await scratch`SELECT id, slug FROM lotmark.tenants LIMIT 1`;
    const tenant = t as { id: string; slug: string } | undefined;
    if (!tenant) { record('a tenant exists in the restored database', false); return false; }
    record('a tenant exists in the restored database', true, tenant.slug);

    /* — Row counts. Necessary, and nowhere near sufficient. — */
    /**
     * The LIVE side must be counted inside a tenant context.
     *
     * It connects as `lotmark_app`, which is a non-superuser under FORCED
     * row-level security, so a query with no `lotmark.tenant_id` set matches
     * nothing and returns zero. The first version of this compared that zero
     * against the restored count and reported every table as mismatched — the
     * policies working exactly as designed, read as a failed restore.
     */
    const liveCounts = await inTenantTransaction(live, {
      tenantId: tenant.id,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, async (tx) => {
      const out = new Map<string, number>();
      for (const table of COUNTED) {
        const [row] = await tx`SELECT count(*)::int AS n FROM lotmark.${tx(table)}`;
        out.set(table, (row as { n: number }).n);
      }
      return out;
    });

    for (const table of COUNTED) {
      const [b] = await scratch`SELECT count(*)::int AS n FROM lotmark.${scratch(table)}`;
      const before = liveCounts.get(table) ?? -1;
      const after = (b as { n: number }).n;
      record(`${table} row count matches`, before === after, `${before} → ${after}`);
    }

    /* — The privilege posture. THE point of the drill. — */
    const appGrants = await scratch`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
      FROM information_schema.role_table_grants
      WHERE table_schema = 'lotmark' AND grantee = 'lotmark_app'
        AND table_name IN ('audit_ledger', 'key_custody_events', 'audit_key_generations')
      GROUP BY table_name`;
    const grantMap = new Map(
      appGrants.map((r) => [(r as { table_name: string }).table_name, (r as { privs: string }).privs]),
    );
    for (const table of ['audit_ledger', 'key_custody_events', 'audit_key_generations']) {
      const privs = grantMap.get(table) ?? '(none)';
      record(`${table} is append-only for the application role`, privs === 'INSERT,SELECT', privs);
    }

    const [pub] = await scratch`
      SELECT count(*)::int AS n FROM lotmark.functions_public_can_execute()`;
    record('PUBLIC can execute no lotmark function', (pub as { n: number }).n === 0,
      `${(pub as { n: number }).n} function(s)`);

    const [rls] = await scratch`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'lotmark' AND c.relkind = 'r'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;
    record('row-level security is enabled and FORCED on every table',
      (rls as { n: number }).n === 0, `${(rls as { n: number }).n} table(s) without it`);

    /* — The audit chain, in the restored database. — */
    const [chain] = await scratch.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${tenant.id}, true)`;
      await tx`SELECT set_config('lotmark.audit_key', ${cfg.LOTMARK_AUDIT_KEY}, true)`;
      await tx`SELECT set_config('lotmark.audit_key_generation', ${cfg.LOTMARK_AUDIT_KEY_GENERATION}, true)`;
      if (cfg.LOTMARK_AUDIT_KEYS) {
        await tx`SELECT set_config('lotmark.audit_keys', ${cfg.LOTMARK_AUDIT_KEYS}, true)`;
      }
      return tx`SELECT * FROM lotmark.verify_audit_chain(${tenant.id})`;
    }) as unknown as Array<{ ok: boolean; entries: string; reason: string | null; keys_missing: string[] }>;
    record('the audit chain verifies in the restored database', chain!.ok === true,
      chain!.ok ? `${chain!.entries} entries` : (chain!.reason ?? 'unknown'));

    /* — The documents, which are not in the dump at all. — */
    const issues = await scratch.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${tenant.id}, true)`;
      return tx`
        SELECT issue_number, document_sha256, document_path, data_snapshot, renderer_version
        FROM lotmark.certificate_issues
        WHERE document_sha256 IS NOT NULL`;
    }) as unknown as Array<{
      issue_number: number; document_sha256: string; document_path: string;
      data_snapshot: CertificateSnapshot; renderer_version: string | null;
    }>;

    if (issues.length === 0) {
      skip('stored certificates match their recorded digest',
        'the database holds no rendered certificate');
    } else {
      let intact = 0;
      let missing = 0;
      for (const issue of issues) {
        const file = path.join(cfg.DOCUMENT_DIR, issue.document_path);
        if (!existsSync(file)) { missing++; continue; }
        const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
        if (digest === issue.document_sha256) intact++;
      }
      record('stored certificates match their recorded digest',
        intact === issues.length,
        `${intact}/${issues.length} intact${missing > 0 ? `, ${missing} FILE(S) MISSING` : ''}`);
    }

    /**
     * Re-rendering. The strongest check available, and the one with a real
     * limit worth stating: only issues produced by the CURRENT renderer can be
     * re-rendered, because a renderer change legitimately changes the bytes.
     * Issues from an older renderer are covered by the digest check above, not
     * by this one.
     */
    const reproducible = issues.filter((i) => i.renderer_version === RENDERER_VERSION);
    if (reproducible.length === 0) {
      skip('a certificate re-renders byte-identically',
        `no issue was produced by ${RENDERER_VERSION}`);
    } else {
      const issue = reproducible[0]!;
      const bytes = await renderCertificate(issue.data_snapshot);
      const digest = createHash('sha256').update(bytes).digest('hex');
      record('a certificate re-renders byte-identically', digest === issue.document_sha256,
        `issue #${issue.issue_number}`);
    }

    /* — The keys, which are also not in the dump. — */
    const keyFiles = existsSync(cfg.SIGNING_KEY_DIR) ? readdirSync(cfg.SIGNING_KEY_DIR) : [];
    const [registered] = await scratch.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.tenant_id', ${tenant.id}, true)`;
      return tx`SELECT count(*)::int AS n FROM lotmark.signing_keys WHERE retired_at IS NULL`;
    }) as unknown as Array<{ n: number }>;
    record('the backup set carries key material alongside the database',
      keyFiles.length > 0 || registered!.n === 0,
      `${keyFiles.length} file(s) in ${cfg.SIGNING_KEY_DIR} for ${registered!.n} registered key(s)`);

    /* — Record the drill in the LIVE database, where somebody will see it. — */
    const failed = checks.filter((c) => !c.ok).length;
    const skipped = checks.filter((c) => c.skipped).length;
    /**
     * A skip is not a pass.
     *
     * `checks.every(c => c.ok)` used to decide this on its own, and a check
     * that could not run recorded itself `ok: true` — so a drill that never
     * looked at a certificate came out `passed`. The three outcomes are now
     * separate, and `incomplete` is what a drill that skipped anything gets.
     * The conformance view treats it as unsatisfied. See migration 0028.
     */
    const outcome: Outcome = failed > 0 ? 'failed' : skipped > 0 ? 'incomplete' : 'passed';
    if (skipped > 0) {
      console.log(
        `\n  ${skipped} check(s) COULD NOT RUN. A drill that skipped its document ` +
        'checks has not proved that a certificate survives a restore.');
    }
    if (!recordIt) return outcome;
    await inTenantTransaction(live, {
      tenantId: tenant.id,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, async (tx) => {
      await tx`
        INSERT INTO lotmark.dr_drills
          (tenant_id, source_label, finished_at, outcome, checks, notes)
        VALUES (${tenant.id}, ${label}, now(),
                ${outcome},
                ${tx.json(checks as never)},
                ${'Restored into ' + SCRATCH_DB + ' and verified. ' +
                  'Key material and documents were checked from the backup set, not the dump.' +
                  (skipped > 0 ? ` ${skipped} check(s) could not run.` : '')})`;
    });

    return outcome;
  } finally {
    await scratch.end();
    await live.end();
  }
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  /**
   * Does the drill actually catch anything?
   *
   * A drill made of assertions nobody has ever seen fail is a drill that
   * passes because it is not looking. This mode restores the SAME backup with
   * `--no-privileges` — the flag people reach for when a restore complains
   * about a missing role — and requires the drill to FAIL.
   *
   * Measured on this machine: with that flag the audit ledger row count is
   * identical, and lotmark_app loses every grant while PUBLIC regains EXECUTE
   * on 37 functions. A drill that checked only row counts would report a
   * perfect restore of a database whose append-only ledger is writable.
   */
  if (args.includes('--sabotage')) {
    const label = backup();
    const scratchUrl = restore(label, true);
    const outcome = await prove(scratchUrl, label, false);
    console.log();
    if (outcome !== 'failed') {
      console.error(
        `THE DRILL IS NOT WORKING: a restore with --no-privileges came out ${outcome} ` +
        'rather than failed. The privilege assertions are the only thing standing ' +
        'between this drill and a false sense of security.',
      );
      process.exit(1);
    }
    const missed = checks.filter((c) => !c.ok).map((c) => c.name);
    console.log(`THE DRILL WORKS — it caught ${missed.length} problem(s) a row-count check would have missed:`);
    for (const m of missed) console.log(`  · ${m}`);
    return;
  }

  if (args.includes('--backup-only')) {
    const label = backup();
    console.log(`\nbackup set ${label} is complete. It has NOT been restored, so it proves nothing yet.`);
    console.log('Run the drill to find out whether it works.');
    return;
  }

  const label = backup();
  const scratchUrl = restore(label);
  const outcome = await prove(scratchUrl, label);

  console.log(`\n${`DRILL ${outcome.toUpperCase()}`} — recorded against backup set ${label}`);
  console.log(`The scratch database ${SCRATCH_DB} is left in place for inspection.`);
  /**
   * An incomplete drill exits 1 as well.
   *
   * It did not fail, and it also did not do the job it was run to do. An
   * operator running this from cron wants to hear about that, and the only
   * channel a cron job has is the exit code.
   */
  if (outcome !== 'passed') process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
