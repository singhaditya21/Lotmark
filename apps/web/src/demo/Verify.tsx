import { useState } from 'react';
import fixture from './fixture.json';
import { rebase, deltaFrom } from './rebase';

/**
 * The public certificate verification page, for the demo.
 *
 * In the real product this is server-rendered HTML with no JavaScript and no
 * account (apps/api/src/routes/public.ts) — a printed certificate has to be
 * checkable in ten years, by an auditor who has never heard of this console.
 * The static demo has no server, so when a viewer follows the vault's "check"
 * link the 404 fallback loads the app at `/verify/<token>` and this renders in
 * the console's place. It mirrors the real page's content and verdicts so the
 * feature can be filmed: hold a certificate, check it, no login, no account.
 *
 * The verdict and facts come from `__verify`, the token → facts map the capture
 * built. The link is a full-page navigation, and the demo saves nothing across
 * one — a reload is a fresh start, as the banner says — so this shows the
 * certificate's captured status rather than anything a console session changed.
 */

type Fact = { status: string } & Record<string, unknown>;

const bodies = fixture as unknown as Record<string, { body?: unknown }>;

/** Resolve a token to its captured facts, dates shifted forward like everything else. */
function lookup(token: string): Fact | null {
  const map = bodies['__verify']?.body as Record<string, unknown> | undefined;
  const raw = map?.[token];
  if (!raw) return null;
  return rebase(raw, deltaFrom(bodies['__capturedAt']?.body)) as Fact;
}

const VERDICT: Record<string, { head: string; note: string; tone: string }> = {
  current: {
    head: 'Current',
    note: 'This is the latest issue of this certificate and it has not been withdrawn.',
    tone: 'ok',
  },
  withdrawn: {
    head: 'WITHDRAWN — do not rely on this certificate',
    note: 'The producer has withdrawn this issue. Obtain a corrected certificate before use.',
    tone: 'bad',
  },
  superseded: {
    head: 'Superseded',
    note: 'A later issue of this certificate exists. Obtain it from the producer before relying on these values.',
    tone: 'warn',
  },
  unknown: {
    head: 'No such certificate',
    note: 'This code does not match any certificate we have issued. Check the link, or contact the producer.',
    tone: 'bad',
  },
};

const fmt = (v: unknown) => (typeof v === 'number' ? String(v) : String(v ?? '—'));
const dateOnly = (v: unknown) => String(v ?? '').slice(0, 10) || '—';

/**
 * The bare `/verify` landing: type a certificate code, look it up.
 *
 * How a person actually verifies without a link — reading the code off the
 * paper and typing it. Resolves the code to its token and navigates, so the
 * result page is the same one the vault's "check" link reaches.
 */
export function VerifyLanding() {
  const [code, setCode] = useState('');
  const [notFound, setNotFound] = useState(false);
  const base = import.meta.env.BASE_URL;

  const check = () => {
    const token = tokenForCode(code);
    if (token) window.location.assign(`${base}verify/${token}`);
    else setNotFound(true);
  };

  return (
    <Shell>
      <p style={{ margin: 0, opacity: 0.85 }}>
        Enter the certificate code printed on the document — for example{' '}
        <code style={codeStyle}>CRT-2041</code> — to check whether it is current.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); check(); }}
        style={{ display: 'flex', gap: 8, marginTop: 4 }}
      >
        <input
          value={code} autoFocus placeholder="CRT-2041"
          onChange={(e) => { setCode(e.target.value); setNotFound(false); }}
          style={{
            flex: 1, font: 'inherit', padding: '8px 10px', borderRadius: 8,
            background: 'color-mix(in oklab, CanvasText 8%, Canvas 92%)',
            border: '1px solid color-mix(in oklab, CanvasText 22%, Canvas 78%)',
            color: 'inherit',
          }}
        />
        <button type="submit" style={primaryStyle}>Check</button>
      </form>
      {notFound && (
        <p style={{ margin: 0, color: '#c46', fontSize: 13 }}>
          No certificate with that code. Try <code style={codeStyle}>CRT-2041</code>.
        </p>
      )}
      <a href={base} style={linkStyle}>← Back to the demo</a>
    </Shell>
  );
}

