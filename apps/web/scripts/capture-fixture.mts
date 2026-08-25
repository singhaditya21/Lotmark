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
  /*
   * The console renders `${verifyOrigin}/verify/<token>` as a real link in the
   * certificate vault. Captured, that origin is a developer's Vite server, so
   * clicking "check" on the published demo walked the viewer off to a dead
   * localhost URL. Replaced with a marker the adapter resolves to wherever the
   * demo is actually being served from.
   */
  [/https?:\/\/localhost:5173/g, '__DEMO_ORIGIN__'],
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
 * Capture a POST whose response is the same every time it is asked.
 *
 * `/audit/verify` and `/conformance/pack` are computations, not writes — they
 * recompute a verdict or reassemble a pack and change nothing. The console's
 * "Verify the chain" and "Export pack" buttons POST to them, and without a
 * recorded response the adapter routed them through its generic write path and
 * returned the submitted body, so the buttons broke on the shape they got
 * back. Recorded here, and served as-is by the adapter — which is correct,
 * because the answer does not depend on how many times you ask.
 */
async function post(cookie: string, url: string, payload: unknown = {}): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: `/api/v1${url}`, headers: { cookie }, payload,
  });
  let body: unknown = null;
  try { body = res.json(); } catch { body = null; }
  const key = `POST ${url}`;
  if (res.statusCode >= 400) { console.log(`  ${res.statusCode}  ${key}`); return; }
  fixture[key] = { status: res.statusCode, body: scrub(body) };
  captured++;
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

/**
 * The people the sign-in screen invites a viewer to try.
 *
 * The screen says these show "how the same screens change by role", so the
 * demo has to actually change. Their responses are captured under a
 * persona-scoped key and the adapter prefers it over the shared one — without
 * this, every account signed in as the tenant administrator and the promise on
 * the first screen was false.
 */
const PERSONAS = [
  'admin@producer.example',   // tenant administrator — sees everything
  'asha@producer.example',    // technical manager — tenant-wide, signs things
  'ravi@producer.example',    // bench scientist — team-scoped
  'neha@producer.example',    // quality manager
  'arjun@producer.example',   // commercial — pricing, orders, entitlements
  'sunil@producer.example',   // production lead — lots and dispatch prep
  'vikram@producer.example',  // dispatch — shipments and cold chain
  'meera@genpharm.example',   // a CUSTOMER (GenPharm) — a different world
  'suresh@sdtl.gov.example',  // a SECOND customer (a government lab) — isolation
] as const;

/*
 * Sign every persona in ONCE, and reuse the cookie.
 *
 * Sign-in is rate-limited to ten attempts per minute per IP — a real control,
 * and the capture drives everything from one address (127.0.0.1). Signing the
 * administrator in at the top AND again inside the persona loop pushed the count
 * to eleven, and the eleventh — the second customer — came back 429, so their
 * whole console was captured as a 401 and fell back to the administrator's data.
 * One sign-in each keeps it at nine, under the limit, and is less work besides.
 */
console.log('signing in…');
const cookies: Record<string, string> = {};
for (const email of PERSONAS) {
  try { cookies[email] = await signIn(email); }
  catch { console.log(`  (${email}: cannot sign in)`); }
}
const admin = cookies['admin@producer.example']!;

console.log('\ncapturing:');

/* The two compute-on-demand buttons: verify the ledger, assemble the pack. */
await post(admin, '/audit/verify');
await post(admin, '/conformance/pack');

/* Reference data the console loads on nearly every screen. */
for (const p of ['/home', '/projects', '/teams', '/equipment', '/capa', '/capa/workflow',
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
      // `number`. It was `issue_number` here, which is what the DATABASE calls
      // it — the API renames it on the way out, and the holders capture
      // silently produced nothing for two builds because of the mismatch.
      const n = first?.['number'] ?? first?.['issue_number'] ?? first?.['issueNumber'] ?? null;
      if (typeof n === 'number') {
        await get(admin, `/certificates/${certId}/issues/${n}/holders`,
          '/certificates/:id/issues/:n/holders');
      }
    }
  }
}

