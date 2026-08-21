import { describe, it, expect } from 'vitest';
import { isBlank, offered, stillNeeded, toInstant } from '../custom-fields';

/**
 * What the custom-field renderer decides, tested apart from the rendering.
 *
 * None of this is a control — the server validates every value against the same
 * definitions and refuses what it does not accept. These decide what a person
 * is OFFERED, and getting them wrong loses data quietly rather than loudly,
 * which is why they are worth their own tests.
 */

const options = [
  { value: 'ampoule_2ml', label: '2 mL ampoule', retired: false },
  { value: 'vial_10ml', label: '10 mL vial', retired: false },
  { value: 'bottle_50ml', label: '50 mL bottle', retired: true },
];

describe('which options to offer', () => {
  it('hides a retired value nobody here holds', () => {
    expect(offered(options, 'ampoule_2ml').map((o) => o.value))
      .toEqual(['ampoule_2ml', 'vial_10ml']);
  });

  it('offers it when THIS record already holds it', () => {
    /**
     * Otherwise the stored value renders as a blank select, and the next save
     * loses it without anybody choosing to. Retiring means "stop choosing
     * this", not "quietly discard the records that already did".
     */
    expect(offered(options, 'bottle_50ml').map((o) => o.value))
      .toEqual(['ampoule_2ml', 'vial_10ml', 'bottle_50ml']);
  });

  it('checks every member of a multiselect, not just the first', () => {
    expect(offered(options, ['ampoule_2ml', 'bottle_50ml']).map((o) => o.value))
      .toContain('bottle_50ml');
  });

  it('offers nothing retired when the record holds nothing', () => {
    expect(offered(options, undefined).map((o) => o.value))
      .toEqual(['ampoule_2ml', 'vial_10ml']);
  });
});

describe('what counts as filled in', () => {
  it('treats whitespace as empty', () => {
    // A required field submitted as spaces is the commonest way a form is
    // filled in without being filled in.
    expect(isBlank('   ')).toBe(true);
    expect(isBlank('Pune')).toBe(false);
  });

  it('treats an empty selection as empty, and false as an answer', () => {
    expect(isBlank([])).toBe(true);
    expect(isBlank(['a'])).toBe(false);
    // `false` is a deliberate answer to a yes/no question, not an absence.
    expect(isBlank(false)).toBe(false);
    expect(isBlank(0)).toBe(false);
  });

  it('treats null and undefined as empty', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
  });
});

describe('what is still needed before saving', () => {
  const sections = [{
    fields: [
      { field: { key: 'a', label: 'Batch origin', required: true }, readOnly: false },
      { field: { key: 'b', label: 'Packaging', required: true }, readOnly: false },
      { field: { key: 'c', label: 'Notes', required: false }, readOnly: false },
      { field: { key: 'd', label: 'Locked', required: true }, readOnly: true },
    ],
  }];

  it('names the required fields that are empty', () => {
    expect(stillNeeded(sections, { a: '', b: 'x' })).toEqual(['Batch origin']);
  });

  it('ignores a required field the person cannot edit', () => {
    // It is read-only here, so demanding it would disable the button with no
    // way to satisfy it. publicationProblems refuses that configuration.
    expect(stillNeeded(sections, { a: 'x', b: 'y' })).toEqual([]);
  });
});

describe('local time to an instant', () => {
  it('produces an unambiguous instant', () => {
    // The control gives wall-clock time with no offset; storing that would mean
    // the value read differently depending on the reader's clock.
    const iso = toInstant('2026-03-01T09:30');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(iso!).getTime()).toBe(new Date('2026-03-01T09:30').getTime());
  });

  it('treats a cleared control as absent, not as the epoch', () => {
    expect(toInstant('')).toBeUndefined();
    expect(toInstant('not a date')).toBeUndefined();
  });
});
