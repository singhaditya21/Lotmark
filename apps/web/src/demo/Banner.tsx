import { useEffect } from 'react';
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
      </div>
    </div>
  );
}
