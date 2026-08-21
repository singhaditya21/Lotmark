import { describe, it, expect } from 'vitest';
import {
  parseGuard, evaluateGuard, pathsUsed, guardProblems, GuardError,
  GUARD_FACTS, MAX_GUARD_LENGTH, type GuardFacts,
} from '../index';

/**
 * The guard language.
 *
 * A language a tenant can write is a language an attacker can write, and the
 * person who can write one holds `user:manage` rather than root. So the tests
 * that matter are the ones about what it CANNOT do: reach the host, run
 * anything, loop, read what it was not handed, or be silently wrong about a
 * comparison.
 */

const ok = (src: string, facts: GuardFacts) => evaluateGuard(parseGuard(src), facts);

const capa: GuardFacts = {
  record: {
    severity: 'Major', source: 'Complaint',
    root_cause: 'Method drift', corrective_action: 'Method revised',
    preventive_action: null, effectiveness_check: '  ',
  },
  custom: { root_cause_category: 'method' },
};

describe('what it will not let you write', () => {
  it('has no function calls, because the grammar has no production for them', () => {
    // The only identifiers are dotted paths, and a path is looked up, never
    // invoked. There is nothing to reach `eval` WITH.
    expect(() => parseGuard('constructor()')).toThrow(GuardError);
    expect(() => parseGuard("require('fs')")).toThrow(GuardError);
    expect(() => parseGuard('record.x()')).toThrow(GuardError);
  });

  it('reads nothing but the facts it was handed', () => {
    /**
     * A path walks OWN properties only. The first version indexed straight into
     * the object and this test failed: `record.__proto__` resolved to
     * `Object.prototype` and `record.constructor.name` to 'Object'. Nothing
     * could be written or called through it — there is no assignment and no
     * call in the grammar — but the claim being made is that a guard reads only
     * what it was handed, and that claim has to be true rather than nearly.
     */
    const tree = parseGuard("record.__proto__ == null and record.constructor == null");
    expect(evaluateGuard(tree, capa)).toBe(true);
    expect(ok("record.constructor.name == 'Object'", capa)).toBe(false);
  });

  it('cannot assign, only ask', () => {
    expect(() => parseGuard("record.severity = 'Minor'")).toThrow(/use '=='/);
  });

  it('refuses characters that have no meaning in it', () => {
    for (const bad of ['record.x; DROP TABLE lots', 'record.x + 1', 'record.x && true', '`x`']) {
      expect(() => parseGuard(bad), bad).toThrow(GuardError);
    }
  });

  it('is bounded, so no expression can be pathological', () => {
    const long = `record.severity == 'Major' and `.repeat(40) + "record.severity == 'Major'";
    expect(long.length).toBeGreaterThan(MAX_GUARD_LENGTH);
    expect(() => parseGuard(long)).toThrow(/at most/);
  });

  it('has no loops or recursion in the grammar at all', () => {
    // Nothing to assert at runtime — it is a property of the productions. What
    // CAN be asserted is that deep nesting still terminates and is bounded.
    const nested = '(((((record.severity == \'Major\')))))';
    expect(ok(nested, capa)).toBe(true);
  });
});

