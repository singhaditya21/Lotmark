import {
  diffConfig, parseConfigPayload, requiresSignatureToPublish, changesRequireSignature,
  effectivePermissionsOfRole, roleConfigSchema, isPermission, RETENTION_SCHEDULE,
  ALL_CONFIG_KINDS, CONFIG_RISK, hasProductDefault,
  fieldConfigSchema, picklistConfigSchema, layoutConfigSchema, isSupportedFieldType,
  workflowConfigSchema, statesTheDatabaseRefuses, ENTITY_RECORD, alwaysSigned,
  guardProblems,
  type ConfigKind, type ConfigChange, type RoleConfig,
  type FieldConfig, type PicklistConfig, type LayoutConfig, type WorkflowConfig,
} from '@lotmark/domain';
import { createHash } from 'node:crypto';
import type { Sql } from '../db';

/**
 * Administering the configuration model.
 *
 * The model has been enforced since the first migration — entries are writable
 * only on a draft, a published version is immutable, one version is active —
 * and there has never been a way to use it. Every role, workflow and numbering
 * template came from the seed, so "everything is configurable" described the
 * schema and not the product.
 *
 * ── The rule everything else follows from ───────────────────────────────────
 *
 * A published version is NEVER edited. Editing means creating a new draft based
 * on it and publishing that. Under GAMP 5 and 21 CFR Part 11 the validation
 * evidence attests what the system does; if a tenant could change a workflow in
 * place, the evidence would be stale the moment they did and records created
 * yesterday would have been created under rules nobody can reconstruct.
 *
 * ── What is checked before a version can be published ───────────────────────
 *
 * A configuration that fails to resolve does not degrade gracefully: `session.ts`
 * throws when no role parses, which means EVERY user is locked out, including
 * the administrator who published it and would have to fix it. So publication
 * validates the whole configuration first, and refuses rather than leaving a
 * tenant nobody can sign in to.
 */

export interface ConfigVersionRow {
  readonly id: string;
  readonly version_number: number;
  readonly status: 'draft' | 'active' | 'superseded';
  readonly change_reason: string;
  readonly based_on_version_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly published_by: string | null;
  readonly published_at: string | null;
  readonly signature_id: string | null;
  readonly change_summary: ConfigChange[];
}

export interface ConfigEntryRow {
  readonly id: string;
  readonly kind: ConfigKind;
  readonly key: string;
  readonly payload: unknown;
  readonly overrides_default: boolean;
}

