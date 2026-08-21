/**
 * The permission vocabulary.
 *
 * Transcribed verbatim from the prototype's PERMS map so the two cannot drift.
 * A permission is a capability, never a role: roles are compositions of these.
 *
 * Invariant (prototype selfCheck #1): every permission granted by any role must
 * appear here. Enforced by `assertRoleGrantsAreDefined()` in ./roles.ts and by
 * a test in ./__tests__/invariants.test.ts.
 */
export const PERMISSIONS = {
  'project:read': 'View projects',
  'project:manage': 'Create and edit projects and plans',
  'study:run': 'Record study results',
  'study:sign': 'Sign off a study',
  'value:assign': 'Assign property values',
  'value:authorise': 'Authorise property values',
  'lot:create': 'Create a lot',
  'lot:release': 'Release a lot to the catalogue',
  'cert:issue': 'Issue a certificate',
  'cert:reissue': 'Reissue and notify holders',
  'catalogue:manage': 'Manage the catalogue',
  'order:create': 'Place an order',
  'order:read_own': 'View own orders',
  'order:read_all': 'View all orders',
  'order:advance': 'Advance dispatch',
  'order:refund': 'Approve a refund or cancellation',
  'entitlement:claim': 'Claim a price tier',
  'entitlement:decide': 'Decide a tier claim',
  'equipment:manage': 'Manage equipment and calibration',
  'competence:manage': 'Manage competence records',
  'capa:manage': 'Manage complaints and CAPA',
  'subcontractor:manage': 'Manage subcontractors',
  'conformance:read': 'View conformance',
  'audit:read': 'Read the audit ledger',
  'audit:verify': 'Verify the audit chain',
  'audit:export': 'Export the audit ledger',
  'pii:contact': 'See customer contact details',
  'user:manage': 'Manage users and roles',
  'vault:use': 'Use the laboratory vault',
} as const satisfies Record<string, string>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

/**
 * Activities that require a *dated competence record*, not merely a permission.
 * ISO 17034 6.3 — the person must be authorised for the activity on the date
 * they perform it. Holding the permission is necessary but not sufficient.
 */
export const COMPETENCE_GATED = [
  'study:sign',
  'value:assign',
  'value:authorise',
  'cert:issue',
] as const satisfies readonly Permission[];

export type CompetenceGatedActivity = (typeof COMPETENCE_GATED)[number];

export function requiresCompetence(p: Permission): p is CompetenceGatedActivity {
  return (COMPETENCE_GATED as readonly Permission[]).includes(p);
}
