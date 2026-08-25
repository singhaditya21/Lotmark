import type { FastifyInstance } from 'fastify';
import { teamsWherePermitted, type Permission } from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { requireSession } from '../plugins/session';

/**
 * The home surface: what is waiting on this person, right now.
 *
 * ── Why this is one endpoint and not the console adding up its screens ───────
 *
 * The pending work is scattered across six surfaces — a study awaiting a
 * signature, a value awaiting authorisation, a released lot with no certificate,
 * an open CAPA, an order to dispatch — and until this existed the only way to
 * find any of it was to open each section and look. The console cannot add it up
 * itself either: it reads studies, values and lots ONE PROJECT AT A TIME, so a
 * client-side total would have to walk every project, and would still miss the
 * scoping. One query per kind, decided here, is both correct and cheap.
 *
 * ── Scoped to what you can ACT on, not merely see ────────────────────────────
 *
 * Each count is filtered by the permission that would let this person clear it —
 * `study:sign` for a draft study, `value:authorise` for an assigned value — so a
 * bench scientist who cannot sign is not shown a pile of signatures that are not
 * theirs to make. That is what makes this an inbox rather than a dashboard.
 * Nothing here authorises anything; every act is still re-decided at its route.
 */

interface Item {
  kind: 'study' | 'value' | 'lot' | 'capa' | 'order';
  code: string;
  title: string;
  detail: string;
  surface: string;
  overdue?: boolean;
}

export async function registerHomeRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  app.get('/home', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const scoped = (perm: Permission) => {
      const t = teamsWherePermitted(ctx.authority, perm);
      return { held: t.length > 0, all: t.includes('*'), teams: t.includes('*') ? [] : (t as string[]) };
    };
    const sign = scoped('study:sign');
    const auth = scoped('value:authorise');
    const cert = scoped('cert:issue');
    const capa = scoped('capa:manage');
    const dispatch = scoped('order:advance');

    const data = await inTenantTransaction(
      db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
        // Team filter as a composable fragment: TRUE for the tenant-wide holder,
        // an ANY() over their teams otherwise (empty array ⇒ nothing, correct
        // for a permission held nowhere).
        const studies = sign.held ? await tx`
          SELECT s.code, s.study_type, p.code AS project_code
          FROM lotmark.studies s JOIN lotmark.projects p ON p.id = s.project_id
          WHERE s.tenant_id = ${ctx.tenantId} AND s.state = 'draft'
            AND ${sign.all ? tx`TRUE` : tx`p.owner_team_id = ANY(${sign.teams})`}
          ORDER BY s.code` : [];

        const values = auth.held ? await tx`
          SELECT v.code, v.property_name, p.code AS project_code
          FROM lotmark.property_values v JOIN lotmark.projects p ON p.id = v.project_id
          WHERE v.tenant_id = ${ctx.tenantId} AND v.state = 'assigned'
            AND ${auth.all ? tx`TRUE` : tx`p.owner_team_id = ANY(${auth.teams})`}
          ORDER BY v.code` : [];

        const lots = cert.held ? await tx`
          SELECT l.lot_code, p.code AS project_code
          FROM lotmark.lots l JOIN lotmark.projects p ON p.id = l.project_id
          WHERE l.tenant_id = ${ctx.tenantId} AND l.state = 'released'
            AND NOT EXISTS (SELECT 1 FROM lotmark.certificates c WHERE c.lot_id = l.id)
            AND ${cert.all ? tx`TRUE` : tx`l.owner_team_id = ANY(${cert.teams})`}
          ORDER BY l.lot_code` : [];

        const capaRows = capa.held ? await tx`
          SELECT code, severity, due_on, (due_on IS NOT NULL AND due_on < ${ctx.today}) AS overdue
          FROM lotmark.capa
          WHERE tenant_id = ${ctx.tenantId} AND closed_at IS NULL
            AND ${capa.all ? tx`TRUE` : tx`owner_team_id = ANY(${capa.teams})`}
          ORDER BY overdue DESC, due_on NULLS LAST, code` : [];

        // Orders carry no team (a customer places them against the producer), so
        // they are gated on holding order:advance at all, then shown tenant-wide.
        const orders = dispatch.held ? await tx`
          SELECT code, state FROM lotmark.orders
          WHERE tenant_id = ${ctx.tenantId} AND state IN ('placed', 'packed')
          ORDER BY placed_on, code` : [];

        return { studies, values, lots, capaRows, orders };
      });

    const s = (r: unknown) => r as Record<string, unknown>;
    const attention: Item[] = [
      ...data.capaRows
        .filter((r) => s(r)['overdue'] === true)
        .map((r): Item => ({
          kind: 'capa', code: String(s(r)['code']),
          title: `${String(s(r)['severity'])} CAPA overdue`,
          detail: `was due ${String(s(r)['due_on'])}`, surface: 'capa', overdue: true,
        })),
      ...data.studies.map((r): Item => ({
        kind: 'study', code: String(s(r)['code']),
        title: `Study awaiting your signature`,
        detail: `${String(s(r)['study_type'])} · ${String(s(r)['project_code'])}`, surface: 'projects',
      })),
      ...data.values.map((r): Item => ({
        kind: 'value', code: String(s(r)['code']),
        title: `Value awaiting authorisation`,
        detail: `${String(s(r)['property_name'])} · ${String(s(r)['project_code'])}`, surface: 'projects',
      })),
      ...data.lots.map((r): Item => ({
        kind: 'lot', code: String(s(r)['lot_code']),
        title: `Released lot with no certificate`,
        detail: String(s(r)['project_code']), surface: 'projects',
      })),
      ...data.orders.map((r): Item => ({
        kind: 'order', code: String(s(r)['code']),
        title: `Order to ${s(r)['state'] === 'placed' ? 'pack' : 'dispatch'}`,
        detail: String(s(r)['state']), surface: 'orders',
      })),
      ...data.capaRows
        .filter((r) => s(r)['overdue'] !== true)
        .map((r): Item => ({
          kind: 'capa', code: String(s(r)['code']),
          title: `Open CAPA`,
          detail: s(r)['due_on'] ? `due ${String(s(r)['due_on'])}` : 'no due date', surface: 'capa',
        })),
    ];

    return reply.send({
      attention,
      summary: {
        studiesToSign: data.studies.length,
        valuesToAuthorise: data.values.length,
        lotsToCertify: data.lots.length,
        capaOpen: data.capaRows.length,
        capaOverdue: data.capaRows.filter((r) => s(r)['overdue'] === true).length,
        ordersToDispatch: data.orders.length,
      },
    });
  });
}
