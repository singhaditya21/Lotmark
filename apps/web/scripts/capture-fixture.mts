#!/usr/bin/env tsx
/**
 * Record the real API's responses so the console can run without one.
 *
 * ── Why capture rather than hand-write ──────────────────────────────────────
 *
 * A hand-written fixture drifts from the real response shapes, and the drift
 * shows up as a blank screen while somebody is recording video. This drives the
 * actual Fastify app through `inject` — the same code path a browser takes,
 * including auth, row-level security and every guard — and writes down what
 * comes back. The shapes are then correct by construction rather than by care.
 *
 * `inject` rather than a listening server because the console's session is a
 * cookie and following it through a real socket adds a port, a race and a
 * process to clean up, for nothing. `inject` returns the Set-Cookie header and
 * hands it back on the next call.
 *
 * ── Sanitisation is not optional ────────────────────────────────────────────
 *
 * The seeded database names a real prospective client. The demo is published to
 * a world-readable URL and recorded on video, so the producer identity is
 * replaced here, at capture time, on the PARSED JSON — key by key, never with a
 * blind string replace over the serialised blob, because a blind replace
 * corrupts any id or digest that happens to contain the pattern.
 *
 * Run: NODE_ENV=development pnpm --filter @lotmark/web capture
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src', 'demo', 'fixture.json');

const PASSWORD = 'demo-password-1234';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/* ── The identity swap ─────────────────────────────────────────────────────── */

/**
 * Ordered, and longest-first where one term contains another.
 *
 * 'Indian Pharmacopoeia Commission' must be replaced before a bare 'IPC' rule
 * could fire inside it, or the result is a half-substituted string that reads
 * worse than either original.
 */
const SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Indian Pharmacopoeia Commission/g, 'Meridian Reference Materials'],
  [/Pharmacopoeial Standards Division/g, 'Certified Reference Materials Division'],
  [/ISO 17034 \+ GIGW 3\.0 \+ DPDP/g, 'ISO 17034 + ISO Guide 35'],
  [/\bIPRS\b/g, 'MRM'],
  [/\bt-ipc\b/g, 't-meridian'],
  [/\bIPC\b/g, 'Meridian'],
  [/\bipc\b/g, 'meridian'],
  // A real NTP host, and one that names the country's national informatics
  // centre. Harmless in itself, and it puts the deployment's context on screen.
  [/nic\.ntp\.gov\.in/g, 'time.example.org'],
  [/\bNIC\b/gi, 'the national cloud'],
  [/\bMeitY\b/g, 'the ministry'],
  [/\bGIGW[^,.;)\]]*/g, 'accessibility'],
  [/\bSTQC[^,.;)\]]*/g, 'security certification'],
  [/\bPvPI\b/g, 'pharmacovigilance'],
  [/\bOpenCart\b/g, 'the legacy storefront'],
  [/demo1234/g, 'demo-viewer'],
  [/demo-password-1234/g, 'demo-viewer'],
];

const scrubString = (s: string): string =>
  SUBSTITUTIONS.reduce((acc, [from, to]) => acc.replace(from, to), s);

/**
 * Walks the parsed value. Object KEYS are left alone deliberately — they are
 * the API's contract with the console, and rewriting one would break the very
 * screens this fixture exists to render.
 */
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

/* ── TOTP, the same six digits the console's user would read off a phone ───── */

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

function currentTotp(): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32(TOTP_SECRET)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16)
    | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/* ── Capture ───────────────────────────────────────────────────────────────── */

const app = await buildApp({ NODE_ENV: 'development' });
await app.ready();

const fixture: Record<string, { status: number; body: unknown }> = {};
const seen = new Set<string>();
let captured = 0;
let failed = 0;

