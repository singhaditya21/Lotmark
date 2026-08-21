import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Me, type Project } from './lib/api';
import { SignIn } from './pages/SignIn';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Audit } from './pages/Audit';
import { Capa } from './pages/Capa';

type Route = 'projects' | 'capa' | 'audit';

export function App() {
  const qc = useQueryClient();
  const [route, setRoute] = useState<Route>('projects');
  const [open, setOpen] = useState<Project | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    retry: false,
  });

  if (me.isLoading) return <div className="spinner">Loading…</div>;

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  if (unauthenticated || !me.data) {
    return <SignIn onSignedIn={() => { void qc.invalidateQueries(); }} />;
  }

  /**
   * Permission-aware navigation.
   *
   * The union across tenant-wide and every team grant, used ONLY to decide what
   * to show. Every act is re-checked server-side; hiding a button is a courtesy
   * to the user, never a security control.
   */
  const held = new Set([
    ...me.data.permissions,
    ...Object.values(me.data.permissionsByTeam).flat(),
  ]);

  const signOut = async () => {
    await api.post('/auth/sign-out');
    qc.clear();
    await qc.invalidateQueries();
  };

  return (
    <>
      <header className="top">
        <span className="brand">Lotmark</span>
        <nav aria-label="Sections">
          <button aria-current={route === 'projects' ? 'page' : 'false'}
                  onClick={() => { setRoute('projects'); setOpen(null); }}>
            Projects
          </button>
          {held.has('capa:manage') && (
            <button aria-current={route === 'capa' ? 'page' : 'false'}
                    onClick={() => { setRoute('capa'); setOpen(null); }}>
              Complaints &amp; CAPA
            </button>
          )}
          {held.has('audit:read') && (
            <button aria-current={route === 'audit' ? 'page' : 'false'}
                    onClick={() => { setRoute('audit'); setOpen(null); }}>
              Audit ledger
            </button>
          )}
        </nav>
        <div className="who">
          <span className="muted">
            {me.data.user.name}
            {me.data.teams.length > 0 && (
              <span> · {me.data.teams.map((t) => t.name).join(', ')}</span>
            )}
          </span>
          <button className="btn ghost sm" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main>
        {route === 'audit' ? (
          <Audit canVerify={held.has('audit:verify')} />
        ) : route === 'capa' ? (
          <Capa canManage={held.has('capa:manage')} />
        ) : open ? (
          <ProjectDetail project={open} onBack={() => setOpen(null)} />
        ) : (
          <Projects onOpen={setOpen} canCreate={held.has('project:manage')} />
        )}
      </main>
    </>
  );
}