export class ConfigAdminError extends Error {
  constructor(message: string, readonly problems: readonly string[] = []) {
    super(message);
    this.name = 'ConfigAdminError';
  }
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export async function versionsOf(tx: Sql, tenantId: string): Promise<ConfigVersionRow[]> {
  const rows = await tx`
    SELECT id, version_number, status, change_reason, based_on_version_id,
           created_by, created_at, published_by, published_at, signature_id, change_summary
    FROM lotmark.config_versions
    WHERE tenant_id = ${tenantId}
    ORDER BY version_number DESC`;
  return rows as unknown as ConfigVersionRow[];
}

export async function versionById(
  tx: Sql, tenantId: string, versionId: string,
): Promise<ConfigVersionRow | null> {
  const [row] = await tx`
    SELECT id, version_number, status, change_reason, based_on_version_id,
           created_by, created_at, published_by, published_at, signature_id, change_summary
    FROM lotmark.config_versions
    WHERE tenant_id = ${tenantId} AND id = ${versionId} LIMIT 1`;
  return (row as unknown as ConfigVersionRow | undefined) ?? null;
}

export async function activeVersion(tx: Sql, tenantId: string): Promise<ConfigVersionRow | null> {
  const [row] = await tx`
    SELECT id, version_number, status, change_reason, based_on_version_id,
           created_by, created_at, published_by, published_at, signature_id, change_summary
    FROM lotmark.config_versions
    WHERE tenant_id = ${tenantId} AND status = 'active' LIMIT 1`;
  return (row as unknown as ConfigVersionRow | undefined) ?? null;
}

export async function draftVersion(tx: Sql, tenantId: string): Promise<ConfigVersionRow | null> {
  const [row] = await tx`
    SELECT id, version_number, status, change_reason, based_on_version_id,
           created_by, created_at, published_by, published_at, signature_id, change_summary
    FROM lotmark.config_versions
    WHERE tenant_id = ${tenantId} AND status = 'draft' LIMIT 1`;
  return (row as unknown as ConfigVersionRow | undefined) ?? null;
}

export async function entriesOf(tx: Sql, versionId: string): Promise<ConfigEntryRow[]> {
  const rows = await tx`
    SELECT id, kind, key, payload, overrides_default
    FROM lotmark.config_entries WHERE version_id = ${versionId}
    ORDER BY kind, key`;
  return rows as unknown as ConfigEntryRow[];
}

/* ── Editing ──────────────────────────────────────────────────────────────── */

/**
 * Open a draft by COPYING the active version's entries.
 *
 * A copy, not a reference. The draft has to be editable without the active
 * version changing under the running system, and the diff needs a fixed
 * baseline — `based_on_version_id` records which version that was, so
 * `change_summary` is a derivation rather than a claim.
 *
 * One draft per tenant, enforced by a partial unique index in 0017: two open
 * drafts are a fork, and whichever publishes second silently discards the
 * other's changes while reporting success.
 */
export async function createDraft(
  tx: Sql,
  args: { tenantId: string; userId: string; changeReason: string },
): Promise<ConfigVersionRow> {
  const existing = await draftVersion(tx, args.tenantId);
  if (existing) {
    throw new ConfigAdminError(
      `Version ${existing.version_number} is already open as a draft. ` +
      'Publish or discard it before starting another — two open drafts are a fork, ' +
      'and the second to publish would silently discard the first.',
    );
  }

  const base = await activeVersion(tx, args.tenantId);
  if (!base) throw new ConfigAdminError('This tenant has no active configuration to base a draft on.');

  const [row] = await tx`
    INSERT INTO lotmark.config_versions
      (tenant_id, version_number, status, change_reason, based_on_version_id, created_by)
    SELECT ${args.tenantId}, coalesce(max(version_number), 0) + 1, 'draft',
           ${args.changeReason}, ${base.id}, ${args.userId}
    FROM lotmark.config_versions WHERE tenant_id = ${args.tenantId}
    RETURNING id, version_number, status, change_reason, based_on_version_id,
              created_by, created_at, published_by, published_at, signature_id, change_summary`;
  const draft = row as unknown as ConfigVersionRow;

  await tx`
    INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload, overrides_default)
    SELECT ${args.tenantId}, ${draft.id}, e.kind, e.key, e.payload, e.overrides_default
    FROM lotmark.config_entries e WHERE e.version_id = ${base.id}`;

  return draft;
}

/** Write one entry into a draft. The payload is validated against its kind. */
export async function upsertEntry(
  tx: Sql,
  args: { tenantId: string; versionId: string; kind: ConfigKind; key: string; payload: unknown },
): Promise<void> {
  if (!ALL_CONFIG_KINDS.includes(args.kind)) {
    throw new ConfigAdminError(`'${args.kind}' is not a configurable kind.`);
  }
  const parsed = parseConfigPayload(args.kind, args.payload);
  if (!parsed.success) {
    throw new ConfigAdminError(
      `This ${args.kind} is not valid.`,
      parsed.error.issues.map((i) => `${i.path.join('.') || args.kind}: ${i.message}`),
    );
  }

  // The draft_only trigger refuses a write to a published version, so this is
  // belt and braces — but it produces a message an administrator can act on
  // rather than a trigger's exception.
  const version = await versionById(tx, args.tenantId, args.versionId);
  if (!version) throw new ConfigAdminError('No such configuration version.');
  if (version.status !== 'draft') {
    throw new ConfigAdminError(
      `Version ${version.version_number} is ${version.status} and cannot be edited. ` +
      'Open a new draft based on it instead — a published version is never edited, ' +
      'which is what makes "under what rules was this issued" answerable later.',
    );
  }

  /**
   * The key COLUMN and the key inside the payload are the same identifier, and
   * must say the same thing.
   *
   * They are stored twice because the column is what a query joins and orders
   * on, and the payload is what a reader parses. Nothing made them agree, so
   * `key: 'my-layout'` with `payload.key: 'my_layout'` stored a row that
   * resolved under one name and not the other — a lookup miss that looks
   * exactly like a missing entry.
   *
   * `sod` is the one kind whose payload has no `key` (it is identified by
   * `ruleId`), so the check is conditional on the payload having one rather
   * than on a list of kinds that would need updating whenever a kind is added.
   */
  const payloadKey = (parsed.data as { key?: unknown }).key;
  if (typeof payloadKey === 'string' && payloadKey !== args.key) {
    throw new ConfigAdminError(
      `This entry is filed under '${args.key}' but its content calls itself ` +
      `'${payloadKey}'. They are the same identifier and must match.`,
    );
  }

  /**
   * Whether this replaces something the product ships, asked rather than
   * assumed — and set on BOTH branches, so an entry does not carry a different
   * answer depending on whether it was created or edited.
   */
  const overrides = hasProductDefault(args.kind, args.key);

  await tx`
    INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload, overrides_default)
    VALUES (${args.tenantId}, ${args.versionId}, ${args.kind}, ${args.key},
            ${tx.json(parsed.data as never)}, ${overrides})
    ON CONFLICT (version_id, kind, key)
    DO UPDATE SET payload = ${tx.json(parsed.data as never)},
                  overrides_default = ${overrides},
                  updated_at = now()`;
}

export async function removeEntry(
  tx: Sql,
  args: { tenantId: string; versionId: string; kind: ConfigKind; key: string },
): Promise<void> {
  const version = await versionById(tx, args.tenantId, args.versionId);
  if (!version) throw new ConfigAdminError('No such configuration version.');
  if (version.status !== 'draft') {
    throw new ConfigAdminError(`Version ${version.version_number} is ${version.status} and cannot be edited.`);
  }
  await tx`
    DELETE FROM lotmark.config_entries
    WHERE version_id = ${args.versionId} AND kind = ${args.kind} AND key = ${args.key}`;
}

/* ── Reviewing ────────────────────────────────────────────────────────────── */

/** What this draft changes, against the version it was based on. */
export async function diffDraft(
  tx: Sql, tenantId: string, draftId: string,
): Promise<ConfigChange[]> {
  const draft = await versionById(tx, tenantId, draftId);
  if (!draft) throw new ConfigAdminError('No such configuration version.');
  const baseId = draft.based_on_version_id;
  const before = baseId ? await entriesOf(tx, baseId) : [];
  const after = await entriesOf(tx, draftId);
  return diffConfig(
    before.map((e) => ({ kind: e.kind, key: e.key, payload: e.payload })),
    after.map((e) => ({ kind: e.kind, key: e.key, payload: e.payload })),
  );
}

/**
 * A digest of exactly what changed.
 *
 * Signed alongside the version's identity, so the signature covers the diff the
 * approver was shown rather than the configuration as a whole. A signature over
 * the whole document would still verify after an unrelated entry moved.
 */
export function changeDigest(changes: readonly ConfigChange[]): string {
  const canonical = [...changes]
    .map((c) => `${c.kind}|${c.key}|${c.change}|${c.risk}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Everything wrong with a configuration, rather than the first thing wrong.
 *
 * ── Why this refuses instead of warning ─────────────────────────────────────
 *
 * A configuration that does not resolve does not degrade gracefully.
 * `session.ts` throws when no role parses — deliberately, because proceeding
 * would authorise nothing and look identical to a permissions bug. The
 * consequence is that publishing a broken configuration locks out EVERY user of
 * the tenant, including the administrator who published it and who would be the
 * one to fix it.
 */
export async function publicationProblems(
  tx: Sql, tenantId: string, versionId: string,
): Promise<string[]> {
  const entries = await entriesOf(tx, versionId);
  const problems: string[] = [];

  const roles = new Map<string, RoleConfig>();
  for (const e of entries.filter((x) => x.kind === 'role')) {
    const parsed = roleConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      problems.push(`Role '${e.key}' is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    roles.set(e.key, parsed.data);
  }

  if (roles.size === 0) {
    problems.push(
      'This configuration defines no valid role. Publishing it would lock every user out ' +
      'of the tenant, including you — sign-in resolves authority from the active version ' +
      'and fails closed when none of it parses.',
    );
  }

  for (const [key, role] of roles) {
    // A permission the code does not enforce is a capability nothing checks.
    for (const p of role.permissions) {
      if (!isPermission(p)) {
        problems.push(`Role '${key}' grants '${p}', which is not a permission this system enforces.`);
      }
    }
    // Inheritance cycles throw inside the resolver, at sign-in, for everyone.
    try {
      effectivePermissionsOfRole(key, roles);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : `Role '${key}' does not resolve.`);
    }
  }

