import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

/**
 * The jump-to-code index.
 *
 * The claims worth pinning: it returns codes across every kind with what the
 * palette needs to navigate, project-scoped rows carry the project to open, and
 * it is scoped — a customer's index holds none of the producer's records.
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

interface Item {
  kind: string; code: string; label: string; detail: string; surface: string;
  project?: { id: string; code: string; material: string };
}

describe('the jump-to-code index', () => {
  it('indexes codes across kinds, with the project on project-scoped rows', async () => {
    const cookie = await signIn('neha@producer.example');
    const res = await app.inject({ method: 'GET', url: '/api/v1/search', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: Item[] }>().items;

    expect(items.length).toBeGreaterThan(0);
    const kinds = new Set(items.map((i) => i.kind));
    // A quality manager can see projects and their records.
    expect(kinds.has('project')).toBe(true);

    for (const i of items) {
      expect(i.code).toBeTruthy();
      expect(i.surface).toBeTruthy();
      // Project-scoped kinds carry the project to open; capa/order do not.
      if (['project', 'lot', 'study', 'value', 'certificate'].includes(i.kind)) {
        expect(i.project?.id, i.kind).toBeTruthy();
        expect(i.project?.code, i.kind).toBeTruthy();
      }
    }

    // A project code resolves to a project item whose project.code matches.
    const aProject = items.find((i) => i.kind === 'project');
    expect(aProject!.project!.code).toBe(aProject!.code);
  });

  it('gives a customer only their own records, none of the producer index', async () => {
    const cookie = await signIn('meera@genpharm.example');
    const res = await app.inject({ method: 'GET', url: '/api/v1/search', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Item[] }>().items;
    // No project/lot/study/value/certificate/capa — the customer holds none of
    // those read permissions. At most their own orders.
    expect(items.every((i) => i.kind === 'order')).toBe(true);
  });
});
