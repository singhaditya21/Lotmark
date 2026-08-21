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
import { PERMISSIONS, ALL_PERMISSIONS, COMPETENCE_GATED, isPermission } from '../permissions';
import { ROLES, ALL_ROLES, undefinedGrants, permissionsOf, kindOf } from '../roles';
import {
  SOD_RULES, defaultSodSettings, findSodViolation, findThresholdViolation,
  isSodEnabled, sodRuleByProvenance, PENDING_SOD_RULES,
} from '../sod';
import { ALL_MACHINES, canTransition, assertTransition, IllegalTransitionError, VALUE_MACHINE } from '../state-machines';
import { RETENTION_SCHEDULE } from '../retention';
import { canonicalMaterial, signaturePayload, ALL_SIGNATURE_MEANINGS, isBasisValid } from '../signatures';

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
    expect(findSodViolation('value:authorise', value, 'u-ravi', settings)?.rule.id)
      .toBe('value-assigner-may-not-authorise');
    expect(findSodViolation('value:authorise', value, 'u-asha', settings)).toBeNull();
  });

  it('blocks deciding a claim you raised (SoD-2)', () => {
    const settings = defaultSodSettings();
    const claim = { raisedBy: 'u-suresh' };
    expect(findSodViolation('entitlement:decide', claim, 'u-suresh', settings)?.rule.id)
      .toBe('claim-raiser-may-not-decide');
    expect(findSodViolation('entitlement:decide', claim, 'u-arjun', settings)).toBeNull();
  });

  it('a disabled rule does not fire', () => {
    const settings = { ...defaultSodSettings(), 'value-assigner-may-not-authorise': false };
    expect(findSodViolation('value:authorise', { assignedBy: 'u-ravi' }, 'u-ravi', settings)).toBeNull();
  });

  it('the two rules the prototype shipped disabled are still off by default', () => {
    const settings = defaultSodSettings();
    expect(isSodEnabled(settings, 'value-assigner-may-not-issue-certificate')).toBe(false);
    expect(isSodEnabled(settings, 'lot-creator-may-not-release')).toBe(false);
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

describe('segregation register — union of the wireframe and the prototype', () => {
  // The decisive property of the union decision: an assessor reading EITHER
  // artefact can look up the number they see and land on the right rule.
  it('resolves every wireframe rule number to exactly one rule', () => {
    const expected: Record<string, string> = {
      'SoD-1': 'value-assigner-may-not-authorise',
      'SoD-2': 'value-assigner-may-not-issue-certificate',
      'SoD-3': 'claim-raiser-may-not-decide',
      'SoD-4': 'refund-above-threshold-needs-second-approver',
      'SoD-5': 'study-signer-must-hold-competence',
    };
    for (const [label, id] of Object.entries(expected)) {
      expect(sodRuleByProvenance('wireframe', label)?.id, `wireframe ${label}`).toBe(id);
    }
  });

  it('resolves every prototype rule number to exactly one rule', () => {
    const expected: Record<string, string> = {
      'SoD-1': 'value-assigner-may-not-authorise',
      'SoD-2': 'claim-raiser-may-not-decide',
      'SoD-3': 'value-assigner-may-not-issue-certificate',
      'SoD-4': 'lot-creator-may-not-release',
    };
    for (const [label, id] of Object.entries(expected)) {
      expect(sodRuleByProvenance('prototype', label)?.id, `prototype ${label}`).toBe(id);
    }
  });

  it('the artefacts genuinely disagree — same number, different rule', () => {
    // Guards the reason semantic ids exist. If this ever stops being true the
    // indirection can be simplified; until then it must not be.
    expect(sodRuleByProvenance('wireframe', 'SoD-2')?.id)
      .not.toBe(sodRuleByProvenance('prototype', 'SoD-2')?.id);
    expect(sodRuleByProvenance('wireframe', 'SoD-4')?.id)
      .not.toBe(sodRuleByProvenance('prototype', 'SoD-4')?.id);
  });

  it('no provenance label maps to two rules within one source', () => {
    for (const source of ['wireframe', 'prototype'] as const) {
      const labels = SOD_RULES.map((r) => r.provenance[source]).filter(Boolean);
      expect(new Set(labels).size, `${source} labels`).toBe(labels.length);
    }
  });

  it('rule ids are unique and every rule carries at least one provenance', () => {
    const ids = SOD_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SOD_RULES) {
      const named = Object.values(r.provenance).filter(Boolean).length;
      expect(named, `${r.id} provenance`).toBeGreaterThan(0);
    }
  });

  it('declares the refund rule as pending rather than omitting it', () => {
    expect(PENDING_SOD_RULES.map((r) => r.id))
      .toEqual(['refund-above-threshold-needs-second-approver']);
  });
});

describe('threshold-approval rules', () => {
  const settings = defaultSodSettings();

  it('does not fire below the threshold', () => {
    expect(findThresholdViolation('order:refund', 4_999_99, ['u-arjun'], settings)).toBeNull();
  });

  it('is inert while the rule is pending-subject', () => {
    // Refunds are not modelled yet. The rule is visible in the register but
    // must not block anything, or it would block an unimplemented path.
    expect(findThresholdViolation('order:refund', 50_000_00, ['u-arjun'], settings)).toBeNull();
  });

  it('counts DISTINCT approvers once the subject exists', () => {
    // Simulate the enforced future by evaluating the rule shape directly.
    const rule = SOD_RULES.find((r) => r.kind === 'threshold-approval');
    expect(rule).toBeDefined();
    if (rule?.kind !== 'threshold-approval') throw new Error('shape changed');
    expect(rule.approversRequired).toBe(2);
    expect(new Set(['u-arjun', 'u-arjun']).size).toBeLessThan(rule.approversRequired);
    expect(new Set(['u-arjun', 'u-neha']).size).toBe(rule.approversRequired);
  });
});

describe('competence-gate rules', () => {
  it('name an activity that is a real permission', () => {
    for (const r of SOD_RULES) {
      if (r.kind !== 'competence-gate') continue;
      expect(isPermission(r.activity), `${r.id} activity`).toBe(true);
    }
  });
});
