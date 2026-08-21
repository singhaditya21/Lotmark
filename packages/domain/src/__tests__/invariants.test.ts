/**
 * The prototype's selfCheck() invariants, promoted to a permanent test suite.
 *
 * In the prototype these were a SCREEN — you had to look at "Build &
 * verification" to learn whether the permission model was self-consistent. Here
 * the ones that concern pure domain declarations run on every commit, and the
 * ones that concern stored data become database constraints and integration
 * tests in @lotmark/db.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSIONS, ALL_PERMISSIONS, COMPETENCE_GATED, isPermission } from '../permissions.js';
import { ROLES, ALL_ROLES, undefinedGrants, permissionsOf, kindOf } from '../roles.js';
import { SOD_RULES, defaultSodSettings, findSodViolation, isSodEnabled } from '../sod.js';
import { ALL_MACHINES, canTransition, assertTransition, IllegalTransitionError, VALUE_MACHINE } from '../state-machines.js';
import { RETENTION_SCHEDULE } from '../retention.js';
import { canonicalMaterial, signaturePayload, ALL_SIGNATURE_MEANINGS, isBasisValid } from '../signatures.js';

describe('permission model', () => {
  // Prototype invariant: "every granted permission is defined"
  it('every permission granted by a role is defined', () => {
    expect(undefinedGrants()).toEqual([]);
  });

  it('every permission is reachable by at least one role', () => {
    const granted = new Set(ALL_ROLES.flatMap((r) => permissionsOf(r)));
    const orphans = ALL_PERMISSIONS.filter((p) => !granted.has(p));
    expect(orphans, `unreachable permissions: ${orphans.join(', ')}`).toEqual([]);
  });

  it('tenantadmin holds every permission', () => {
    expect([...permissionsOf('tenantadmin')].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('every competence-gated activity is a real permission', () => {
    for (const a of COMPETENCE_GATED) expect(isPermission(a)).toBe(true);
  });

  it('customer roles hold no producer-console permissions', () => {
    const producerOnly = ['value:authorise', 'cert:issue', 'lot:release', 'user:manage', 'audit:export'] as const;
    for (const role of ALL_ROLES) {
      if (kindOf(role) !== 'customer') continue;
      for (const p of producerOnly) {
        expect(permissionsOf(role), `${role} must not hold ${p}`).not.toContain(p);
      }
    }
  });

  it('every permission has a human-readable description', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(PERMISSIONS[p].length, `${p} description`).toBeGreaterThan(0);
    }
  });
});

describe('segregation of duties', () => {
  // Prototype invariant: "every SoD rule guards a defined permission"
  it('every rule guards a defined permission', () => {
    for (const r of SOD_RULES) expect(isPermission(r.action), `${r.id} → ${r.action}`).toBe(true);
  });

  it('rule ids are unique', () => {
    const ids = SOD_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('blocks the assigner of a value from authorising it (SoD-1)', () => {
    const settings = defaultSodSettings();
    const value = { assignedBy: 'u-ravi' };
    expect(findSodViolation('value:authorise', value, 'u-ravi', settings)?.id).toBe('SoD-1');
    expect(findSodViolation('value:authorise', value, 'u-asha', settings)).toBeNull();
  });

  it('blocks deciding a claim you raised (SoD-2)', () => {
    const settings = defaultSodSettings();
    const claim = { raisedBy: 'u-suresh' };
    expect(findSodViolation('entitlement:decide', claim, 'u-suresh', settings)?.id).toBe('SoD-2');
    expect(findSodViolation('entitlement:decide', claim, 'u-arjun', settings)).toBeNull();
  });

  it('a disabled rule does not fire', () => {
    const settings = { ...defaultSodSettings(), 'SoD-1': false };
    expect(findSodViolation('value:authorise', { assignedBy: 'u-ravi' }, 'u-ravi', settings)).toBeNull();
  });

  it('SoD-3 and SoD-4 are off by default, matching the prototype', () => {
    const settings = defaultSodSettings();
    expect(isSodEnabled(settings, 'SoD-3')).toBe(false);
    expect(isSodEnabled(settings, 'SoD-4')).toBe(false);
  });

  it('a null record can never violate a rule', () => {
    expect(findSodViolation('value:authorise', null, 'u-ravi', defaultSodSettings())).toBeNull();
  });
});

describe('state machines', () => {
  it('every transition names a defined permission', () => {
    for (const m of ALL_MACHINES) {
      for (const t of m.transitions) {
        expect(isPermission(t.requires), `${m.name}: ${t.from}→${t.to} requires ${t.requires}`).toBe(true);
      }
    }
  });

  it('every transition references declared states', () => {
    for (const m of ALL_MACHINES) {
      const states = m.states as readonly string[];
      for (const t of m.transitions) {
        expect(states, `${m.name}.from=${t.from}`).toContain(t.from);
        expect(states, `${m.name}.to=${t.to}`).toContain(t.to);
      }
    }
  });

  it('no transition leaves a terminal state', () => {
    for (const m of ALL_MACHINES) {
      const terminal = m.terminal as readonly string[];
      const escaping = m.transitions.filter((t) => terminal.includes(t.from));
      expect(escaping.map((t) => `${m.name}:${t.from}→${t.to}`)).toEqual([]);
    }
  });

  it('the initial state is a declared state', () => {
    for (const m of ALL_MACHINES) {
      expect(m.states as readonly string[]).toContain(m.initial);
    }
  });

  it('every non-terminal state can be reached from the initial state', () => {
    for (const m of ALL_MACHINES) {
      const reached = new Set<string>([m.initial]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of m.transitions) {
          if (reached.has(t.from) && !reached.has(t.to)) { reached.add(t.to); grew = true; }
        }
      }
      const unreachable = (m.states as readonly string[]).filter((s) => !reached.has(s));
      expect(unreachable, `${m.name} unreachable states`).toEqual([]);
    }
  });

  it('rejects an illegal transition', () => {
    expect(canTransition(VALUE_MACHINE, 'draft', 'authorised')).toBeNull();
    expect(() => assertTransition(VALUE_MACHINE, 'draft', 'authorised')).toThrow(IllegalTransitionError);
  });

  it('allows the legal path draft → assigned → authorised', () => {
    expect(assertTransition(VALUE_MACHINE, 'draft', 'assigned').requires).toBe('value:assign');
    expect(assertTransition(VALUE_MACHINE, 'assigned', 'authorised').requires).toBe('value:authorise');
  });
});

describe('signature canonicalisation', () => {
  const study = {
    kind: 'study' as const,
    record: { id: 'ST-1001', projectId: 'PRJ-0412', type: 'homogeneity', equipmentIds: ['EQ-01', 'EQ-02'], uncertainty: 0.18 },
  };

  it('is deterministic', () => {
    expect(canonicalMaterial(study)).toBe(canonicalMaterial(study));
  });

  it('is insensitive to equipment ordering but sensitive to membership', () => {
    const reordered = { ...study, record: { ...study.record, equipmentIds: ['EQ-02', 'EQ-01'] } };
    const changed = { ...study, record: { ...study.record, equipmentIds: ['EQ-01', 'EQ-03'] } };
    expect(canonicalMaterial(reordered)).toBe(canonicalMaterial(study));
    expect(canonicalMaterial(changed)).not.toBe(canonicalMaterial(study));
  });

  it('changes when any material field changes', () => {
    const base = canonicalMaterial(study);
    expect(canonicalMaterial({ ...study, record: { ...study.record, uncertainty: 0.19 } })).not.toBe(base);
    expect(canonicalMaterial({ ...study, record: { ...study.record, type: 'stability' } })).not.toBe(base);
    expect(canonicalMaterial({ ...study, record: { ...study.record, projectId: 'PRJ-0413' } })).not.toBe(base);
  });

  it('carries the canonical version so old signatures stay verifiable', () => {
    expect(canonicalMaterial(study)).toMatch(/^v1\|/);
  });

  it('a field cannot forge a separator (§11.70 excision resistance)', () => {
    const a = canonicalMaterial({ ...study, record: { ...study.record, type: 'homogeneity|X' } });
    const b = canonicalMaterial({ ...study, record: { ...study.record, type: 'homogeneity' } });
    expect(a).not.toBe(b);
    expect(a).toContain('homogeneity\\|X');
  });

  it('binds signer and meaning, so a signature cannot be transferred or relabelled', () => {
    const at = '2026-01-08T10:15:00Z';
    const base = signaturePayload({ signable: study, signerUserId: 'u-ravi', meaning: 'approval', signedAt: at });
    expect(signaturePayload({ signable: study, signerUserId: 'u-asha', meaning: 'approval', signedAt: at })).not.toBe(base);
    expect(signaturePayload({ signable: study, signerUserId: 'u-ravi', meaning: 'review', signedAt: at })).not.toBe(base);
    expect(signaturePayload({ signable: study, signerUserId: 'u-ravi', meaning: 'approval', signedAt: '2026-01-09T10:15:00Z' })).not.toBe(base);
  });

  it('offers the four §11.50 meanings', () => {
    expect(ALL_SIGNATURE_MEANINGS).toEqual(['authorship', 'review', 'approval', 'responsibility']);
  });
});

describe('competence basis', () => {
  const basis = {
    competenceRecordId: 'CMP-001', activity: 'study:sign',
    validFrom: '2024-01-01', validTo: '2027-12-31',
    checkedOn: '2025-11-04', personUserId: 'u-ravi',
  };

  it('is valid inside the dated interval', () => expect(isBasisValid(basis)).toBe(true));
  it('is invalid before it starts', () => expect(isBasisValid({ ...basis, checkedOn: '2023-12-31' })).toBe(false));
  it('is invalid after it ends', () => expect(isBasisValid({ ...basis, checkedOn: '2028-01-01' })).toBe(false));
  it('is invalid when absent', () => expect(isBasisValid(null)).toBe(false));
  it('is valid on the boundary days', () => {
    expect(isBasisValid({ ...basis, checkedOn: '2024-01-01' })).toBe(true);
    expect(isBasisValid({ ...basis, checkedOn: '2027-12-31' })).toBe(true);
  });
});

describe('retention schedule', () => {
  it('class ids are unique', () => {
    const ids = RETENTION_SCHEDULE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every class states a driver and a conflict resolution', () => {
    for (const r of RETENTION_SCHEDULE) {
      expect(r.drivenBy.length, `${r.id} driver`).toBeGreaterThan(0);
      expect(r.conflictResolution.length, `${r.id} resolution`).toBeGreaterThan(0);
    }
  });

  it('CERT-In classes are pinned to India', () => {
    for (const r of RETENTION_SCHEDULE) {
      if (r.drivenBy.includes('CERT-In')) expect(r.indiaResident, `${r.id}`).toBe(true);
    }
  });

  it('only customer contact data is freely erasable under DPDP', () => {
    const erasable = RETENTION_SCHEDULE.filter((r) => !r.erasureRefusable).map((r) => r.id);
    expect(erasable).toEqual(['customer_contact_data']);
  });
});
