import { describe, it, expect } from 'vitest';
import {
  fieldConfigSchema, picklistConfigSchema, layoutConfigSchema,
  valuesSchemaFor, missingRequired, resolveForm, writableFields,
  CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_PARENT, CUSTOM_FIELD_PERMISSIONS,
  FROZEN_STATES, isFrozen,
  isSupportedFieldType, isPermission, ALL_MACHINES,
  type FieldConfig, type PicklistConfig, type LayoutConfig,
} from '../index';

/**
 * Custom fields: what a tenant may define, and what may then be stored.
 *
 * The interesting cases are the refusals. A form designer whose definitions are
 * checked loosely produces configuration that publishes cleanly and renders
 * nothing — which is worse than a designer that refuses, because the
 * administrator believes it worked.
 */

const field = (over: Record<string, unknown> & { key: string }): FieldConfig =>
  fieldConfigSchema.parse({
    entity: 'lot', label: `Field ${over.key}`, type: 'text', ...over,
  });

const picklists = (...lists: PicklistConfig[]) =>
  new Map(lists.map((l) => [l.key, l]));

const grade = picklistConfigSchema.parse({
  key: 'grade', name: 'Grade',
  values: [
    { value: 'primary', label: 'Primary' },
    { value: 'secondary', label: 'Secondary' },
    { value: 'legacy', label: 'Legacy', retired: true },
  ],
});

describe('the entity vocabulary cannot drift from the product', () => {
  it('is exactly the record types that have a state machine', () => {
    /**
     * The list is written out rather than derived, because the literal types
     * are what make the table and permission maps exhaustively checked. This is
     * the price of that: one test, which fails the moment a machine is added
     * and the list is not.
     */
    expect([...CUSTOM_FIELD_ENTITIES].sort())
      .toEqual(ALL_MACHINES.map((m) => m.name).sort());
  });

  it('names a permission the system actually enforces, for every entity', () => {
    // A permission nothing enforces is a capability nothing checks — the same
    // rule publicationProblems applies to roles.
    for (const entity of CUSTOM_FIELD_ENTITIES) {
      const p = CUSTOM_FIELD_PERMISSIONS[entity];
      expect(isPermission(p.read), `${entity}.read = ${p.read}`).toBe(true);
      expect(isPermission(p.write), `${entity}.write = ${p.write}`).toBe(true);
    }
  });

  it('names a table and a state column for every entity', () => {
    for (const entity of CUSTOM_FIELD_ENTITIES) {
      expect(CUSTOM_FIELD_PARENT[entity].table, entity).toBeTruthy();
      expect(CUSTOM_FIELD_PARENT[entity].stateColumn, entity).toBeTruthy();
    }
  });

  it('freezes on exactly the states each machine calls terminal', () => {
    /**
     * Derived, so it cannot disagree — this test is what proves the derivation
     * still lines up entity for entity, which is the part a refactor breaks.
     */
    for (const m of ALL_MACHINES) {
      expect([...FROZEN_STATES[m.name as keyof typeof FROZEN_STATES]].sort(), m.name)
        .toEqual([...m.terminal].sort());
    }
    expect(isFrozen('study', 'signed')).toBe(true);
    expect(isFrozen('study', 'draft')).toBe(false);
    // A record whose state cannot be read is not treated as frozen; the guard
    // and the record check refuse it first.
    expect(isFrozen('study', null)).toBe(false);
  });
});

