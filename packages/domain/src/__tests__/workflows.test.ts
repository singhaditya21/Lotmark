import { describe, it, expect } from 'vitest';
import {
  ALL_MACHINES, defaultWorkflows, machineFromConfig, machineFor, builtInMachine,
  workflowConfigSchema, statesTheDatabaseRefuses, DDL_CONSTRAINED_STATES,
  canTransition, assertSystemTransition, reasonRequired, type StateMachine,
} from '../index';

/**
 * Workflows, resolved from configuration.
 *
 * The claim the architecture document has always made about `defaults.ts` is
 * that deriving configuration from the code constants "PROVES the configuration
 * model can express everything that used to be hardcoded". It was not proved,
 * and it was not true: `systemInitiated` was dropped in the derivation, so a
 * machine resolved back out of configuration silently forbade the moves
 * scheduled work is allowed to make. These tests are that claim, checked.
 */

const configured = () => new Map(
  defaultWorkflows().map((wf) => [wf.entity, machineFromConfig(wf)]),
);

describe('the round trip is lossless', () => {
  it('rebuilds every built-in machine from its own configuration', () => {
    /**
     * The whole low-code premise in one assertion. If a machine cannot survive
     * being written to configuration and read back, then configuration is a
     * description of the product rather than the product.
     */
    for (const original of ALL_MACHINES) {
      const wf = defaultWorkflows().find((w) => w.entity === original.name)!;
      const rebuilt = machineFromConfig(wf);

      expect(rebuilt.name, original.name).toBe(original.name);
      expect([...rebuilt.states].sort()).toEqual([...original.states].sort());
      expect(rebuilt.initial).toBe(original.initial);
      expect([...rebuilt.terminal].sort()).toEqual([...original.terminal].sort());

      const shape = (m: StateMachine<string>) => m.transitions
        .map((t) => `${t.from}->${t.to} ${t.requires} ${t.systemInitiated === true ? 'system' : 'person'}`)
        .sort();
      expect(shape(rebuilt), `${original.name} transitions`)
        .toEqual(shape(original as unknown as StateMachine<string>));
    }
  });

  it('keeps the moves a job is allowed to make unattended', () => {
    // The one that was actually broken. The entitlement lapse job asserts this
    // exact move, and a configured machine that dropped the flag refuses it.
    const entitlement = configured().get('entitlement')!;
    expect(() => assertSystemTransition(entitlement, 'approved', 'lapsed')).not.toThrow();
  });

  it('does not let configuration hand a job a move meant for a person', () => {
    const study = configured().get('study')!;
    expect(() => assertSystemTransition(study, 'draft', 'signed')).toThrow();
  });
});

describe('the ceremony a move carries', () => {
  it('asks for a reason on every CAPA move, as the routes already did', () => {
    /**
     * The CAPA route demanded a reason on every move while this list named one
     * of them. Making the route read configuration without fixing that would
     * have quietly dropped the requirement from four of the five moves — the
     * same shape as the lot-release signature, found the same way.
     */
    const capa = defaultWorkflows().find((w) => w.entity === 'capa')!;
    for (const t of capa.transitions) {
      expect(t.requiresReason, `${t.from} → ${t.to}`).toBe(true);
    }
  });

  it('leaves a reason optional where the product never asked for one', () => {
    // A reason is a quality practice, not a regulatory obligation, so it is a
    // default a tenant may configure away — unlike a signature.
    const study = defaultWorkflows().find((w) => w.entity === 'study')!;
    expect(study.transitions.every((t) => t.requiresReason === false)).toBe(true);
  });

  it('carries the reason flag onto the resolved machine', () => {
    const capa = configured().get('capa')!;
    const move = canTransition(capa, 'open', 'investigation')!;
    expect(reasonRequired(move)).toBe(true);
    const study = configured().get('study')!;
    expect(reasonRequired(canTransition(study, 'draft', 'signed')!)).toBe(false);
  });
});