  /**
   * Every role somebody actually holds must still exist.
   *
   * Removing a role from the configuration does not revoke the assignments
   * naming it — `resolveRoleKinds` skips the unknown role and `resolveAuthority`
   * throws on it. Either way the person silently loses everything, and the
   * assignment stays in the table looking valid.
   */
  const assigned = await tx`
    SELECT DISTINCT ra.role_key, count(*)::int AS holders
    FROM lotmark.role_assignments ra
    WHERE ra.tenant_id = ${tenantId} AND ra.revoked_at IS NULL
    GROUP BY ra.role_key`;
  for (const r of assigned) {
    const row = r as { role_key: string; holders: number };
    if (!roles.has(row.role_key)) {
      problems.push(
        `Role '${row.role_key}' is held by ${row.holders} ` +
        `${row.holders === 1 ? 'person' : 'people'} but is not defined in this version. ` +
        'Revoke those assignments first, or keep the role.',
      );
    }
  }

  /** A retention override must name a class that exists in the statutory schedule. */
  const classIds = new Set(RETENTION_SCHEDULE.map((c) => c.id as string));
  for (const e of entries.filter((x) => x.kind === 'retention')) {
    if (!classIds.has(e.key)) {
      problems.push(`Retention override '${e.key}' does not name a class in the statutory schedule.`);
    }
  }

