import type { FastifyInstance } from 'fastify';
import {
  oneWayAnova, linearStability, consensus, combineBudget,
  shelfLifeMonthsBetween, expandedUncertainty,
  type UncertaintyComponent,
} from '@lotmark/stats';
import { teamsWherePermitted } from '@lotmark/domain';
import { inTenantTransaction, inTenantAsOf } from '../db';
import { requireSession } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { forbidden, invalidRequest, notFound, sendProblem, unprocessable } from '../http/problem';

export async function registerConsoleRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;

  /**
   * Projects, filtered by what the caller may actually see.
   *
   * The filter is derived from the SAME authority object the guard uses, so a
   * list can never show a row the caller would be refused on opening. Building
   * the WHERE clause from `teamsWherePermitted` rather than hand-writing it is
   * what keeps the two in step.
   */
  app.get('/projects', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const permitted = teamsWherePermitted(ctx.authority, 'project:read');
    if (permitted.length === 0) {
      // Not an error: the caller legitimately has visibility of nothing.
      return reply.send({ projects: [], scope: 'none' });
    }

    const rows = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      permitted.includes('*')
        ? tx`SELECT p.*, t.name AS team_name FROM lotmark.projects p
             LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
             WHERE p.tenant_id = ${ctx.tenantId} ORDER BY p.code`
        : tx`SELECT p.*, t.name AS team_name FROM lotmark.projects p
             LEFT JOIN lotmark.teams t ON t.id = p.owner_team_id
             WHERE p.tenant_id = ${ctx.tenantId} AND p.owner_team_id = ANY(${permitted as string[]})
             ORDER BY p.code`);

    return reply.send({
      projects: rows.map((r) => {
        const p = r as Record<string, unknown>;
        return {
          id: p['id'], code: p['code'], material: p['material_name'],
          cas: p['cas_number'], sku: p['sku'], stage: p['stage'], team: p['team_name'],
        };
      }),
      scope: permitted.includes('*') ? 'tenant' : 'teams',
    });
  });

  /**
   * A project's uncertainty budget, COMPUTED from raw measurements.
   *
   * Nothing here reads a stored summary. The assigned value on a certificate is
   * the consensus mean of a signed characterisation study's raw results, and
   * this endpoint recomputes it on demand — which is what makes the figure
   * reproducible rather than merely recorded.
   */
  app.get<{ Params: { id: string } }>('/projects/:id/budget', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [projectRow] = await tx`
        SELECT id, code, owner_team_id FROM lotmark.projects
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const project = projectRow as { id: string; code: string; owner_team_id: string | null } | undefined;
      if (!project) return { status: 404 as const };

      // Scope is taken from the LOADED record, never from the request.
      const verdict = decide({
        authority: ctx.authority,
        permission: 'project:read',
        scope: project.owner_team_id
          ? { kind: 'team', teamId: project.owner_team_id }
          : { kind: 'tenant' },
        sodSettings: {},
        onDate: ctx.today,
      });
      if (!verdict.allowed) return { status: 403 as const, verdict };

      const studies = await tx`
        SELECT id, code, study_type, state, signed_on, shelf_life_to
        FROM lotmark.studies
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${project.id} AND state = 'signed'`;

      const components: UncertaintyComponent[] = [];
      for (const s of studies) {
        const st = s as { id: string; code: string; study_type: string; signed_on: string | null; shelf_life_to: string | null };
        const raw = await tx`
          SELECT unit_ref, replicate, elapsed_months, laboratory_ref, measured_value
          FROM lotmark.study_results WHERE study_id = ${st.id}`;
        if (raw.length === 0) continue;
        const rows = raw.map((r) => r as {
          unit_ref: number | null; replicate: number | null;
          elapsed_months: number | null; laboratory_ref: string | null; measured_value: number;
        });

        if (st.study_type === 'homogeneity') {
          const a = oneWayAnova(rows.map((r) => ({ unit: r.unit_ref!, replicate: r.replicate!, value: r.measured_value })));
          components.push({
            studyId: st.code, studyType: 'homogeneity', symbol: 'u(bb)', value: a.uBb,
            basis: `${a.units} units × ${a.replicatesPerUnit} replicates, one-way ANOVA` +
              (a.floored ? ', floored at the detection limit' : ''),
          });
        } else if (st.study_type === 'stability') {
          const months = st.shelf_life_to && st.signed_on
            ? shelfLifeMonthsBetween(st.signed_on, st.shelf_life_to) : 24;
          const r = linearStability(rows.map((x) => ({ months: x.elapsed_months!, value: x.measured_value })), months);
          components.push({
            studyId: st.code, studyType: 'stability', symbol: 'u(lts)', value: r.uLts,
            basis: `${r.n} timepoints, slope ${r.slope.toFixed(5)}/month` +
              `${r.trendSignificant ? ' (SIGNIFICANT)' : ' (not significant)'}, projected over ${months} months`,
          });
        } else if (st.study_type === 'characterisation') {
          const c = consensus(rows.map((x) => ({ laboratory: x.laboratory_ref!, value: x.measured_value })));
          components.push({
            studyId: st.code, studyType: 'characterisation', symbol: 'u(char)', value: c.uChar,
            basis: `${c.laboratories} laboratories, s = ${c.standardDeviation.toFixed(3)}`,
          });
        }
      }

      const budget = combineBudget(components);
      const charRows = studies.filter((s) => (s as { study_type: string }).study_type === 'characterisation');
      let assignedValue: number | null = null;
      if (charRows[0]) {
        const raw = await tx`
          SELECT laboratory_ref, measured_value FROM lotmark.study_results
          WHERE study_id = ${(charRows[0] as { id: string }).id}`;
        if (raw.length > 0) {
          assignedValue = consensus(raw.map((r) => {
            const x = r as { laboratory_ref: string; measured_value: number };
            return { laboratory: x.laboratory_ref, value: x.measured_value };
          })).value;
        }
      }

      return {
        status: 200 as const,
        body: {
          project: { id: project.id, code: project.code },
          assignedValue,
          budget: {
            uBb: budget.uBb, uLts: budget.uLts, uChar: budget.uChar,
            uCombined: budget.uCombined, complete: budget.complete,
            expanded: budget.uCombined !== null ? expandedUncertainty(budget.uCombined, 2) : null,
            coverageFactor: 2,
          },
          components: budget.components,
        },
      };
    });

    if (result.status === 404) return sendProblem(reply, notFound('No such project.'));
    if (result.status === 403) {
      return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
    }
    return reply.send(result.body);
  });


  /** Studies for a project, with their state — the console's work list. */
  app.get<{ Params: { id: string } }>('/projects/:id/studies', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const out = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [projectRow] = await tx`
        SELECT id, owner_team_id FROM lotmark.projects
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const project = projectRow as { id: string; owner_team_id: string | null } | undefined;
      if (!project) return null;

      const verdict = decide({
        authority: ctx.authority, permission: 'project:read',
        scope: project.owner_team_id ? { kind: 'team', teamId: project.owner_team_id } : { kind: 'tenant' },
        sodSettings: {}, onDate: ctx.today,
      });
      if (!verdict.allowed) return { forbidden: verdict };

      const rows = await tx`
        SELECT id, code, study_type, state, uncertainty, signed_on, shelf_life_to
        FROM lotmark.studies
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${project.id}
        ORDER BY code`;
      return { studies: rows.map((r) => {
        const s = r as Record<string, unknown>;
        return {
          id: s['id'], code: s['code'], type: s['study_type'], state: s['state'],
          uncertainty: s['uncertainty'], signedOn: s['signed_on'],
        };
      }) };
    });

    if (!out) return sendProblem(reply, notFound('No such project.'));
    if ('forbidden' in out) return sendProblem(reply, forbidden(out.forbidden.reason, out.forbidden.message));
    return reply.send(out);
  });


  /**
   * The register as it stood on a date.
   *
   * The question an assessor actually asks. Note that the guard above is
   * evaluated against ctx.today — the REAL date — and never against the as-of
   * date: reading history is a present-tense act, and authorising it against a
   * past date would let somebody read on the strength of access they have since
   * lost.
   */
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/projects/:id/as-of', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendProblem(reply, invalidRequest('Supply ?date=YYYY-MM-DD.'));
    }

    // Authorisation FIRST, at the present moment, on its own transaction —
    // before the session is put into the past and becomes read-only.
    const project = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [row] = await tx`
        SELECT id, code, owner_team_id FROM lotmark.projects
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      return row as { id: string; code: string; owner_team_id: string | null } | undefined;
    });
    if (!project) return sendProblem(reply, notFound('No such project.'));

    const verdict = decide({
      authority: ctx.authority, permission: 'project:read',
      scope: project.owner_team_id ? { kind: 'team', teamId: project.owner_team_id } : { kind: 'tenant' },
      sodSettings: {},
      // ctx.today, deliberately — not the requested date.
      onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    try {
      const body = await inTenantAsOf(db,
        { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY, asOf: date },
        async (tx) => {
          const studies = await tx`
            SELECT s.code, s.study_type, s.state, s.uncertainty, s.signed_on,
                   u.display_name AS signed_by,
                   -- Was the signer authorised ON THE DAY, not today?
                   (SELECT count(*) > 0 FROM lotmark.competence_as_of(s.signed_by_user_id, 'study:sign'))
                     AS signer_was_competent
            FROM lotmark.studies s
            LEFT JOIN lotmark.users u ON u.id = s.signed_by_user_id
            WHERE s.tenant_id = ${ctx.tenantId} AND s.project_id = ${project.id}
              AND s.created_at::date <= lotmark.effective_date()
            ORDER BY s.code`;

          const lots = await tx`
            SELECT l.lot_code, lotmark.lot_state_as_of(l.id) AS state_then, l.expiry_date
            FROM lotmark.lots l
            WHERE l.tenant_id = ${ctx.tenantId} AND l.project_id = ${project.id}
              AND l.created_at::date <= lotmark.effective_date()
            ORDER BY l.lot_code`;

          return {
            project: { id: project.id, code: project.code },
            asOf: date,
            studies,
            // A lot with no state as at the date did not exist yet.
            lots: lots.filter((l) => (l as { state_then: string | null }).state_then !== null),
          };
        });
      return reply.send(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('in the future')) {
        return sendProblem(reply, unprocessable('That date is in the future; the records cannot answer it.'));
      }
      throw e;
    }
  });

  /** The audit ledger, newest first. */
  app.get<{ Querystring: { limit?: string } }>('/audit', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const verdict = decide({
      authority: ctx.authority, permission: 'audit:read',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const rows = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      tx`SELECT seq, occurred_at, actor_label, actor_role_id, kind, action, detail, time_source, region
         FROM lotmark.audit_ledger WHERE tenant_id = ${ctx.tenantId}
         ORDER BY seq DESC LIMIT ${limit}`);

    return reply.send({ entries: rows });
  });

  /**
   * Verify the chain.
   *
   * A separate permission from reading it: seeing what happened and attesting
   * that the record is intact are different acts, and the second is the one an
   * assessor asks the Quality Manager to perform.
   */
  app.post('/audit/verify', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const verdict = decide({
      authority: ctx.authority, permission: 'audit:verify',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    const result = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      // Retired keys, so history written before a rotation can actually be
      // verified rather than reported as unverified.
      auditKeys: cfg.LOTMARK_AUDIT_KEYS,
    }, async (tx) => {
      const [row] = await tx`SELECT * FROM lotmark.verify_audit_chain(${ctx.tenantId})`;
      const v = row as {
        ok: boolean; entries: string; broken_at: string | null; reason: string | null;
        generations: string[]; keys_missing: string[];
      };
      // Running a verification is itself an auditable act — and it appends to
      // the very chain it just checked, which is correct: the next verification
      // covers this one.
      /**
       * An UNVERIFIED chain is not a broken one.
       *
       * `keys_missing` means the verifier does not hold a retired generation's
       * key. Writing "BROKEN" into the ledger for that would be a false alarm
       * recorded permanently, on the one record that must never overstate.
       */
      const unverified = v.keys_missing.length > 0;
      await recordAudit(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
        actorRoleId: '—', sessionId: ctx.sessionId,
        timeSource: ctx.timeSource, region: ctx.region,
      }, {
        kind: 'SYSTEM', action: 'Audit chain verification run',
        detail: v.ok
          ? `intact across ${v.entries} entries (generation${v.generations.length === 1 ? '' : 's'} ${v.generations.join(', ')})`
          : unverified
            ? `UNVERIFIED: no key held for generation ${v.keys_missing.join(', ')}`
            : `BROKEN at ${v.broken_at}: ${v.reason}`,
      });
      return v;
    });

    const unverified = result.keys_missing.length > 0;
    return reply.send({
      ok: result.ok,
      entries: Number(result.entries),
      brokenAt: result.broken_at ? Number(result.broken_at) : null,
      reason: result.reason,
      /** Which key generations the checked range spans. */
      generations: result.generations,
      /**
       * Generations whose key the server does not hold. Non-empty means the
       * answer is "not checked", NOT "tampered with" — a distinction the
       * console renders differently because the two call for opposite responses.
       */
      keysMissing: result.keys_missing,
      unverified,
    });
  });
}