async function signIn(email: string): Promise<string> {
  const first = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: PASSWORD },
  });
  const raw = first.headers['set-cookie'];
  let cookie = (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
  if (first.json<{ secondFactorRequired?: boolean }>().secondFactorRequired) {
    const second = await app.inject({
      method: 'POST', url: '/api/v1/auth/second-factor',
      headers: { cookie }, payload: { code: currentTotp(), attempt: 1 },
    });
    const rotated = second.headers['set-cookie'];
    if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  }
  return cookie;
}

/**
 * Record one GET.
 *
 * `template` is the key the adapter will match on — the path with its ids put
 * back as `:params`. The demo resolves `/projects/<a real uuid>` by falling
 * back to the template, so one capture serves every id the console might ask
 * for. That is deliberate: a demo where only the first project opens is worse
 * than one where every project opens the same project.
 */
async function get(cookie: string, url: string, template = url): Promise<unknown> {
  const key = `GET ${template}`;
  const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });
  let body: unknown = null;
  try { body = res.json(); } catch { body = null; }
  if (res.statusCode >= 400) {
    failed++;
    if (!seen.has(key)) console.log(`  ${res.statusCode}  ${key}`);
  } else if (!seen.has(key)) {
    captured++;
  }
  seen.add(key);

  /*
   * Keep the RICHEST response for a template, not the last one.
   *
   * Several projects share the key `/projects/:id/values`, and the seed does not
   * give all of them values. Last-write-wins produced a demo whose project
   * detail opened onto three empty tabs — technically a faithful capture of the
   * fourth project, and useless to film.
   */
  const weight = (v: unknown): number => JSON.stringify(v ?? null).length;
  const existing = fixture[key];
  if (!existing || res.statusCode < 400 && weight(body) > weight(existing.body)) {
    fixture[key] = { status: res.statusCode, body: scrub(body) };
  }
  return body;
}

/**
 * Pull ids out of a list response.
 *
 * The API is not uniform about its envelope — `/projects` answers
 * `{projects: [...], scope: ...}`, others answer a bare array, others `{items}`.
 * Rather than encode each shape, take the first array-valued property. Guessing
 * wrong here is silent: the capture simply skips every detail endpoint and the
 * demo comes out with list screens that open onto nothing.
 */
const ids = (v: unknown, key = 'id'): string[] => {
  const list = Array.isArray(v) ? v
    : (v && typeof v === 'object')
      ? (Object.values(v as Record<string, unknown>).find(Array.isArray) as unknown[] ?? [])
      : [];
  return list.flatMap((r) => {
    const id = (r as Record<string, unknown> | null)?.[key];
    return typeof id === 'string' ? [id] : [];
  });
};

console.log('signing in…');
const asha = await signIn('asha@producer.example');
const admin = await signIn('admin@producer.example');

console.log('\ncapturing:');

/* Shell and identity. Captured for BOTH sessions; the admin one wins, because
 * the demo signs a viewer in with the widest role so every screen is reachable. */
await get(asha, '/auth/me');
await get(admin, '/auth/me');

/* Reference data the console loads on nearly every screen. */
for (const p of ['/projects', '/teams', '/equipment', '/capa', '/capa/workflow',
  '/audit', '/ops', '/conformance', '/catalogue', '/orders', '/entitlements',
  '/vault', '/admin/people', '/admin/config']) {
  await get(admin, p);
}

/* Per-project detail. The console opens one project at a time; capture the
 * first few so the list is not a wall of identical rows on camera. */
const projects = ids(await get(admin, '/projects'));
for (const id of projects.slice(0, 4)) {
  for (const sub of ['studies', 'values', 'lots', 'budget']) {
    await get(admin, `/projects/${id}/${sub}`, `/projects/:id/${sub}`);
  }
}

