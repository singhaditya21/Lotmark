import { useState, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Study } from '../lib/api';
import { Dialog, Field } from './Dialog';

/**
 * Measurement entry.
 *
 * A paste target, not a form. Scientists arrive with numbers already in a
 * spreadsheet or an instrument export; making them retype into 24 boxes is how
 * transcription errors enter a certificate. The grid parses tab- or
 * comma-separated rows and shows exactly what it understood before anything is
 * sent.
 */
export function RecordResults({
  open, study, onClose,
}: { open: boolean; study: Study; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [unit, setUnit] = useState('% w/w');
  const [replace, setReplace] = useState(false);
  const [problem, setProblem] = useState<ApiError['problem'] | null>(null);

  const shape = study.type === 'homogeneity'
    ? { cols: ['unit', 'replicate', 'value'], hint: 'unit, replicate, value' }
    : study.type === 'stability'
      ? { cols: ['elapsedMonths', 'value'], hint: 'months elapsed, value' }
      : { cols: ['laboratory', 'value'], hint: 'laboratory, value' };

  const parsed = useMemo(() => {
    const rows: Array<Record<string, string | number>> = [];
    const bad: number[] = [];
    text.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
      const parts = line.split(/[\t,;]+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length !== shape.cols.length) { bad.push(i + 1); return; }
      const row: Record<string, string | number> = {};
      shape.cols.forEach((c, j) => {
        const raw = parts[j]!;
        row[c] = c === 'laboratory' ? raw : Number(raw);
      });
      if (shape.cols.some((c) => c !== 'laboratory' && !Number.isFinite(row[c] as number))) {
        bad.push(i + 1); return;
      }
      rows.push(row);
    });
    return { rows, bad };
  }, [text, shape.cols]);

  const save = useMutation({
    mutationFn: () => api.put(`/studies/${study.id}/results`, {
      measurements: parsed.rows, unit, replace,
    }),
    onSuccess: () => {
      void qc.invalidateQueries();
      setText(''); setProblem(null); onClose();
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.problem : null),
  });

  return (
    <Dialog
      open={open}
      title={`Measurements for ${study.code}`}
      lede={`Paste one measurement per line: ${shape.hint}. Tabs, commas or two spaces all separate.`}
      onClose={() => { setProblem(null); onClose(); }}
      footer={<>
        <button className="btn" disabled={save.isPending || parsed.rows.length === 0 || parsed.bad.length > 0}
                onClick={() => { setProblem(null); save.mutate(); }}>
          {save.isPending ? 'Saving…' : `Record ${parsed.rows.length} measurement${parsed.rows.length === 1 ? '' : 's'}`}
        </button>
        <button className="btn ghost" onClick={() => { setProblem(null); onClose(); }}>Cancel</button>
      </>}
    >
      <Field label="Measurements">
        <textarea className="t mono" rows={9} value={text} spellCheck={false}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={study.type === 'homogeneity'
                    ? '4\t1\t99.609\n4\t2\t99.552\n21\t1\t99.473'
                    : study.type === 'stability'
                      ? '0\t99.711\n1\t99.377\n3\t99.609'
                      : 'L1\t99.769\nL2\t100.243\nL3\t99.405'} />
      </Field>

      <div className="grid2">
        <Field label="Unit"><input className="t mono" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
        <Field label="If measurements already exist">
          <label className="inline">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <span>Replace them — the discard is recorded in the ledger</span>
          </label>
        </Field>
      </div>

      {parsed.bad.length > 0 && (
        <div className="note deny">
          Line{parsed.bad.length > 1 ? 's' : ''} {parsed.bad.join(', ')} did not read as
          “{shape.hint}”. Nothing is sent until every line parses.
        </div>
      )}

      {parsed.rows.length > 0 && parsed.bad.length === 0 && (
        <div className="preview">
          <div className="lab">Understood {parsed.rows.length} measurements</div>
          <div className="scroll" style={{ maxHeight: 150 }}>
            <table>
              <thead><tr>{shape.cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {parsed.rows.slice(0, 6).map((row, i) => (
                  <tr key={i}>{shape.cols.map((c) => <td key={c} className="mono">{String(row[c])}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.rows.length > 6 && <div className="muted" style={{ fontSize: 12, padding: '6px 0 0' }}>
            …and {parsed.rows.length - 6} more</div>}
        </div>
      )}

      {problem && <div className="note deny">{problem.detail}</div>}
    </Dialog>
  );
}
