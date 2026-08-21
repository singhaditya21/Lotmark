/**
 * Move a signing key from one custody class to another.
 *
 *   pnpm --filter @lotmark/api custody:show
 *   pnpm --filter @lotmark/api custody:move -- --to keychain --reason "..."
 *   pnpm --filter @lotmark/api custody:move -- --to dev_file --reason "..." --keep-source
 *
 * ── Why this is a command and not a configuration change ────────────────────
 *
 * `custody` is printed on every certificate the key signs, so it has to
 * describe where the key actually is. That makes moving it a real operation on
 * real bytes — read here, write there, prove it arrived — not a setting.
 *
 * SIGNING_KEY_CUSTODY does not move anything. It decides only what class NEW
 * keys are minted under; an existing key is always read through the class the
 * database records for it, so a certificate can never claim one custody while
 * the key was read from another.
 *
 * ── The order of operations IS the safety property ──────────────────────────
 *
 *   1. read from the current store
 *   2. write to the new store
 *   3. read BACK from the new store and compare
 *   4. only then record the move and update the column
 *   5. only then remove from the old store, and only if asked
 *
 * A failure at any point leaves the key readable where it already was. The
 * tempting shorter version — move, then verify — has a window where the key
 * exists nowhere, and the thing being moved is the only object in the system
 * that cannot be regenerated without invalidating history.
 */
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config';
import { createDb, inTenantTransaction } from '../src/db';
import { createCustody, ALL_CUSTODY_CLASSES, IMPLEMENTED, type CustodyClass } from '../src/services/custody';
import { recordAudit } from '../src/services/audit';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};
const has = (name: string) => args.includes(`--${name}`);

const cfg = loadConfig();
const db = createDb(cfg);

const digest = (pem: string) => createHash('sha256').update(pem.trim()).digest('hex').slice(0, 16);

async function main(): Promise<void> {
  const [tenantRow] = await db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  const tenant = tenantRow as { id: string; slug: string; time_source: string; region: string } | undefined;
  if (!tenant) throw new Error('No tenant is provisioned. Run: pnpm db:seed');

  const keys = await inTenantTransaction(db, { tenantId: tenant.id, auditKey: cfg.LOTMARK_AUDIT_KEY },
    (tx) => tx`
      SELECT key_version, purpose, custody, fingerprint, retired_at
      FROM lotmark.signing_keys WHERE tenant_id = ${tenant.id} ORDER BY purpose, key_version`);

  if (has('show') || args.length === 0) {
    console.log(`tenant ${tenant.slug}\n`);
    console.log('key            purpose  custody     fingerprint');
    console.log('─'.repeat(64));
    for (const k of keys) {
      const r = k as Record<string, unknown>;
      console.log(
        `${String(r['key_version']).padEnd(14)} ${String(r['purpose']).padEnd(8)} ` +
        `${String(r['custody']).padEnd(11)} ${String(r['fingerprint']).slice(0, 24)}` +
        (r['retired_at'] ? '  (retired)' : ''),
      );
    }
    console.log('\navailable custody classes here:',
      ALL_CUSTODY_CLASSES.filter((c) => IMPLEMENTED[c]).join(', '));
    console.log('not implemented in this build:',
      ALL_CUSTODY_CLASSES.filter((c) => !IMPLEMENTED[c]).join(', ') || 'none');
    return;
  }

  const to = flag('to') as CustodyClass | null;
  const reason = flag('reason');
  const version = flag('key') ?? 'rec-v1';

  if (!to || !ALL_CUSTODY_CLASSES.includes(to)) {
    throw new Error(`--to must be one of ${ALL_CUSTODY_CLASSES.join(', ')}`);
  }
  if (!reason) {
    // The database CHECK would refuse it anyway; failing here says why.
    throw new Error('--reason is required. A custody move with no stated reason cannot be reviewed.');
  }

  const key = keys.map((k) => k as Record<string, unknown>)
    .find((k) => k['key_version'] === version && k['purpose'] === 'record');
  if (!key) throw new Error(`No record key '${version}' for this tenant.`);

  const from = key['custody'] as CustodyClass;
  if (from === to) throw new Error(`Key ${version} is already held as ${to}.`);

  console.log(`moving ${version}: ${from} → ${to}`);

  const source = createCustody(from, { keyDir: cfg.SIGNING_KEY_DIR, keychainService: cfg.KEYCHAIN_SERVICE });
  const target = createCustody(to, { keyDir: cfg.SIGNING_KEY_DIR, keychainService: cfg.KEYCHAIN_SERVICE });

  // 1. Read from where it is.
  const pem = source.read(tenant.id, version);
  if (!pem) throw new Error(`The key is not present in ${source.describe}. Nothing to move.`);
  console.log(`  read from ${source.describe} (sha256:${digest(pem)})`);

  // 2. Write to where it is going.
  target.write(tenant.id, version, pem);

  // 3. Read it BACK and compare, before anything is recorded or removed.
  const readBack = target.read(tenant.id, version);
  if (!readBack) throw new Error(`Wrote the key to ${target.describe} but could not read it back. Nothing has changed.`);
  if (readBack.trim() !== pem.trim()) {
    throw new Error(
      `The key read back from ${target.describe} does not match what was written ` +
      `(sha256:${digest(readBack)} vs ${digest(pem)}). Nothing has changed; the key is still in ${source.describe}.`,
    );
  }
  console.log(`  verified in ${target.describe} (sha256:${digest(readBack)})`);

  // 4. Record the move. The function refuses a change the trigger would block.
  await inTenantTransaction(db, { tenantId: tenant.id, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
    await tx`SELECT lotmark.move_key_custody(
      ${tenant.id}, ${version}, ${to}, ${reason}, ${null})`;
    await recordAudit(tx, {
      tenantId: tenant.id,
      // No person: this is a command run by an operator against the machine, and
      // inventing a user id would be a lie in the one place that must not carry one.
      actorUserId: null,
      actorLabel: 'system · custody move',
      actorRoleId: 'system',
      sessionId: null,
      timeSource: tenant.time_source,
      region: tenant.region,
    }, {
      kind: 'SECURITY',
      action: 'Signing key custody moved',
      detail: `${version}: ${from} → ${to} · ${reason}`,
      subjectTable: 'signing_keys',
      changes: { keyVersion: version, from, to, fingerprint: key['fingerprint'] },
    });
  });
  console.log(`  recorded: ${from} → ${to}`);

  // 5. Only now is it safe to remove the old copy.
  if (has('keep-source')) {
    console.log(`  LEFT IN PLACE in ${source.describe} — remove it yourself; until you do, the`);
    console.log('  key is readable from two places and the weaker one decides how well it is held.');
  } else {
    try {
      source.remove(tenant.id, version);
      console.log(`  removed from ${source.describe}`);
    } catch (e) {
      console.warn(`  could not remove from ${source.describe}: ${(e as Error).message}`);
      console.warn('  The move is recorded and the key is safe in its new home. Remove the old copy by hand.');
    }
  }

  console.log(`\nNothing else needs changing: the key provider reads each key through the`);
  console.log(`custody class the DATABASE records for it, which is now '${to}'.`);
  console.log('SIGNING_KEY_CUSTODY decides only what class NEW keys are minted under.');
}

main()
  .then(() => db.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    await db.end();
    process.exit(1);
  });
