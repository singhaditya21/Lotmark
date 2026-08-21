import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Project } from '../lib/api';
import { Dialog, Field, useFieldErrors } from './Dialog';

export function NewProject({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const qc = useQueryClient();
  const [materialName, setMaterial] = useState('');
  const [casNumber, setCas] = useState('');
  const [sku, setSku] = useState('');
  const [intakeQuantity, setIntake] = useState('');
  const [targetUncertainty, setTarget] = useState('');
  const [teamId, setTeam] = useState('');
  const [problem, setProblem] = useState<ApiError['problem'] | null>(null);

  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<{ teams: Array<{ id: string; key: string; name: string }> }>('/teams'),
    enabled: open,
  });

  const errors = useFieldErrors(problem);

  const create = useMutation({
    mutationFn: () => api.post<{ project: Project }>('/projects', {
      materialName,
      sku,
      ...(casNumber ? { casNumber } : {}),
      ...(intakeQuantity ? { intakeQuantity } : {}),
      ...(targetUncertainty ? { targetUncertainty } : {}),
      ...(teamId ? { teamId } : {}),
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      reset();
      onCreated(r.project);
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.problem : null),
  });

  const reset = () => {
    setMaterial(''); setCas(''); setSku(''); setIntake(''); setTarget('');
    setTeam(''); setProblem(null);
  };

  const list = teams.data?.teams ?? [];
  // Only default when there is no choice to make. Picking one silently would
  // file the work somewhere the user did not choose.
  const teamValue = teamId || (list.length === 1 ? list[0]!.id : '');

  return (
    <Dialog
      open={open}
      title="New project"
      lede="A project is one candidate reference material, from characterisation through to a released lot."
      onClose={() => { reset(); onClose(); }}
      footer={<>
        <button className="btn" disabled={create.isPending || !materialName || !sku}
                onClick={() => { setProblem(null); setTeam(teamValue); create.mutate(); }}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </button>
        <button className="btn ghost" onClick={() => { reset(); onClose(); }}>Cancel</button>
      </>}
    >
      <div className="grid2">
        <Field label="Material" error={errors.get('materialName')}>
          <input className="t" value={materialName} onChange={(e) => setMaterial(e.target.value)}
                 placeholder="Paracetamol" autoFocus />
        </Field>
        <Field label="CAS number" hint="optional" error={errors.get('casNumber')}>
          <input className="t mono" value={casNumber} onChange={(e) => setCas(e.target.value)}
                 placeholder="103-90-2" />
        </Field>
      </div>

      <Field label="SKU" hint="upper-case, used in the lot code" error={errors.get('sku')}>
        <input className="t mono" value={sku}
               onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="RM-PARA" />
      </Field>

      <div className="grid2">
        <Field label="Unit quantity" hint="optional" error={errors.get('intakeQuantity')}>
          <input className="t" value={intakeQuantity} onChange={(e) => setIntake(e.target.value)}
                 placeholder="50 mg" />
        </Field>
        <Field label="Target uncertainty" hint="optional" error={errors.get('targetUncertainty')}>
          <input className="t" value={targetUncertainty} onChange={(e) => setTarget(e.target.value)}
                 placeholder="0.5%" />
        </Field>
      </div>

      {list.length > 1 && (
        <Field label="Owning team" hint="decides who can see and act on this work">
          <select className="t" value={teamValue} onChange={(e) => setTeam(e.target.value)}>
            <option value="">Choose a team…</option>
            {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}

      {problem && !problem.errors && <div className="note deny">{problem.detail}</div>}
      {problem?.errors && <div className="note deny">{problem.detail}</div>}
    </Dialog>
  );
}
