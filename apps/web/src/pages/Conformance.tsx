import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError, type ConformanceView, type ConformanceRequirement } from '../lib/api';

/**
 * Conformance, evidenced from the records.
 *
 * ── What separates this from a specification with ticks ─────────────────────
 *
 * Each requirement carries two different things: a STATUS, which is what the
 * code does, and LIVE EVIDENCE, which is what the records currently show. They
 * can disagree, and the disagreement is the interesting part — competence
 * enforcement can be present in the code while no authorisation is valid today.
 *
 * Nothing here rounds a gap up to a pass. Subcontracting is declared and not
 * enforced and says so; key custody says dev_file is honest rather than
 * compliant. A conformance page that was entirely green would be the least
 * useful screen in the product.
 */

const STATUS_TONE: Record<string, string> = {
  enforced: 'ok', partial: 'warn', declared: 'bad', not_implemented: 'bad',
};

const STATUS_LABEL: Record<string, string> = {
  enforced: 'enforced', partial: 'partial',
  declared: 'declared, not enforced', not_implemented: 'not implemented',
};

export function Conformance({ canExport }: { canExport: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const view = useQuery({
    queryKey: ['conformance'],
    queryFn: () => api.get<ConformanceView>('/conformance'),
  });

  const exportPack = useMutation({
    mutationFn: () => api.post<{ manifest: { packDigest: string }; requirements: unknown[] }>(
      '/conformance/pack'),
    onSuccess: (pack) => {
      setError(null);
      setFlash(
        `Pack assembled: ${pack.requirements.length} requirements, digest ` +
        `${pack.manifest.packDigest.slice(0, 16)}…`,
      );
      /**
       * Handed over as a file the browser saves. The pack is signed and
       * digested, so what leaves here can be checked against what the ledger
       * says was exported.
       */
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lotmark-assessment-pack.json';
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.problem.detail : 'The pack could not be assembled.'),
  });

  const v = view.data;

  return (
    <>
      <h1>Conformance</h1>
      <p className="lede">
        Each clause, what the system does about it, and what the records
        currently show. The two are reported separately because they can
        disagree — and where they do, that is the finding.
      </p>

      {flash && <div className="note okbox">{flash}</div>}
      {error && <div className="note deny">{error}</div>}

      {v && (
        <div className="kpis" style={{ marginTop: 13 }}>
          <div className="kpi"><div className="k">Clauses</div><div className="v mono">{v.summary.clauses}</div></div>
          <div className="kpi"><div className="k">Fully enforced</div><div className="v mono">{v.summary.enforced}</div></div>
          <div className="kpi">
            <div className="k">With a gap</div>
            <div className="v mono">{v.summary.weaker}</div>
          </div>
        </div>
      )}

      <div className="row" style={{ margin: '12px 0' }}>
        <button className="btn" disabled={!canExport || exportPack.isPending}
                onClick={() => exportPack.mutate()}>
          {exportPack.isPending ? 'Assembling…' : 'Export the assessment pack'}
        </button>
        {!canExport && (
          <span className="muted">
            Exporting needs <span className="mono">audit:export</span> — a different act
            from reading this page, because a pack leaves the building.
          </span>
        )}
      </div>

      {view.isLoading && <div className="spinner">Gathering the evidence…</div>}

      {(v?.clauses ?? []).map((c) => (
        <div className="card" key={c.clause} style={{ marginTop: 13 }}>
          <div className="pad" style={{ paddingBottom: 8 }}>
            <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 15 }}>
              {c.clause}{' '}
              <span className={`chip ${STATUS_TONE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
            </h2>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Requirement</th><th>Status</th><th>What the records show</th><th /></tr>
              </thead>
              <tbody>
                {c.requirements.map((r) => (
                  <Row key={r.id} r={r} open={open === r.id}
                       onToggle={() => setOpen(open === r.id ? null : r.id)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

function Row({ r, open, onToggle }: {
  r: ConformanceRequirement; open: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <b className="mono" style={{ fontSize: 12 }}>{r.id}</b>
          <div className="muted" style={{ fontSize: 12.5 }}>{r.statement}</div>
        </td>
        <td><span className={`chip ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
        <td>
          {r.evidence ? (
            <>
              <span className={`chip ${r.evidence.satisfied ? 'ok' : 'warn'}`}>
                {r.evidence.satisfied ? 'supported' : 'see note'}
              </span>{' '}
              <span className="muted" style={{ fontSize: 12.5 }}>{r.evidence.summary}</span>
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              not evidenced from records — see the code and tests
            </span>
          )}
        </td>
        <td>
          <button className="btn ghost sm" onClick={onToggle}>{open ? 'less' : 'evidence'}</button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ background: 'var(--line2)' }}>
            {r.note && <div className="note warn" style={{ marginTop: 0 }}>{r.note}</div>}
            <div className="grid2" style={{ marginTop: 10 }}>
              <div>
                <b style={{ fontSize: 12.5 }}>Implemented by</b>
                <ul className="plain">
                  {r.code.map((c) => <li key={c} className="mono" style={{ fontSize: 11.5 }}>{c}</li>)}
                  {r.code.length === 0 && <li className="muted">—</li>}
                </ul>
              </div>
              <div>
                <b style={{ fontSize: 12.5 }}>Demonstrated by</b>
                <ul className="plain">
                  {r.tests.map((t) => (
                    <li key={`${t.file}:${t.named}`} className="mono" style={{ fontSize: 11.5 }}>
                      {t.file} — “{t.named}”
                    </li>
                  ))}
                  {r.tests.length === 0 && (
                    <li className="muted">
                      nothing demonstrates this, which is why it is not marked enforced
                    </li>
                  )}
                </ul>
              </div>
            </div>
            {r.evidence && (
              <div style={{ marginTop: 8 }}>
                <b style={{ fontSize: 12.5 }}>Figures an assessor can check</b>
                <div className="mono muted" style={{ fontSize: 11.5 }}>
                  {Object.entries(r.evidence.figures)
                    .map(([k, val]) => `${k}: ${val ?? '—'}`).join('  ·  ')}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
