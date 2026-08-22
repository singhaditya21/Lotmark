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

  /**
   * The TITLES of the tests in a file, not its text.
   *
   * This check used to be `source.includes(phrase)` over the whole file, which
   * any occurrence satisfied — a comment, a variable name, an import. The
   * flagship uncertainty requirement cited the phrase "combine", and the only
   * two occurrences in the file it named were `import { combineBudget … }` and
   * a call to it. An import statement was standing as the evidence that ISO
   * Guide 35 uncertainty combination is demonstrated.
   *
   * A title is what a person reads in a test report, and it is the only part of
   * a file that means "this behaviour is asserted".
   */
  const testTitles = (source: string): string[] =>
    [...source.matchAll(/\b(?:it|test|describe)\s*(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)]
      .map((m) => m[2] ?? '');

  it('names tests that exist, by a phrase in a test TITLE', () => {
    const missing: string[] = [];
    for (const r of REQUIREMENTS) {
      for (const t of r.tests) {
        const full = path.join(REPO, t.file);
        if (!existsSync(full)) { missing.push(`${r.id} → ${t.file} (no such file)`); continue; }
        const titles = testTitles(readFileSync(full, 'utf8'));
        const wanted = t.named.toLowerCase();
        if (!titles.some((title) => title.toLowerCase().includes(wanted))) {
          missing.push(
            `${r.id} → ${t.file} has no test TITLED "${t.named}" ` +
            `(${titles.length} titles in that file)`);
        }
      }
    }
    expect(missing, 'the evidence for these requirements is not a test').toEqual([]);
  });

  it('will not accept an import statement as evidence', () => {
    /**
     * The regression, stated directly. This is the shape that let a citation
     * pass for a whole release.
     */
    const fixture = [
      "import { combineBudget } from '../budget';",
      "describe('the uncertainty budget', () => {",
      "  it('is recomputed from raw results', () => { combineBudget([]); });",
      '});',
    ].join('\n');
    const titles = testTitles(fixture);
    expect(titles).toEqual(['the uncertainty budget', 'is recomputed from raw results']);
    expect(titles.some((t) => t.toLowerCase().includes('combine')),
      'an import and a call are not an assertion').toBe(false);
  });

  it('does not let a browser test stand alone as evidence for a server control', () => {
    /**
     * `apps/web` tests assert what the console DOES WITH an answer. They cannot
     * assert that the server refuses anything — the console is explicitly not a
     * security control here ("hiding a control is a courtesy to the user, never
     * a security control"). A requirement whose only evidence lives under
     * apps/web is therefore evidenced by something that cannot demonstrate it.
     */
    const browserOnly = REQUIREMENTS
      .filter((r) => r.tests.length > 0)
      .filter((r) => r.tests.every((t) => t.file.startsWith('apps/web/')))
      .map((r) => r.id);
    expect(browserOnly,
      'these cite only console tests, which cannot demonstrate a server control')
      .toEqual([]);
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
