import type { FastifyInstance } from 'fastify';
import { teamsWherePermitted, type Permission } from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { requireSession } from '../plugins/session';

/**
 * The jump-to-code index behind the command palette (⌘K).
 *
 * Everything in this system is cited by a human-facing code — PRJ-0412,
 * RMP-PARA-0421, CRT-2041, NCR-0231, ORD-3401 — in CAPAs, emails and audits,
 * and until this existed there was no way to go from a code back to the record:
 * you scanned the Projects table and drilled down. This returns every code the
 * caller may see, scoped the same way each surface is, and the palette filters
 * it as they type. Returning the whole index rather than a server-side `q`
 * filter keeps the demo (whose adapter drops the query string) and the product
 * behaving identically, and the index is bounded — a producer's codes number in
 * the hundreds, not millions.
 */

interface Proj {
  id: string; code: string; material: string;
  cas: string | null; sku: string; stage: string; team: string | null;
}
interface SearchItem {
  kind: 'project' | 'lot' | 'study' | 'value' | 'certificate' | 'capa' | 'order';
  code: string;
  label: string;
  detail: string;
  surface: string;
  project?: Proj;
}

const CAP = 300;

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  app.get('/search', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const teams = (perm: Permission) => {
      const t = teamsWherePermitted(ctx.authority, perm);
      return { held: t.length > 0, all: t.includes('*'), ids: t.includes('*') ? [] : (t as string[]) };
    };
    const proj = teams('project:read');
    const capa = teams('capa:manage');
    const ordersAll = teams('order:read_all');
    const ordersOwn = teams('order:read_own');

    const data = await inTenantTransaction(
      db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
        // The project columns every project-scoped row carries, so the palette
        // can OPEN the project rather than just land on the Projects list.
        const pFilter = proj.all ? tx`TRUE` : tx`p.owner_team_id = ANY(${proj.ids})`;

        const projects = proj.held ? await tx`
          SELECT p.id, p.code, p.material_name, p.cas_number, p.sku, p.stage, t.name AS team
          FROM lotmark.projects p LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
          WHERE p.tenant_id = ${ctx.tenantId} AND ${pFilter}
          ORDER BY p.code LIMIT ${CAP}` : [];

        const lots = proj.held ? await tx`
          SELECT l.lot_code, l.state, p.id AS pid, p.code AS pcode, p.material_name, p.cas_number,
                 p.sku, p.stage, t.name AS team
          FROM lotmark.lots l JOIN lotmark.projects p ON p.id = l.project_id
          LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
          WHERE l.tenant_id = ${ctx.tenantId} AND ${pFilter}
          ORDER BY l.lot_code DESC LIMIT ${CAP}` : [];

        const studies = proj.held ? await tx`
          SELECT s.code, s.study_type, s.state, p.id AS pid, p.code AS pcode, p.material_name,
                 p.cas_number, p.sku, p.stage, t.name AS team
          FROM lotmark.studies s JOIN lotmark.projects p ON p.id = s.project_id
          LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
          WHERE s.tenant_id = ${ctx.tenantId} AND ${pFilter}
          ORDER BY s.code LIMIT ${CAP}` : [];

        const values = proj.held ? await tx`
          SELECT v.code, v.property_name, p.id AS pid, p.code AS pcode, p.material_name,
                 p.cas_number, p.sku, p.stage, t.name AS team
          FROM lotmark.property_values v JOIN lotmark.projects p ON p.id = v.project_id
          LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
          WHERE v.tenant_id = ${ctx.tenantId} AND ${pFilter}
          ORDER BY v.code LIMIT ${CAP}` : [];

        const certs = proj.held ? await tx`
          SELECT c.code, l.lot_code, p.id AS pid, p.code AS pcode, p.material_name, p.cas_number,
                 p.sku, p.stage, t.name AS team
          FROM lotmark.certificates c
          JOIN lotmark.lots l ON l.id = c.lot_id
          JOIN lotmark.projects p ON p.id = l.project_id
          LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
          WHERE c.tenant_id = ${ctx.tenantId} AND ${pFilter}
          ORDER BY c.code DESC LIMIT ${CAP}` : [];

        const capaRows = capa.held ? await tx`
          SELECT code, source, severity FROM lotmark.capa
          WHERE tenant_id = ${ctx.tenantId}
            AND ${capa.all ? tx`TRUE` : tx`owner_team_id = ANY(${capa.ids})`}
          ORDER BY code DESC LIMIT ${CAP}` : [];

        // Orders: everything for a dispatcher/QM (order:read_all), otherwise the
        // caller's own (order:read_own — a customer jumping to their own order).
        const orders = ordersAll.held ? await tx`
          SELECT code, state FROM lotmark.orders WHERE tenant_id = ${ctx.tenantId}
          ORDER BY code DESC LIMIT ${CAP}`
          : ordersOwn.held ? await tx`
          SELECT code, state FROM lotmark.orders
          WHERE tenant_id = ${ctx.tenantId} AND placed_by_user_id = ${ctx.userId}
          ORDER BY code DESC LIMIT ${CAP}` : [];

        return { projects, lots, studies, values, certs, capaRows, orders };
      });

    const r = (x: unknown) => x as Record<string, unknown>;
    const projOf = (row: Record<string, unknown>, idKey = 'pid', codeKey = 'pcode'): Proj => ({
      id: String(row[idKey]), code: String(row[codeKey]), material: String(row['material_name']),
      cas: (row['cas_number'] as string | null) ?? null, sku: String(row['sku']),
      stage: String(row['stage']), team: (row['team'] as string | null) ?? null,
    });

    const items: SearchItem[] = [
      ...data.projects.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'project', code: String(row['code']), label: String(row['material_name']),
          detail: `project${row['team'] ? ` · ${String(row['team'])}` : ''}`, surface: 'projects',
          project: {
            id: String(row['id']), code: String(row['code']), material: String(row['material_name']),
            cas: (row['cas_number'] as string | null) ?? null, sku: String(row['sku']),
            stage: String(row['stage']), team: (row['team'] as string | null) ?? null,
          },
        };
      }),
      ...data.lots.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'lot', code: String(row['lot_code']), label: String(row['material_name']),
          detail: `lot · ${String(row['state'])}`, surface: 'projects', project: projOf(row),
        };
      }),
      ...data.certs.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'certificate', code: String(row['code']), label: String(row['material_name']),
          detail: `certificate · lot ${String(row['lot_code'])}`, surface: 'projects', project: projOf(row),
        };
      }),
      ...data.studies.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'study', code: String(row['code']), label: String(row['material_name']),
          detail: `${String(row['study_type'])} study · ${String(row['state'])}`,
          surface: 'projects', project: projOf(row),
        };
      }),
      ...data.values.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'value', code: String(row['code']), label: String(row['property_name']),
          detail: `value · ${String(row['pcode'])}`, surface: 'projects', project: projOf(row),
        };
      }),
      ...data.capaRows.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'capa', code: String(row['code']), label: String(row['source']),
          detail: `${String(row['severity'])} CAPA`, surface: 'capa',
        };
      }),
      ...data.orders.map((x): SearchItem => {
        const row = r(x);
        return {
          kind: 'order', code: String(row['code']), label: `Order ${String(row['code'])}`,
          detail: `order · ${String(row['state'])}`, surface: 'orders',
        };
      }),
    ];

    return reply.send({ items });
  });
}
