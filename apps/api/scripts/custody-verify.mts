/** Does the API's key path honour custody, and refuse a mismatch? */
import { loadConfig } from '../src/config';
import { createDb, inTenantTransaction } from '../src/db';
import { KeyProvider } from '../src/services/keys';
import { createCustody } from '../src/services/custody';

const cfg = loadConfig();
const db = createDb(cfg);
const [t] = await db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
const tenantId = (t as { id: string }).id;

/**
 * The key is read through the class the DATABASE names for it, whichever class
 * this process would mint under. That is the invariant: a certificate cannot
 * claim one custody while the key was read from another.
 */
for (const kind of ['keychain', 'dev_file'] as const) {
  const provider = new KeyProvider(
    (k) => createCustody(k, { keyDir: cfg.SIGNING_KEY_DIR, keychainService: cfg.KEYCHAIN_SERVICE }),
    kind,
  );
  try {
    const key = await inTenantTransaction(db, { tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx) => provider.active(tx, tenantId));
    console.log(`${kind.padEnd(9)} → loaded ${key.keyVersion}, custody=${key.custody}, fp=${key.fingerprint.slice(0, 16)}`);
  } catch (e) {
    console.log(`${kind.padEnd(9)} → REFUSED: ${(e as Error).message.split('.')[0]}.`);
  }
}
await db.end();
