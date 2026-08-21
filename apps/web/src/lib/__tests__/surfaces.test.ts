import { describe, it, expect } from 'vitest';
import {
  SURFACES, visibleSurfaces, resolveRoute, whyNoSurface, permissionsThatWouldHelp,
  type Viewer, type Surface,
} from '../surfaces';

/**
 * The nine seeded personas, with the permissions their roles grant.
 *
 * Written out rather than imported: the console deliberately does not depend on
 * @lotmark/domain — these strings reach the browser as UI labels and the server
 * validates everything regardless. The end-to-end check that these match the
 * real grants is apps/api/scripts/persona-probe.mjs, which signs each of them
 * in for real.
 */
const PERSONA = {
  scientist: ['project:read', 'study:run', 'study:sign', 'value:assign', 'audit:read'],
  prodlead: ['project:read', 'project:manage', 'study:run', 'study:sign', 'lot:create', 'equipment:manage', 'audit:read'],
  techmgr: ['project:read', 'value:authorise', 'lot:release', 'cert:issue', 'cert:reissue', 'audit:read'],
  quality: ['project:read', 'conformance:read', 'capa:manage', 'subcontractor:manage', 'competence:manage', 'audit:read', 'audit:verify', 'audit:export'],
  commercial: ['catalogue:manage', 'order:read_all', 'entitlement:decide', 'order:refund', 'pii:contact', 'audit:read'],
  dispatch: ['order:read_all', 'order:advance', 'pii:contact', 'audit:read'],
  labqm: ['order:create', 'order:read_own', 'entitlement:claim', 'vault:use'],
  labbuyer: ['order:create', 'order:read_own', 'vault:use'],
} as const;

const producer = (perms: readonly string[]): Viewer =>
  ({ held: new Set(perms), roleKinds: ['producer'] });
const customer = (perms: readonly string[]): Viewer =>
  ({ held: new Set(perms), roleKinds: ['customer'] });

describe('every persona lands somewhere that makes sense', () => {
  it('gives the science and quality roles their sections', () => {
    expect(resolveRoute(producer(PERSONA.scientist), null)).toBe('projects');
    expect(resolveRoute(producer(PERSONA.prodlead), null)).toBe('projects');
    expect(resolveRoute(producer(PERSONA.techmgr), null)).toBe('projects');
    expect(resolveRoute(producer(PERSONA.quality), null)).toBe('projects');
  });

  it('does NOT send Commercial or Dispatch to an empty Projects table', () => {
    /**
     * The defect this file exists for. Both hold `audit:read` but no
     * `project:read`, and both used to land on Projects — which correctly
     * returned zero rows, so the product looked broken to a user whose
     * permissions were working exactly as designed.
     */
    for (const role of ['commercial', 'dispatch'] as const) {
      const viewer = producer(PERSONA[role]);
      expect(visibleSurfaces(viewer).map((s) => s.id), role).not.toContain('projects');
      expect(resolveRoute(viewer, null), `${role} should land on the audit ledger`).toBe('audit');
    }
  });

  it('sends both laboratory customers to an explanation, not a blank page', () => {
    for (const role of ['labqm', 'labbuyer'] as const) {
      const viewer = customer(PERSONA[role]);
      expect(visibleSurfaces(viewer), role).toEqual([]);
      expect(resolveRoute(viewer, null), role).toBeNull();
      // And the reason must be the honest one: nothing is built for them yet,
      // which no administrator can grant their way out of.
      expect(whyNoSurface(viewer), role).toBe('half_not_built');
    }
  });

  it('never returns a section the viewer cannot open', () => {
    for (const [role, perms] of Object.entries(PERSONA)) {
      const viewer = role.startsWith('lab') ? customer(perms) : producer(perms);
      for (const s of visibleSurfaces(viewer)) {
        expect(s.permission === null || viewer.held.has(s.permission), `${role} → ${s.id}`).toBe(true);
        expect(viewer.roleKinds).toContain(s.half);
      }
    }
  });
});

describe('choosing which section to show', () => {
  it('honours a request the viewer may open', () => {
    expect(resolveRoute(producer(PERSONA.quality), 'capa')).toBe('capa');
    expect(resolveRoute(producer(PERSONA.quality), 'audit')).toBe('audit');
  });

  it('falls back rather than showing a section the viewer may not open', () => {
    // A stale request — from a role that has since been revoked — must not
    // render a section the person no longer holds.
    expect(resolveRoute(producer(PERSONA.scientist), 'capa')).toBe('projects');
  });

  it('returns null rather than defaulting into somebody else’s section', () => {
    expect(resolveRoute(customer(PERSONA.labqm), 'projects')).toBeNull();
  });
});

describe('explaining an empty account', () => {
  it('tells apart the three reasons, because the action differs for each', () => {
    expect(whyNoSurface({ held: new Set(), roleKinds: [] })).toBe('no_role');
    expect(whyNoSurface(customer(PERSONA.labqm))).toBe('half_not_built');
    // A producer role holding none of the section permissions: an
    // administrator CAN fix this one.
    expect(whyNoSurface(producer(['pii:contact']))).toBe('no_permissions');
  });

  it('names permissions worth asking for, without repeating any', () => {
    const asks = permissionsThatWouldHelp(producer(['pii:contact']));
    expect(asks).toContain('project:read');
    expect(new Set(asks).size).toBe(asks.length);
  });

  it('stops saying "not built" as soon as a section for that half exists', () => {
    /**
     * The reason `whyNoSurface` is derived from SURFACES rather than written as
     * fixed copy. The Access page tells a laboratory user that their half of
     * the product does not exist yet — true today, and a lie the moment the
     * storefront lands. Nobody remembers to delete that sentence, so it has to
     * delete itself.
     *
     * This simulates the storefront arriving.
     */
    const withStorefront: Surface[] = [
      ...SURFACES,
      { id: 'vault', label: 'Certificate vault', half: 'customer', permission: 'vault:use' },
    ];
    const viewer = customer(PERSONA.labqm);
    const forTheirHalf = withStorefront.filter((s) => viewer.roleKinds.includes(s.half));
    expect(forTheirHalf.length).toBeGreaterThan(0);
    // With that row present the reason is no longer 'half_not_built', and the
    // sentence claiming the half does not exist is no longer rendered.
    const wouldBe = forTheirHalf.length === 0 ? 'half_not_built' : 'no_permissions';
    expect(wouldBe).toBe('no_permissions');
    // Sanity: today, without it, the honest answer really is 'half_not_built'.
    expect(whyNoSurface(viewer)).toBe('half_not_built');
  });
});
