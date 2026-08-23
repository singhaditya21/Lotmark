import fixture from './fixture.json';
import { DEMO_PASSWORD } from './constants';

/**
 * The console, with the API replaced by a recording.
 *
 * Every call the console makes goes through one function — `request()` in
 * lib/api.ts — so this is the only place the swap has to happen, and the real
 * path is left completely untouched when the flag is off.
 *
 * ── What this is honest about ───────────────────────────────────────────────
 *
 * The screens, the navigation, the validation, the guards and the signing
 * ceremony are the real product. Everything behind them is a JSON file captured
 * from a real run. Nothing is persisted; a reload is a fresh start.
 */

type Recorded = { status: number; body: unknown };
const RECORDING = fixture as unknown as Record<string, Recorded>;

/**
 * A mutable copy, so the demo can remember.
 *
 * The difference between a demo and a slideshow is whether creating something
 * changes what the next screen shows. Mutations are applied here and every
 * later GET reads from it.
 */
const state: Record<string, Recorded> = structuredClone(RECORDING);

/* ── Matching a real path back to the template it was captured under ───────── */

/**
 * `/projects/8f3a…/studies` has to find `GET /projects/:id/studies`.
 *
 * Segment count first, then a segment-by-segment comparison where a `:param`
 * matches anything. Templates are tried longest-literal-first so that a
 * specific capture beats a general one — `/admin/config/draft/:id/review` must
 * win over `/admin/config/:id` even though both have five segments.
 */
const TEMPLATES = Object.keys(RECORDING).filter((k) => !k.includes('|')).map((key) => {
  const [method, ...rest] = key.split(' ');
  const path = rest.join(' ');
  const parts = path.split('/');
  return {
    key, method: method!, parts,
    literals: parts.filter((p) => !p.startsWith(':')).length,
  };
}).sort((a, b) => b.literals - a.literals);

function match(method: string, path: string): string | null {
  const parts = path.split('/');
  for (const t of TEMPLATES) {
    if (t.method !== method || t.parts.length !== parts.length) continue;
    if (t.parts.every((p, i) => p.startsWith(':') || p === parts[i])) return t.key;
  }
  return null;
}

/** The signed-in person's copy of a recording, or the shared one. */
function read(key: string): Recorded | undefined {
  return (persona ? state[`${persona}|${key}`] : undefined) ?? state[key];
}

/* ── Session ──────────────────────────────────────────────────────────────── */

/**
 * The demo password, shown on the sign-in screen.
 *
 * Deliberately not the seed password, and deliberately visible: the point of a
 * public demo is that anyone can walk in. An EMPTY password is still refused,
 * because a login that accepts nothing reads as broken rather than open.
 */
export { DEMO_PASSWORD };

let signedIn = false;
let steppedUpUntil = 0;

/**
 * Who is signed in, because the sign-in screen promises it matters.
 *
 * That screen invites a viewer to try a bench scientist, a quality manager or a
 * customer "to see how the same screens change by role". Until this existed the
 * adapter ignored the address entirely and every account signed in as the
 * tenant administrator — the demo contradicting its own first screen, on the
 * feature the product leads with.
 *
 * Responses captured per persona are keyed `email|METHOD /path` and preferred
 * over the shared capture. Only the endpoints whose CONTENT actually differs
 * are captured that way; everything else falls through.
 */
let persona = '';

const SIGNING_WINDOW_MS = 15 * 60 * 1000;

/* ── Responding ───────────────────────────────────────────────────────────── */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

const problem = (status: number, code: string, detail: string): Response =>
  json({ type: 'about:blank', title: String(status), status, detail, code }, status);

/**
 * A pause before every write.
 *
 * Not decoration. The console has loading states, disabled buttons and
 * optimistic updates that are part of how the product feels, and an instant
 * response hides all of them — a recording made against a zero-latency backend
 * looks like a mockup precisely because nothing ever takes a moment.
 */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ids that look like the real ones, so nothing on screen says `id-3`. */
const newId = (): string => {
  const hex = '0123456789abcdef';
  const pick = (n: number) => Array.from({ length: n },
    () => hex[Math.floor(Math.random() * 16)]).join('');
  return `${pick(8)}-${pick(4)}-5${pick(3)}-b${pick(3)}-${pick(12)}`;
};

/** The first array-valued property of a recorded body — the API's envelopes vary. */
function listOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const found = Object.values(body as Record<string, unknown>).find(Array.isArray);
    return (found as unknown[] | undefined) ?? null;
  }
  return null;
}

/**
 * Apply a write to the in-memory copy.
 *
 * Generic on purpose. There are more than fifty mutating endpoints and hand
 * writing each one would be a second implementation of the product — one that
 * would drift from the first. Instead: prepend the submitted record to whatever
 * list the closest matching GET returns, so the thing the user just created is
 * at the top of the next screen, which is what they will point the camera at.
 */
