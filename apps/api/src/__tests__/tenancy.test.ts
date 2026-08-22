import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { currentTenant, requireTenant, NoTenantError } from '../services/tenancy';

/**
 * One tenant per deployment, said once.
 *
 * Lotmark is single-tenant, deliberately — the reasoning is in
 * `services/tenancy.ts`. The multi-tenant machinery in the schema stays as
 * defence in depth, and the boundary that actually carries weight is producer
 * against CUSTOMER, which is `organisation_id` and is exercised on every
 * request.
 *
 * What these tests protect is not the decision. It is that the decision has one
 * home. It used to be assumed in three places, each with its own copy of the
 * query and its own silence about what `NULL` meant.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('the deployment has a tenant', () => {
  it('resolves it, with everything a request needs', async () => {
    const t = await currentTenant(app.db);
    expect(t).not.toBeNull();
    expect(t!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t!.slug.length).toBeGreaterThan(0);
    // Both are stamped onto every ledger entry, so a missing one is not a
    // cosmetic problem.
    expect(t!.timeSource.length).toBeGreaterThan(0);
    expect(t!.region.length).toBeGreaterThan(0);
  });

  it('resolves the same one every time', async () => {
    // `resolve_tenant(NULL)` orders by `created_at` and takes the first, so the
    // answer is stable rather than whichever row the planner reached first.
    const a = await currentTenant(app.db);
    const b = await currentTenant(app.db);
    expect(a!.id).toBe(b!.id);
  });

  it('says what to do when there is none', () => {
    // The message is the remedy. An unprovisioned deployment is the commonest
    // first-run state and "no tenant" alone tells nobody anything.
    expect(new NoTenantError().message).toMatch(/pnpm db:seed/);
    expect(requireTenant).toBeTypeOf('function');
  });
});

describe('the assumption has one home', () => {
  it('is resolved in exactly one production file', () => {
    /**
     * The test that stops it spreading again.
     *
     * `resolve_tenant(NULL)` reads as an innocuous default until you know that
     * NULL means "there is only one". Three files called it, none of them said
     * so, and a fourth was added the day the decision was still open. Now one
     * file calls it and carries the whole argument.
     */
    const roots = ['routes', 'plugins', 'services', 'jobs', 'http'];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__') walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        if (full.endsWith(path.join('services', 'tenancy.ts'))) continue;

        const src = readFileSync(full, 'utf8');
        // Comments may mention it; only a real call counts.
        if (/resolve_tenant\s*\(/.test(src.replace(/^\s*\*.*$/gm, ''))) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    };

    // fileURLToPath, not `.pathname`: a repository path containing a space
    // arrives percent-encoded otherwise, and scandir fails on it.
    const base = fileURLToPath(new URL('..', import.meta.url));
    for (const r of roots) walk(path.join(base, r));

    expect(offenders,
      'resolve the tenant through services/tenancy.ts, where the single-tenant '
      + 'decision is written down — not with a bare NULL that says nothing')
      .toEqual([]);
  });
});
