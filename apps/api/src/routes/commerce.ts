import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  assertTransition, defaultSodSettings, reasonRequired,
  type OrderState,
} from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { machineForEntity } from '../services/workflows';
import { tenantSod } from '../services/sod';
import { nextCode } from '../services/numbering';
import {
  sendProblem, notFound, conflict, unprocessable, invalidRequest, forbidden,
} from '../http/problem';

/**
 * The commercial half: catalogue, orders, price-tier claims, dispatch and the
 * customer's vault.
 *
 * ── Every transaction here declares who it is acting as ─────────────────────
 *
 * Migration 0022 put restrictive organisation policies on these tables and they
 * fail CLOSED. A producer-side request that does not declare itself sees an
 * empty list rather than an error, and a customer request that does not set its
 * organisation sees nothing at all. `txFor` below derives both from the session
 * so no route has to remember.
 *
 * ── Two ways to read the same table ─────────────────────────────────────────
 *
 * `order:read_all` and `order:read_own` are different permissions and the
 * difference is enforced twice: by the guard, which decides whether the request
 * is allowed, and by the database, which decides which rows exist as far as the
 * session is concerned. Neither is sufficient alone — the guard could be
 * forgotten in a new route, and the policy cannot express "this person may see
 * every organisation's orders".
 */

const orderBody = z.object({
  lines: z.array(z.object({
    lotId: z.string().uuid(),
    quantity: z.number().int().positive().max(1000),
  })).min(1, 'An order needs at least one line.'),
});

const advanceBody = z.object({
  to: z.string(),
  courier: z.string().max(120).optional(),
  trackingReference: z.string().max(120).optional(),
  /**
   * Demanded by the move, not by this schema. The product's default asks for
   * one when cancelling — `placed → cancelled` and `packed → cancelled` — and
   * there was no field to put it in, so the declared rule could not have been
   * obeyed even by somebody trying to.
   */
  reason: z.string().max(1000).optional(),
});

const claimBody = z.object({
  supportingDocument: z.string().min(1, 'A tier claim needs supporting documentation.').max(500),
});

