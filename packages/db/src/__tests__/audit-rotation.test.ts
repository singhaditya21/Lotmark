/**
 * Rotating the audit key without orphaning history.
 *
 * The chain link is an HMAC under a key held outside the database. That made
 * the key unrotatable: verification used one key from seq 1 onward, so changing
 * it would have made all history fail — indistinguishably from tampering.
 *
 * These tests encode the same threat model as audit-chain.test.ts. The attacker
 * can run arbitrary SQL, so the question is never "can they change things" but
 * "is the change undeniable afterwards". The interesting cases here are the
 * ones where an attacker tries to use rotation ITSELF as the forgery: relabel
 * history into a generation whose key they chose, and present that key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, ADMIN_URL, type Sql } from '../client';

const T = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const U1 = '33333333-3333-3333-3333-333333333333';
const KEY_V1 = 'generation-one-key-not-a-production-secret';
const KEY_V2 = 'generation-two-key-not-a-production-secret';

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
      await tx`SELECT set_config('lotmark.audit_key', ${KEY_V1}, true)`;
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

/**
 * The same scenario on the OWNER connection.
 *
 * Disabling a trigger requires ownership, which the application role does not
 * have — so the application literally cannot perform the tampers below, and the
 * chain exists for whoever can. Mixing the two connections deadlocks: ALTER
 * TABLE wants ACCESS EXCLUSIVE while the application transaction still holds a
 * lock on the same table.
 */
