import { useQuery } from '@tanstack/react-query';
import { api, type Project } from '../lib/api';

export function Projects({ onOpen }: { onOpen: (p: Project) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: Project[]; scope: string }>('/projects'),
  });

  if (isLoading) return <div className="spinner">Loading projects…</div>;
  if (error) return <div className="note deny">{(error as Error).message}</div>;

  const projects = data?.projects ?? [];

  return (
    <>
      <h1>Projects</h1>
      <p className="lede">
        {data?.scope === 'tenant'
          ? 'You hold visibility across the whole tenant.'
          : data?.scope === 'teams'
            ? 'Filtered to the teams in which you hold permission to read projects.'
            : 'Your role holds no project visibility.'}
      </p>

      {projects.length === 0 ? (
        <div className="card pad">
          <p className="muted" style={{ margin: 0 }}>
            No projects are visible to you. This is a correct answer, not an
            error — your role grants no project access in any team.
          </p>
        </div>
      ) : (
        <div className="card scroll">
          <table>
            <thead>
              <tr><th>Code</th><th>Material</th><th>CAS</th><th>Stage</th><th>Team</th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="click" onClick={() => onOpen(p)}>
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
    </>
  );
}
