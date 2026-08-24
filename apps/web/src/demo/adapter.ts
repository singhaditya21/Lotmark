import fixture from './fixture.json';
import { DEMO_PASSWORD } from './constants';
import { rebase, deltaFrom } from './rebase';
import { matchChain, type Ctx } from './chains';

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
 * A fresh, hydrated copy of the recording.
 *
 * Rebasing (dates shifted forward to now) and origin resolution are applied
 * here rather than per request — the fixture is hundreds of keys and re-walking
 * it on every read would be silly. Extracted into a function, and not inlined,
 * so `resetData()` can build a clean copy for a re-take without a page reload.
 */
function hydrate(): Record<string, Recorded> {
  const s = structuredClone(RECORDING);

  /*
   * Move every recorded date forward by the gap since capture, so a demo filmed
   * months from now still opens on a ledger whose newest entry is minutes old.
   * See ./rebase.ts for why the shift is uniform.
   */
  const delta = deltaFrom((RECORDING['__capturedAt'] as unknown as { body?: unknown })?.body);
  if (delta !== 0) {
    for (const key of Object.keys(s)) {
      if (key === '__capturedAt') continue;
      s[key]!.body = rebase(s[key]!.body, delta);
    }
  }

  /*
   * Guarded, because this module is also loaded by its own tests under node,
   * where there is no window. Falling back to the marker's own text leaves the
   * link inert rather than throwing on import and taking every assertion with it.
   */
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const here = `${origin}${import.meta.env.BASE_URL ?? '/'}`.replace(/\/$/, '');
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/__DEMO_ORIGIN__/g, here);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fix(x)]));
    }
    return v;
  };
  for (const key of Object.keys(s)) s[key]!.body = fix(s[key]!.body);
  return s;
}

/**
 * The demo's memory. `let`, not `const`, so a reset can replace it wholesale —
 * every helper reads this binding by name, so they all see the new copy.
 */
let state: Record<string, Recorded> = hydrate();

/**
 * Throw away everything done this session and start from the recording.
 *
 * For a re-take mid-recording: signed in, on the same screen, but the data
 * unwound — the study unsigned again, the ledger back to where it was captured.
 * The session (who is signed in, whether they have stepped up) is deliberately
 * kept, so the operator does not re-do the login between takes. The caller
 * clears the query cache so every screen refetches from the fresh copy.
 */
export function resetData(): void {
  state = hydrate();
}

/* ── A second producer, projected from the first ──────────────────────────── */

/**
 * Which producer tenant the console is showing. `A` is the recorded one; `B`
 * projects it into a second producer at the response boundary — see the rules
 * in the capture. A projection, not a copy: mutations still land on A's stored
 * state, and B is what a reader sees over it.
 */
let demoTenant: 'A' | 'B' = 'A';

const tenantRules = (): Array<[string, string]> =>
  ((state['__tenantB']?.body as { rules?: Array<[string, string]> } | undefined)?.rules) ?? [];

/** Rewrite string VALUES only — ids and digests carry none of these words. */
function toTenantB(value: unknown): unknown {
  if (typeof value === 'string') {
    return tenantRules().reduce((s, [from, to]) => s.split(from).join(to), value);
  }
  if (Array.isArray(value)) return value.map(toTenantB);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toTenantB(v)]));
  }
  return value;
}

/** The identity being shown, for the demo bar. */
export function tenantName(): string {
  return demoTenant === 'B'
    ? String((state['__tenantB']?.body as { name?: string } | undefined)?.name ?? 'Tenant B')
    : 'Meridian Reference Materials';
}

/** Switch producer tenant. The caller resets the query cache to refetch. */
export function switchTenant(): 'A' | 'B' {
  demoTenant = demoTenant === 'A' ? 'B' : 'A';
  return demoTenant;
}

/** Project a response into the current tenant. A no-op for tenant A. */
function forTenant(body: unknown): unknown {
  return demoTenant === 'B' ? toTenantB(body) : body;
}

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

/**
 * Which writes demand a fresh signing window, and which do not.
 *
 * The genuine signature acts — signing a study, assigning or authorising a
 * value, publishing configuration, reissuing or withdrawing a certificate —
 * always do: each goes through the real product's signing path.
 *
 * A workflow TRANSITION is different, and getting it wrong is what this
 * function exists to prevent. Whether a move needs a signature is a property of
 * the move, set per-transition in the configuration — the product enforces
 * `requiresSignature` FROM the transition, not from a blanket rule. The seeded
 * CAPA workflow requires the `capa:manage` permission on every move and a
 * signature on none, so guarding all of them unconditionally made the demo
 * refuse a CAPA progression that the real product completes without ceremony —
 * a §11.200 wall where there is none. So a transition is consulted against the
 * captured workflow, and only a move that actually sets `requiresSignature`
 * asks for one.
 */