/* Certificates, reached from a lot. */
for (const id of projects.slice(0, 2)) {
  const lots = await get(admin, `/projects/${id}/lots`, '/projects/:id/lots');
  const lotRows = Array.isArray(lots) ? lots
    : (lots && typeof lots === 'object')
      ? (Object.values(lots as Record<string, unknown>).find(Array.isArray) as unknown[] ?? [])
      : [];
  for (const lot of lotRows.slice(0, 3)) {
    const certId = (lot as Record<string, unknown>)['certificate_id'];
    if (typeof certId === 'string') {
      const cert = await get(admin, `/certificates/${certId}`, '/certificates/:id');
      const issues = (cert as Record<string, unknown> | null)?.['issues'];
      const first = Array.isArray(issues) && issues.length > 0
        ? issues[0] as Record<string, unknown> : null;
      const n = first?.['issue_number'] ?? first?.['issueNumber'] ?? null;
      if (typeof n === 'number') {
        await get(admin, `/certificates/${certId}/issues/${n}/holders`,
          '/certificates/:id/issues/:n/holders');
      }
    }
  }
}

/* Custom fields, for whichever entities the seed actually configures. */
for (const [entity, list] of [['lot', '/projects'], ['project', '/projects']] as const) {
  const recs = ids(await get(admin, list));
  for (const r of recs.slice(0, 2)) {
    await get(admin, `/custom-fields/${entity}/${r}`, `/custom-fields/:entity/:recordId`);
    await get(admin, `/custom-fields/${entity}/${r}/history`,
      `/custom-fields/:entity/:recordId/history`);
  }
}

/* The configuration surfaces — the low-code story, and the best thing to film. */
const versions = await get(admin, '/admin/config');
for (const v of ids(versions).slice(0, 3)) {
  await get(admin, `/admin/config/${v}`, '/admin/config/:id');
}

/*
 * The two designers, which is where the low-code story lives.
 *
 * Their screens hang off a DRAFT configuration version, so there is nothing to
 * capture until one exists. Open a real draft, record what the designers read
 * from it, then discard it — the demo needs the shapes, not the row, and
 * leaving a draft behind would break the next capture (one draft per tenant).
 */
const draftRes = await app.inject({
  method: 'POST', url: '/api/v1/admin/config/draft',
  headers: { cookie: admin },
  payload: { changeReason: 'Captured to record the designer screens' },
});
const draftId = draftRes.statusCode < 400
  ? (draftRes.json() as { id?: string }).id ?? null : null;

if (draftId) {
  await get(admin, `/admin/config/draft/${draftId}/review`,
    '/admin/config/draft/:id/review');
  await get(admin, `/admin/config/draft/${draftId}/workflows`,
    '/admin/config/draft/:id/workflows');
  for (const entity of ['lot', 'project', 'study', 'capa']) {
    await get(admin, `/admin/config/draft/${draftId}/form/${entity}`,
      '/admin/config/draft/:id/form/:entity');
  }
  await app.inject({
    method: 'DELETE', url: `/api/v1/admin/config/draft/${draftId}`,
    headers: { cookie: admin },
  });
  console.log('  (draft opened, captured and discarded)');
} else {
  console.log(`  could not open a draft (${draftRes.statusCode}) — the designer`);
  console.log('  screens will 404 in the demo. Check for a draft left behind.');
}

app.log.level = 'silent';
await app.close();

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture, null, 2));

/* ── Report, and refuse to ship a fixture that still names the client ──────── */

const serialised = JSON.stringify(fixture);
const FORBIDDEN = ['Indian Pharmacopoeia', 'IPC', 't-ipc', 'IPRS', 'NIC', 'MeitY',
  'STQC', 'GIGW', 'OpenCart', 'PvPI', 'demo1234', 'demo-password-1234', 'crore', 'lakh'];
const hits = FORBIDDEN.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(serialised));

console.log(`\n${captured} endpoint(s) captured, ${failed} refused, ${Object.keys(fixture).length} keys`);
console.log(`written to ${path.relative(process.cwd(), OUT)}`);

if (hits.length > 0) {
  console.error(`\nREFUSING: the fixture still contains ${hits.join(', ')}.`);
  console.error('Fix the substitution table above — do not edit the JSON by hand, or the');
  console.error('next capture puts it back.');
  process.exit(1);
}
console.log('no forbidden term survives in the fixture.');
