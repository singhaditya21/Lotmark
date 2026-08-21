/**
 * The audit chain, tested against the real database.
 *
 * The threat model these tests encode: an attacker who can run arbitrary SQL.
 * That is not hypothetical — it is a DBA, a restored backup, or anyone with the
 * connection string. Nothing in a database can PREVENT such a person altering
 * rows. The chain's only job is to make the alteration undeniable afterwards,
 * so the tests deliberately disable the protective triggers to play that role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, ADMIN_URL, type Sql } from '../client';

const T = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const U1 = '33333333-3333-3333-3333-333333333333';
const KEY = 'test-hmac-key-not-a-production-secret';

/**
 * Two identities, deliberately.
 *
 * `sql` is the APPLICATION role — non-superuser, non-owner, subject to RLS and
 * to the append-only REVOKEs. It is what the running system uses.
 *
 * `admin` is the schema OWNER, used only to play the attacker: someone with a
 * DBA's privileges who can disable triggers. That is the threat the hash chain
 * exists for, and it cannot be simulated from the application role — which is
 * itself worth knowing.
 */
let sql: Sql;
let admin: Sql;
beforeAll(async () => {
  sql = createClient();
  admin = createClient(ADMIN_URL);
  await sql`SELECT 1`;
  await admin`SELECT 1`;
});
afterAll(async () => { await sql.end(); await admin.end(); });

async function inRollback<R>(fn: (tx: Sql) => Promise<R>): Promise<R> {
  const MARK = Symbol('rollback');
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.audit_key', ${KEY}, true)`;
      // Tenants are under RLS; provision_tenant is SECURITY DEFINER and is the
      // only way to create one without an existing tenant context.
      await tx`SELECT lotmark.provision_tenant(${T}, 't', 'T', 'T', 'ISO 17034', 'X-{SEQ}', 'local')`;
      await tx`SELECT set_config('lotmark.tenant_id', ${T}, true)`;
      await tx`INSERT INTO lotmark.organisations (id, tenant_id, code, name, kind)
               VALUES (${ORG}, ${T}, 'O', 'Org', 'producer')`;
      await tx`INSERT INTO lotmark.users (id, tenant_id, organisation_id, code, email, display_name, password_hash)
               VALUES (${U1}, ${T}, ${ORG}, 'u1', 'a@b.c', 'A', 'x')`;
      const out = await fn(tx as unknown as Sql);
      throw Object.assign(new Error('rollback'), { [MARK]: true, out });
    });
  } catch (e) {
    if (e && typeof e === 'object' && (e as Record<symbol, unknown>)[MARK]) {
      return (e as unknown as { out: R }).out;
    }
    throw e;
  }
}

/** Fixtures + rollback, on whichever connection is given. */
async function withFixtures<R>(conn: Sql, fn: (c: Sql) => Promise<R>): Promise<R> {
  const MARK = Symbol('rollback');
  try {
    return await conn.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.audit_key', ${KEY}, true)`;
      await tx`SELECT lotmark.provision_tenant(${T}, 't', 'T', 'T', 'ISO 17034', 'X-{SEQ}', 'local')`;
      await tx`SELECT set_config('lotmark.tenant_id', ${T}, true)`;
      await tx`INSERT INTO lotmark.organisations (id, tenant_id, code, name, kind)
               VALUES (${ORG}, ${T}, 'O', 'Org', 'producer')`;
      await tx`INSERT INTO lotmark.users (id, tenant_id, organisation_id, code, email, display_name, password_hash)
               VALUES (${U1}, ${T}, ${ORG}, 'u1', 'a@b.c', 'A', 'x')`;
      const out = await fn(tx as unknown as Sql);
      throw Object.assign(new Error('rollback'), { [MARK]: true, out });
    });
  } catch (e) {
    if (e && typeof e === 'object' && (e as Record<symbol, unknown>)[MARK]) {
      return (e as unknown as { out: R }).out;
    }
    throw e;
  }
}

const adminRollback = <R>(fn: (a: Sql) => Promise<R>): Promise<R> => withFixtures(admin, fn);

const writeOn = (conn: Sql, action: string, detail = '') =>
  conn`INSERT INTO lotmark.audit_ledger
         (tenant_id, actor_user_id, actor_label, actor_role_id, kind, action, detail, time_source, region)
       VALUES (${T}, ${U1}, 'Ravi Menon', 'scientist', 'WORKFLOW', ${action}, ${detail}, 'ntp', 'local')
       RETURNING seq, entry_hash, prev_hash`;

