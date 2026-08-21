import type { CapaState } from './api';

/**
 * How each state is presented.
 *
 * The LABELS live here; the WORKFLOW does not. Which state may follow which is
 * fetched from the server's declared machine, because a second copy in the
 * console would drift from the one actually enforced and the drift would
 * surface as buttons that return 409.
 */
export const CAPA_STATE_LABEL: Record<CapaState, string> = {
  open: 'Open',
  investigation: 'Investigating',
  root_cause: 'Root cause',
  capa: 'Action',
  effectiveness: 'Effectiveness',
  closed: 'Closed',
};

/**
 * What the person is being asked to supply at each step.
 *
 * ISO 17034 7.11 wants the reasoning recorded, not just the state changed, so
 * each move prompts for the field that step is actually about.
 */
export const CAPA_STEP_PROMPT: Partial<Record<CapaState, {
  field: 'rootCause' | 'correctiveAction' | 'preventiveAction' | 'effectivenessCheck';
  label: string;
  hint: string;
  placeholder: string;
}>> = {
  root_cause: {
    field: 'rootCause', label: 'Root cause',
    hint: 'what actually caused it, not what happened',
    placeholder: 'The constraint permitted duplicate rows because SQL NULLs are distinct',
  },
  capa: {
    field: 'correctiveAction', label: 'Corrective action',
    hint: 'what was done about this occurrence',
    placeholder: 'Constraint changed to UNIQUE NULLS NOT DISTINCT',
  },
  effectiveness: {
    field: 'effectivenessCheck', label: 'Effectiveness check',
    hint: 'how you will know it worked',
    placeholder: 'Job run three times consecutively; second and third produced no duplicate',
  },
  closed: {
    field: 'preventiveAction', label: 'Preventive action',
    hint: 'optional — what stops the next one',
    placeholder: 'Every notice-sending job now asserts idempotency in its test',
  },
};

export const SEVERITY_TONE: Record<string, string> = {
  Critical: 'bad', Major: 'warn', Minor: 'grey',
};

/** Terminal states read as settled; everything else is outstanding. */
export function isOpen(state: CapaState): boolean {
  return state !== 'closed';
}

/** Days until due, negative when overdue. Null when no date is set. */
export function daysUntil(due: string | null, today = new Date()): number | null {
  if (!due) return null;
  const d = Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(d)) return null;
  const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - utcToday) / 86_400_000);
}

export interface DueLabel {
  readonly text: string;
  readonly overdue: boolean;
}

/**
 * How a due date reads on a row — or whether it reads at all.
 *
 * Extracted from the JSX because it was wrong there and nothing caught it: the
 * lateness branch required the CAPA to be OPEN, so a closed one fell through to
 * the other branch and rendered "due in -8 days". A due date on a closed CAPA
 * is not actionable, so it is not shown.
 */
export function dueLabel(state: CapaState, due: string | null, today = new Date()): DueLabel | null {
  if (!isOpen(state)) return null;
  const days = daysUntil(due, today);
  if (days === null) return null;
  if (days < 0) {
    const n = Math.abs(days);
    return { text: `${n} day${n === 1 ? '' : 's'} overdue`, overdue: true };
  }
  if (days === 0) return { text: 'due today', overdue: false };
  return { text: `due in ${days} day${days === 1 ? '' : 's'}`, overdue: false };
}

/**
 * What the server will still refuse a close for.
 *
 * Extracted so the console can say it BEFORE the attempt. The server enforces
 * the same rule and remains the authority; this exists so nobody discovers it
 * by being refused, and so it cannot silently drift out of step with the
 * fields the dialog actually offers — which is the defect that made the rule
 * enforced and unsatisfiable at the same time.
 */
export function missingToClose(args: {
  rootCause: string; correctiveAction: string;
}): string[] {
  return [
    args.rootCause.trim() ? null : 'a root cause',
    args.correctiveAction.trim() ? null : 'a corrective action',
  ].filter((x): x is string => x !== null);
}
