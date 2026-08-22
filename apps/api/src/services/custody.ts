import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';

/** Identifies the on-disk envelope format, so a future change can be told apart. */
const ENVELOPE_HEADER = 'lotmark-key-envelope-v1';

/**
 * Where a private signing key actually lives.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * The key never enters the database — an attacker who compromises Postgres must
 * not thereby be able to forge signatures, or the §11.70 argument collapses.
 * That leaves the question of where it DOES live, and the answer is printed on
 * every certificate the key signs, right after the key version.
 *
 * Making that an interface rather than a hard-coded file path means moving to a
 * KMS or an HSM is a configuration change and a recorded custody move, rather
 * than a rewrite of the signing path. It also means the honest answer for each
 * class is written down in one place, next to the code that implements it.
 *
 * ── What is honestly available here, and what is not ────────────────────────
 *
 * `dev_file` and `keychain` both work on this machine. `env` works anywhere.
 * `kms` and `hsm` do NOT exist: there is no cloud account and no hardware
 * module, and an adapter that pretended otherwise would put a false custody
 * class on a certificate. They fail at construction with a message saying what
 * would be needed, which is the only truthful thing to do.
 *
 * None of these is a substitute for the others. `keychain` is a real
 * improvement over a file in the working tree and is still a laptop, so it is
 * not marked production-grade.
 */

export type CustodyClass = 'dev_file' | 'env' | 'keychain' | 'kms' | 'hsm';

export interface KeyCustody {
  readonly kind: CustodyClass;
  /** One line, for logs and for explaining the class to an operator. */
  readonly describe: string;
  /**
   * Whether this class may be used outside development.
   *
   * Read this as documentation on the instance. The ENFORCEMENT is not here —
   * `loadConfig` refuses to boot a production process by consulting the
   * `PRODUCTION_GRADE` table at the foot of this file, because that check has
   * to run before anything is constructed. The two must agree; they are two
   * views of one fact about the class.
   *
   * The wording here used to say `loadConfig` refused "on a class that is false
   * here", which sent a reader looking for a reader of this property and
   * finding none — the check is real, and it is fifty lines further down.
   */
  readonly productionGrade: boolean;

  read(tenantId: string, keyVersion: string): string | null;
  write(tenantId: string, keyVersion: string, privateKeyPem: string): void;
  /** Remove the key from this store, after it has been written to another. */
  remove(tenantId: string, keyVersion: string): void;
}

/* ── dev_file ─────────────────────────────────────────────────────────────── */

/**
 * A mode-0600 file under a gitignored directory.
 *
 * Honest about what it is: anyone who can read the working tree, any backup
 * that includes it, and any process running as this user can read the key.
 */
export class DevFileCustody implements KeyCustody {
  readonly kind = 'dev_file' as const;
  readonly describe: string;
  readonly productionGrade = false;

  constructor(private readonly dir: string) {
    this.describe = `mode-0600 files under ${dir}`;
  }

  private at(tenantId: string, keyVersion: string): string {
    return path.join(this.dir, `${tenantId}.${keyVersion}.pem`);
  }