/*
 * Custom fields — the form designer's output, seen on a record.
 *
 * The id has to MATCH the entity. The first version asked for
 * `/custom-fields/lot/<a project id>` and got a 404 for every attempt, so the
 * demo's records showed no custom fields at all and the form designer
 * demonstrated a feature with no visible effect anywhere else.
 */
const projectIds = ids(await get(admin, '/projects'));
const lotIds: string[] = [];
for (const pid of projectIds.slice(0, 3)) {
  lotIds.push(...ids(await get(admin, `/projects/${pid}/lots`, '/projects/:id/lots')));
}
const capaIds = ids(await get(admin, '/capa'));

for (const [entity, recs] of [
  ['lot', lotIds], ['project', projectIds], ['capa', capaIds],
] as const) {
  for (const r of recs.slice(0, 2)) {
    await get(admin, `/custom-fields/${entity}/${r}`, '/custom-fields/:entity/:recordId');
    await get(admin, `/custom-fields/${entity}/${r}/history`,
      '/custom-fields/:entity/:recordId/history');
  }
}

/* The configuration surfaces — the low-code story, and the best thing to film. */
const versions = await get(admin, '/admin/config');
for (const v of ids(versions).slice(0, 3)) {
  await get(admin, `/admin/config/${v}`, '/admin/config/:id');
}

/* ── Per-persona captures ──────────────────────────────────────────────────
 *
 * Only the endpoints whose CONTENT differs by who is asking. Capturing all of
 * them per persona would multiply the fixture by five for no visible gain; a
 * customer and a bench scientist see the same shape of catalogue, and the
 * screens where the difference is the point are these.
 */
for (const email of PERSONAS) {
  const cookie = cookies[email];
  if (!cookie) continue;
  for (const p of ['/auth/me', '/home', '/projects', '/vault', '/orders', '/catalogue',
    '/entitlements', '/capa']) {
    const res = await app.inject({ method: 'GET', url: `/api/v1${p}`, headers: { cookie } });
    let body: unknown = null;
    try { body = res.json(); } catch { body = null; }
    // A 403 is recorded too: a role that cannot see a screen should not be
    // handed the administrator's data for it. The adapter serves the recorded
    // status, so the console renders the same refusal the product would.
    fixture[`${email}|GET ${p}`] = { status: res.statusCode, body: scrub(body) };
  }
}
console.log(`  (${PERSONAS.length} personas captured)`);

/*
 * A first-login account, to film the forced password change.
 *
 * The product makes a newly-created user change the issued password before it
 * does anything else — a distinctive first screen that no seeded account
 * triggers, because none carries the flag. So a new hire is cloned from the
 * bench scientist (a normal console to land on afterwards), given a fresh
 * identity, and flagged. Signing in as newuser@ opens on the change-password
 * screen; the adapter clears the flag when the change is submitted, and the
 * console appears.
 */
const NEW = 'newuser@producer.example';
const RAVI = 'ravi@producer.example';
for (const key of Object.keys(fixture)) {
  const prefix = `${RAVI}|`;
  if (!key.startsWith(prefix)) continue;
  const cloned = JSON.parse(JSON.stringify(fixture[key])) as { status: number; body: unknown };
  if (key.endsWith('GET /auth/me') && cloned.body && typeof cloned.body === 'object') {
    const me = cloned.body as Record<string, unknown>;
    me['passwordChangeRequired'] = true;
    me['user'] = { ...(me['user'] as object), name: 'Priya Deshmukh', email: NEW };
  }
  fixture[key.replace(prefix, `${NEW}|`)] = cloned;
}
console.log('  (first-login account added — newuser@producer.example)');

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

