import { isIP } from 'node:net';
import path from 'node:path';
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
  /**
   * Stated, never assumed.
   *
   * This used to default to 'development', which meant every refusal below that
   * is conditional on production — the audit-key check, the custody check, and
   * the deployment checks added since — silently did not apply to a deployment
   * that simply forgot to set it. The system was at its least safe exactly where
   * it was least supervised, and nothing said so. There is no safe default here:
   * defaulting to production instead would break every developer's laptop into a
   * refusal it cannot satisfy, so the value is required.
   */
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    required_error:
      'NODE_ENV is not set. It must be stated: development, test or production. ' +
      'Every production refusal in this file is conditional on it, so an unset ' +
      'NODE_ENV would turn all of them off. For a local process: NODE_ENV=development.',
  }),
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

  /**
   * Which audit key generation this process writes under.
   *
   * The ledger records it on every entry, and migration 0019 binds it to a
   * commitment so an entry cannot be written under a key that is not the
   * generation's. Rotation is `pnpm --filter @lotmark/api audit:rotate`.
   */
  LOTMARK_AUDIT_KEY_GENERATION: z.string().min(1).default('v1'),

  /**
   * RETIRED audit keys, as JSON mapping generation to key, e.g.
   * {"v1":"...","v2":"..."}.
   *
   * Needed only to VERIFY history written before the current rotation. Absent,
   * verification reports those generations as unverified — which is honest, and
   * deliberately not the same as reporting them broken.
   */
  LOTMARK_AUDIT_KEYS: z.string().optional(),

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

  /** Where rendered certificates are stored, content-addressed by digest. */
  DOCUMENT_DIR: z.string().default('.documents'),

  /** The origin printed on certificates for the public verification page. */
  PUBLIC_ORIGIN: z.string().default('http://localhost:5173'),

  /**
   * Which proxy, if any, may set the client address.
   *
   * `req.ip` is written into the audit ledger and keys rate limiting, so
   * whoever can set `X-Forwarded-For` can choose what the 21 CFR 11 audit trail
   * says about where an act came from. Handed to Fastify's `trustProxy`:
   *
   *   false                  trust nothing — the socket address (the default)
   *   10.0.0.7,10.0.0.8      trust only these; addresses and CIDR blocks
   *   loopback               the named sets proxy-addr understands
   *   true                   trust ANY client's header — refused in production
   *
   * A hop COUNT is deliberately not accepted, although Fastify documents one.
   * Measured against fastify 5.12.1: `trustProxy: 2` produced the socket
   * address for a request carrying `X-Forwarded-For: 203.0.113.9` — byte for
   * byte what `false` produced. lib/request.js returns `() => false` for a
   * number, on purpose ("Hop-count-only trust cannot validate the immediate
   * peer. Fail closed"). Accepting the form would let an operator configure
   * proxy trust, believe they had it, and get none.
   */
  TRUST_PROXY: z.string().default('false'),
});

export type AppConfig = z.infer<typeof schema>;

/** The named address sets `proxy-addr` understands, which Fastify passes through. */
const PROXY_ADDRESS_SETS = ['loopback', 'linklocal', 'uniquelocal'];

/**
 * What is wrong with a TRUST_PROXY value, or null.
 *
 * Shape only — whether the value is ALLOWED here is a separate question asked
 * below, in production. The shape is checked everywhere because a typo is a typo
 * everywhere, and this one fails silently: Fastify hands anything it does not
 * recognise to proxy-addr as a subnet list, an unparseable list matches no
 * address, and the result is indistinguishable from `false`. An operator who
 * wrote `TRUST_PROXY=yes` would see every request attributed to the proxy and
 * have nothing to tell them why.
 */
function trustProxyProblem(value: string): string | null {
  if (value === 'true' || value === 'false') return null;
  if (/^\d+$/.test(value)) {
    return 'a hop count does nothing in this version of Fastify — it fails closed and ' +
      'behaves exactly like false, so configuring one would give you no proxy trust ' +
      'while looking like it had';
  }
  for (const entry of value.split(',').map((s) => s.trim())) {
    if (entry === '') return 'it has an empty entry';
    if (PROXY_ADDRESS_SETS.includes(entry)) continue;
    const [address, prefix, ...rest] = entry.split('/');
    if (rest.length > 0 || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      return `'${entry}' is not a CIDR block`;
    }
    if (isIP(address ?? '') === 0) {
      return `'${entry}' is not an IP address, a CIDR block, or one of ${PROXY_ADDRESS_SETS.join(', ')}`;
    }
  }
  return null;
}

/** Whether two configured directories are the same place, or one is inside the other. */
function overlap(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return x === y || x.startsWith(`${y}${path.sep}`) || y.startsWith(`${x}${path.sep}`);
}