  read(tenantId: string, keyVersion: string): string | null {
    const p = this.at(tenantId, keyVersion);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  write(tenantId: string, keyVersion: string, pem: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = this.at(tenantId, keyVersion);
    writeFileSync(p, pem, { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  remove(tenantId: string, keyVersion: string): void {
    rmSync(this.at(tenantId, keyVersion), { force: true });
  }
}

/* ── env ──────────────────────────────────────────────────────────────────── */

/**
 * The key injected through the environment, base64-encoded.
 *
 * The standard shape for a container whose secrets manager populates the
 * environment at start-up, and the only class here that is honestly usable in
 * production. Its limits are real and worth stating: the value is visible to
 * anything that can read the process environment, it cannot be rotated without
 * a restart, and it is easy to leak into a crash dump or a log line that prints
 * `process.env`.
 *
 * Read-only by construction. A process cannot write to its own environment in a
 * way that outlives it, and pretending otherwise would silently lose a key.
 */
export class EnvCustody implements KeyCustody {
  readonly kind = 'env' as const;
  readonly describe = 'base64 in the process environment, injected by a secrets manager';
  readonly productionGrade = true;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private name(tenantId: string, keyVersion: string): string {
    // Uppercased with separators normalised, because environment variable names
    // cannot carry hyphens in every shell that might set them.
    return `LOTMARK_SIGNING_KEY_${`${tenantId}_${keyVersion}`.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  }

  read(tenantId: string, keyVersion: string): string | null {
    const raw = this.env[this.name(tenantId, keyVersion)];
    return raw ? Buffer.from(raw, 'base64').toString('utf8') : null;
  }

  write(tenantId: string, keyVersion: string, _privateKeyPem?: string): void {
    throw new Error(
      `Cannot write a signing key into the environment. Set ${this.name(tenantId, '<version>')} ` +
      'from your secrets manager before starting the process, or generate the key under ' +
      'another custody class and move it.',
    );
  }

  remove(): void {
    throw new Error('A key held in the environment is removed by not setting it.');
  }
}

/* ── keychain ─────────────────────────────────────────────────────────────── */

/** Exit code `security` uses for "the item is not in the keychain". */
const SEC_ITEM_NOT_FOUND = 44;

/**
 * The hard limit on a value written through the `security` prompt.
 *
 * MEASURED, not documented anywhere: 128 characters go in and come back; 129 go
 * in and 128 come back, with a zero exit status and no warning. A silent
 * truncation of a private key is about the worst failure this module could
 * have, so the limit is asserted rather than trusted.
 */
const KEYCHAIN_PROMPT_LIMIT = 128;

/** AES-256 needs exactly this. */
const WRAPPING_KEY_BYTES = 32;

/**
 * The macOS Keychain, holding a wrapping key rather than the signing key.
 *
 * ── Why the key itself is not in the Keychain ───────────────────────────────
 *
 * It does not fit. `security add-generic-password` can be fed a value on stdin
 * — which is the only way to keep a secret out of argv, where `ps` would show
 * it to every user on the machine — but the prompt that reads it truncates at
 * 128 characters, silently and with a success exit code. A base64-encoded
 * Ed25519 private key is 160. Storing one that way appears to work and produces
 * a key that cannot be decoded; the first symptom would be a signature that
 * will not verify.
 *
 * ── What happens instead ────────────────────────────────────────────────────
 *
 * The Keychain holds a 32-byte wrapping key (44 characters of base64, well
 * inside the limit). The signing key sits beside the other key material on disk
 * encrypted with AES-256-GCM under it.
 *
 * This is better than the naive version would have been even if it had fit.
 * Both halves are now required: a stolen working tree, a backup tarball or a
 * clone of the repository yields only ciphertext, and the Keychain half needs
 * an unlocked keychain on that specific machine. GCM also means tampering with
 * the file is detected rather than producing a subtly wrong key.
 *
 * It is still NOT production key custody, and is not marked as such. A desktop
 * keychain is tied to one login session on one machine, with no access policy
 * worth auditing and no rotation story.
 */
export class KeychainCustody implements KeyCustody {
  readonly kind = 'keychain' as const;
  readonly describe = 'AES-256-GCM on disk under a wrapping key held in the macOS Keychain';
  readonly productionGrade = false;

  constructor(
    private readonly service = 'lotmark.signing-key',
    private readonly dir = '.keys',
  ) {
    if (process.platform !== 'darwin') {
      throw new Error(
        `Keychain custody needs macOS; this process is on ${process.platform}. ` +
        'Use env custody with a secrets manager, or dev_file in development.',
      );
    }
  }

  private account(tenantId: string, keyVersion: string): string {
    return `${tenantId}.${keyVersion}`;
  }

  private at(tenantId: string, keyVersion: string): string {
    return path.join(this.dir, `${tenantId}.${keyVersion}.enc`);
  }

  /* ── the Keychain half ──────────────────────────────────────────────────── */

  private readWrappingKey(account: string): Buffer | null {
    try {
      const b64 = execFileSync(
        'security',
        ['find-generic-password', '-a', account, '-s', this.service, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
      if (!b64) return null;
      const key = Buffer.from(b64, 'base64');
      /**
       * A wrapping key is exactly 32 bytes. Anything else is not one.
       *
       * This is not defensive padding: an earlier version of this class tried
       * to put the PEM itself in the Keychain, and the prompt silently
       * truncated it — leaving an item under this very account holding 96 bytes
       * of a base64 string. Passing that to createCipheriv fails with "Invalid
       * key length", which says nothing about what is actually wrong.
       */
      if (key.length !== WRAPPING_KEY_BYTES) {
        throw new Error(
          `The Keychain item for this key holds ${key.length} bytes, not a ` +
          `${WRAPPING_KEY_BYTES}-byte wrapping key. It is left over from something else. ` +
          `Remove it with: security delete-generic-password -a '${account}' -s '${this.service}'`,
        );
      }
      return key;
    } catch (e) {
      if (e instanceof Error && e.message.includes('wrapping key')) throw e;
      const status = (e as { status?: number }).status;
      if (status === SEC_ITEM_NOT_FOUND) return null;
      /**
       * A LOCKED keychain fails here too, and it must never be read as "no key".
       * Treating it as absent would mint a replacement and silently orphan every
       * signature made under the real one.
       */
      throw new Error(
        `Could not read the wrapping key from the Keychain (security exited ${status}). ` +
        'If the keychain is locked, unlock it and retry. This is NOT the same as the key ' +
        'being absent and must not be treated as such.',
      );
    }
  }

  private writeWrappingKey(account: string, key: Buffer): void {
    const b64 = key.toString('base64');
    if (b64.length > KEYCHAIN_PROMPT_LIMIT) {
      // Unreachable for a 32-byte key; here so that changing the key size
      // fails loudly rather than storing a truncated one.
      throw new Error(
        `A ${b64.length}-character value cannot be written through the security prompt, ` +
        `which truncates at ${KEYCHAIN_PROMPT_LIMIT} without reporting it.`,
      );
    }
    execFileSync(
      'security',
      ['add-generic-password', '-a', account, '-s', this.service,
       '-D', 'Lotmark signing key wrapper', '-U', '-w'],
      // Passed on stdin, twice, because the prompt asks for confirmation. The
      // secret never appears in argv. `security`'s own manual recommends this:
      // "Use of the -p or -w options is insecure."
      { input: `${b64}\n${b64}\n`, stdio: ['pipe', 'ignore', 'pipe'] },
    );

    // Read it back before returning. The truncation above is silent, so the
    // only reliable check is to look.
    const back = this.readWrappingKey(account);
    if (!back || !back.equals(key)) {
      throw new Error('The wrapping key did not survive the round trip into the Keychain.');
    }
  }

  /* ── the disk half ──────────────────────────────────────────────────────── */

  read(tenantId: string, keyVersion: string): string | null {
    const file = this.at(tenantId, keyVersion);
    if (!existsSync(file)) return null;

    const wrapping = this.readWrappingKey(this.account(tenantId, keyVersion));
    if (!wrapping) {
      throw new Error(
        `The encrypted key ${path.basename(file)} is present but its wrapping key is not in ` +
        'the Keychain. The two halves are both required; neither is a copy of the other.',
      );
    }

    const envelope = readFileSync(file, 'utf8').trim().split('\n');
    if (envelope[0] !== ENVELOPE_HEADER) {
      throw new Error(`${file} is not a Lotmark key envelope.`);
    }
    const [ivB64, tagB64, ctB64] = (envelope[1] ?? '').split(':');
    if (!ivB64 || !tagB64 || !ctB64) throw new Error(`${file} is malformed.`);

    const decipher = createDecipheriv('aes-256-gcm', wrapping, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // GCM authentication failed: the file was altered, or the wrapping key is
      // the wrong one. Either way the result would not be the signing key.
      throw new Error(
        `${path.basename(file)} failed authentication. It has been altered, or it belongs to a ` +
        'different wrapping key. Refusing to return a key that is not the one that was stored.',
      );
    }
  }

  write(tenantId: string, keyVersion: string, pem: string): void {
    const account = this.account(tenantId, keyVersion);
    /**
     * Reuse an existing wrapper so that re-writing a key does not orphan an
     * envelope written moments earlier.
     *
     * An item that is NOT a valid wrapping key is replaced rather than refused.
     * That is safe here and only here: `write` is called with the plaintext key
     * in hand, so there is nothing to lose — whereas `read` must refuse, because
     * there the junk item is the only thing standing between the caller and a
     * key that cannot be recovered.
     */
    let wrapping: Buffer;
    try {
      wrapping = this.readWrappingKey(account) ?? randomBytes(WRAPPING_KEY_BYTES);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('wrapping key')) throw e;
      wrapping = randomBytes(WRAPPING_KEY_BYTES);
    }
    this.writeWrappingKey(account, wrapping);

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrapping, iv);
    const ciphertext = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
    const envelope =
      `${ENVELOPE_HEADER}\n` +
      `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}\n`;

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.at(tenantId, keyVersion);
    writeFileSync(file, envelope, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  remove(tenantId: string, keyVersion: string): void {
    rmSync(this.at(tenantId, keyVersion), { force: true });
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-a', this.account(tenantId, keyVersion), '-s', this.service],
        { stdio: 'ignore' },
      );
    } catch (e) {
      if ((e as { status?: number }).status !== SEC_ITEM_NOT_FOUND) throw e;
    }
  }
}

/* ── kms and hsm ──────────────────────────────────────────────────────────── */

/**
 * Declared, and deliberately not implemented.
 *
 * The vocabulary carries these because the column and the certificate footer
 * must be able to express them. An adapter that "worked" by falling back to a
 * file would put the word `hsm` on a document backed by a laptop, which is the
 * precise overclaim this whole module exists to prevent.
 */
class UnavailableCustody implements KeyCustody {
  readonly productionGrade = true;
  readonly describe: string;

  constructor(readonly kind: CustodyClass, private readonly needs: string) {
    this.describe = `${kind} — not implemented in this build`;
    throw new Error(
      `Custody class '${kind}' is declared but not implemented. It needs ${needs}. ` +
      'Nothing in this build can hold a key that way, and reporting that it does ' +
      'would put a false custody class on every certificate signed with it.',
    );
  }

  read(): string | null { throw new Error('unreachable'); }
  write(): void { throw new Error('unreachable'); }
  remove(): void { throw new Error('unreachable'); }
}

/* ── selection ────────────────────────────────────────────────────────────── */

export interface CustodyOptions {
  readonly keyDir: string;
  readonly keychainService?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createCustody(kind: CustodyClass, opts: CustodyOptions): KeyCustody {
  switch (kind) {
    case 'dev_file': return new DevFileCustody(opts.keyDir);
    case 'env': return new EnvCustody(opts.env);
    case 'keychain': return new KeychainCustody(opts.keychainService, opts.keyDir);
    case 'kms':
      return new UnavailableCustody('kms',
        'a cloud KMS endpoint, credentials, and a signing path that never exports the key');
    case 'hsm':
      return new UnavailableCustody('hsm',
        'a PKCS#11 module, a slot and a PIN, and a signing path that never exports the key');
  }
}

export const ALL_CUSTODY_CLASSES: readonly CustodyClass[] =
  ['dev_file', 'env', 'keychain', 'kms', 'hsm'];

/**
 * Which classes may be used outside development.
 *
 * A table rather than a property read off an instance, because the check has to
 * happen at CONFIGURATION time — before anything is constructed, and while the
 * process can still refuse to start. Constructing an unimplemented class throws,
 * so asking the instance would conflate "not allowed here" with "not built".
 *
 * `kms` and `hsm` are true because they WOULD be production-grade. They still
 * cannot be selected, because they are not implemented; the two failures are
 * different and are reported differently.
 */
export const PRODUCTION_GRADE: Record<CustodyClass, boolean> = {
  dev_file: false,
  env: true,
  keychain: false,
  kms: true,
  hsm: true,
};

/** Classes this build can actually construct. */
export const IMPLEMENTED: Record<CustodyClass, boolean> = {
  dev_file: true, env: true, keychain: process.platform === 'darwin',
  kms: false, hsm: false,
};