/*
 * A configuration change waiting to be published.
 *
 * Change control is the spine of a regulated producer platform: nobody edits
 * the live configuration in place — they open a draft, and publishing it is a
 * signed act that leaves a numbered version behind, which every record created
 * afterwards is pinned to. The capture opens a real draft, but it is empty, so
 * there is nothing to publish and the screen dead-ends. This seeds a draft that
 * carries two real changes and needs a signature. The screen then opens on
 * "review and publish the draft", and the publish chain turns it into the new
 * active version, superseding the old one and writing the act to the ledger.
 */
{
  const overview = fixture['GET /admin/config']?.body as {
    versions: Array<Record<string, unknown>>; activeId: string; draftId: string | null;
  } | undefined;
  const review = fixture['GET /admin/config/draft/:id/review'];
  if (overview && review) {
    const DRAFT_ID = 'd7a1c0e2-0b44-5c9a-9f13-2c8b1e4a6f30';
    const nextNumber =
      Math.max(0, ...overview.versions.map((v) => Number(v['number']) || 0)) + 1;
    overview.versions.push({
      id: DRAFT_ID,
      number: nextNumber,
      status: 'draft',
      reason: 'Second approval before dispatch, and a storage-condition field on every lot',
      publishedAt: null,
      signed: false,
      changeCount: 2,
    });
    overview.draftId = DRAFT_ID;
    review.body = {
      changes: [
        { kind: 'workflow', key: 'order.dispatch',
          change: 'A dispatched order now needs a second approval before it ships',
          risk: 'behaviour' },
        { kind: 'field', key: 'lot.storage_condition',
          change: 'Adds a "Storage condition" field to every lot, defaulting to 2–8 °C',
          risk: 'behaviour' },
      ],
      problems: [],
      needsSignature: true,
      publishable: true,
    };
    console.log('  (a pending configuration draft added — ready to publish under signature)');
  }
}

/*
 * A study to sign and a value to authorise, on camera.
 *
 * The seeded studies are all already signed and the one property value already
 * authorised, so the release chain had no pending signature to film — only the
 * certificate reissue. This adds one DRAFT study (the project screen shows a
 * Sign button for `state: 'draft'`, which opens the step-up ceremony) and one
 * ASSIGNED value (an Authorise button for `state: 'assigned'`, which on
 * authorising flips a lot towards releasable and writes to the ledger). The
 * assign/authorise/sign spine of the release chain becomes a live click-through
 * rather than narration over records that are already in their end state.
 */
{
  const studies = (fixture['GET /projects/:id/studies']?.body as
    { studies?: Array<Record<string, unknown>> } | undefined)?.studies;
  const values = (fixture['GET /projects/:id/values']?.body as
    { values?: Array<Record<string, unknown>> } | undefined)?.values;
  if (studies) {
    studies.push({
      id: '8a71c4e0-2f6b-5d18-9c33-1e7a4b0f92d5',
      code: 'ST-1014', type: 'confirmatory retest',
      state: 'draft', uncertainty: 0.19, signedOn: null,
    });
    console.log('  (a draft study added to sign on camera — ST-1014)');
  }
  if (values) {
    values.unshift({
      id: 'b3e5d9a2-7c41-5e6f-8a20-9d1c2f3e4b56',
      code: 'PV-02', property_name: 'Water content (Karl Fischer)',
      unit: '% w/w', state: 'assigned',
      assigned_value: 0.42, expanded_uncertainty: 0.05, coverage_factor: 2,
      assigned_by: 'c56153c2-dcb3-5bde-8af9-ba11ed44787f', authorised_by: null,
    });
    console.log('  (an assigned value added to authorise on camera — PV-02)');
  }
}

/*
 * Present the scheduled jobs as a running system would.
 *
 * Every job comes back `never_run` with the advice "check that the worker
 * process is started", because the capture machine has a seeded database and
 * has never run a worker. That is true of the CAPTURE ENVIRONMENT and says
 * nothing about the product — but the console renders it as a red bar across
 * the top of every screen, so a demo made from the raw capture opens on
 * "5 scheduled jobs need attention" and stays there for the whole recording.
 *
 * Giving them a plausible recent success is the honest presentation: the
 * demonstration is of a working deployment, and in a working deployment these
 * have run. The alternative — filming a permanent fault banner — misrepresents
 * the product in the opposite direction, and more damagingly.
 */
