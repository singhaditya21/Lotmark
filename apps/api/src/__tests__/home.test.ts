import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

/**
 * The home surface.
 *
 * The two claims worth pinning: the shape the console reads is what comes back,
 * and the counts are scoped to what the caller can act on — a customer, who
 * holds none of the producer act permissions, is shown an empty inbox rather
 * than the producer's pile of work.
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

beforeAll(async () => { app = await buildApp({ NODE_ENV: 'test' }); await app.ready(); });
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
    const rotated = second.headers['set-cookie'];
    if (rotated) cookie = (Array.isArray(rotated) ? rotated[0]! : String(rotated)).split(';')[0]!;
  }
  return cookie;
}

interface Home {
  attention: Array<{ kind: string; code: string; title: string; surface: string; overdue?: boolean }>;
  summary: {
    studiesToSign: number; valuesToAuthorise: number; lotsToCertify: number;
    capaOpen: number; capaOverdue: number; ordersToDispatch: number;
  };
}

describe('the home surface', () => {
  it('returns a scoped summary and an itemised attention list', async () => {
    const cookie = await signIn('neha@producer.example');
    const res = await app.inject({ method: 'GET', url: '/api/v1/home', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const home = res.json<Home>();

    for (const k of Object.keys(home.summary) as Array<keyof Home['summary']>) {
      expect(Number.isInteger(home.summary[k]), k).toBe(true);
      expect(home.summary[k]).toBeGreaterThanOrEqual(0);
    }
    expect(Array.isArray(home.attention)).toBe(true);
    for (const item of home.attention) {
      expect(item.code).toBeTruthy();
      expect(['study', 'value', 'lot', 'capa', 'order']).toContain(item.kind);
      expect(item.surface).toBeTruthy();
    }
    // Overdue CAPA sort to the top of the list.
    const firstNonOverdue = home.attention.findIndex((i) => i.overdue !== true);
    const lastOverdue = home.attention.map((i) => i.overdue === true).lastIndexOf(true);
    if (firstNonOverdue !== -1 && lastOverdue !== -1) {
      expect(lastOverdue).toBeLessThan(firstNonOverdue === -1 ? Infinity : firstNonOverdue);
    }
    // The itemised list and the counts agree on the signable studies.
    expect(home.attention.filter((i) => i.kind === 'study').length).toBe(home.summary.studiesToSign);
  });

  it('shows a customer an empty inbox — none of this work is theirs', async () => {
    const cookie = await signIn('meera@genpharm.example');
    const res = await app.inject({ method: 'GET', url: '/api/v1/home', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const home = res.json<Home>();
    expect(home.attention).toEqual([]);
    expect(home.summary.studiesToSign).toBe(0);
    expect(home.summary.valuesToAuthorise).toBe(0);
    expect(home.summary.lotsToCertify).toBe(0);
    expect(home.summary.capaOpen).toBe(0);
    expect(home.summary.ordersToDispatch).toBe(0);
  });
});