/** Hostnames that mean "this machine", and so cannot be a deployment's public address. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]', '[::]'];

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

  /**
   * A malformed proxy setting is refused everywhere — see trustProxyProblem for
   * why the failure would otherwise be invisible.
   */
  const proxyProblem = trustProxyProblem(cfg.TRUST_PROXY);
  if (proxyProblem !== null) {
    throw new Error(
      `TRUST_PROXY='${cfg.TRUST_PROXY}' cannot be used: ${proxyProblem}. ` +
      'Write false to trust nothing, or name the proxy: its address, a CIDR block, ' +
      `a comma-separated list of either, or a named set (${PROXY_ADDRESS_SETS.join(', ')}).`,
    );
  }

  if (cfg.NODE_ENV !== 'production') return cfg;

  /* ── Everything below here is about being deployed ──────────────────────────
   *
   * These are the checks that have no development equivalent, so they had no
   * chance to be exercised before the first deployment. Each one refuses at boot
   * rather than at the moment the damage would show: a certificate carrying an
   * unreachable verification address is already printed, and an audit entry
   * carrying an attacker's chosen IP is already in an append-only ledger.
   */

  /**
   * PUBLIC_ORIGIN is not a setting, it is a promise printed on paper.
   *
   * Every certificate carries `${PUBLIC_ORIGIN}/verify/<token>` as the address
   * an auditor is told to check, and a certificate cannot be un-printed. The
   * default is a developer's Vite server, so a deployment that never set this
   * would issue certificates directing every third-party auditor to their own
   * laptop.
   */
  let publicOrigin: URL | null = null;
  try {
    publicOrigin = new URL(cfg.PUBLIC_ORIGIN);
  } catch { /* reported below */ }
  if (publicOrigin === null || !['http:', 'https:'].includes(publicOrigin.protocol)) {
    throw new Error(
      `PUBLIC_ORIGIN='${cfg.PUBLIC_ORIGIN}' is not an http or https origin. ` +
      'It is printed on every certificate as the address an auditor is told to ' +
      'visit, so it must be the address this deployment is actually reachable at, ' +
      'e.g. https://certificates.example.org.',
    );
  }
  if (LOOPBACK_HOSTS.includes(publicOrigin.hostname)) {
    throw new Error(
      `PUBLIC_ORIGIN='${cfg.PUBLIC_ORIGIN}' points at this machine. Every certificate ` +
      'issued would tell an auditor to verify it at their own computer, and a printed ' +
      'certificate cannot be recalled. Set it to the public address of this deployment ' +
      'before starting it in production.',
    );
  }

  /**
   * Blanket proxy trust hands the audit trail to whoever is calling.
   *
   * With `true`, Fastify takes the leftmost `X-Forwarded-For` value from any
   * client, and that value becomes `req.ip` — which is recorded against every
   * act in the ledger (21 CFR 11 §11.10(e)) and is the key rate limiting counts
   * against. An attacker would choose both: an audit trail naming somebody else,
   * and a fresh rate-limit bucket per request.
   */
  if (cfg.TRUST_PROXY === 'true') {
    throw new Error(
      'TRUST_PROXY=true trusts the X-Forwarded-For header from ANY client. The address ' +
      'it produces is written into the audit ledger and keys rate limiting, so blanket ' +
      'trust lets a caller choose what the audit trail says about them. Name the proxy ' +
      'instead — its address or CIDR block — or set TRUST_PROXY=false if nothing sits ' +
      'in front of this process.',
    );
  }

  /**
   * Two key directories that are one directory.
   *
   * The anchor key signs statements ABOUT the ledger, and the API must not be
   * able to read it: a component that can write the ledger and also sign
   * attestations about it attests to nothing. That separation is enforced by
   * these being different directories owned by different OS users — so a
   * deployment that pointed both at the same place would have kept the two
   * config values and lost the property they exist for. The same for documents:
   * DOCUMENT_DIR is content the application serves and the DR drill copies
   * wholesale, and a private key inside it is a private key in a backup tarball
   * that is not treated as one.
   */
  for (const [name, dir] of [['ANCHOR_KEY_DIR', cfg.ANCHOR_KEY_DIR], ['DOCUMENT_DIR', cfg.DOCUMENT_DIR]] as const) {
    if (overlap(cfg.SIGNING_KEY_DIR, dir)) {
      throw new Error(
        `SIGNING_KEY_DIR='${cfg.SIGNING_KEY_DIR}' overlaps ${name}='${dir}': ` +
        `${path.resolve(cfg.SIGNING_KEY_DIR)} and ${path.resolve(dir)} are the same place, ` +
        'or one is inside the other. ' +
        (name === 'ANCHOR_KEY_DIR'
          ? 'The anchor key signs statements about the ledger this process writes; if this ' +
            'process can read it, those statements attest to nothing. Give the signer its own ' +
            'directory, owned by its own OS user.'
          : 'Documents are served to callers and copied wholesale by the DR drill, so a ' +
            'signing key inside that directory leaves the building with them.'),
      );
    }
  }

  return cfg;
}

export const IDLE_WARNING_RATIO = 0.8;