async function inAdminRollback<R>(fn: (tx: Sql) => Promise<R>): Promise<R> {
  const MARK = Symbol('rollback');
  try {
    return await admin.begin(async (tx) => {
      await tx`SELECT set_config('lotmark.audit_key', ${KEY_V1}, true)`;
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

/**
 * Play the DBA: disable the append-only triggers for the duration.
 *
 * Re-enabled inside the same transaction, so a failure cannot leave the ledger
 * committed-mutable — a mistake made once here already, which left the append-
 * only protection silently off for every later test.
 */
const attack = <R>(fn: (a: Sql) => Promise<R>): Promise<R> =>
  inAdminRollback(async (a) => {
    await a`ALTER TABLE lotmark.audit_ledger DISABLE TRIGGER audit_ledger_no_update`;
    try { return await fn(a); }
    finally {
      await a`ALTER TABLE lotmark.audit_ledger ENABLE TRIGGER audit_ledger_no_update`;
    }
  });

const write = (tx: Sql, action: string) =>
  tx`INSERT INTO lotmark.audit_ledger
       (tenant_id, actor_user_id, actor_label, actor_role_id, kind, action, detail, time_source, region)
     VALUES (${T}, ${U1}, 'Ravi Menon', 'scientist', 'WORKFLOW', ${action}, '', 'ntp', 'local')
     RETURNING seq, key_version`;

interface Verdict {
  ok: boolean; entries: string; broken_at: string | null; reason: string | null;
  generations: string[]; keys_missing: string[];
}
const verify = async (tx: Sql): Promise<Verdict> => {
  const [row] = await tx`SELECT * FROM lotmark.verify_audit_chain(${T})`;
  return row as unknown as Verdict;
};

/** Switch the session to a generation and its key, as the application would. */
async function useKey(tx: Sql, generation: string, key: string): Promise<void> {
  await tx`SELECT set_config('lotmark.audit_key', ${key}, true)`;
  await tx`SELECT set_config('lotmark.audit_key_generation', ${generation}, true)`;
}

/** Offer a verifier a set of generation keys. */
async function offerKeys(tx: Sql, keys: Record<string, string>): Promise<void> {
  await tx`SELECT set_config('lotmark.audit_keys', ${JSON.stringify(keys)}, true)`;
}

describe('a chain with one generation', () => {
  it('records the generation on every entry and commits the key', async () => {
    await inRollback(async (tx) => {
      const [first] = await write(tx, 'Study signed');
      expect((first as { key_version: string }).key_version).toBe('v1');

      const [gen] = await tx`
        SELECT generation, from_seq, key_check FROM lotmark.audit_key_generations
        WHERE tenant_id = ${T}`;
      const g = gen as { generation: string; from_seq: string; key_check: string | null };
      expect(g.generation).toBe('v1');
      expect(Number(g.from_seq)).toBe(1);
      expect(g.key_check, 'first use commits the key').not.toBeNull();

      expect((await verify(tx)).ok).toBe(true);
    });
  });

  it('refuses an append under a key that is not the generation’s key', async () => {
    /**
     * The commitment doing its work. Without it, anybody able to insert into
     * the ledger could write entries under a key of their own choosing and the
     * generation label would carry no information at all.
     */
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await useKey(tx, 'v1', 'a-key-this-generation-was-never-written-under');
      await expect(write(tx, 'Forged entry')).rejects.toThrow(/does not match the key registered/);
    });
  });
});

describe('rotating', () => {
  it('keeps the chain unbroken across the boundary', async () => {
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await write(tx, 'Value assigned');

      await tx`SELECT set_config('lotmark.audit_key_next', ${KEY_V2}, true)`;
      const [row] = await tx`SELECT lotmark.rotate_audit_key(${T}, 'v2', 'Scheduled rotation', NULL) AS from_seq`;
      expect(Number((row as { from_seq: string }).from_seq)).toBe(3);

      await useKey(tx, 'v2', KEY_V2);
      const [third] = await write(tx, 'Audit key rotated');
      expect((third as { key_version: string }).key_version).toBe('v2');
      await write(tx, 'Lot released');

      // With both keys, the whole history verifies — across the boundary.
      await offerKeys(tx, { v1: KEY_V1, v2: KEY_V2 });
      const verdict = await verify(tx);
      expect(verdict.ok, verdict.reason ?? '').toBe(true);
      expect(Number(verdict.entries)).toBe(4);
      expect(verdict.generations).toEqual(['v1', 'v2']);
      expect(verdict.keys_missing).toEqual([]);
    });
  });

  it('refuses a rotation to the key already in use', async () => {
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await tx`SELECT set_config('lotmark.audit_key_next', ${KEY_V1}, true)`;
      await expect(tx`SELECT lotmark.rotate_audit_key(${T}, 'v2', 'Not really a rotation', NULL)`)
        .rejects.toThrow(/identical to the current one/);
    });
  });

  it('cannot start a generation in the past', async () => {
    /**
     * The escape this closes: forge entries 1..N, relabel them as a generation
     * whose key you chose, register that generation as starting at seq 1, and
     * present your key. `from_seq` is always the next unused sequence, and the
     * table is append-only, so the range a generation covers is fixed when it
     * is created and cannot be extended backwards over existing history.
     */
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await write(tx, 'Value assigned');
      await expect(tx`
        INSERT INTO lotmark.audit_key_generations (tenant_id, generation, from_seq, key_check, reason)
        VALUES (${T}, 'evil', 1, 'whatever', 'backdated')`)
        .rejects.toThrow();   // collides with v1 on (tenant_id, from_seq)
    });
  });

  it('cannot re-point a generation that is already committed', async () => {
    /**
     * Run as the OWNER on purpose. The application role is stopped earlier, by
     * the privilege layer — see the append-only tests below. The question here
     * is what stops somebody who CAN grant themselves privileges, and the
     * answer has to be the trigger.
     */
    await inAdminRollback(async (tx) => {
      await write(tx, 'Study signed');
      await expect(tx`
        UPDATE lotmark.audit_key_generations SET key_check = 'a-key-i-control'
        WHERE tenant_id = ${T} AND generation = 'v1'`)
        .rejects.toThrow(/already committed to a key/);
    });
  });
});

