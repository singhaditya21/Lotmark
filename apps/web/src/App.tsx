import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Me, type Project } from './lib/api';
import { visibleSurfaces, resolveRoute, type Viewer } from './lib/surfaces';
import { SignIn } from './pages/SignIn';
import { Access } from './pages/Access';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Audit } from './pages/Audit';
import { Capa } from './pages/Capa';
import { People } from './pages/People';
import { Configuration } from './pages/Configuration';
import { Operations } from './pages/Operations';
import { JobHealthBanner } from './components/JobHealthBanner';

export function App() {
  const qc = useQueryClient();
  const [requested, setRequested] = useState<string | null>(null);
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
   * The union across tenant-wide and every team grant, used ONLY to decide what
   * to show. Every act is re-checked server-side; hiding a control is a
   * courtesy to the user, never a security control.
   */
  const held = new Set([
    ...me.data.permissions,
    ...Object.values(me.data.permissionsByTeam).flat(),
  ]);

  const viewer: Viewer = { held, roleKinds: me.data.roleKinds };
  const sections = visibleSurfaces(viewer);
  const route = resolveRoute(viewer, requested);

  const signOut = async () => {
    await api.post('/auth/sign-out');
    qc.clear();
    await qc.invalidateQueries();
  };

  const go = (id: string) => { setRequested(id); setOpen(null); };

  return (
    <>
      <header className="top">
        <span className="brand">Lotmark</span>
        <nav aria-label="Sections">
          {/* Driven by the surface table, so adding a section is one row there
              rather than a button here and a branch below that can disagree. */}
          {sections.map((s) => (
            <button key={s.id} aria-current={route === s.id ? 'page' : 'false'}
                    onClick={() => go(s.id)}>
              {s.label}
            </button>
          ))}
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
        {/*
          One banner slot, above everything. A failing overnight job is only
          discovered by somebody who opens Operations, and nobody opens it on a
          normal day. Shown only to people who could act on it.
        */}
        {sections.some((s) => s.id === 'operations') && (
          <JobHealthBanner onOpen={() => go('operations')} />
        )}

        {/*
          `route === null` is a real outcome, not an error: this person holds no
          section. It gets an explanation rather than a blank page or — as
          before — an empty Projects table that looked like lost data.
        */}
        {route === null ? (
          <Access viewer={viewer} name={me.data.user.name} organisation={me.data.organisation} />
        ) : route === 'audit' ? (
          <Audit canVerify={held.has('audit:verify')} />
        ) : route === 'capa' ? (
          <Capa canManage={held.has('capa:manage')} />
        ) : route === 'people' ? (
          <People />
        ) : route === 'configuration' ? (
          <Configuration />
        ) : route === 'operations' ? (
          <Operations />
        ) : open ? (
          <ProjectDetail project={open} onBack={() => setOpen(null)}
                         canReissue={held.has('cert:reissue')} />
        ) : (
          <Projects onOpen={setOpen} canCreate={held.has('project:manage')} />
        )}
      </main>
    </>
  );
}
