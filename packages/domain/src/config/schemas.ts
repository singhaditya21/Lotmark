import { z } from 'zod';
import { ALL_PERMISSIONS, type Permission } from '../permissions';
import type { ConfigKind } from './registry';

/**
 * Payload schemas, one per configurable kind.
 *
 * Every schema validates against the FIXED FLOOR where it touches it. A
 * configured role may only grant permissions that exist; a configured
 * transition may only require a permission that exists. That is the safety
 * boundary of the whole low-code design: configuration composes capabilities,
 * it never invents them.
 */

const permissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);
const key = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, 'lower-case slug');
const label = z.string().min(1).max(120);

/* ── A · Roles ───────────────────────────────────────────────────────────── */

export const roleConfigSchema = z.object({
  key,
  name: label,
  description: z.string().max(500).optional(),
  kind: z.enum(['producer', 'customer']),
  permissions: z.array(permissionSchema).min(0),
  /**
   * Roles this one inherits from, resolved transitively. Lets a tenant express
   * "Senior Scientist is a Scientist who can also authorise" without restating
   * the whole grant list and letting the two drift.
   */
  inherits: z.array(key).default([]),
  /** A system role ships with the product and cannot be deleted, only extended. */
  system: z.boolean().default(false),
});
export type RoleConfig = z.infer<typeof roleConfigSchema>;

/* ── A · Segregation of duties ───────────────────────────────────────────── */

export const sodConfigSchema = z.object({
  ruleId: z.string().min(1),
  enabled: z.boolean(),
  /** Threshold-approval rules only; ignored by other shapes. */
  thresholdMinor: z.number().int().nonnegative().optional(),
  approversRequired: z.number().int().min(2).optional(),
});
export type SodConfig = z.infer<typeof sodConfigSchema>;

/* ── C · Workflows ───────────────────────────────────────────────────────── */

export const transitionConfigSchema = z.object({
  from: key,
  to: key,
  /** Must exist in the fixed vocabulary — configuration cannot invent capability. */
  requires: permissionSchema,
  /** Wording used in the audit ledger when this transition is taken. */
  action: label,
  /** Demand an electronic signature, with the meanings offered to the signer. */
  requiresSignature: z.boolean().default(false),
  signatureMeanings: z
    .array(z.enum(['authorship', 'review', 'approval', 'responsibility']))
    .default([]),
  /** Require a dated competence record for this activity. */
  requiresCompetence: permissionSchema.optional(),
  /** Force the actor to state a reason, recorded on the transition. */
  requiresReason: z.boolean().default(false),
  /** Guard expressions evaluated before the move; all must hold. */
  guards: z.array(z.string()).default([]),
});
export type TransitionConfig = z.infer<typeof transitionConfigSchema>;

export const workflowConfigSchema = z
  .object({
    key,
    name: label,
    /** The entity this workflow governs, e.g. 'study', 'lot', 'capa'. */
    entity: key,
    states: z
      .array(z.object({ key, name: label, colour: z.string().optional() }))
      .min(2),
    initial: key,
    terminal: z.array(key).default([]),
    transitions: z.array(transitionConfigSchema).min(1),
  })
  .superRefine((wf, ctx) => {
    const states = new Set(wf.states.map((s) => s.key));
    if (!states.has(wf.initial)) {
      ctx.addIssue({ code: 'custom', message: `initial state '${wf.initial}' is not declared`, path: ['initial'] });
    }
    for (const t of wf.terminal) {
      if (!states.has(t)) {
        ctx.addIssue({ code: 'custom', message: `terminal state '${t}' is not declared`, path: ['terminal'] });
      }
    }
    wf.transitions.forEach((tr, i) => {
      if (!states.has(tr.from)) {
        ctx.addIssue({ code: 'custom', message: `unknown state '${tr.from}'`, path: ['transitions', i, 'from'] });
      }
      if (!states.has(tr.to)) {
        ctx.addIssue({ code: 'custom', message: `unknown state '${tr.to}'`, path: ['transitions', i, 'to'] });
      }
      if (wf.terminal.includes(tr.from)) {
        ctx.addIssue({
          code: 'custom',
          message: `'${tr.from}' is terminal but has an outgoing transition`,
          path: ['transitions', i, 'from'],
        });
      }
    });
    // Every non-initial state must be reachable, or a tenant has configured a
    // state their users can never arrive at — always a mistake, never a design.
    const reached = new Set([wf.initial]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const tr of wf.transitions) {
        if (reached.has(tr.from) && !reached.has(tr.to)) { reached.add(tr.to); grew = true; }
      }
    }
    for (const s of wf.states) {
      if (!reached.has(s.key)) {
        ctx.addIssue({ code: 'custom', message: `state '${s.key}' is unreachable from '${wf.initial}'`, path: ['states'] });
      }
    }
  });
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

