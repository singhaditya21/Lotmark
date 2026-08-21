import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

/**
 * Administering configuration.
 *
 * The interesting cases are all refusals. Publishing a configuration that does
 * not resolve locks EVERY user out of the tenant — `session.ts` throws when no
 * role parses, deliberately, because proceeding would authorise nothing and
 * look identical to a permissions bug. The person who published it would be
 * locked out too, and would be the one expected to fix it.
 */

const PASSWORD = 'demo-password-1234';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

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
  const code =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  admin = await signIn('admin@producer.example');
});
afterAll(async () => { await app.close(); });

/** Never leave a draft behind: one per tenant, so a stray one breaks the next test. */
afterEach(async () => {
  const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
  const draftId = overview.json<{ draftId: string | null }>().draftId;
  if (draftId) {
    await app.inject({ method: 'DELETE', url: `/api/v1/admin/config/draft/${draftId}`, headers: { cookie: admin } });
  }
});

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
    expect(second.statusCode, second.body).toBe(200);
    const rotated = second.headers['set-cookie'];
    if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  }
  return cookie;
}

const openDraft = async (reason: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/config/draft',
    headers: { cookie: admin }, payload: { changeReason: reason },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ id: string }>().id;
};

const putEntry = (id: string, kind: string, key: string, payload: unknown) =>
  app.inject({
    method: 'PUT', url: `/api/v1/admin/config/draft/${id}/entry`,
    headers: { cookie: admin }, payload: { kind, key, payload },
  });

const review = async (id: string) => {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/admin/config/draft/${id}/review`, headers: { cookie: admin },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    changes: Array<{ kind: string; key: string; change: string; risk: string }>;
    problems: string[]; needsSignature: boolean; publishable: boolean;
  }>();
};

/** What the console would show in the `overridesDefault` column for one entry. */
const overridesFor = async (versionId: string, kind: string, key: string) => {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/admin/config/${versionId}`, headers: { cookie: admin },
  });
  expect(res.statusCode, res.body).toBe(200);
  const entry = res.json<{ entries: Array<{ kind: string; key: string; overridesDefault: boolean }> }>()
    .entries.find((e) => e.kind === kind && e.key === key);
  expect(entry, `no ${kind}:${key} entry in version ${versionId}`).toBeDefined();
  return entry!.overridesDefault;
};

const role = (key: string, over: Record<string, unknown> = {}) => ({
  key, name: `Role ${key}`, kind: 'producer',
  permissions: ['project:read'], inherits: [], system: false, ...over,
});

describe('who may administer configuration', () => {
  it('refuses somebody without user:manage', async () => {
    // Ravi is a scientist. He holds real authority over studies and none at all
    // over what the system does.
    const ravi = await signIn('ravi@producer.example');
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/config', headers: { cookie: ravi },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('user:manage');
  });
});

describe('an entry is filed under one identifier, not two', () => {
  /**
   * Every entry carries its key twice: in the `key` column, which is what a
   * query joins and orders on, and inside the payload, which is what a reader
   * parses. Nothing used to make them agree.
   */
  it('refuses a key that disagrees with the payload', async () => {
    const id = await openDraft('Key agreement');
    const res = await putEntry(id, 'role', 'auditor', role('inspector'));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/calls itself/);
  });

  it('refuses a key the payload schema would itself reject', async () => {
    // The route accepted `z.string().min(1).max(120)` for the column while the
    // payload validated a lower-case slug, so a key with spaces and capitals
    // got as far as the database.
    const id = await openDraft('Key shape');
    const res = await putEntry(id, 'role', 'My Auditor!', role('My Auditor!'));
    expect(res.statusCode).toBe(400);
  });

  it('accepts them when they agree', async () => {
    const id = await openDraft('Key agreement, positive');
    const res = await putEntry(id, 'role', 'auditor', role('auditor'));
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('whether an entry replaces a product default', () => {
  /**
   * `overrides_default` is shown in the console, so it has to be true. It was
   * hardcoded to `true` on insert and left untouched on update, which claimed
   * that anything written through the API replaces something the product
   * ships — including kinds the product ships nothing of.
   */
  it('says so for a role the product ships', async () => {
    const id = await openDraft('Overriding a shipped role');
    await putEntry(id, 'role', 'quality', role('quality'));
    expect(await overridesFor(id, 'role', 'quality')).toBe(true);
  });

  it('does not say so for a role the tenant invented', async () => {
    const id = await openDraft('A role of our own');
    await putEntry(id, 'role', 'inspector', role('inspector'));
    expect(await overridesFor(id, 'role', 'inspector')).toBe(false);
  });

  it('gives the same answer whether the entry was created or edited', async () => {
    // The UPDATE branch did not set the column at all, so an entry could end up
    // with a different answer purely because of how it got there.
    const id = await openDraft('Created then edited');
    await putEntry(id, 'role', 'inspector', role('inspector'));
    await putEntry(id, 'role', 'inspector', role('inspector', { name: 'Inspector, renamed' }));
    expect(await overridesFor(id, 'role', 'inspector')).toBe(false);
  });
});

describe('drafts', () => {
  it('copies the active version and changes nothing until published', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
    const activeId = before.json<{ activeId: string }>().activeId;

    const id = await openDraft('Copy check');
    const draft = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${id}`, headers: { cookie: admin },
    });
    const activeDetail = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${activeId}`, headers: { cookie: admin },
    });

    const keysOf = (r: typeof draft) =>
      r.json<{ entries: Array<{ kind: string; key: string }> }>()
        .entries.map((e) => `${e.kind}:${e.key}`).sort();
    expect(keysOf(draft)).toEqual(keysOf(activeDetail));

    // And the active version is still the active version.
    const after = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
    expect(after.json<{ activeId: string }>().activeId).toBe(activeId);
  });

  it('allows only one at a time', async () => {
    await openDraft('The first');
    const second = await app.inject({
      method: 'POST', url: '/api/v1/admin/config/draft',
      headers: { cookie: admin }, payload: { changeReason: 'The second' },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json<{ detail: string }>().detail).toMatch(/already open as a draft/);
  });

  it('refuses to edit a published version', async () => {
    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { cookie: admin } });
    const activeId = overview.json<{ activeId: string }>().activeId;
    const res = await putEntry(activeId, 'role', 'sneaky', role('sneaky'));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/cannot be edited/);
  });

  it('validates a payload against the schema for its kind', async () => {
    const id = await openDraft('Validation check');
    const res = await putEntry(id, 'role', 'bogus', role('bogus', { permissions: ['not:a:permission'] }));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/not valid/);
  });
});

