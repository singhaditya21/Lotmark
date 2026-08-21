import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * Parsed and validated once at boot. A missing or malformed value fails the
 * process immediately with a readable message, rather than surfacing as an
 * undefined halfway through a request three hours later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),

  DATABASE_URL: z.string().default('postgres://localhost:5432/lotmark_dev'),

  /**
   * The audit chain HMAC key.
   *
   * Set on every database session; the chain trigger refuses to append without
   * it. It deliberately lives OUTSIDE the database — an attacker with SQL
   * access must not also hold the key, or the chain proves nothing.
   */
  LOTMARK_AUDIT_KEY: z.string().min(16).default('dev-audit-key-change-me'),

  /** Session lifetime and the idle window that ends one early. */
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(480),
  IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),

  /**
   * How long a signing session stays "continuous" after a step-up.
   * 21 CFR 11 §11.200(a)(1)(ii): subsequent signings within a continuous
   * session may use one component; outside it, all components are required.
   */
  SIGNING_WINDOW_MINUTES: z.coerce.number().int().positive().max(60).default(15),

  /**
   * Where private signing keys live. Outside the database on purpose: an
   * attacker who compromises Postgres must not thereby be able to forge
   * signatures.
   */
  SIGNING_KEY_DIR: z.string().default('.keys'),

  /** Where the console is served from in development, for CORS and cookies. */
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  if (cfg.NODE_ENV === 'production' && cfg.LOTMARK_AUDIT_KEY === 'dev-audit-key-change-me') {
    // Running production on the published default key would make every chain in
    // every deployment forgeable by anyone who read this file.
    throw new Error('LOTMARK_AUDIT_KEY must be set to a real secret outside development.');
  }
  return cfg;
}

export const IDLE_WARNING_RATIO = 0.8;
