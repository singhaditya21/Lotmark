import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, ApiError, type Project, type Study, type PropertyValue, type Lot, type Budget,
} from '../lib/api';
import { sig } from '../lib/format';
import { SignAction } from '../components/SignAction';
import { StepUp } from '../components/StepUp';
import type { Meaning } from '../lib/meanings';

type Pending =
  | { kind: 'sign-study'; id: string; code: string }
  | { kind: 'assign'; id: string; code: string }
  | { kind: 'authorise'; id: string; code: string }
  | { kind: 'certificate'; id: string; code: string }
  | null;

export function ProjectDetail({ project, onBack }: { project: Project; onBack: () => void }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [stepUpFor, setStepUpFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const studies = useQuery({
    queryKey: ['studies', project.id],
    queryFn: () => api.get<{ studies: Study[] }>(`/projects/${project.id}/studies`),
  });
  const values = useQuery({
    queryKey: ['values', project.id],
    queryFn: () => api.get<{ values: PropertyValue[] }>(`/projects/${project.id}/values`),
  });
  const lots = useQuery({
    queryKey: ['lots', project.id],
    queryFn: () => api.get<{ lots: Lot[] }>(`/projects/${project.id}/lots`),
  });
  const budget = useQuery({
    queryKey: ['budget', project.id],
    queryFn: () => api.get<Budget>(`/projects/${project.id}/budget`),
  });

  const refresh = () => {
    for (const k of ['studies', 'values', 'lots', 'budget']) {
      void qc.invalidateQueries({ queryKey: [k, project.id] });
    }
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };

  const act = useMutation({
    mutationFn: async ({ p, meaning, reason }: { p: NonNullable<Pending>; meaning: Meaning; reason: string }) => {
      const path =
        p.kind === 'sign-study' ? `/studies/${p.id}/sign`
        : p.kind === 'assign' ? `/values/${p.id}/assign`
        : p.kind === 'authorise' ? `/values/${p.id}/authorise`
        : `/lots/${p.id}/certificate`;
      return api.post<Record<string, unknown>>(path, { meaning, reason: reason || undefined });
    },
    onSuccess: (_r, vars) => {
      setPending(null); setError(null);
      setFlash(`${describe(vars.p)} — signed and recorded in the ledger.`);
      refresh();
    },
    onError: (e, vars) => {
      if (e instanceof ApiError && e.needsStepUp) {
        // Not a failure: the act is legitimate, the session simply has not been
        // stepped up. Ask for the components and let them retry.
        setPending(null);
        setStepUpFor(describe(vars.p));
        return;
      }
      setError(e instanceof ApiError ? e.problem.detail : 'The action could not be completed.');
    },
  });

  const draftStudies = (studies.data?.studies ?? []).filter((s) => s.state === 'draft');
  const b = budget.data?.budget;

  return (
    <>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 12 }}>← Projects</button>
      <h1>{project.code} · {project.material}</h1>
      <p className="lede">
        {project.sku} · CAS {project.cas ?? '—'} · {project.team ?? 'no team'} ·
        stage <b>{project.stage}</b>
      </p>

      {flash && <div className="note okbox">{flash}</div>}
      {error && <div className="note deny">{error}</div>}

      <div className="kpis" style={{ marginTop: 13 }}>
        <div className="kpi"><div className="k">Assigned value</div>
          <div className="v mono">{sig(budget.data?.assignedValue, 7)}</div></div>
        <div className="kpi"><div className="k">u combined</div>
          <div className="v mono">{sig(b?.uCombined, 4)}</div></div>
        <div className="kpi"><div className="k">U (k={b?.coverageFactor ?? 2})</div>
          <div className="v mono">{sig(b?.expanded, 4)}</div></div>
        <div className="kpi"><div className="k">Budget</div>
          <div className="v">
            <span className={`chip ${b?.complete ? 'ok' : 'warn'}`}>
              {b?.complete ? 'complete' : 'incomplete'}
            </span>
          </div></div>
      </div>

      <div className="card pad">
        <h2 style={{ marginTop: 0 }}>Uncertainty budget</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Computed from raw measurements every time it is asked for. Nothing here
          is stored as a summary, and no screen offers a field to type it into.
        </p>
        {(budget.data?.components ?? []).length === 0 ? (
          <p className="muted">No signed studies contribute yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Component</th><th>Study</th><th>Value</th><th>Basis</th></tr></thead>
              <tbody>
                {budget.data!.components.map((c) => (
                  <tr key={c.studyId + c.symbol}>
                    <td className="mono"><b>{c.symbol}</b></td>
                    <td className="mono">{c.studyId}</td>
                    <td className="mono">{sig(c.value, 6)}</td>
                    <td className="muted">{c.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Studies</h2>
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Code</th><th>Type</th><th>State</th><th>u</th><th>Signed</th><th /></tr></thead>
            <tbody>
              {(studies.data?.studies ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td>
                  <td>{s.type}</td>
                  <td><span className={`chip ${s.state === 'signed' ? 'ok' : 'grey'}`}>{s.state}</span></td>
                  <td className="mono">{sig(s.uncertainty, 6)}</td>
                  <td className="mono muted">{s.signedOn ?? '—'}</td>
                  <td>
                    {s.state === 'draft' && (
                      <button className="btn sm" onClick={() => setPending({ kind: 'sign-study', id: s.id, code: s.code })}>
                        Sign
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Property values</h2>
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Code</th><th>Property</th><th>Value</th><th>U</th><th>State</th><th /></tr></thead>
            <tbody>
              {(values.data?.values ?? []).map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.code}</td>
                  <td>{v.property_name}</td>
                  <td className="mono">{sig(v.assigned_value, 7)} {v.unit}</td>
                  <td className="mono">± {sig(v.expanded_uncertainty, 4)}</td>
                  <td>
                    <span className={`chip ${v.state === 'authorised' ? 'ok' : v.state === 'assigned' ? 'warn' : 'grey'}`}>
                      {v.state}
                    </span>
                  </td>
                  <td>
                    {v.state === 'draft' && (
                      <button className="btn sm" disabled={!b?.complete}
                              title={b?.complete ? '' : 'All three studies must be signed first'}
                              onClick={() => setPending({ kind: 'assign', id: v.id, code: v.code })}>
                        Assign
                      </button>
                    )}
                    {v.state === 'assigned' && (
                      <button className="btn sm" onClick={() => setPending({ kind: 'authorise', id: v.id, code: v.code })}>
                        Authorise
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {draftStudies.length > 0 && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <div className="note">
              {draftStudies.length} stud{draftStudies.length === 1 ? 'y is' : 'ies are'} still
              unsigned, so the budget is incomplete and no value can be assigned yet.
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="pad" style={{ paddingBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Lot register</h2>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Lot</th><th>State</th><th>Expires</th><th>Storage</th><th>Supersedes</th><th>Certificate</th><th /></tr>
            </thead>
            <tbody>
              {(lots.data?.lots ?? []).length === 0 ? (
                <tr><td colSpan={7} className="muted">No lots released.</td></tr>
              ) : lots.data!.lots.map((l) => (
                <tr key={l.id}>
                  <td className="mono"><b>{l.lot_code}</b></td>
                  <td><span className={`chip ${l.state === 'released' ? 'ok' : 'grey'}`}>{l.state}</span></td>
                  <td className="mono">{l.expiry_date}</td>
                  <td>{l.storage_condition}{l.cold_chain && <span className="chip warn" style={{ marginLeft: 6 }}>cold chain</span>}</td>
                  <td className="mono muted">{l.supersedes ?? '—'}</td>
                  <td className="mono">{l.certificate_code ?? '—'}</td>
                  <td>
                    {l.state === 'released' && !l.certificate_code && (
                      <button className="btn sm" onClick={() => setPending({ kind: 'certificate', id: l.id, code: l.lot_code })}>
                        Issue certificate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <SignAction
        open={pending !== null}
        title={pending ? describe(pending) : ''}
        description={pending ? explain(pending) : ''}
        busy={act.isPending}
        error={null}
        onCancel={() => { setPending(null); setError(null); }}
        onSign={(meaning, reason) => pending && act.mutate({ p: pending, meaning, reason })}
      />

      <StepUp
        open={stepUpFor !== null}
        purpose={stepUpFor ?? ''}
        onClose={() => setStepUpFor(null)}
        onUnlocked={() => { setStepUpFor(null); setFlash('Signing session open. Try the action again.'); }}
      />
    </>
  );
}

function describe(p: NonNullable<Pending>): string {
  switch (p.kind) {
    case 'sign-study': return `Sign study ${p.code}`;
    case 'assign': return `Assign property value ${p.code}`;
    case 'authorise': return `Authorise property value ${p.code}`;
    case 'certificate': return `Issue a certificate for ${p.code}`;
  }
}

function explain(p: NonNullable<Pending>): string {
  switch (p.kind) {
    case 'sign-study':
      return 'The uncertainty will be computed from the raw measurements and bound into your signature.';
    case 'assign':
      return 'The value and its uncertainty are derived from the signed studies. You cannot alter them here.';
    case 'authorise':
      return 'You are accepting this value on behalf of the producer. The person who assigned it cannot perform this step.';
    case 'certificate':
      return 'The stated value and uncertainty will be frozen onto this issue. A later revision becomes a reissue, never an edit.';
  }
}
