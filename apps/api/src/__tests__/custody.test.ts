import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DevFileCustody, EnvCustody, KeychainCustody, createCustody,
  PRODUCTION_GRADE, IMPLEMENTED,
} from '../services/custody';
import { loadConfig } from '../config';

const PEM =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MC4CAQAwBQYDK2VwBCIEIKh0aqn1P0xS4hLhKYvtZK6qnY0XWFrTgAQzzikOcVjV\n' +
  '-----END PRIVATE KEY-----\n';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const VERSION = 'test-v1';
/** A service name of its own, so a test never touches a real signing key. */
const TEST_SERVICE = 'lotmark.custody-test';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'lotmark-custody-'));
  dirs.push(d);
  return d;
}

const onMac = process.platform === 'darwin';

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (onMac) {
    try {
      execFileSync('security',
        ['delete-generic-password', '-a', `${TENANT}.${VERSION}`, '-s', TEST_SERVICE],
        { stdio: 'ignore' });
    } catch { /* already gone */ }
  }
});

describe('dev_file custody', () => {
  it('round-trips the key and writes it unreadable to anyone else', () => {
    const dir = scratch();
    const custody = new DevFileCustody(dir);
    expect(custody.read(TENANT, VERSION)).toBeNull();
    custody.write(TENANT, VERSION, PEM);
    expect(custody.read(TENANT, VERSION)).toBe(PEM);
    custody.remove(TENANT, VERSION);
    expect(custody.read(TENANT, VERSION)).toBeNull();
  });

  it('is honest that it is not fit for production', () => {
    expect(new DevFileCustody(scratch()).productionGrade).toBe(false);
    expect(PRODUCTION_GRADE.dev_file).toBe(false);
  });
});

describe('env custody', () => {
  it('reads a base64 key out of the environment', () => {
    const name = `LOTMARK_SIGNING_KEY_${`${TENANT}_${VERSION}`.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const custody = new EnvCustody({ [name]: Buffer.from(PEM).toString('base64') });
    expect(custody.read(TENANT, VERSION)).toBe(PEM);
  });

  it('refuses to write, rather than appearing to and losing the key', () => {
    // A process cannot put a value in its own environment in a way that
    // outlives it. Silently succeeding here would mint a key that vanishes at
    // the next restart, orphaning everything signed in between.
    expect(() => new EnvCustody({}).write(TENANT, VERSION, PEM)).toThrow(/Cannot write/);
  });
});

describe.skipIf(!onMac)('keychain custody', () => {
  it('round-trips the key through an encrypted envelope', () => {
    const dir = scratch();
    const custody = new KeychainCustody(TEST_SERVICE, dir);
    custody.write(TENANT, VERSION, PEM);
    expect(custody.read(TENANT, VERSION)).toBe(PEM);
  });

  it('does not leave the key readable on disk', () => {
    /**
     * The point of the class. Both halves are required: the file is
     * ciphertext, and the wrapping key is in the Keychain.
     */
    const dir = scratch();
    new KeychainCustody(TEST_SERVICE, dir).write(TENANT, VERSION, PEM);
    const file = path.join(dir, `${TENANT}.${VERSION}.enc`);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('BEGIN PRIVATE KEY');
    expect(raw).not.toContain(PEM.split('\n')[1]);
    expect(raw).toContain('lotmark-key-envelope-v1');
  });

  it('detects a tampered envelope instead of returning a wrong key', () => {
    // AES-GCM authenticates. A flipped byte must be refused, not decrypted into
    // something that is not the key that was stored.
    const dir = scratch();
    const custody = new KeychainCustody(TEST_SERVICE, dir);
    custody.write(TENANT, VERSION, PEM);
    const file = path.join(dir, `${TENANT}.${VERSION}.enc`);
    const lines = readFileSync(file, 'utf8').split('\n');
    const [iv, tag, ct] = lines[1]!.split(':');
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] = bytes[0]! ^ 0x01;
    writeFileSync(file, `${lines[0]}\n${iv}:${tag}:${bytes.toString('base64')}\n`);
    expect(() => custody.read(TENANT, VERSION)).toThrow(/failed authentication/);
  });

  it('refuses a Keychain item that is not a wrapping key', () => {
    /**
     * A regression guard for a real failure. An earlier version tried to put
     * the PEM itself in the Keychain; `security`'s prompt truncates at 128
     * characters silently and with a success status, leaving a 96-byte item
     * under exactly this account. Passing it to createCipheriv produces
     * "Invalid key length", which says nothing useful.
     */
    const dir = scratch();
    // Its own account, so the junk item cannot leak into another test.
    const version = `${VERSION}-junk`;
    const account = `${TENANT}.${version}`;
    const junk = 'A'.repeat(128);
    execFileSync('security',
      ['add-generic-password', '-a', account, '-s', TEST_SERVICE, '-U', '-w'],
      { input: `${junk}\n${junk}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
    // An envelope must exist, or read() returns null before consulting the Keychain.
    writeFileSync(path.join(dir, `${TENANT}.${version}.enc`),
      'lotmark-key-envelope-v1\nAAAA:BBBB:CCCC\n');
    expect(() => new KeychainCustody(TEST_SERVICE, dir).read(TENANT, version))
      .toThrow(/not a 32-byte wrapping key/);

    // Writing, unlike reading, may replace it: the plaintext key is in hand.
    const custody = new KeychainCustody(TEST_SERVICE, dir);
    custody.write(TENANT, version, PEM);
    expect(custody.read(TENANT, version)).toBe(PEM);
    custody.remove(TENANT, version);
  });

  it('reports a missing envelope as absent, and a missing wrapper as broken', () => {
    // These are different faults. "No key here" is normal on first use; "the
    // ciphertext is here but the wrapper is gone" is a key that cannot be
    // recovered, and must never be reported as the former — that would mint a
    // replacement and orphan every signature made under the real key.
    const dir = scratch();
    const custody = new KeychainCustody(TEST_SERVICE, dir);
    expect(custody.read(TENANT, 'never-written')).toBeNull();

    custody.write(TENANT, VERSION, PEM);
    execFileSync('security',
      ['delete-generic-password', '-a', `${TENANT}.${VERSION}`, '-s', TEST_SERVICE],
      { stdio: 'ignore' });
    expect(() => custody.read(TENANT, VERSION)).toThrow(/wrapping key is not in/);
  });

  it('removes both halves', () => {
    const dir = scratch();
    const custody = new KeychainCustody(TEST_SERVICE, dir);
    custody.write(TENANT, VERSION, PEM);
    custody.remove(TENANT, VERSION);
    expect(existsSync(path.join(dir, `${TENANT}.${VERSION}.enc`))).toBe(false);
    expect(custody.read(TENANT, VERSION)).toBeNull();
  });
});