const write = (tx: Sql, action: string, detail = '') =>
  tx`INSERT INTO lotmark.audit_ledger
       (tenant_id, actor_user_id, actor_label, actor_role_id, kind, action, detail, time_source, region)
     VALUES (${T}, ${U1}, 'Ravi Menon', 'scientist', 'WORKFLOW', ${action}, ${detail}, 'ntp', 'local')
     RETURNING seq, entry_hash, prev_hash`;

const verify = (tx: Sql) =>
  tx`SELECT * FROM lotmark.verify_audit_chain(${T})` as unknown as Promise<
    Array<{ ok: boolean; entries: string; broken_at: string | null; reason: string | null }>
  >;

describe('appending', () => {
  it('assigns a gap-free sequence starting at 1', async () => {
    await inRollback(async (tx) => {
      const rows = [];
      for (const a of ['Study signed', 'Value assigned', 'Lot released']) {
        const [r] = await write(tx, a);
        rows.push(r as { seq: string });
      }
      expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    });
  });

  it('links each entry to its predecessor', async () => {
    await inRollback(async (tx) => {
      const [a] = await write(tx, 'first') as unknown as [{ entry_hash: string; prev_hash: string }];
      const [b] = await write(tx, 'second') as unknown as [{ prev_hash: string }];
      expect(a.prev_hash).toBe('0'.repeat(64));
      expect(b.prev_hash).toBe(a.entry_hash);
    });
  });

  it('produces a 64-character hex HMAC, not a 32-bit checksum', async () => {
    await inRollback(async (tx) => {
      const [r] = await write(tx, 'x') as unknown as [{ entry_hash: string }];
      expect(r.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('REFUSES to append when no key is set on the session', async () => {
    await inRollback(async (tx) => {
      await tx`SELECT set_config('lotmark.audit_key', '', true)`;
      // Appending unkeyed would produce a link nobody can verify, and the
      // failure would be silent. Refusing is the only safe behaviour.
      await expect(write(tx, 'unkeyed')).rejects.toThrow(/audit_key is not set/);
    });
  });

  it('verifies an intact chain', async () => {
    await inRollback(async (tx) => {
      for (let i = 0; i < 5; i++) await write(tx, `act ${i}`);
      const [v] = await verify(tx);
      expect(v!.ok).toBe(true);
      expect(Number(v!.entries)).toBe(5);
      expect(v!.broken_at).toBeNull();
    });
  });

  it('reports not-verifiable rather than true when the key is absent', async () => {
    /**
     * The intent is unchanged since 0002: no key means UNVERIFIED, never
     * `ok = true`. The wording moved when 0019 made verification per
     * generation — "no key available for generation v1" says which key is
     * missing, which matters once there can be more than one, and it is
     * explicit that this is not a broken chain.
     */
    await inRollback(async (tx) => {
      await write(tx, 'one');
      await tx`SELECT set_config('lotmark.audit_key', '', true)`;
      const [v] = await verify(tx);
      expect(v!.ok).toBe(false);
      expect(v!.reason).toMatch(/no key available for generation/);
      expect(v!.reason, 'and it must not read as tampering').toMatch(/not broken/);
      expect(v!.broken_at, 'nothing is broken, so nothing is pointed at').toBeNull();
    });
  });
});

/** Refused by the privilege layer, the trigger layer, or both. */
const refused = /append-only|permission denied/;

describe('append-only enforcement — two independent layers', () => {
  // The application role holds no UPDATE or DELETE grant, so it is stopped
  // before a trigger is reached. The trigger is the second layer, for anyone
  // who does hold the grant. Testing only one would leave the other unproven.
  it('REFUSES an UPDATE on the ledger', async () => {
    await inRollback(async (tx) => {
      await write(tx, 'act');
      await expect(tx`UPDATE lotmark.audit_ledger SET action = 'rewritten' WHERE tenant_id = ${T}`)
        .rejects.toThrow(refused);
    });
  });

  it('REFUSES a DELETE on the ledger', async () => {
    await inRollback(async (tx) => {
      await write(tx, 'act');
      await expect(tx`DELETE FROM lotmark.audit_ledger WHERE tenant_id = ${T}`)
        .rejects.toThrow(refused);
    });
  });

  it('the TRIGGER refuses even the owner, who holds every grant', async () => {
    // Proving the second layer: privileges alone would leave a DBA unimpeded.
    // A row-level trigger needs a row, so one is written and the transaction
    // rolled back afterwards.
    await expect(adminRollback(async (a) => {
      await a`INSERT INTO lotmark.audit_ledger
                (tenant_id, actor_label, actor_role_id, kind, action, time_source, region)
              VALUES (${T}, 'x', 'x', 'SYSTEM', 'x', 'ntp', 'local')`;
      await a`UPDATE lotmark.audit_ledger SET action = 'rewritten' WHERE tenant_id = ${T}`;
    })).rejects.toThrow(/append-only/);
  });

  // One rejected statement per transaction: Postgres aborts the whole
  // transaction on the first error, so a second assertion would only ever see
  // "current transaction is aborted" and would pass for the wrong reason.
  const withSignature = (fn: (tx: Sql) => Promise<unknown>) => async () => {
    await inRollback(async (tx) => {
      // signature_value is required by 0003: a signature that carries only a
      // digest is what the prototype had, and it proved nothing.
      await tx`INSERT INTO lotmark.signatures
                 (tenant_id, subject_kind, subject_id, signer_user_id, meaning,
                  time_source, region, binding_hash, signature_value)
               VALUES (${T}, 'study', ${U1}, ${U1}, 'approval', 'ntp', 'local',
                       ${'a'.repeat(64)}, 'ZmFrZS1zaWduYXR1cmUtZm9yLXRoZS1hcHBlbmQtb25seS10ZXN0')`;
      await fn(tx);
    });
  };

  it('REFUSES to edit a signature', withSignature(async (tx) => {
    await expect(tx`UPDATE lotmark.signatures SET meaning = 'review' WHERE tenant_id = ${T}`)
      .rejects.toThrow(refused);
  }));

  it('REFUSES to delete a signature', withSignature(async (tx) => {
    await expect(tx`DELETE FROM lotmark.signatures WHERE tenant_id = ${T}`)
      .rejects.toThrow(refused);
  }));
});

describe('tamper detection — attacker with direct SQL access', () => {
  /**
   * This whole block runs on the ADMIN connection.
   *
   * Two reasons. Disabling a trigger requires ownership, which the application
   * role does not have — so the application literally cannot perform this
   * tamper, and the chain exists for whoever can. And mixing the two
   * connections DEADLOCKS: ALTER TABLE wants ACCESS EXCLUSIVE while the
   * application transaction still holds a lock on the same table.
   */
  const attack = <R>(fn: (a: Sql) => Promise<R>): Promise<R> =>
    adminRollback(async (a) => {
      await a`ALTER TABLE lotmark.audit_ledger DISABLE TRIGGER audit_ledger_no_update`;
      await a`ALTER TABLE lotmark.audit_ledger DISABLE TRIGGER audit_ledger_no_delete`;
      try { return await fn(a); }
      finally {
        await a`ALTER TABLE lotmark.audit_ledger ENABLE TRIGGER audit_ledger_no_update`;
        await a`ALTER TABLE lotmark.audit_ledger ENABLE TRIGGER audit_ledger_no_delete`;
      }
    });

  const verifyOn = async (a: Sql) => {
    const [v] = await a`SELECT * FROM lotmark.verify_audit_chain(${T})`;
    return v as { ok: boolean; entries: string; broken_at: string | null; reason: string | null };
  };

  it('DETECTS an altered entry', async () => {
    const v = await attack(async (a) => {
      for (let i = 0; i < 4; i++) await writeOn(a, `act ${i}`);
      await a`UPDATE lotmark.audit_ledger SET action = 'Nothing happened' WHERE tenant_id = ${T} AND seq = 2`;
      return verifyOn(a);
    });
    expect(v.ok).toBe(false);
    expect(Number(v.broken_at)).toBe(2);
    expect(v.reason).toMatch(/altered after it was written/);
  });

  it('DETECTS a deleted entry as a sequence gap', async () => {
    const v = await attack(async (a) => {
      for (let i = 0; i < 4; i++) await writeOn(a, `act ${i}`);
      await a`DELETE FROM lotmark.audit_ledger WHERE tenant_id = ${T} AND seq = 3`;
      return verifyOn(a);
    });
    expect(v.ok).toBe(false);
    // Gap-free seq is what makes a removal visible. With a bigserial default a
    // delete would be indistinguishable from a rolled-back insert.
    expect(v.reason).toMatch(/sequence gap/);
    expect(Number(v.broken_at)).toBe(4);
  });

  it('DETECTS a changed detail field, not merely the action', async () => {
    const v = await attack(async (a) => {
      await writeOn(a, 'Value authorised', 'PV-01 by Dr Asha Pillai');
      await a`UPDATE lotmark.audit_ledger SET detail = 'PV-01 by somebody else' WHERE tenant_id = ${T} AND seq = 1`;
      return verifyOn(a);
    });
    expect(v.ok).toBe(false);
    expect(Number(v.broken_at)).toBe(1);
  });

  it('DETECTS a back-dated entry', async () => {
    const v = await attack(async (a) => {
      await writeOn(a, 'Certificate issued');
      await a`UPDATE lotmark.audit_ledger SET occurred_at = occurred_at - interval '30 days'
              WHERE tenant_id = ${T} AND seq = 1`;
      return verifyOn(a);
    });
    expect(v.ok).toBe(false);
  });

  it('cannot be repaired without the key — a re-chained forgery still fails', async () => {
    const v = await attack(async (a) => {
      for (let i = 0; i < 3; i++) await writeOn(a, `act ${i}`);
      // The attacker recomputes the chain the way an UNKEYED SHA-256 design
      // would allow. Without the HMAC key the result does not verify.
      await a`UPDATE lotmark.audit_ledger SET action = 'forged',
                entry_hash = encode(digest(prev_hash || 'forged', 'sha256'), 'hex')
              WHERE tenant_id = ${T} AND seq = 2`;
      return verifyOn(a);
    });
    expect(v.ok).toBe(false);
    expect(Number(v.broken_at)).toBe(2);
  });
});

describe('published configuration is immutable', () => {
  const publish = async (tx: Sql) => {
    const [v] = await tx`INSERT INTO lotmark.config_versions
        (tenant_id, version_number, status, change_reason, created_by, published_by, published_at)
      VALUES (${T}, 1, 'active', 'initial', ${U1}, ${U1}, now()) RETURNING id`;
    return (v as { id: string }).id;
  };

  it('REFUSES to change a published version\'s content', async () => {
    await inRollback(async (tx) => {
      await publish(tx);
      await expect(tx`UPDATE lotmark.config_versions SET change_reason = 'rewritten' WHERE tenant_id = ${T}`)
        .rejects.toThrow(/published and immutable/);
    });
  });

  it('REFUSES to delete a published version', async () => {
    await inRollback(async (tx) => {
      await publish(tx);
      await expect(tx`DELETE FROM lotmark.config_versions WHERE tenant_id = ${T}`)
        .rejects.toThrow(/cannot be deleted/);
    });
  });

  it('still allows the status walk to superseded', async () => {
    await inRollback(async (tx) => {
      await publish(tx);
      await expect(tx`UPDATE lotmark.config_versions SET status = 'superseded' WHERE tenant_id = ${T}`)
        .resolves.toBeDefined();
    });
  });

  it('REFUSES to add an entry to a published version', async () => {
    await inRollback(async (tx) => {
      const vid = await publish(tx);
      // The header being immutable proves nothing if the entries can still move.
      await expect(tx`INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
                      VALUES (${T}, ${vid}, 'role', 'sneaky', '{}'::jsonb)`)
        .rejects.toThrow(/only be changed while the version is a draft/);
    });
  });

  it('allows entries to be edited while the version is a draft', async () => {
    await inRollback(async (tx) => {
      const [v] = await tx`INSERT INTO lotmark.config_versions
          (tenant_id, version_number, change_reason, created_by)
        VALUES (${T}, 1, 'wip', ${U1}) RETURNING id`;
      await expect(tx`INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
                      VALUES (${T}, ${(v as { id: string }).id}, 'role', 'scientist', '{}'::jsonb)`)
        .resolves.toBeDefined();
    });
  });
});

describe('the protective triggers are all live', () => {
  /**
   * A guard against a real incident during development.
   *
   * The tamper tests disable triggers to play the attacker. An earlier revision
   * ran those ALTERs on a connection OUTSIDE the rolled-back transaction, so a
   * timed-out test committed the disable and never undid it — leaving the audit
   * ledger silently mutable, and every subsequent "append-only" test passing for
   * the wrong reason.
   *
   * The ALTERs now run inside the transaction, so a rollback reverts them. This
   * test asserts the outcome rather than trusting the mechanism.
   */
  it('no trigger in the schema is left disabled', async () => {
    const rows = await admin`
      SELECT c.relname || '.' || t.tgname AS name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'lotmark' AND NOT t.tgisinternal AND t.tgenabled = 'D'`;
    expect(rows.map((r) => (r as { name: string }).name)).toEqual([]);
  });
});
