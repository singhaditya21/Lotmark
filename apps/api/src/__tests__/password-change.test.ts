import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { OPERATIONS } from '../http/operations';

/**
 * An issued password is a shared secret until it is replaced.
 *
 * `POST /admin/users` mints a password, hashes it, and hands it back once so an
 * administrator can pass it on. Until this change the account could then use it
 * forever, which meant every act that password authenticated — including
 * electronic signatures — was attributable to a credential at least two people
 * had held. 21 CFR 11 §11.300(b) and (d).
 *
 * ── Why this file is ordered ────────────────────────────────────────────────
 *
 * Enrolment can only be completed once, so the assertions run in sequence
 * against one provisioned account rather than each rebuilding it. Written as
 * independent tests it would need a fresh account per case, and the sign-in
 * rate limiter — 10 a minute, deliberately — would start refusing them. The
 * order below is the order a real person meets these states in.
 */

const DEMO_PASSWORD = 'demo-password-1234';
const DEMO_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Distinct per run: a user cannot be deleted, being referenced by the ledger. */
const STAMP = Date.now().toString(36);
const NEW_EMAIL = `pwtest-${STAMP}@producer.example`;
const NEW_CODE = `pwtest-${STAMP}`;
/** A second account that never pays its debt, so the sweep below has a subject. */
const SWEEP_EMAIL = `pwsweep-${STAMP}@producer.example`;
const SWEEP_CODE = `pwsweep-${STAMP}`;

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

