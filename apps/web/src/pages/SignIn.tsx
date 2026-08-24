import { useState } from 'react';
import { api, ApiError } from '../lib/api';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [stage, setStage] = useState<'credentials' | 'second-factor'>('credentials');
  const [email, setEmail] = useState('ravi@producer.example');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ outcome: string; secondFactorRequired: boolean }>(
        '/auth/sign-in', { email, password });
      if (r.secondFactorRequired) { setStage('second-factor'); setAttempt(1); }
      else onSignedIn();
    } catch (err) {
      // The server returns one uniform message for wrong password, unknown
      // account, locked and deactivated. Passing it through unchanged is what
      // keeps the form from becoming a user-enumeration oracle.
      setError(err instanceof ApiError ? err.problem.detail : 'Could not sign in.');
    } finally { setBusy(false); }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/second-factor', { code, attempt });
      onSignedIn();
    } catch (err) {
      const detail = err instanceof ApiError ? err.problem.detail : 'That code was not accepted.';
      setError(detail);
      setCode('');
      if (detail.includes('Sign in again')) { setStage('credentials'); setPassword(''); }
      else setAttempt((n) => n + 1);
    } finally { setBusy(false); }
  }

  return (
    <div className="centre">
      <div className="signin">
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 680, letterSpacing: '-0.5px' }}>Lotmark</div>
          <div className="muted">Reference material producer platform</div>
        </div>

        <div className="card pad">
          {stage === 'credentials' ? (
            <form onSubmit={submitCredentials}>
              <h1>Access your tenant</h1>
              <p className="lede">Sign in with your producer or laboratory account.</p>
              <label className="f">
                <span>Email address</span>
                <input className="t" type="email" autoComplete="username"
                       value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </label>
              <label className="f">
                <span>Password</span>
                <input className="t" type="password" autoComplete="current-password"
                       value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              {error && <div className="note deny">{error}</div>}
              <button className="btn" type="submit" disabled={busy} style={{ marginTop: 6, width: '100%' }}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <h1>Verify it is you</h1>
              <p className="lede">
                Enter the six-digit code from your authenticator. Attempt {attempt} of 3.
              </p>
              <label className="f">
                <span>Authenticator code</span>
                <input className="t mono" inputMode="numeric" pattern="\d{6}" maxLength={6}
                       autoComplete="one-time-code" placeholder="000000" value={code}
                       onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                       required autoFocus />
              </label>
              {error && <div className="note deny">{error}</div>}
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn" type="submit" disabled={busy || code.length !== 6}>
                  {busy ? 'Verifying…' : 'Verify'}
                </button>
                <button className="btn ghost" type="button"
                        onClick={() => { setStage('credentials'); setError(null); setPassword(''); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>

        {/*
          * The credentials hint differs between the two builds, and must.
          *
          * This box used to print the seeded password and the real authenticator
          * secret unconditionally. In the local development build that is a
          * convenience; in the published demo it put a working credential pair
          * for any instance seeded from this repository onto a public page. The
          * demo build shows its own throwaway password instead, and no secret at
          * all — the demo accepts any six digits, so there is nothing to copy.
          */}
        <div className="note" style={{ marginTop: 14 }}>
          {import.meta.env.VITE_DEMO ? (
            <>
              <b>Demonstration.</b> Every record here is invented and nothing is
              saved. Password <span className="mono">demo-viewer</span>, then any
              six digits at the authenticator step. The same screens change by
              role — try <span className="mono">admin@</span> (sees everything),
              {' '}<span className="mono">ravi@</span> (bench scientist,
              team-scoped), <span className="mono">arjun@</span> (commercial),
              {' '}<span className="mono">vikram@</span> (dispatch), or a customer:
              {' '}<span className="mono">meera@genpharm.example</span> and
              {' '}<span className="mono">suresh@sdtl.gov.example</span>, who each
              see only their own laboratory.
            </>
          ) : (
            <>
              <b>Demonstration data.</b> Password{' '}
              <span className="mono">demo-password-1234</span>.
              Authenticator secret{' '}
              <span className="mono">JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP</span>.
              Try <span className="mono">ravi@</span> (bench scientist, team-scoped),
              {' '}<span className="mono">neha@</span> (quality, tenant-wide) or
              {' '}<span className="mono">meera@genpharm.example</span> (customer).
            </>
          )}
        </div>
      </div>
    </div>
  );
}