const decisionBody = z.object({
  approve: z.boolean(),
  note: z.string().min(1, 'A decision must state its reasoning.').max(1000),
  revalidationDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const readingsBody = z.object({
  readings: z.array(z.object({
    readAt: z.string(),
    celsius: z.number(),
  })).min(1),
});

const priceBody = z.object({
  unitPriceMinor: z.number().int().nonnegative(),
  tierable: z.boolean(),
});

export async function registerCommerceRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  const auditOf = (ctx: RequestContext) => ({
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  });

  /**
   * A transaction that has already said who is acting.
   *
   * Derived from the session's organisation, so a route cannot forget — and
   * forgetting is invisible here, because the policies fail closed and an empty
   * result looks like an empty table.
   */
  const txFor = <T>(ctx: RequestContext, fn: (t: Sql) => Promise<T>): Promise<T> =>
    inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      organisationKind: ctx.organisation.kind === 'producer' ? 'producer' : 'customer',
      organisationId: ctx.organisation.id,
    }, fn);

  async function held(
    req: FastifyRequest, reply: FastifyReply, permissions: readonly string[],
  ): Promise<RequestContext | null> {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return null;
    // Any ONE of them is enough; they are alternative ways to be entitled to
    // the same screen, not a set that must all be held.
    for (const p of permissions) {
      const verdict = decide({
        authority: ctx.authority, permission: p as never,
        scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
      });
      if (verdict.allowed) return ctx;
    }
    await sendProblem(reply, forbidden('permission_denied',
      `This needs one of: ${permissions.join(', ')}.`));
    return null;
  }

  const can = (ctx: RequestContext, permission: string): boolean =>
    decide({
      authority: ctx.authority, permission: permission as never,
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    }).allowed;

  /* ── Catalogue ────────────────────────────────────────────────────────── */

  /**
   * What can be bought.
   *
   * A withdrawn lot is not in it. That is the whole point of withdrawing one,
   * and it is enforced here rather than left to the caller's WHERE clause.
   */
  app.get('/catalogue', async (req, reply) => {
    const ctx = await held(req, reply, ['order:create', 'catalogue:manage', 'order:read_all']);
    if (!ctx) return;

    const rows = await txFor(ctx, (t) => t`
      SELECT l.id, l.lot_code, l.expiry_date, l.stock_units, l.storage_condition,
             l.cold_chain, l.unit_price_minor, l.tierable,
             p.material_name, p.cas_number, p.sku,
             c.code AS certificate_code,
             pv.assigned_value, pv.expanded_uncertainty, pv.unit, pv.property_name
      FROM lotmark.lots l
      JOIN lotmark.projects p ON p.id = l.project_id
      LEFT JOIN lotmark.certificates c ON c.lot_id = l.id
      LEFT JOIN LATERAL (
        SELECT assigned_value, expanded_uncertainty, unit, property_name
        FROM lotmark.property_values v
        WHERE v.project_id = l.project_id AND v.state = 'authorised'
        ORDER BY v.authorised_at DESC LIMIT 1
      ) pv ON true
      WHERE l.tenant_id = ${ctx.tenantId} AND l.state = 'released'
      ORDER BY p.material_name, l.lot_code`);

    return reply.send({
      items: rows,
      canManage: can(ctx, 'catalogue:manage'),
      canOrder: can(ctx, 'order:create'),
    });
  });

  app.put<{ Params: { id: string } }>('/catalogue/:id', async (req, reply) => {
    const ctx = await held(req, reply, ['catalogue:manage']);
    if (!ctx) return;

    const parsed = priceBody.safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, invalidRequest('A price and tier flag are required.'));

    const out = await txFor(ctx, async (t) => {
      const [row] = await t`
        UPDATE lotmark.lots
        SET unit_price_minor = ${parsed.data.unitPriceMinor}, tierable = ${parsed.data.tierable},
            version = version + 1
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} AND state = 'released'
        RETURNING lot_code`;
      if (!row) return { status: 404 as const };
      await recordAudit(t, auditOf(ctx), {
        kind: 'CONFIGURATION', action: 'Catalogue price set',
        detail: `${(row as { lot_code: string }).lot_code} · ${parsed.data.unitPriceMinor} minor units` +
          `${parsed.data.tierable ? ' · eligible for a government tier' : ''}`,
        subjectTable: 'lots', subjectId: req.params.id,
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such released lot.'));
    return reply.send({ ok: true });
  });

  /* ── Orders ───────────────────────────────────────────────────────────── */

  app.get('/orders', async (req, reply) => {
    const ctx = await held(req, reply, ['order:read_all', 'order:read_own']);
    if (!ctx) return;

    const body = await txFor(ctx, async (t) => {
      /**
       * No organisation filter in the SQL, deliberately.
       *
       * The row-level policy already restricts a customer session to its own
       * organisation. Adding a WHERE here would duplicate the rule in a second
       * place that can drift from the first — and the one that drifts is always
       * the one nobody reads.
       */
      const orders = await t`
        SELECT o.id, o.code, o.state, o.placed_on, o.total_minor, o.currency,
               o.courier, o.tracking_reference,
               org.name AS organisation_name
        FROM lotmark.orders o
        JOIN lotmark.organisations org ON org.id = o.organisation_id
        WHERE o.tenant_id = ${ctx.tenantId}
        ORDER BY o.placed_on DESC, o.code DESC`;

      const lines = await t`
        SELECT ol.order_id, ol.quantity, ol.unit_price_minor,
               l.lot_code, p.material_name
        FROM lotmark.order_lines ol
        JOIN lotmark.lots l ON l.id = ol.lot_id
        JOIN lotmark.projects p ON p.id = l.project_id
        WHERE ol.tenant_id = ${ctx.tenantId}`;

      const shipments = await t`
        SELECT s.id, s.order_id, s.code, s.temperature_class, s.dispatched_at, s.delivered_at,
               (SELECT count(*)::int FROM lotmark.logger_readings r WHERE r.shipment_id = s.id) AS readings,
               (SELECT count(*)::int FROM lotmark.logger_readings r
                 WHERE r.shipment_id = s.id
                   AND (r.celsius < split_part(s.temperature_class, '-', 1)::numeric
                     OR r.celsius > split_part(s.temperature_class, '-', 2)::numeric)) AS excursions
        FROM lotmark.shipments s WHERE s.tenant_id = ${ctx.tenantId}`;

      // Read in the same transaction as the orders, so the moves offered and
      // the states shown come from one read of the configuration.
      const machine = await machineForEntity(t, ctx.tenantId, 'order', (m) => app.log.warn(m));

      return { orders, lines, shipments, machine };
    });

    return reply.send({
      ...body,
      scope: can(ctx, 'order:read_all') ? 'all' : 'own',
      canAdvance: can(ctx, 'order:advance'),
      /** Every state the machine permits, so the console never offers a 409. */
      transitions: body.machine
        ? body.machine.transitions.map((t) => ({ from: t.from, to: t.to, action: t.action }))
        : [],
    });
  });

  app.post('/orders', async (req, reply) => {
    const ctx = await held(req, reply, ['order:create']);
    if (!ctx) return;

    const parsed = orderBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid order.'));
    }

    const out = await txFor(ctx, async (t) => {
      let total = 0;
      const priced: Array<{ lotId: string; quantity: number; unitPriceMinor: number; lotCode: string }> = [];

      for (const line of parsed.data.lines) {
        /**
         * The lot is locked and re-read INSIDE the transaction.
         *
         * Stock and state are both checked here rather than trusted from the
         * catalogue the customer was looking at: a lot can be withdrawn between
         * a page load and a click, and selling material whose certificate has
         * just been withdrawn is the single worst outcome this route has.
         */
        const [row] = await t`
          SELECT id, lot_code, state, stock_units, unit_price_minor
          FROM lotmark.lots
          WHERE tenant_id = ${ctx.tenantId} AND id = ${line.lotId}
          FOR UPDATE`;
        const lot = row as {
          id: string; lot_code: string; state: string;
          stock_units: number; unit_price_minor: number;
        } | undefined;

        if (!lot) return { status: 404 as const, message: 'One of those lots does not exist.' };
        if (lot.state !== 'released') {
          return {
            status: 409 as const,
            message: `Lot ${lot.lot_code} is ${lot.state} and can no longer be ordered.`,
          };
        }
        if (lot.stock_units < line.quantity) {
          return {
            status: 409 as const,
            message: `Only ${lot.stock_units} unit(s) of ${lot.lot_code} remain.`,
          };
        }

        await t`
          UPDATE lotmark.lots SET stock_units = stock_units - ${line.quantity}, version = version + 1
          WHERE id = ${lot.id}`;

        total += lot.unit_price_minor * line.quantity;
        priced.push({
          lotId: lot.id, quantity: line.quantity,
          unitPriceMinor: lot.unit_price_minor, lotCode: lot.lot_code,
        });
      }

      const code = await nextCode(t, { tenantId: ctx.tenantId, entity: 'order', today: ctx.today });
      const [orderRow] = await t`
        INSERT INTO lotmark.orders
          (tenant_id, code, organisation_id, placed_by_user_id, state, placed_on, total_minor)
        VALUES (${ctx.tenantId}, ${code}, ${ctx.organisation.id}, ${ctx.userId},
                'placed', ${ctx.today}, ${total})
        RETURNING id`;
      const orderId = (orderRow as { id: string }).id;

      for (const line of priced) {
        await t`
          INSERT INTO lotmark.order_lines (tenant_id, order_id, lot_id, quantity, unit_price_minor)
          VALUES (${ctx.tenantId}, ${orderId}, ${line.lotId}, ${line.quantity}, ${line.unitPriceMinor})`;
      }

      await recordAudit(t, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Order placed',
        detail: `${code} · ${priced.map((l) => `${l.quantity}× ${l.lotCode}`).join(', ')}`,
        subjectTable: 'orders', subjectId: orderId,
        changes: { code, totalMinor: total },
      });

      return { status: 200 as const, code, orderId, total };
    });

    if (out.status === 404) return sendProblem(reply, notFound(out.message));
    if (out.status === 409) return sendProblem(reply, conflict(out.message));
    return reply.send({ code: out.code, id: out.orderId, totalMinor: out.total });
  });

  app.post<{ Params: { id: string } }>('/orders/:id/advance', async (req, reply) => {
    const ctx = await held(req, reply, ['order:advance']);
    if (!ctx) return;

    const parsed = advanceBody.safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, invalidRequest('A target state is required.'));

    const out = await txFor(ctx, async (t) => {
      const [row] = await t`
        SELECT id, code, state, version FROM lotmark.orders
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} FOR UPDATE`;
      const order = row as { id: string; code: string; state: OrderState; version: number } | undefined;
      if (!order) return { status: 404 as const };

      // The declared machine decides, not this route. An illegal move is a
      // defect caught at the boundary rather than a corrupt record found later.
      const machine = await machineForEntity(t, ctx.tenantId, 'order', (m) => app.log.warn(m));
      if (!machine) return { status: 409 as const, message: 'No workflow governs orders.' };

      let step;
      try {
        step = assertTransition(machine, order.state, parsed.data.to);
      } catch (e) {
        return { status: 409 as const, message: e instanceof Error ? e.message : 'Illegal transition.' };
      }

      if (reasonRequired(step) && !parsed.data.reason?.trim()) {
        return {
          status: 422 as const,
          message: `Moving ${order.code} from ${order.state} to ${parsed.data.to} must state why.`,
        };
      }

      await t`
        UPDATE lotmark.orders
        SET state = ${parsed.data.to},
            courier = coalesce(${parsed.data.courier ?? null}, courier),
            tracking_reference = coalesce(${parsed.data.trackingReference ?? null}, tracking_reference),
            version = version + 1
        WHERE id = ${order.id}`;

      await t`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason)
        VALUES (${ctx.tenantId}, 'order', ${order.id}, ${order.state}, ${parsed.data.to},
                ${ctx.userId}, ${parsed.data.reason?.trim() || step.action})`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'WORKFLOW', action: step.action,
        detail: `${order.code}: ${order.state} → ${parsed.data.to}` +
          (parsed.data.courier ? ` · ${parsed.data.courier}` : ''),
        subjectTable: 'orders', subjectId: order.id,
        changes: { from: order.state, to: parsed.data.to },
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such order.'));
    if (out.status === 409) return sendProblem(reply, conflict(out.message));
    return reply.send({ ok: true });
  });

  /* ── Price-tier claims ────────────────────────────────────────────────── */

  app.get('/entitlements', async (req, reply) => {
    const ctx = await held(req, reply, ['entitlement:decide', 'entitlement:claim']);
    if (!ctx) return;

    const rows = await txFor(ctx, (t) => t`
      SELECT e.id, e.code, e.state, e.raised_on, e.supporting_document,
             e.decision_note, e.decided_at, e.revalidation_due,
             e.raised_by, org.name AS organisation_name,
             u.display_name AS raised_by_name
      FROM lotmark.entitlements e
      JOIN lotmark.organisations org ON org.id = e.organisation_id
      LEFT JOIN lotmark.users u ON u.id = e.raised_by
      WHERE e.tenant_id = ${ctx.tenantId}
      ORDER BY e.raised_on DESC`);

    return reply.send({
      claims: rows,
      canDecide: can(ctx, 'entitlement:decide'),
      canClaim: can(ctx, 'entitlement:claim'),
      /**
       * Stated plainly rather than implied by a silent absence: an approved
       * tier is RECORDED and has no effect on what anything costs. No tier
       * price list exists in the product.
       */
      tierHasNoPriceEffect: true,
    });
  });

  app.post('/entitlements', async (req, reply) => {
    const ctx = await held(req, reply, ['entitlement:claim']);
    if (!ctx) return;

    const parsed = claimBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid claim.'));
    }

    const out = await txFor(ctx, async (t) => {
      const [open] = await t`
        SELECT id FROM lotmark.entitlements
        WHERE tenant_id = ${ctx.tenantId} AND organisation_id = ${ctx.organisation.id}
          AND state = 'under_review' LIMIT 1`;
      if (open) return { status: 409 as const };

      const [seq] = await t`
        SELECT count(*)::int + 100 AS n FROM lotmark.entitlements WHERE tenant_id = ${ctx.tenantId}`;
      const code = `ENT-${(seq as { n: number }).n}`;

      const [row] = await t`
        INSERT INTO lotmark.entitlements
          (tenant_id, code, organisation_id, raised_by, raised_on, supporting_document, state)
        VALUES (${ctx.tenantId}, ${code}, ${ctx.organisation.id}, ${ctx.userId},
                ${ctx.today}, ${parsed.data.supportingDocument}, 'under_review')
        RETURNING id`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Price tier claimed',
        detail: `${code} · ${parsed.data.supportingDocument}`,
        subjectTable: 'entitlements', subjectId: (row as { id: string }).id,
      });
      return { status: 200 as const, code };
    });

    if (out.status === 409) {
      return sendProblem(reply, conflict('A claim for your organisation is already under review.'));
    }
    return reply.send({ code: out.code });
  });

  app.post<{ Params: { id: string } }>('/entitlements/:id/decide', async (req, reply) => {
    const ctx = await held(req, reply, ['entitlement:decide']);
    if (!ctx) return;

    const parsed = decisionBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid decision.'));
    }

    const out = await txFor(ctx, async (t) => {
      const [row] = await t`
        SELECT id, code, state, raised_by FROM lotmark.entitlements
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} FOR UPDATE`;
      const claim = row as
        { id: string; code: string; state: string; raised_by: string } | undefined;
      if (!claim) return { status: 404 as const };

      const sod = await tenantSod(t, ctx.tenantId, (m) => app.log.warn(m));
      const to = parsed.data.approve ? 'approved' : 'rejected';
      const machine = await machineForEntity(
        t, ctx.tenantId, 'entitlement', (m) => app.log.warn(m));
      if (!machine) return { status: 409 as const, message: 'No workflow governs price tiers.' };
      try {
        assertTransition(machine, claim.state as string, to);
      } catch (e) {
        return { status: 409 as const, message: e instanceof Error ? e.message : 'Illegal transition.' };
      }

      /**
       * SoD-3: you cannot decide a claim you raised.
       *
       * The record is passed to the guard so the rule reads the earlier actor
       * from it — the rule is declared in @lotmark/domain and evaluated here,
       * rather than restated as an `if` that would drift from the declaration.
       */
      const verdict = decide({
        authority: ctx.authority, permission: 'entitlement:decide',
        scope: { kind: 'tenant' },
        record: { raisedBy: claim.raised_by },
        sodSettings: sod.settings, sodThresholds: sod.thresholds, onDate: ctx.today,
      });
      if (!verdict.allowed) {
        await recordAudit(t, auditOf(ctx), {
          kind: 'DENY', action: 'Price tier decision refused',
          detail: `${claim.code}: ${verdict.message}`,
          subjectTable: 'entitlements', subjectId: claim.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      await t`
        UPDATE lotmark.entitlements
        SET state = ${to}, decided_by = ${ctx.userId}, decided_at = now(),
            decision_note = ${parsed.data.note},
            revalidation_due = ${parsed.data.approve ? (parsed.data.revalidationDue ?? null) : null},
            version = version + 1
        WHERE id = ${claim.id}`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'WORKFLOW', action: parsed.data.approve ? 'Tier approved' : 'Tier rejected',
        detail: `${claim.code} · ${parsed.data.note}` +
          (parsed.data.approve
            ? ' · recorded only; no price list exists, so nothing costs less'
            : ''),
        subjectTable: 'entitlements', subjectId: claim.id,
      });
      return { status: 200 as const };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such claim.'));
    if (out.status === 409) return sendProblem(reply, conflict(out.message));
    if (out.status === 403) {
      return sendProblem(reply, forbidden(out.verdict.reason, out.verdict.message));
    }
    return reply.send({ ok: true });
  });

  /* ── Cold chain ───────────────────────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/orders/:id/shipment', async (req, reply) => {
    const ctx = await held(req, reply, ['order:advance']);
    if (!ctx) return;

    const parsed = z.object({ temperatureClass: z.string().regex(/^-?\d+(\.\d+)?--?\d+(\.\d+)?$/,
      'A temperature class looks like "2-8".') }).safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid class.'));
    }

    const out = await txFor(ctx, async (t) => {
      const [row] = await t`
        SELECT id, code FROM lotmark.orders
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const order = row as { id: string; code: string } | undefined;
      if (!order) return { status: 404 as const };

      const [seq] = await t`
        SELECT count(*)::int + 1 AS n FROM lotmark.shipments WHERE tenant_id = ${ctx.tenantId}`;
      const code = `SHP-${String((seq as { n: number }).n).padStart(4, '0')}`;

      const [ship] = await t`
        INSERT INTO lotmark.shipments (tenant_id, code, order_id, temperature_class, dispatched_at)
        VALUES (${ctx.tenantId}, ${code}, ${order.id}, ${parsed.data.temperatureClass}, now())
        RETURNING id`;

      await recordAudit(t, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Shipment created',
        detail: `${code} for ${order.code} · ${parsed.data.temperatureClass} °C`,
        subjectTable: 'shipments', subjectId: (ship as { id: string }).id,
      });
      return { status: 200 as const, code, id: (ship as { id: string }).id };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such order.'));
    return reply.send({ code: out.code, id: out.id });
  });

  /**
   * Logger readings, and what an excursion does.
   *
   * Stored as DATA rather than an attached PDF, which is what makes the next
   * part possible: a reading outside the shipment's temperature class raises a
   * CAPA automatically. A cold-chain breach that depends on somebody noticing
   * it in a chart is a cold-chain breach that gets noticed at the next audit.
   */
  app.post<{ Params: { id: string } }>('/shipments/:id/readings', async (req, reply) => {
    const ctx = await held(req, reply, ['order:advance']);
    if (!ctx) return;

    const parsed = readingsBody.safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, invalidRequest('Readings are required.'));

    const out = await txFor(ctx, async (t) => {
      const [row] = await t`
        SELECT s.id, s.code, s.temperature_class, o.code AS order_code, o.owner_team_id
        FROM lotmark.shipments s JOIN lotmark.orders o ON o.id = s.order_id
        WHERE s.tenant_id = ${ctx.tenantId} AND s.id = ${req.params.id} LIMIT 1`;
      const shipment = row as {
        id: string; code: string; temperature_class: string;
        order_code: string; owner_team_id: string | null;
      } | undefined;
      if (!shipment) return { status: 404 as const };

      const [lo, hi] = shipment.temperature_class.split('-').map(Number);
      if (lo === undefined || hi === undefined || Number.isNaN(lo) || Number.isNaN(hi)) {
        return { status: 422 as const, message: `Cannot read the temperature class '${shipment.temperature_class}'.` };
      }

      const excursions = parsed.data.readings.filter((r) => r.celsius < lo || r.celsius > hi);

      for (const r of parsed.data.readings) {
        await t`
          INSERT INTO lotmark.logger_readings (tenant_id, shipment_id, read_at, celsius)
          VALUES (${ctx.tenantId}, ${shipment.id}, ${r.readAt}, ${r.celsius})`;
      }

      let capaCode: string | null = null;
      if (excursions.length > 0) {
        const worst = excursions.reduce((a, b) =>
          Math.abs(b.celsius - (b.celsius < lo ? lo : hi)) > Math.abs(a.celsius - (a.celsius < lo ? lo : hi)) ? b : a);

        capaCode = await nextCode(t, { tenantId: ctx.tenantId, entity: 'capa', today: ctx.today });
        await t`
          INSERT INTO lotmark.capa
            (tenant_id, code, source, subject_table, subject_id, severity, state,
             owner_team_id, raised_on, due_on)
          VALUES (${ctx.tenantId}, ${capaCode}, 'Cold chain excursion', 'shipments', ${shipment.id},
                  'Major', 'open', ${shipment.owner_team_id}, ${ctx.today}, ${ctx.today}::date + 14)`;

        await recordAudit(t, auditOf(ctx), {
          kind: 'WORKFLOW', action: 'CAPA raised for a cold chain excursion',
          detail:
            `${capaCode} · ${shipment.code} (${shipment.order_code}) · ` +
            `${excursions.length} reading(s) outside ${shipment.temperature_class} °C, ` +
            `worst ${worst.celsius} °C`,
          subjectTable: 'capa', subjectId: shipment.id,
        });
      }

      await recordAudit(t, auditOf(ctx), {
        kind: 'WORKFLOW', action: 'Cold chain readings recorded',
        detail: `${shipment.code} · ${parsed.data.readings.length} reading(s)` +
          (excursions.length > 0 ? ` · ${excursions.length} EXCURSION(S)` : ' · all within class'),
        subjectTable: 'shipments', subjectId: shipment.id,
      });

      return { status: 200 as const, excursions: excursions.length, capaCode };
    });

    if (out.status === 404) return sendProblem(reply, notFound('No such shipment.'));
    if (out.status === 422) return sendProblem(reply, unprocessable(out.message));
    return reply.send({ excursions: out.excursions, capaRaised: out.capaCode });
  });

  /* ── The laboratory's vault ───────────────────────────────────────────── */

  app.get('/vault', async (req, reply) => {
    const ctx = await held(req, reply, ['vault:use']);
    if (!ctx) return;

    const rows = await txFor(ctx, (t) => t`
      SELECT v.id, v.quantity, v.storage_location, v.source,
             v.acquired_on, v.acquired_on_basis,
             l.lot_code, l.expiry_date, l.storage_condition, l.state AS lot_state,
             p.material_name, p.cas_number,
             c.id AS certificate_id, c.code AS certificate_code,
             i.issue_number, i.withdrawn, i.verification_token,
             i.assigned_value, i.expanded_uncertainty, i.unit, i.property_name
      FROM lotmark.vault_holdings v
      JOIN lotmark.lots l ON l.id = v.lot_id
      JOIN lotmark.projects p ON p.id = l.project_id
      LEFT JOIN lotmark.certificates c ON c.lot_id = l.id
      LEFT JOIN LATERAL (
        SELECT issue_number, withdrawn, verification_token,
               assigned_value, expanded_uncertainty, unit, property_name
        FROM lotmark.certificate_issues ci
        WHERE ci.certificate_id = c.id
        ORDER BY ci.issue_number DESC LIMIT 1
      ) i ON true
      WHERE v.tenant_id = ${ctx.tenantId} AND v.quantity > 0
      ORDER BY l.expiry_date`);

    return reply.send({
      holdings: rows,
      organisation: ctx.organisation.name,
      /** The public verification origin, so a holder can check without an account. */
      verifyOrigin: cfg.PUBLIC_ORIGIN,
    });
  });
}
