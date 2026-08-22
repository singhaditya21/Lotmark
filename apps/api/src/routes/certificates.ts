import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSignatureMeaning, defaultSodSettings, type SignatureMeaning, type AuthScope } from '@lotmark/domain';
import { inTenantTransaction } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { activeConfigVersionId } from '../services/config-admin';
import { recordAudit } from '../services/audit';
import { applySignature, rejectSigning, SigningRejection } from '../services/signing';
import { refuseSigning } from '../services/signing-refusal';
import { loadLiveSession, hashToken, SESSION_COOKIE } from '../services/sessions';
import { renderAndStoreIssue, notifyHolders, resolveRecipient } from '../services/certificate-issue';
import { sendProblem, notFound, conflict, unprocessable, invalidRequest, forbidden, sessionExpired } from '../http/problem';

const reissueBody = z.object({
  meaning: z.string().refine(isSignatureMeaning),
  reason: z.string().min(1, 'A reissue must state why.').max(1000),
});

const withdrawBody = z.object({
  reason: z.string().min(1, 'A withdrawal must state why.').max(1000),
});

/**
 * Reissue and withdrawal.
 *
 * The product's central safety obligation. If a certified value turns out to be
 * wrong, every holder must be told — and "every holder" means order lines UNION
 * self-declared vault holdings, because a vial received as a sample or a
 * replacement has no order line behind it.
 *
 * A reissue never overwrites. Issue 1 remains verifiable forever, which is what
 * makes "what did the certificate say when we tested against it" answerable
 * years later.
 */
