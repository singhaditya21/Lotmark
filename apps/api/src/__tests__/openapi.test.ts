import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { OPERATIONS, routeKey } from '../http/operations';
import { buildOpenApi } from '../http/openapi';
import { ALL_PERMISSIONS } from '@lotmark/domain';

/**
 * The API description cannot drift from the API.
 *
 * This is the deliverable of the OpenAPI work; the document is a by-product.
 * A hand-written specification is worth exactly as much as its agreement with
 * the server, and hand-written ones stop agreeing within a release.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('every route is described, and every description has a route', () => {
  it('has no undocumented route', () => {
    const described = new Set(OPERATIONS.map(routeKey));
    const undocumented = app.routeTable
      .map(routeKey)
      .filter((k) => !described.has(k))
      .sort();
    expect(
      undocumented,
      'add an entry to src/http/operations.ts for each of these — there is no allowlist',
    ).toEqual([]);
  });

  it('describes nothing that does not exist', () => {
    /**
     * The more insidious direction. A description of a route that has been
     * removed still reads as documentation, and somebody will build against it.
     */
    const real = new Set(app.routeTable.map(routeKey));
    const phantom = OPERATIONS.map(routeKey).filter((k) => !real.has(k)).sort();
    expect(phantom, 'these are described but not registered').toEqual([]);
  });

  it('describes each route exactly once', () => {
    const seen = new Map<string, number>();
    for (const o of OPERATIONS) seen.set(routeKey(o), (seen.get(routeKey(o)) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });
});

describe('what each description has to say', () => {
  it('names a permission this system actually enforces', () => {
    // A permission that is not in the vocabulary is a capability nothing
    // checks, and naming one here would describe a control that does not exist.
    for (const o of OPERATIONS) {
      if (o.permission === null) continue;
      expect(o.requiresSession, `${routeKey(o)} names a permission, so it needs a session`).toBe(true);
      expect(ALL_PERMISSIONS as readonly string[], routeKey(o)).toContain(o.permission);
    }
  });

  it('makes every unauthenticated operation justify itself', () => {
    /**
     * A route reachable with no session is either a deliberate decision or a
     * route that forgot `requireSession`, and in the document those look
     * identical. Requiring a reason is what makes the second one visible: it
     * cannot be added without somebody writing down why.
     *
     * Permission-less-but-authenticated operations need no such note — signing
     * out and asking who you are do not require justifying.
     */
    for (const o of OPERATIONS) {
      if (o.requiresSession) continue;
      expect(o.note, `${routeKey(o)} is reachable without a session and must say why`).toBeTruthy();
    }
  });

  it('summarises every operation in plain words', () => {
    for (const o of OPERATIONS) {
      expect(o.summary.length, routeKey(o)).toBeGreaterThan(10);
      expect(o.summary, `${routeKey(o)} should not just restate its path`)
        .not.toMatch(/^(GET|POST|PUT|DELETE)\b/i);
    }
  });
});

describe('the generated document', () => {
  it('is valid OpenAPI 3.1 with a path for every operation', () => {
    const doc = buildOpenApi();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();

    const described = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`));
    expect(described.length).toBe(OPERATIONS.length);
  });

  it('renders path parameters in OpenAPI form, not Fastify form', () => {
    // Fastify writes /certificates/:id; OpenAPI writes /certificates/{id}. A
    // document carrying the wrong one generates clients that 404.
    const doc = buildOpenApi();
    for (const path of Object.keys(doc.paths)) {
      expect(path, 'a colon parameter leaked into the document').not.toMatch(/:/);
    }
    expect(Object.keys(doc.paths)).toContain('/api/v1/certificates/{id}');
  });

  it('declares every path parameter it uses', () => {
    const doc = buildOpenApi();
    for (const [path, item] of Object.entries(doc.paths)) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, operation] of Object.entries(item)) {
        const declared = (operation.parameters ?? []).map((p) => p.name);
        for (const name of inPath) {
          expect(declared, `${method.toUpperCase()} ${path} must declare {${name}}`)
            .toContain(name);
        }
      }
    }
  });

  it('marks the unauthenticated operations, and only those', () => {
    /**
     * Four operations are reachable without a session, each on purpose. If a
     * fifth appears here it is either a deliberate decision somebody should
     * see, or a route that forgot requireSession.
     */
    const doc = buildOpenApi();
    const open: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (operation.security?.length === 0) open.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(open.sort()).toEqual([
      'GET /health/live',
      'GET /health/ready',
      'GET /verify/{token}',
      'POST /api/v1/auth/sign-in',
    ]);
  });
});