function totpFor(secret: string): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[o]! & 0x7f) << 24) | ((mac[o + 1]! & 0xff) << 16)
    | ((mac[o + 2]! & 0xff) << 8) | (mac[o + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
let admin: string;

/** What the administrator was shown, once. */
let issuedPassword: string;
let issuedTotp: string;
let newUserId: string;

let sweepUserId: string;
let sweepSession: string;

/** Two sessions for the provisioned account, to prove what a change does to them. */
let sessionA: string;
let sessionB: string;

const CHOSEN_PASSWORD = 'correct-horse-battery-staple-17';

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  admin = await signInFully('admin@producer.example', DEMO_PASSWORD, DEMO_TOTP);

  const org = await producerOrganisationId();
  const created = await app.inject({
    method: 'POST', url: '/api/v1/admin/users', headers: { cookie: admin },
    payload: {
      email: NEW_EMAIL, displayName: `Password Test ${STAMP}`,
      code: NEW_CODE, organisationId: org,
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const body = created.json<{ userId: string; initialPassword: string; enrolment: string }>();
  newUserId = body.userId;
  issuedPassword = body.initialPassword;
  issuedTotp = new URL(body.enrolment).searchParams.get('secret')!;
  expect(issuedTotp, 'the enrolment URI must carry a secret').toBeTruthy();

  const sweep = await app.inject({
    method: 'POST', url: '/api/v1/admin/users', headers: { cookie: admin },
    payload: {
      email: SWEEP_EMAIL, displayName: `Password Sweep ${STAMP}`,
      code: SWEEP_CODE, organisationId: org,
    },
  });
  expect(sweep.statusCode, sweep.body).toBe(200);
  const sw = sweep.json<{ userId: string; initialPassword: string; enrolment: string }>();
  sweepUserId = sw.userId;
  sweepSession = await signInFully(
    SWEEP_EMAIL, sw.initialPassword, new URL(sw.enrolment).searchParams.get('secret')!);
});

/**
 * Close the account the suite provisioned.
 *
 * A user cannot be deleted — the ledger refers to it — so deactivation is the
 * only close-out there is, and it is the same one an administrator would use.
 * Without this the demonstration directory fills with test accounts, each of
 * which is a real account that can really sign in.
 */
afterAll(async () => {
  for (const id of [newUserId, sweepUserId]) {
    if (id && admin) {
      await app.inject({
        method: 'POST', url: `/api/v1/admin/users/${id}/deactivate`,
        headers: { cookie: admin }, payload: {},
      });
    }
  }
  await app.close();
});

/** Password only — the session exists and authorises nothing. */
async function passwordOnly(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
}

async function signInFully(email: string, password: string, secret: string): Promise<string> {
  let cookie = await passwordOnly(email, password);
  const second = await app.inject({
    method: 'POST', url: '/api/v1/auth/second-factor',
    headers: { cookie }, payload: { code: totpFor(secret), attempt: 1 },
  });
  expect(second.statusCode, second.body).toBe(200);
  const rotated = second.headers['set-cookie'];
  if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  return cookie;
}

/**
 * Read as the application role, inside a tenant.
 *
 * A bare `app.db` SELECT against `users` or `audit_ledger` returns ZERO rows
 * rather than erroring: `lotmark_app` is subject to FORCE row-level security
 * and no `lotmark.tenant_id` is set outside a tenant transaction. Which is the
 * policy doing its job — but it reads exactly like an empty table, so every
 * read here goes through the same door the application uses.
 */
function asTenant<T>(fn: (tx: Sql, tenantId: string) => Promise<T>): Promise<T> {
  return app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`.then(([t]) => {
    const tenantId = (t as { id: string }).id;
    return inTenantTransaction(app.db, {
      tenantId, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, (tx) => fn(tx, tenantId));
  });
}

function producerOrganisationId(): Promise<string> {
  return asTenant(async (tx, tenantId) => {
    const [row] = await tx`
      SELECT id FROM lotmark.organisations
      WHERE tenant_id = ${tenantId} AND kind = 'producer' LIMIT 1`;
    return (row as { id: string }).id;
  });
}

const changePassword = (cookie: string, currentPassword: string, newPassword: string) =>
  app.inject({
    method: 'POST', url: '/api/v1/auth/password',
    headers: { cookie }, payload: { currentPassword, newPassword },
  });

describe('an account provisioned with a password somebody else chose', () => {
  it('is created owing a change', async () => {
    const row = await asTenant(async (tx) => {
      const [r] = await tx`
        SELECT password_change_required, password_changed_at
        FROM lotmark.users WHERE id = ${newUserId}`;
      return r;
    });
    const user = row as { password_change_required: boolean; password_changed_at: string | null };
    expect(user.password_change_required).toBe(true);
    // NOT back-filled: the account has never had a password set by its holder,
    // and saying otherwise would be the one lie this column could tell.
    expect(user.password_changed_at).toBeNull();
  });

  it('leaves accounts that predate the column alone', async () => {
    // The default is false precisely so that deploying the migration does not
    // lock out everybody who already had an account.
    const row = await asTenant(async (tx) => {
      const [r] = await tx`
        SELECT password_change_required FROM lotmark.users
        WHERE email = 'admin@producer.example'`;
      return r;
    });
    expect((row as { password_change_required: boolean }).password_change_required).toBe(false);
  });

  it('can authenticate with the issued password', async () => {
    sessionA = await signInFully(NEW_EMAIL, issuedPassword, issuedTotp);
    expect(sessionA).toContain('lm_sid=');
  });

  it('is told so by /auth/me, which stays reachable', async () => {
    /**
     * The one route that must answer, because it is how the console learns to
     * show the change screen. Gating it would leave the client unable to tell
     * "your password must change" from "you are signed out", and it would show
     * the sign-in form to somebody already signed in.
     */
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionA },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ passwordChangeRequired: boolean }>().passwordChangeRequired).toBe(true);
  });
});

describe('what the account may do before it pays the debt', () => {
  it('is refused a route that needs only a session', async () => {
    // /auth/step-up requires no permission at all, so a refusal here can only
    // be the password gate — nothing else is in the way.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/step-up', headers: { cookie: sessionA },
      payload: { password: issuedPassword, code: totpFor(issuedTotp) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('password_change_required');
  });

  it('is refused BEFORE the permission check, not after', async () => {
    /**
     * This account holds no role, so /projects would refuse it anyway — with a
     * guard reason. Getting `password_change_required` instead proves the gate
     * fires in requireSession, before any route reaches `decide()`. That
     * ordering is what makes the gate impossible for a new route to forget.
     */
    const res = await app.inject({
      method: 'GET', url: '/api/v1/projects', headers: { cookie: sessionA },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('password_change_required');
  });

  /**
   * The claim is that NO route can forget the gate, because the gate is in
   * requireSession rather than in the routes. A claim of that shape is not
   * provable by picking two routes and trying them, so this tries all of them:
   * every operation the registry says needs a session, minus the three that
   * deliberately opt out and say why.
   *
   * The registry is the right list to walk. `openapi.test.ts` already fails in
   * both directions if it disagrees with the routes Fastify actually built, so
   * a route added tomorrow appears here without anybody remembering to add it —
   * which is the only version of this test worth having.
   */
  it('is refused by EVERY route that needs a session', async () => {
    const OPEN_TO_A_PENDING_ACCOUNT = new Set([
      'GET /api/v1/auth/me',
      'POST /api/v1/auth/password',
      'POST /api/v1/auth/sign-out',
    ]);

    const gated = OPERATIONS.filter((o) => o.requiresSession)
      .filter((o) => !OPEN_TO_A_PENDING_ACCOUNT.has(`${o.method} ${o.url}`))
      // Sign-in and the second factor take a session that has not been resolved
      // yet; there is nothing for this gate to act on.
      .filter((o) => o.url !== '/api/v1/auth/second-factor');

    expect(gated.length, 'the sweep must actually cover something').toBeGreaterThan(30);

    const wrong: string[] = [];
    for (const o of gated) {
      // Any syntactically valid id: the gate fires before the handler looks at
      // the parameters, so what they are cannot matter — and if it ever does,
      // that is the finding.
      const url = o.url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await app.inject({
        method: o.method as 'GET', url, headers: { cookie: sweepSession },
      });
      let code = '';
      try { code = res.json<{ code?: string }>().code ?? ''; } catch { code = '(not json)'; }
      if (res.statusCode !== 403 || code !== 'password_change_required') {
        wrong.push(`${o.method} ${o.url} → ${res.statusCode} ${code}`);
      }
    }
    expect(wrong, 'every one of these answered something other than the password gate')
      .toEqual([]);
  });

  it('may still sign out', async () => {
    // There has to be a way to leave. Checked on the sweep session, which has
    // no further use — signing out of sessionA would invalidate the rest of
    // this file.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-out', headers: { cookie: sweepSession },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('cannot change the password on a session that has not passed the second factor', async () => {
    /**
     * The ordering is the control, not a nicety. If the issued password alone
     * reached this route, then whoever generated it — or whoever saw the
     * channel it travelled through — could set a new one and take the account
     * before its owner ever signed in. Demanding the second factor first means
     * the person replacing the credential holds the authenticator.
     */
    const halfway = await passwordOnly(NEW_EMAIL, issuedPassword);
    const res = await changePassword(halfway, issuedPassword, CHOSEN_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('second_factor_required');
  });
});

describe('replacing the password', () => {
  it('refuses without the current password', async () => {
    const res = await changePassword(sessionA, 'not-the-issued-password', CHOSEN_PASSWORD);
    expect(res.statusCode).toBe(401);
    // The same uniform message as sign-in: which of the two was wrong is not
    // something the response should confirm.
    expect(res.json<{ detail: string }>().detail).toMatch(/current password was not accepted/i);
  });

  it('refuses a password shorter than policy, as a field error', async () => {
    const res = await changePassword(sessionA, issuedPassword, 'short');
    expect(res.statusCode).toBe(400);
    const body = res.json<{ errors?: Array<{ field: string; message: string }> }>();
    expect(body.errors?.some((e) => e.field === 'newPassword')).toBe(true);
  });

  it('refuses the current password offered as the new one', async () => {
    // "Change it" and "type it again" are different acts. Accepting the second
    // as the first would clear the obligation without replacing anything.
    const res = await changePassword(sessionA, issuedPassword, issuedPassword);
    expect(res.statusCode).toBe(422);
  });

  it('accepts a real change, and ends the account’s other sessions', async () => {
    sessionB = await signInFully(NEW_EMAIL, issuedPassword, issuedTotp);

    const res = await changePassword(sessionA, issuedPassword, CHOSEN_PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ changed: boolean; otherSessionsEnded: number }>();
    expect(body.changed).toBe(true);
    expect(body.otherSessionsEnded, 'sessionB was open under the old password')
      .toBeGreaterThanOrEqual(1);
  });

  it('kept the session that did the changing', async () => {
    // Revoking it too would sign the user out at the moment they did the right
    // thing, and the likeliest reading of that is that the change failed.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionA },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ passwordChangeRequired: boolean }>().passwordChangeRequired).toBe(false);
  });

  it('ended the other one', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sessionB },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets the account act now', async () => {
    // Not 403 password_change_required any more. It is 403 for the ordinary
    // reason — this account still holds no role — which is the correct refusal.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/projects', headers: { cookie: sessionA },
    });
    expect(res.json<{ code: string }>().code).not.toBe('password_change_required');
  });
});

describe('after the change', () => {
  it('refuses the issued password at sign-in', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-in',
      payload: { email: NEW_EMAIL, password: issuedPassword },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the chosen one', async () => {
    const cookie = await signInFully(NEW_EMAIL, CHOSEN_PASSWORD, issuedTotp);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('records the act in the ledger, and neither password in it', async () => {
    const rows = await asTenant((tx) => tx`
      SELECT action, detail, changes, actor_user_id
      FROM lotmark.audit_ledger
      WHERE subject_table = 'users' AND subject_id = ${newUserId}
      ORDER BY seq`);

    const entry = rows.find((r) => (r as { action: string }).action === 'Password changed by its holder');
    expect(entry, 'the change must be in the ledger').toBeDefined();
    expect((entry as { actor_user_id: string }).actor_user_id).toBe(newUserId);

    // The auditable fact is the act. The credential is not, and an audit ledger
    // is precisely the wrong place to discover one.
    const asText = JSON.stringify(rows);
    expect(asText).not.toContain(issuedPassword);
    expect(asText).not.toContain(CHOSEN_PASSWORD);
  });
});
