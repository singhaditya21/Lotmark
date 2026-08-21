import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isSignatureMeaning, defaultSodSettings, assertTransition, LOT_MACHINE,
  type SignatureMeaning, type CompetenceBasis, type AuthScope, type Permission,
} from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { applySignature, SigningError } from '../services/signing';
import { loadLiveSession, hashToken, SESSION_COOKIE } from '../services/sessions';
import { nextCode } from '../services/numbering';
import { signPayload } from '@lotmark/security';
import { mintVerificationToken } from '../services/documents';
import {
  renderCertificate, snapshotDigest, RENDERER_VERSION, TEMPLATE_KEY, TEMPLATE_VERSION,
  type CertificateSnapshot,
} from '../services/certificate-pdf';
import { conflict, forbidden, invalidRequest, notFound, sendProblem, stepUpRequired, unprocessable } from '../http/problem';

const releaseBody = z.object({
  meaning: z.string().refine(isSignatureMeaning),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stockUnits: z.number().int().nonnegative().default(0),
  unitPriceMinor: z.number().int().nonnegative().default(0),
  reason: z.string().max(1000).optional(),
});

const issueBody = z.object({
  meaning: z.string().refine(isSignatureMeaning),
  reason: z.string().max(1000).optional(),
});

export async function registerLotRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys, documents } = app;

  async function competenceBasis(
    tx: Sql, tenantId: string, userId: string, activity: Permission, onDate: string,
  ): Promise<CompetenceBasis | null> {
    const [row] = await tx`
      SELECT id, activity, valid_from, valid_to FROM lotmark.competence_records
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND activity = ${activity}
        AND superseded_at IS NULL AND valid_from <= ${onDate} AND valid_to >= ${onDate}
      LIMIT 1`;
    const c = row as { id: string; activity: string; valid_from: string; valid_to: string } | undefined;
    return c ? {
      competenceRecordId: c.id, activity: c.activity, validFrom: c.valid_from,
      validTo: c.valid_to, checkedOn: onDate, personUserId: userId,
    } : null;
  }

  /**
   * RELEASE A LOT.
   *
   * Only from an AUTHORISED property value. A lot released against an
   * unauthorised value would carry a number nobody accepted responsibility for,
   * which is the whole thing the authorisation step exists to prevent.
   *
   * Releasing supersedes the previous lot of the same project, so the
   * supersession chain stays intact and "which lot replaced which" is a
   * traversal rather than a guess.
   */
  app.post<{ Params: { id: string } }>('/projects/:id/release-lot', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = releaseBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(
        parsed.error.issues[0]?.message ?? 'An expiry date and signature meaning are required.'));
    }
    const token = req.cookies[SESSION_COOKIE]!;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [projectRow] = await tx`
        SELECT id, code, sku, owner_team_id, material_name FROM lotmark.projects
        WHERE tenant_id = ${ctx.tenantId} AND id = ${req.params.id} LIMIT 1`;
      const project = projectRow as {
        id: string; code: string; sku: string; owner_team_id: string | null; material_name: string;
      } | undefined;
      if (!project) return { status: 404 as const };

      const [valueRow] = await tx`
        SELECT id, code, assigned_value, expanded_uncertainty, property_name, unit,
               coverage_factor, assigned_by
        FROM lotmark.property_values
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${project.id} AND state = 'authorised'
        ORDER BY authorised_at DESC LIMIT 1`;
      const value = valueRow as {
        id: string; code: string; assigned_value: number; expanded_uncertainty: number;
        property_name: string; unit: string; coverage_factor: number; assigned_by: string | null;
      } | undefined;
      if (!value) {
        return { status: 422 as const, message: 'This project has no authorised property value to release against.' };
      }

      const scope: AuthScope = project.owner_team_id
        ? { kind: 'team', teamId: project.owner_team_id } : { kind: 'tenant' };
      const basis = await competenceBasis(tx, ctx.tenantId, ctx.userId, 'lot:release', ctx.today);

      const verdict = decide({
        authority: ctx.authority, permission: 'lot:release', scope,
        // SoD-4 (off by default) reads createdBy; carried so enabling the rule
        // needs no code change.
        record: { createdBy: value.assigned_by },
        sodSettings: defaultSodSettings(), onDate: ctx.today,
        competenceFor: () => basis, requiresSignature: true,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditCtxOf(ctx), {
          kind: 'DENY', action: 'Lot release refused',
          detail: `${project.code}: ${verdict.message}`,
          subjectTable: 'projects', subjectId: project.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      assertTransition(LOT_MACHINE, 'draft', 'released');

      const [prevRow] = await tx`
        SELECT id, lot_code FROM lotmark.lots
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${project.id} AND state = 'released'
        ORDER BY released_at DESC NULLS LAST LIMIT 1`;
      const previous = prevRow as { id: string; lot_code: string } | undefined;

      // Through the counter, not count(*): counting rows races two concurrent
      // releases onto the same code, and stops tracking the high-water mark the
      // moment a lot is superseded.
      const lotCode = await nextCode(tx, {
        tenantId: ctx.tenantId, entity: 'lot',
        material: project.sku.split('-')[1] ?? project.sku, today: ctx.today,
      });
      const [storageRow] = await tx`
        SELECT storage_condition FROM lotmark.studies
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${project.id}
          AND study_type = 'stability' AND storage_condition IS NOT NULL
        LIMIT 1`;
      const storage = (storageRow as { storage_condition: string } | undefined)?.storage_condition
        ?? 'Room temperature';
      // Cold chain is DERIVED from the storage condition the stability study
      // established, not asked for. A person typing it can disagree with the data.
      const coldChain = /°C/.test(storage) && !/Room/i.test(storage);

      const [lotRow] = await tx`
        INSERT INTO lotmark.lots
          (tenant_id, project_id, lot_code, previous_lot_id, expiry_date, state, stock_units,
           storage_condition, cold_chain, unit_price_minor, created_by, released_by, released_at,
           owner_team_id)
        VALUES (${ctx.tenantId}, ${project.id}, ${lotCode}, ${previous?.id ?? null},
                ${parsed.data.expiryDate}, 'released', ${parsed.data.stockUnits},
                ${storage}, ${coldChain}, ${parsed.data.unitPriceMinor},
                ${ctx.userId}, ${ctx.userId}, now(), ${project.owner_team_id})
        RETURNING id`;
      const lotId = (lotRow as { id: string }).id;

      const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return { status: 401 as const, message: 'Your session has ended.' };
      const key = await keys.active(tx, ctx.tenantId, (m) => app.log.info(m));

      let signature;
      try {
        signature = await applySignature(tx, {
          tenantId: ctx.tenantId,
          signable: {
            kind: 'lot',
            record: { id: lotId, lotCode, projectId: project.code, expiryDate: parsed.data.expiryDate },
          },
          subjectId: lotId, signerUserId: ctx.userId,
          meaning: parsed.data.meaning as SignatureMeaning,
          session, signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
          competenceBasis: verdict.competenceBasis,
          requiresCompetence: verdict.competenceBasis !== null,
          key, timeSource: ctx.timeSource, region: ctx.region,
        });
      } catch (e) {
        if (e instanceof SigningError) {
          return { status: e.code === 'step_up_required' ? 401 as const : 409 as const, message: e.message };
        }
        throw e;
      }

      if (previous) {
        await tx`UPDATE lotmark.lots SET state = 'superseded', version = version + 1 WHERE id = ${previous.id}`;
        await tx`
          INSERT INTO lotmark.state_transitions
            (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason)
          VALUES (${ctx.tenantId}, 'lot', ${previous.id}, 'released', 'superseded',
                  ${ctx.userId}, ${'superseded by ' + lotCode})`;
      }

      await tx`
        INSERT INTO lotmark.state_transitions
          (tenant_id, subject_type, subject_id, from_state, to_state, actor_user_id, reason, signature_id)
        VALUES (${ctx.tenantId}, 'lot', ${lotId}, 'draft', 'released',
                ${ctx.userId}, ${parsed.data.reason ?? null}, ${signature.id})`;

      await recordAudit(tx, auditCtxOf(ctx), {
        kind: 'WORKFLOW', action: 'Lot released',
        detail: `${lotCode} for ${project.code}` + (previous ? ` · supersedes ${previous.lot_code}` : '') +
          ` · storage ${storage}${coldChain ? ' (cold chain)' : ''}`,
        subjectTable: 'lots', subjectId: lotId,
        changes: { lotCode, supersedes: previous?.lot_code ?? null, coldChain },
      });

      return {
        status: 200 as const,
        body: {
          lot: {
            id: lotId, lotCode, state: 'released', expiryDate: parsed.data.expiryDate,
            storageCondition: storage, coldChain, supersedes: previous?.lot_code ?? null,
          },
          value: {
            code: value.code, assignedValue: value.assigned_value,
            expandedUncertainty: value.expanded_uncertainty,
            unit: value.unit, coverageFactor: value.coverage_factor,
          },
          signature: { id: signature.id, signedAt: signature.signedAt, keyVersion: key.keyVersion },
        },
      };
    });

    return respond(reply, result, 'No such project.');
  });

  /**
   * ISSUE A CERTIFICATE for a released lot.
   *
   * The stated value and uncertainty are FROZEN onto the issue at this moment.
   * A certificate says what was true when it was issued; if the project's value
   * is later revised, that is a REISSUE with its own number, never an edit.
   */
  app.post<{ Params: { id: string } }>('/lots/:id/certificate', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const parsed = issueBody.safeParse(req.body);
    if (!parsed.success) return sendProblem(reply, invalidRequest('A signature meaning is required.'));
    const token = req.cookies[SESSION_COOKIE]!;

    const result = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [lotRow] = await tx`
        SELECT l.*, p.code AS project_code, p.owner_team_id
        FROM lotmark.lots l JOIN lotmark.projects p ON p.id = l.project_id
        WHERE l.tenant_id = ${ctx.tenantId} AND l.id = ${req.params.id} FOR UPDATE OF l`;
      const lot = lotRow as {
        id: string; lot_code: string; project_id: string; project_code: string;
        state: string; owner_team_id: string | null; created_by: string | null;
      } | undefined;
      if (!lot) return { status: 404 as const };
      if (lot.state !== 'released') {
        return { status: 409 as const, message: `Lot ${lot.lot_code} is ${lot.state}; only a released lot may be certified.` };
      }

      const [valueRow] = await tx`
        SELECT code, assigned_value, expanded_uncertainty, property_name, unit, coverage_factor, assigned_by
        FROM lotmark.property_values
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${lot.project_id} AND state = 'authorised'
        ORDER BY authorised_at DESC LIMIT 1`;
      const value = valueRow as {
        code: string; assigned_value: number; expanded_uncertainty: number;
        property_name: string; unit: string; coverage_factor: number; assigned_by: string | null;
      } | undefined;
      if (!value) return { status: 422 as const, message: 'No authorised property value to certify.' };

      const scope: AuthScope = lot.owner_team_id
        ? { kind: 'team', teamId: lot.owner_team_id } : { kind: 'tenant' };
      const basis = await competenceBasis(tx, ctx.tenantId, ctx.userId, 'cert:issue', ctx.today);

      const verdict = decide({
        authority: ctx.authority, permission: 'cert:issue', scope,
        // SoD-3 (off by default) reads assignedBy.
        record: { assignedBy: value.assigned_by },
        sodSettings: defaultSodSettings(), onDate: ctx.today,
        requiresCompetence: 'cert:issue', competenceFor: () => basis,
        requiresSignature: true,
      });
      if (!verdict.allowed) {
        await recordAudit(tx, auditCtxOf(ctx), {
          kind: 'DENY', action: 'Certificate issue refused',
          detail: `${lot.lot_code}: ${verdict.message}`,
          subjectTable: 'lots', subjectId: lot.id, changes: verdict.detail,
        });
        return { status: 403 as const, verdict };
      }

      let [certRow] = await tx`
        SELECT id, code FROM lotmark.certificates
        WHERE tenant_id = ${ctx.tenantId} AND lot_id = ${lot.id} LIMIT 1`;
      let cert = certRow as { id: string; code: string } | undefined;

      if (!cert) {
        const code = await nextCode(tx, {
          tenantId: ctx.tenantId, entity: 'certificate', today: ctx.today,
        });
        const [created] = await tx`
          INSERT INTO lotmark.certificates (tenant_id, code, lot_id)
          VALUES (${ctx.tenantId}, ${code}, ${lot.id}) RETURNING id, code`;
        cert = created as { id: string; code: string };
      }

      const [maxRow] = await tx`
        SELECT COALESCE(max(issue_number), 0)::int AS n FROM lotmark.certificate_issues
        WHERE certificate_id = ${cert.id}`;
      const issueNumber = (maxRow as { n: number }).n + 1;

      const session = await loadLiveSession(tx, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
      if (!session) return { status: 401 as const, message: 'Your session has ended.' };
      const key = await keys.active(tx, ctx.tenantId, (m) => app.log.info(m));

      const [issueRow] = await tx`
        INSERT INTO lotmark.certificate_issues
          (tenant_id, certificate_id, issue_number, assigned_value, expanded_uncertainty,
           coverage_factor, property_name, unit, issued_by_user_id, issued_at, reissue_reason)
        VALUES (${ctx.tenantId}, ${cert.id}, ${issueNumber}, ${value.assigned_value},
                ${value.expanded_uncertainty}, ${value.coverage_factor}, ${value.property_name},
                ${value.unit}, ${ctx.userId}, now(),
                ${issueNumber > 1 ? (parsed.data.reason ?? 'Reissued') : null})
        RETURNING id`;
      const issueId = (issueRow as { id: string }).id;

      let signature;
      try {
        signature = await applySignature(tx, {
          tenantId: ctx.tenantId,
          signable: {
            kind: 'certificate',
            record: {
              certificateId: cert.code, lotId: lot.lot_code, issueNumber,
              value: value.assigned_value, expandedUncertainty: value.expanded_uncertainty,
            },
          },
          subjectId: issueId, signerUserId: ctx.userId,
          meaning: parsed.data.meaning as SignatureMeaning,
          session, signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
          competenceBasis: verdict.competenceBasis, requiresCompetence: true,
          key, timeSource: ctx.timeSource, region: ctx.region,
        });
      } catch (e) {
        if (e instanceof SigningError) {
          return { status: e.code === 'step_up_required' ? 401 as const : 409 as const, message: e.message };
        }
        throw e;
      }

      /* ── Render the document, in the SAME transaction ──────────────────
       *
       * A certificate row without its document is a promise the system cannot
       * keep, and a document whose row rolled back is an artefact attesting to
       * something that never happened. Both are worse than the whole issuance
       * failing, so they succeed or fail together.
       */
      const [projectRow] = await tx`
        SELECT p.material_name, p.cas_number, t.name AS producer_name,
               t.conformance_frame, o.accreditation
        FROM lotmark.projects p
        JOIN lotmark.tenants t ON t.id = p.tenant_id
        LEFT JOIN lotmark.organisations o ON o.tenant_id = t.id AND o.kind = 'producer'
        WHERE p.id = ${lot.project_id} LIMIT 1`;
      const meta = projectRow as {
        material_name: string; cas_number: string | null; producer_name: string;
        conformance_frame: string; accreditation: string | null;
      };

      const [lotDetail] = await tx`
        SELECT l.expiry_date, l.storage_condition, prev.lot_code AS previous_lot_code
        FROM lotmark.lots l
        LEFT JOIN lotmark.lots prev ON prev.id = l.previous_lot_id
        WHERE l.id = ${lot.id}`;
      const detail = lotDetail as {
        expiry_date: string; storage_condition: string; previous_lot_code: string | null;
      };

      const [pvRow] = await tx`
        SELECT components FROM lotmark.property_values
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${lot.project_id} AND state = 'authorised'
        ORDER BY authorised_at DESC LIMIT 1`;
      const components = ((pvRow as { components: Array<{ symbol: string; value: number; basis: string }> } | undefined)
        ?.components ?? []).map((c) => ({ symbol: c.symbol, value: c.value, basis: c.basis }));

      const verificationToken = mintVerificationToken();

      const snapshot: CertificateSnapshot = {
        producerName: meta.producer_name,
        producerAccreditation: meta.accreditation,
        certificateCode: cert.code,
        issueNumber,
        issuedAt: signature.signedAt,
        lotCode: lot.lot_code,
        previousLotCode: detail.previous_lot_code,
        materialName: meta.material_name,
        casNumber: meta.cas_number,
        propertyName: value.property_name,
        assignedValue: value.assigned_value,
        expandedUncertainty: value.expanded_uncertainty,
        coverageFactor: value.coverage_factor,
        unit: value.unit,
        expiryDate: detail.expiry_date,
        storageCondition: detail.storage_condition,
        transportCondition: null,
        components,
        issuedByName: ctx.displayName,
        signedAt: signature.signedAt,
        signatureMeaning: signature.meaning,
        keyVersion: key.keyVersion,
        keyCustody: key.custody,
        verificationToken,
        reissueReason: issueNumber > 1 ? (parsed.data.reason ?? 'Reissued') : null,
        conformanceFrame: meta.conformance_frame,
      };

      const pdf = await renderCertificate(snapshot);
      const stored = documents.put(pdf);
      // The signature is over the PDF BYTES, so a verifier needs only the file
      // and the public key — no database, no account, no cooperation from us.
      const documentSignature = signPayload(
        Buffer.from(pdf).toString('base64'), key.privateKey,
      );

      await tx`
        UPDATE lotmark.certificate_issues
        SET document_sha256 = ${stored.sha256}, document_path = ${stored.relativePath},
            document_bytes = ${stored.bytes},
            data_snapshot = ${tx.json(snapshot as never)},
            data_snapshot_digest = ${snapshotDigest(snapshot)},
            template_key = ${TEMPLATE_KEY}, template_version = ${TEMPLATE_VERSION},
            renderer_version = ${RENDERER_VERSION},
            document_signature = ${documentSignature},
            document_key_version = ${key.keyVersion},
            rendered_at = now(), verification_token = ${verificationToken}
        WHERE id = ${issueId}`;

      await recordAudit(tx, auditCtxOf(ctx), {
        kind: 'CERTIFICATE', action: issueNumber === 1 ? 'Certificate issued' : 'Certificate reissued',
        detail: `${cert.code} issue #${issueNumber} for ${lot.lot_code} · ` +
          `${value.assigned_value.toPrecision(7)} ± ${value.expanded_uncertainty.toPrecision(4)} ${value.unit} (k=${value.coverage_factor})`,
        subjectTable: 'certificate_issues', subjectId: issueId,
        changes: {
          certificate: cert.code, issueNumber, value: value.assigned_value,
          documentSha256: stored.sha256, documentBytes: stored.bytes,
        },
      });

      return {
        status: 200 as const,
        body: {
          certificate: { id: cert.id, code: cert.code, lot: lot.lot_code },
          issue: {
            id: issueId, number: issueNumber,
            assignedValue: value.assigned_value,
            expandedUncertainty: value.expanded_uncertainty,
            coverageFactor: value.coverage_factor,
            property: value.property_name, unit: value.unit,
          },
          signature: { id: signature.id, signedAt: signature.signedAt, keyVersion: key.keyVersion },
          document: {
            sha256: stored.sha256, bytes: stored.bytes,
            verificationToken,
            url: `/api/v1/certificates/${cert.id}/issues/${issueNumber}/pdf`,
            verifyUrl: `${cfg.PUBLIC_ORIGIN}/verify/${verificationToken}`,
          },
        },
      };
    });

    return respond(reply, result, 'No such lot.');
  });

  /** Download a certificate issue as a PDF. */
  app.get<{ Params: { id: string; n: string } }>('/certificates/:id/issues/:n/pdf', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const found = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, async (tx) => {
      const [row] = await tx`
        SELECT i.document_sha256, i.withdrawn, c.code, l.owner_team_id
        FROM lotmark.certificate_issues i
        JOIN lotmark.certificates c ON c.id = i.certificate_id
        JOIN lotmark.lots l ON l.id = c.lot_id
        WHERE i.tenant_id = ${ctx.tenantId} AND i.certificate_id = ${req.params.id}
          AND i.issue_number = ${Number(req.params.n)}`;
      const issue = row as {
        document_sha256: string | null; withdrawn: boolean; code: string; owner_team_id: string | null;
      } | undefined;
      if (!issue) return null;

      const verdict = decide({
        authority: ctx.authority, permission: 'project:read',
        scope: issue.owner_team_id ? { kind: 'team', teamId: issue.owner_team_id } : { kind: 'tenant' },
        sodSettings: {}, onDate: ctx.today,
      });
      if (!verdict.allowed) return { forbidden: verdict };
      return issue;
    });

    if (!found) return sendProblem(reply, notFound('No such certificate issue.'));
    if ('forbidden' in found) {
      return sendProblem(reply, forbidden(found.forbidden.reason, found.forbidden.message));
    }
    if (!found.document_sha256) {
      return sendProblem(reply, conflict('This issue has no rendered document.'));
    }

    const bytes = documents.get(found.document_sha256);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition',
              `inline; filename="${found.code}-issue-${req.params.n}.pdf"`)
      // The digest is published so a caller can verify what it received.
      .header('x-document-sha256', found.document_sha256)
      .send(Buffer.from(bytes));
  });

  /** Lots for a project, newest first. */
  app.get<{ Params: { id: string } }>('/projects/:id/lots', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;
    const rows = await inTenantTransaction(db, { tenantId: ctx.tenantId, auditKey: cfg.LOTMARK_AUDIT_KEY }, (tx) =>
      tx`SELECT l.id, l.lot_code, l.state, l.expiry_date, l.stock_units, l.storage_condition,
                l.cold_chain, prev.lot_code AS supersedes,
                c.code AS certificate_code
         FROM lotmark.lots l
         LEFT JOIN lotmark.lots prev ON prev.id = l.previous_lot_id
         LEFT JOIN lotmark.certificates c ON c.lot_id = l.id
         WHERE l.tenant_id = ${ctx.tenantId} AND l.project_id = ${req.params.id}
         ORDER BY l.created_at DESC`);
    return reply.send({ lots: rows });
  });
}

type StepResult =
  | { status: 200; body: unknown }
  | { status: 404 }
  | { status: 403; verdict: { reason: string; message: string } }
  | { status: 409 | 422 | 401; message: string };

function respond(reply: FastifyReply, result: StepResult, missingMessage: string) {
  switch (result.status) {
    // `missingMessage`, not `notFound` — the latter shadows the imported helper.
    case 404: return sendProblem(reply, notFound(missingMessage));
    case 403: return sendProblem(reply, forbidden(result.verdict.reason, result.verdict.message));
    case 409: return sendProblem(reply, conflict(result.message));
    case 422: return sendProblem(reply, unprocessable(result.message));
    case 401: return sendProblem(reply, stepUpRequired(result.message));
    default: return reply.send(result.body);
  }
}

function auditCtxOf(ctx: RequestContext) {
  return {
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  };
}

