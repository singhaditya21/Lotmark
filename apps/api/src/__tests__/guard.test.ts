import { describe, it, expect } from 'vitest';
import {
  resolveAuthority, defaultRoles, defaultSodSettings,
  type RoleAssignment, type CompetenceBasis,
} from '@lotmark/domain';
import { decide, guard, Forbidden, type GuardRequest } from '../services/guard';

const ROLES = new Map(defaultRoles().map((r) => [r.key, r]));
const TODAY = '2026-08-21';
const ORGANICS = 'team-organics';
const INORGANICS = 'team-inorganics';

const authorityOf = (assignments: RoleAssignment[]) =>
  resolveAuthority({ userId: 'u-ravi', assignments, roles: ROLES, asOf: TODAY });

const assign = (roleKey: string, teamId: string | null): RoleAssignment =>
  ({ userId: 'u-ravi', roleKey, teamId, validFrom: null, validTo: null });

const basis = (from: string, to: string): CompetenceBasis => ({
  competenceRecordId: 'CMP-001', activity: 'study:sign',
  validFrom: from, validTo: to, checkedOn: TODAY, personUserId: 'u-ravi',
});

const base = (over: Partial<GuardRequest> = {}): GuardRequest => ({
  authority: authorityOf([assign('scientist', ORGANICS)]),
  permission: 'study:sign',
  scope: { kind: 'team', teamId: ORGANICS },
  sodSettings: defaultSodSettings(),
  onDate: TODAY,
  ...over,
});

describe('authentication', () => {
  it('refuses an anonymous caller before anything else', () => {
    const v = decide(base({ authority: null }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('not_authenticated');
  });
});

describe('permission and scope', () => {
  it('allows a permission held in the acting team', () => {
    expect(decide(base()).allowed).toBe(true);
  });

  it('refuses the same permission in another team', () => {
    const v = decide(base({ scope: { kind: 'team', teamId: INORGANICS } }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('permission_denied');
    expect(v.message).toContain('in this team');
  });

  it('refuses a permission the role does not hold at all', () => {
    const v = decide(base({ permission: 'cert:issue' }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('permission_denied');
  });

  it('lets a tenant-wide grant act on any team', () => {
    const v = decide(base({
      authority: authorityOf([assign('tenantadmin', null)]),
      scope: { kind: 'team', teamId: INORGANICS },
    }));
    expect(v.allowed).toBe(true);
  });
});

describe('segregation of duties', () => {
  const authoriser = authorityOf([assign('techmgr', ORGANICS)]);

  it('refuses authorising a value you assigned yourself', () => {
    const v = decide(base({
      authority: authoriser,
      permission: 'value:authorise',
      record: { assignedBy: 'u-ravi' },
    }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('segregation_of_duties');
    expect(v.detail['rule']).toBe('value-assigner-may-not-authorise');
    // The denial carries the provenance so an assessor reading either source
    // artefact can find the rule by the number they know.
    expect(v.detail['provenance']).toMatchObject({ wireframe: 'SoD-1', prototype: 'SoD-1' });
  });

  it('allows authorising a value somebody else assigned', () => {
    const v = decide(base({
      authority: authoriser,
      permission: 'value:authorise',
      record: { assignedBy: 'u-sunil' },
    }));
    expect(v.allowed).toBe(true);
  });

  it('does not fire when the rule is disabled for the tenant', () => {
    const v = decide(base({
      authority: authoriser,
      permission: 'value:authorise',
      record: { assignedBy: 'u-ravi' },
      sodSettings: { ...defaultSodSettings(), 'value-assigner-may-not-authorise': false },
    }));
    expect(v.allowed).toBe(true);
  });

  it('checks permission BEFORE segregation, so the message is the useful one', () => {
    // A scientist has no value:authorise at all. Reporting SoD here would tell
    // them to find a colleague when the real answer is that they lack the right.
    const v = decide(base({ permission: 'value:authorise', record: { assignedBy: 'u-ravi' } }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('permission_denied');
  });
});

describe('competence gating — ISO 17034 6.3', () => {
  it('refuses when no competence record exists', () => {
    const v = decide(base({ requiresCompetence: 'study:sign', competenceFor: () => null }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('competence_missing');
  });

  it('refuses when the record does not cover the acting date', () => {
    const v = decide(base({
      requiresCompetence: 'study:sign',
      competenceFor: () => basis('2024-01-01', '2026-06-30'),
    }));
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe('competence_expired');
    expect(v.message).toContain('2026-06-30');
  });

  it('allows when the record covers the date, and returns the basis to freeze', () => {
    const v = decide(base({
      requiresCompetence: 'study:sign',
      competenceFor: () => basis('2024-01-01', '2027-12-31'),
    }));
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    // The basis travels back so the signature can freeze it: editing the
    // competence record later must not rewrite the validity of this act.
    expect(v.competenceBasis?.competenceRecordId).toBe('CMP-001');
  });

  it('holding the permission is not sufficient without competence', () => {
    const withPermission = decide(base());
    expect(withPermission.allowed).toBe(true);
    const withGate = decide(base({ requiresCompetence: 'study:sign', competenceFor: () => null }));
    expect(withGate.allowed).toBe(false);
  });

  it('returns a null basis when the act is not competence-gated', () => {
    const v = decide(base({ permission: 'project:read' }));
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.competenceBasis).toBeNull();
  });
});

describe('signature requirement', () => {
  it('reports when the caller must still collect a signature', () => {
    const v = decide(base({ requiresSignature: true }));
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.signatureRequired).toBe(true);
  });

  it('defaults to not requiring one', () => {
    const v = decide(base());
    expect(v.allowed).toBe(true);
    if (!v.allowed) return;
    expect(v.signatureRequired).toBe(false);
  });
});

describe('the throwing form', () => {
  it('returns the allowance when permitted', () => {
    expect(guard(base()).allowed).toBe(true);
  });

  it('throws Forbidden carrying the verdict, so the denial can be recorded', () => {
    try {
      guard(base({ scope: { kind: 'team', teamId: INORGANICS } }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Forbidden);
      const f = e as Forbidden;
      // A refusal is evidence that a control worked; losing the detail wastes it.
      expect(f.denial.reason).toBe('permission_denied');
      expect(f.denial.detail['permission']).toBe('study:sign');
    }
  });
});