export function DemoVerify({ token }: { token: string }) {
  const v = lookup(token);
  const status = v?.status ?? 'unknown';
  const base = VERDICT[status] ?? VERDICT['unknown']!;
  // A withdrawn certificate says WHY, when the producer recorded a reason.
  const reason = typeof v?.['withdrawnReason'] === 'string' ? v['withdrawnReason'] as string : '';
  const verdict = status === 'withdrawn' && reason
    ? { ...base, note: reason } : base;

  const rows: Array<[string, string]> = v ? [
    ['Certificate', `${fmt(v['certificateCode'])} · issue #${fmt(v['issueNumber'])}`],
    ['Material', fmt(v['materialName'])],
    ['Lot', fmt(v['lotCode'])],
    [fmt(v['propertyName']),
      `${fmt(v['assignedValue'])} ± ${fmt(v['expandedUncertainty'])} ${fmt(v['unit'])} `
      + `(k = ${fmt(v['coverageFactor'])})`],
    ['Expiry', dateOnly(v['expiryDate'])],
    ['Issued', dateOnly(v['issuedAt'])],
    ['Producer', fmt(v['producerName'])],
  ] : [];

  /*
   * Hand the record over as a file (D12). The real product hands over a signed
   * PDF, which a static demo cannot render; this saves the same facts as JSON,
   * so a viewer can open and inspect what leaves the page.
   */
  const download = () => {
    if (!v) return;
    const blob = new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fmt(v['certificateCode'])}-verification.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Shell>
      <div style={{
        borderRadius: 10, padding: '14px 16px',
        border: `1px solid ${verdict.tone === 'ok' ? '#2f7d4f'
          : verdict.tone === 'warn' ? '#8a6d1f' : '#8a2f2f'}`,
        background: verdict.tone === 'ok' ? 'rgba(47,125,79,0.14)'
          : verdict.tone === 'warn' ? 'rgba(138,109,31,0.14)' : 'rgba(138,47,47,0.16)',
      }}>
        <div style={{ fontWeight: 600 }}>{verdict.head}</div>
        <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>{verdict.note}</div>
      </div>

      {rows.length > 0 && (
        <dl style={{
          display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 20px',
          margin: 0, padding: '4px 2px',
        }}>
          {rows.map(([k, val]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ opacity: 0.6, fontSize: 13 }}>{k}</dt>
              <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{val}</dd>
            </div>
          ))}
        </dl>
      )}

      <p style={{ fontSize: 12, opacity: 0.55, margin: 0 }}>
        Everything shown here is already printed on the certificate you are holding.
        No account is required to check it.
      </p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <a href={import.meta.env.BASE_URL} style={linkStyle}>← Back to the demo</a>
        {v && (
          <button type="button" onClick={download} style={{ ...linkStyle, cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>
            Download this record
          </button>
        )}
      </div>
    </Shell>
  );
}

/* ── The shared frame and a few styles, so the landing and the result match ── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', padding: '48px 16px',
      font: '15px/1.5 ui-sans-serif, system-ui, sans-serif',
      background: 'var(--bg, #0c0e10)', color: 'var(--ink, #e9e7e2)',
    }}>
      <div style={{ width: 'min(560px, 100%)', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 18, letterSpacing: '-0.01em' }}>Certificate verification</strong>
          <span style={{ fontSize: 12, opacity: 0.6 }}>Meridian Reference Materials</span>
        </div>
        {children}
      </div>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  fontSize: 13, color: 'var(--accent, #6ea8fe)', textDecoration: 'none',
};
const codeStyle: React.CSSProperties = {
  font: '600 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
  padding: '2px 5px', borderRadius: 4,
  background: 'color-mix(in oklab, CanvasText 10%, Canvas 90%)',
};
const primaryStyle: React.CSSProperties = {
  font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: '8px 14px',
  borderRadius: 8, border: 'none',
  background: 'color-mix(in oklab, CanvasText 82%, Canvas 18%)', color: 'Canvas',
};

/** The token in `/verify/<token>`, or null when this is not a verify URL. */
/**
 * Whether this is a verification URL at all — with a token, or the bare
 * `/verify` landing where a code is typed in.
 */
export function isVerifyPath(): boolean {
  return /\/verify(\/|$)/.test(window.location.pathname);
}

/** The token in `/verify/<token>`, or null on the bare `/verify` landing. */
export function verifyTokenFromPath(): string | null {
  const m = /\/verify\/([^/?#]+)/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Resolve a certificate code a person typed to the token behind it.
 *
 * A holder reads a code off a printed certificate — CRT-2041 — not the opaque
 * token in the link. The map is keyed by token, so this scans it for a matching
 * code. Case-insensitive, because nobody types a certificate code the way it is
 * stored.
 */
export function tokenForCode(code: string): string | null {
  const wanted = code.trim().toUpperCase();
  const map = bodies['__verify']?.body as Record<string, Record<string, unknown>> | undefined;
  for (const [token, facts] of Object.entries(map ?? {})) {
    if (String(facts['certificateCode']).toUpperCase() === wanted) return token;
  }
  return null;
}
