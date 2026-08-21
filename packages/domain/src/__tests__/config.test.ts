import { describe, it, expect } from 'vitest';
import {
  CONFIG_SCHEMAS, ALL_CONFIG_KINDS, CONFIG_RISK, requiresSignatureToPublish,
  diffConfig, changesRequireSignature, parseConfigPayload,
  defaultRoles, defaultWorkflows, defaultSodConfig, defaultNumbering, defaultFlags,
  effectivePermissionsOfRole, resolveAuthority, can, teamsWherePermitted,
  assignmentActiveOn, ConfigError, anyPermissions,
  type RoleConfig, type RoleAssignment,
} from '../config';
import { ALL_PERMISSIONS } from '../permissions';
import { ALL_MACHINES } from '../state-machines';
import { SOD_RULES } from '../sod';

const roleMap = (rs: RoleConfig[]) => new Map(rs.map((r) => [r.key, r]));

describe('the config model can express everything that was hardcoded', () => {
  // The decisive test of the low-code pivot. If a rule that used to live in
  // code cannot survive the round trip into configuration, this fails.
  it('every default role validates as role configuration', () => {
    for (const r of defaultRoles()) {
      const res = CONFIG_SCHEMAS.role.safeParse(r);
      expect(res.success, `${r.key}: ${res.success ? '' : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });

  it('every default workflow validates, including reachability and terminality', () => {
    for (const w of defaultWorkflows()) {
      const res = CONFIG_SCHEMAS.workflow.safeParse(w);
      expect(res.success, `${w.key}: ${res.success ? '' : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });

  it('produces one workflow per built-in state machine, losing no transition', () => {
    const workflows = defaultWorkflows();
    expect(workflows).toHaveLength(ALL_MACHINES.length);
    for (const m of ALL_MACHINES) {
      const w = workflows.find((x) => x.key === m.name);
      expect(w, `workflow for ${m.name}`).toBeDefined();
      expect(w!.states).toHaveLength(m.states.length);
      expect(w!.transitions).toHaveLength(m.transitions.length);
      expect(w!.initial).toBe(m.initial);
    }
  });

  it('marks signing and authorisation transitions as signature-bearing', () => {
    const study = defaultWorkflows().find((w) => w.key === 'study')!;
    const sign = study.transitions.find((t) => t.to === 'signed')!;
    expect(sign.requiresSignature).toBe(true);
    expect(sign.signatureMeanings.length).toBeGreaterThan(0);
    expect(sign.requiresCompetence).toBe('study:sign');
  });

  it('requires a stated reason where the prototype demanded one', () => {
    const value = defaultWorkflows().find((w) => w.key === 'property_value')!;
    const returned = value.transitions.find((t) => t.from === 'assigned' && t.to === 'draft')!;
    expect(returned.requiresReason).toBe(true);
  });

  it('every default SoD entry and numbering template validates', () => {
    expect(defaultSodConfig()).toHaveLength(SOD_RULES.length);
    for (const s of defaultSodConfig()) expect(CONFIG_SCHEMAS.sod.safeParse(s).success).toBe(true);
    for (const n of defaultNumbering()) expect(CONFIG_SCHEMAS.numbering.safeParse(n).success).toBe(true);
    for (const f of defaultFlags()) expect(CONFIG_SCHEMAS.flag.safeParse(f).success).toBe(true);
  });

  it('every config kind has a schema registered', () => {
    for (const k of ALL_CONFIG_KINDS) expect(CONFIG_SCHEMAS[k], k).toBeDefined();
  });
});

describe('configuration cannot invent capability — the safety boundary', () => {
  it('REJECTS a role granting a permission that does not exist', () => {
    const res = CONFIG_SCHEMAS.role.safeParse({
      key: 'rogue', name: 'Rogue', kind: 'producer', permissions: ['everything:always'],
    });
    expect(res.success).toBe(false);
  });

  it('REJECTS a transition requiring a permission that does not exist', () => {
    const res = CONFIG_SCHEMAS.workflow.safeParse({
      key: 'w', name: 'W', entity: 'w',
      states: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }],
      initial: 'a', terminal: ['b'],
      transitions: [{ from: 'a', to: 'b', requires: 'invented:permission', action: 'Move' }],
    });
    expect(res.success).toBe(false);
  });

  it('accepts a role granting only real permissions', () => {
    const res = CONFIG_SCHEMAS.role.safeParse({
      key: 'reviewer', name: 'Reviewer', kind: 'producer',
      permissions: [ALL_PERMISSIONS[0], ALL_PERMISSIONS[1]],
    });
    expect(res.success).toBe(true);
  });
});

describe('workflow configuration is validated structurally', () => {
  const base = {
    key: 'w', name: 'W', entity: 'w',
    states: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }],
    initial: 'a', terminal: ['b'],
    transitions: [{ from: 'a', to: 'b', requires: 'project:read', action: 'Move' }],
  };

  it('accepts a well-formed workflow', () => {
    expect(CONFIG_SCHEMAS.workflow.safeParse(base).success).toBe(true);
  });

  it('REJECTS an undeclared initial state', () => {
    expect(CONFIG_SCHEMAS.workflow.safeParse({ ...base, initial: 'zzz' }).success).toBe(false);
  });

  it('REJECTS a transition out of a terminal state', () => {
    const bad = {
      ...base,
      transitions: [...base.transitions, { from: 'b', to: 'a', requires: 'project:read', action: 'Back' }],
    };
    expect(CONFIG_SCHEMAS.workflow.safeParse(bad).success).toBe(false);
  });

  it('REJECTS an unreachable state', () => {
    const bad = {
      ...base,
      states: [...base.states, { key: 'orphan', name: 'Orphan' }],
      terminal: ['b', 'orphan'],
    };
    const res = CONFIG_SCHEMAS.workflow.safeParse(bad);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.success ? {} : res.error.issues)).toContain('unreachable');
  });
});

