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
import { KeyProvider } from './services/keys';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: AppConfig;
    db: Sql;
    keys: KeyProvider;
  }
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const cfg = { ...loadConfig(), ...overrides };
  const app = Fastify({
    logger: cfg.NODE_ENV === 'test'
      ? false
      : { level: cfg.NODE_ENV === 'production' ? 'info' : 'debug' },
    // Trusting a forwarded header lets a client choose the IP that appears in
    // the security ledger and drives rate limiting. Only trust it behind a
    // proxy that actually sets it.
    trustProxy: false,
  });

  app.decorate('cfg', cfg);
  app.decorate('db', createDb(cfg));
  app.decorate('keys', new KeyProvider(cfg.SIGNING_KEY_DIR));

  await app.register(helmet, {
    // The API serves JSON only; a restrictive default CSP is right and cheap.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
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

  app.get('/health', async () => {
    const [row] = await app.db`SELECT now() AS at`;
    return { status: 'ok', database: 'reachable', at: (row as { at: string }).at };
  });

  await app.register(registerAuthRoutes, { prefix: '/api/v1/auth' });
  await app.register(registerConsoleRoutes, { prefix: '/api/v1' });
  await app.register(registerWorkflowRoutes, { prefix: '/api/v1' });
  await app.register(registerValueRoutes, { prefix: '/api/v1' });
  await app.register(registerLotRoutes, { prefix: '/api/v1' });
  await app.register(registerCreateRoutes, { prefix: '/api/v1' });

  app.addHook('onClose', async () => { await app.db.end(); });
  return app;
}