describe('what the verifier is told, and what it is NOT told', () => {
  it('reports a missing key as UNVERIFIED rather than as tampering', async () => {
    /**
     * The distinction that decides what somebody does next. "Broken" sends them
     * to investigate a breach; "unverified" sends them to find a key. Reporting
     * the second as the first is a false alarm on the most serious signal the
     * system has.
     */
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await tx`SELECT set_config('lotmark.audit_key_next', ${KEY_V2}, true)`;
      await tx`SELECT lotmark.rotate_audit_key(${T}, 'v2', 'Scheduled rotation', NULL)`;
      await useKey(tx, 'v2', KEY_V2);
      await write(tx, 'Audit key rotated');

      // A verifier holding only the current key.
      await offerKeys(tx, { v2: KEY_V2 });
      const verdict = await verify(tx);
      expect(verdict.ok).toBe(false);
      expect(verdict.keys_missing).toEqual(['v1']);
      expect(verdict.reason).toMatch(/UNVERIFIED here, not broken/);
      expect(verdict.broken_at, 'nothing is broken, so nothing is pointed at').toBeNull();
    });
  });

  it('reports a WRONG key as unverified rather than as tampering', async () => {
    // Without the commitment check this reported "entry was altered after it
    // was written" — a tampering alarm raised because somebody typed the wrong
    // key.
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await offerKeys(tx, { v1: 'the-wrong-key-entirely' });
      const verdict = await verify(tx);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/is not the key it was written under/);
      expect(verdict.reason).toMatch(/not broken/);
      expect(verdict.broken_at).toBeNull();
    });
  });

  it('still detects real tampering as tampering', async () => {
    /**
     * The property everything else must not have cost. An attacker with the
     * correct key who edits an entry is still caught — the generation work
     * changed which key verifies which entry, not whether the content is
     * committed to.
     */
    await attack(async (tx) => {
      await write(tx, 'Study signed');
      await write(tx, 'Value assigned');
      await tx`UPDATE lotmark.audit_ledger SET action = 'Nothing happened'
               WHERE tenant_id = ${T} AND seq = 1`;

      await offerKeys(tx, { v1: KEY_V1 });
      const verdict = await verify(tx);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/altered after it was written/);
      expect(Number(verdict.broken_at)).toBe(1);
    });
  });

  it('catches entries relabelled into a generation that had not begun', async () => {
    await attack(async (tx) => {
      await write(tx, 'Study signed');
      await write(tx, 'Value assigned');
      await tx`SELECT set_config('lotmark.audit_key_next', ${KEY_V2}, true)`;
      await tx`SELECT lotmark.rotate_audit_key(${T}, 'v2', 'Scheduled rotation', NULL)`;
      await useKey(tx, 'v2', KEY_V2);
      await write(tx, 'Audit key rotated');

      // The attacker relabels an OLD entry into the new generation, hoping the
      // verifier will reach for the key they control.
      await tx`UPDATE lotmark.audit_ledger SET key_version = 'v2'
               WHERE tenant_id = ${T} AND seq = 1`;

      await offerKeys(tx, { v1: KEY_V1, v2: KEY_V2 });
      const verdict = await verify(tx);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/claims generation v2 but v1 was in force/);
      expect(Number(verdict.broken_at)).toBe(1);
    });
  });
});


describe('the generation register is append-only at BOTH layers', () => {
  /**
   * The claim these tests exist to keep honest.
   *
   * Migration 0005 grants the application role SELECT, INSERT, UPDATE and
   * DELETE on every table in the schema, and sets default privileges so every
   * table created afterwards inherits them. Two tables added later carried a
   * comment promising append-only "at two layers, privilege and trigger" while
   * having exactly one, because nobody revoked the default grant. 0019 revokes
   * it; this checks that it stayed revoked.
   */
  it('refuses an UPDATE from the application role at the PRIVILEGE layer', async () => {
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await expect(tx`
        UPDATE lotmark.audit_key_generations SET reason = 'rewritten'
        WHERE tenant_id = ${T}`).rejects.toThrow(/permission denied/);
    });
  });

  it('refuses a DELETE from the application role at the PRIVILEGE layer', async () => {
    await inRollback(async (tx) => {
      await write(tx, 'Study signed');
      await expect(tx`DELETE FROM lotmark.audit_key_generations WHERE tenant_id = ${T}`)
        .rejects.toThrow(/permission denied/);
    });
  });

  it('refuses a DELETE from the OWNER at the TRIGGER layer', async () => {
    // The layer that matters for whoever can grant themselves privileges back.
    await inAdminRollback(async (tx) => {
      await write(tx, 'Study signed');
      await expect(tx`DELETE FROM lotmark.audit_key_generations WHERE tenant_id = ${T}`)
        .rejects.toThrow(/append-only/);
    });
  });

  it('still lets the application role commit a generation on first use', async () => {
    // The one legitimate write, which now goes through a SECURITY DEFINER
    // function precisely so the role can hold no UPDATE grant.
    await inRollback(async (tx) => {
      await tx`
        INSERT INTO lotmark.audit_key_generations (tenant_id, generation, from_seq, reason)
        VALUES (${T}, 'v1', 1, 'carried over by migration')`;
      await write(tx, 'Study signed');
      const [g] = await tx`
        SELECT key_check FROM lotmark.audit_key_generations
        WHERE tenant_id = ${T} AND generation = 'v1'`;
      expect((g as { key_check: string | null }).key_check).not.toBeNull();
    });
  });
});
