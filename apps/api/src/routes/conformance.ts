import type { FastifyInstance } from 'fastify';
import { signPayload } from '@lotmark/security';
import { inTenantTransaction } from '../db';
import { requireSession } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { conformanceView, buildAssessmentPack } from '../services/conformance';
import { sendProblem, forbidden } from '../http/problem';

/**
 * Conformance, and the pack an assessor asks for.
 *
 * `conformance:read` gates the view. The Quality Manager holds it, and it is
 * the permission the vocabulary already has for exactly this — no new one was
 * invented, because roles are stored configuration and a permission added in
 * code reaches no tenant that already exists.
 *
 * Exporting is a separate act from reading and is AUDITED. A pack leaves the
 * building; who assembled one and when is part of the record.
 */
export async function registerConformanceRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys } = app;

  const args = (tenantId: string) => ({
    tenantId,
    auditKey: cfg.LOTMARK_AUDIT_KEY,
    auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    auditKeys: cfg.LOTMARK_AUDIT_KEYS,
    organisationKind: 'producer' as const,
  });

  app.get('/conformance', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    const verdict = decide({
      authority: ctx.authority, permission: 'conformance:read',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    // Read-only and many queries, so the same snapshot argument applies as for
    // the pack: a screen whose clauses disagree with each other is worse than
    // one that is a moment out of date.
    const clauses = await inTenantTransaction(
      db, { ...args(ctx.tenantId), isolation: 'repeatable read' },
      (tx) => conformanceView(tx, ctx.tenantId));

    return reply.send({
      clauses,
      /**
       * Counted from the register rather than from the screen, so a clause
       * that is partly declared cannot be summarised away.
       */
      summary: {
        clauses: clauses.length,
        enforced: clauses.filter((c) => c.status === 'enforced').length,
        weaker: clauses.filter((c) => c.status !== 'enforced').length,
      },
    });
  });

  app.post('/conformance/pack', async (req, reply) => {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return;

    // Exporting is `audit:export`, not `conformance:read`: assembling a bundle
    // of the producer's records to send outside is a different act from looking
    // at a screen.
    const verdict = decide({
      authority: ctx.authority, permission: 'audit:export',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) return sendProblem(reply, forbidden(verdict.reason, verdict.message));

    /**
     * TWO transactions, and the split is the point.
     *
     * The pack is assembled at REPEATABLE READ so that every section reads the
     * same snapshot. Under the default READ COMMITTED each statement takes a
     * fresh one, so a pack could count certificates before a record landed and
     * the audit chain after it — an export that disagrees with itself, signed,
     * and handed to an assessor.
     *
     * The audit entry is written on a SEPARATE, ordinary transaction. Appending
     * to the ledger touches a row every writer touches, and doing that under
     * REPEATABLE READ turns an ordinary concurrent act into a serialization
     * failure. The export is recorded after the pack exists and before it is
     * returned, so an export that could not be recorded is not an export.
     */
    const pack = await inTenantTransaction(
      db, { ...args(ctx.tenantId), isolation: 'repeatable read' },
      async (tx) => {
        const key = await keys.active(tx, ctx.tenantId, (m) => app.log.info(m));
        return buildAssessmentPack(tx, ctx.tenantId, (payload) => ({
          signature: signPayload(payload, key.privateKey),
          keyVersion: key.keyVersion,
          custody: key.custody,
        }));
      });

    await inTenantTransaction(db, args(ctx.tenantId), (tx) => recordAudit(tx, {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
      actorRoleId: '—', sessionId: ctx.sessionId,
      timeSource: ctx.timeSource, region: ctx.region,
    }, {
      kind: 'GOVERNANCE', action: 'Assessment pack exported',
      detail:
        `${pack.requirements.length} requirement(s), ` +
        `${Object.keys(pack.sections).length} section(s), ` +
        `digest ${pack.manifest.packDigest.slice(0, 16)}…`,
      changes: { packDigest: pack.manifest.packDigest, keyVersion: pack.manifest.keyVersion },
    }));

    return reply
      .header('content-disposition',
        `attachment; filename="lotmark-assessment-${pack.tenant.slug}.json"`)
      .send(pack);
  });
}