  problems.push(...await customFieldProblems(tx, tenantId, entries));
  problems.push(...await workflowProblems(tx, tenantId, entries));

  return problems;
}

/**
 * Whether the workflows in this version can govern the records that exist.
 *
 * ── The active version governs every record ─────────────────────────────────
 *
 * Not the version each record was created under. Two lots of the same kind
 * following different rules because they were made on different days is not
 * something an operator can hold in their head or an assessor can be shown. The
 * price of that choice is paid here: a published change that removes a state
 * records are sitting in would strand them, so it is refused.
 *
 * The precedent is exactly the role check above — removing a role somebody
 * holds is refused for the same reason, and the message has the same shape:
 * name the thing, count who is affected, say what to do.
 */
async function workflowProblems(
  tx: Sql, tenantId: string, entries: readonly ConfigEntryRow[],
): Promise<string[]> {
  const problems: string[] = [];

  const workflows: WorkflowConfig[] = [];
  for (const e of entries.filter((x) => x.kind === 'workflow')) {
    const parsed = workflowConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      problems.push(`Workflow '${e.key}' is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    workflows.push(parsed.data);
  }

  for (const wf of workflows) {
    /**
     * A state the database could not store.
     *
     * `studies.state` carries a CHECK listing its two states. A configured
     * study workflow adding a third fails at the INSERT, which reaches a user
     * as a 500 long after the change was signed off. Said here instead.
     */
    for (const state of statesTheDatabaseRefuses(wf)) {
      problems.push(
        `Workflow '${wf.key}' adds the state '${state}' to ${wf.entity}, which the database ` +
        'cannot store — that column carries a CHECK listing the states it accepts. ' +
        'Making those states extensible is a schema change, not a configuration one.',
      );
    }

    /**
     * A signature cannot be configured away.
     *
     * `ALWAYS_SIGNED` is the floor — the acts 21 CFR 11 §11.50 makes the point
     * of the record. A tenant may add a signature to any move; switching one of
     * these off would be configuring its way out of the regulation, and the
     * runtime ORs the floor in regardless. Refusing it here means the
     * administrator is told rather than having their setting silently ignored,
     * which is the difference between a rule and a trap.
     */
    for (const t of wf.transitions) {
      if (alwaysSigned(t.requires) && t.requiresSignature === false) {
        problems.push(
          `Workflow '${wf.key}' turns the signature off for ${t.from} → ${t.to}, ` +
          `but '${t.requires}' always manifests one. Configuration can add a signature ` +
          'to a move; it cannot take this one away.',
        );
      }
      if (t.requiresSignature === true && t.signatureMeanings.length === 0) {
        // §11.50(a)(3): the meaning is chosen by the signer, so there has to be
        // something to choose from. An empty list would offer an empty select.
        problems.push(
          `Workflow '${wf.key}' asks for a signature on ${t.from} → ${t.to} but offers no ` +
          'meaning for the signer to choose. A signature manifests a meaning.',
        );
      }
    }

    /**
     * Guards, checked here rather than discovered at the move.
     *
     * A guard that does not parse, or names a fact the entity does not offer,
     * REFUSES the transition at runtime — failing closed is the only safe
     * reading of a rule nobody can evaluate. That is the right behaviour and a
     * terrible way to find out, so publication reads every guard first, against
     * the entity's vocabulary and the custom fields THIS version declares.
     */
    const customKeys = entries
      .filter((e) => e.kind === 'field')
      .map((e) => fieldConfigSchema.safeParse(e.payload))
      .filter((r) => r.success && r.data.entity === wf.entity)
      .map((r) => (r as { data: FieldConfig }).data.key);

    for (const t of wf.transitions) {
      for (const g of t.guards) {
        for (const problem of guardProblems(g, wf.entity, customKeys)) {
          problems.push(
            `Workflow '${wf.key}', the guard on ${t.from} → ${t.to}: ${problem.message}`,
          );
        }
      }
    }

    const record = ENTITY_RECORD[wf.entity as keyof typeof ENTITY_RECORD];
    if (!record) continue;

    /**
     * States records are actually sitting in, which the new machine must keep.
     *
     * Identifiers come from a compiler-checked map and never from the entry —
     * `wf.entity` has already been narrowed by the schema to one of seven
     * literals. A table name cannot be a bind parameter; the safety is the
     * narrowing, not the quoting.
     */
    const rows = await tx.unsafe(
      `SELECT r.${record.stateColumn} AS state, count(*)::int AS held
       FROM lotmark.${record.table} r WHERE r.tenant_id = $1
       GROUP BY 1`,
      [tenantId],
    );

    const declared = new Set(wf.states.map((s) => s.key));
    for (const r of rows) {
      const row = r as unknown as { state: string | null; held: number };
      if (row.state === null || declared.has(row.state)) continue;
      problems.push(
        `Workflow '${wf.key}' does not declare the state '${row.state}', and ` +
        `${row.held} ${wf.entity} record${row.held === 1 ? '' : 's'} ` +
        `${row.held === 1 ? 'is' : 'are'} in it. They would have nowhere to go. ` +
        'Keep the state, or move those records out of it first.',
      );
    }
  }

  return problems;
}

/**
 * Whether the custom fields, picklists and layouts in this version hold together.
 *
 * Each payload has already been validated ALONE, when it was written. None of
 * these checks can be made there: they are all about one entry agreeing with
 * another, and a schema only ever sees itself. A layout naming a field that
 * does not exist parses perfectly and renders a form with a hole in it.
 *
 * Split out rather than inlined because it is the only part of publication
 * validation that reads the RECORDS as well as the configuration — the
 * immutable-type check below has to know whether anything has been stored.
 */
async function customFieldProblems(
  tx: Sql, tenantId: string, entries: readonly ConfigEntryRow[],
): Promise<string[]> {
  const problems: string[] = [];

  const fields = new Map<string, FieldConfig>();
  for (const e of entries.filter((x) => x.kind === 'field')) {
    const parsed = fieldConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      problems.push(`Field '${e.key}' is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    fields.set(e.key, parsed.data);
  }

  const picklists = new Map<string, PicklistConfig>();
  for (const e of entries.filter((x) => x.kind === 'picklist')) {
    const parsed = picklistConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      problems.push(`Picklist '${e.key}' is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    picklists.set(e.key, parsed.data);
  }

  const layouts: LayoutConfig[] = [];
  for (const e of entries.filter((x) => x.kind === 'layout')) {
    const parsed = layoutConfigSchema.safeParse(e.payload);
    if (!parsed.success) {
      problems.push(`Layout '${e.key}' is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    layouts.push(parsed.data);
  }

  for (const [key, f] of fields) {
    /**
     * A type nothing can store. `attachment` is in the type vocabulary and has
     * no upload surface, so publishing one produces a control that accepts
     * nothing — and the administrator finds out from a user, not from here.
     */
    if (!isSupportedFieldType(f.type)) {
      problems.push(
        `Field '${key}' is of type '${f.type}', which cannot yet be stored or rendered. ` +
        'Choose another type, or remove the field.',
      );
    }
    // Presence of `picklistKey` is checked by the schema; that it names
    // something real cannot be, because the picklist is a different entry.
    if (f.picklistKey && !picklists.has(f.picklistKey)) {
      problems.push(
        `Field '${key}' draws from picklist '${f.picklistKey}', which this version does not define.`,
      );
    }
  }

  for (const l of layouts) {
    for (const section of l.sections) {
      for (const placed of section.fields) {
        const f = fields.get(placed.field);
        if (!f) {
          problems.push(
            `Layout '${l.key}' places field '${placed.field}', which this version does not define.`,
          );
        } else if (f.entity !== l.entity) {
          problems.push(
            `Layout '${l.key}' is for ${l.entity} but places field '${placed.field}', ` +
            `which belongs to ${f.entity}.`,
          );
        }
      }
    }
  }

  /**
   * A required field that no layout places can never be filled in.
   *
   * Once a layout exists for an entity it is authoritative — that is the point
   * of a layout. So a required field left out of it makes every save of that
   * record fail, on a field the person cannot see. Only checked for entities
   * that HAVE a layout: with none, every field is rendered.
   */
  const laidOut = new Set(layouts.map((l) => l.entity));
  const placedByEntity = new Map<string, Set<string>>();
  for (const l of layouts) {
    const set = placedByEntity.get(l.entity) ?? new Set<string>();
    for (const s of l.sections) {
      for (const p of s.fields) if (!p.readOnly) set.add(p.field);
    }
    placedByEntity.set(l.entity, set);
  }
  for (const [key, f] of fields) {
    if (!f.required || !laidOut.has(f.entity)) continue;
    if (!placedByEntity.get(f.entity)?.has(key)) {
      problems.push(
        `Field '${key}' is required on ${f.entity} but no layout places it as writable. ` +
        'Nobody would be able to fill it in, so no record of that kind could be saved.',
      );
    }
  }

  /**
   * A field's type cannot change once values have been stored under it.
   *
   * `field.immutableType` has carried the reason since the schema was written —
   * "changing its type would reinterpret stored data" — and nothing enforced
   * it. A `text` field holding 'Pune' republished as `number` does not convert
   * anything; it makes every existing document fail validation the next time
   * somebody edits the record, on a value they did not touch.
   *
   * Compared against the ACTIVE version, because that is what the stored
   * documents were validated against. Costs one query, and only when the draft
   * contains fields at all.
   */
  if (fields.size > 0) {
    const active = await activeVersion(tx, tenantId);
    if (active) {
      const previous = await entriesOf(tx, active.id);
      const held = await tx`
        SELECT entity, count(DISTINCT record_id)::int AS records
        FROM lotmark.custom_field_values
        WHERE tenant_id = ${tenantId}
        GROUP BY entity`;
      const withRecords = new Set(
        held.map((r) => (r as { entity: string; records: number }).entity),
      );

      for (const e of previous.filter((x) => x.kind === 'field')) {
        const before = fieldConfigSchema.safeParse(e.payload);
        const after = fields.get(e.key);
        if (!before.success || !after) continue;
        if (before.data.type === after.type) continue;
        if (!before.data.immutableType) continue;
        if (!withRecords.has(before.data.entity)) continue;
        problems.push(
          `Field '${e.key}' changes type from '${before.data.type}' to '${after.type}', ` +
          `and ${before.data.entity} records already hold values for it. ` +
          'Add a new field instead — changing this one would reinterpret what is already stored.',
        );
      }
    }
  }

  return problems;
}

/**
 * Publish a draft.
 *
 * Supersedes the active version and makes this one active, in one transaction:
 * the partial unique index allows exactly one active version, so a two-step
 * update would collide with itself.
 */
export async function publishDraft(
  tx: Sql,
  args: {
    tenantId: string;
    draftId: string;
    userId: string;
    /** The signature id, when the change requires one. */
    signatureId: string | null;
  },
): Promise<{ changes: ConfigChange[]; needsSignature: boolean }> {
  const draft = await versionById(tx, args.tenantId, args.draftId);
  if (!draft) throw new ConfigAdminError('No such configuration version.');
  if (draft.status !== 'draft') {
    throw new ConfigAdminError(`Version ${draft.version_number} is already ${draft.status}.`);
  }

  const problems = await publicationProblems(tx, args.tenantId, args.draftId);
  if (problems.length > 0) {
    throw new ConfigAdminError('This configuration cannot be published.', problems);
  }

  const changes = await diffDraft(tx, args.tenantId, args.draftId);
  if (changes.length === 0) {
    throw new ConfigAdminError(
      'This draft changes nothing. Publishing it would add a version to the history ' +
      'that no record was created under.',
    );
  }

  const needsSignature = changesRequireSignature(changes);
  if (needsSignature && !args.signatureId) {
    const risky = changes.filter((c) => c.risk !== 'presentation');
    throw new ConfigAdminError(
      'This version changes behaviour or security and must be signed.',
      risky.map((c) => `${c.kind} '${c.key}' ${c.change} (${c.risk})`),
    );
  }

  const active = await activeVersion(tx, args.tenantId);
  if (active) {
    await tx`
      UPDATE lotmark.config_versions SET status = 'superseded', updated_at = now()
      WHERE id = ${active.id}`;
  }

  await tx`
    UPDATE lotmark.config_versions
    SET status = 'active', published_by = ${args.userId}, published_at = now(),
        signature_id = ${args.signatureId}, change_summary = ${tx.json(changes as never)},
        updated_at = now()
    WHERE id = ${args.draftId}`;

  return { changes, needsSignature };
}

/** Discard a draft. Only a draft, and only in full. */
export async function discardDraft(
  tx: Sql, tenantId: string, draftId: string,
): Promise<void> {
  const draft = await versionById(tx, tenantId, draftId);
  if (!draft) throw new ConfigAdminError('No such configuration version.');
  if (draft.status !== 'draft') {
    throw new ConfigAdminError(
      `Version ${draft.version_number} is ${draft.status} and cannot be discarded. ` +
      'Published configuration is part of the record of what the system did.',
    );
  }
  await tx`DELETE FROM lotmark.config_entries WHERE version_id = ${draftId}`;
  await tx`DELETE FROM lotmark.config_versions WHERE id = ${draftId}`;
}

/** Which kinds need a signature to publish — for the console to explain up front. */
export const KIND_RISK = Object.fromEntries(
  ALL_CONFIG_KINDS.map((k) => [k, { risk: CONFIG_RISK[k], signed: requiresSignatureToPublish(k) }]),
) as Record<ConfigKind, { risk: string; signed: boolean }>;
