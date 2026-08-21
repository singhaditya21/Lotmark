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
export function daysUntil(due: string | null): number | null {
  if (!due) return null;
  const d = Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(d)) return null;
  const today = new Date();
  const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - utcToday) / 86_400_000);
}