export async function registerCertificateRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys, documents } = app;

  const auditOf = (ctx: RequestContext) => ({
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  });

  /* ── The issue history ────────────────────────────────────────────────── */

  /**
   * A certificate and every issue of it.
   *
   * Gated on `project:read` against the OWNING TEAM, taken from the loaded lot
   * rather than from the request. Reading a certificate's history is reading
   * the project's record; it is not a separate privilege.
   *
   * Issue 1 stays here forever. That is the point of a reissue never
   * overwriting: "what did the certificate say when we tested against it" has
   * to remain answerable years later, and this endpoint is how the console
   * shows it.
   */
  app.get<{ Params: { id: string } }>('/certificates/:id', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const out = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      // Reissue and withdrawal write notifications for holders across every
      // customer organisation, so they act on the producer's side. Without it
      // the 0022 policies fail closed and the notices reach nobody — see db.ts.
      organisationKind: 'producer',
    }, async (tx) => {
      const [certRow] = await tx`
        SELECT c.id, c.code, c.lot_id, l.lot_code, l.state AS lot_state, l.owner_team_id
        FROM lotmark.certificates c JOIN lotmark.lots l ON l.id = c.lot_id
        WHERE c.tenant_id = ${ctx.tenantId} AND c.id = ${req.params.id} LIMIT 1`;
      const cert = certRow as {
        id: string; code: string; lot_id: string; lot_code: string;
        lot_state: string; owner_team_id: string | null;
      } | undefined;
      if (!cert) return null;

      const verdict = decide({
        authority: ctx.authority, permission: 'project:read',
        scope: cert.owner_team_id ? { kind: 'team', teamId: cert.owner_team_id } : { kind: 'tenant' },
        sodSettings: {}, onDate: ctx.today,
      });
      if (!verdict.allowed) return { forbidden: verdict };

      const rows = await tx`
        SELECT i.issue_number, i.issued_at, i.reissue_reason,
               i.withdrawn, i.withdrawn_at, i.withdrawn_reason,
               i.property_name, i.assigned_value, i.expanded_uncertainty,
               i.coverage_factor, i.unit, i.document_sha256, i.verification_token,
               u.display_name AS issued_by
        FROM lotmark.certificate_issues i
        LEFT JOIN lotmark.users u ON u.id = i.issued_by_user_id
        WHERE i.certificate_id = ${cert.id}
        ORDER BY i.issue_number`;

      const issues = rows.map((r) => r as Record<string, unknown>);
      // The current issue is the highest-numbered one that has not been
      // withdrawn. A withdrawn latest issue leaves the certificate with NO
      // current issue, which is a distinct state from "superseded" and the one
      // a holder most needs to see.
      const latest = issues.at(-1);
      const current = latest && latest['withdrawn'] !== true
        ? Number(latest['issue_number']) : null;

      return {
        certificate: {
          id: cert.id, code: cert.code,
          lotId: cert.lot_id, lotCode: cert.lot_code, lotState: cert.lot_state,
        },
        currentIssue: current,
        issues: issues.map((i) => ({
          number: Number(i['issue_number']),
          issuedAt: i['issued_at'],
          issuedBy: i['issued_by'],
          reissueReason: i['reissue_reason'],
          withdrawn: i['withdrawn'] === true,
          withdrawnAt: i['withdrawn_at'],
          withdrawnReason: i['withdrawn_reason'],
          propertyName: i['property_name'],
          assignedValue: i['assigned_value'],
          expandedUncertainty: i['expanded_uncertainty'],
          coverageFactor: i['coverage_factor'],
          unit: i['unit'],
          documentSha256: i['document_sha256'],
          verificationToken: i['verification_token'],
        })),
      };
    });

    if (!out) return sendProblem(reply, notFound('No such certificate.'));
    if ('forbidden' in out) return sendProblem(reply, forbidden(out.forbidden.reason, out.forbidden.message));
    return reply.send(out);
  });

  /* ── Holders of an issue ──────────────────────────────────────────────── */

  /**
   * Who holds this issue.
   *
   * ── Why two permissions are accepted ────────────────────────────────────
   *
   * This required `order:read_all`, which the Technical Manager does not hold —
   * so the one person authorised to reissue or withdraw a certificate could not
   * see who would be told. Asking somebody to withdraw a document without
   * showing them who is relying on it is asking them to act blind on the
   * product's most consequential path.
   *
   * Holding `cert:reissue` is therefore sufficient. That is not a widening of
   * commercial visibility: it is the recognition that the holder list is part
   * of the reissue act, not part of the order book.
   *
   * ── Why contact details are separate ────────────────────────────────────
   *
   * `contact_user_id` identifies a PERSON at the holding organisation, and
   * seeing it is `pii:contact` — a permission the Technical Manager also does
   * not hold, and does not need. She needs to know WHICH LABORATORIES are
   * affected in order to judge the impact; she does not need to know who works
   * there. The previous version returned the raw function rows, so anyone
   * reaching this endpoint got the contact whether or not they were entitled
   * to it.
   */
  app.get<{ Params: { id: string; n: string } }>('/certificates/:id/issues/:n/holders', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    /**
     * The owning team, loaded before anything is decided.
     *
     * The first version of this asked for `cert:reissue` at TENANT scope and
     * refused the Technical Manager, whose authority is granted on the Organics
     * Section rather than across the producer — so the screen told her she was
     * not permitted to see holders of a certificate she is permitted to
     * withdraw. `can()` was right; the question was wrong.
     *
     * This is the rule the rest of the codebase already follows: the scope comes
     * from the LOADED RECORD, never from the request and never assumed.
     */
    const owner = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      // Reissue and withdrawal write notifications for holders across every
      // customer organisation, so they act on the producer's side. Without it
      // the 0022 policies fail closed and the notices reach nobody — see db.ts.
      organisationKind: 'producer',
    }, async (tx) => {
      const [row] = await tx`
        SELECT l.owner_team_id
        FROM lotmark.certificates c JOIN lotmark.lots l ON l.id = c.lot_id
        WHERE c.tenant_id = ${ctx.tenantId} AND c.id = ${req.params.id} LIMIT 1`;
      return row as { owner_team_id: string | null } | undefined;
    });
    if (!owner) return sendProblem(reply, notFound('No such certificate.'));

    const certScope: AuthScope = owner.owner_team_id
      ? { kind: 'team', teamId: owner.owner_team_id } : { kind: 'tenant' };

    const asReissuer = decide({
      authority: ctx.authority, permission: 'cert:reissue',
      scope: certScope, sodSettings: {}, onDate: ctx.today,
    });
    // Commercial visibility is tenant-wide by nature: the order book is not
    // owned by the laboratory section that made the material.
    const asCommercial = decide({
      authority: ctx.authority, permission: 'order:read_all',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!asReissuer.allowed && !asCommercial.allowed) {
      // Report the commercial denial: it is the one that names the permission
      // most callers of this endpoint are expected to hold.
      return sendProblem(reply, forbidden(asCommercial.reason, asCommercial.message));
    }

    const maySeeContacts = decide({
      authority: ctx.authority, permission: 'pii:contact',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    }).allowed;

    const rows = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      // Reissue and withdrawal write notifications for holders across every
      // customer organisation, so they act on the producer's side. Without it
      // the 0022 policies fail closed and the notices reach nobody — see db.ts.
      organisationKind: 'producer',
    }, async (tx) => {
      const holders = (await tx`
        SELECT * FROM lotmark.certificate_holders(${req.params.id}, ${Number(req.params.n)})`
      ) as unknown as Array<Record<string, unknown> & { organisation_id: string; contact_user_id: string | null }>;

      // Reachability comes from the code that actually addresses the notices,
      // not from a second guess at the same rule.
      const reachable = new Map<string, boolean>();
      for (const h of holders) {
        reachable.set(h.organisation_id, (await resolveRecipient(tx, ctx.tenantId, h)) !== null);
      }

      if (maySeeContacts && holders.length > 0) {
        // Reading contact details is itself an auditable act under DPDP.
        await recordAudit(tx, auditOf(ctx), {
          kind: 'PII', action: 'Certificate holder contacts read',
          detail: `${holders.length} holder(s) of issue #${req.params.n}`,
          subjectTable: 'certificates', subjectId: req.params.id,
        });
      }
      return holders.map((h) => ({
        organisationId: h.organisation_id,
        organisation: h['organisation_name'] as string,
        quantity: Number(h['quantity']),
        basis: h['basis'] as string,
        /**
         * Whether a notice would actually reach somebody — computed by the
         * same function that sends them, never inferred from whether a named
         * contact happens to be recorded.
         */
        reachable: reachable.get(h.organisation_id) === true,
        // Present only when the caller is entitled to it.
        ...(maySeeContacts ? { contactUserId: h.contact_user_id } : {}),
      }));
    });

    return reply.send({
      holders: rows,
      unreachableCount: rows.filter((h) => !h.reachable).length,
      contactsVisible: maySeeContacts,
    });
  });

  /* ── Reissue ──────────────────────────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/certificates/:id/reissue', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = reissueBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid request.'));
    }
    const token = req.cookies[SESSION_COOKIE]!;

    const result = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      // Reissue and withdrawal write notifications for holders across every
      // customer organisation, so they act on the producer's side. Without it
      // the 0022 policies fail closed and the notices reach nobody — see db.ts.
      organisationKind: 'producer',
    }, async (tx) => {
      const [certRow] = await tx`
        SELECT c.id, c.code, c.lot_id, l.project_id, l.owner_team_id
        FROM lotmark.certificates c JOIN lotmark.lots l ON l.id = c.lot_id
        WHERE c.tenant_id = ${ctx.tenantId} AND c.id = ${req.params.id} FOR UPDATE OF c`;
      const cert = certRow as {
        id: string; code: string; lot_id: string; project_id: string; owner_team_id: string | null;
      } | undefined;
      if (!cert) return { status: 404 as const };

      const scope: AuthScope = cert.owner_team_id
        ? { kind: 'team', teamId: cert.owner_team_id } : { kind: 'tenant' };

      // Resolve competence FIRST, then decide once. An earlier revision ran
      // decide() twice — once with a null basis and again with the real one —
      // which is a guard evaluated on data it did not have.
      const [compRow] = await tx`
        SELECT id, activity, valid_from, valid_to FROM lotmark.competence_records
        WHERE tenant_id = ${ctx.tenantId} AND user_id = ${ctx.userId} AND activity = 'cert:issue'
          AND superseded_at IS NULL AND valid_from <= ${ctx.today} AND valid_to >= ${ctx.today}
        LIMIT 1`;
      const comp = compRow as { id: string; activity: string; valid_from: string; valid_to: string } | undefined;
      const basis = comp ? {
        competenceRecordId: comp.id, activity: comp.activity,
        validFrom: comp.valid_from, validTo: comp.valid_to,
        checkedOn: ctx.today, personUserId: ctx.userId,
      } : null;

      const realVerdict = decide({
        authority: ctx.authority, permission: 'cert:reissue', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
        requiresCompetence: 'cert:issue', competenceFor: () => basis,
        requiresSignature: true,
      });

      if (!realVerdict.allowed) {
        await recordAudit(tx, auditOf(ctx), {
          kind: 'DENY', action: 'Certificate reissue refused',
          detail: `${cert.code}: ${realVerdict.message}`,
          subjectTable: 'certificates', subjectId: cert.id, changes: realVerdict.detail,
        });
        return { status: 403 as const, verdict: realVerdict };
      }

      const [prevRow] = await tx`
        SELECT issue_number, assigned_value, expanded_uncertainty, coverage_factor, unit, property_name
        FROM lotmark.certificate_issues
        WHERE certificate_id = ${cert.id} ORDER BY issue_number DESC LIMIT 1`;
      const prev = prevRow as {
        issue_number: number; assigned_value: number; expanded_uncertainty: number;
        coverage_factor: number; unit: string; property_name: string;
      } | undefined;
      if (!prev) return { status: 422 as const, message: 'This certificate has no issue to reissue from.' };

      const [pvRow] = await tx`
        SELECT property_name, unit, assigned_value, expanded_uncertainty, coverage_factor, components
        FROM lotmark.property_values
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${cert.project_id} AND state = 'authorised'
        ORDER BY authorised_at DESC LIMIT 1`;
      const pv = pvRow as {
        property_name: string; unit: string; assigned_value: number;
        expanded_uncertainty: number; coverage_factor: number;
        components: Array<{ symbol: string; value: number; basis: string }>;
      } | undefined;
      if (!pv) return { status: 422 as const, message: 'No authorised property value to reissue from.' };
      // A value whose uncertainty was never computed cannot be certified. This
      // surfaced as a 500 on a NOT NULL violation, which tells the operator
      // nothing about what to do next.
      if (pv.assigned_value == null || pv.expanded_uncertainty == null) {
        return {
          status: 422 as const,
          message: 'The authorised value carries no computed uncertainty. ' +
            'Re-assign it so the budget is recomputed before reissuing.',
        };
      }

      const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return { status: 401 as const, message: 'Your session has ended.' };
      const key = await keys.active(tx, ctx.tenantId, (m) => app.log.info(m));

      const issueNumber = prev.issue_number + 1;
      /**
       * The configuration version this issue was produced under.
       *
       * The column has existed since 0001 with an FK, the seed populates it,
       * and `routes/create.ts` stamps it on projects, studies and values — and
       * both routes that issue a CERTIFICATE omitted it, which is the record
       * where provenance matters most. Without it "under what rules was this
       * certificate issued" is answerable only by guessing from dates, in a
       * table nobody may rewrite.
       */
      const configVersionId = await activeConfigVersionId(tx, ctx.tenantId);

      const [issueRow] = await tx`
        INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty,
           coverage_factor, property_name, unit, issued_by_user_id, issued_at, reissue_reason,
           config_version_id)
        VALUES (${ctx.tenantId}, ${cert.id}, ${issueNumber}, ${pv.assigned_value},
                ${pv.expanded_uncertainty}, ${pv.coverage_factor}, ${pv.property_name},
                ${pv.unit}, ${ctx.userId}, now(), ${parsed.data.reason},
                ${configVersionId})
        RETURNING id`;
      const issueId = (issueRow as { id: string }).id;

      let signature;
      try {
        signature = await applySignature(tx, {
          tenantId: ctx.tenantId,
          signable: {
            kind: 'certificate',
            record: {
              certificateId: cert.code, lotId: cert.lot_id, issueNumber,
              value: pv.assigned_value, expandedUncertainty: pv.expanded_uncertainty,
            },
          },
          subjectId: issueId, signerUserId: ctx.userId,
          meaning: parsed.data.meaning as SignatureMeaning,
          session, signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
          competenceBasis: realVerdict.competenceBasis, requiresCompetence: true,
          key, timeSource: ctx.timeSource, region: ctx.region,
        });
      } catch (e) {
        /**
         * THROWS, never returns.
         *
         * Returning a status object from inside the transaction callback
         * resolves it, and postgres.js COMMITS a callback that resolves. That
         * committed the record inserted moments earlier without its signature —
         * see SigningRejection for what that produced. Throwing rolls it back;
         * the refusal is recorded afterwards, outside the dead transaction.
         */
        rejectSigning(e, { table: 'certificate_issues', label: `${cert.code} issue #${issueNumber}` });
      }

      const rendered = await renderAndStoreIssue(tx, documents, {
        tenantId: ctx.tenantId, issueId, certificateCode: cert.code, issueNumber,
        lotId: cert.lot_id, projectId: cert.project_id,
        value: {
          propertyName: pv.property_name, assignedValue: pv.assigned_value,
          expandedUncertainty: pv.expanded_uncertainty, coverageFactor: pv.coverage_factor,
          unit: pv.unit, components: pv.components ?? [],
        },
        issuedByName: ctx.displayName, signedAt: signature.signedAt,
        signatureMeaning: signature.meaning, key, reissueReason: parsed.data.reason,
      });

      /** What actually changed, so a holder is told rather than left to compare. */
      const diff: string[] = [];
      if (pv.assigned_value !== prev.assigned_value) {
        diff.push(`value ${prev.assigned_value} → ${pv.assigned_value}`);
      }
      if (pv.expanded_uncertainty !== prev.expanded_uncertainty) {
        diff.push(`U ${prev.expanded_uncertainty} → ${pv.expanded_uncertainty}`);
      }
      if (pv.coverage_factor !== prev.coverage_factor) {
        diff.push(`k ${prev.coverage_factor} → ${pv.coverage_factor}`);
      }
      const changeText = diff.length > 0 ? diff.join('; ') : 'no change to the certified figures';

      const notice = await notifyHolders(tx, {
        tenantId: ctx.tenantId, certificateId: cert.id, issueNumber: prev.issue_number,
        kind: 'reissue',
        subject: `${cert.code} has been reissued as issue #${issueNumber}`,
        body: `Reason: ${parsed.data.reason}. Change: ${changeText}. ` +
              `Replace issue #${prev.issue_number} in your records with issue #${issueNumber}.`,
      });

      await recordAudit(tx, auditOf(ctx), {
        kind: 'CERTIFICATE', action: 'Certificate reissued',
        detail: `${cert.code} #${prev.issue_number} → #${issueNumber} · ${parsed.data.reason} · ` +
          `${changeText} · ${notice.notified.length} holder(s) notified` +
          (notice.unreachable.length > 0
            ? ` · ${notice.unreachable.length} UNREACHABLE` : ''),
        subjectTable: 'certificate_issues', subjectId: issueId,
        changes: {
          from: prev.issue_number, to: issueNumber, diff,
          notified: notice.notified.length, unreachable: notice.unreachable.length,
        },
      });

      return {
        status: 200 as const,
        body: {
          certificate: cert.code,
          issue: { number: issueNumber, previous: prev.issue_number },
          changed: diff, changeSummary: changeText,
          document: { sha256: rendered.sha256, verifyUrl: `${cfg.PUBLIC_ORIGIN}/verify/${rendered.verificationToken}` },
          notified: notice.notified.map((h) => ({ organisation: h.organisation_name, basis: h.basis, quantity: Number(h.quantity) })),
          unreachable: notice.unreachable.map((h) => ({ organisation: h.organisation_name, basis: h.basis })),
        },
      };
    }).catch((e: unknown) => {
      // The transaction has already rolled back by the time this runs.
      if (e instanceof SigningRejection) return { status: 'refused' as const, rejection: e };
      throw e;
    });

    if (result.status === 'refused') {
      return refuseSigning({
        db, auditKey: cfg.LOTMARK_AUDIT_KEY, audit: auditOf(ctx),
        rejection: result.rejection, reply,
      });
    }

    switch (result.status) {
      case 404: return sendProblem(reply, notFound('No such certificate.'));
      case 403: return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
      case 422: return sendProblem(reply, unprocessable(result.message));
      // There is deliberately no 409 arm: the only conflict this route could
      // raise came from the signing step, which now throws so its transaction
      // rolls back. The compiler proves it — adding one back would not type.
      case 401:
        // An ENDED session, not a step-up. Reporting it as a step-up sent the
        // console to a re-authentication dialog whose own request would then
        // fail, telling the user the wrong thing twice.
        return sendProblem(reply, sessionExpired(result.message));
      default: return reply.send(result.body);
    }
  });

  /* ── Withdraw ─────────────────────────────────────────────────────────── */

  app.post<{ Params: { id: string; n: string } }>('/certificates/:id/issues/:n/withdraw', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = withdrawBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'A reason is required.'));
    }

    const result = await inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
      // Reissue and withdrawal write notifications for holders across every
      // customer organisation, so they act on the producer's side. Without it
      // the 0022 policies fail closed and the notices reach nobody — see db.ts.
      organisationKind: 'producer',
    }, async (tx) => {
      const [row] = await tx`
        SELECT i.id, i.withdrawn, i.issue_number, c.id AS cert_id, c.code, l.id AS lot_id, l.owner_team_id
        FROM lotmark.certificate_issues i
        JOIN lotmark.certificates c ON c.id = i.certificate_id
        JOIN lotmark.lots l ON l.id = c.lot_id
        WHERE i.tenant_id = ${ctx.tenantId} AND i.certificate_id = ${req.params.id}
          AND i.issue_number = ${Number(req.params.n)}
        FOR UPDATE OF i`;
      const issue = row as {
        id: string; withdrawn: boolean; issue_number: number;
        cert_id: string; code: string; lot_id: string; owner_team_id: string | null;
      } | undefined;
      if (!issue) return { status: 404 as const };
      if (issue.withdrawn) return { status: 409 as const, message: 'This issue is already withdrawn.' };

      const scope: AuthScope = issue.owner_team_id
        ? { kind: 'team', teamId: issue.owner_team_id } : { kind: 'tenant' };

      const verdict = decide({
        authority: ctx.authority, permission: 'cert:reissue', scope,
        sodSettings: defaultSodSettings(), onDate: ctx.today,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditOf(ctx), {
          kind: 'DENY', action: 'Certificate withdrawal refused',
          detail: `${issue.code} #${issue.issue_number}: ${verdict.message}`,
          subjectTable: 'certificate_issues', subjectId: issue.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      await tx`
        UPDATE lotmark.certificate_issues
        SET withdrawn = true, withdrawn_at = now(),
            withdrawn_reason = ${parsed.data.reason}, withdrawn_by_user_id = ${ctx.userId}
        WHERE id = ${issue.id}`;

      // A withdrawn certificate must not remain purchasable. Failing closed on
      // the catalogue is the whole point of withdrawing it.
      await tx`
        UPDATE lotmark.lots SET state = 'withdrawn', version = version + 1
        WHERE id = ${issue.lot_id} AND state = 'released'`;

      const notice = await notifyHolders(tx, {
        tenantId: ctx.tenantId, certificateId: issue.cert_id, issueNumber: issue.issue_number,
        kind: 'withdrawal',
        subject: `${issue.code} issue #${issue.issue_number} has been WITHDRAWN`,
        body: `Do not rely on this certificate. Reason: ${parsed.data.reason}. ` +
              'Contact the producer before using any material covered by it.',
      });

      await recordAudit(tx, auditOf(ctx), {
        kind: 'CERTIFICATE', action: 'Certificate WITHDRAWN',
        detail: `${issue.code} #${issue.issue_number} · ${parsed.data.reason} · ` +
          `${notice.notified.length} holder(s) notified` +
          (notice.unreachable.length > 0
            ? ` · ${notice.unreachable.length} UNREACHABLE — reach them another way` : '') +
          ' · lot removed from the catalogue',
        subjectTable: 'certificate_issues', subjectId: issue.id,
        changes: {
          withdrawn: true, reason: parsed.data.reason,
          notified: notice.notified.length, unreachable: notice.unreachable.length,
        },
      });

      return {
        status: 200 as const,
        body: {
          certificate: issue.code, issue: issue.issue_number, withdrawn: true,
          notified: notice.notified.map((h) => ({ organisation: h.organisation_name, basis: h.basis })),
          unreachable: notice.unreachable.map((h) => ({ organisation: h.organisation_name, basis: h.basis })),
        },
      };
    });

    switch (result.status) {
      case 404: return sendProblem(reply, notFound('No such certificate issue.'));
      case 403: return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
      case 409: return sendProblem(reply, conflict(result.message));
      default: return reply.send(result.body);
    }
  });
}
