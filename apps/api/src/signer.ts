/**
 * The anchor signer.
 *
 * A separate process, a separate database role, a separate key directory.
 *
 * Why not a job in the worker? Because the point of an anchor is that the
 * component which writes the ledger cannot also produce the statements
 * attesting to it. Putting anchoring behind the same queue the application
 * enqueues into — and running it as the same role — would be a dependency
 * inversion dressed up as a control: the compromised component would be
 * choosing when, and over what, it gets attested.
 *
 *   pnpm --filter @lotmark/api anchor         # anchor every tenant once
 *   pnpm --filter @lotmark/api anchor verify  # verify anchors, report exposure
 *   pnpm --filter @lotmark/api anchor export  # copy anchors out of the database
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config';
import { createDb, inTenantTransaction } from './db';
import { AnchorKeyStore, anchorTenant, verifyAnchors } from './services/anchor';

const cfg = loadConfig();
// The SIGNER's connection: not the application's, not the owner's.
const sql = createDb({ ...cfg, DATABASE_URL: cfg.DATABASE_SIGNER_URL });
const keys = new AnchorKeyStore(cfg.ANCHOR_KEY_DIR);
const log = (m: string) => console.log(m);

const command = process.argv[2] ?? 'anchor';

const tenants = (await sql`SELECT * FROM lotmark.all_tenants()`).map(
  (r) => r as { id: string; slug: string; time_source: string; region: string },
);

if (command === 'verify') {
  for (const t of tenants) {
    const v = await inTenantTransaction(sql,
      { tenantId: t.id, auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx) => verifyAnchors(tx, t.id));
    log(
      `${t.slug.padEnd(12)} ${v.ok ? 'anchors verify' : 'ANCHORS BROKEN'} · ` +
      `${v.anchors} anchor(s)` +
      (v.ok
        ? ` · covers through seq ${v.coversThrough} · ${v.unanchoredEntries} entry(s) not yet anchored`
        : ` · ${v.reason}${v.failedAt ? ` at ${v.failedAt}` : ''}`),
    );
  }
} else if (command === 'export') {
  /**
   * Copy anchors out of the database.
   *
   * An anchor inside the database it notarises is still a row the same attacker
   * controls. The export is what actually closes the circle, and it is only as
   * good as where it goes — a file beside the database proves little; the same
   * file on separate media or a WORM store proves a great deal. The target is
   * recorded so nobody has to guess which was done.
   */
  const dir = path.resolve(cfg.ANCHOR_KEY_DIR, '../.anchors-exported');
  mkdirSync(dir, { recursive: true });
  for (const t of tenants) {
    await inTenantTransaction(sql, { tenantId: t.id, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const pending = await tx`
        SELECT c.id, c.through_seq, c.signed_statement, c.signature, c.key_version
        FROM lotmark.audit_checkpoints c
        WHERE c.tenant_id = ${t.id} AND c.signature IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM lotmark.audit_checkpoint_exports e
                          WHERE e.checkpoint_id = c.id AND e.target = ${dir})
        ORDER BY c.through_seq`;
      for (const p of pending) {
        const a = p as {
          id: string; through_seq: string; signed_statement: string;
          signature: string; key_version: string;
        };
        const body = JSON.stringify({
          statement: a.signed_statement, signature: a.signature, keyVersion: a.key_version,
        }, null, 2);
        const file = path.join(dir, `${t.slug}-${a.through_seq}.anchor.json`);
        writeFileSync(file, body);
        await tx`
          INSERT INTO lotmark.audit_checkpoint_exports
            (tenant_id, checkpoint_id, target, content_sha256)
          VALUES (${t.id}, ${a.id}, ${dir},
                  ${createHash('sha256').update(body).digest('hex')})`;
        log(`exported ${path.basename(file)}`);
      }
    });
  }
} else {
  for (const t of tenants) {
    const r = await inTenantTransaction(sql,
      { tenantId: t.id, auditKey: cfg.LOTMARK_AUDIT_KEY },
      (tx) => anchorTenant(tx, {
        tenantId: t.id, tenantName: t.slug, keys, auditKey: cfg.LOTMARK_AUDIT_KEY, log,
      }));
    log(
      r.created
        ? `${t.slug.padEnd(12)} anchored seq ${r.fromSeq}–${r.toSeq} (${r.entryCount} entries)`
        : `${t.slug.padEnd(12)} ${r.reason}`,
    );
  }
}

await sql.end();
