/**
 * Rotate the audit chain key.
 *
 *   LOTMARK_AUDIT_KEY_NEXT="$(openssl rand -base64 32)" \
 *     pnpm --filter @lotmark/api audit:rotate -- --generation v2 --reason "annual rotation"
 *
 *   pnpm --filter @lotmark/api audit:generations      # show what exists
 *   pnpm --filter @lotmark/api audit:claim            # commit the current generation
 *
 * ── Why the new key comes from the environment ──────────────────────────────
 *
 * It is never taken as an argument, because argv is visible to every user on
 * the machine through `ps`. It is never PRINTED either, for the same reason a
 * password prompt does not echo: a secret on a terminal ends up in scrollback,
 * in a screen recording, and in the log of whatever CI system ran the command.
 *
 * The operator therefore supplies it and keeps it. This script's job is to
 * register it and move the ledger onto it, not to look after it.
 *
 * ── What rotation actually does ─────────────────────────────────────────────
 *
 *   1. registers the new generation with a COMMITMENT to the new key — an HMAC
 *      of a fixed string, so the database can recognise the key later without
 *      ever being able to produce a signature with it;
 *   2. switches the session onto the new key and generation;
 *   3. writes the ledger entry recording the rotation, which becomes the first
 *      entry of the new generation — so the ledger itself says where the
 *      boundary is, rather than that being knowable only from a side table.
 *
 * All three in ONE transaction. A rotation that registered a generation and
 * then failed to write its first entry would leave a generation nothing was
 * ever written under, and the next append would silently start using it.
 *
 * ── Afterwards ──────────────────────────────────────────────────────────────
 *
 * Set LOTMARK_AUDIT_KEY to the new key and LOTMARK_AUDIT_KEY_GENERATION to the
 * new generation. KEEP THE OLD KEY: put it in LOTMARK_AUDIT_KEYS so history
 * written under it can still be verified. Losing it does not break the chain —
 * verification will report those entries as unverified rather than broken —
 * but nobody will ever be able to check them again.
 */
import { loadConfig } from '../src/config';
import { createDb, inTenantTransaction } from '../src/db';
import { recordAudit } from '../src/services/audit';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};

const cfg = loadConfig();
const db = createDb(cfg);

