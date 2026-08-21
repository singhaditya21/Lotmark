import { z } from 'zod';
import { CUSTOM_FIELD_ENTITIES } from './schemas';
import { ALL_MACHINES } from '../state-machines';
import type { FieldConfig, PicklistConfig, LayoutConfig } from './schemas';

/**
 * Turning field definitions into something that validates, and into something
 * that renders.
 *
 * ── One schema, built once, used by the only validator ──────────────────────
 *
 * The server is the only validator. `apps/web` has no zod dependency and
 * deliberately does not import @lotmark/domain — `surfaces.test.ts` re-declares
 * permissions as literal strings rather than importing them, and says why.
 * Sharing a schema into the browser would reverse that decision for the whole
 * console, so the client renders what the server hands it and gates on presence
 * only. Nothing is duplicated, so nothing can drift.
 *
 * ── Why the entity vocabulary is closed ─────────────────────────────────────
 *
 * `field.entity`, `layout.entity` and `view.entity` were free slugs. A field on
 * entity `widgets` published cleanly and rendered nowhere — configuration that
 * looks applied and does nothing, which is the failure mode this whole model is
 * supposed to prevent. The vocabulary is derived from the state machines rather
 * than listed again here, so a record type added to the product becomes
 * extensible without anybody remembering to update a second list.
 */

export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export function isCustomFieldEntity(v: string): v is CustomFieldEntity {
  return (CUSTOM_FIELD_ENTITIES as readonly string[]).includes(v);
}

/**
 * Where each record type lives, what its state column is called, and how it
 * reaches a team.
 *
 * Named for the entity rather than for custom fields, because it is not about
 * custom fields: `publicationProblems()` uses it to ask which states records
 * are CURRENTLY in before letting a workflow change remove one.
 *
 * Three questions, one map, because all three are asked at the same moment and
 * answering them separately is how they drift apart.
 *
 *  · The TABLE, because values hang off a record id and something has to check
 *    that the id names a real record in this tenant. Without it, values attach
 *    to any uuid at all — rows no screen shows, no parent can delete, and every
 *    count in the assessment pack quietly wrong.
 *
 *  · The STATE column, because a record that has reached a terminal state must
 *    stop accepting values. `projects` calls it `stage`; everything else calls
 *    it `state`.
 *
 *  · How it reaches a TEAM, because authority in this system is scoped. Sunil
 *    holds `lot:create` on Organics Section, not tenant-wide, and a guard that
 *    asks the tenant-wide question refuses him on his own lots. That exact bug
 *    has been found here twice before — see the holders endpoint.
 *
 * Exhaustive by construction: `Record<CustomFieldEntity, …>` means the compiler
 * refuses a new entity until it has been given all three.
 */
export const ENTITY_RECORD: Record<CustomFieldEntity, {
  readonly table: string;
  readonly stateColumn: string;
  /** 'own' — the table carries owner_team_id; 'project' — join to it; 'none'. */
  readonly teamVia: 'own' | 'project' | 'none';
}> = {
  project: { table: 'projects', stateColumn: 'stage', teamVia: 'own' },
  study: { table: 'studies', stateColumn: 'state', teamVia: 'own' },
  property_value: { table: 'property_values', stateColumn: 'state', teamVia: 'project' },
  lot: { table: 'lots', stateColumn: 'state', teamVia: 'own' },
  order: { table: 'orders', stateColumn: 'state', teamVia: 'own' },
  entitlement: { table: 'entitlements', stateColumn: 'state', teamVia: 'none' },
  capa: { table: 'capa', stateColumn: 'state', teamVia: 'own' },
};

/**
 * States after which a record's custom fields stop accepting changes.
 *
 * Exactly each machine's `terminal` array, DERIVED rather than restated, so the
 * two cannot disagree — a state added to a machine's terminal list freezes
 * custom fields on the same day, without anybody remembering a second list.
 *
 * The reason a freeze is needed at all is the same reason the table is
 * append-only, one step further on: append-only keeps the history of a change,
 * but a signed study whose custom fields can still be edited is a record whose
 * meaning moves after it was attested to. `field.onCertificate` makes that
 * concrete — the value on an issued certificate must not acquire a successor.
 */
export const FROZEN_STATES: Record<CustomFieldEntity, readonly string[]> =
  Object.fromEntries(
    CUSTOM_FIELD_ENTITIES.map((e) => [
      e, ALL_MACHINES.find((m) => m.name === e)?.terminal ?? [],
    ]),
  ) as Record<CustomFieldEntity, readonly string[]>;

