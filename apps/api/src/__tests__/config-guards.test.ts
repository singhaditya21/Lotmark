import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * What the process refuses to start on.
 *
 * ── Why these are worth a test at all ───────────────────────────────────────
 *
 * This system has never been deployed. Every check in here therefore guards a
 * situation that has never occurred, which is exactly the kind of code that
 * gets deleted by someone who cannot see what it was for — and the first time
 * anyone would find out is the first deployment, in the state the check exists
 * to prevent. The messages are asserted as well as the throwing, because a
 * refusal an operator cannot act on just moves the outage.
 */

/** A configuration that is valid, so each test can break exactly one thing. */
const production = {
  NODE_ENV: 'production',
  LOTMARK_AUDIT_KEY: 'a-real-secret-value-for-tests',
  DATABASE_URL: 'postgres://lotmark_app@db.internal:5432/lotmark',
  SIGNING_KEY_CUSTODY: 'env',
  PUBLIC_ORIGIN: 'https://certificates.example.org',
  SIGNING_KEY_DIR: '/srv/lotmark/keys',
  ANCHOR_KEY_DIR: '/srv/lotmark-signer/keys',
  DOCUMENT_DIR: '/srv/lotmark/documents',
} as const;

const load = (env: Record<string, string>) => loadConfig(env as NodeJS.ProcessEnv);

