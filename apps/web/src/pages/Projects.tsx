import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Project } from '../lib/api';
import { NewProject } from '../components/NewProject';

export function Projects({ onOpen, canCreate }: { onOpen: (p: Project) => void; canCreate: boolean }) {
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[]; scope: string }>('/projects'),
  });

  if (isLoading) return <div className="spinner">Loading projects…</div>;
  if (error) return <div className="note deny" role="alert">{(error as Error).message}</div>;

  const projects = data?.projects ?? [];

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h1>Projects</h1>
        {canCreate && <button className="btn" onClick={() => setCreating(true)}>New project</button>}
      </div>
      <p className="lede">
        {data?.scope === 'tenant'
          ? 'You hold visibility across the whole tenant.'
          : data?.scope === 'teams'
            ? 'Filtered to the teams in which you hold permission to read projects.'
            : 'Your role holds no project visibility.'}
      </p>

      {projects.length === 0 ? (
        <div className="card empty">
          {canCreate ? (
            <>
              <b>No projects yet</b>
              Start one, and the studies, values and lots follow from it.
              <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                <button className="btn" onClick={() => setCreating(true)}>New project</button>
              </div>
            </>
          ) : (
            <>
              <b>Nothing to show you</b>
              This is a correct answer, not an error — your role grants no
              project access in any team.
            </>
          )}
        </div>
      ) : (
        <div className="card scroll">
          <table>
            <thead>
              <tr><th>Code</th><th>Material</th><th>CAS</th><th>Stage</th><th>Team</th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                // The project row is the sole entry into the whole release
                // chain, so it must open from the keyboard, not the mouse alone.
                <tr key={p.id} className="click" onClick={() => onOpen(p)}
                    role="button" tabIndex={0}
                    aria-label={`Open project ${p.code} — ${p.material}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p); }
                    }}>
                  <td className="mono">{p.code}</td>
                  <td><b>{p.material}</b></td>
                  <td className="mono muted">{p.cas ?? '—'}</td>
                  <td><span className={`chip ${p.stage === 'released' ? 'ok' : 'grey'}`}>{p.stage}</span></td>
                  <td className="muted">{p.team ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewProject open={creating} onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); onOpen(p); }} />
    </>
  );
}
