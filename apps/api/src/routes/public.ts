import type { FastifyInstance } from 'fastify';
import { inTenantTransaction } from '../db';
import { tenantFlags, flagEnabled } from '../services/flags';

/**
 * Public certificate verification.
 *
 * No session, no JavaScript, no account. A customer's auditor holding a printed
 * certificate must be able to check it, and requiring them to register with the
 * producer whose certificate is in question defeats the purpose.
 *
 * Server-rendered HTML rather than a client app for the same reason a
 * certificate is a PDF: it has to work in ten years, on whatever browser the
 * auditor has, behind whatever proxy their organisation runs.
 *
 * Everything returned is already printed on the certificate the caller is
 * holding. No customer, no order, no holder, no internal identifier — the
 * lookup runs through a SECURITY DEFINER function whose projection is the
 * access control.
 */
export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  interface Verification {
    certificate_code: string; lot_code: string; issue_number: number;
    property_name: string; assigned_value: number; expanded_uncertainty: number;
    coverage_factor: number; unit: string; issued_at: string;
    withdrawn: boolean; withdrawn_reason: string | null;
    material_name: string; expiry_date: string; producer_name: string;
    document_sha256: string | null; document_signature: string | null;
    document_key_version: string | null; superseded_by: number | null;
  }

  app.get<{ Params: { token: string } }>('/verify/:token', async (req, reply) => {
    // Bound before it reaches the database: a token is fixed-shape, and an
    // unbounded parameter on an unauthenticated route is a free denial-of-service.
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      return reply.code(404).type('text/html; charset=utf-8').send(page(null, null));
    }

    /**
     * A producer may switch public verification off.
     *
     * Answered as 404 rather than 403, and the same 404 an unknown token gets:
     * whether a producer offers public verification at all is not something an
     * unauthenticated caller should be able to probe, and a distinct status
     * would tell them.
     *
     * The tenant comes from `resolve_tenant(NULL)`, which is what every
     * unauthenticated path in this codebase currently does — sign-in included.
     * It is the single-tenant bootstrap, and it is one of the things the
     * request-level tenant identity decision will have to revisit. Named here
     * rather than left to be discovered.
     */
    const [tenantRow] = await db`SELECT * FROM lotmark.resolve_tenant(NULL)`;
    const tenant = tenantRow as { id: string } | undefined;
    if (!tenant) {
      return reply.code(404).type('text/html; charset=utf-8').send(page(null, null));
    }
    const flags = await inTenantTransaction(
      db, { tenantId: tenant.id, auditKey: app.cfg.LOTMARK_AUDIT_KEY },
      (tx) => tenantFlags(tx, tenant.id, (m) => app.log.warn(m)));
    if (!flagEnabled(flags, 'public_verification')) {
      return reply
        .code(404).type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(page(null, null));
    }

    const [row] = await db`SELECT * FROM lotmark.verify_certificate(${token})`;
    const v = row as Verification | undefined;

    interface PublicKey {
      public_key_pem: string; custody: string; fingerprint: string; purpose: string;
    }
    let publicKey: PublicKey | null = null;
    if (v?.document_key_version) {
      const [k] = await db`
        SELECT * FROM lotmark.public_signing_key(${v.producer_name}, ${v.document_key_version})`;
      publicKey = (k as PublicKey | undefined) ?? null;
    }

    return reply
      .code(v ? 200 : 404)
      .type('text/html; charset=utf-8')
      // A verification result is a point-in-time statement; caching it could
      // show a withdrawn certificate as current.
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send(page(v ?? null, publicKey));
  });

  function page(
    v: Verification | null,
    key: { public_key_pem: string; custody: string; fingerprint: string; purpose: string } | null,
  ): string {
    const status = !v ? 'unknown'
      : v.withdrawn ? 'withdrawn'
      : v.superseded_by !== null ? 'superseded'
      : 'current';

    const banner = {
      unknown: ['No such certificate', 'This code does not match any certificate we have issued. Check the link, or contact the producer.'],
      withdrawn: ['WITHDRAWN — do not rely on this certificate', v?.withdrawn_reason ?? 'No reason was recorded.'],
      superseded: [`Superseded by issue #${v?.superseded_by}`, 'A later issue of this certificate exists. Obtain it from the producer before relying on these values.'],
      current: ['Current', 'This is the latest issue of this certificate and it has not been withdrawn.'],
    }[status];

    const rows = v ? [
      ['Certificate', `${esc(v.certificate_code)} · issue #${v.issue_number}`],
      ['Material', esc(v.material_name)],
      ['Lot', esc(v.lot_code)],
      [esc(v.property_name), `${fmt(v.assigned_value)} ± ${fmt(v.expanded_uncertainty)} ${esc(v.unit)} (k = ${fmt(v.coverage_factor)})`],
      ['Expiry', esc(v.expiry_date)],
      ['Issued', esc(String(v.issued_at).slice(0, 10))],
      ['Producer', esc(v.producer_name)],
      ['Document digest', v.document_sha256 ? `<code>${esc(v.document_sha256)}</code>` : '—'],
    ] : [];

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${v ? `${esc(v.certificate_code)} — verification` : 'Certificate verification'}</title>
<style>
  :root{--bg:#f7f6f2;--panel:#fff;--ink:#16181c;--muted:#5b6472;--line:#dcd9d1;
        --ok:#2f5f44;--okbg:#e5eee8;--bad:#8c1f25;--badbg:#f6e7e7;--warn:#8a5610;--warnbg:#f6eee1}
  @media(prefers-color-scheme:dark){:root{--bg:#101214;--panel:#171a1e;--ink:#e9e7e2;--muted:#9aa4b2;
        --line:#2b3037;--ok:#79c098;--okbg:#152318;--bad:#e58c8c;--badbg:#2a1618;--warn:#d6a05a;--warnbg:#2a2013}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:640px;margin:0 auto;padding:36px 20px 64px}
  h1{font-size:20px;margin:0 0 4px;letter-spacing:-.2px}
  .sub{color:var(--muted);margin:0 0 24px;font-size:14px}
  .status{border-radius:9px;padding:16px 18px;margin-bottom:22px;border:1px solid}
  .status b{display:block;font-size:17px;margin-bottom:4px}
  .status.current{background:var(--okbg);border-color:var(--ok);color:var(--ok)}
  .status.withdrawn{background:var(--badbg);border-color:var(--bad);color:var(--bad)}
  .status.superseded{background:var(--warnbg);border-color:var(--warn);color:var(--warn)}
  .status.unknown{background:var(--panel);border-color:var(--line);color:var(--muted)}
  table{width:100%;border-collapse:collapse;background:var(--panel);
        border:1px solid var(--line);border-radius:9px;overflow:hidden}
  th,td{text-align:left;padding:11px 15px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child th,tr:last-child td{border-bottom:0}
  th{width:38%;font-weight:600;color:var(--muted);font-size:13px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
  details{margin-top:20px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px}
  summary{cursor:pointer;font-size:14px;font-weight:600}
  pre{overflow-x:auto;font-size:11px;background:transparent;margin:10px 0 0}
  footer{margin-top:28px;color:var(--muted);font-size:13px}
</style></head>
<body><div class="wrap">
  <h1>Certificate verification</h1>
  <p class="sub">Independent check of a certified reference material certificate.</p>

  <div class="status ${status}">
    <b>${esc(banner[0]!)}</b>${esc(banner[1]!)}
  </div>

  ${v ? `<table>${rows.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join('')}</table>` : ''}

  ${key ? `<details><summary>Verify the signature yourself</summary>
    <p style="font-size:14px;color:var(--muted)">
      The document carries an Ed25519 signature over its own bytes. Anyone can check it
      with the public key below — no account and no access to the producer's systems.
      This is the producer's <b>${esc(key.purpose)}</b> key; custody is
      <b>${esc(key.custody)}</b>.
    </p>
    <p style="font-size:13px"><b>Fingerprint</b> <code>${esc(key.fingerprint)}</code></p>
    <pre><code>${esc(key.public_key_pem)}</code></pre>
  </details>` : ''}

  <footer>
    This page states what the producer's records say now. A certificate that was
    current when printed may since have been superseded or withdrawn, which is
    the reason to check rather than assume.
  </footer>
</div></body></html>`;
  }
}

function esc(v: string): string {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v) >= 1 ? v.toPrecision(6) : v.toPrecision(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