describe('NODE_ENV has to be stated', () => {
  it('refuses to start without it', () => {
    /**
     * The defect this replaces: NODE_ENV defaulted to 'development', so a
     * deployment that never set it got every production refusal in config.ts
     * silently disabled — the audit-key check, the custody check, and all of
     * the deployment checks below. The system was at its least safe where it
     * was least supervised, and nothing said so.
     */
    const { NODE_ENV: _omitted, ...withoutIt } = production;
    expect(() => load(withoutIt)).toThrow(/NODE_ENV is not set/);
    expect(() => load(withoutIt)).toThrow(/development, test or production/);
  });

  it('refuses a value that is not one of the three', () => {
    // 'prod' is the plausible typo, and under the old default it would have
    // been rejected too — but an EMPTY value would have been rejected only
    // because zod saw an empty string, which is luck rather than a guard.
    expect(() => load({ ...production, NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
    expect(() => load({ ...production, NODE_ENV: '' })).toThrow(/NODE_ENV/);
  });

  it('starts when it is stated', () => {
    expect(load({ ...production }).NODE_ENV).toBe('production');
    expect(load({ NODE_ENV: 'development' }).NODE_ENV).toBe('development');
  });
});

describe('settings that are declared and read by nothing', () => {
  /**
   * RUN_SCHEDULER and WEB_ORIGIN were both parsed by config.ts and read
   * nowhere. RUN_SCHEDULER was the worse of the two: worker.ts told operators
   * to set it on the API to run jobs inline, and setting it did nothing at all
   * — the API never constructs a Scheduler. An operator who followed the
   * instruction would have had an API running no scheduled jobs, with the first
   * symptom being a stability-monitoring CAPA that was never raised.
   */
  it('are not in the parsed configuration', () => {
    const cfg = load({ ...production }) as Record<string, unknown>;
    expect(Object.keys(cfg)).not.toContain('RUN_SCHEDULER');
    expect(Object.keys(cfg)).not.toContain('WEB_ORIGIN');
  });

  it('cannot come back: every setting in the schema is read by something', () => {
    /**
     * The general form of the defect, rather than the two instances of it.
     *
     * A setting that is parsed and never read is worse than a missing one,
     * because an operator who sets it believes they have configured something.
     * RUN_SCHEDULER was the proof: worker.ts told operators to set it on the
     * API to run jobs inline, the API never constructs a Scheduler, and the
     * first symptom would have been a stability CAPA that was never raised.
     *
     * So this asks the invariant of every key at once, and will catch the next
     * one without anybody remembering to add it here. The config file itself
     * and this test are excluded — a setting mentioned only where it is
     * declared, or only in the test asserting it is used, is not read.
     */
    const roots = [path.resolve(HERE, '..'), path.resolve(HERE, '../../scripts')];
    const config = path.resolve(HERE, '../config.ts');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(m?[tj]s)$/.test(entry) && full !== THIS_FILE && full !== config) files.push(full);
      }
    };
    for (const root of roots) walk(root);

    /**
     * Comments are stripped first, and that is not a detail.
     *
     * Without it this test passed for RUN_SCHEDULER while the only mention left
     * in the tree was worker.ts's note explaining that the setting had been
     * deleted — a comment ABOUT a dead setting satisfying a test that the
     * setting is alive. Explaining a removal has to remain possible, so the
     * scan has to mean "read by code" rather than "the string occurs".
     */
    const code = files
      .map((f) => readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'))
      .join('\n');

    const unread = Object.keys(load({ ...production }))
      .filter((key) => !new RegExp(`\\b${key}\\b`).test(code));
    expect(unread, 'declared in config.ts and read by nothing').toEqual([]);
  });
});

describe('PUBLIC_ORIGIN in production', () => {
  /**
   * Not a setting — a promise printed on paper. Every certificate carries
   * `${PUBLIC_ORIGIN}/verify/<token>` as the address an auditor is told to
   * check, and a printed certificate cannot be recalled.
   */
  it('refuses the localhost default a deployment would inherit', () => {
    const { PUBLIC_ORIGIN: _replaced, ...withoutIt } = production;
    expect(() => load(withoutIt)).toThrow(/points at this machine/);
    expect(() => load(withoutIt)).toThrow(/cannot be recalled/);
  });

  it('refuses every other spelling of this machine', () => {
    for (const origin of ['http://127.0.0.1:4000', 'https://[::1]:4000', 'http://0.0.0.0:4000']) {
      expect(() => load({ ...production, PUBLIC_ORIGIN: origin }), origin)
        .toThrow(/points at this machine/);
    }
  });

  it('refuses something that is not an origin at all', () => {
    // A bare hostname is the likely mistake, and it produces a verification URL
    // that resolves to nothing on the auditor's machine.
    expect(() => load({ ...production, PUBLIC_ORIGIN: 'certificates.example.org' }))
      .toThrow(/not an http or https origin/);
  });

  it('accepts a real public address', () => {
    expect(load({ ...production }).PUBLIC_ORIGIN).toBe('https://certificates.example.org');
  });

  it('leaves development alone', () => {
    // The default IS the right answer on a laptop; the console is served from it.
    expect(load({ NODE_ENV: 'development' }).PUBLIC_ORIGIN).toMatch(/localhost/);
  });
});

describe('TRUST_PROXY', () => {
  /**
   * `req.ip` is written into the audit ledger under 21 CFR 11 §11.10(e) and is
   * the key rate limiting counts against. Whoever can set X-Forwarded-For can
   * therefore choose what the audit trail says about where an act came from.
   */
  it('refuses blanket trust in production', () => {
    expect(() => load({ ...production, TRUST_PROXY: 'true' })).toThrow(/ANY client/);
    expect(() => load({ ...production, TRUST_PROXY: 'true' })).toThrow(/audit ledger/);
  });

  it('accepts a named proxy, a CIDR block, or a named set', () => {
    for (const value of ['false', '10.0.0.7', '10.0.0.0/8,192.168.1.1', 'loopback', 'fd00::1']) {
      expect(load({ ...production, TRUST_PROXY: value }).TRUST_PROXY, value).toBe(value);
    }
  });

  it('refuses a hop count, which Fastify accepts and ignores', () => {
    /**
     * Measured against fastify 5.12.1 before this was written: a request with
     * `X-Forwarded-For: 203.0.113.9` from 10.0.0.7 produced req.ip = 10.0.0.7
     * under `trustProxy: 2` — identical to `false`, and different from the
     * 203.0.113.9 that `trustProxy: '10.0.0.7'` produced. lib/request.js
     * returns `() => false` for a number deliberately. Accepting the form here
     * would let an operator configure proxy trust and get none.
     */
    expect(() => load({ ...production, TRUST_PROXY: '2' })).toThrow(/hop count does nothing/);
  });

  it('refuses a value Fastify would silently ignore, in every environment', () => {
    /**
     * The failure mode that made this worth checking at all: Fastify hands an
     * unrecognised value to proxy-addr as a subnet list, a list that parses to
     * nothing matches no address, and the result is indistinguishable from
     * `false`. An operator who wrote `yes` would see every request attributed
     * to the proxy and have nothing to tell them why.
     */
    expect(() => load({ ...production, TRUST_PROXY: 'yes' })).toThrow(/not an IP address/);
    expect(() => load({ NODE_ENV: 'development', TRUST_PROXY: 'yes' })).toThrow(/not an IP address/);
    expect(() => load({ ...production, TRUST_PROXY: '10.0.0.0/x' })).toThrow(/not a CIDR block/);
  });
});

describe('the signing key directory in production', () => {
  /**
   * The anchor key signs statements ABOUT the ledger this process writes. If
   * this process can read it, those statements attest to nothing — the whole
   * point of DATABASE_SIGNER_URL and ANCHOR_KEY_DIR being separate values is
   * that the API holds neither.
   */
  it('refuses a key directory that is the anchor key directory', () => {
    expect(() => load({ ...production, ANCHOR_KEY_DIR: production.SIGNING_KEY_DIR }))
      .toThrow(/attest to nothing/);
  });

  it('refuses one nested inside the other, either way round', () => {
    expect(() => load({ ...production, ANCHOR_KEY_DIR: '/srv/lotmark/keys/anchor' }))
      .toThrow(/overlaps ANCHOR_KEY_DIR/);
    expect(() => load({ ...production, SIGNING_KEY_DIR: '/srv/lotmark-signer/keys/record' }))
      .toThrow(/overlaps ANCHOR_KEY_DIR/);
  });

  it('refuses a key directory inside the document store', () => {
    // Documents are served to callers and copied wholesale by the DR drill, so
    // a private key in there leaves the building with them.
    expect(() => load({ ...production, SIGNING_KEY_DIR: '/srv/lotmark/documents/keys' }))
      .toThrow(/overlaps DOCUMENT_DIR/);
  });

  it('accepts directories that merely share a prefix', () => {
    // `.keys` and `.keys-anchor` are the shipped defaults and are NOT nested;
    // a string startsWith check would have called them an overlap.
    expect(() => load({
      ...production, SIGNING_KEY_DIR: '/srv/lotmark/.keys', ANCHOR_KEY_DIR: '/srv/lotmark/.keys-anchor',
    })).not.toThrow();
  });

  it('leaves development alone', () => {
    // A laptop has one working tree and the defaults do not overlap; the point
    // of this check is the deployment where somebody set both to /var/lotmark.
    expect(() => load({ NODE_ENV: 'development', SIGNING_KEY_DIR: '.k', ANCHOR_KEY_DIR: '.k' }))
      .not.toThrow();
  });
});
