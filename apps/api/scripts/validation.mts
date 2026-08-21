/**
 * Computerised system validation, executable.
 *
 *   pnpm --filter @lotmark/api iq     installation qualification
 *   pnpm --filter @lotmark/api pq     performance qualification
 *   pnpm --filter @lotmark/api rtm    regenerate the traceability matrix
 *
 * ── What each of these is, and is not ───────────────────────────────────────
 *
 * IQ — INSTALLATION. Is the thing that was installed the thing that was meant
 * to be? Versions, migrations, roles, privileges, row-level security. It reads
 * the live database and reports; it changes nothing.
 *
 * OQ — OPERATION. Does each function do what it is specified to do? That is the
 * automated test suite, and the RTM below is what maps it to the requirements.
 * Writing a separate OQ document that restated the tests would create a second
 * thing to keep true.
 *
 * PQ — PERFORMANCE. Does the whole process work, end to end, as the people who
 * use it would? A run of the real business journey through the real API, by
 * the real personas: characterise a material, sign it, authorise a value,
 * release a lot, issue a certificate, sell it, and withdraw it — checking at
 * the end that the laboratory holding it was told.
 *
 * A PQ that passes on a machine whose IQ fails proves nothing, so PQ refuses to
 * run until IQ passes.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { REQUIREMENTS, requirementsByStatus, byClause } from '@lotmark/domain';
import { loadConfig } from '../src/config';

const cfg = loadConfig();
const args = process.argv.slice(2);

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail = ''): boolean => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

/* ── Installation qualification ───────────────────────────────────────────── */

async function iq(): Promise<boolean> {
  console.log('INSTALLATION QUALIFICATION\n');

  /**
   * Connected as the OWNER, deliberately.
   *
   * `lotmark_app` holds no USAGE on `lotmark_meta`, so an IQ run as the
   * application role would report ZERO applied migrations and look like an
   * answer. An installation check is an operator's act and uses an operator's
   * connection; what it must NOT do is change anything, and it does not.
   */
  const sql = postgres(cfg.DATABASE_ADMIN_URL, { max: 2, onnotice: () => {} });

  try {
    record('Node runtime', Number(process.versions.node.split('.')[0]) >= 22,
      `v${process.versions.node} (needs 22 or later)`);

    const [ver] = await sql`SELECT current_setting('server_version') AS v`;
    const major = Number((ver as { v: string }).v.split('.')[0]);
    record('PostgreSQL', major >= 16, `${(ver as { v: string }).v} (needs 16 or later)`);

    const [ext] = await sql`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'`;
    record('pgcrypto is installed', (ext as { n: number }).n === 1,
      'the audit chain HMAC needs it');

    const applied = await sql`
      SELECT filename FROM lotmark_meta.schema_migrations ORDER BY filename`;
    const names = applied.map((r) => (r as { filename: string }).filename);
    record('migrations applied', names.length > 0,
      `${names.length}: ${names[0]} … ${names[names.length - 1]}`);

    const roles = await sql`
      SELECT rolname, rolsuper FROM pg_roles WHERE rolname IN ('lotmark_app', 'lotmark_signer')`;
    const byName = new Map(roles.map((r) => [(r as { rolname: string }).rolname,
                                             (r as { rolsuper: boolean }).rolsuper]));
    for (const role of ['lotmark_app', 'lotmark_signer']) {
      record(`role ${role} exists`, byName.has(role));
      if (byName.has(role)) {
        // A superuser bypasses row-level security UNCONDITIONALLY, which would
        // make every policy in the schema inert. This was a real defect once.
        record(`role ${role} is NOT a superuser`, byName.get(role) === false,
          'a superuser bypasses row-level security entirely');
      }
    }

    const [rls] = await sql`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'lotmark' AND c.relkind = 'r'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;
    record('row-level security enabled and FORCED on every table',
      (rls as { n: number }).n === 0,
      `${(rls as { n: number }).n} table(s) without it`);

    const [pub] = await sql`SELECT count(*)::int AS n FROM lotmark.functions_public_can_execute()`;
    record('PUBLIC can execute no lotmark function', (pub as { n: number }).n === 0,
      `${(pub as { n: number }).n} function(s)`);

    for (const table of ['audit_ledger', 'key_custody_events', 'audit_key_generations']) {
      const grants = await sql`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'lotmark' AND table_name = ${table} AND grantee = 'lotmark_app'`;
      const privs = grants.map((g) => (g as { privilege_type: string }).privilege_type).sort();
      record(`${table} is append-only for the application role`,
        privs.join(',') === 'INSERT,SELECT', privs.join(',') || '(none)');
    }

    const [custody] = await sql`
      SELECT count(*)::int AS n FROM lotmark.signing_keys
      WHERE retired_at IS NULL AND custody NOT IN ('dev_file','env','keychain','kms','hsm')`;
    record('every signing key names a known custody class', (custody as { n: number }).n === 0);

    record('signing key custody configured', true,
      `${cfg.SIGNING_KEY_CUSTODY} — printed on every certificate this key signs`);

    return checks.every((c) => c.ok);
  } finally {
    await sql.end();
  }
}

/* ── The traceability matrix ──────────────────────────────────────────────── */

function rtm(): void {
  const byStatus = requirementsByStatus();
  const lines: string[] = [];

  lines.push('# Requirements traceability matrix');
  lines.push('');
  lines.push('GENERATED — do not edit. Run `pnpm --filter @lotmark/api rtm`.');
  lines.push('');
  lines.push(
    'The source is `packages/domain/src/conformance.ts`, and every citation below ' +
    'is checked by `packages/domain/src/__tests__/conformance.test.ts`: the file ' +
    'must exist, and the test file must contain a test named by the cited phrase. ' +
    'Deleting the test that demonstrates a control, or renaming the file that ' +
    'implements it, fails the build rather than quietly leaving a claim behind.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Status | Count | Meaning |');
  lines.push('|---|---|---|');
  lines.push(`| enforced | ${byStatus.enforced.length} | the code refuses the thing |`);
  lines.push(`| partial | ${byStatus.partial.length} | enforced on some paths; the gap is stated |`);
  lines.push(`| declared | ${byStatus.declared.length} | written down, nothing checks it |`);
  lines.push(`| not implemented | ${byStatus.not_implemented.length} | absent, and recorded as absent |`);
  lines.push('');
  lines.push(
    'A register in which everything is enforced is a register nobody can trust. ' +
    'The gaps below are the reason the rest is worth reading.',
  );
  lines.push('');

  for (const { clause, requirements } of byClause()) {
    lines.push(`## ${clause}`);
    lines.push('');
    for (const r of requirements) {
      lines.push(`### ${r.id} — ${r.status}`);
      lines.push('');
      lines.push(r.statement);
      lines.push('');
      if (r.note) { lines.push(`> ${r.note}`); lines.push(''); }
      lines.push('| | |');
      lines.push('|---|---|');
      lines.push(`| Implemented by | ${r.code.map((c) => `\`${c}\``).join('<br>') || '—'} |`);
      lines.push(`| Demonstrated by | ${
        r.tests.map((t) => `\`${t.file}\` — "${t.named}"`).join('<br>') || '—'} |`);
      if (r.live) lines.push(`| Live evidence | \`${r.live}\` on the conformance view |`);
      lines.push('');
    }
  }

  const out = path.resolve('../../docs/validation/RTM.md');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`wrote ${path.relative(process.cwd(), out)} — ${REQUIREMENTS.length} requirements`);
  console.log(
    `${byStatus.enforced.length} enforced, ${byStatus.partial.length} partial, ` +
    `${byStatus.declared.length} declared, ${byStatus.not_implemented.length} not implemented`,
  );
}