async function main(): Promise<void> {
  const [tenantRow] = await db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
  const tenant = tenantRow as
    { id: string; slug: string; time_source: string; region: string } | undefined;
  if (!tenant) throw new Error('No tenant is provisioned. Run: pnpm db:seed');

  const base = {
    tenantId: tenant.id,
    auditKey: cfg.LOTMARK_AUDIT_KEY,
    auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    auditKeys: cfg.LOTMARK_AUDIT_KEYS,
  };

  if (args.includes('--show') || args.length === 0) {
    const rows = await inTenantTransaction(db, base, (tx) => tx`
      SELECT g.generation, g.from_seq, g.activated_at::date AS activated_on, g.reason,
             g.key_check IS NOT NULL AS committed,
             (SELECT count(*) FROM lotmark.audit_ledger l
               WHERE l.tenant_id = g.tenant_id AND l.key_version = g.generation) AS entries
      FROM lotmark.audit_key_generations g
      WHERE g.tenant_id = ${tenant.id} ORDER BY g.from_seq`);

    console.log(`tenant ${tenant.slug} — audit key generations\n`);
    console.log('generation  from_seq  entries  committed  activated   reason');
    console.log('─'.repeat(92));
    for (const r of rows) {
      const g = r as Record<string, unknown>;
      console.log(
        `${String(g['generation']).padEnd(11)} ${String(g['from_seq']).padStart(8)} ` +
        `${String(g['entries']).padStart(8)}  ${g['committed'] ? 'yes      ' : 'NO       '} ` +
        `${String(g['activated_on'])}  ${String(g['reason']).slice(0, 40)}`,
      );
    }

    const [v] = await inTenantTransaction(db, base, (tx) =>
      tx`SELECT * FROM lotmark.verify_audit_chain(${tenant.id})`);
    const verdict = v as {
      ok: boolean; entries: string; reason: string | null;
      generations: string[]; keys_missing: string[];
    };
    console.log();
    if (verdict.ok) {
      console.log(`chain verifies across ${verdict.entries} entries, generations ${verdict.generations.join(', ')}`);
    } else if (verdict.keys_missing.length > 0) {
      console.log(`chain is UNVERIFIED (not broken): no key held for ${verdict.keys_missing.join(', ')}`);
      console.log('Set LOTMARK_AUDIT_KEYS to a JSON map of retired generation keys to check them.');
    } else {
      console.log(`chain FAILS: ${verdict.reason}`);
    }
    return;
  }

  /**
   * Commit the current generation to the key this process holds.
   *
   * Migration 0019 carried existing history forward as generation 'v1' with no
   * commitment, because the migration cannot see the key — it lives outside the
   * database on purpose. The first append commits it, which in practice is
   * seconds later; until then there is a window in which somebody who could
   * already write to the ledger could commit a key of their own.
   *
   * This closes the window on demand rather than waiting for traffic. It also
   * matters for verification quality: with no commitment recorded, a verifier
   * given the WRONG key cannot be told apart from a tampered chain, because
   * there is nothing to compare the key against.
   */
  if (args.includes('--claim')) {
    await inTenantTransaction(db, base, async (tx) => {
      const [row] = await tx`
        SELECT key_check IS NOT NULL AS committed FROM lotmark.audit_key_generations
        WHERE tenant_id = ${tenant.id} AND generation = ${cfg.LOTMARK_AUDIT_KEY_GENERATION}`;
      const found = row as { committed: boolean } | undefined;
      if (!found) {
        throw new Error(
          `Generation ${cfg.LOTMARK_AUDIT_KEY_GENERATION} is not registered for this tenant. ` +
          'It is registered on its first use, or by rotating onto it.',
        );
      }
      if (found.committed) {
        console.log(`generation ${cfg.LOTMARK_AUDIT_KEY_GENERATION} is already committed; nothing to do`);
        return;
      }
      await tx`SELECT lotmark.commit_audit_generation(
        ${tenant.id}, ${cfg.LOTMARK_AUDIT_KEY_GENERATION},
        lotmark.audit_key_check(${tenant.id}, ${cfg.LOTMARK_AUDIT_KEY_GENERATION}, ${cfg.LOTMARK_AUDIT_KEY}))`;
      console.log(
        `generation ${cfg.LOTMARK_AUDIT_KEY_GENERATION} is now committed to the key this ` +
        'process holds. A verifier given the wrong key will now be told so, rather than ' +
        'being told the chain is broken.',
      );
    });
    return;
  }

  const generation = flag('generation');
  const reason = flag('reason');
  // Read from the environment, never argv. It is not echoed anywhere.
  const nextKey = process.env['LOTMARK_AUDIT_KEY_NEXT'];

  if (!generation) throw new Error('--generation is required, e.g. --generation v2');
  if (!reason) throw new Error('--reason is required. A rotation with no stated reason cannot be reviewed.');
  if (!nextKey || nextKey.length < 16) {
    throw new Error(
      'Set LOTMARK_AUDIT_KEY_NEXT to the new key (at least 16 characters) in the environment. ' +
      'It is deliberately not accepted as an argument, where ps would show it to every user ' +
      'on this machine.\n\n' +
      '  LOTMARK_AUDIT_KEY_NEXT="$(openssl rand -base64 32)" pnpm ... audit:rotate -- ...',
    );
  }
  if (nextKey === cfg.LOTMARK_AUDIT_KEY) {
    throw new Error('The new key is identical to the current one. That is not a rotation.');
  }

  const fromSeq = await db.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.tenant_id', ${tenant.id}, true)`;
    await tx`SELECT set_config('lotmark.audit_key', ${cfg.LOTMARK_AUDIT_KEY}, true)`;
    await tx`SELECT set_config('lotmark.audit_key_generation', ${cfg.LOTMARK_AUDIT_KEY_GENERATION}, true)`;
    await tx`SELECT set_config('lotmark.audit_key_next', ${nextKey}, true)`;

    const [row] = await tx`
      SELECT lotmark.rotate_audit_key(${tenant.id}, ${generation}, ${reason}, ${null}) AS from_seq`;
    const from = Number((row as { from_seq: string }).from_seq);

    // From here the session writes under the NEW key, so the entry recording
    // the rotation is itself the first entry of the new generation.
    await tx`SELECT set_config('lotmark.audit_key', ${nextKey}, true)`;
    await tx`SELECT set_config('lotmark.audit_key_generation', ${generation}, true)`;

    await recordAudit(tx as never, {
      tenantId: tenant.id,
      actorUserId: null,
      actorLabel: 'system · audit key rotation',
      actorRoleId: 'system',
      sessionId: null,
      timeSource: tenant.time_source,
      region: tenant.region,
    }, {
      kind: 'SECURITY',
      action: 'Audit chain key rotated',
      detail:
        `${cfg.LOTMARK_AUDIT_KEY_GENERATION} → ${generation} from seq ${from} · ${reason}`,
      subjectTable: 'audit_key_generations',
      changes: { from: cfg.LOTMARK_AUDIT_KEY_GENERATION, to: generation, fromSeq: from },
    });

    return from;
  });

  console.log(`rotated: ${cfg.LOTMARK_AUDIT_KEY_GENERATION} → ${generation}, from seq ${fromSeq}`);
  console.log('\nNow, before the next audited action:');
  console.log(`  LOTMARK_AUDIT_KEY            = the new key (not printed here, on purpose)`);
  console.log(`  LOTMARK_AUDIT_KEY_GENERATION = ${generation}`);
  console.log('\nAnd KEEP THE OLD KEY. Put both in LOTMARK_AUDIT_KEYS so history written');
  console.log('under the old one can still be verified:');
  console.log(`  LOTMARK_AUDIT_KEYS = {"${cfg.LOTMARK_AUDIT_KEY_GENERATION}":"<old>","${generation}":"<new>"}`);
  console.log('\nLosing the old key does not break the chain — those entries would be');
  console.log('reported UNVERIFIED rather than broken — but nobody could ever check them again.');
}

main()
  .then(() => db.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    await db.end();
    process.exit(1);
  });
