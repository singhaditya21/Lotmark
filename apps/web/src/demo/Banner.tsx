import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEMO_PASSWORD } from './constants';

/**
 * The one thing on screen that is not the product.
 *
 * It has to say three things — this is a demonstration, the data is invented,
 * and here is how to get in — without becoming the subject of the recording.
 * So: a single line, pinned to the bottom, out of the way of the navigation at
 * the top and of every dialog, and quiet enough that a viewer stops seeing it
 * after ten seconds. `pointer-events: none` so it can never intercept a click
 * during a take.
 */
export function DemoBanner() {
  /*
   * Reserve the space the bar occupies.
   *
   * `position: fixed` takes the bar out of flow, so on a short page it sat on
   * top of the last table row — measured on the live site, covering a project.
   * A viewer scrolling to the bottom of any list would find the final row
   * permanently half-hidden, which on camera reads as a rendering bug in the
   * product rather than as the demo furniture it is.
   */
  useEffect(() => {
    const previous = document.body.style.paddingBottom;
    document.body.style.paddingBottom = '68px';
    return () => { document.body.style.paddingBottom = previous; };
  }, []);

  return (
    <div
      role="note"
      style={{
        position: 'fixed', insetInline: 0, bottom: 0, zIndex: 40,
        display: 'flex', justifyContent: 'center', pointerEvents: 'none',
        padding: '0 0 10px',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '6px 14px', borderRadius: 999,
          font: '500 12px/1.4 ui-sans-serif, system-ui, sans-serif',
          letterSpacing: '0.01em',
          background: 'color-mix(in oklab, Canvas 86%, CanvasText 14%)',
          color: 'color-mix(in oklab, CanvasText 78%, Canvas 22%)',
          border: '1px solid color-mix(in oklab, CanvasText 16%, Canvas 84%)',
          boxShadow: '0 1px 3px rgb(0 0 0 / 0.10), 0 6px 20px rgb(0 0 0 / 0.06)',
          backdropFilter: 'blur(6px)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6, height: 6, borderRadius: 999, flex: 'none',
            background: 'color-mix(in oklab, CanvasText 45%, Canvas 55%)',
          }}
        />
        <span>Demonstration — every record is invented and nothing is saved.</span>
        <span style={{ opacity: 0.55 }}>·</span>
        <span>
          Sign in with any listed account, password{' '}
          <code
            style={{
              font: '600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
              padding: '2px 5px', borderRadius: 4,
              background: 'color-mix(in oklab, CanvasText 10%, Canvas 90%)',
            }}
          >
            {DEMO_PASSWORD}
          </code>
          , then any six digits.
        </span>
        <span style={{ opacity: 0.55 }}>·</span>
        <button type="button" onClick={() => window.dispatchEvent(new Event('demo:start-tour'))}
          style={linkButton}>Guided tour</button>
        <span style={{ opacity: 0.55 }}>·</span>
        <TenantButton />
        <span style={{ opacity: 0.55 }}>·</span>
        <ResetButton />
      </div>
    </div>
  );
}

/**
 * Start over without signing in again.
 *
 * A re-take control: unwind everything done this session to the recorded
 * starting point, while staying signed in on the current screen. `resetData()`
 * rebuilds the adapter's copy of the fixture; clearing the query cache makes
 * every screen refetch from it, so the change is visible immediately without a
 * page reload — which would drop the session and the current screen.
 */
const linkButton: React.CSSProperties = {
  pointerEvents: 'auto', cursor: 'pointer', font: 'inherit', color: 'inherit',
  background: 'transparent', border: 'none', padding: 0,
  textDecoration: 'underline', textUnderlineOffset: 2, opacity: 0.85,
};

function ResetButton() {
  const qc = useQueryClient();
  /*
   * Imported lazily, in the handler, NOT at the top of this file.
   *
   * The adapter runs `hydrate()` when it loads — a module side effect Rollup
   * will not tree-shake — so a static import here would drag the adapter and
   * the whole fixture into the NORMAL build, where the banner never renders.
   * Measured: it did exactly that. A dynamic import keeps the dependency inside
   * the demo, where it belongs.
   */
  const reset = async () => {
    const { resetData } = await import('./adapter');
    resetData();
    void qc.resetQueries();
  };
  return (
    <button
      type="button"
      onClick={reset}
      style={linkButton}
    >
      Reset
    </button>
  );
}

/**
 * Switch producer tenants, to show the isolation between two labs on one
 * platform. Lazy-imports the adapter for the same reason ResetButton does.
 */
function TenantButton() {
  const qc = useQueryClient();
  const [other, setOther] = useState('Aurora Standards Ltd');
  const switchTo = async () => {
    const { switchTenant, tenantName } = await import('./adapter');
    switchTenant();
    await qc.resetQueries();
    // Show the name of the tenant you can switch BACK to.
    const nowShowing = tenantName();
    setOther(nowShowing === 'Aurora Standards Ltd'
      ? 'Meridian Reference Materials' : 'Aurora Standards Ltd');
  };
  return (
    <button type="button" onClick={switchTo} style={linkButton}>
      Switch to {other}
    </button>
  );
}