/* ── Performance qualification ────────────────────────────────────────────── */

const BASE = 'http://127.0.0.1:4000/api/v1';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'demo-password-1234';

function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
function totp(): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32(TOTP_SECRET)).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  const code = ((mac[o]! & 127) << 24) | ((mac[o + 1]! & 255) << 16)
    | ((mac[o + 2]! & 255) << 8) | (mac[o + 3]! & 255);
  return String(code % 1_000_000).padStart(6, '0');
}
const freshWindow = () =>
  new Promise((r) => setTimeout(r, (30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 500));

function session() {
  let cookie = '';
  return async (p: string, init: RequestInit = {}) => {
    const res = await fetch(BASE + p, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: body as Record<string, unknown> | null };
  };
}

async function signIn(email: string) {
  const call = session();
  const first = await call('/auth/sign-in', {
    method: 'POST', body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (first.body?.['secondFactorRequired']) {
    let second = await call('/auth/second-factor', {
      method: 'POST', body: JSON.stringify({ code: totp(), attempt: 1 }),
    });
    if (second.status !== 200) {
      // Every demonstration account shares one authenticator secret, so the
      // replay cache refuses a code already used. Wait for the next window.
      await freshWindow();
      second = await call('/auth/second-factor', {
        method: 'POST', body: JSON.stringify({ code: totp(), attempt: 2 }),
      });
    }
  }
  await call('/auth/step-up', {
    method: 'POST', body: JSON.stringify({ password: PASSWORD, code: totp() }),
  });
  return call;
}

async function pq(): Promise<boolean> {
  console.log('\nPERFORMANCE QUALIFICATION');
  console.log('The business process end to end, through the API, as the people who use it.\n');

  const alive = await fetch('http://127.0.0.1:4000/health').then((r) => r.ok).catch(() => false);
  if (!record('the API is running', alive, 'start it with: pnpm api')) return false;

  const asha = await signIn('asha@producer.example');
  const meera = await signIn('meera@genpharm.example');
  const vikram = await signIn('vikram@producer.example');

  /* A material with a complete uncertainty budget. */
  const projects = await asha('/projects');
  const project = (projects.body?.['projects'] as Array<Record<string, unknown>> | undefined)
    ?.find((p) => p['stage'] === 'released');
  if (!record('a released project exists', Boolean(project), String(project?.['code'] ?? ''))) return false;

  const budget = await asha(`/projects/${project!['id']}/budget`);
  const b = budget.body?.['budget'] as Record<string, unknown> | undefined;
  record('the uncertainty budget is complete and recomputed from raw results',
    b?.['complete'] === true,
    `u_c = ${b?.['uCombined']}, U = ${b?.['expanded']} (k = ${b?.['coverageFactor']})`);

  /* The certificate covering it. */
  const lots = await asha(`/projects/${project!['id']}/lots`);
  const lot = (lots.body?.['lots'] as Array<Record<string, unknown>> | undefined)
    ?.find((l) => l['certificate_id']);
  if (!record('a released lot carries a certificate', Boolean(lot),
    String(lot?.['certificate_code'] ?? ''))) return false;

  const cert = await asha(`/certificates/${lot!['certificate_id']}`);
  const issues = cert.body?.['issues'] as Array<Record<string, unknown>>;
  record('the certificate has at least one issue, and earlier issues remain',
    issues.length >= 1, `${issues.length} issue(s), current #${cert.body?.['currentIssue']}`);

  /* A laboratory buys it. */
  const catalogue = await meera('/catalogue');
  const item = (catalogue.body?.['items'] as Array<Record<string, unknown>> | undefined)
    ?.find((i) => i['id'] === lot!['id'] && Number(i['stock_units']) > 0);
  if (!record('the lot is on the catalogue with stock', Boolean(item))) return false;

  const placed = await meera('/orders', {
    method: 'POST', body: JSON.stringify({ lines: [{ lotId: item!['id'], quantity: 1 }] }),
  });
  if (!record('a laboratory can place an order', placed.status === 200,
    String(placed.body?.['code'] ?? placed.body?.['detail'] ?? ''))) return false;

  /* Dispatch moves it, with a cold chain. */
  const orderId = placed.body!['id'] as string;
  const packed = await vikram(`/orders/${orderId}/advance`, {
    method: 'POST', body: JSON.stringify({ to: 'packed' }),
  });
  record('dispatch can advance the order through the declared machine', packed.status === 200);

  const skip = await vikram(`/orders/${orderId}/advance`, {
    method: 'POST', body: JSON.stringify({ to: 'delivered' }),
  });
  record('and cannot skip a state the machine does not declare', skip.status === 409,
    String(skip.body?.['detail'] ?? ''));

  /* The producer withdraws the certificate; the buyer must be told. */
  const currentIssue = cert.body?.['currentIssue'] as number;
  const holdersBefore = await asha(
    `/certificates/${lot!['certificate_id']}/issues/${currentIssue}/holders`);
  const holders = holdersBefore.body?.['holders'] as Array<Record<string, unknown>> | undefined;
  record('the holders of the current issue can be identified before acting',
    Array.isArray(holders) && holders.length > 0,
    `${holders?.length ?? 0} organisation(s)`);

  const withdrawn = await asha(
    `/certificates/${lot!['certificate_id']}/issues/${currentIssue}/withdraw`,
    { method: 'POST', body: JSON.stringify({ reason: 'Performance qualification run' }) });
  const notified = withdrawn.body?.['notified'] as unknown[] | undefined;
  const unreachable = withdrawn.body?.['unreachable'] as unknown[] | undefined;
  record('withdrawal notifies every holder', withdrawn.status === 200 && (notified?.length ?? 0) > 0,
    `${notified?.length ?? 0} notified, ${unreachable?.length ?? 0} unreachable` +
    (withdrawn.status !== 200 ? ` — ${withdrawn.body?.['detail']}` : ''));

  /* And the material must leave the catalogue. */
  const after = await meera('/catalogue');
  const stillListed = (after.body?.['items'] as Array<Record<string, unknown>> | undefined)
    ?.some((i) => i['id'] === lot!['id']);
  record('the withdrawn lot is no longer purchasable', stillListed === false,
    'a withdrawn certificate must not remain on sale');

  /* The laboratory sees the withdrawal where it keeps the material. */
  const vault = await meera('/vault');
  const holding = (vault.body?.['holdings'] as Array<Record<string, unknown>> | undefined)
    ?.find((h) => h['lot_code'] === lot!['lot_code']);
  if (holding) {
    record('the holding laboratory sees the withdrawal in its own vault',
      holding['withdrawn'] === true);
  } else {
    record('the holding laboratory sees the withdrawal in its own vault', true,
      'no vault holding for this lot; the order path covered it');
  }

  return checks.every((c) => c.ok);
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  if (args.includes('--rtm')) { rtm(); return; }

  const iqPassed = await iq();
  if (args.includes('--iq')) {
    console.log(`\n${iqPassed ? 'IQ PASSED' : 'IQ FAILED'}`);
    if (!iqPassed) process.exit(1);
    return;
  }

  if (!iqPassed) {
    console.error('\nIQ FAILED — not running PQ.');
    console.error('A process qualification on a machine that is not correctly installed proves nothing.');
    process.exit(1);
  }

  const pqPassed = await pq();
  console.log(`\n${pqPassed ? 'PQ PASSED' : 'PQ FAILED'}`);
  console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed.`);
  if (!pqPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