export function isFrozen(entity: CustomFieldEntity, state: string | null): boolean {
  return state !== null && FROZEN_STATES[entity].includes(state);
}

/**
 * Who may see and who may set custom values, per entity.
 *
 * A custom field is part of its parent record, so the authority over it is the
 * authority over that record — there is deliberately no `customfield:write`
 * permission. Inventing one would mean a person who cannot edit a lot could
 * still change what a lot says, and it would be granted to nobody in every
 * tenant that already exists, since roles are stored configuration.
 *
 * Where a read has two candidate permissions the PRODUCER-side one is used, so
 * the failure is a refusal rather than an exposure.
 */
export const CUSTOM_FIELD_PERMISSIONS: Record<
  CustomFieldEntity, { read: string; write: string }
> = {
  project: { read: 'project:read', write: 'project:manage' },
  study: { read: 'project:read', write: 'study:run' },
  property_value: { read: 'project:read', write: 'value:assign' },
  lot: { read: 'project:read', write: 'lot:create' },
  order: { read: 'order:read_all', write: 'order:advance' },
  entitlement: { read: 'entitlement:decide', write: 'entitlement:decide' },
  capa: { read: 'capa:manage', write: 'capa:manage' },
};

/**
 * Types the form designer can store AND render, end to end.
 *
 * Three of `fieldTypeSchema`'s twelve are deliberately absent, and the line is
 * drawn at "a person can actually use it", not at "the server can validate it":
 *
 *  · `attachment` has no upload surface at all;
 *  · `user` and `team` validate as identifiers perfectly well, and rendering
 *    them means a picker. A text box asking somebody to paste a uuid is not a
 *    person picker, it is a way to record the wrong person.
 *
 * `publicationProblems()` refuses these by name, so a tenant is told when they
 * choose one rather than discovering it from whoever has to fill the form in.
 * Adding a picker later means deleting a line here and one from the renderer.
 */
export const SUPPORTED_FIELD_TYPES = [
  'text', 'textarea', 'number', 'integer', 'boolean',
  'date', 'datetime', 'select', 'multiselect',
] as const;

