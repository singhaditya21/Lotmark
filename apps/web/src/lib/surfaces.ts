/**
 * What this person can actually open.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 *
 * The console had one default route — Projects — and everybody landed on it.
 * Four of the nine seeded personas legitimately have visibility of no projects
 * at all: Commercial, Dispatch, and both laboratory customers. They signed in
 * correctly, were scoped correctly, and were then shown an empty table with no
 * explanation and nowhere else to go. Correct enforcement presented as a broken
 * product, which is the worst way to be right.
 *
 * ── Why this is a table and not a switch ────────────────────────────────────
 *
 * Every surface added from here on is one row plus one `case` in App.tsx. The
 * previous shape — a `Route` union, a hand-written nav with a `held.has(...)`
 * guard per button, and a ternary chain that fell through to Projects — made
 * "which sections exist" something you had to reconstruct by reading JSX, and
 * made the fallback invisible.
 *
 * ── Two boundaries, deliberately not merged ─────────────────────────────────
 *
 * `half` is matched against the person's ROLE kinds, not their organisation's
 * kind. See resolveRoleKinds in @lotmark/domain for why those are different
 * questions. Nothing here authorises anything: the server re-decides every act,
 * and hiding a control is a courtesy to the user rather than a security
 * control.
 */

export type Half = 'producer' | 'customer';

export interface Surface {
  readonly id: string;
  readonly label: string;
  readonly half: Half;
  /**
   * The permission that makes this section worth showing.
   *
   * Held anywhere — tenant-wide or in any single team — because a section is
   * worth opening if there is anything at all in it. The section itself then
   * shows only what the person may see, and the server enforces that.
   *
   * `null` means every authenticated person in that half sees it.
   */
  readonly permission: string | null;
}

/**
 * The sections, in the order they appear.
 *
 * Projects now requires `project:read`. That single line is what stops
 * Commercial and Dispatch landing on an empty table: they hold no project
 * permission, so the section is not theirs, and they are told so plainly
 * instead of being shown nothing.
 */
export const SURFACES: readonly Surface[] = [
  { id: 'projects', label: 'Projects', half: 'producer', permission: 'project:read' },
  { id: 'capa', label: 'Complaints & CAPA', half: 'producer', permission: 'capa:manage' },
  { id: 'audit', label: 'Audit ledger', half: 'producer', permission: 'audit:read' },
];

export interface Viewer {
  /** Every permission held anywhere — tenant-wide or in any team. */
  readonly held: ReadonlySet<string>;
  readonly roleKinds: readonly Half[];
}

/** The sections this person may open, in declaration order. */
export function visibleSurfaces(viewer: Viewer): Surface[] {
  return SURFACES.filter(
    (s) => viewer.roleKinds.includes(s.half) && (s.permission === null || viewer.held.has(s.permission)),
  );
}

/**
 * Which section to show.
 *
 * Returns null when there is nothing to show — a real outcome that the caller
 * must render as an explanation, never as a blank page or as an empty Projects
 * table. Falling back to a fixed section is exactly the bug this replaces.
 */
export function resolveRoute(viewer: Viewer, requested: string | null): string | null {
  const visible = visibleSurfaces(viewer);
  if (visible.length === 0) return null;
  if (requested && visible.some((s) => s.id === requested)) return requested;
  return visible[0]!.id;
}

/**
 * Why this person has nothing to open, in terms they can act on.
 *
 * The distinction matters and is the reason this is computed rather than
 * written as fixed copy:
 *
 *   'half_not_built'  — the product has no sections for their half yet. Nothing
 *                       an administrator can grant will change that.
 *   'no_permissions'  — sections exist for their half; they hold none of the
 *                       permissions. An administrator CAN fix this.
 *   'no_role'         — they hold no role at all, so they belong to no half.
 *
 * Deriving 'half_not_built' from SURFACES rather than hard-coding it means the
 * sentence stops being said the moment the first section for that half is
 * added. Copy that claims a half does not exist becomes a lie on the day
 * somebody builds it, and nobody remembers to go and delete it.
 */
export type NoSurfaceReason = 'half_not_built' | 'no_permissions' | 'no_role';

export function whyNoSurface(viewer: Viewer): NoSurfaceReason {
  if (viewer.roleKinds.length === 0) return 'no_role';
  const forTheirHalf = SURFACES.filter((s) => viewer.roleKinds.includes(s.half));
  return forTheirHalf.length === 0 ? 'half_not_built' : 'no_permissions';
}

/** The permissions that would open something, for telling the user what to ask for. */
export function permissionsThatWouldHelp(viewer: Viewer): string[] {
  return SURFACES
    .filter((s) => viewer.roleKinds.includes(s.half) && s.permission !== null)
    .map((s) => s.permission!)
    .filter((p, i, all) => all.indexOf(p) === i);
}