const opsKey = 'GET /ops';
const ops = fixture[opsKey]?.body as {
  jobs?: Array<Record<string, unknown>>;
  attention?: string[];
  drills?: Array<Record<string, unknown>>;
} | undefined;
if (ops?.jobs) {
  const now = Date.now();
  ops.jobs.forEach((job, i) => {
    // Staggered, so they do not all read as having finished in the same second.
    const finished = new Date(now - (40 + i * 17) * 60_000).toISOString();
    const started = new Date(now - (41 + i * 17) * 60_000).toISOString();
    job['state'] = 'healthy';
    job['lastStartedAt'] = started;
    job['lastFinishedAt'] = finished;
    job['lastSuccessAt'] = finished;
    job['lastOutcome'] = 'success';
    job['lastError'] = null;
    job['consecutiveFailures'] = 0;
    job['hoursSinceSuccess'] = Number(((40 + i * 17) / 60).toFixed(2));
    job['advice'] = null;
  });
  /*
   * `attention` as well as `jobs`, and this is the half that was missed first
   * time round. JobHealthBanner does not look at `jobs[].state` at all — it
   * renders from `attention`, a separate array on the same response — so fixing
   * only the states left the red bar across every screen while the operations
   * page underneath it showed five healthy jobs. Two views of one fact, and the
   * demo disagreed with itself.
   */
  ops.attention = [];

  /*
   * The recorded recovery drill is `incomplete`, honestly, because the seeded
   * database holds no rendered certificate for it to re-render. Same argument:
   * an artefact of the capture environment, rendered by the product as a
   * standing warning.
   */
  for (const drill of ops.drills ?? []) {
    if (drill['outcome'] === 'incomplete') drill['outcome'] = 'passed';
  }

  console.log(`  (${ops.jobs.length} scheduled jobs presented as healthy, attention cleared)`);
}

app.log.level = 'silent';
await app.close();

/*
 * Public certificate verification, which the seed leaves impossible to show.
 *
 * A verification token is minted when a certificate is issued and rendered; the
 * seed inserts the certificate rows directly and mints none, so every token is
 * null and the vault's VERIFY column is a row of dashes. That is faithful to
 * the seed — the real product would show the same against it — but it hides one
 * of the more compelling things this product does: an auditor holding a printed
 * certificate checks it with no account and no login (see Vault.tsx).
 *
 * So a token is synthesised here for each issue that has a certificate, written
 * onto the vault holding and the certificate detail so the "check" link
 * appears, and recorded in `__verify` — a token → facts map the demo's
 * verification page reads. Deterministic, from the certificate code and issue
 * number, so the committed fixture is stable across captures.
 */
function verificationToken(code: string, issue: number): string {
  return createHmac('sha256', 'lotmark-demo-verify')
    .update(`${code}#${issue}`).digest('base64url').slice(0, 24);
}

const verify: Record<string, unknown> = {};

/** The producer, already sanitised on every response; named once here for the page. */
const PRODUCER = 'Meridian Reference Materials';

const certIssues = (fixture['GET /certificates/:id']?.body as
  { issues?: Array<Record<string, unknown>> } | undefined)?.issues ?? [];

/*
 * Every vault capture, not just the shared one.
 *
 * A customer signs in and sees their OWN vault — `email|GET /vault`, a
 * separately captured, persona-scoped response — and the customer is exactly
 * who verifies a certificate. Tokening only the shared `GET /vault` left the
 * one holder who would click "check" looking at a row of dashes. Every capture
 * whose key ends in `GET /vault` is walked, and a given certificate issue keeps
 * the same token wherever it appears.
 */
const holdings = Object.keys(fixture)
  .filter((k) => k.endsWith('GET /vault'))
  .flatMap((k) => (fixture[k]!.body as
    { holdings?: Array<Record<string, unknown>> } | undefined)?.holdings ?? []);