describe('what it does let you say', () => {
  it('compares a field to a value', () => {
    expect(ok("record.severity == 'Major'", capa)).toBe(true);
    expect(ok("record.severity != 'Major'", capa)).toBe(false);
  });

  it('combines with and, or, not, and brackets', () => {
    expect(ok("record.severity == 'Major' and record.source == 'Complaint'", capa)).toBe(true);
    expect(ok("record.severity == 'Minor' or record.source == 'Complaint'", capa)).toBe(true);
    expect(ok("not (record.severity == 'Minor')", capa)).toBe(true);
    expect(ok("record.severity == 'Minor' and (record.source == 'Complaint' or true)", capa))
      .toBe(false);
  });

  it('binds and tighter than or, as everybody expects', () => {
    // false and false or true  →  (false and false) or true  →  true
    expect(ok("record.severity == 'Minor' and record.source == 'X' or true", capa)).toBe(true);
  });

  it('asks whether something was filled in', () => {
    expect(ok('record.preventive_action is empty', capa)).toBe(true);
    expect(ok('record.root_cause is not empty', capa)).toBe(true);
    // Whitespace is empty. A field containing two spaces was not filled in.
    expect(ok('record.effectiveness_check is empty', capa)).toBe(true);
  });

  it('reads custom fields, which are the tenant’s own', () => {
    expect(ok("custom.root_cause_category == 'method'", capa)).toBe(true);
  });

  it('treats a missing field and a null field the same', () => {
    // An author should not have to know whether a column is null or the key is
    // absent; both mean nobody said.
    expect(ok('record.never_set == null', capa)).toBe(true);
    expect(ok('record.preventive_action == null', capa)).toBe(true);
    expect(ok('record.never_set is empty', capa)).toBe(true);
  });

  it('orders numbers and ISO dates', () => {
    const lot: GuardFacts = { record: { stock_units: 5, expiry_date: '2027-01-01' } };
    expect(ok('record.stock_units > 0', lot)).toBe(true);
    expect(ok('record.stock_units >= 5 and record.stock_units <= 5', lot)).toBe(true);
    expect(ok("record.expiry_date > '2026-12-31'", lot)).toBe(true);
  });
});

describe('it refuses to be silently wrong', () => {
  it('will not order a number against a string', () => {
    /**
     * This is where a typeless expression language earns its reputation: `"10"
     * < "9"` is true, and a rule that is quietly wrong is worse than one that
     * refuses. Throwing means the caller fails the move closed.
     */
    const facts: GuardFacts = { record: { stock_units: 5, severity: 'Major' } };
    expect(() => ok("record.stock_units > 'Major'", facts)).toThrow(/cannot compare/);
  });

  it('will not order against nothing', () => {
    expect(() => ok('record.missing > 3', capa)).toThrow(/cannot compare/);
  });

  it('will not treat a non-boolean as a condition', () => {
    // `record.severity` on its own is text, not a yes/no. Accepting it would
    // mean every non-empty string is a rule that passes.
    expect(() => ok('record.severity', capa)).toThrow(/not a yes\/no value/);
    expect(ok('record.cold_chain', { record: { cold_chain: false } })).toBe(false);
  });

  it('rejects an unfinished expression rather than guessing', () => {
    for (const bad of ["record.severity ==", "and record.x == 1", "(record.x == 1",
      "record.x == 1)", "record.x is", "record.x is not"]) {
      expect(() => parseGuard(bad), bad).toThrow(GuardError);
    }
  });
});

describe('what publication checks', () => {
  it('lists every fact a guard reads', () => {
    const tree = parseGuard(
      "record.severity == 'Major' and custom.x is empty and record.severity != 'Minor'");
    expect(pathsUsed(tree)).toEqual(['custom.x', 'record.severity']);
  });

  it('refuses a guard naming something the entity does not have', () => {
    const problems = guardProblems("record.invented == 1", 'capa', []);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(/is not something a guard on capa can read/);
    // And it says what IS available, so the author can fix it without guessing.
    expect(problems[0]!.message).toMatch(/record.severity/);
  });

  it('accepts a custom field the same version declares', () => {
    expect(guardProblems("custom.batch_origin is not empty", 'capa', ['batch_origin']))
      .toEqual([]);
    expect(guardProblems("custom.batch_origin is not empty", 'capa', []))
      .toHaveLength(1);
  });

  it('reports a guard that does not parse as one problem, not a crash', () => {
    const problems = guardProblems("record.x ==", 'capa', []);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.guard).toBe('record.x ==');
  });

  it('offers a vocabulary for every entity that has a machine', () => {
    for (const entity of ['capa', 'lot', 'order', 'property_value', 'project', 'study', 'entitlement']) {
      expect(GUARD_FACTS[entity], entity).toBeDefined();
      expect(GUARD_FACTS[entity]!.length, entity).toBeGreaterThan(0);
    }
  });
});
