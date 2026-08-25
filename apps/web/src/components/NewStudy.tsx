import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Dialog, Field, useFieldErrors } from './Dialog';

type StudyType = 'homogeneity' | 'stability' | 'characterisation' | 'confirmatory retest';

const TYPES: Array<[StudyType, string]> = [
  ['homogeneity', 'Homogeneity — between-unit variation, u(bb)'],
  ['stability', 'Stability — drift over shelf life, u(lts)'],
  ['characterisation', 'Characterisation — interlaboratory consensus, u(char) and the assigned value'],
  ['confirmatory retest', 'Confirmatory retest'],
];

export function NewStudy({
  open, projectId, onClose,
}: { open: boolean; projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [studyType, setType] = useState<StudyType>('homogeneity');
  const [equipmentIds, setEquipment] = useState<string[]>([]);
  const [shelfLifeTo, setShelf] = useState('');
  const [storageCondition, setStorage] = useState('');
  const [transportCondition, setTransport] = useState('');
  const [problem, setProblem] = useState<ApiError['problem'] | null>(null);

  const equipment = useQuery({
    queryKey: ['equipment'],
    queryFn: () => api.get<{ equipment: Array<{ id: string; code: string; name: string; calibrated_to: string | null }> }>('/equipment'),
    enabled: open,
  });

  const errors = useFieldErrors(problem);
  const needsShelf = studyType === 'stability';

  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/studies`, {
      studyType, equipmentIds,
      ...(shelfLifeTo ? { shelfLifeTo } : {}),
      ...(storageCondition ? { storageCondition } : {}),
      ...(transportCondition ? { transportCondition } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['studies', projectId] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      reset(); onClose();
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.problem : null),
  });

  const reset = () => {
    setType('homogeneity'); setEquipment([]); setShelf('');
    setStorage(''); setTransport(''); setProblem(null);
  };

  const toggle = (id: string) =>
    setEquipment((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog
      open={open}
      title="New study"
      lede="The study design decides what shape its measurements take, and which uncertainty component it contributes."
      onClose={() => { reset(); onClose(); }}
      footer={<>
        <button className="btn"
                disabled={create.isPending || equipmentIds.length === 0 || (needsShelf && !shelfLifeTo)}
                onClick={() => { setProblem(null); create.mutate(); }}>
          {create.isPending ? 'Creating…' : 'Create study'}
        </button>
        <button className="btn ghost" onClick={() => { reset(); onClose(); }}>Cancel</button>
      </>}
    >
      <Field label="Design" error={errors.get('studyType')}>
        <select className="t" value={studyType} onChange={(e) => setType(e.target.value as StudyType)}>
          {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>

      <Field label="Equipment used"
             hint="drives the calibration impact trace"
             error={errors.get('equipmentIds')}>
        <div className="picker">
          {(equipment.data?.equipment ?? []).map((e) => {
            const lapsed = e.calibrated_to !== null && e.calibrated_to < today;
            return (
              <label key={e.id} className={`pick ${equipmentIds.includes(e.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={equipmentIds.includes(e.id)} onChange={() => toggle(e.id)} />
                <span className="mono">{e.code}</span>
                <span>{e.name}</span>
                {/* Surfaced, not blocked: using lapsed equipment is sometimes
                    unavoidable, and the impact trace is what makes it visible. */}
                {lapsed && <span className="chip warn">calibration lapsed</span>}
              </label>
            );
          })}
        </div>
      </Field>

      {needsShelf && (
        <>
          <Field label="Shelf life to" hint="u(lts) is projected across this period"
                 error={errors.get('shelfLifeTo')}>
            <input className="t mono" type="date" value={shelfLifeTo} onChange={(e) => setShelf(e.target.value)} />
          </Field>
          <div className="grid2">
            <Field label="Storage condition" hint="decides the lot's cold chain">
              <input className="t" value={storageCondition} onChange={(e) => setStorage(e.target.value)}
                     placeholder="2–8 °C" />
            </Field>
            <Field label="Transport condition">
              <input className="t" value={transportCondition} onChange={(e) => setTransport(e.target.value)}
                     placeholder="Chilled 72 h" />
            </Field>
          </div>
        </>
      )}

      {problem && <div className="note deny" role="alert">{problem.detail}</div>}
    </Dialog>
  );
}
