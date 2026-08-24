/**
 * What a write should make true everywhere else.
 *
 * The generic rule — prepend the submitted record to the matching list — is
 * enough for a screenshot and not enough for a take. This system's whole story
 * is that one act moves a record through a machine and leaves a trace: sign a
 * study and it reads `signed`; authorise a value and the lot it belongs to
 * becomes releasable; issue a certificate and the holders can see it. A demo
 * where the button works but nothing downstream changes demonstrates a form,
 * not a product.
 *
 * ── Why these are written by hand ───────────────────────────────────────────
 *
 * There are seven state machines in the configuration — project, study,
 * property_value, lot, order, entitlement, capa — with 28 states and 25 moves
 * between them. Reimplementing them here would be a second copy of the product
 * that drifts from the first, which is the failure this whole demo was built to
 * avoid. So these are not a simulation of the machines. Each one is a small,
 * explicit statement of what a viewer should SEE change, on the screens the
 * recording actually visits, and nothing more.
 *
 * Everything not listed falls back to the generic rule.
 */

export interface Ctx {
  /** The recorded body for a key, live and mutable. */
  readonly body: (key: string) => unknown;
  /** The list inside a recorded body, whatever the envelope calls it. */
  readonly list: (key: string) => Array<Record<string, unknown>> | null;
  /** Append to the audit ledger. This is the point of most of these. */
  readonly audit: (kind: string, action: string, detail: string) => void;
  readonly actor: string;
  readonly now: () => string;
  readonly id: () => string;
}

type Chain = (ctx: Ctx, payload: Record<string, unknown>, params: string[]) => unknown;

/** Find a row by id in any of the given keys. */
const find = (ctx: Ctx, keys: string[], id: string) => {
  for (const key of keys) {
    const row = ctx.list(key)?.find((r) => r['id'] === id);
    if (row) return row;
  }
  return null;
};


/**
 * `[pattern, kind, chain]`, tried in order.
 *
 * `:x` matches one segment and is collected into `params`.
 */
