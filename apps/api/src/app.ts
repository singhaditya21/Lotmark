import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadConfig, type AppConfig } from './config';
import { createDb, type Sql } from './db';
import { registerAuthRoutes } from './routes/auth';
import { registerConsoleRoutes } from './routes/console';
import { registerWorkflowRoutes } from './routes/workflow';
import { registerValueRoutes } from './routes/values';
import { registerLotRoutes } from './routes/lots';
import { registerCreateRoutes } from './routes/create';
import { registerPublicRoutes } from './routes/public';
import { registerCertificateRoutes } from './routes/certificates';
import { registerCapaRoutes } from './routes/capa';
import { registerAdminConfigRoutes } from './routes/admin-config';
import { registerAdminPeopleRoutes } from './routes/admin-people';
import { registerOpsRoutes } from './routes/ops';
import { registerCommerceRoutes } from './routes/commerce';
import { registerConformanceRoutes } from './routes/conformance';
import { registerCustomFieldRoutes } from './routes/custom-fields';
import { KeyProvider } from './services/keys';
import { createCustody } from './services/custody';
import { DocumentStore } from './services/documents';
import type { RegisteredRoute } from './http/operations';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: AppConfig;
    db: Sql;
    keys: KeyProvider;
    documents: DocumentStore;
    /** Every route Fastify actually registered — see the onRoute hook below. */
    routeTable: RegisteredRoute[];
  }
}

/**
 * TRUST_PROXY as Fastify wants it.
 *
 * The environment has only strings, and Fastify means different things by the
 * boolean and the string, so the conversion has to happen rather than be left
 * to coercion. `loadConfig` has already refused every other shape — including a
 * hop count, which Fastify accepts and then ignores; see the note there.
 */
function parseTrustProxy(value: string): boolean | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const cfg = { ...loadConfig(), ...overrides };
  const app = Fastify({
    logger: cfg.NODE_ENV === 'test'
      ? false
      : { level: cfg.NODE_ENV === 'production' ? 'info' : 'debug' },
    // Trusting a forwarded header lets a client choose the IP that appears in
    // the security ledger and drives rate limiting. Only trust it behind a
    // proxy that actually sets it — which is why this is now configuration
    // rather than a hard-coded false: a deployment DOES sit behind a proxy, and
    // the honest answer differs per deployment. loadConfig checks the shape
    // everywhere and refuses blanket `true` in production.
    trustProxy: parseTrustProxy(cfg.TRUST_PROXY),
  });

  /**
   * What was ACTUALLY registered.
   *
   * Collected from Fastify itself rather than from a list somebody maintains,
   * because the whole value of the API description is that it cannot quietly
   * disagree with the server. A route added without a matching operation fails
   * the completeness test in openapi.test.ts; that test is the deliverable, and
   * the generated document is a by-product of it.
   *
   * Registered BEFORE any routes, since onRoute only sees what follows it.
   */
  const routeTable: RegisteredRoute[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // HEAD is generated automatically for every GET and describes nothing of
      // its own; OPTIONS likewise.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routeTable.push({ method, url: route.url });
    }
  });

  app.decorate('cfg', cfg);
  app.decorate('db', createDb(cfg));
  app.decorate('keys', new KeyProvider(
    (kind) => createCustody(kind, {
      keyDir: cfg.SIGNING_KEY_DIR,
      keychainService: cfg.KEYCHAIN_SERVICE,
    }),
    cfg.SIGNING_KEY_CUSTODY,
  ));
  app.decorate('documents', new DocumentStore(cfg.DOCUMENT_DIR));

  await app.register(helmet, {
    // The API serves JSON, plus one server-rendered HTML page at /verify/:token.
    // That page carries inline styles and nothing else — no script, no external
    // origin — so the policy allows exactly that and nothing more.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
  });

  await app.register(cookie, {
    parseOptions: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // Secure cookies do not travel over http, and the dev console is served
      // over http through a Vite proxy on the same origin. Forcing Secure here
      // would make signing in during development impossible.
      secure: cfg.NODE_ENV === 'production',
    },
  });

  await app.register(rateLimit, {
    global: false,
    // Keyed by IP. Per-identity throttling additionally lives in the sign-in
    // service, where it survives a restart and can be shown to an assessor.
    keyGenerator: (req) => req.ip,
  });

  /**
   * ── Two probes, because they answer two different questions ────────────────
   *
   * What was here before was one `/health` that queried the database, plus a
   * second `/api/v1/ops/alive` that queried the database, caught the failure,
   * and returned 200 with `database: 'unreachable'` in the body. A load
   * balancer reads the STATUS CODE. So the endpoint whose name promised
   * liveness kept an instance that could not reach its database in rotation,
   * reporting the outage politely to nobody, and the endpoint that would have
   * failed correctly was the one an orchestrator would not have been pointed at.
   *
   * The two questions an orchestrator actually asks:
   *
   *   /health/live   is this process running? Restart it if not. NO dependency
   *                  checks, deliberately — a liveness probe that fails on a
   *                  database outage makes every instance restart at once,
   *                  which turns a recoverable outage into a crash loop.
   *   /health/ready  can it serve a request? Take it out of rotation if not.
   *                  Non-200 when not, so the answer is in the status code and
   *                  not only in a body nobody parses.
   *
   * Both are unauthenticated and both say nothing about the data. A health
   * endpoint that leaks tenant counts is a reconnaissance endpoint.
   */
  app.get('/health/live', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/health/ready', async (_req, reply) => {
    const started = Date.now();
    let database = 'unreachable';
    let detail: string | null = null;
    try {
      await app.db`SELECT 1`;
      database = 'reachable';
    } catch (err) {
      // The reason, not just the verdict: "unreachable" alone sends an operator
      // to the wrong place about equally often as the right one.
      detail = err instanceof Error ? err.message : String(err);
    }
    const ready = database === 'reachable';
    return reply
      // 503 rather than 500: this instance is not ready, which is a statement
      // about availability and is retryable, not an error in the request.
      .code(ready ? 200 : 503)
      .send({
        status: ready ? 'ready' : 'not_ready',
        database,
        ...(detail === null ? {} : { detail }),
        checkedInMs: Date.now() - started,
        uptimeSeconds: Math.round(process.uptime()),
      });
  });

  await app.register(registerAuthRoutes, { prefix: '/api/v1/auth' });
  await app.register(registerConsoleRoutes, { prefix: '/api/v1' });
  await app.register(registerWorkflowRoutes, { prefix: '/api/v1' });
  await app.register(registerValueRoutes, { prefix: '/api/v1' });
  await app.register(registerLotRoutes, { prefix: '/api/v1' });
  await app.register(registerCreateRoutes, { prefix: '/api/v1' });
  await app.register(registerCertificateRoutes, { prefix: '/api/v1' });
  await app.register(registerCapaRoutes, { prefix: '/api/v1' });
  await app.register(registerAdminConfigRoutes, { prefix: '/api/v1' });
  await app.register(registerAdminPeopleRoutes, { prefix: '/api/v1' });
  await app.register(registerOpsRoutes, { prefix: '/api/v1' });
  await app.register(registerCommerceRoutes, { prefix: '/api/v1' });
  await app.register(registerConformanceRoutes, { prefix: '/api/v1' });
  await app.register(registerCustomFieldRoutes, { prefix: '/api/v1' });
  // Unauthenticated, deliberately: an auditor holding a printed certificate
  // must not need an account with the producer whose certificate is in question.
  await app.register(registerPublicRoutes, { prefix: '' });

  app.addHook('onClose', async () => { await app.db.end(); });
  return app;
}
