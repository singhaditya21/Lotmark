/**
 * The decisions the custom-field renderer makes, separated from the rendering.
 *
 * This app tests library functions and not components — see `surfaces.ts` and
 * `capa.ts`, which exist for the same reason. What is here is everything that
 * could be wrong in a way a screenshot would not show.
 */

export interface Option { value: string; label: string; retired: boolean }

/**
 * Is this value absent, for the purpose of "required"?
 *
 * Required means present AND not blank. A required text field submitted as an
 * empty string is the commonest way a form is filled in without being filled
 * in, and the server takes the same view — this is only what decides whether
 * the Save button is offered.
 */
export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Which picklist options to offer.
 *
 * Retired ones are hidden — that is what retiring means — EXCEPT when this
 * record already holds one. Hiding it unconditionally renders a stored value as
 * a blank control, and the next save loses it without anybody choosing to.
 */
export function offered(options: readonly Option[], value: unknown): Option[] {
  const held = Array.isArray(value)
    ? value.map((v) => String(v))
    : [value === undefined || value === null ? '' : String(value)];
  return options.filter((o) => !o.retired || held.includes(o.value));
}

/** Required fields with nothing in them, by label, for the disabled-button hint. */
export function stillNeeded(
  sections: ReadonlyArray<{
    fields: ReadonlyArray<{
      field: { key: string; label: string; required: boolean };
      readOnly: boolean;
    }>;
  }>,
  values: Record<string, unknown>,
): string[] {
  return sections
    .flatMap((s) => s.fields)
    .filter((p) => !p.readOnly && p.field.required)
    .filter((p) => isBlank(values[p.field.key]))
    .map((p) => p.field.label);
}

/**
 * What a `datetime-local` control gives, turned into an instant.
 *
 * The control produces local wall-clock time with no offset; the server wants
 * an unambiguous instant. Converting here rather than accepting both means one
 * representation is stored, and it means the same moment however the reader's
 * clock is set.
 */
export function toInstant(localValue: string): string | undefined {
  if (!localValue) return undefined;
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