describe('the classes that do not exist here', () => {
  it('refuses to construct kms or hsm, naming what would be needed', () => {
    // An adapter that "worked" by falling back to a file would print the word
    // `hsm` on a certificate backed by a laptop.
    for (const kind of ['kms', 'hsm'] as const) {
      expect(IMPLEMENTED[kind]).toBe(false);
      expect(() => createCustody(kind, { keyDir: scratch() }))
        .toThrow(/declared but not implemented/);
    }
  });
});

describe('the configuration guard', () => {
  const base = {
    LOTMARK_AUDIT_KEY: 'a-real-secret-value-for-tests',
    DATABASE_URL: 'postgres://localhost:5432/x',
  };

  it('refuses a custody class this build cannot construct', () => {
    expect(() => loadConfig({ ...base, SIGNING_KEY_CUSTODY: 'hsm' } as NodeJS.ProcessEnv))
      .toThrow(/not implemented in this build/);
  });

  it('refuses a development key file in production', () => {
    /**
     * The guard that matters. Without it a production deployment signs every
     * certificate with a file on a server disk while the footer says so in
     * small print that nobody reads.
     */
    expect(() => loadConfig({
      ...base, NODE_ENV: 'production', SIGNING_KEY_CUSTODY: 'dev_file',
    } as NodeJS.ProcessEnv)).toThrow(/not fit for production/);
  });

  it('allows env custody in production', () => {
    const cfg = loadConfig({
      ...base, NODE_ENV: 'production', SIGNING_KEY_CUSTODY: 'env',
    } as NodeJS.ProcessEnv);
    expect(cfg.SIGNING_KEY_CUSTODY).toBe('env');
  });

  it('allows the development classes in development', () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).SIGNING_KEY_CUSTODY).toBe('dev_file');
  });
});
