import { useEffect, useState } from 'react';

/**
 * A guided tour — a teleprompter for the demo, not a puppeteer of it.
 *
 * It drives the one thing it can drive reliably: which SCREEN is showing. For
 * each stop it navigates there and shows a caption saying what to point out and
 * what to click. It does NOT click the buttons itself — signing, exporting,
 * verifying are the moments worth filming, and a recording of software clicking
 * its own buttons is a recording of nothing. The presenter performs; this keeps
 * them on script and on the right screen.
 *
 * Demo only. It reaches nothing in the product build.
 */

interface Stop {
  readonly screen: string;
  readonly title: string;
  readonly caption: string;
}

const STOPS: readonly Stop[] = [
  {
    screen: 'projects',
    title: 'The producer\'s console',
    caption: 'Every reference material is a project. Open one to see its '
      + 'uncertainty budget — computed from the raw measurements each time it is '
      + 'asked for, never stored as a summary.',
  },
  {
    screen: 'conformance',
    title: 'Conformance register',
    caption: 'Each regulatory clause, what the system enforces, and where the '
      + 'records and the claims disagree — that gap is the finding. '
      + 'Export the assessment pack: 29 requirements, signed and digested.',
  },
  {
    screen: 'audit',
    title: 'Tamper-evident ledger',
    caption: 'Every act is appended and hash-chained to the one before it under '
      + 'a key held outside the database. Click "Verify the chain" — altering one '
      + 'entry breaks every link that follows.',
  },
  {
    screen: 'flows',
    title: 'Workflow designer',
    caption: 'Who may make each move through a workflow is configuration, not '
      + 'code — designed in a draft and taking effect only when that draft is '
      + 'published under signature.',
  },
  {
    screen: 'forms',
    title: 'Form designer',
    caption: 'Add a field to any record — a lot, a CAPA — without touching code. '
      + 'It appears on the record and is versioned like every other change.',
  },
  {
    screen: 'operations',
    title: 'The system watching itself',
    caption: 'Scheduled jobs, operational alerts, and disaster-recovery drills. '
      + 'A recovery that has not been rehearsed is not a recovery, and this says '
      + 'so.',
  },
];

export function DemoTour({ onGoTo, onClose }: {
  onGoTo: (screen: string) => void;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const stop = STOPS[i]!;
  const first = i === 0;
  const last = i === STOPS.length - 1;

  // Navigate to this stop's screen whenever the step changes.
  useEffect(() => { onGoTo(stop.screen); }, [i, stop.screen, onGoTo]);

  // Arrow keys and Escape, so the presenter never has to find the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && !last) setI((n) => n + 1);
      else if (e.key === 'ArrowLeft' && !first) setI((n) => n - 1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [first, last, onClose]);

  return (
    <div
      role="dialog"
      aria-label="Guided tour"
      style={{
        position: 'fixed', left: '50%', transform: 'translateX(-50%)',
        bottom: 56, zIndex: 60, width: 'min(560px, calc(100vw - 32px))',
        font: '14px/1.55 ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <div style={{
        background: 'color-mix(in oklab, Canvas 90%, CanvasText 10%)',
        color: 'CanvasText',
        border: '1px solid color-mix(in oklab, CanvasText 18%, Canvas 82%)',
        borderRadius: 12, padding: '14px 16px',
        boxShadow: '0 8px 30px rgb(0 0 0 / 0.22)',
        backdropFilter: 'blur(8px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <strong style={{ fontSize: 15 }}>{stop.title}</strong>
          <span style={{ fontSize: 12, opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>
            {i + 1} / {STOPS.length}
          </span>
        </div>
        <p style={{ margin: '6px 0 12px', opacity: 0.9 }}>{stop.caption}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" onClick={onClose} style={ghost}>Skip tour</button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => setI((n) => n - 1)} disabled={first} style={ghost}>
            Back
          </button>
          {last ? (
            <button type="button" onClick={onClose} style={primary}>Done</button>
          ) : (
            <button type="button" onClick={() => setI((n) => n + 1)} style={primary}>Next →</button>
          )}
        </div>
      </div>
    </div>
  );
}

const ghost: React.CSSProperties = {
  font: 'inherit', cursor: 'pointer', padding: '5px 10px', borderRadius: 7,
  background: 'transparent', color: 'inherit',
  border: '1px solid color-mix(in oklab, CanvasText 20%, Canvas 80%)',
};

const primary: React.CSSProperties = {
  font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: '5px 12px',
  borderRadius: 7, border: 'none',
  background: 'color-mix(in oklab, CanvasText 82%, Canvas 18%)',
  color: 'Canvas',
};
