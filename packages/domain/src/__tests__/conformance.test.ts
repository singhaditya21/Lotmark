import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIREMENTS, byClause, requirementsByStatus } from '../conformance';

/**
 * The requirement register cannot rot.
 *
 * A traceability matrix maintained by hand stops being true within two
 * releases, because nothing fails when it does. Every requirement here names
 * its evidence as paths and test-name phrases, and this suite checks that each
 * one still resolves — so deleting the test that demonstrates a control, or
 * renaming the file that implements it, fails the build rather than quietly
 * leaving a claim behind.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');

describe('every requirement points at something real', () => {
  it('names code that exists', () => {
    const missing: string[] = [];
    for (const r of REQUIREMENTS) {
      for (const file of r.code) {
        if (!existsSync(path.join(REPO, file))) missing.push(`${r.id} → ${file}`);
      }
    }
    expect(missing, 'these requirements cite code that has been moved or deleted').toEqual([]);
  });

  it('names tests that exist, by a phrase that appears in them', () => {
    /**
     * Checking the phrase and not only the file is the part that matters. A
     * test file survives a rewrite that removes the very test a requirement
     * depends on, and the citation would still look satisfied.
     */
    const missing: string[] = [];
    for (const r of REQUIREMENTS) {
      for (const t of r.tests) {
        const full = path.join(REPO, t.file);
        if (!existsSync(full)) { missing.push(`${r.id} → ${t.file} (no such file)`); continue; }
        const source = readFileSync(full, 'utf8');
        if (!source.toLowerCase().includes(t.named.toLowerCase())) {
          missing.push(`${r.id} → ${t.file} has no test naming "${t.named}"`);
        }
      }
    }
    expect(missing, 'the evidence for these requirements no longer exists').toEqual([]);
  });

  it('gives every enforced requirement at least one test', () => {
    // "Enforced" means the code refuses the thing. A claim of enforcement with
    // nothing demonstrating it is an assertion, and this register exists to
    // avoid assertions.
    const unevidenced = REQUIREMENTS
      .filter((r) => r.status === 'enforced' && r.tests.length === 0)
      .map((r) => r.id);
    expect(unevidenced, 'claimed as enforced with no test to show for it').toEqual([]);
  });
});

describe('the register is honest about what is missing', () => {
  it('makes every requirement that is not fully enforced explain itself', () => {
    for (const r of REQUIREMENTS) {
      if (r.status === 'enforced') continue;
      expect(r.note, `${r.id} is ${r.status} and must say what is missing`).toBeTruthy();
    }
  });

  it('still contains gaps, which is the point', () => {
    /**
     * A register in which everything is enforced is a register nobody can
     * trust. This asserts the honest ones are still described honestly —
     * subcontracting is declared and not enforced, and saying so is the whole
     * value of recording it.
     */
    const byStatus = requirementsByStatus();
    expect(byStatus.declared.length + byStatus.partial.length,
      'if this ever reaches zero, check it is true rather than tidied').toBeGreaterThan(0);
    expect(byStatus.declared.map((r) => r.id)).toContain('REQ-SUBCONTRACT');
  });

  it('has unique ids and cites a clause for each', () => {
    const ids = REQUIREMENTS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of REQUIREMENTS) {
      expect(r.clause.length, r.id).toBeGreaterThan(3);
      expect(r.statement.length, r.id).toBeGreaterThan(30);
    }
  });
});

describe('grouping for the conformance view', () => {
  it('covers the clauses an ISO 17034 assessor asks about', () => {
    const clauses = byClause().map((c) => c.clause).join(' | ');
    for (const expected of ['§6.3', '§7.7', '§7.9', '§7.10', '§7.11', '§8.4']) {
      expect(clauses, `no requirement cites ISO 17034 ${expected}`).toContain(expected);
    }
  });

  it('covers the Part 11 clauses the product claims', () => {
    const clauses = byClause().map((c) => c.clause).join(' | ');
    for (const expected of ['§11.10(b)', '§11.10(d)', '§11.10(e)', '§11.50', '§11.70', '§11.200']) {
      expect(clauses, `no requirement cites 21 CFR 11 ${expected}`).toContain(expected);
    }
  });
});
