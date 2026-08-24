import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The demo adapter.
 *
 * These are here because the alternative is clicking, and clicking is how the
 * two defects in this file's subject matter got shipped in the first place: the
 * audit ledger rendered empty for a build because `/audit?limit=200` never
 * matched, and it looked exactly like a quiet day. A 404 on a list endpoint has
 * no symptom. Only an assertion has.
 */

const load = async () => {
  vi.resetModules();
  return import('../adapter');
};

const call = async (
  demoFetch: (p: string, i: RequestInit) => Promise<Response>,
  method: string, path: string, body?: unknown,
) => {
  const res = await demoFetch(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

/** Sign in, because everything else is behind it. */
const signIn = async (
  demoFetch: (p: string, i: RequestInit) => Promise<Response>,
  email = 'admin@producer.example',
) => {
  await call(demoFetch, 'POST', '/auth/sign-in', { email, password: 'demo-viewer' });
  await call(demoFetch, 'POST', '/auth/second-factor', { code: '123456' });
};

/** Open a signing window, which every signed act requires. */
const stepUp = (demoFetch: (p: string, i: RequestInit) => Promise<Response>) =>
  call(demoFetch, 'POST', '/auth/step-up', { password: 'demo-viewer', code: '123456' });

const listIn = (body: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  const found = Object.values(body as Record<string, unknown>).find(Array.isArray);
  return (found as Array<Record<string, unknown>> | undefined) ?? [];
};

describe('reading', () => {
  let demoFetch: (p: string, i: RequestInit) => Promise<Response>;
  beforeEach(async () => { ({ demoFetch } = await load()); });

  it('serves a path with a query string', async () => {
    /*
     * The whole reason these tests exist. `match()` compares path segments, so
     * `/audit?limit=200` had a final segment of `audit?limit=200` and matched
     * nothing — the richest screen in the demo rendered empty and nobody could
     * tell, because an empty audit table looks like a quiet day.
     */
    await signIn(demoFetch);
    const withQuery = await call(demoFetch, 'GET', '/audit?limit=200');
    expect(withQuery.status).toBe(200);
    expect(listIn(withQuery.body).length).toBeGreaterThan(0);
  });

  it('resolves a real id against the template it was captured under', async () => {
    await signIn(demoFetch);
    const projects = listIn((await call(demoFetch, 'GET', '/projects')).body);
    expect(projects.length).toBeGreaterThan(0);
    const studies = await call(demoFetch, 'GET', `/projects/${String(projects[0]!['id'])}/studies`);
    expect(studies.status).toBe(200);
  });

  it('refuses everything before sign-in', async () => {
    expect((await call(demoFetch, 'GET', '/auth/me')).status).toBe(401);
  });
});

describe('who is signed in', () => {
  let demoFetch: (p: string, i: RequestInit) => Promise<Response>;
  beforeEach(async () => { ({ demoFetch } = await load()); });

  it('is the person whose address was used', async () => {
    /*
     * The sign-in screen invites a viewer to try a bench scientist, a quality
     * manager or a customer "to see how the same screens change by role". It
     * ignored the address entirely for one release and every account signed in
     * as the tenant administrator.
     */
    await signIn(demoFetch, 'meera@genpharm.example');
    const me = (await call(demoFetch, 'GET', '/auth/me')).body as
      { user?: { name?: string }; roleKinds?: string[] };
    expect(me.user?.name).toContain('Meera');
    expect(me.roleKinds).toContain('customer');
  });

  it('shows a customer a different world from the producer', async () => {
    await signIn(demoFetch, 'meera@genpharm.example');
    const customerProjects = listIn((await call(demoFetch, 'GET', '/projects')).body);

    const fresh = await load();
    await signIn(fresh.demoFetch, 'admin@producer.example');
    const adminProjects = listIn((await call(fresh.demoFetch, 'GET', '/projects')).body);

    expect(customerProjects.length).toBe(0);
    expect(adminProjects.length).toBeGreaterThan(0);
  });

  it('rejects an empty password, and says what the right one is', async () => {
    const empty = await call(demoFetch, 'POST', '/auth/sign-in',
      { email: 'admin@producer.example', password: '  ' });
    expect(empty.status).toBe(401);
    const wrong = await call(demoFetch, 'POST', '/auth/sign-in',
      { email: 'admin@producer.example', password: 'nope' });
    expect(String(wrong.body['detail'])).toContain('demo-viewer');
  });
});

describe('signing', () => {
  let demoFetch: (p: string, i: RequestInit) => Promise<Response>;
  beforeEach(async () => { ({ demoFetch } = await load()); });

  it('refuses a signed act until the signing window is open', async () => {
    /*
     * §11.200 in miniature: a live session is not a signature. Skipping this in
     * the demo would hide the one ceremony worth filming.
     */
    await signIn(demoFetch);
    const projects = listIn((await call(demoFetch, 'GET', '/projects')).body);
    const studies = listIn((await call(demoFetch, 'GET',
      `/projects/${String(projects[0]!['id'])}/studies`)).body);
    const refused = await call(demoFetch, 'POST',
      `/studies/${String(studies[0]!['id'])}/sign`, { meaning: 'approval' });
    expect(refused.status).toBe(401);
    expect(refused.body['code']).toBe('step_up_required');
  });

  it('does NOT demand step-up for a transition the workflow does not sign', async () => {
    /*
     * The over-broad guard this pins down. Whether a move needs a signature is
     * set per-transition — the product enforces `requiresSignature` FROM the
     * transition — and the seeded CAPA workflow signs none of its moves, only
     * gating them on the `capa:manage` permission. A blanket rule on every path
     * ending in `transition` made the demo throw the §11.200 wall in front of a
     * CAPA progression that the real product completes without ceremony, which
     * is a refusal the product would never show and a dead end on camera.
     */
    await signIn(demoFetch);
    const capa = listIn((await call(demoFetch, 'GET', '/capa')).body);
    const before = listIn((await call(demoFetch, 'GET', '/audit')).body)[0]!['seq'];

    // investigation → root_cause: a real move in the seeded workflow, and one
    // it does not require a signature for.
    const moved = await call(demoFetch, 'POST',
      `/capa/${String(capa[0]!['id'])}/transition`,
      { to: 'root_cause', reason: 'Logger failure confirmed as the cause' });

    expect(moved.status, 'the move was refused for a signature it does not need').toBe(200);
    const top = listIn((await call(demoFetch, 'GET', '/audit')).body)[0]!;
    expect(top['seq'], 'and it still recorded the move in the ledger').not.toBe(before);
    expect(top['kind']).toBe('CAPA');
  });
});

describe('an act leaves a trace', () => {
  let demoFetch: (p: string, i: RequestInit) => Promise<Response>;
  beforeEach(async () => {
    ({ demoFetch } = await load());
    await signIn(demoFetch);
    await stepUp(demoFetch);
  });

  const auditTop = async () => {
    const entries = listIn((await call(demoFetch, 'GET', '/audit')).body);
    return entries[0]!;
  };

  it('signing a study marks it signed AND writes to the ledger', async () => {
    /*
     * Both halves, because either alone is a lie. A demo where the button works
     * and the record does not move is a form; one where the record moves and
     * the ledger does not is this product without the thing it is for.
     */
    const projects = listIn((await call(demoFetch, 'GET', '/projects')).body);
    const pid = String(projects[0]!['id']);
    const studies = listIn((await call(demoFetch, 'GET', `/projects/${pid}/studies`)).body);
    const target = studies.find((s) => s['state'] !== 'signed') ?? studies[0]!;
    const before = (await auditTop())['seq'];

    const res = await call(demoFetch, 'POST', `/studies/${String(target['id'])}/sign`,
      { meaning: 'approval' });
    expect(res.status).toBe(200);

    const after = listIn((await call(demoFetch, 'GET', `/projects/${pid}/studies`)).body);
    expect(after.find((s) => s['id'] === target['id'])?.['state']).toBe('signed');

    const top = await auditTop();
    expect(top['seq']).not.toBe(before);
    expect(top['kind']).toBe('SIGNATURE');
    expect(String(top['actor_label'])).toContain('Administrator');
  });

  it('withdrawing an issue marks its holders notified', async () => {
    /*
     * ISO 17034 §7.11. The register grades this `partial` because the real
     * system tells holders in-app and nowhere else — but identifying them and
     * recording that they were told is the part that does work, and it is the
     * part worth showing.
     */
    const cert = (await call(demoFetch, 'GET', '/certificates/x')).body as
      { issues?: Array<Record<string, unknown>> };
    const n = String(cert.issues?.[0]?.['number'] ?? 1);

    await call(demoFetch, 'POST', `/certificates/x/issues/${n}/withdraw`,
      { reason: 'Assay value found to be wrong' });

    const holders = listIn((await call(demoFetch, 'GET',
      `/certificates/x/issues/${n}/holders`)).body);
    expect(holders.length).toBeGreaterThan(0);
    expect(holders.every((h) => h['notified'] === true)).toBe(true);

    const top = await auditTop();
    expect(top['kind']).toBe('CERTIFICATE');
    expect(String(top['detail'])).toMatch(/withdrawn/i);
    expect(String(top['detail'])).toMatch(/holder\(s\) notified/);
  });

  it('a CAPA transition moves the record and names the move', async () => {
    const capa = listIn((await call(demoFetch, 'GET', '/capa')).body);
    const id = String(capa[0]!['id']);
    await call(demoFetch, 'POST', `/capa/${id}/transition`,
      { to: 'containment', reason: 'Stock quarantined' });

    const after = listIn((await call(demoFetch, 'GET', '/capa')).body);
    expect(after.find((c) => c['id'] === id)?.['state']).toBe('containment');
    expect(String((await auditTop())['detail'])).toContain('containment');
  });

  it('records the ledger entry against the person who acted', async () => {
    const fresh = await load();
    await signIn(fresh.demoFetch, 'asha@producer.example');
    await stepUp(fresh.demoFetch);
    const capa = listIn((await call(fresh.demoFetch, 'GET', '/capa')).body);
    await call(fresh.demoFetch, 'POST', `/capa/${String(capa[0]!['id'])}/transition`,
      { to: 'containment' });
    const entries = listIn((await call(fresh.demoFetch, 'GET', '/audit')).body);
    expect(String(entries[0]!['actor_label'])).toContain('Asha');
  });
});
