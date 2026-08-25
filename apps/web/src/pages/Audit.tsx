import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuditEntry, type ChainResult } from '../lib/api';
import { when } from '../lib/format';

/**
 * Three outcomes, not two.
 *
 * A chain the verifier could not check is NOT a broken chain, and rendering it
 * in the same red box would send somebody to investigate a breach that did not
 * happen. It happens whenever the audit key has been rotated and this process
 * holds only the current one — an ordinary, expected state.
 */
function ChainVerdict({ result }: { result: ChainResult }) {
  const spanned = result.generations.length > 1
    ? ` spanning key generations ${result.generations.join(' and ')}`
    : '';

  if (result.ok) {
    return (
      <div className="note okbox" role="status">
        The chain is intact across {result.entries} entries{spanned}.
      </div>
    );
  }

  if (result.unverified) {
    return (
      <div className="note warn" role="status">
        <b>Not checked — this is not a failure.</b> No key is held for generation{' '}
        <span className="mono">{result.keysMissing.join(', ')}</span>, so those entries could
        not be verified. Nothing suggests they have been altered; the key simply is not on
        this server. Supply the retired key in <span className="mono">LOTMARK_AUDIT_KEYS</span>{' '}
        to check them.
      </div>
    );
  }

  return (
    <div className="note deny" role="alert">
      <b>BROKEN at entry {result.brokenAt}.</b> {result.reason}
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  DENY: 'bad', SECURITY: 'bad', SIGNATURE: 'ok', CERTIFICATE: 'ok',
  WORKFLOW: 'grey', AUTH: 'grey', SYSTEM: 'grey', CONFIGURATION: 'warn', PII: 'warn',
};

export function Audit({ canVerify }: { canVerify: boolean }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<ChainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit?limit=200'),
  });

  const verify = useMutation({
    mutationFn: () => api.post<ChainResult>('/audit/verify'),
    onSuccess: (r) => {
      setResult(r); setError(null);
      // Verifying is itself an audited act, so the ledger has changed.
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.problem.detail : 'Verification failed.'),
  });

  return (
    <>
      <h1>Audit ledger</h1>
      <p className="lede">
        Every act is appended and linked to the one before it by HMAC-SHA256
        under a key held outside the database. Altering or removing an entry
        cannot be hidden — it breaks every link that follows.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => verify.mutate()} disabled={!canVerify || verify.isPending}>
          {verify.isPending ? 'Verifying…' : 'Verify the chain'}
        </button>
        {!canVerify && (
          <span className="muted">
            Verifying requires <span className="mono">audit:verify</span>, which your role does not hold.
          </span>
        )}
      </div>

      {error && <div className="note deny" role="alert">{error}</div>}
      {result && <ChainVerdict result={result} />}

      {isLoading ? <div className="spinner">Loading the ledger…</div> : (
        <div className="card ledger" style={{ marginTop: 13 }}>
          {(data?.entries ?? []).map((e) => (
            <div className="e" key={e.seq}>
              <span className="mono muted">#{e.seq}</span>
              <span className="mono muted">{when(e.occurred_at)}</span>
              <span><span className={`chip ${KIND_TONE[e.kind] ?? 'grey'}`}>{e.kind}</span></span>
              <span>
                <b>{e.action}</b>
                {e.detail && <span className="muted"> — {e.detail}</span>}
                <span className="muted"> · {e.actor_label}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
