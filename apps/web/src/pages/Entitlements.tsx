import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { api, ApiError, type EntitlementsView } from '../lib/api';
import { Dialog, Field } from '../components/Dialog';

/**
 * Government price-tier claims.
 *
 * ── Said on the screen, not just in a comment ───────────────────────────────
 *
 * An approved tier is RECORDED and changes no price: there is no tier price
 * list in the product. Letting a laboratory infer a discount that never arrives
 * would be worse than not offering the workflow at all, so the page says so
 * where the claim is made and where it is decided.
 *
 * ── SoD-3 ───────────────────────────────────────────────────────────────────
 *
 * You cannot decide a claim you raised. Enforced by the guard from the declared
 * rule; the console does not restate it, because a second copy would drift.
 */
export function Entitlements() {
  const qc = useQueryClient();
  const [claiming, setClaiming] = useState(false);
  const [document, setDocument] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [revalidationDue, setRevalidationDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const view = useQuery({
    queryKey: ['entitlements'],
    queryFn: () => api.get<EntitlementsView>('/entitlements'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['entitlements'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const onError = (e: unknown) =>
    setError(e instanceof ApiError ? e.problem.detail : 'That could not be completed.');

  const claim = useMutation({
    mutationFn: () => api.post<{ code: string }>('/entitlements', { supportingDocument: document }),
    onSuccess: (r) => {
      setClaiming(false); setDocument(''); setError(null);
      toast.success(`Claim ${r.code} raised. It is under review.`);
      refresh();
    },
    onError,
  });

  const decideOn = (approve: boolean) => ({
    approve, note,
    ...(approve && revalidationDue ? { revalidationDue } : {}),
  });

  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.post(`/entitlements/${deciding}/decide`, decideOn(approve)),
    onSuccess: () => {
      setDeciding(null); setNote(''); setRevalidationDue(''); setError(null);
      toast.success('Decision recorded.');
      refresh();
    },
    onError,
  });

  const v = view.data;

  return (
    <>
      <h1>Price tiers</h1>
      <p className="lede">
        A claim to a government price tier, with the documentation supporting it.
        A tier is not permanent — an approved one carries a revalidation date and
        lapses on its own.
      </p>

      {v?.tierHasNoPriceEffect && (
        <div className="note warn">
          <b>An approved tier is recorded and changes no price.</b> The product
          holds no tier price list, so nothing costs less as a result. Saying so
          here beats letting somebody expect a discount that never arrives.
        </div>
      )}

      {error && <div className="note deny" role="alert">{error}</div>}

      {v?.canClaim && (
        <div className="row" style={{ margin: '12px 0' }}>
          <button className="btn" onClick={() => { setClaiming(true); setError(null); }}>
            Claim a tier
          </button>
        </div>
      )}

      {view.isLoading ? <div className="spinner">Loading…</div> : (v?.claims ?? []).length === 0 ? (
        <div className="note">No claims.</div>
      ) : (
        <div className="card" style={{ marginTop: 13 }}>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Claim</th><th>Laboratory</th><th>Supporting document</th>
                  <th>State</th><th>Revalidation</th><th />
                </tr>
              </thead>
              <tbody>
                {v!.claims.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">
                      <b>{c.code}</b>
                      <div className="muted" style={{ fontSize: 11.5 }}>{c.raised_on}</div>
                    </td>
                    <td>
                      {c.organisation_name}
                      {c.raised_by_name && (
                        <div className="muted" style={{ fontSize: 11.5 }}>by {c.raised_by_name}</div>
                      )}
                    </td>
                    <td className="muted">{c.supporting_document}</td>
                    <td>
                      <span className={`chip ${
                        c.state === 'approved' ? 'ok' :
                        c.state === 'under_review' ? 'warn' : 'grey'}`}>
                        {c.state.replace('_', ' ')}
                      </span>
                      {c.decision_note && (
                        <div className="muted" style={{ fontSize: 11.5 }}>{c.decision_note}</div>
                      )}
                    </td>
                    <td className="mono muted">{c.revalidation_due ?? '—'}</td>
                    <td>
                      {v!.canDecide && c.state === 'under_review' && (
                        <button className="btn sm" onClick={() => { setDeciding(c.id); setError(null); }}>
                          Decide
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog
        open={claiming}
        title="Claim a government price tier"
        lede="One claim can be open at a time. Recorded and reviewed by the producer."
        onClose={() => setClaiming(false)}
        footer={<>
          <button className="btn" disabled={claim.isPending || document.trim().length === 0}
                  onClick={() => claim.mutate()}>
            {claim.isPending ? 'Raising…' : 'Raise claim'}
          </button>
          <button className="btn ghost" onClick={() => setClaiming(false)}>Cancel</button>
        </>}
      >
        <Field label="Supporting documentation" hint="required; what establishes the entitlement">
          <input className="t" value={document} onChange={(e) => setDocument(e.target.value)}
                 placeholder="Government laboratory registration GL-2291" />
        </Field>
      </Dialog>

      <Dialog
        open={deciding !== null}
        title="Decide this claim"
        lede="You cannot decide a claim you raised — the server refuses it under SoD-3."
        onClose={() => setDeciding(null)}
        footer={<>
          <button className="btn" disabled={decide.isPending || note.trim().length === 0}
                  onClick={() => decide.mutate(true)}>
            Approve
          </button>
          <button className="btn danger" disabled={decide.isPending || note.trim().length === 0}
                  onClick={() => decide.mutate(false)}>
            Reject
          </button>
          <button className="btn ghost" onClick={() => setDeciding(null)}>Cancel</button>
        </>}
      >
        <Field label="Reasoning" hint="required; recorded with the decision">
          <textarea className="t" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Registration verified against the published list" />
        </Field>
        <Field label="Revalidation due" hint="approval only; a job lapses the tier on this date">
          <input className="t mono" type="date" value={revalidationDue}
                 onChange={(e) => setRevalidationDue(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