describe('what a tenant may define', () => {
  it('refuses a field on an entity the product does not have', () => {
    // A free slug here published cleanly and rendered nowhere.
    const r = fieldConfigSchema.safeParse({
      key: 'widget_size', entity: 'widgets', label: 'Size', type: 'text',
    });
    expect(r.success).toBe(false);
  });

  it('accepts every entity that has a state machine', () => {
    for (const entity of CUSTOM_FIELD_ENTITIES) {
      const r = fieldConfigSchema.safeParse({
        key: 'note', entity, label: 'Note', type: 'text',
      });
      expect(r.success, entity).toBe(true);
    }
  });

  it('refuses a picklist that offers the same value twice', () => {
    // Both parsed before, so which label a record displayed depended on the
    // order of the array.
    const r = picklistConfigSchema.safeParse({
      key: 'grade', name: 'Grade',
      values: [
        { value: 'primary', label: 'Primary' },
        { value: 'primary', label: 'Primary (old)' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a layout section that places no fields', () => {
    // It renders as a heading above nothing. Only `sections` had a minimum.
    const r = layoutConfigSchema.safeParse({
      key: 'lot_form', entity: 'lot', name: 'Lot form',
      sections: [{ title: 'Empty', fields: [] }],
    });
    expect(r.success).toBe(false);
  });

  it('knows which declared types it can actually store', () => {
    // `attachment` is in the type vocabulary and has no upload surface, so it
    // is not supported — said once, here, rather than discovered by an
    // administrator whose control accepts nothing.
    expect(isSupportedFieldType('text')).toBe(true);
    expect(isSupportedFieldType('attachment')).toBe(false);
    // `user` and `team` validate as identifiers, and rendering one means a
    // picker. A text box asking for a uuid is not a person picker.
    expect(isSupportedFieldType('user')).toBe(false);
    expect(isSupportedFieldType('team')).toBe(false);
  });
});

describe('what may then be stored', () => {
  const schemaOf = (...fs: FieldConfig[]) => valuesSchemaFor(fs, picklists(grade));

  it('refuses a key no field defines', () => {
    /**
     * Strict on purpose. Without it a key removed from configuration, or one
     * never defined at all, is stored anyway — so the document accumulates data
     * no screen shows and no rule governs.
     */
    const s = schemaOf(field({ key: 'batch_origin' }));
    expect(s.safeParse({ batch_origin: 'Pune', stowaway: 'x' }).success).toBe(false);
  });

  it('treats a required field submitted blank as not submitted', () => {
    const s = schemaOf(field({ key: 'batch_origin', required: true }));
    expect(s.safeParse({ batch_origin: '' }).success).toBe(false);
    expect(s.safeParse({ batch_origin: 'Pune' }).success).toBe(true);
  });

  it('lets an optional field be absent, but not be the wrong shape', () => {
    const s = schemaOf(field({ key: 'yield_pct', type: 'number' }));
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ yield_pct: 91.4 }).success).toBe(true);
    expect(s.safeParse({ yield_pct: '91.4' }).success).toBe(false);
  });

  it('applies the range and the integer-ness the definition asked for', () => {
    const s = schemaOf(field({ key: 'passes', type: 'integer', min: 1, max: 5 }));
    expect(s.safeParse({ passes: 3 }).success).toBe(true);
    expect(s.safeParse({ passes: 3.5 }).success).toBe(false);
    expect(s.safeParse({ passes: 9 }).success).toBe(false);
  });

  it('applies the pattern the definition asked for', () => {
    const s = schemaOf(field({ key: 'code', pattern: '^[A-Z]{3}-\\d{2}$' }));
    expect(s.safeParse({ code: 'ABC-12' }).success).toBe(true);
    expect(s.safeParse({ code: 'abc-12' }).success).toBe(false);
  });

  it('holds a select to its picklist', () => {
    const s = schemaOf(field({ key: 'grade', type: 'select', picklistKey: 'grade' }));
    expect(s.safeParse({ grade: 'primary' }).success).toBe(true);
    expect(s.safeParse({ grade: 'invented' }).success).toBe(false);
  });

  it('still accepts a RETIRED value', () => {
    /**
     * Retiring a value means "stop choosing this", not "every record already
     * holding it becomes unsaveable". Rejecting it here would mean that the
     * next time somebody edited an unrelated field on the same record, the
     * save failed over a value they never touched. The renderer is what stops
     * it being offered.
     */
    const s = schemaOf(field({ key: 'grade', type: 'select', picklistKey: 'grade' }));
    expect(s.safeParse({ grade: 'legacy' }).success).toBe(true);
  });

  it('checks every member of a multiselect', () => {
    const s = schemaOf(field({ key: 'grades', type: 'multiselect', picklistKey: 'grade' }));
    expect(s.safeParse({ grades: ['primary', 'secondary'] }).success).toBe(true);
    expect(s.safeParse({ grades: ['primary', 'invented'] }).success).toBe(false);
  });

  it('wants a calendar date, not a timestamp', () => {
    const s = schemaOf(field({ key: 'sampled_on', type: 'date' }));
    expect(s.safeParse({ sampled_on: '2026-03-01' }).success).toBe(true);
    expect(s.safeParse({ sampled_on: '2026-03-01T00:00:00Z' }).success).toBe(false);
  });

  it('refuses every value for a type it cannot store', () => {
    // Fail closed. Accepting it would store data nothing can render.
    const s = schemaOf(field({ key: 'coa', type: 'attachment' }));
    expect(s.safeParse({ coa: 'anything' }).success).toBe(false);
    expect(s.safeParse({ coa: null }).success).toBe(false);
  });

  it('counts blank and empty as missing, for the button that submits', () => {
    const fs = [
      field({ key: 'a', required: true }),
      field({ key: 'b', required: true, type: 'multiselect', picklistKey: 'grade' }),
      field({ key: 'c' }),
    ];
    expect(missingRequired(fs, { a: '  ', b: [], c: 'x' })).toEqual(['a', 'b']);
    expect(missingRequired(fs, { a: 'x', b: ['primary'] })).toEqual([]);
  });
});

describe('what gets rendered', () => {
  const fields = [
    field({ key: 'second', sortOrder: 2 }),
    field({ key: 'first', sortOrder: 1 }),
  ];

  it('shows every field for the entity when no layout exists', () => {
    /**
     * Defining a field is enough to make it appear. Requiring a layout too
     * would mean an administrator defines a field, sees nothing, and cannot
     * tell a missing layout from a broken feature.
     */
    const form = resolveForm({ entity: 'lot', fields, layouts: [], roleKeys: [] });
    expect(form.layoutKey).toBeNull();
    expect(form.sections).toHaveLength(1);
    expect(form.sections[0]!.fields.map((f) => f.field.key)).toEqual(['first', 'second']);
  });

  it('renders nothing at all when the entity has no fields', () => {
    const form = resolveForm({ entity: 'capa', fields, layouts: [], roleKeys: [] });
    expect(form.sections).toEqual([]);
  });

  const layout = (over: Record<string, unknown> & { key: string }): LayoutConfig =>
    layoutConfigSchema.parse({
      entity: 'lot', name: `Layout ${over.key}`,
      sections: [{ title: 'Details', fields: [{ field: 'first' }] }],
      ...over,
    });

  it('prefers a layout restricted to a role the viewer holds', () => {
    const form = resolveForm({
      entity: 'lot', fields, roleKeys: ['quality'],
      layouts: [layout({ key: 'general' }), layout({ key: 'quality_only', roles: ['quality'] })],
    });
    expect(form.layoutKey).toBe('quality_only');
  });

  it('falls back to the unrestricted layout for everybody else', () => {
    const form = resolveForm({
      entity: 'lot', fields, roleKeys: ['scientist'],
      layouts: [layout({ key: 'general' }), layout({ key: 'quality_only', roles: ['quality'] })],
    });
    expect(form.layoutKey).toBe('general');
  });

  it('survives a layout that names a field no longer defined', () => {
    // publicationProblems refuses to publish this. It can still arrive from a
    // version published before that check existed, and a screen that throws is
    // a worse answer than a screen that shows what remains.
    const form = resolveForm({
      entity: 'lot', fields, roleKeys: [],
      layouts: [layout({
        key: 'stale',
        sections: [{ title: 'Details', fields: [{ field: 'first' }, { field: 'deleted' }] }],
      })],
    });
    expect(form.sections[0]!.fields.map((f) => f.field.key)).toEqual(['first']);
  });

  it('excludes read-only placements from what may be written', () => {
    const form = resolveForm({
      entity: 'lot', fields, roleKeys: [],
      layouts: [layout({
        key: 'mixed',
        sections: [{
          title: 'Details',
          fields: [{ field: 'first' }, { field: 'second', readOnly: true }],
        }],
      })],
    });
    expect(writableFields(form).map((f) => f.key)).toEqual(['first']);
  });
});
