import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Me, type Project } from './lib/api';
import { visibleSurfaces, resolveRoute, type Viewer } from './lib/surfaces';
import { SignIn } from './pages/SignIn';
import { ChangePassword } from './pages/ChangePassword';
import { Access } from './pages/Access';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Audit } from './pages/Audit';
import { Capa } from './pages/Capa';
import { People } from './pages/People';
import { Configuration } from './pages/Configuration';
import { Operations } from './pages/Operations';
import { Conformance } from './pages/Conformance';
import { JobHealthBanner } from './components/JobHealthBanner';
import { Catalogue } from './pages/Catalogue';
import { Orders } from './pages/Orders';
import { Vault } from './pages/Vault';
import { Entitlements } from './pages/Entitlements';

export function App() {
  const qc = useQueryClient();
  const [requested, setRequested] = useState<string | null>(null);
  const [open, setOpen] = useState<Project | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

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

  const signOut = async () => {
    await api.post('/auth/sign-out');
    /**
     * A full reload, not a cache invalidation.
     *
     * Found while testing the password screens: the POST returned 200 and the
     * session really was revoked, but `qc.clear()` followed by
     * `invalidateQueries()` put no query back in flight, so the console went on
     * rendering the previous user's shell — their name in the corner, their
     * sections in the nav — until something happened to touch the network.
     * Nothing was exposed that the server would still answer, and it looked
     * exactly like everything that would be.
     *
     * Signing out is the one action where "no state from the previous user
     * survives" is the whole requirement, and a reload is the only way to
     * assert that about state React Query does not own.
     */
    window.location.assign('/');
  };

  const passwordChanged = (ended: number) => {
    setChangingPassword(false);
    setPasswordNotice(ended > 0
      ? `Password changed. ${ended} other session${ended === 1 ? '' : 's'} ended.`
      : 'Password changed.');
    // `me` carries passwordChangeRequired, so it must be refetched for the
    // shell to appear at all after a forced change.
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  /**
   * An account that still carries the password it was issued gets this screen
   * and nothing else.
   *
   * Placed ABOVE the surface resolution deliberately: every other route is
   * returning 403 to this session, so rendering the shell would produce a
   * navigation bar of sections that all fail, and a job-health banner whose
   * query is one of the things being refused.
   */
  if (me.data.passwordChangeRequired || changingPassword) {
    return (
      <ChangePassword
        required={me.data.passwordChangeRequired}
        name={me.data.user.name}
        onDone={passwordChanged}
        onCancel={me.data.passwordChangeRequired ? undefined : () => setChangingPassword(false)}
        onSignOut={me.data.passwordChangeRequired ? () => { void signOut(); } : undefined}
      />
    );
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
          <button className="btn ghost sm" onClick={() => setChangingPassword(true)}>
            Password
          </button>
          <button className="btn ghost sm" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main>
        {passwordNotice && (
          <div className="note okbox" style={{ marginBottom: 14 }}>
            {passwordNotice}{' '}
            <button className="btn ghost sm" onClick={() => setPasswordNotice(null)}>Dismiss</button>
          </div>
        )}
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
        ) : route === 'conformance' ? (
          <Conformance canExport={held.has('audit:export')} />
        ) : route === 'catalogue' || route === 'shop' ? (
          // One screen for both halves: the same material, different verbs.
          <Catalogue />
        ) : route === 'orders' || route === 'my-orders' ? (
          <Orders />
        ) : route === 'tiers' || route === 'my-tiers' ? (
          <Entitlements />
        ) : route === 'vault' ? (
          <Vault />
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
