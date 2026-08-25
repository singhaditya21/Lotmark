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
      // The project screen reads `signedOn` for the Signed column; set that, so
      // a study signed on camera fills its date in rather than staying a dash.
      study['signedOn'] = ctx.now().slice(0, 10);
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

  /* ── A lot is released from the authorised value ────────────────────────────
   *
   * The step the product turned on but never wired a screen to. It creates a
   * new released lot, supersedes the one it replaces (so "which lot replaced
   * which" stays a traversal), and returns the shape the release dialog reads
   * back. Storage and cold chain are the API's default here — the real server
   * derives them from the stability study. */
  ['POST /projects/:id/release-lot', (ctx, payload) => {
    const lots = ctx.list('GET /projects/:id/lots');
    const authorised = ctx.list('GET /projects/:id/values')?.find((v) => v['state'] === 'authorised');
    const previous = lots?.find((l) => l['state'] === 'released');
    if (previous) previous['state'] = 'superseded';

    const nums = (lots ?? []).map((l) => Number(/(\d+)$/.exec(String(l['lot_code']))?.[1] ?? 0));
    const code = `RMP-PARA-${String(Math.max(0, ...nums) + 1).padStart(4, '0')}`;
    const storage = 'Room temperature';
    const lot = {
      id: ctx.id(), lot_code: code, state: 'released',
      expiry_date: String(payload['expiryDate'] ?? ''),
      storage_condition: storage, cold_chain: false,
      supersedes: previous ? previous['lot_code'] : null,
      certificate_code: null, certificate_id: null,
      stock_units: Number(payload['stockUnits']) || 0,
      unit_price_minor: Number(payload['unitPriceMinor']) || 0,
    };
    lots?.unshift(lot);
    ctx.audit('WORKFLOW', 'lot.release',
      `${code} released${previous ? ` · supersedes ${String(previous['lot_code'])}` : ''}`
      + ` · storage ${storage}`);
    return {
      lot: {
        id: lot.id, lotCode: code, state: 'released', expiryDate: lot.expiry_date,
        storageCondition: storage, coldChain: false, supersedes: lot.supersedes,
      },
      value: authorised ? {
        code: authorised['code'], assignedValue: authorised['assigned_value'],
        expandedUncertainty: authorised['expanded_uncertainty'],
        unit: authorised['unit'], coverageFactor: authorised['coverage_factor'],
      } : null,
      signature: { id: ctx.id(), signedAt: ctx.now(), keyVersion: 1 },
    };
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
      const from = String(capa['state'] ?? '') || null;
      capa['state'] = to;
      if (to === 'closed') capa['closed_at'] = ctx.now();
      if (payload['rootCause']) capa['root_cause'] = payload['rootCause'];
      if (payload['correctiveAction']) capa['corrective_action'] = payload['correctiveAction'];
      // Grow the move history the card's timeline reads, so the move the viewer
      // just made shows up there too.
      const history = Array.isArray(capa['transitions'])
        ? (capa['transitions'] as unknown[])
        : (capa['transitions'] = []);
      history.push({
        fromState: from, toState: to, occurredAt: ctx.now(),
        actor: ctx.actor, reason: payload['reason'] ?? null, signed: true,
      });
    }
    ctx.audit('CAPA', 'capa.transition',
      `${String(capa?.['code'] ?? 'CAPA')} → ${to}`
      + (payload['reason'] ? ` — ${String(payload['reason'])}` : ''));
    return capa ?? { id, state: to };
  }],

  /* ── A customer places an order, and it works its way to dispatch ───────── */
  ['POST /orders', (ctx, payload) => {
    /*
     * The customer's half of the story, which the generic write left as a bare
     * row with no code and no state. A real placed order: its own number, the
     * line count, priced, against the customer's own organisation, and an entry
     * in the ledger the producer will see. Currency is written as INR rather
     * than the symbol on purpose — the published bundle is scanned for it.
     */
    const lines = (payload['lines'] as Array<{ quantity?: number }> | undefined) ?? [];
    const units = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    const totalMinor = units * 500_000; // INR 5,000 a unit, matching the catalogue.
    const code = `ORD-${3400 + Math.floor(Math.random() * 500)}`;
    const me = ctx.body('GET /auth/me') as { organisation?: { name?: string } } | undefined;
    const order = {
      id: ctx.id(), code, state: 'placed', placed_on: ctx.now().slice(0, 10),
      total_minor: totalMinor, currency: 'INR', courier: null,
      tracking_reference: null,
      organisation_name: me?.organisation?.name ?? 'the customer',
    };
    ctx.list('GET /orders')?.unshift(order);
    ctx.audit('ORDER', 'order.place',
      `${code} placed by ${order.organisation_name} — ${units} unit(s), `
      + `INR ${(totalMinor / 100).toLocaleString('en-IN')}`);
    return { code, totalMinor };
  }],

  ['POST /orders/:id/advance', (ctx, payload, [id]) => {
    const order = find(ctx, ['GET /orders'], id!);
    const to = String(payload['to'] ?? 'packed');
    if (order) {
      order['state'] = to;
      if (to === 'dispatched') {
        order['courier'] = payload['courier'] ?? 'Cold-chain courier';
        order['tracking_reference'] = `CC${100000 + Math.floor(Math.random() * 900000)}`;
        order['dispatched_at'] = ctx.now();
      }
      if (to === 'delivered') order['delivered_at'] = ctx.now();
    }
    ctx.audit('ORDER', 'order.advance', `${String(order?.['code'] ?? 'order')} → ${to}`);
    return order ?? { id, state: to };
  }],

  ['POST /orders/:id/shipment', (ctx, payload, [id]) => {
    const order = find(ctx, ['GET /orders'], id!);
    if (order) { order['state'] = 'dispatched'; order['dispatched_at'] = ctx.now(); }
    const code = `SHP-${8000 + Math.floor(Math.random() * 900)}`;
    const shipment = {
      id: ctx.id(), order_id: id, code,
      temperature_class: String(payload['temperatureClass'] ?? '2-8'),
      dispatched_at: ctx.now(), delivered_at: null, readings: 0, excursions: 0,
    };
    const shipments = (ctx.body('GET /orders') as { shipments?: unknown[] } | undefined)?.shipments;
    if (Array.isArray(shipments)) shipments.unshift(shipment);
    ctx.audit('ORDER', 'shipment.create',
      `${code} raised for ${String(order?.['code'] ?? 'order')} — cold chain armed at `
      + `${shipment.temperature_class} °C`);
    return shipment;
  }],

  /* ── The cold chain reports in ──────────────────────────────────────────── */
  ['POST /shipments/:id/readings', (ctx, payload, [id]) => {
    const shipments = (ctx.body('GET /orders') as
      { shipments?: Array<Record<string, unknown>> } | undefined)?.shipments;
    const shipment = shipments?.find((s) => s['id'] === id);
    const excursion = payload['excursion'] === true;
    if (shipment) {
      shipment['readings'] = Number(shipment['readings'] ?? 0) + 1;
      if (excursion) shipment['excursions'] = Number(shipment['excursions'] ?? 0) + 1;
    }
    ctx.audit('SHIPMENT', 'shipment.reading',
      `${String(shipment?.['code'] ?? 'shipment')} logged a temperature reading`
      + (excursion ? ' — EXCURSION flagged' : ' — in range'));
    return shipment ?? { id, readings: 1 };
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

  /* ── A configuration draft is published, under signature ────────────────────
   *
   * The change-control loop, closed. The screen opens on a draft that carries
   * two real changes; publishing it (a signed act — the ceremony is enforced by
   * needsStepUp, which already covers every `/publish`) makes the draft the new
   * active version, supersedes the old one, and writes the act to the ledger.
   * The Configuration screen reads `activeId`/`draftId` back from the overview,
   * so the version table updates the moment it refetches. */
  ['POST /admin/config/draft/:id/publish', (ctx) => {
    const overview = ctx.body('GET /admin/config') as {
      versions: Array<Record<string, unknown>>; activeId: string; draftId: string | null;
    } | undefined;
    const review = ctx.body('GET /admin/config/draft/:id/review') as
      { changes?: Array<Record<string, unknown>> } | undefined;
    const changes = review?.changes ?? [];

    let published: Record<string, unknown> | undefined;
    if (overview) {
      published = overview.versions.find((v) => v['id'] === overview.draftId);
      for (const v of overview.versions) if (v['status'] === 'active') v['status'] = 'superseded';
      if (published) {
        published['status'] = 'active';
        published['signed'] = true;
        published['publishedAt'] = ctx.now();
        published['changeCount'] = changes.length;
        overview.activeId = published['id'] as string;
      }
      overview.draftId = null;
    }

    ctx.audit('CONFIG', 'config.publish',
      `Version ${published?.['number'] ?? '?'} published under signature — `
      + `${changes.length} change(s): ${changes.map((c) => String(c['key'])).join(', ')}`);
    return { number: Number(published?.['number'] ?? 0), changes, signed: true };
  }],

  /* ── Team membership: who belongs to a team ─────────────────────────────────
   *
   * Belonging, not authority — it grants nothing on its own. The roster reads
   * the directory's `memberships`, so joining pushes a row and bumps the team's
   * member count, and leaving removes it. */
  ['POST /admin/teams/:id/members', (ctx, payload, [teamId]) => {
    const dir = ctx.body('GET /admin/people') as {
      memberships?: Array<Record<string, unknown>>;
      teams?: Array<Record<string, unknown>>;
      users?: Array<Record<string, unknown>>;
    } | undefined;
    const userId = String(payload['userId'] ?? '');
    const already = dir?.memberships?.some(
      (m) => m['team_id'] === teamId && m['user_id'] === userId && !m['left_on']);
    if (dir?.memberships && !already) {
      dir.memberships.push({ id: ctx.id(), team_id: teamId, user_id: userId, joined_on: ctx.now().slice(0, 10) });
      const team = dir.teams?.find((t) => t['id'] === teamId);
      if (team) team['members'] = Number(team['members'] ?? 0) + 1;
      const user = dir.users?.find((u) => u['id'] === userId);
      ctx.audit('CONFIGURATION', 'team.member.add',
        `${String(user?.['display_name'] ?? 'Someone')} joined ${String(team?.['name'] ?? 'a team')} — membership grants nothing on its own`);
    }
    return { ok: true };
  }],

  ['DELETE /admin/teams/:id/members/:userId', (ctx, _payload, [teamId, userId]) => {
    const dir = ctx.body('GET /admin/people') as {
      memberships?: Array<Record<string, unknown>>;
      teams?: Array<Record<string, unknown>>;
      users?: Array<Record<string, unknown>>;
    } | undefined;
    if (dir?.memberships) {
      const before = dir.memberships.length;
      dir.memberships = dir.memberships.filter(
        (m) => !(m['team_id'] === teamId && m['user_id'] === userId));
      const team = dir.teams?.find((t) => t['id'] === teamId);
      if (before !== dir.memberships.length && team) {
        team['members'] = Math.max(0, Number(team['members'] ?? 0) - 1);
      }
      const user = dir.users?.find((u) => u['id'] === userId);
      ctx.audit('CONFIGURATION', 'team.member.remove',
        `${String(user?.['display_name'] ?? 'Someone')} left ${String(team?.['name'] ?? 'a team')}`);
    }
    return { ok: true };
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