export function isSupportedFieldType(t: string): boolean {
  return (SUPPORTED_FIELD_TYPES as readonly string[]).includes(t);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The zod schema for one field's value, before optionality is applied.
 *
 * Retired picklist values are ACCEPTED here and not offered by the renderer.
 * Retiring a value means "stop choosing this", not "every record that already
 * holds it becomes unsaveable" — which is what rejecting it would mean the next
 * time somebody edited an unrelated field on the same record.
 */
function valueSchema(
  field: FieldConfig,
  picklists: ReadonlyMap<string, PicklistConfig>,
): z.ZodTypeAny {
  const options = () => {
    const list = field.picklistKey ? picklists.get(field.picklistKey) : undefined;
    return (list?.values ?? []).map((v) => v.value);
  };

  switch (field.type) {
    case 'text':
    case 'textarea': {
      let s = z.string();
      if (field.maxLength !== undefined) s = s.max(field.maxLength);
      if (field.pattern) s = s.regex(new RegExp(field.pattern), 'does not match the required pattern');
      return s;
    }
    case 'number':
    case 'integer': {
      let n = field.type === 'integer' ? z.number().int() : z.number();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.string().regex(ISO_DATE, 'must be a date, as YYYY-MM-DD');
    case 'datetime':
      return z.string().datetime({ offset: true });
    case 'select': {
      const allowed = options();
      return z.string().refine((v) => allowed.includes(v), 'not one of the allowed values');
    }
    case 'multiselect': {
      const allowed = options();
      return z.array(z.string().refine((v) => allowed.includes(v), 'not one of the allowed values'));
    }
    case 'user':
    case 'team':
      return z.string().regex(UUID, 'must be an identifier');
    default:
      /**
       * `attachment`, and anything added to `fieldTypeSchema` without being
       * taught here. Refusing every value is the fail-closed answer: the
       * alternative accepts data nothing can render or interpret.
       */
      return z.never();
  }
}

/**
 * The schema for a whole custom-field document.
 *
 * `strict()` matters. Without it, a key removed from configuration, or one that
 * was never defined, is accepted and stored — so the document accumulates data
 * no screen shows and no rule governs. A submit carrying an unknown key is a
 * client that is out of date, and it should be told so rather than have the
 * difference silently kept.
 *
 * Note what this does NOT do: it never deletes. Values already stored for a
 * field since removed from configuration stay in earlier revisions, which is
 * the whole point of the table being append-only.
 */
export function valuesSchemaFor(
  fields: readonly FieldConfig[],
  picklists: ReadonlyMap<string, PicklistConfig>,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    const base = valueSchema(f, picklists);
    /**
     * Required means "present and not blank", not merely "present". A required
     * text field submitted as an empty string is the commonest way a form is
     * filled in without being filled in.
     */
    shape[f.key] = f.required
      ? (f.type === 'text' || f.type === 'textarea'
          ? (base as z.ZodString).min(1, 'is required')
          : base)
      : base.optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/** Required fields with nothing usable in the document. */
export function missingRequired(
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
): string[] {
  return fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = values[f.key];
      if (v === undefined || v === null) return true;
      if (typeof v === 'string') return v.trim().length === 0;
      if (Array.isArray(v)) return v.length === 0;
      return false;
    })
    .map((f) => f.key);
}

/* ── What to render ───────────────────────────────────────────────────────── */

export interface ResolvedField {
  readonly field: FieldConfig;
  readonly span: number;
  readonly readOnly: boolean;
}

export interface ResolvedSection {
  readonly title: string;
  readonly columns: number;
  readonly collapsed: boolean;
  readonly fields: readonly ResolvedField[];
}

export interface ResolvedForm {
  readonly entity: string;
  /** The layout used, or null when falling back to every field for the entity. */
  readonly layoutKey: string | null;
  readonly sections: readonly ResolvedSection[];
}

/**
 * Which layout this person sees, and what it puts where.
 *
 * ── The fallback is deliberate ──────────────────────────────────────────────
 *
 * With no layout for an entity, every field for it is rendered in one section
 * ordered by `sortOrder`. So defining a field is enough to make it appear; a
 * layout is how you arrange fields, not how you switch them on. Requiring both
 * would mean an administrator defines a field, sees nothing, and has no way to
 * tell a missing layout from a broken feature.
 *
 * ── A field named by no layout is not rendered ──────────────────────────────
 *
 * Once a layout EXISTS for an entity it is authoritative, because the point of
 * a layout is to control the form. A required field left out of it could then
 * never be filled — so `publicationProblems()` refuses that combination rather
 * than leaving it to be discovered by somebody who cannot save a record.
 */
export function resolveForm(args: {
  entity: string;
  fields: readonly FieldConfig[];
  layouts: readonly LayoutConfig[];
  /** Role keys held by the viewer, for layouts restricted to particular roles. */
  roleKeys: readonly string[];
}): ResolvedForm {
  const mine = args.fields
    .filter((f) => f.entity === args.entity)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));

  const byKey = new Map(mine.map((f) => [f.key, f]));

  const candidates = args.layouts.filter((l) => l.entity === args.entity);
  // A layout naming roles applies only to those; one naming none applies to
  // everybody, and is the fallback when no role-specific layout matches.
  const layout =
    candidates.find((l) => l.roles.length > 0 && l.roles.some((r) => args.roleKeys.includes(r)))
    ?? candidates.find((l) => l.roles.length === 0)
    ?? null;

  if (!layout) {
    return {
      entity: args.entity,
      layoutKey: null,
      sections: mine.length === 0 ? [] : [{
        title: 'Additional information',
        columns: 2,
        collapsed: false,
        fields: mine.map((field) => ({ field, span: 1, readOnly: false })),
      }],
    };
  }

  return {
    entity: args.entity,
    layoutKey: layout.key,
    sections: layout.sections.map((s) => ({
      title: s.title,
      columns: s.columns,
      collapsed: s.collapsed,
      fields: s.fields
        // A layout can outlive the field it names — see publicationProblems,
        // which refuses to publish that, and this, which survives it anyway.
        .filter((p) => byKey.has(p.field))
        .map((p) => ({ field: byKey.get(p.field)!, span: p.span, readOnly: p.readOnly })),
    })),
  };
}

/** Every field the resolved form can actually write, across all its sections. */
export function writableFields(form: ResolvedForm): FieldConfig[] {
  return form.sections.flatMap((s) => s.fields.filter((f) => !f.readOnly).map((f) => f.field));
}