function remember(path: string, payload: unknown): unknown {
  const created = {
    id: newId(),
    ...(payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}),
    created_at: new Date().toISOString(),
  };

  // The collection a POST to /projects/:id/studies belongs to is the GET of the
  // same path; for /studies/:id/sign it is the parent collection instead.
  const collection = match('GET', path)
    ?? match('GET', path.replace(/\/[^/]+$/, ''));
  if (collection) {
    const entry = state[collection];
    const list = listOf(entry?.body);
    if (entry && list) list.unshift(created);
  }
  return created;
}

/* ── The adapter ──────────────────────────────────────────────────────────── */

export async function demoFetch(path: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const payload = typeof init.body === 'string' && init.body
    ? JSON.parse(init.body) as unknown : null;
  const field = (k: string): string => {
    const v = (payload as Record<string, unknown> | null)?.[k];
    return typeof v === 'string' ? v : '';
  };

  /* — Authentication, which every recording starts with — */

  if (path === '/auth/sign-in') {
    await pause(220);
    const email = field('email').trim().toLowerCase();
    if (field('password').trim() === '') {
      return problem(401, 'invalid_credentials', 'Enter the demo password shown below.');
    }
    if (field('password') !== DEMO_PASSWORD) {
      return problem(401, 'invalid_credentials',
        `This is a demonstration. The password is “${DEMO_PASSWORD}”.`);
    }
    // Remembered now rather than at the second factor, because that step does
    // not carry the address.
    persona = email;
    // Second factor demanded, because skipping it would hide one of the few
    // things this product does that a viewer should notice it doing.
    return json({ secondFactorRequired: true });
  }

  if (path === '/auth/second-factor') {
    await pause(200);
    if (!/^\d{6}$/.test(field('code'))) {
      return problem(401, 'invalid_code', 'Six digits. In the demo, any six will do.');
    }
    signedIn = true;
    return json(read('GET /auth/me')?.body ?? {});
  }

  if (path === '/auth/step-up') {
    await pause(240);
    if (field('password') !== DEMO_PASSWORD || !/^\d{6}$/.test(field('code'))) {
      return problem(401, 'step_up_failed',
        `Password “${DEMO_PASSWORD}” and any six digits.`);
    }
    steppedUpUntil = Date.now() + SIGNING_WINDOW_MS;
    return json({ ok: true, until: new Date(steppedUpUntil).toISOString() });
  }

  if (path === '/auth/sign-out') {
    signedIn = false; steppedUpUntil = 0; persona = '';
    return json({ ok: true });
  }

  if (path === '/auth/me') {
    if (!signedIn) return problem(401, 'unauthenticated', 'Sign in to continue.');
    return json(read('GET /auth/me')?.body ?? {});
  }

  /* — Signing. The ceremony is the point, so the refusal has to be real — */

  if (method === 'POST' && /\/(sign|authorise|assign|publish|withdraw|reissue|transition)$/.test(path)) {
    if (Date.now() > steppedUpUntil) {
      return problem(401, 'step_up_required',
        'Confirm your identity before signing. This is 21 CFR 11 §11.200 — a signature '
        + 'needs a fresh authentication, not just a live session.');
    }
  }

  /* — Reads — */

  if (method === 'GET') {
    const key = match('GET', path);
    if (!key) return problem(404, 'not_found', `Nothing recorded for ${path}.`);
    const rec = read(key)!;
    return json(rec.body, rec.status);
  }

  /* — Writes — */

  await pause(160);

  /**
   * Configuration drafts, which the generic rule cannot serve.
   *
   * The two designers are the low-code story and the best thing in the product
   * to film, and they both hang off a draft. The console does not read the
   * draft's id from this response — it refetches `GET /admin/config` and takes
   * `draftId` from there. So creating one has to write that scalar, which no
   * amount of prepending-to-a-list will do. Discarding one has to clear it, or
   * the designer never returns to its opening screen.
   */
  const overview = state['GET /admin/config']?.body as
    { draftId: string | null; versions?: unknown[] } | undefined;

  if (method === 'POST' && path === '/admin/config/draft' && overview) {
    const id = newId();
    overview.draftId = id;
    overview.versions?.unshift({
      id, number: (overview.versions.length ?? 0) + 1, status: 'draft',
      reason: (payload as Record<string, unknown> | null)?.['changeReason'] ?? '',
      publishedAt: null, signed: false, changeCount: 0,
    });
    return json({ id, status: 'draft' });
  }

  if (method === 'DELETE' && /^\/admin\/config\/draft\/[^/]+$/.test(path) && overview) {
    overview.draftId = null;
    overview.versions = (overview.versions ?? []).filter(
      (v) => (v as Record<string, unknown>)['status'] !== 'draft');
    return json({ ok: true });
  }

  if (method === 'POST' && /^\/admin\/config\/draft\/[^/]+\/publish$/.test(path) && overview) {
    overview.draftId = null;
    for (const v of overview.versions ?? []) {
      const row = v as Record<string, unknown>;
      if (row['status'] === 'draft') {
        row['status'] = 'active';
        row['signed'] = true;
        row['publishedAt'] = new Date().toISOString();
      } else if (row['status'] === 'active') {
        row['status'] = 'superseded';
      }
    }
    return json({ ok: true, published: true });
  }

  const created = remember(path, payload);
  return json(created, 200);
}
