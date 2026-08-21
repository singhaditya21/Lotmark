import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction } from '../db';

/**
 * The commercial half, exercised as the people who use it.
 *
 * The interesting assertions are about what each persona CANNOT reach. One
 * laboratory reading another's orders is the failure this whole cluster was
 * built to prevent, and it was the live behaviour until migration 0022.
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
const cookies: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
  for (const who of ['meera@genpharm.example', 'suresh@sdtl.gov.example',
                     'arjun@producer.example', 'vikram@producer.example']) {
    cookies[who] = await signIn(who);
  }
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

const get = (who: string, url: string) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie: cookies[who]! } });
const post = (who: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { cookie: cookies[who]! }, payload });

const MEERA = 'meera@genpharm.example';
const SURESH = 'suresh@sdtl.gov.example';
const ARJUN = 'arjun@producer.example';
const VIKRAM = 'vikram@producer.example';

interface OrdersBody {
  orders: Array<{ id: string; code: string; state: string; organisation_name: string }>;
  scope: 'all' | 'own';
  canAdvance: boolean;
}

describe('one laboratory cannot see another', () => {
  it('shows a customer only their own organisation’s orders', async () => {
    /**
     * The defect that motivated migration 0022. Before it, every authenticated
     * user of the tenant saw every organisation's orders, because the producer
     * and its customers ARE the same tenant.
     */
    const mine = (await get(MEERA, '/orders')).json<OrdersBody>();
    expect(mine.scope).toBe('own');
    expect(mine.orders.length).toBeGreaterThan(0);
    const organisations = new Set(mine.orders.map((o) => o.organisation_name));
    expect([...organisations]).toEqual(['GenPharm Laboratories Pvt Ltd']);

    const theirs = (await get(SURESH, '/orders')).json<OrdersBody>();
    const otherOrgs = new Set(theirs.orders.map((o) => o.organisation_name));
    expect(otherOrgs.has('GenPharm Laboratories Pvt Ltd'),
      'the other laboratory must not appear').toBe(false);
  });

  it('shows the producer everything, because that is their job', async () => {
    const all = (await get(ARJUN, '/orders')).json<OrdersBody>();
    expect(all.scope).toBe('all');
    expect(new Set(all.orders.map((o) => o.organisation_name)).size).toBeGreaterThan(1);
  });

  it('shows a customer only their own vault', async () => {
    const vault = (await get(MEERA, '/vault')).json<{
      holdings: unknown[]; organisation: string;
    }>();
    expect(vault.organisation).toBe('GenPharm Laboratories Pvt Ltd');
    const theirs = (await get(SURESH, '/vault')).json<{ holdings: unknown[] }>();
    // SDTL holds nothing in the seed; the point is that it does not inherit
    // GenPharm's holdings.
    expect(theirs.holdings.length).toBe(0);
  });

  it('refuses the vault to somebody with no vault:use', async () => {
    const res = await get(ARJUN, '/vault');
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('vault:use');
  });
});

describe('placing an order', () => {
  const catalogue = async (who: string) =>
    (await get(who, '/catalogue')).json<{
      items: Array<{ id: string; lot_code: string; stock_units: number }>;
      canOrder: boolean; canManage: boolean;
    }>();

  it('shows the catalogue to a customer and to the producer', async () => {
    const asCustomer = await catalogue(MEERA);
    expect(asCustomer.canOrder).toBe(true);
    expect(asCustomer.canManage).toBe(false);
    expect(asCustomer.items.length).toBeGreaterThan(0);

    const asCommercial = await catalogue(ARJUN);
    expect(asCommercial.canManage).toBe(true);
  });

  it('decrements stock, and refuses to sell more than exists', async () => {
    const before = await catalogue(MEERA);
    const lot = before.items.find((i) => i.stock_units > 0)!;

    const placed = await post(MEERA, '/orders', { lines: [{ lotId: lot.id, quantity: 1 }] });
    expect(placed.statusCode, placed.body).toBe(200);

    const after = await catalogue(MEERA);
    const same = after.items.find((i) => i.id === lot.id)!;
    expect(same.stock_units).toBe(lot.stock_units - 1);

    // Stock is re-read under a row lock inside the transaction, not trusted
    // from the page the customer was looking at.
    const greedy = await post(MEERA, '/orders', {
      lines: [{ lotId: lot.id, quantity: same.stock_units + 5 }],
    });
    expect(greedy.statusCode).toBe(409);
    expect(greedy.json<{ detail: string }>().detail).toMatch(/remain/);
  });

  it('refuses an order for a lot that is not released', async () => {
    /**
     * A lot can be withdrawn between a page load and a click, and selling
     * material whose certificate has just been withdrawn is the worst outcome
     * this route has. The state is checked inside the transaction.
     */
    const tenant = await tenantId();
    const withdrawn = await inTenantTransaction(app.db, {
      tenantId: tenant, auditKey: app.cfg.LOTMARK_AUDIT_KEY, organisationKind: 'producer',
    }, async (tx) => {
      const [row] = await tx`
        SELECT id FROM lotmark.lots
        WHERE tenant_id = ${tenant} AND state <> 'released' LIMIT 1`;
      return (row as { id: string } | undefined)?.id ?? null;
    });
    if (!withdrawn) return;   // nothing unreleased in the seed; nothing to prove

    const res = await post(MEERA, '/orders', { lines: [{ lotId: withdrawn, quantity: 1 }] });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/can no longer be ordered/);
  });
});