describe('custom field configuration', () => {
  const base = { key: 'batch_origin', entity: 'lot', label: 'Batch origin', type: 'text' };

  it('accepts a simple text field', () => {
    expect(CONFIG_SCHEMAS.field.safeParse(base).success).toBe(true);
  });

  it('REJECTS a select field with no picklist', () => {
    expect(CONFIG_SCHEMAS.field.safeParse({ ...base, type: 'select' }).success).toBe(false);
  });

  it('REJECTS min greater than max', () => {
    expect(CONFIG_SCHEMAS.field.safeParse({ ...base, type: 'number', min: 10, max: 1 }).success).toBe(false);
  });

  it('REJECTS an invalid regular expression, rather than throwing at render time', () => {
    expect(CONFIG_SCHEMAS.field.safeParse({ ...base, pattern: '([unclosed' }).success).toBe(false);
  });

  it('REJECTS a key that is not a slug', () => {
    expect(CONFIG_SCHEMAS.field.safeParse({ ...base, key: 'Batch Origin!' }).success).toBe(false);
  });
});

describe('role inheritance', () => {
  it('flattens grants through the chain', () => {
    const roles = roleMap([
      { key: 'base', name: 'Base', kind: 'producer', permissions: ['project:read'], inherits: [], system: false },
      { key: 'senior', name: 'Senior', kind: 'producer', permissions: ['study:sign'], inherits: ['base'], system: false },
      { key: 'lead', name: 'Lead', kind: 'producer', permissions: ['lot:release'], inherits: ['senior'], system: false },
    ]);
    const perms = effectivePermissionsOfRole('lead', roles);
    expect([...perms].sort()).toEqual(['lot:release', 'project:read', 'study:sign']);
  });

  it('names the cycle rather than overflowing the stack', () => {
    const roles = roleMap([
      { key: 'a', name: 'A', kind: 'producer', permissions: [], inherits: ['b'], system: false },
      { key: 'b', name: 'B', kind: 'producer', permissions: [], inherits: ['a'], system: false },
    ]);
    expect(() => effectivePermissionsOfRole('a', roles)).toThrow(ConfigError);
    expect(() => effectivePermissionsOfRole('a', roles)).toThrow(/cycle/i);
  });

  it('reports an undefined parent role clearly', () => {
    const roles = roleMap([
      { key: 'a', name: 'A', kind: 'producer', permissions: [], inherits: ['ghost'], system: false },
    ]);
    expect(() => effectivePermissionsOfRole('a', roles)).toThrow(/'ghost' is not defined/);
  });
});

