import { useRef, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Step-up re-authentication.
 *
 * 21 CFR 11 §11.200(a)(1) requires two identification components for a signing.
 * Both are collected here, and the dialog explains WHY it is asking — a
 * credential prompt with no stated reason is exactly the shape of a phishing
 * screen, and training people to type their password into unexplained boxes is
 * its own security problem.
 */
export function StepUp({
  open, purpose, onClose, onUnlocked,
}: {
  open: boolean;
  purpose: string;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) { setPassword(''); setCode(''); setError(null); }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/step-up', { password, code });
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail : 'Could not open a signing session.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="modal" ref={ref} onCancel={onClose} aria-label="Confirm your identity">
      <form className="body" onSubmit={submit}>
        <h1>Confirm your identity</h1>
        <p className="lede" style={{ marginBottom: 14 }}>
          You are about to {purpose}. Signing requires both your password and a
          current authenticator code.
        </p>

        <label className="f">
          <span>Password</span>
          <input className="t" type="password" autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)}
                 required autoFocus />
        </label>

        <label className="f">
          <span>Authenticator code</span>
          <input className="t mono" inputMode="numeric" pattern="\d{6}" maxLength={6}
                 autoComplete="one-time-code" placeholder="000000"
                 value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                 required />
        </label>

        {error && <div className="note deny" role="alert">{error}</div>}

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Open signing session'}
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
