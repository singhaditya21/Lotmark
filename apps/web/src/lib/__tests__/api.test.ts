import { describe, it, expect } from 'vitest';
import { ApiError, type Problem } from '../api';

/**
 * The problem shape as the SERVER actually builds it.
 *
 * Reproduced from apps/api/src/http/problem.ts: `type` is the code appended to
 * a base URI, `code` is the raw machine-readable string, and `title` is that
 * code HUMANISED for display. Writing the fixture by hand from the server's
 * rules is the point — a fixture that guessed the shape would have agreed with
 * the bug below rather than catching it.
 */
function serverProblem(code: string, status: number, detail: string): Problem {
  return {
    type: `https://lotmark.local/problems/${code}`,
    title: code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    status,
    detail,
    code,
  };
}

describe('recognising a step-up request', () => {
  it('detects the step-up problem the server really sends', () => {
    /**
     * The regression this file exists for.
     *
     * `needsStepUp` compared `title` against 'step_up_required'. The server
     * sends title 'Step up required' and code 'step_up_required', so the
     * comparison was always false and the console never opened the
     * re-authentication dialog — for signing a study, assigning a value,
     * authorising one, issuing a certificate or reissuing one. Every signed act
     * dead-ended the first time in a session with a red message telling the
     * user to re-enter credentials and nothing to enter them into.
     */
    const problem = serverProblem('step_up_required', 401, 'Re-enter your password and authenticator code before signing.');
    expect(problem.title, 'the server humanises the code into the title').toBe('Step up required');

    const error = new ApiError(401, problem);
    expect(error.needsStepUp).toBe(true);
  });

  it('does not mistake other 401s for a step-up', () => {
    // An expired session must NOT open the signing dialog: the user needs to
    // sign in again, and asking them to step up instead is a dead end of its own.
    for (const code of ['session_expired', 'not_authenticated', 'second_factor_required', 'authentication_failed']) {
      const error = new ApiError(401, serverProblem(code, 401, 'nope'));
      expect(error.needsStepUp, `${code} must not read as a step-up`).toBe(false);
    }
  });

  it('does not treat a non-401 as a step-up even with the same code', () => {
    const error = new ApiError(403, serverProblem('step_up_required', 403, 'nope'));
    expect(error.needsStepUp).toBe(false);
  });
});

describe('reading a refusal', () => {
  it('exposes forbidden separately from field errors', () => {
    const denial = new ApiError(403, serverProblem('segregation_of_duties', 403,
      'Segregation of duties (SoD-1): you cannot authorise a value you assigned.'));
    expect(denial.isForbidden).toBe(true);
    expect(denial.fieldErrors).toEqual([]);
    expect(denial.message).toContain('SoD-1');
  });

  it('surfaces field errors for inline display', () => {
    const invalid = new ApiError(400, {
      ...serverProblem('invalid_request', 400, 'A reissue must state why.'),
      errors: [{ field: 'reason', message: 'A reissue must state why.' }],
    });
    expect(invalid.fieldErrors).toEqual([{ field: 'reason', message: 'A reissue must state why.' }]);
  });
});