describe('team-scoped authorisation', () => {
  const roles = roleMap(defaultRoles());
  const TODAY = '2026-08-21';
  const ORGANICS = 'team-organics';
  const INORGANICS = 'team-inorganics';

  const authority = (assignments: RoleAssignment[]) =>
    resolveAuthority({ userId: 'u1', assignments, roles, asOf: TODAY });

  it('grants a team permission only within that team', () => {
    const a = authority([
      { userId: 'u1', roleKey: 'scientist', teamId: ORGANICS, validFrom: null, validTo: null },
    ]);
    expect(can(a, 'study:sign', { kind: 'team', teamId: ORGANICS })).toBe(true);
    expect(can(a, 'study:sign', { kind: 'team', teamId: INORGANICS })).toBe(false);
  });

  it('a team grant never satisfies a tenant-scoped act', () => {
    const a = authority([
      { userId: 'u1', roleKey: 'tenantadmin', teamId: ORGANICS, validFrom: null, validTo: null },
    ]);
    // Holding admin over one section is not authority over the whole producer.
    expect(can(a, 'user:manage', { kind: 'tenant' })).toBe(false);
    expect(can(a, 'user:manage', { kind: 'team', teamId: ORGANICS })).toBe(true);
  });

  it('a tenant-wide grant satisfies every team scope', () => {
    const a = authority([
      { userId: 'u1', roleKey: 'quality', teamId: null, validFrom: null, validTo: null },
    ]);
    expect(can(a, 'audit:verify', { kind: 'tenant' })).toBe(true);
    expect(can(a, 'audit:verify', { kind: 'team', teamId: INORGANICS })).toBe(true);
  });

  it('supports different roles on different teams', () => {
    const a = authority([
      { userId: 'u1', roleKey: 'scientist', teamId: ORGANICS, validFrom: null, validTo: null },
      { userId: 'u1', roleKey: 'techmgr', teamId: INORGANICS, validFrom: null, validTo: null },
    ]);
    expect(can(a, 'study:sign', { kind: 'team', teamId: ORGANICS })).toBe(true);
    expect(can(a, 'study:sign', { kind: 'team', teamId: INORGANICS })).toBe(false);
    expect(can(a, 'cert:issue', { kind: 'team', teamId: INORGANICS })).toBe(true);
    expect(can(a, 'cert:issue', { kind: 'team', teamId: ORGANICS })).toBe(false);
  });

  it('ignores assignments outside their validity window — leave cover expires', () => {
    const expired: RoleAssignment = {
      userId: 'u1', roleKey: 'techmgr', teamId: ORGANICS,
      validFrom: '2026-01-01', validTo: '2026-06-30',
    };
    expect(assignmentActiveOn(expired, TODAY)).toBe(false);
    expect(can(authority([expired]), 'cert:issue', { kind: 'team', teamId: ORGANICS })).toBe(false);

    const live = { ...expired, validTo: '2026-12-31' };
    expect(can(authority([live]), 'cert:issue', { kind: 'team', teamId: ORGANICS })).toBe(true);
  });

  it('ignores another user\'s assignments entirely', () => {
    const a = authority([
      { userId: 'someone-else', roleKey: 'tenantadmin', teamId: null, validFrom: null, validTo: null },
    ]);
    expect(can(a, 'user:manage', { kind: 'tenant' })).toBe(false);
    expect(a.teamIds).toEqual([]);
  });

  it('reports the teams to filter rows by', () => {
    const a = authority([
      { userId: 'u1', roleKey: 'scientist', teamId: ORGANICS, validFrom: null, validTo: null },
      { userId: 'u1', roleKey: 'scientist', teamId: INORGANICS, validFrom: null, validTo: null },
    ]);
    expect([...teamsWherePermitted(a, 'study:sign')].sort()).toEqual([INORGANICS, ORGANICS].sort());
    // A tenant-wide holder is unfiltered.
    const b = authority([{ userId: 'u1', roleKey: 'quality', teamId: null, validFrom: null, validTo: null }]);
    expect(teamsWherePermitted(b, 'audit:read')).toEqual(['*']);
  });

  it('anyPermissions unions across scopes for navigation only', () => {
    const a = authority([
      { userId: 'u1', roleKey: 'scientist', teamId: ORGANICS, validFrom: null, validTo: null },
      { userId: 'u1', roleKey: 'dispatch', teamId: INORGANICS, validFrom: null, validTo: null },
    ]);
    const all = anyPermissions(a);
    expect(all.has('study:sign')).toBe(true);
    expect(all.has('order:advance')).toBe(true);
    // But neither is exercisable outside its own team.
    expect(can(a, 'order:advance', { kind: 'team', teamId: ORGANICS })).toBe(false);
  });
});