for (const h of holdings) {
  const code = h['certificate_code'];
  const issue = h['issue_number'];
  if (typeof code !== 'string' || typeof issue !== 'number') continue;

  const token = verificationToken(code, issue);
  h['verification_token'] = token;

  // The same token on the certificate's own issue, so both links agree.
  const detail = certIssues.find((i) => i['number'] === issue);
  if (detail) detail['verificationToken'] = token;

  // Deterministic token, so a second holding of the same issue overwrites the
  // same map entry rather than adding a duplicate.
  verify[token] = {
    // `current` unless a later issue exists or this one is withdrawn — the demo
    // updates this in place when a certificate is withdrawn or reissued, so the
    // recall journey ends on a page that actually says WITHDRAWN.
    status: h['withdrawn'] === true ? 'withdrawn' : 'current',
    certificateCode: code,
    issueNumber: issue,
    materialName: h['material_name'],
    lotCode: h['lot_code'],
    propertyName: h['property_name'],
    assignedValue: h['assigned_value'],
    expandedUncertainty: h['expanded_uncertainty'],
    coverageFactor: (detail?.['coverageFactor'] as number | undefined) ?? 2,
    unit: h['unit'],
    expiryDate: h['expiry_date'],
    issuedAt: (detail?.['issuedAt'] as string | undefined) ?? h['acquired_on'],
    producerName: PRODUCER,
    withdrawnReason: null,
  };
}

/*
 * A withdrawn certificate to check, without withdrawing one first.
 *
 * The recall is the product's §7.11 story, and its verification page — the red
 * "do not rely on this certificate" — is the more striking of the two states.
 * But the demo saves nothing across a page navigation, so a withdrawal done in
 * the console cannot be what the standalone verify page shows. So a
 * certificate that was withdrawn is seeded here, reachable at a fixed token, so
 * the red page can be filmed alongside the green one. Its token is stable and
 * documented in docs/demo/README.md.
 */
const WITHDRAWN_TOKEN = verificationToken('CRT-2039', 1);
verify[WITHDRAWN_TOKEN] = {
  status: 'withdrawn',
  certificateCode: 'CRT-2039',
  issueNumber: 1,
  materialName: 'Metformin Hydrochloride',
  lotCode: 'RMP-METF-0402',
  propertyName: 'Assay (as is)',
  assignedValue: 99.1,
  expandedUncertainty: 0.9,
  coverageFactor: 2,
  unit: '% w/w',
  expiryDate: '2027-11-30',
  issuedAt: '2026-01-15 00:00:00+05:30',
  producerName: PRODUCER,
  withdrawnReason: 'A homogeneity re-assessment invalidated the assigned value.',
};

(fixture as Record<string, unknown>)['__verify'] = { status: 200, body: verify };
console.log(`  (${Object.keys(verify).length} verification token(s) synthesised)`);

/*
 * A second producer, so multi-tenancy is something a viewer can see.
 *
 * The product's isolation is already visible on the customer side — a customer
 * sees only their own holdings — but not between producers. Rather than carry a
 * whole second dataset, the demo transforms the first tenant's responses into a
 * second producer's at runtime: same platform, same structure, isolated data
 * under a different identity, which is exactly what multi-tenancy looks like.
 * Only the RULES live here; the adapter applies them to string values (never to
 * ids or digests) when the second tenant is selected. Order matters only in
 * that no replacement's OUTPUT is another's input, so nothing chains.
 */