describe('what publication refuses', () => {
  it('refuses a configuration that would lock everybody out', async () => {
    /**
     * The failure this check exists for. Sign-in resolves authority from the
     * active version and fails closed when none of it parses, so a version with
     * no valid role locks out every user of the tenant — including whoever
     * published it, who would then be unable to publish a fix.
     */
    const id = await openDraft('Remove every role');
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${id}`, headers: { cookie: admin },
    });
    for (const e of detail.json<{ entries: Array<{ kind: string; key: string }> }>().entries) {
      if (e.kind !== 'role') continue;
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/config/draft/${id}/entry/${e.kind}/${e.key}`,
        headers: { cookie: admin },
      });
    }

    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/defines no valid role/);
    expect(r.problems.join(' '), 'and it says what would happen').toMatch(/lock every user out/);

    const publish = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: { meaning: 'approval' },
    });
    expect(publish.statusCode).toBe(422);
  });

  it('refuses to remove a role somebody still holds', async () => {
    // Removing it does not revoke the assignments naming it: the person
    // silently loses everything while the row still looks valid.
    const id = await openDraft('Remove a role in use');
    await app.inject({
      method: 'DELETE', url: `/api/v1/admin/config/draft/${id}/entry/role/scientist`,
      headers: { cookie: admin },
    });
    const r = await review(id);
    expect(r.publishable).toBe(false);
    expect(r.problems.join(' ')).toMatch(/'scientist' is held by/);
  });

  it('refuses a security change with no signature', async () => {
    const id = await openDraft('Add a role');
    expect((await putEntry(id, 'role', 'sectionlead', role('sectionlead'))).statusCode).toBe(200);

    const r = await review(id);
    expect(r.needsSignature, 'a role is a security change').toBe(true);
    expect(r.publishable).toBe(true);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/must be signed/);
  });

  it('refuses a draft that changes nothing', async () => {
    const id = await openDraft('An empty change');
    const r = await review(id);
    expect(r.changes).toEqual([]);
    expect(r.publishable).toBe(false);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/changes nothing/);
  });

  it('rolls back completely when the signing step is refused', async () => {
    /**
     * The session is authenticated but not stepped up, which is the state every
     * session is in before its first signing. Returning from inside the
     * transaction would publish the version UNSIGNED — see SigningRejection.
     */
    const id = await openDraft('Add a role, without stepping up');
    await putEntry(id, 'role', 'sectionlead', role('sectionlead'));

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/config/draft/${id}/publish`,
      headers: { cookie: admin }, payload: { meaning: 'approval' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('step_up_required');

    // THE assertion: the version must still be a draft, and unsigned.
    const after = await app.inject({
      method: 'GET', url: `/api/v1/admin/config/${id}`, headers: { cookie: admin },
    });
    const v = after.json<{ version: { status: string; signed: boolean } }>().version;
    expect(v.status, 'a refused signing must not publish the version').toBe('draft');
    expect(v.signed).toBe(false);
  });
});

describe('reviewing', () => {
  it('reports every problem at once, not the first one', async () => {
    // An administrator fixing one problem at a time through a screen that
    // reveals the next one is how a configuration change takes an afternoon.
    const id = await openDraft('Two problems');
    await app.inject({
      method: 'DELETE', url: `/api/v1/admin/config/draft/${id}/entry/role/scientist`,
      headers: { cookie: admin },
    });
    await app.inject({
      method: 'DELETE', url: `/api/v1/admin/config/draft/${id}/entry/role/techmgr`,
      headers: { cookie: admin },
    });
    const r = await review(id);
    expect(r.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies a presentation change as needing no signature', async () => {
    const id = await openDraft('Move something on a form');
    const res = await putEntry(id, 'translation', 'en-gb', {
      key: 'en-gb', locale: 'en-GB', strings: { 'projects.title': 'Projects' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = await review(id);
    expect(r.changes.some((c) => c.kind === 'translation')).toBe(true);
    expect(r.needsSignature, 'translations are presentation').toBe(false);
  });
});