export const CHAINS: ReadonlyArray<readonly [string, Chain]> = [
  /* ── A study is signed ──────────────────────────────────────────────────── */
  ['POST /studies/:id/sign', (ctx, payload, [id]) => {
    const study = find(ctx, ['GET /projects/:id/studies'], id!);
    if (study) {
      study['state'] = 'signed';
      study['signed'] = ctx.now().slice(0, 10);
      study['signedBy'] = ctx.actor;
    }
    ctx.audit('SIGNATURE', 'study.sign',
      `${study?.['code'] ?? 'study'} signed — ${String(payload['meaning'] ?? 'approval')}`);
    return { ...(study ?? {}), signed: true };
  }],

  /* ── A property value is assigned, then authorised ──────────────────────── */
  ['POST /values/:id/assign', (ctx, payload, [id]) => {
    const value = find(ctx, ['GET /projects/:id/values'], id!);
    if (value) { value['state'] = 'assigned'; value['assigned_on'] = ctx.now().slice(0, 10); }
    ctx.audit('VALUE', 'value.assign',
      `${value?.['property_name'] ?? 'value'} assigned${payload['assignedValue'] ? ` — ${String(payload['assignedValue'])}` : ''}`);
    return value ?? { id, state: 'assigned' };
  }],

  ['POST /values/:id/authorise', (ctx, _payload, [id]) => {
    const value = find(ctx, ['GET /projects/:id/values'], id!);
    if (value) { value['state'] = 'authorised'; value['authorised_on'] = ctx.now().slice(0, 10); }
    /*
     * The lot becomes releasable. The console reads the lot's own state, so
     * moving only the value would leave the next screen unchanged and the
     * viewer wondering what the button did.
     */
    const lot = ctx.list('GET /projects/:id/lots')?.find((l) => l['state'] === 'study'
      || l['state'] === 'authorisation');
    if (lot) lot['state'] = 'authorisation';
    ctx.audit('VALUE', 'value.authorise',
      `${value?.['property_name'] ?? 'value'} authorised for release`);
    return value ?? { id, state: 'authorised' };
  }],

  /* ── A certificate is issued from a lot ─────────────────────────────────── */
  ['POST /lots/:id/certificate', (ctx, _payload, [id]) => {
    const lot = find(ctx, ['GET /projects/:id/lots'], id!);
    const code = `CRT-${2000 + Math.floor(Math.random() * 900)}`;
    if (lot) {
      lot['state'] = 'released';
      lot['certificate_code'] = code;
      lot['certificate_id'] = ctx.id();
    }
    ctx.audit('CERTIFICATE', 'certificate.issue',
      `${code} issued for ${String(lot?.['lot_code'] ?? 'lot')} — issue #1`);
    return { code, issueNumber: 1, lotId: id };
  }],

  /* ── Reissue and withdrawal, the §7.11 recall path ──────────────────────── */
  ['POST /certificates/:id/reissue', (ctx, payload) => {
    const cert = ctx.body('GET /certificates/:id') as
      { issues?: Array<Record<string, unknown>>; currentIssue?: Record<string, unknown> } | undefined;
    const next = ((cert?.issues?.[0]?.['number'] as number | undefined) ?? 1) + 1;
    const issue = {
      ...(cert?.issues?.[0] ?? {}),
      number: next,
      issuedAt: ctx.now(),
      issuedBy: ctx.actor,
      reissueReason: String(payload['reason'] ?? 'Corrected value'),
      withdrawn: false, withdrawnAt: null, withdrawnReason: null,
    };
    cert?.issues?.unshift(issue);
    if (cert) cert.currentIssue = issue;
    ctx.audit('CERTIFICATE', 'certificate.reissue', `Reissued as #${next} — ${String(issue.reissueReason)}`);
    return issue;
  }],

  ['POST /certificates/:id/issues/:n/withdraw', (ctx, payload, [, n]) => {
    const cert = ctx.body('GET /certificates/:id') as
      { issues?: Array<Record<string, unknown>> } | undefined;
    const issue = cert?.issues?.find((i) => String(i['number']) === n);
    if (issue) {
      issue['withdrawn'] = true;
      issue['withdrawnAt'] = ctx.now();
      issue['withdrawnReason'] = String(payload['reason'] ?? 'Value found to be wrong');
    }
    /* Holders are told. This is the control the register calls REQ-WITHDRAWAL. */
    const holders = ctx.list('GET /certificates/:id/issues/:n/holders');
    holders?.forEach((h) => { h['notified'] = true; h['notified_at'] = ctx.now(); });

    ctx.audit('CERTIFICATE', 'certificate.withdraw',
      `Issue #${n} withdrawn — ${String(payload['reason'] ?? 'value found to be wrong')}; `
      + `${holders?.length ?? 0} holder(s) notified`);
    return { withdrawn: true, notified: holders?.length ?? 0 };
  }],

  /* ── A CAPA moves through its machine ───────────────────────────────────── */
  ['POST /capa/:id/transition', (ctx, payload, [id]) => {
    const capa = find(ctx, ['GET /capa'], id!);
    const to = String(payload['to'] ?? payload['toState'] ?? 'containment');
    if (capa) {
      capa['state'] = to;
      if (to === 'closed') capa['closed_at'] = ctx.now();
      if (payload['rootCause']) capa['root_cause'] = payload['rootCause'];
      if (payload['correctiveAction']) capa['corrective_action'] = payload['correctiveAction'];
    }
    ctx.audit('CAPA', 'capa.transition',
      `${String(capa?.['code'] ?? 'CAPA')} → ${to}`
      + (payload['reason'] ? ` — ${String(payload['reason'])}` : ''));
    return capa ?? { id, state: to };
  }],

  /* ── An order advances, and a shipment is raised ────────────────────────── */
  ['POST /orders/:id/advance', (ctx, payload, [id]) => {
    const order = find(ctx, ['GET /orders'], id!);
    const to = String(payload['to'] ?? 'packed');
    if (order) order['state'] = to;
    ctx.audit('ORDER', 'order.advance', `${String(order?.['code'] ?? 'order')} → ${to}`);
    return order ?? { id, state: to };
  }],

  ['POST /orders/:id/shipment', (ctx, _payload, [id]) => {
    const order = find(ctx, ['GET /orders'], id!);
    if (order) { order['state'] = 'dispatched'; order['dispatched_at'] = ctx.now(); }
    ctx.audit('ORDER', 'shipment.create',
      `Shipment raised for ${String(order?.['code'] ?? 'order')} — cold chain armed`);
    return { id: ctx.id(), orderId: id, state: 'in_transit' };
  }],

  /* ── An entitlement is decided ──────────────────────────────────────────── */
  ['POST /entitlements/:id/decide', (ctx, payload, [id]) => {
    const ent = find(ctx, ['GET /entitlements'], id!);
    const decision = String(payload['decision'] ?? 'approved');
    if (ent) { ent['state'] = decision; ent['decided_at'] = ctx.now(); }
    ctx.audit('ENTITLEMENT', 'entitlement.decide',
      `${String(ent?.['code'] ?? 'entitlement')} ${decision}`);
    return ent ?? { id, state: decision };
  }],

  /* ── Custom field values, the form designer's visible effect ────────────── */
  ['PUT /custom-fields/:entity/:recordId', (ctx, payload, [entity]) => {
    const store = ctx.body('GET /custom-fields/:entity/:recordId') as
      { values?: Record<string, unknown> } | undefined;
    const submitted = (payload['values'] ?? payload) as Record<string, unknown>;
    if (store) store.values = { ...(store.values ?? {}), ...submitted };
    ctx.audit('CONFIG', 'custom_fields.write',
      `Custom fields updated on a ${entity} — ${Object.keys(submitted).length} field(s)`);
    return store ?? { values: submitted };
  }],
];

/** Match a path against a chain pattern, collecting `:params`. */
export function matchChain(
  method: string, path: string,
): { chain: Chain; params: string[] } | null {
  const parts = path.split('/');
  for (const [pattern, chain] of CHAINS) {
    const [m, p] = pattern.split(' ');
    if (m !== method) continue;
    const want = p!.split('/');
    if (want.length !== parts.length) continue;
    const params: string[] = [];
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i]!.startsWith(':')) params.push(parts[i]!);
      else if (want[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { chain, params };
  }
  return null;
}
