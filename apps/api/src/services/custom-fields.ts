import {
  fieldConfigSchema, picklistConfigSchema, layoutConfigSchema,
  resolveForm, writableFields, valuesSchemaFor, missingRequired,
  ENTITY_RECORD, isCustomFieldEntity, isFrozen,
  type FieldConfig, type PicklistConfig, type LayoutConfig,
  type CustomFieldEntity, type ResolvedForm,
} from '@lotmark/domain';
import { inSavepoint, type Sql } from '../db';
import { activeVersion, entriesOf } from './config-admin';

/**
 * Custom fields at runtime.
 *
 * The configuration model has been able to DESCRIBE fields, picklists and
 * layouts since it was written, and nothing has ever read one. This is the
 * reader: it resolves what a person should see, validates what they submit
 * against the definitions rather than against a hand-written schema, and
 * appends the result.
 *
 * ── Stored configuration is validated on read ───────────────────────────────
 *
 * Every payload is `safeParse`d here, exactly as `session.ts` does with roles,
 * and an entry that fails is skipped with a log rather than thrown over. A
 * single malformed field definition must not take out the record it appears on;
 * `publicationProblems()` is what stops one being published in the first place.
 */

export class CustomFieldError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(message);
    this.name = 'CustomFieldError';
  }
}

export interface Definitions {
  readonly versionId: string;
  readonly fields: FieldConfig[];
  readonly picklists: Map<string, PicklistConfig>;
  readonly layouts: LayoutConfig[];
}

export async function activeDefinitions(
  tx: Sql, tenantId: string, onBadEntry?: (msg: string) => void,
): Promise<Definitions | null> {
  const active = await activeVersion(tx, tenantId);
  if (!active) return null;
  return definitionsFrom(tx, active.id, onBadEntry);
}

/**
 * The same read, against ANY version.
 *
 * Exists so the form designer's preview is produced by this resolver rather
 * than by a second one written in the browser. A preview built from a copy of
 * these rules is a preview that can be right about a form the runtime renders
 * differently, which is worse than no preview.
 */
export async function definitionsFrom(
  tx: Sql, versionId: string, onBadEntry?: (msg: string) => void,
): Promise<Definitions> {
  const entries = await entriesOf(tx, versionId);

  const fields: FieldConfig[] = [];
  const picklists = new Map<string, PicklistConfig>();
  const layouts: LayoutConfig[] = [];

  for (const e of entries) {
    if (e.kind === 'field') {
      const r = fieldConfigSchema.safeParse(e.payload);
      if (r.success) fields.push(r.data);
      else onBadEntry?.(`field '${e.key}' in the active version does not parse and was ignored`);
    } else if (e.kind === 'picklist') {
      const r = picklistConfigSchema.safeParse(e.payload);
      if (r.success) picklists.set(e.key, r.data);
      else onBadEntry?.(`picklist '${e.key}' in the active version does not parse and was ignored`);
    } else if (e.kind === 'layout') {
      const r = layoutConfigSchema.safeParse(e.payload);
      if (r.success) layouts.push(r.data);
      else onBadEntry?.(`layout '${e.key}' in the active version does not parse and was ignored`);
    }
  }

  return { versionId, fields, picklists, layouts };
}

/** The form for one entity, plus the option lists it needs to render. */
export interface RenderableForm extends ResolvedForm {
  readonly picklists: Record<string, Array<{
    value: string; label: string; retired: boolean;
  }>>;
}

export function renderableForm(
  defs: Definitions, entity: string, roleKeys: readonly string[],
): RenderableForm {
  const form = resolveForm({
    entity, fields: defs.fields, layouts: defs.layouts, roleKeys,
  });

  // Only the lists this form actually draws from, sorted as configured. A
  // retired value is sent WITH its flag rather than withheld: a record may
  // already hold one, and the renderer needs the label to show it.
  const needed = new Set(
    form.sections.flatMap((s) => s.fields.map((f) => f.field.picklistKey)).filter(Boolean),
  );
  const picklists: RenderableForm['picklists'] = {};
  for (const k of needed) {
    const list = defs.picklists.get(k as string);
    if (!list) continue;
    picklists[k as string] = [...list.values]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
      .map((v) => ({ value: v.value, label: v.label, retired: v.retired }));
  }

  return { ...form, picklists };
}

export interface Revision {
  readonly revision: number;
  readonly values: Record<string, unknown>;
  readonly configVersionId: string;
  readonly recordedBy: string;
  readonly recordedByName: string;
  readonly reason: string | null;
  readonly recordedAt: string;
}

export async function currentRevision(
  tx: Sql, entity: string, recordId: string,
): Promise<Revision | null> {
  const rows = await tx`
    SELECT v.revision, v."values", v.config_version_id, v.recorded_by,
           u.display_name AS recorded_by_name, v.reason, v.created_at
    FROM lotmark.custom_field_values v
    JOIN lotmark.users u ON u.id = v.recorded_by
    WHERE v.entity = ${entity} AND v.record_id = ${recordId}
    ORDER BY v.revision DESC
    LIMIT 1`;
  return rows.length === 0 ? null : rowToRevision(rows[0]);
}