function needsStepUp(path: string, payload: Record<string, unknown> | null): boolean {
  if (/\/(sign|authorise|assign|publish|withdraw|reissue)$/.test(path)) return true;

  const capa = /^\/capa\/([^/]+)\/transition$/.exec(path);
  if (capa) {
    const from = (listOf(read('GET /capa')?.body) ?? [])
      .find((c) => (c as Record<string, unknown>)['id'] === capa[1]) as
      Record<string, unknown> | undefined;
    const to = payload?.['to'] ?? payload?.['toState'];
    const moves = (read('GET /capa/workflow')?.body as
      { transitions?: Array<Record<string, unknown>> } | undefined)?.transitions ?? [];
    const move = moves.find((m) => m['from'] === from?.['state'] && m['to'] === to);
    // Default to demanding it: an unknown move is safer refused than waved
    // through, and it keeps a mislabelled fixture from quietly dropping the
    // ceremony.
    return move ? move['requiresSignature'] === true : true;
  }

  return false;
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

/** The signed-in person's display name, for the audit trail's actor column. */
function actorLabel(): string {
  const me = (persona ? state[`${persona}|GET /auth/me`] : undefined) ?? state['GET /auth/me'];
  const user = (me?.body as { user?: { name?: string } } | undefined)?.user;
  return user?.name ?? 'Demonstration user';
}

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

export async function demoFetch(rawPath: string, init: RequestInit): Promise<Response> {
  /**
   * Drop the query string before matching.
   *
   * The audit ledger asks for `/audit?limit=200`, and `match()` compares path
   * SEGMENTS — so the last segment was `audit?limit=200`, which matches nothing
   * recorded, and the most data-rich screen in the demo rendered empty while
   * the fixture held sixty-two entries. It failed silently, as a 404 on a list
   * endpoint does: an empty table looks like a quiet day rather than a fault.
   *
   * Recorded under the bare path, because the demo has one recording per
   * endpoint and a limit it cannot honour anyway.
   */
  const path = rawPath.split('?')[0]!;

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
    return json(forTenant(read('GET /auth/me')?.body ?? {}));
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

  if (path === '/auth/password') {
    await pause(200);
    /*
     * Clear the forced-change flag on the signed-in person's own /auth/me, so
     * the next refetch drops the change screen and the console appears. This is
     * what makes the first-login journey complete rather than loop.
     */
    const me = read('GET /auth/me')?.body as { passwordChangeRequired?: boolean } | undefined;
    if (me) me.passwordChangeRequired = false;
    return json({ changed: true, otherSessionsEnded: 0 });
  }

  if (path === '/auth/me') {
    if (!signedIn) return problem(401, 'unauthenticated', 'Sign in to continue.');
    return json(forTenant(read('GET /auth/me')?.body ?? {}));
  }

  /* — Signing. The ceremony is the point, so the refusal has to be real — */

  if (method === 'POST'
      && needsStepUp(path, payload as Record<string, unknown> | null)
      && Date.now() > steppedUpUntil) {
    return problem(401, 'step_up_required',
      'Confirm your identity before signing. This is 21 CFR 11 §11.200 — a signature '
      + 'needs a fresh authentication, not just a live session.');
  }

  /* — Reads — */

  if (method === 'GET') {
    const key = match('GET', path);
    if (!key) return problem(404, 'not_found', `Nothing recorded for ${path}.`);
    const rec = read(key)!;
    return json(forTenant(rec.body), rec.status);
  }

  /* — Writes — */

  await pause(160);

  /**
   * A POST that only computes — verify the chain, assemble the pack.
   *
   * These change nothing and return the same thing every time, so a recorded
   * response is the whole answer. Served before the write paths below, which
   * would otherwise route them through `remember()` and hand the button back the
   * body it submitted — which is not the shape it asked for, and how both broke.
   */
  const recorded = state[`POST ${path}`];
  if (recorded) return json(forTenant(recorded.body), recorded.status);

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

  /*
   * Publishing a draft is NOT handled here. It returns the exact shape the
   * screen reads back — `{ number, changes, signed }` — and writes the act to
   * the ledger, which is a chain's job, not a scalar poke. See the
   * `POST /admin/config/draft/:id/publish` chain in ./chains.ts.
   */

  /**
   * A write that changes what the next screen shows.
   *
   * `remember()` alone puts the new row at the top of a list, which is enough
   * for a screenshot. What sells this product is the trace: sign a study and it
   * reads `signed`, withdraw a certificate and its holders are marked notified,
   * and every one of those acts appears in the audit ledger seconds later under
   * the person who did it. See ./chains.ts.
   */
  const ctx: Ctx = {
    // Persona-aware, so a chain mutates the SAME body a signed-in persona
    // reads. Once some screens were captured per persona (a producer role sees
    // its own CAPA list), a chain writing to the shared copy while the reader
    // took the persona-scoped one meant the move never showed. `read()` is the
    // one lookup that resolves persona-scoped first, then shared.
    body: (key) => read(key)?.body,
    list: (key) => listOf(read(key)?.body) as Array<Record<string, unknown>> | null,
    actor: actorLabel(),
    now: () => new Date().toISOString(),
    id: newId,
    audit: (kind, action, detail) => {
      const entries = listOf(read('GET /audit')?.body);
      if (!entries) return;
      const top = entries[0] as Record<string, unknown> | undefined;
      entries.unshift({
        seq: String(Number(top?.['seq'] ?? 0) + 1),
        occurred_at: new Date().toISOString(),
        actor_label: actorLabel(),
        actor_role_id: '—',
        kind, action, detail,
        // Carried from the recording so the columns stay populated and
        // consistent with every entry above them.
        time_source: top?.['time_source'] ?? 'time.example.org (stratum 1)',
        region: top?.['region'] ?? 'ap-south-1',
      });
    },
  };

  const chained = matchChain(method, path);
  if (chained) return json(chained.chain(ctx, (payload ?? {}) as Record<string, unknown>,
    chained.params) ?? { ok: true }, 200);

  const created = remember(path, payload);
  return json(created, 200);
}
