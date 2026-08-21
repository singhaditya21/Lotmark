/**
 * Regression tests for three UI defects found by driving the console by hand.
 *
 * Each was a rule living inline in JSX, where nothing could catch it being
 * wrong. Fixing them without pinning them is how they come back.
 */
import { describe, it, expect } from 'vitest';
import { dueLabel, daysUntil, missingToClose, isOpen, CAPA_STATE_LABEL } from '../capa';
import type { CapaState } from '../api';

const TODAY = new Date('2026-08-21T09:00:00Z');
const offset = (days: number) =>
  new Date(Date.UTC(2026, 7, 21 + days)).toISOString().slice(0, 10);

describe('due dates — defect 3: "due in -8 days"', () => {
  it('says nothing at all on a CLOSED capa', () => {
    // The original bug: the lateness branch required the CAPA to be open, so a
    // closed one fell through and rendered a negative countdown.
    expect(dueLabel('closed', offset(-8), TODAY)).toBeNull();
    expect(dueLabel('closed', offset(+8), TODAY)).toBeNull();
    expect(dueLabel('closed', offset(0), TODAY)).toBeNull();
  });

  it('reports overdue days as a positive count, never a negative countdown', () => {
    expect(dueLabel('open', offset(-8), TODAY)).toEqual({ text: '8 days overdue', overdue: true });
    expect(dueLabel('investigation', offset(-1), TODAY)).toEqual({ text: '1 day overdue', overdue: true });
  });

  it('handles today and the future', () => {
    expect(dueLabel('open', offset(0), TODAY)).toEqual({ text: 'due today', overdue: false });
    expect(dueLabel('open', offset(1), TODAY)).toEqual({ text: 'due in 1 day', overdue: false });
    expect(dueLabel('open', offset(22), TODAY)).toEqual({ text: 'due in 22 days', overdue: false });
  });

  it('says nothing when no due date is set', () => {
    expect(dueLabel('open', null, TODAY)).toBeNull();
  });

  it('never renders a negative number, in any state or offset', () => {
    const states: CapaState[] = ['open', 'investigation', 'root_cause', 'capa', 'effectiveness', 'closed'];
    for (const state of states) {
      for (let d = -400; d <= 400; d += 7) {
        const label = dueLabel(state, offset(d), TODAY);
        if (label) expect(label.text, `${state} @ ${d}`).not.toMatch(/-\d/);
      }
    }
  });

  it('is not thrown by a malformed date', () => {
    expect(daysUntil('not-a-date', TODAY)).toBeNull();
    expect(dueLabel('open', 'not-a-date', TODAY)).toBeNull();
  });
});

describe('closing requirements — defect 1: the dead end', () => {
  it('names BOTH required fields when both are absent', () => {
    // The original bug: the server demanded a corrective action and the dialog
    // offered only a preventive one, so the rule was enforced and
    // unsatisfiable. This list is what the dialog renders fields for.
    expect(missingToClose({ rootCause: '', correctiveAction: '' }))
      .toEqual(['a root cause', 'a corrective action']);
  });

  it('names only what is actually missing', () => {
    expect(missingToClose({ rootCause: 'Seal tool out of tolerance', correctiveAction: '' }))
      .toEqual(['a corrective action']);
    expect(missingToClose({ rootCause: '', correctiveAction: 'Tool recalibrated' }))
      .toEqual(['a root cause']);
  });

  it('is satisfied when both are present', () => {
    expect(missingToClose({ rootCause: 'Cause', correctiveAction: 'Action' })).toEqual([]);
  });

  it('does not accept whitespace as an answer', () => {
    // "   " would satisfy a length check and tell an assessor nothing.
    expect(missingToClose({ rootCause: '   ', correctiveAction: '\t\n' }))
      .toEqual(['a root cause', 'a corrective action']);
  });
});

describe('state presentation', () => {
  it('treats only closed as settled', () => {
    const states: CapaState[] = ['open', 'investigation', 'root_cause', 'capa', 'effectiveness'];
    for (const s of states) expect(isOpen(s), s).toBe(true);
    expect(isOpen('closed')).toBe(false);
  });

  it('labels every state the server can send', () => {
    // The workflow itself comes from the server; only the LABELS live here, and
    // a state without one would render blank in the progress rail.
    const states: CapaState[] = ['open', 'investigation', 'root_cause', 'capa', 'effectiveness', 'closed'];
    for (const s of states) {
      expect(CAPA_STATE_LABEL[s], s).toBeTruthy();
    }
  });
});