describe('which machine governs', () => {
  it('prefers the configured one', () => {
    const wf = workflowConfigSchema.parse({
      key: 'capa', name: 'CAPA', entity: 'capa',
      states: [{ key: 'raised', name: 'Raised' }, { key: 'closed', name: 'Closed' }],
      initial: 'raised', terminal: ['closed'],
      transitions: [{ from: 'raised', to: 'closed', requires: 'capa:manage', action: 'Closed' }],
    });
    const m = machineFor('capa', new Map([['capa', machineFromConfig(wf)]]))!;
    expect(m.states).toEqual(['raised', 'closed']);
  });

  it('falls back to the built-in when a tenant has configured nothing', () => {
    /**
     * What makes this safe to turn on: a tenant that has never touched workflow
     * configuration behaves exactly as it did before there was any.
     */
    const m = machineFor('capa', new Map())!;
    expect(m).toEqual(builtInMachine('capa'));
  });

  it('knows nothing about an entity the product does not have', () => {
    expect(machineFor('widgets', new Map())).toBeNull();
  });
});

describe('configuration cannot invent capability', () => {
  it('drops a transition demanding a permission nothing enforces', () => {
    /**
     * Stored JSONB is validated on READ, never cast and trusted — the same rule
     * `session.ts` applies to roles. Dropping the transition means the move
     * cannot be made, which is the safe direction: the alternative is a move
     * gated on a permission no guard will ever check.
     */
    const wf = {
      key: 'capa', name: 'CAPA', entity: 'capa',
      states: [{ key: 'raised', name: 'Raised' }, { key: 'closed', name: 'Closed' }],
      initial: 'raised', terminal: ['closed'],
      transitions: [
        { from: 'raised', to: 'closed', requires: 'capa:manage', action: 'Closed',
          requiresSignature: false, signatureMeanings: [], requiresReason: false,
          guards: [], systemInitiated: false },
        { from: 'raised', to: 'closed', requires: 'invented:permission', action: 'Sneaked',
          requiresSignature: false, signatureMeanings: [], requiresReason: false,
          guards: [], systemInitiated: false },
      ],
    };
    const dropped: string[] = [];
    const m = machineFromConfig(wf as never, (r) => dropped.push(r));
    expect(m.transitions).toHaveLength(1);
    expect(dropped[0]).toMatch(/not a permission this system enforces/);
    expect(canTransition(m, 'raised', 'closed')!.action).toBe('Closed');
  });
});

describe('what the database could not store', () => {
  it('names the study states the schema cannot hold', () => {
    /**
     * `studies.state` carries a CHECK from migration 0001 listing its two
     * states — the only state vocabulary in the schema welded into DDL. A
     * configured study workflow adding a third would fail at the INSERT, which
     * reaches a user as a 500. Publication refuses it with a sentence instead.
     */
    const wf = workflowConfigSchema.parse({
      key: 'study', name: 'Study', entity: 'study',
      states: [
        { key: 'draft', name: 'Draft' },
        { key: 'reviewed', name: 'Reviewed' },
        { key: 'signed', name: 'Signed' },
      ],
      initial: 'draft', terminal: ['signed'],
      transitions: [
        { from: 'draft', to: 'reviewed', requires: 'study:run', action: 'Reviewed' },
        { from: 'reviewed', to: 'signed', requires: 'study:sign', action: 'Signed' },
      ],
    });
    expect(statesTheDatabaseRefuses(wf)).toEqual(['reviewed']);
  });

  it('objects to nothing for an entity with no such constraint', () => {
    const wf = defaultWorkflows().find((w) => w.entity === 'capa')!;
    expect(statesTheDatabaseRefuses(wf)).toEqual([]);
    expect(DDL_CONSTRAINED_STATES['capa']).toBeUndefined();
  });

  it('accepts the built-in study workflow unchanged', () => {
    const wf = defaultWorkflows().find((w) => w.entity === 'study')!;
    expect(statesTheDatabaseRefuses(wf)).toEqual([]);
  });
});