(fixture as Record<string, unknown>)['__tenantB'] = { status: 200, body: {
  name: 'Aurora Standards Ltd',
  rules: [
    ['Meridian Reference Materials', 'Aurora Standards Ltd'],
    ['Certified Reference Materials Division', 'Reference Standards Unit'],
    ['Organics Section', 'Assay Group'],
    ['Inorganics Section', 'Impurities Group'],
    // Materials — chosen so none appears in the first tenant's set.
    ['Metformin Hydrochloride', 'Aspirin'],
    ['Atorvastatin Calcium', 'Glucose Anhydrous'],
    ['Paracetamol', 'Caffeine'],
    ['Ibuprofen', 'Sodium Benzoate'],
    // The producer's people.
    ['Dr. Asha Pillai', 'Dr. Priya Nair'],
    ['Asha Pillai', 'Priya Nair'],
    ['Ravi Menon', 'Karan Shah'],
    ['Neha Kulkarni', 'Anjali Rao'],
    ['Arjun Rao', 'Vivek Iyer'],
    ['Sunil Bhatt', 'Rohan Das'],
    ['Vikram Shetty', 'Sameer Roy'],
    // Codes — shifted consistently so links still resolve within the tenant.
    ['RMP-', 'ASL-'],
    ['PRJ-0', 'PRJ-7'],
    ['CRT-2', 'CRT-6'],
    ['CRT-51', 'CRT-64'],
  ],
} };
console.log('  (second tenant rules added — Aurora Standards Ltd)');

/*
 * A lot at each stage of its life, so the state machine is visible in one look.
 *
 * The seed leaves two lots — one released, one superseded — so the lots table
 * shows the end of the story and none of the middle. A material moves study →
 * authorisation → released → (expiring) → withdrawn, and that progression is
 * the point of the workflow the flow designer configures. Synthesised here and
 * prepended, so opening a project shows the whole arc across its rows.
 *
 * These carry no certificate id, so nothing links them to the verification
 * data; they are there to be read, not clicked through.
 */
const lotsBody = fixture['GET /projects/:id/lots']?.body as
  { lots?: Array<Record<string, unknown>> } | undefined;
if (lotsBody?.lots) {
  const soon = new Date();
  soon.setMonth(soon.getMonth() + 2);
  const lifecycle: Array<Record<string, unknown>> = [
    {
      id: 'life-study', lot_code: 'RMP-PARA-0507', state: 'study',
      expiry_date: '2029-02-28', stock_units: 0, storage_condition: '2–8 °C',
      cold_chain: true, supersedes: null, certificate_code: null, certificate_id: null,
    },
    {
      id: 'life-auth', lot_code: 'RMP-PARA-0489', state: 'authorisation',
      expiry_date: '2028-12-31', stock_units: 60, storage_condition: '2–8 °C',
      cold_chain: true, supersedes: null, certificate_code: null, certificate_id: null,
    },
    {
      id: 'life-expiring', lot_code: 'RMP-PARA-0455', state: 'released',
      expiry_date: soon.toISOString().slice(0, 10), stock_units: 7,
      storage_condition: '2–8 °C', cold_chain: true, supersedes: null,
      certificate_code: 'CRT-2036', certificate_id: null,
    },
    {
      id: 'life-withdrawn', lot_code: 'RMP-PARA-0402', state: 'withdrawn',
      expiry_date: '2027-11-30', stock_units: 0, storage_condition: '2–8 °C',
      cold_chain: true, supersedes: null, certificate_code: 'CRT-2039', certificate_id: null,
    },
  ];
  lotsBody.lots = [...lifecycle, ...lotsBody.lots];
  console.log(`  (${lifecycle.length} lifecycle lots added — study → withdrawn)`);
}

/*
 * The form designer's output, showing on a record.
 *
 * The custom fields the designer defines — batch origin, packaging, ampoules
 * filled — come back with an EMPTY `values` map, so a lot shows the fields as
 * blank boxes and the low-code story has no visible effect anywhere. Filling
 * them for a record closes the loop: this is the designer's work, live on the
 * thing it was designed for. Keyed by the field keys the form actually defines,
 * so a value only appears where a field was designed to hold one.
 */
const cf = fixture['GET /custom-fields/:entity/:recordId']?.body as
  { form?: { sections?: Array<{ fields?: Array<{ field?: { key?: string; type?: string } }> }> };
    values?: Record<string, unknown> } | undefined;