describe('dispatch', () => {
  it('follows the declared state machine and refuses a skip', async () => {
    const orders = (await get(VIKRAM, '/orders')).json<OrdersBody>();
    expect(orders.canAdvance).toBe(true);
    const placed = orders.orders.find((o) => o.state === 'placed');
    if (!placed) return;

    // placed → delivered is not a transition the machine declares.
    const skip = await post(VIKRAM, `/orders/${placed.id}/advance`, { to: 'delivered' });
    expect(skip.statusCode).toBe(409);
    expect(skip.json<{ detail: string }>().detail).toMatch(/cannot move to delivered/);

    const step = await post(VIKRAM, `/orders/${placed.id}/advance`, { to: 'packed' });
    expect(step.statusCode, step.body).toBe(200);
  });

  it('refuses a customer trying to advance their own order', async () => {
    const orders = (await get(MEERA, '/orders')).json<OrdersBody>();
    const mine = orders.orders[0];
    if (!mine) return;
    const res = await post(MEERA, `/orders/${mine.id}/advance`, { to: 'packed' });
    expect(res.statusCode).toBe(403);
  });
});

describe('the cold chain', () => {
  it('raises a CAPA automatically when a reading leaves the class', async () => {
    /**
     * The reason readings are stored as DATA rather than an attached PDF. A
     * cold-chain breach that depends on somebody noticing it in a chart is a
     * breach that gets noticed at the next audit.
     */
    const orders = (await get(VIKRAM, '/orders')).json<OrdersBody>();
    const order = orders.orders[0]!;

    const shipment = await post(VIKRAM, `/orders/${order.id}/shipment`, { temperatureClass: '2-8' });
    expect(shipment.statusCode, shipment.body).toBe(200);
    const shipmentId = shipment.json<{ id: string }>().id;

    const within = await post(VIKRAM, `/shipments/${shipmentId}/readings`, {
      readings: [{ readAt: '2026-08-20T08:00:00Z', celsius: 4.4 }],
    });
    expect(within.json<{ excursions: number; capaRaised: string | null }>().excursions).toBe(0);
    expect(within.json<{ capaRaised: string | null }>().capaRaised).toBeNull();

    const breach = await post(VIKRAM, `/shipments/${shipmentId}/readings`, {
      readings: [
        { readAt: '2026-08-20T12:00:00Z', celsius: 5.0 },
        { readAt: '2026-08-20T14:00:00Z', celsius: 15.2 },
      ],
    });
    const body = breach.json<{ excursions: number; capaRaised: string | null }>();
    expect(body.excursions).toBe(1);
    expect(body.capaRaised, 'an excursion must raise a CAPA').not.toBeNull();
    // From the configured counter, so it cannot collide with a seeded code.
    expect(body.capaRaised).toMatch(/^NCR-\d{4}$/);
  });
});

describe('price-tier claims', () => {
  it('is honest that an approved tier changes no price', async () => {
    // The permission exists, the workflow exists, and no tier price list does.
    // Saying so beats letting somebody infer a discount that never applies.
    const body = (await get(ARJUN, '/entitlements')).json<{ tierHasNoPriceEffect: boolean }>();
    expect(body.tierHasNoPriceEffect).toBe(true);
  });

  it('refuses a second open claim from the same organisation', async () => {
    await post(MEERA, '/entitlements', { supportingDocument: 'Registration GL-1' });
    const second = await post(MEERA, '/entitlements', { supportingDocument: 'Registration GL-2' });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a customer trying to decide their own claim', async () => {
    const claims = (await get(MEERA, '/entitlements')).json<{
      claims: Array<{ id: string; state: string }>; canDecide: boolean;
    }>();
    expect(claims.canDecide, 'a customer may claim, never decide').toBe(false);
    const open = claims.claims.find((c) => c.state === 'under_review');
    if (!open) return;
    const res = await post(MEERA, `/entitlements/${open.id}/decide`, { approve: true, note: 'me' });
    expect(res.statusCode).toBe(403);
  });
});

async function tenantId(): Promise<string> {
  const [row] = await app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  return (row as { id: string }).id;
}