/**
 * The current document as PLAIN values, for a guard to read.
 *
 * `{}` when nothing has been recorded, so a guard asking about a custom field
 * on a record that has none sees an absent value rather than an error — absent
 * and empty are the same question to somebody writing a rule.
 */
export async function currentCustomValues(
  tx: Sql, entity: string, recordId: string,
): Promise<Record<string, unknown>> {
  const current = await currentRevision(tx, entity, recordId);
  return current?.values ?? {};
}

/** Every revision, oldest first — the trail §11.10(e) asks for. */
export async function revisionHistory(
  tx: Sql, entity: string, recordId: string,
): Promise<Revision[]> {
  const rows = await tx`
    SELECT v.revision, v."values", v.config_version_id, v.recorded_by,
           u.display_name AS recorded_by_name, v.reason, v.created_at
    FROM lotmark.custom_field_values v
    JOIN lotmark.users u ON u.id = v.recorded_by
    WHERE v.entity = ${entity} AND v.record_id = ${recordId}
    ORDER BY v.revision`;
  return rows.map(rowToRevision);
}

function rowToRevision(r: unknown): Revision {
  const row = r as {
    revision: number; values: Record<string, unknown>; config_version_id: string;
    recorded_by: string; recorded_by_name: string; reason: string | null; created_at: string;
  };
  return {
    revision: row.revision,
    values: row.values,
    configVersionId: row.config_version_id,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    reason: row.reason,
    recordedAt: row.created_at,
  };
}

export interface ParentRecord {
  /** null means tenant-wide, which is what the guard is then asked. */
  readonly ownerTeamId: string | null;
  readonly state: string | null;
  readonly frozen: boolean;
}

/**
 * The parent record: does it exist here, whose team is it, and is it finished?
 *
 * All three are asked at the same moment and answered by one query, because
 * asking them separately is three round trips and three chances to disagree.
 *
 * ── Why the team matters ────────────────────────────────────────────────────
 *
 * Authority in this system is SCOPED. Sunil holds `lot:create` on Organics
 * Section, not tenant-wide, so a guard that asks the tenant-wide question
 * refuses him on his own lots — which is exactly what the first version of
 * these routes did, and exactly the bug the certificate-holders endpoint had
 * before it. The scope comes from the record, never from an assumption.
 *
 * ── Why the identifiers are interpolated ────────────────────────────────────
 *
 * A table name cannot be a bind parameter. `isCustomFieldEntity` has already
 * narrowed the request's string to one of seven literals before this is
 * reached, and the table and column names come from a compiler-checked map — so
 * what is interpolated is one of seven values chosen at compile time, never
 * anything from the request. The safety is the narrowing, not the quoting.
 */
export async function parentRecord(
  tx: Sql, tenantId: string, entity: CustomFieldEntity, recordId: string,
): Promise<ParentRecord | null> {
  const meta = ENTITY_RECORD[entity];

  const team =
    meta.teamVia === 'own' ? 'r.owner_team_id'
    : meta.teamVia === 'project' ? 'p.owner_team_id'
    : 'NULL::uuid';
  const join = meta.teamVia === 'project'
    ? 'LEFT JOIN lotmark.projects p ON p.id = r.project_id' : '';

  const rows = await tx.unsafe(
    `SELECT ${team} AS owner_team_id, r.${meta.stateColumn} AS state
     FROM lotmark.${meta.table} r ${join}
     WHERE r.tenant_id = $1 AND r.id = $2 LIMIT 1`,
    [tenantId, recordId],
  );
  if (rows.length === 0) return null;
  const row = rows[0] as unknown as { owner_team_id: string | null; state: string | null };
  return {
    ownerTeamId: row.owner_team_id,
    state: row.state,
    frozen: isFrozen(entity, row.state),
  };
}

export interface SaveResult {
  readonly outcome:
    | 'saved' | 'conflict' | 'invalid' | 'no_such_record' | 'not_configurable' | 'frozen';
  readonly revision?: number;
  readonly problems?: string[];
  readonly currentRevision?: number;
  /** The terminal state the parent is in, when refused for that reason. */
  readonly state?: string | undefined;
}

/**
 * Append the next revision of a record's custom-field document.
 *
 * ── What is merged, and what is not ─────────────────────────────────────────
 *
 * Only WRITABLE fields may be submitted; a value for a read-only placement is
 * refused rather than ignored, because ignoring it means the person watched
 * their edit vanish. Values for read-only fields are carried forward from the
 * previous revision, so a save never silently blanks them.
 *
 * Values for fields since REMOVED from configuration are NOT carried forward.
 * They are not destroyed either — the revision that holds them is still there,
 * which is what the table being append-only buys. Carrying them forward would
 * mean a document that no configuration explains growing indefinitely.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 *
 * The caller says which revision it read. This writes the next one, and the
 * unique index refuses if somebody else already did — so the second of two
 * simultaneous edits is a 409 rather than a silent overwrite. No lock is taken:
 * `SELECT … FOR UPDATE` needs the UPDATE privilege, which this table
 * deliberately does not grant.
 */