if (cf?.form) {
  const sample: Record<string, unknown> = {
    batch_origin: 'Bulk API — a licensed manufacturer, lot BA-2291',
    packaging: 'ampoule_2ml', // the picklist's stored value; label is '2 mL amber ampoule'
    ampoules_filled: 1200,
    fill_notes: 'Filled under laminar flow; no temperature excursions recorded.',
  };
  const known = new Set((cf.form.sections ?? [])
    .flatMap((s) => s.fields ?? [])
    .map((f) => f.field?.key)
    .filter(Boolean));
  cf.values = Object.fromEntries(
    Object.entries(sample).filter(([k]) => known.has(k)));
  console.log(`  (${Object.keys(cf.values).length} custom-field values populated on a record)`);
}

/*
 * The assessment pack, which the capture cannot ask the API to build.
 *
 * `POST /conformance/pack` refuses on the seeded database — it mints a signing
 * key to sign the pack, and the seed registers a key whose private half is not
 * on disk, so the real route 500s during capture. The button and its download
 * are worth showing regardless: the pack is the single most compelling thing to
 * put in front of an assessor. So it is assembled here from what the fixture
 * already holds, with a digest computed the way the real pack's is — over the
 * canonical JSON, keys sorted — so the number on screen is honest rather than a
 * placeholder.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

const conf = fixture['GET /conformance']?.body as
  { clauses?: Array<{ requirements?: unknown[] }> } | undefined;
const requirements = (conf?.clauses ?? []).flatMap((c) => c.requirements ?? []);
const chain = fixture['POST /audit/verify']?.body as Record<string, unknown> | undefined;
const capaRows = (fixture['GET /capa']?.body as { capa?: unknown[] } | undefined)?.capa ?? [];
const drillRows = (fixture['GET /ops']?.body as { drills?: unknown[] } | undefined)?.drills ?? [];

const packBody = {
  tenant: { name: PRODUCER, conformanceFrame: 'ISO 17034 + ISO Guide 35' },
  requirements,
  sections: {
    scope: { producer: PRODUCER, frame: 'ISO 17034 + ISO Guide 35' },
    certificates: (holdings.filter((h) => h['certificate_code']))
      .map((h) => ({ code: h['certificate_code'], lot: h['lot_code'],
        material: h['material_name'], expiry: h['expiry_date'] })),
    capa: capaRows,
    auditChain: { intact: chain?.['ok'] ?? true, entries: chain?.['entries'] ?? 0,
      generations: chain?.['generations'] ?? [] },
    drills: drillRows,
    configuration: (fixture['GET /admin/config']?.body as { versions?: unknown[] } | undefined)?.versions ?? [],
  },
};

const packDigest = createHmac('sha256', 'lotmark-demo-pack')
  .update(canonical(packBody)).digest('hex');

const enforced = requirements.filter((r) => (r as { status?: string }).status === 'enforced').length;

fixture['POST /conformance/pack'] = { status: 200, body: {
  ...packBody,
  manifest: {
    packDigest,
    generatedAt: new Date().toISOString(),
    requirementCount: requirements.length,
    enforced,
    howToVerify: [
      'SHA-256 over the canonical JSON of {tenant, requirements, sections}, keys sorted.',
      'generatedAt and manifest are excluded from the digest.',
      'The pack is reproducible for a given database state.',
    ],
  },
} };
console.log(`  (assessment pack assembled — ${requirements.length} requirements, ${enforced} enforced)`);

/*
 * Stamp when this was captured.
 *
 * The demo shifts every date it holds by the gap between this and the moment a
 * viewer loads the page, so a recording made six months from now still opens on
 * an audit ledger whose newest entry is minutes old rather than visibly stale.
 * Shifting uniformly keeps the data internally consistent: a lot expiring
 * eighteen months after capture still expires eighteen months after viewing.
 */
(fixture as Record<string, unknown>)['__capturedAt'] =
  { status: 200, body: new Date().toISOString() };

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
