import { useState, useEffect } from 'react';
import { DemoTour } from './demo/Tour';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Me, type Project, type HomeView, type SearchIndex, type SearchItem } from './lib/api';
import { visibleSurfaces, resolveRoute, type Viewer } from './lib/surfaces';
import { SignIn } from './pages/SignIn';
import { ChangePassword } from './pages/ChangePassword';
import { Access } from './pages/Access';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Home } from './pages/Home';
import { CommandPalette } from './components/CommandPalette';
import { Audit } from './pages/Audit';
import { Capa } from './pages/Capa';
import { People } from './pages/People';
import { Configuration } from './pages/Configuration';
import { FormDesigner } from './pages/FormDesigner';
import { FlowDesigner } from './pages/FlowDesigner';
import { Operations } from './pages/Operations';
import { Conformance } from './pages/Conformance';
import { JobHealthBanner } from './components/JobHealthBanner';
import { Catalogue } from './pages/Catalogue';
import { Orders } from './pages/Orders';
import { Vault } from './pages/Vault';
import { Entitlements } from './pages/Entitlements';

export function App() {
  const qc = useQueryClient();
  /*
   * A deep-link entry point, demo only: `?screen=conformance` starts the app on
   * that surface, so a recording can begin already on the right screen instead
   * of clicking there in every take. The id is a surface id (see surfaces.ts);
   * an unknown one resolves to the default, so a stale link is harmless.
   */
  const [requested, setRequested] = useState<string | null>(
    import.meta.env.VITE_DEMO
      ? new URLSearchParams(window.location.search).get('screen')
      : null,
  );
  const [open, setOpen] = useState<Project | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  /*
   * The command palette (⌘K / Ctrl-K). The listener is top-level so the hook
   * order never changes; the palette itself only renders once signed in.
   */
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * The guided tour. Demo only, and folded away entirely in the product build:
   * the state seeds false there, the listener never registers, and the render
   * is behind a folded constant so Rollup drops the import. Declared here, above
   * every early return, so the hook order never changes between renders —
   * placing it lower tripped React error #310 the first time. Started by the
   * demo bar's "Tour" button (a window event, so the bar need not reach into
   * this component) or by ?tour=1.
   */
  const [tour, setTour] = useState(import.meta.env.VITE_DEMO
    && new URLSearchParams(window.location.search).get('tour') === '1');
  useEffect(() => {
    if (!import.meta.env.VITE_DEMO) return;
    const start = () => setTour(true);
    window.addEventListener('demo:start-tour', start);
    return () => window.removeEventListener('demo:start-tour', start);
  }, []);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    retry: false,
  });

  /*
   * The home summary, fetched once here so the nav badge and the Home page share
   * one request (react-query dedupes on the key). Enabled only once signed in —
   * a producer lands on Home, and the badge is how a pending count reaches every
   * other screen without opening Home.
   */
  const home = useQuery({
    queryKey: ['home'],
    queryFn: () => api.get<HomeView>('/home'),
    enabled: !!me.data,
    retry: false,
  });

  // The jump-to-code index, fetched once the palette is first opened (and then
  // cached) — no need to pull it for a session that never presses ⌘K.
  const search = useQuery({
    queryKey: ['search'],
    queryFn: () => api.get<SearchIndex>('/search'),
    enabled: !!me.data && palette,
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
    /*
     * BASE_URL, not '/'. The demo is served from a repository subpath, so a
     * bare '/' sends the viewer to the domain root — which is not this
     * application and, on GitHub Pages, is somebody else's 404. Vite injects
     * '/' for a normal build, so this is identical there.
     */
    window.location.assign(import.meta.env.BASE_URL);
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

  // Selecting a code: open its project if it has one (a lot, study, value or
  // certificate lives inside its project detail), otherwise land on its surface.
  const jump = (item: SearchItem) => {
    setPalette(false);
    if (item.project) { setOpen(item.project); setRequested('projects'); }
    else { setOpen(null); setRequested(item.surface); }
  };

  return (
    <>
      {/* Keyboard users reach content without tabbing the whole section nav. */}
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <span className="brand">Lotmark</span>
        <nav aria-label="Sections">
          {/* Driven by the surface table, so adding a section is one row there
              rather than a button here and a branch below that can disagree. */}
          {sections.map((s) => (
            <button key={s.id} aria-current={route === s.id ? 'page' : 'false'}
                    onClick={() => go(s.id)}>
              {s.label}
              {s.id === 'home' && (home.data?.attention.length ?? 0) > 0 && (
                <span className="badge" aria-label={`${home.data!.attention.length} waiting`}>
                  {home.data!.attention.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="who">
          <button className="cmdk-open" onClick={() => setPalette(true)} aria-label="Jump to a record">
            Jump to…<span className="kbd">⌘K</span>
          </button>
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

      <main id="main" tabIndex={-1}>
        {passwordNotice && (
          <div className="note okbox" style={{ marginBottom: 14 }} aria-live="polite">
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
        ) : route === 'home' ? (
          <Home name={me.data.user.name} onGo={go} />
        ) : route === 'audit' ? (
          <Audit canVerify={held.has('audit:verify')} />
        ) : route === 'capa' ? (
          <Capa canManage={held.has('capa:manage')} />
        ) : route === 'people' ? (
          <People />
        ) : route === 'configuration' ? (
          <Configuration />
        ) : route === 'forms' ? (
          <FormDesigner />
        ) : route === 'flows' ? (
          <FlowDesigner />
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
                         canReissue={held.has('cert:reissue')}
                         canRelease={held.has('lot:release')}
                         canRecordLotFields={held.has('lot:create')} />
        ) : (
          <Projects onOpen={setOpen} canCreate={held.has('project:manage')} />
        )}
      </main>
      <CommandPalette
        open={palette}
        items={search.data?.items ?? []}
        onClose={() => setPalette(false)}
        onSelect={jump}
      />
      {import.meta.env.VITE_DEMO && tour
        ? <DemoTour onGoTo={go} onClose={() => setTour(false)} /> : null}
    </>
  );
}
