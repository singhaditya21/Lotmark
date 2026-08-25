import { useState } from 'react';
import { api, ApiError, type Problem } from '../lib/api';
import { Field, useFieldErrors } from '../components/Dialog';

/**
 * Setting your own password.
 *
 * ── One screen, two ways in ─────────────────────────────────────────────────
 *
 * Either the server said you must — an account provisioned with a password
 * somebody else chose is refused everywhere else until it is replaced — or you
 * chose to from the header. The act is identical, so the screen is; only the
 * explanation and whether there is a way out differ.
 *
 * A modal was the obvious alternative and is worse for the forced case: a
 * dialog over a shell whose every control returns 403 shows the user a product
 * they cannot touch and invites them to try. The centred layout is the same one
 * sign-in uses, which is the truthful framing — this is still enrolment.
 *
 * ── Why a confirmation field ────────────────────────────────────────────────
 *
 * The value is masked and the old password stops working the moment this
 * succeeds. A typo is therefore not an inconvenience, it is a lockout that only
 * an administrator can undo. Checked here rather than at the server because it
 * is a question about this form, not about the account.
 */
export function ChangePassword({
  required, name, onDone, onCancel, onSignOut,
}: {
  /** The server is refusing everything else until this is done. */
  required: boolean;
  name: string;
  onDone: (otherSessionsEnded: number) => void;
  /** Voluntary changes can be abandoned. A required one cannot. */
  onCancel: (() => void) | undefined;
  /**
   * The way out of a REQUIRED change.
   *
   * There has to be one. Somebody who cannot complete this — no password
   * manager to hand, wrong account, an enrolment credential that was mistyped
   * on its way to them — must be able to leave rather than be held on a screen
   * with one button that does not work for them.
   */
  onSignOut: (() => void) | undefined;
}) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldError = useFieldErrors(problem);

  const mismatch = confirm.length > 0 && confirm !== newPassword;
  // The 12-character rule is printed on the field, so enforce it here too rather
  // than shipping a submit the server will predictably reject.
  const tooShort = newPassword.length > 0 && newPassword.length < 12;
  const submittable =
    currentPassword.length > 0 && newPassword.length >= 12 && !mismatch && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!submittable) return;
    setBusy(true); setError(null); setProblem(null);
    try {
      const r = await api.post<{ changed: boolean; otherSessionsEnded: number }>(
        '/auth/password', { currentPassword, newPassword });
      onDone(r.otherSessionsEnded);
    } catch (err) {
      if (err instanceof ApiError) {
        setProblem(err.problem);
        setError(err.problem.detail);
        // Nothing is auto-cleared. With the length rule enforced above, a
        // rejection here means the server disagreed (wrong current password,
        // reuse, …); wiping a field the user then has to retype — including a
        // long new password that was never the problem — only invites a weaker
        // choice. The field-level errors point at what to fix.
      } else {
        setError('Could not change the password.');
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="centre">
      <div className="signin">
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 680, letterSpacing: '-0.5px' }}>Lotmark</div>
          <div className="muted">{name}</div>
        </div>

        <div className="card pad">
          <form onSubmit={submit}>
            <h1>{required ? 'Set your own password' : 'Change your password'}</h1>
            <p className="lede">
              {required
                ? 'This account is still using the password it was issued. Somebody else chose '
                  + 'that password and may still know it, so it works for enrolment and nothing '
                  + 'else. Replace it to continue.'
                : 'Your other sessions will end. This one will not.'}
            </p>

            <Field label="Current password" error={fieldError.get('currentPassword')}>
              <input className="t" type="password" autoComplete="current-password"
                     value={currentPassword} onChange={(e) => setCurrent(e.target.value)}
                     required autoFocus />
            </Field>

            <Field label="New password" hint="at least 12 characters"
                   error={tooShort ? 'At least 12 characters.' : fieldError.get('newPassword')}>
              <input className="t" type="password" autoComplete="new-password"
                     value={newPassword} onChange={(e) => setNext(e.target.value)} required />
            </Field>

            <Field label="New password again"
                   error={mismatch ? 'These two do not match.' : undefined}>
              <input className="t" type="password" autoComplete="new-password"
                     value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>

            {error && <div className="note deny" role="alert">{error}</div>}

            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" type="submit" disabled={!submittable}
                      style={onCancel ? undefined : { width: '100%' }}>
                {busy ? 'Setting…' : 'Set password'}
              </button>
              {onCancel && (
                <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
              )}
            </div>
          </form>
        </div>

        {required && (
          <>
            <div className="note" style={{ marginTop: 14 }}>
              Length beats punctuation. A passphrase of ordinary words is both stronger and easier
              to remember than a short one with symbols substituted in.
            </div>
            {onSignOut && (
              <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
                <button className="btn ghost sm" type="button" onClick={onSignOut}>
                  Sign out instead
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