export async function saveValues(
  tx: Sql,
  args: {
    tenantId: string;
    entity: string;
    recordId: string;
    submitted: Record<string, unknown>;
    basedOnRevision: number;
    recordedBy: string;
    reason: string | null;
    roleKeys: readonly string[];
    onBadEntry?: (msg: string) => void;
  },
): Promise<SaveResult> {
  if (!isCustomFieldEntity(args.entity)) return { outcome: 'not_configurable' };

  const defs = await activeDefinitions(tx, args.tenantId, args.onBadEntry);
  if (!defs) {
    return {
      outcome: 'invalid',
      problems: ['This tenant has no active configuration, so there are no field definitions to check against.'],
    };
  }

  const parent = await parentRecord(tx, args.tenantId, args.entity, args.recordId);
  if (!parent) return { outcome: 'no_such_record' };

  /**
   * A finished record stops accepting values.
   *
   * Append-only keeps the history of a change; it does not stop the change. A
   * signed study whose custom fields can still be edited is a record whose
   * meaning moves after somebody attested to it — and `field.onCertificate`
   * makes that concrete, because the value on an issued certificate must not
   * acquire a successor.
   */
  if (parent.frozen) {
    return { outcome: 'frozen', state: parent.state ?? undefined };
  }

  const form = resolveForm({
    entity: args.entity, fields: defs.fields, layouts: defs.layouts, roleKeys: args.roleKeys,
  });
  const writable = writableFields(form);
  const writableKeys = new Set(writable.map((f) => f.key));

  if (writable.length === 0) {
    return {
      outcome: 'invalid',
      problems: [`No custom fields are configured for ${args.entity}, so there is nothing to save.`],
    };
  }

  const refused = Object.keys(args.submitted).filter((k) => !writableKeys.has(k));
  if (refused.length > 0) {
    return {
      outcome: 'invalid',
      problems: refused.map((k) =>
        `'${k}' is not a field you can set on this record. It may have been removed from ` +
        'configuration, or it may be read-only here.'),
    };
  }

  const previous = await currentRevision(tx, args.entity, args.recordId);

  // Carry forward read-only values, and only for fields that still exist.
  const carried: Record<string, unknown> = {};
  const known = new Set(defs.fields.filter((f) => f.entity === args.entity).map((f) => f.key));
  for (const [k, v] of Object.entries(previous?.values ?? {})) {
    if (known.has(k) && !writableKeys.has(k)) carried[k] = v;
  }

  const document = { ...carried, ...args.submitted };

  const entityFields = defs.fields.filter((f) => f.entity === args.entity);
  const schema = valuesSchemaFor(entityFields, defs.picklists);
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    return {
      outcome: 'invalid',
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(document)'}: ${i.message}`),
    };
  }

  const stillMissing = missingRequired(entityFields, parsed.data);
  if (stillMissing.length > 0) {
    return {
      outcome: 'invalid',
      problems: stillMissing.map((k) => `'${k}' is required and was not given a value.`),
    };
  }

  const next = args.basedOnRevision + 1;

  /**
   * The INSERT goes inside a SAVEPOINT, and the reason is not stylistic.
   *
   * PostgreSQL aborts the whole transaction on any statement error. Catching
   * the unique violation and carrying on therefore does NOT work: every later
   * statement returns "current transaction is aborted", and the COMMIT re-raises
   * the original error — so a concurrent edit that should be a 409 arrives as a
   * 500, and the audit entry the route was about to write is lost with it.
   *
   * Measured before writing this, not assumed. The catch fires, `SELECT 1`
   * immediately after it fails, and the commit throws the duplicate-key error
   * a second time. A savepoint rolls back just the INSERT and leaves the
   * transaction usable, which is the only way to turn an expected constraint
   * violation into an answer rather than a crash.
   *
   * Same family as the signing-rollback defect: a database error swallowed
   * mid-transaction is never actually handled.
   */
  try {
    await inSavepoint(tx, async (sp) => {
      await sp`
        INSERT INTO lotmark.custom_field_values
          (tenant_id, entity, record_id, revision, "values", config_version_id, recorded_by, reason)
        VALUES (${args.tenantId}, ${args.entity}, ${args.recordId}, ${next},
                ${tx.json(parsed.data as never)}, ${defs.versionId}, ${args.recordedBy},
                ${args.reason})`;
    });
  } catch (e) {
    // 23505 — the revision exists, so somebody else saved between this caller's
    // read and its write. Reported as a conflict, never resolved by guessing
    // which of the two edits was meant.
    if (isUniqueViolation(e)) {
      return { outcome: 'conflict', currentRevision: previous?.revision ?? 0 };
    }
    throw e;
  }

  return { outcome: 'saved', revision: next };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
