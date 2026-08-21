import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';

/**
 * A signature demanded by CONFIGURATION, not by the route.
 *
 * Until this, `requiresSignature` was a field a tenant could set and nothing
 * read: the flow designer offered a checkbox that changed what the
 * configuration SAID and not what the system did. `capa:manage` is not one of
 * the acts 21 CFR 11 §11.50 makes the point of the record, so the product
 * demands no signature to close a nonconformity — and the seeded tenant's
 * quality manual does. That override is what these tests exercise, and it is
 * the difference between the setting being real and being decorative.
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
  const o = mac[mac.length - 1]! & 15;
  const code = ((mac[o]! & 127) << 24) | ((mac[o + 1]! & 255) << 16)
    | ((mac[o + 2]! & 255) << 8) | (mac[o + 3]! & 255);
  return String(code % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
/** Neha is Quality Manager: holds capa:manage tenant-wide. */
let neha: string;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  neha = await signIn('neha@producer.example');
});
afterAll(async () => { await app.close(); });

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

function asTenant<T>(fn: (tx: Sql, tenantId: string) => Promise<T>): Promise<T> {
  return app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`.then(([t]) => {
    const tenantId = (t as { id: string }).id;
    return inTenantTransaction(app.db, {
      tenantId, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
      organisationKind: 'producer',
    }, (tx) => fn(tx, tenantId));
  });
}

/**
 * A fresh CAPA, at whichever state the test needs.
 *
 * Created rather than borrowed. A fresh seed leaves exactly ONE nonconformity,
 * partway through its own workflow, and five tests sharing it means the fourth
 * depends on what the third did — including the one that closes it, after which
 * nothing else can move. Each test gets its own.
 */
let made = 0;
/** Distinct per run: a CAPA cannot be deleted, and its code is unique per tenant. */
const STAMP = Date.now().toString(36);
async function aCapa(state: string): Promise<{ id: string; code: string }> {
  const n = ++made;
  return asTenant(async (tx, tenantId) => {
    const [team] = await tx`SELECT id FROM lotmark.teams LIMIT 1`;
    const [row] = await tx`
      INSERT INTO lotmark.capa
        (tenant_id, code, source, severity, state, raised_on, owner_team_id,
         root_cause, corrective_action)
      VALUES (${tenantId}, ${`NCR-SIG-${STAMP}-${n}`}, 'Signature test', 'Minor',
              ${state}, current_date, ${(team as { id: string }).id},
              'Method drift', 'Method revised')
      RETURNING id, code`;
    return row as unknown as { id: string; code: string };
  });
}

const move = (id: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST', url: `/api/v1/capa/${id}/transition`,
    headers: { cookie: neha }, payload: body,
  });

const stepUp = () => app.inject({
  method: 'POST', url: '/api/v1/auth/step-up', headers: { cookie: neha },
  payload: { password: PASSWORD, code: currentTotp() },
});

describe('the moves a tenant did NOT ask to be signed', () => {
  it('go through with no signature at all', async () => {
    /**
     * The requirement lands on ONE transition, not on the workflow. If every
     * move suddenly demanded a signature the feature would be indistinguishable
     * from a route-level rule, which is what it replaces.
     */
    const capa = await aCapa('open');
    for (const [to, reason] of [
      ['investigation', 'Investigating'], ['root_cause', 'Cause established'],
      ['capa', 'Action raised'], ['effectiveness', 'Checking it worked'],
    ] as const) {
      const res = await move(capa.id, { to, reason });
      expect(res.statusCode, `${to}: ${res.body}`).toBe(200);
    }
    const signed = await asTenant(async (tx) => {
      const rows = await tx`
        SELECT to_state, signature_id FROM lotmark.state_transitions
        WHERE subject_type = 'capa' AND subject_id = ${capa.id}
        ORDER BY occurred_at`;
      return [...rows] as Array<{ to_state: string; signature_id: string | null }>;
    });
    expect(signed.length).toBe(4);
    for (const t of signed) {
      expect(t.signature_id, `${t.to_state} was not configured to need one`).toBeNull();
    }
  });
});

describe('the move a tenant DID ask to be signed', () => {
  it('refuses it with no meaning, and says which are offered', async () => {
    // §11.50(a)(3): a signature manifests a meaning, and the meaning is chosen
    // by the signer. The configured list is what may be chosen from.
    const capa = await aCapa('effectiveness');
    const res = await move(capa.id, { to: 'closed', reason: 'Effective' });
    expect(res.statusCode, res.body).toBe(422);
    const detail = res.json<{ detail: string }>().detail;
    expect(detail).toMatch(/must be signed/);
    expect(detail).toMatch(/approval/);
    expect(detail).toMatch(/responsibility/);
  });

  it('refuses a meaning the tenant did not offer for this move', async () => {
    // The seeded override offers approval and responsibility, not authorship.
    const capa = await aCapa('effectiveness');
    const res = await move(capa.id, { to: 'closed', reason: 'Effective', meaning: 'authorship' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/not a meaning this move offers/);
  });

  it('demands a step-up, and leaves the CAPA exactly where it was', async () => {
    /**
     * THE assertion. A refused signing used to commit the record it was
     * refusing to sign, because returning from inside the transaction resolves
     * it and a resolved callback COMMITS. This is that lesson applied to a
     * transition the ROUTE never knew was signed — the requirement arrived from
     * configuration, and the rollback has to hold just the same.
     */
    const capa = await aCapa('effectiveness');
    const before = await stateOf(capa.id);
    expect(before).toBe('effectiveness');

    const res = await move(capa.id, { to: 'closed', reason: 'Effective', meaning: 'approval' });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('step_up_required');

    expect(await stateOf(capa.id), 'a refused signing must not move the record').toBe('effectiveness');
    const transitions = await asTenant(async (tx) => {
      const rows = await tx`
        SELECT 1 FROM lotmark.state_transitions
        WHERE subject_type = 'capa' AND subject_id = ${capa.id} AND to_state = 'closed'`;
      return rows.length;
    });
    expect(transitions, 'and must not leave a transition behind either').toBe(0);
  });

  it('goes through once the signature is made, and binds it to the move', async () => {
    const capa = await aCapa('effectiveness');
    expect((await stepUp()).statusCode).toBe(200);

    const res = await move(capa.id, { to: 'closed', reason: 'Verified effective', meaning: 'approval' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stateOf(capa.id)).toBe('closed');

    const row = await asTenant(async (tx) => {
      const rows = await tx`
        SELECT st.signature_id, s.meaning, s.signer_user_id
        FROM lotmark.state_transitions st
        JOIN lotmark.signatures s ON s.id = st.signature_id
        WHERE st.subject_type = 'capa' AND st.subject_id = ${capa.id} AND st.to_state = 'closed'`;
      return rows[0] as { signature_id: string; meaning: string } | undefined;
    });
    // §11.70: the signature is linked to the record it signed, not merely
    // recorded alongside it.
    expect(row, 'the transition must carry the signature').toBeDefined();
    expect(row!.meaning).toBe('approval');
  });
});

const stateOf = (id: string) => asTenant(async (tx) => {
  const [row] = await tx`SELECT state FROM lotmark.capa WHERE id = ${id}`;
  return (row as { state: string }).state;
});