/* ── B · Custom fields ───────────────────────────────────────────────────── */

export const fieldTypeSchema = z.enum([
  'text', 'textarea', 'number', 'integer', 'boolean',
  'date', 'datetime', 'select', 'multiselect', 'user', 'team', 'attachment',
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export const fieldConfigSchema = z
  .object({
    key,
    entity: key,
    label,
    type: fieldTypeSchema,
    helpText: z.string().max(500).optional(),
    required: z.boolean().default(false),
    /** Once a field has values, changing its type would reinterpret stored data. */
    immutableType: z.boolean().default(true),
    /** select / multiselect only: the picklist this draws from. */
    picklistKey: key.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().optional(),
    defaultValue: z.unknown().optional(),
    /** Show only when this expression is true, e.g. "material_class == 'organic'". */
    visibleWhen: z.string().optional(),
    /** Include on the rendered certificate. Behaviour-risk, not presentation. */
    onCertificate: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
  })
  .superRefine((f, ctx) => {
    if ((f.type === 'select' || f.type === 'multiselect') && !f.picklistKey) {
      ctx.addIssue({ code: 'custom', message: `'${f.type}' needs a picklistKey`, path: ['picklistKey'] });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      ctx.addIssue({ code: 'custom', message: 'min exceeds max', path: ['min'] });
    }
    if (f.pattern) {
      try { new RegExp(f.pattern); }
      catch { ctx.addIssue({ code: 'custom', message: 'pattern is not a valid regular expression', path: ['pattern'] }); }
    }
  });
export type FieldConfig = z.infer<typeof fieldConfigSchema>;

export const picklistConfigSchema = z.object({
  key,
  name: label,
  values: z
    .array(z.object({
      value: z.string().min(1),
      label,
      /** Retired values stay resolvable for existing records but cannot be chosen. */
      retired: z.boolean().default(false),
      sortOrder: z.number().int().default(0),
    }))
    .min(1),
});
export type PicklistConfig = z.infer<typeof picklistConfigSchema>;

/* ── D · Layouts, views, dashboards, reports ─────────────────────────────── */

export const layoutConfigSchema = z.object({
  key,
  entity: key,
  name: label,
  /** Restrict this layout to particular roles; empty means everyone. */
  roles: z.array(key).default([]),
  sections: z
    .array(z.object({
      title: label,
      columns: z.number().int().min(1).max(4).default(2),
      collapsed: z.boolean().default(false),
      fields: z.array(z.object({
        field: key,
        span: z.number().int().min(1).max(4).default(1),
        readOnly: z.boolean().default(false),
      })),
    }))
    .min(1),
});
export type LayoutConfig = z.infer<typeof layoutConfigSchema>;

export const viewConfigSchema = z.object({
  key,
  entity: key,
  name: label,
  roles: z.array(key).default([]),
  columns: z.array(z.object({
    field: key,
    label: label.optional(),
    width: z.number().int().positive().optional(),
    sortable: z.boolean().default(true),
  })).min(1),
  defaultSort: z.object({ field: key, direction: z.enum(['asc', 'desc']) }).optional(),
  defaultFilters: z.array(z.object({
    field: key,
    operator: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null']),
    value: z.unknown(),
  })).default([]),
  pageSize: z.number().int().min(10).max(200).default(25),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;

export const dashboardConfigSchema = z.object({
  key,
  name: label,
  roles: z.array(key).default([]),
  widgets: z.array(z.object({
    kind: z.enum(['kpi', 'table', 'bar', 'line', 'donut', 'list', 'text']),
    title: label,
    /** Named, server-side query. Never raw SQL from configuration. */
    source: key,
    params: z.record(z.string(), z.unknown()).default({}),
    width: z.number().int().min(1).max(12).default(4),
    height: z.number().int().min(1).max(8).default(2),
  })).default([]),
});
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;

export const reportConfigSchema = z.object({
  key,
  name: label,
  roles: z.array(key).default([]),
  /** Named, server-side query — configuration selects and shapes, never executes SQL. */
  source: key,
  params: z.record(z.string(), z.unknown()).default({}),
  columns: z.array(z.object({ field: key, label: label.optional() })).min(1),
  format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  schedule: z.object({
    cron: z.string().min(1),
    recipients: z.array(z.string().email()).min(1),
    enabled: z.boolean().default(true),
  }).optional(),
});
export type ReportConfig = z.infer<typeof reportConfigSchema>;

/* ── A · Templates, numbering, translation, flags, retention ─────────────── */

export const numberingConfigSchema = z.object({
  key,
  entity: key,
  /** e.g. 'IPRS{MAT}{SEQ:4}' — placeholders resolved by the numbering service. */
  template: z.string().min(1),
  /** Sequence resets: never, yearly, or per parent record. */
  resetPolicy: z.enum(['never', 'yearly', 'per_parent']).default('never'),
  padTo: z.number().int().min(1).max(12).default(4),
  startAt: z.number().int().nonnegative().default(1),
});
export type NumberingConfig = z.infer<typeof numberingConfigSchema>;

export const templateConfigSchema = z.object({
  key,
  name: label,
  purpose: z.enum(['certificate', 'notification_email', 'notification_sms', 'label', 'letter']),
  locale: z.string().min(2).max(10).default('en'),
  subject: z.string().optional(),
  /** Rendered by a sandboxed engine with no filesystem or network access. */
  body: z.string().min(1),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

export const translationConfigSchema = z.object({
  key,
  locale: z.string().min(2).max(10),
  strings: z.record(z.string(), z.string()),
});
export type TranslationConfig = z.infer<typeof translationConfigSchema>;

export const flagConfigSchema = z.object({
  key,
  name: label,
  enabled: z.boolean(),
  description: z.string().max(500).optional(),
});
export type FlagConfig = z.infer<typeof flagConfigSchema>;

export const retentionConfigSchema = z.object({
  /** Must match a retention class id from the statutory schedule. */
  key,
  /**
   * Tenants may retain LONGER than the statutory minimum, never shorter — the
   * floor is law, and configuration cannot lower it. Enforced on publish.
   */
  retainForDays: z.number().int().positive(),
  reason: z.string().min(1),
});
export type RetentionConfig = z.infer<typeof retentionConfigSchema>;

/* ── The registry ────────────────────────────────────────────────────────── */

export const CONFIG_SCHEMAS = {
  role: roleConfigSchema,
  workflow: workflowConfigSchema,
  field: fieldConfigSchema,
  picklist: picklistConfigSchema,
  layout: layoutConfigSchema,
  view: viewConfigSchema,
  dashboard: dashboardConfigSchema,
  report: reportConfigSchema,
  numbering: numberingConfigSchema,
  template: templateConfigSchema,
  translation: translationConfigSchema,
  sod: sodConfigSchema,
  retention: retentionConfigSchema,
  flag: flagConfigSchema,
} as const satisfies Record<ConfigKind, z.ZodTypeAny>;

/** Validate a payload against the schema registered for its kind. */
export function parseConfigPayload(kind: ConfigKind, payload: unknown) {
  return CONFIG_SCHEMAS[kind].safeParse(payload);
}
