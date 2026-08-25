import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Capa as CapaRow, type CapaState, type CapaWorkflow } from '../lib/api';
import { CAPA_STATE_LABEL, SEVERITY_TONE, isOpen, daysUntil, dueLabel } from '../lib/capa';
import { when } from '../lib/format';
import { CapaTransition } from '../components/CapaTransition';

/**
 * Complaints, nonconformities and corrective action — ISO 17034 7.11.
 *
 * A register is scanned for what needs attention, not read top to bottom, so
 * severity and lateness are encoded in FORM as well as in text: an overdue
 * Critical should be findable without reading a single date.
 */
export function Capa({ canManage }: { canManage: boolean }) {
  const [moving, setMoving] = useState<{ capa: CapaRow; to: CapaState } | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const register = useQuery({
    queryKey: ['capa'],
    queryFn: () => api.get<{ capa: CapaRow[] }>('/capa'),
  });

  // The declared machine, so the progress rail reflects what is enforced.
  const workflow = useQuery({
    queryKey: ['capa-workflow'],
    queryFn: () => api.get<CapaWorkflow>('/capa/workflow'),
  });

  if (register.isLoading) return <div className="spinner">Loading the register…</div>;
  if (register.error) return <div className="note deny" role="alert">{(register.error as Error).message}</div>;

  const all = register.data?.capa ?? [];
  const open = all.filter((c) => isOpen(c.state));
  const closed = all.filter((c) => !isOpen(c.state));
  const overdue = open.filter((c) => { const d = daysUntil(c.due_on); return d !== null && d < 0; });
  const shown = showClosed ? all : open;

  const states = workflow.data?.states ?? [];

  return (
    <>
      <h1>Complaints &amp; CAPA</h1>
      <p className="lede">
        Every nonconformity, its root cause, and what was done about it. A CAPA is
        closed with its reasoning recorded — never deleted.
      </p>

      <div className="kpis">
        <div className="kpi"><div className="k">Open</div><div className="v">{open.length}</div></div>
        <div className="kpi"><div className="k">Overdue</div>
          <div className="v" style={overdue.length > 0 ? { color: 'var(--bad)' } : undefined}>
            {overdue.length}
          </div></div>
        <div className="kpi"><div className="k">Critical open</div>
          <div className="v">{open.filter((c) => c.severity === 'Critical').length}</div></div>
        <div className="kpi"><div className="k">Closed</div><div className="v">{closed.length}</div></div>
      </div>

      {open.length === 0 && (
        <div className="note okbox">
          No open nonconformities. This is the state an assessor hopes to find and
          rarely does — it is worth checking that findings are being raised at all.
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        <label className="inline">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          <span>Show closed ({closed.length})</span>
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="card empty"><b>Nothing to show</b>Switch on closed CAPAs to see the history.</div>
      ) : (
        <div className="capa-list">
          {shown.map((c) => {
            // The rule lives in lib/capa and is pinned by tests; it was wrong
            // while it lived inline here and nothing could catch it.
            const label = dueLabel(c.state, c.due_on);
            const late = label?.overdue ?? false;
            return (
              <article className={`capa ${late ? 'late' : ''}`} key={c.id}>
                <div className="capa-head">
                  <span className="mono code">{c.code}</span>
                  <span className={`chip ${SEVERITY_TONE[c.severity] ?? 'grey'}`}>{c.severity}</span>
                  <b className="capa-source">{c.source}</b>
                  {c.team && <span className="muted">· {c.team}</span>}
                  <span className="capa-when muted">
                    raised {c.raised_on}
                    {label && (
                      <span className={label.overdue ? 'overdue' : ''}>{' · '}{label.text}</span>
                    )}
                  </span>
                </div>

                {/* The rail is built from the server's states, so it cannot
                    show a step the machine does not have. */}
                <ol className="rail" aria-label="Workflow position">
                  {states.map((s) => {
                    const at = states.indexOf(c.state);
                    const here = states.indexOf(s);
                    const cls = here < at ? 'done' : here === at ? 'now' : 'todo';
                    return (
                      <li key={s} className={cls} aria-current={here === at ? 'step' : undefined}>
                        <span className="dot" aria-hidden="true" />
                        <span className="rail-label">{CAPA_STATE_LABEL[s]}</span>
                      </li>
                    );
                  })}
                </ol>

                {(c.root_cause || c.corrective_action) && (
                  <dl className="capa-detail">
                    {c.root_cause && <><dt>Root cause</dt><dd>{c.root_cause}</dd></>}
                    {c.corrective_action && <><dt>Corrective action</dt><dd>{c.corrective_action}</dd></>}
                  </dl>
                )}

                <div className="capa-actions">
                  {c.closed_at ? (
                    <span className="muted">Closed {when(c.closed_at)}</span>
                  ) : c.availableTransitions.length === 0 ? (
                    <span className="muted">No further moves.</span>
                  ) : !canManage ? (
                    <span className="muted">
                      Advancing a CAPA requires <span className="mono">capa:manage</span>.
                    </span>
                  ) : (
                    c.availableTransitions.map((to) => (
                      <button key={to}
                              className={`btn sm ${to === 'closed' ? '' : 'ghost'}`}
                              onClick={() => setMoving({ capa: c, to })}>
                        {to === 'closed' ? 'Close' : `Move to ${CAPA_STATE_LABEL[to]}`}
                      </button>
                    ))
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <CapaTransition
        capa={moving?.capa ?? null}
        to={moving?.to ?? null}
        onClose={() => setMoving(null)}
      />
    </>
  );
}
