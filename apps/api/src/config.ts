import { z } from 'zod';
import { PRODUCTION_GRADE, IMPLEMENTED, ALL_CUSTODY_CLASSES, type CustodyClass } from './services/custody';

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

  /**
   * Connects as `lotmark_app`, never as a superuser or the schema owner: a
   * superuser bypasses row-level security unconditionally, so the tenant
   * isolation policies would simply not apply.
   */
  DATABASE_URL: z.string().default('postgres://lotmark_app@localhost:5432/lotmark_dev'),

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

  /**
   * How the private signing key is held — see services/custody.ts.
   *
   * This value is PRINTED ON EVERY CERTIFICATE the key signs, so it is checked
   * at boot rather than trusted: a class that this build cannot construct, or
   * that is not fit for production, stops the process instead of quietly
   * putting a claim on a document.
   */
  SIGNING_KEY_CUSTODY: z.enum(['dev_file', 'env', 'keychain', 'kms', 'hsm']).default('dev_file'),
  KEYCHAIN_SERVICE: z.string().default('lotmark.signing-key'),

  /**
   * The OWNER connection, used only by the scheduler.
   *
   * pg-boss maintains its own schema and needs DDL, which the application role
   * deliberately does not have. Job HANDLERS still use DATABASE_URL, so the
   * work itself remains subject to row-level security.
   */
  DATABASE_ADMIN_URL: z.string().default('postgres://localhost:5432/lotmark_dev'),

  /**
   * The SIGNER's connection and key directory.
   *
   * A separate database role that can read the ledger and insert anchors, and
   * nothing else — and a key directory the API's own SIGNING_KEY_DIR does not
   * point at. The application must be unable to read the anchor key or write
   * the table attesting to its own ledger, or the attestation is worth exactly
   * what the ledger is.
   */
  DATABASE_SIGNER_URL: z.string().default('postgres://lotmark_signer@localhost:5432/lotmark_dev'),
  ANCHOR_KEY_DIR: z.string().default('.keys-anchor'),

  /** Run the scheduler in this process. Off for the API, on for the worker. */
  RUN_SCHEDULER: z.coerce.boolean().default(false),

  /** Where rendered certificates are stored, content-addressed by digest. */
  DOCUMENT_DIR: z.string().default('.documents'),

  /** The origin printed on certificates for the public verification page. */
  PUBLIC_ORIGIN: z.string().default('http://localhost:5173'),

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

  const custody = cfg.SIGNING_KEY_CUSTODY as CustodyClass;

  /**
   * A custody class the build cannot construct is refused everywhere, not just
   * in production. Selecting `hsm` on a machine with no HSM must fail loudly at
   * boot; the alternative is discovering it when a certificate has already been
   * issued claiming hardware protection it never had.
   */
  if (!IMPLEMENTED[custody]) {
    const usable = ALL_CUSTODY_CLASSES.filter((c) => IMPLEMENTED[c]);
    throw new Error(
      `SIGNING_KEY_CUSTODY='${custody}' is not implemented in this build` +
      (custody === 'keychain' ? ` (it needs macOS; this is ${process.platform})` : '') +
      `. Available here: ${usable.join(', ')}.`,
    );
  }

  /**
   * The guard that matters. A development key file surviving into production
   * would mean every signature was backed by a file on a server disk, while the
   * certificate footer said so in small print that nobody reads.
   */
  if (cfg.NODE_ENV === 'production' && !PRODUCTION_GRADE[custody]) {
    throw new Error(
      `SIGNING_KEY_CUSTODY='${custody}' is not fit for production. ` +
      'Use env custody with a secrets manager, or implement the kms or hsm adapter. ' +
      'This value is printed on every certificate; running production on it would ' +
      'be an accurate statement of a bad situation rather than a good one.',
    );
  }

  return cfg;
}

export const IDLE_WARNING_RATIO = 0.8;
