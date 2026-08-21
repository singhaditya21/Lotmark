import type { Permission } from '../permissions';
import type { RoleConfig } from './schemas';
import type { RoleKind } from '../roles';

/**
 * Resolving User → Team → Role → Permission.
 *
 * The prototype had one role per user, globally. Real laboratories do not work
 * that way: a scientist may sign studies for the Organics section and only read
 * for Inorganics, and the person covering a colleague's leave holds their role
 * on one team for three weeks.
 *
 * So a role is assigned at a SCOPE:
 *
 *   scope = null    → tenant-wide; the permission applies everywhere
 *   scope = teamId  → the permission applies only to records owned by that team
 *
 * Every authorisation question therefore has two parts — "may this person do
 * this at all", and "may they do it to THIS record" — and both must be answered.
 * Answering only the first is the classic broken-object-level-authorisation bug,
 * so `can()` deliberately requires a scope argument rather than defaulting.
 */

export interface RoleAssignment {
  readonly userId: string;
  readonly roleKey: string;
  /** null = tenant-wide. */
  readonly teamId: string | null;
  /** Time-boxed assignments (leave cover) expire without anyone remembering. */
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

/**
 * Flatten a role's grants through its inheritance chain.
 *
 * Cycles are a configuration error, not a stack overflow: a tenant that
 * configures A inherits B inherits A gets a clear message naming the cycle.
 */
export function effectivePermissionsOfRole(
  roleKey: string,
  roles: ReadonlyMap<string, RoleConfig>,
  seen: readonly string[] = [],
): Set<Permission> {
  if (seen.includes(roleKey)) {
    throw new ConfigError(`Role inheritance cycle: ${[...seen, roleKey].join(' → ')}`);
  }
  const role = roles.get(roleKey);
  if (!role) throw new ConfigError(`Role '${roleKey}' is not defined in this configuration.`);

  const out = new Set<Permission>(role.permissions);
  for (const parent of role.inherits) {
    for (const p of effectivePermissionsOfRole(parent, roles, [...seen, roleKey])) out.add(p);
  }
  return out;
}

/** Is this assignment live on the given date? */
export function assignmentActiveOn(a: RoleAssignment, onDate: string): boolean {
  if (a.validFrom && a.validFrom > onDate) return false;
  if (a.validTo && a.validTo < onDate) return false;
  return true;
}

/**
 * A user's resolved authority at a point in time.
 *
 * Computed once per request and passed to the guard, so a single request cannot
 * see two different answers as configuration or assignments change underneath it.
 */
export interface ResolvedAuthority {
  readonly userId: string;
  readonly asOf: string;
  /** Permissions held everywhere in the tenant. */
  readonly tenantWide: ReadonlySet<Permission>;
  /** Permissions held only within a given team. */
  readonly byTeam: ReadonlyMap<string, ReadonlySet<Permission>>;
  /** Teams the user is assigned into — the data scope for row filtering. */
  readonly teamIds: readonly string[];
}

export function resolveAuthority(args: {
  readonly userId: string;
  readonly assignments: readonly RoleAssignment[];
  readonly roles: ReadonlyMap<string, RoleConfig>;
  readonly asOf: string;
}): ResolvedAuthority {
  const tenantWide = new Set<Permission>();
  const byTeam = new Map<string, Set<Permission>>();

  for (const a of args.assignments) {
    if (a.userId !== args.userId) continue;
    if (!assignmentActiveOn(a, args.asOf)) continue;

    const perms = effectivePermissionsOfRole(a.roleKey, args.roles);
    if (a.teamId === null) {
      for (const p of perms) tenantWide.add(p);
    } else {
      const bucket = byTeam.get(a.teamId) ?? new Set<Permission>();
      for (const p of perms) bucket.add(p);
      byTeam.set(a.teamId, bucket);
    }
  }

  return {
    userId: args.userId,
    asOf: args.asOf,
    tenantWide,
    byTeam,
    teamIds: [...byTeam.keys()],
  };
}

/**
 * The scope a permission is being exercised against.
 *
 * `{ kind: 'tenant' }`  — an act with no owning team (tenant configuration,
 *                         reading the audit ledger).
 * `{ kind: 'team', teamId }` — an act on a record owned by a team.
 *
 * There is no "any" scope on purpose. A caller that does not know which team a
 * record belongs to has not loaded the record, and is therefore not in a
 * position to authorise an action on it.
 */
export type AuthScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'team'; readonly teamId: string };

/**
 * Does this authority hold `permission` within `scope`?
 *
 * Tenant-wide grants satisfy team scopes — someone granted Quality Manager
 * across the tenant can act on any team's records. Team grants never satisfy a
 * tenant scope, because authority over one section is not authority over the
 * whole producer.
 */
export function can(
  authority: ResolvedAuthority,
  permission: Permission,
  scope: AuthScope,
): boolean {
  if (authority.tenantWide.has(permission)) return true;
  if (scope.kind === 'tenant') return false;
  return authority.byTeam.get(scope.teamId)?.has(permission) ?? false;
}

/** Teams in which the user holds `permission`. Drives row-level filtering. */
export function teamsWherePermitted(
  authority: ResolvedAuthority,
  permission: Permission,
): readonly string[] {
  if (authority.tenantWide.has(permission)) return ['*'];
  const out: string[] = [];
  for (const [teamId, perms] of authority.byTeam) {
    if (perms.has(permission)) out.push(teamId);
  }
  return out;
}

/**
 * Which half or halves of the product this person belongs in.
 *
 * ── Why this comes from ROLE kind, not organisation kind ────────────────────
 *
 * `roles.ts` has always said a role is either producer-side or customer-side,
 * and that "the kind decides which half of the application the user lands in".
 * Nothing implemented it, so every persona landed on the producer Projects
 * screen — and four of the nine landed on it empty, because they legitimately
 * have visibility of no projects. Correct enforcement, presented as a broken
 * product.
 *
 * The tempting alternative is to read `organisations.kind` off the user's row.
 * That is a different question with a different answer, and conflating them
 * would be wrong in both directions: a producer employee given a customer role
 * for testing would be sent to the producer console, and a laboratory user
 * granted `audit:read` would be sent to the storefront.
 *
 * The division of labour, stated once so it does not get collapsed later:
 *
 *   organisation kind  →  the DATA boundary. What rows you may see. Enforced by
 *                         row-level security, in the database.
 *   role kind          →  the PRODUCT boundary. Which half you land in. Decided
 *                         here, and advisory — every act is still authorised by
 *                         the guard on its own terms.
 *
 * A person can legitimately hold both, and then they get both.
 */
export function resolveRoleKinds(args: {
  readonly userId: string;
  readonly assignments: readonly RoleAssignment[];
  readonly roles: ReadonlyMap<string, RoleConfig>;
  readonly asOf: string;
}): RoleKind[] {
  const kinds = new Set<RoleKind>();
  for (const a of args.assignments) {
    if (a.userId !== args.userId) continue;
    if (!assignmentActiveOn(a, args.asOf)) continue;
    const role = args.roles.get(a.roleKey);
    // An assignment naming a role the configuration does not define is a
    // configuration fault, not a licence to guess a half. Skipped here and
    // reported where the configuration is read.
    if (role) kinds.add(role.kind);
  }
  return [...kinds];
}

/** Every permission the user holds anywhere — for UI navigation only, never for enforcement. */
export function anyPermissions(authority: ResolvedAuthority): ReadonlySet<Permission> {
  const out = new Set<Permission>(authority.tenantWide);
  for (const perms of authority.byTeam.values()) for (const p of perms) out.add(p);
  return out;
}
