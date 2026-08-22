import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

/**
 * The two probes an orchestrator reads.
 *
 * ── What this replaces, and why it was worth replacing ──────────────────────
 *
 * `/api/v1/ops/alive` caught the database failure, put `database:
 * 'unreachable'` in the body, and returned 200. A load balancer reads the
 * STATUS CODE and nothing else, so the endpoint reported the outage in a field
 * that nothing on the path between the instance and the traffic would ever
 * parse — and kept routing requests to an instance that could not serve one.
 *
 * The assertion that matters in this file is therefore about status codes.
 * Bodies are checked too, for the human reading them during an incident.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ NODE_ENV: 'test' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('/health/live', () => {
  it('is 200 while the process answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(res.json()['uptimeSeconds']).toBeTypeOf('number');
  });

  it('says nothing about the database', async () => {
    /**
     * Deliberate, and the reason there are two endpoints rather than one. A
     * liveness probe that fails during a database outage makes every instance
     * restart simultaneously, turning a recoverable outage into a crash loop —
     * and restarting a process cannot fix a database that is down.
     */
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(Object.keys(res.json())).not.toContain('database');
  });
});

describe('/health/ready', () => {
  it('is 200 with the database reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', database: 'reachable' });
  });

  it('is 503 when the database is not reachable', async () => {
    /**
     * The whole point. This is the case `/ops/alive` answered 200 to.
     *
     * A separate app on a database that does not exist, rather than a stubbed
     * `db`, because the failure being tested is the one a deployment actually
     * has: a connection that cannot be made. postgres.js connects lazily, so
     * the failure surfaces exactly where the handler catches it.
     */
    const broken = await buildApp({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://localhost:5432/lotmark_no_such_database',
    });
    await broken.ready();
    try {
      const res = await broken.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode, 'an instance that cannot reach its database is not ready').toBe(503);
      expect(res.json()).toMatchObject({ status: 'not_ready', database: 'unreachable' });

      /*
       * And it must SAY WHY. The handler's comment promises "the reason, not
       * just the verdict", and it delivered the empty string for the commonest
       * production failure there is — postgres.js raises an Error whose detail
       * is on `code` (ECONNREFUSED, ENOTFOUND) with nothing in `message`, so
       * `err.message` was blank exactly when an operator most needs it.
       */
      const detail = res.json<{ detail?: string }>().detail;
      expect(detail, 'not_ready without a reason sends an operator to the wrong place')
        .toBeTruthy();
      /*
       * A code and then a sentence. This fixture points at a missing DATABASE
       * on a reachable host, so the code is the SQLSTATE 3D000; a missing HOST
       * gives ENOTFOUND and a closed port gives ECONNREFUSED. All three were
       * measured against a running process. The shape is what is asserted,
       * because the exact text belongs to the driver.
       */
      expect(detail).toMatch(/^[A-Z0-9]+: .+|did not answer/);
      expect(res.json()['detail'], 'and it says what failed').toBeTruthy();
    } finally {
      await broken.close();
    }
  });
});

describe('what was there before', () => {
  it('has no /ops/alive', async () => {
    // Removed rather than left as an alias: an endpoint that answers 200
    // regardless of the answer is worse than no endpoint, because something
    // will be pointed at it.
    const res = await app.inject({ method: 'GET', url: '/api/v1/ops/alive' });
    expect(res.statusCode).toBe(404);
  });

  it('has no bare /health either', async () => {
    // It queried the database and was named for liveness — the two questions
    // conflated, which is what made the pair above necessary.
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(404);
  });
});