describe('configuration change control', () => {
  it('classifies risk so presentation edits do not demand a signature', () => {
    expect(requiresSignatureToPublish('role')).toBe(true);
    expect(requiresSignatureToPublish('workflow')).toBe(true);
    expect(requiresSignatureToPublish('retention')).toBe(true);
    expect(requiresSignatureToPublish('layout')).toBe(false);
    expect(requiresSignatureToPublish('dashboard')).toBe(false);
  });

  it('every kind has a risk classification', () => {
    for (const k of ALL_CONFIG_KINDS) expect(CONFIG_RISK[k], k).toBeDefined();
  });

  it('detects additions, removals and modifications', () => {
    const before = [
      { kind: 'role' as const, key: 'a', payload: { x: 1 } },
      { kind: 'role' as const, key: 'b', payload: { x: 2 } },
    ];
    const after = [
      { kind: 'role' as const, key: 'a', payload: { x: 9 } },
      { kind: 'layout' as const, key: 'c', payload: {} },
    ];
    const d = diffConfig(before, after);
    expect(d).toEqual([
      { kind: 'layout', key: 'c', change: 'added', risk: 'presentation' },
      { kind: 'role', key: 'a', change: 'modified', risk: 'security' },
      { kind: 'role', key: 'b', change: 'removed', risk: 'security' },
    ]);
  });

  it('does not report a change when only key order differs', () => {
    const before = [{ kind: 'role' as const, key: 'a', payload: { x: 1, y: 2 } }];
    const after = [{ kind: 'role' as const, key: 'a', payload: { y: 2, x: 1 } }];
    // A spurious "modified" would demand a signature and a re-validation cycle
    // for a change that did not happen.
    expect(diffConfig(before, after)).toEqual([]);
  });

  it('demands a signature only when something above presentation changed', () => {
    expect(changesRequireSignature([
      { kind: 'layout', key: 'c', change: 'added', risk: 'presentation' },
    ])).toBe(false);
    expect(changesRequireSignature([
      { kind: 'layout', key: 'c', change: 'added', risk: 'presentation' },
      { kind: 'workflow', key: 'study', change: 'modified', risk: 'behaviour' },
    ])).toBe(true);
  });

  it('parses payloads through the kind registry', () => {
    expect(parseConfigPayload('flag', { key: 'x', name: 'X', enabled: true }).success).toBe(true);
    expect(parseConfigPayload('flag', { key: 'x' }).success).toBe(false);
  });
});
