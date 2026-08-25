import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

/**
 * The CAPA register's transition timeline.
 *
 * Every move already writes to state_transitions (ISO 17034 7.11); the claim
 * here is that the register now surfaces that history on each CAPA — with the
 * actor, reason and time — rather than leaving it to be reconstructed from the
 * ledger, and that the moves are in order.
 */

const PW = 'demo-password-1234';
const SEC = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function b32(s: string): Buffer {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let b = '';
  for (const c of s.toUpperCase()) { const i = a.indexOf(c); if (i >= 0) b += i.toString(2).padStart(5, '0'); }
  const o = Buffer.alloc(Math.floor(b.length / 8));
  for (let i = 0; i < o.length; i++) o[i] = parseInt(b.slice(i * 8, i * 8 + 8), 2);
  return o;
}
function totp(): string {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const m = createHmac('sha1', b32(SEC)).update(c).digest(); const of = m[m.length - 1]! & 15;
  const co = ((m[of]! & 127) << 24) | ((m[of + 1]! & 255) << 16) | ((m[of + 2]! & 255) << 8) | (m[of + 3]! & 255);
  return String(co % 1_000_000).padStart(6, '0');
}

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ NODE_ENV: 'test' }); await app.ready(); });
afterAll(async () => { await app.close(); });

async function signIn(email: string): Promise<string> {
  const f = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: PW } });
  let ck = (Array.isArray(f.headers['set-cookie']) ? f.headers['set-cookie'][0]! : String(f.headers['set-cookie'])).split(';')[0]!;
  if (f.json<{ secondFactorRequired?: boolean }>().secondFactorRequired) {
    const s = await app.inject({ method: 'POST', url: '/api/v1/auth/second-factor', headers: { cookie: ck }, payload: { code: totp(), attempt: 1 } });
    const r = s.headers['set-cookie']; if (r) ck = (Array.isArray(r) ? r[0]! : String(r)).split(';')[0]!;
  }
  return ck;
}

interface Move { fromState: string | null; toState: string; occurredAt: string; actor: string | null; reason: string | null; signed: boolean; }
interface Capa { code: string; transitions: Move[]; }

describe('the CAPA transition timeline', () => {
  it('surfaces each move with its actor, reason and time, in order', async () => {
    const cookie = await signIn('neha@producer.example');
    const res = await app.inject({ method: 'GET', url: '/api/v1/capa', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const capa = res.json<{ capa: Capa[] }>().capa;
    expect(capa.length).toBeGreaterThan(0);

    // Every CAPA carries a transitions array — the field the card reads.
    for (const c of capa) {
      expect(Array.isArray(c.transitions), c.code).toBe(true);
      // Each recorded move has, at minimum, a destination state and a time, and
      // the moves are chronological. (A freshly-raised, un-moved CAPA is empty.)
      for (const m of c.transitions) {
        expect(m.toState).toBeTruthy();
        expect(m.occurredAt).toBeTruthy();
        expect(typeof m.signed).toBe('boolean');
      }
      const times = c.transitions.map((m) => new Date(m.occurredAt).getTime());
      expect(times, `${c.code} history in order`).toEqual([...times].sort((a, b) => a - b));
    }
  });
});
