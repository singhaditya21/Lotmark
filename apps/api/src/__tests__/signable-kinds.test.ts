import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import type { SignableKind } from '@lotmark/domain';

/**
 * Every kind the domain can sign is a kind the database will store.
 *
 * `SignableKind` and `signature_subject_kind_known` are two statements of one
 * fact, and they have now disagreed twice. Migration 0026 fixed the first
 * occurrence — signing a workflow transition "reached the user as a 500", in
 * the words of its header — and while rewriting the very constraint at issue it
 * did not notice that `config_version` was already sitting in the same enum,
 * also unlisted. Migration 0030 fixed that one.
 *
 * The failure is quiet in the worst way: the code compiles, the route is
 * reachable, the signature is computed, and the INSERT is refused — so the act
 * a regulation requires to be signed is the one act that cannot complete.
 *
 * This test is here so that a seventh kind cannot be added in code alone.
 */

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is not set; test/setup.ts should have.');

/**
 * Restated here on purpose.
 *
 * Importing a list and comparing it with itself proves nothing. `SignableKind`
 * is a type, so it has no runtime value to read — and the moment somebody adds
 * a member, this literal stops type-checking (see the assignment below) and
 * they are made to come here and say whether the database knows about it too.
 */
const KINDS = [
  'study', 'value', 'certificate', 'lot', 'config_version', 'state_transition',
] as const;

/**
 * The compile-time half of the check.
 *
 * Assigning both ways forces the two sets to be identical: a kind added to
 * `SignableKind` and not to `KINDS` fails the first line, and a kind left in
 * `KINDS` after being removed from the type fails the second.
 */
const _everyKindIsListed: readonly SignableKind[] = KINDS;
const _everyListedKindIsReal: readonly (typeof KINDS)[number][] =
  [] as SignableKind[];
void _everyKindIsListed; void _everyListedKindIsReal;

let sql: Sql;

beforeAll(() => { sql = postgres(url, { onnotice: () => {}, max: 1 }); });
afterAll(async () => { await sql?.end(); });

describe('every kind the domain can sign is accepted by the database', () => {
  it('is listed in signature_subject_kind_known', async () => {
    const [row] = await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'signature_subject_kind_known'`;
    expect(row, 'the constraint is missing entirely').toBeDefined();

    const def = (row as { def: string }).def;
    const accepted = new Set([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));

    for (const kind of KINDS) {
      expect(accepted.has(kind),
        `the database refuses to store a '${kind}' signature, so every act that ` +
        'requires one fails at the INSERT. Add it to the CHECK in a migration.')
        .toBe(true);
    }
  });

  it('does not accept a kind the domain cannot produce', async () => {
    /*
     * The other direction matters less but is not free: a kind the database
     * accepts and the domain cannot make is a hole in what the constraint is
     * for, which is ensuring a stored signature says something the verifier
     * knows how to canonicalise.
     */
    const [row] = await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'signature_subject_kind_known'`;
    const def = (row as { def: string }).def;
    const accepted = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(new Set(accepted)).toEqual(new Set(KINDS));
  });
});
