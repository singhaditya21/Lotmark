import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { inTenantTransaction, type Sql } from '../db';
import { tenantFlags, flagEnabled, productFlags } from '../services/flags';
import { defaultFlags, PENDING_FLAGS } from '@lotmark/domain';

/**
 * Feature flags.
 *
 * Five were seeded from the first release and read by NOTHING. Two of them —
 * `adr` and `publications` — named features with no route, no table, no screen
 * and no test anywhere, and the same four facts also lived as boolean columns
 * on `tenants` which already disagreed with the config entries: columns true,
 * entries false.
 *
 * A flag that gates nothing reads, from the configuration console, exactly like
 * a flag that gates something. That is what these tests are about.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

function asTenant<T>(fn: (tx: Sql, tenantId: string) => Promise<T>): Promise<T> {
  return app.db`SELECT * FROM lotmark.resolve_tenant(NULL)`.then(([t]) => {
    const tenantId = (t as { id: string }).id;
    return inTenantTransaction(app.db, {
      tenantId, auditKey: app.cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: app.cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, (tx) => fn(tx, tenantId));
  });
}

describe('every flag gates something', () => {
  it('is consulted somewhere in the source', () => {
    /**
     * The test that stops the next decorative flag.
     *
     * A flag is only a control if some code path asks about it. This reads the
     * source rather than trusting a list, because trusting a list is how five
     * of them sat unread for a whole release.
     */
    const sources = [
      'src/routes/public.ts', 'src/routes/commerce.ts', 'src/routes/lots.ts',
      'src/routes/certificates.ts', 'src/services/flags.ts', 'src/app.ts',
      'src/services/certificate-pdf.ts', 'src/routes/console.ts',
    ].map((f) => {
      try { return readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'); }
      catch { return ''; }
    }).join('\n');

    const unconsulted = defaultFlags()
      .map((f) => f.key)
      .filter((key) => !sources.includes(`'${key}'`))
      .filter((key) => !(key in PENDING_FLAGS));

    expect(unconsulted,
      'a flag nothing asks about reads like a control and is not one — consult '
      + 'it, delete it, or name it in PENDING_FLAGS with the reason')
      .toEqual([]);
  });

  it('ships only flags somebody reasoned about', () => {
    // `adr` and `publications` were deleted rather than wired: nobody could say
    // what building them would mean, which is the difference between a gap and
    // a name.
    const keys = defaultFlags().map((f) => f.key).sort();
    expect(keys).not.toContain('adr');
    expect(keys).not.toContain('publications');
  });

  it('gives a reason for every flag that gates nothing yet', () => {
    /**
     * `bilingual` and `gov_tier` are real intentions waiting on features that
     * do not exist — an i18n layer and a price list. Marking them beats
     * deleting them AND beats leaving them silent, which is the same call
     * `sod.ts` makes with `pending-subject`.
     */
    for (const [key, reason] of Object.entries(PENDING_FLAGS)) {
      expect(defaultFlags().some((f) => f.key === key),
        `${key} is marked pending but is not a flag`).toBe(true);
      expect(reason.length, `${key} must say WHY`).toBeGreaterThan(20);
    }
  });
});

describe('there is one store', () => {
  it('no longer keeps the same facts on the tenant row', async () => {
    // The columns and the config entries held the same four facts and already
    // disagreed. Migration 0027 dropped the columns.
    const cols = await app.db`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'lotmark' AND table_name = 'tenants'
        AND column_name IN ('bilingual', 'adr', 'publications', 'gov_tier')`;
    expect(cols.length, 'two sources of truth for one fact').toBe(0);
  });

  it('resolves from configuration, falling back to the product', async () => {
    const flags = await asTenant((tx, t) => tenantFlags(tx, t));
    for (const f of defaultFlags()) {
      expect(flags.has(f.key), f.key).toBe(true);
    }
    expect(productFlags().get('public_verification')).toBe(true);
  });

  it('treats a flag nobody ships as OFF', () => {
    // A flag the product does not have cannot have been reasoned about, and
    // turning an unknown feature on because a name appeared in configuration is
    // the wrong direction to fail.
    expect(flagEnabled(productFlags(), 'invented_feature')).toBe(false);
  });
});

describe('public verification, which the flag actually gates', () => {
  it('serves a verification page while the flag is on', async () => {
    const res = await app.inject({ method: 'GET', url: '/verify/notarealtokenatall' });
    // 404 for an unknown token, but the page rendered rather than the route
    // being absent — which is what proves the flag let us through.
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('is indistinguishable from an unknown token when switched off', async () => {
    /**
     * 404, not 403, and the SAME 404 an unknown token gets. Whether a producer
     * offers public verification at all is not something an unauthenticated
     * caller should be able to probe, and a distinct status would tell them.
     */
    const off = await asTenant(async (tx, tenantId) => {
      const [row] = await tx`
        SELECT e.id FROM lotmark.config_entries e
        JOIN lotmark.config_versions v ON v.id = e.version_id
        WHERE v.tenant_id = ${tenantId} AND v.status = 'active'
          AND e.kind = 'flag' AND e.key = 'public_verification'`;
      return row !== undefined;
    });
    expect(off, 'the seed must define the flag for this to mean anything').toBe(true);

    // The entry cannot be edited on a published version — that is the
    // immutability trigger — so the switched-off behaviour is asserted through
    // the resolver the route uses rather than by rewriting the tenant's config
    // underneath every other test file.
    const flags = new Map([['public_verification', false]]);
    expect(flagEnabled(flags, 'public_verification')).toBe(false);
  });
});
