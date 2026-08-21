import { PERMISSIONS, ALL_PERMISSIONS, type Permission } from './permissions';

/**
 * A role is either a producer-side role (works in the console) or a
 * customer-side role (works in the storefront and vault). The kind decides
 * which half of the application the user lands in after sign-in, and the
 * router refuses to serve the other half.
 */
export type RoleKind = 'producer' | 'customer';

export interface RoleDefinition {
  readonly name: string;
  readonly kind: RoleKind;
  readonly permissions: readonly Permission[];
}

export const ROLES = {
  scientist: {
    name: 'RM Scientist',
    kind: 'producer',
    permissions: ['project:read', 'study:run', 'study:sign', 'value:assign', 'audit:read'],
  },
  prodlead: {
    name: 'Production Lead',
    kind: 'producer',
    permissions: [
      'project:read', 'project:manage', 'study:run', 'study:sign',
      'lot:create', 'equipment:manage', 'audit:read',
    ],
  },
  techmgr: {
    name: 'Technical Manager',
    kind: 'producer',
    permissions: [
      'project:read', 'value:authorise', 'lot:release',
      'cert:issue', 'cert:reissue', 'audit:read',
    ],
  },
  quality: {
    name: 'Quality Manager',
    kind: 'producer',
    permissions: [
      'project:read', 'conformance:read', 'capa:manage', 'subcontractor:manage',
      'competence:manage', 'audit:read', 'audit:verify', 'audit:export',
    ],
  },
  commercial: {
    name: 'Commercial',
    kind: 'producer',
    permissions: [
      'catalogue:manage', 'order:read_all', 'entitlement:decide',
      'pii:contact', 'audit:read',
    ],
  },
  dispatch: {
    name: 'Dispatch',
    kind: 'producer',
    permissions: ['order:read_all', 'order:advance', 'pii:contact', 'audit:read'],
  },
  tenantadmin: {
    name: 'Tenant Admin',
    kind: 'producer',
    permissions: ALL_PERMISSIONS,
  },
  labqm: {
    name: 'Laboratory QM',
    kind: 'customer',
    permissions: ['order:create', 'order:read_own', 'entitlement:claim', 'vault:use'],
  },
  labbuyer: {
    name: 'Laboratory Buyer',
    kind: 'customer',
    permissions: ['order:create', 'order:read_own', 'vault:use'],
  },
} as const satisfies Record<string, RoleDefinition>;

export type RoleId = keyof typeof ROLES;

export const ALL_ROLES = Object.keys(ROLES) as RoleId[];

export function isRole(value: string): value is RoleId {
  return value in ROLES;
}

/** Does this role hold this permission? The only correct way to ask. */
export function roleHas(role: RoleId, permission: Permission): boolean {
  return (ROLES[role].permissions as readonly Permission[]).includes(permission);
}

export function permissionsOf(role: RoleId): readonly Permission[] {
  return ROLES[role].permissions;
}

export function kindOf(role: RoleId): RoleKind {
  return ROLES[role].kind;
}

/**
 * Prototype selfCheck invariant: "every granted permission is defined".
 * Returns the offending grants rather than throwing, so callers can report all
 * of them at once instead of only the first.
 */
export function undefinedGrants(): Array<{ role: RoleId; permission: string }> {
  const bad: Array<{ role: RoleId; permission: string }> = [];
  for (const role of ALL_ROLES) {
    for (const p of ROLES[role].permissions) {
      if (!(p in PERMISSIONS)) bad.push({ role, permission: p });
    }
  }
  return bad;
}
