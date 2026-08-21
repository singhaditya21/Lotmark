import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isSignatureMeaning, changesRequireSignature, ALL_CONFIG_KINDS,
  type SignatureMeaning, type ConfigKind,
} from '@lotmark/domain';
import { inTenantTransaction, type Sql } from '../db';
import { requireSession, type RequestContext } from '../plugins/session';
import { decide } from '../services/guard';
import { recordAudit } from '../services/audit';
import { applySignature, rejectSigning, SigningRejection } from '../services/signing';
import { refuseSigning } from '../services/signing-refusal';
import { loadLiveSession, hashToken, SESSION_COOKIE } from '../services/sessions';
import {
  versionsOf, versionById, activeVersion, draftVersion, entriesOf,
  createDraft, upsertEntry, removeEntry, diffDraft, publishDraft, discardDraft,
  publicationProblems, changeDigest, ConfigAdminError, KIND_RISK,
} from '../services/config-admin';
import {
  sendProblem, notFound, unprocessable, invalidRequest, forbidden,
} from '../http/problem';

/**
 * The configuration administration API.
 *
 * ── One permission, deliberately ────────────────────────────────────────────
 *
 * Everything here is gated on `user:manage` at TENANT scope. No new permission
 * was invented for configuration, and that is not laziness: roles are stored
 * configuration, read from `config_entries` of the active version at sign-in.
 * A permission added in code would exist in the vocabulary and be granted to
 * nobody, in any tenant that already exists — so it would gate the screens
 * shut and look like a bug.
 *
 * ── Publishing is the only act with ceremony ────────────────────────────────
 *
 * Editing a draft is ordinary and audited. Publishing changes what the system
 * does for everybody, so it validates the whole configuration first, refuses if
 * it would not resolve, and requires an electronic signature when the change is
 * anything other than presentation.
 */
const draftBody = z.object({
  changeReason: z.string().min(1, 'A configuration change must state why.').max(1000),
});

const entryBody = z.object({
  kind: z.string().refine((k): k is ConfigKind => (ALL_CONFIG_KINDS as string[]).includes(k),
    'Not a configurable kind.'),
  key: z.string().min(1).max(120),
  payload: z.unknown(),
});

const publishBody = z.object({
  /** Required only when the change needs a signature; validated server-side. */
  meaning: z.string().refine(isSignatureMeaning).optional(),
});

export async function registerAdminConfigRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db, keys } = app;

  const auditOf = (ctx: RequestContext) => ({
    tenantId: ctx.tenantId, actorUserId: ctx.userId, actorLabel: ctx.displayName,
    actorRoleId: '—', sessionId: ctx.sessionId,
    timeSource: ctx.timeSource, region: ctx.region,
  });

  const tx = <T>(ctx: RequestContext, fn: (t: Sql) => Promise<T>): Promise<T> =>
    inTenantTransaction(db, {
      tenantId: ctx.tenantId,
      auditKey: cfg.LOTMARK_AUDIT_KEY,
      auditKeyGeneration: cfg.LOTMARK_AUDIT_KEY_GENERATION,
    }, fn);

  /** Authorise, or reply. Returns the context when allowed. */
  async function requireAdmin(
    req: FastifyRequest, reply: FastifyReply,
  ): Promise<RequestContext | null> {
    const ctx = await requireSession(app, req, reply);
    if (!ctx) return null;
    const verdict = decide({
      authority: ctx.authority, permission: 'user:manage',
      scope: { kind: 'tenant' }, sodSettings: {}, onDate: ctx.today,
    });
    if (!verdict.allowed) {
      await sendProblem(reply, forbidden(verdict.reason, verdict.message));
      return null;
    }
    return ctx;
  }

  const failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ConfigAdminError) {
      return sendProblem(reply, unprocessable(
        e.problems.length > 0 ? `${e.message} ${e.problems.join(' · ')}` : e.message,
      ));
    }
    throw e;
  };

  /* ── The overview ─────────────────────────────────────────────────────── */

  app.get('/admin/config', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const body = await tx(ctx, async (t) => {
      const versions = await versionsOf(t, ctx.tenantId);
      const active = await activeVersion(t, ctx.tenantId);
      const draft = await draftVersion(t, ctx.tenantId);
      return {
        versions: versions.map((v) => ({
          id: v.id, number: v.version_number, status: v.status,
          reason: v.change_reason, publishedAt: v.published_at,
          signed: v.signature_id !== null,
          changeCount: (v.change_summary ?? []).length,
        })),
        activeId: active?.id ?? null,
        draftId: draft?.id ?? null,
        /** So the console can say up front which edits will need signing. */
        kinds: KIND_RISK,
      };
    });
    return reply.send(body);
  });

  /* ── One version, with its entries ────────────────────────────────────── */

  app.get<{ Params: { id: string } }>('/admin/config/:id', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const body = await tx(ctx, async (t) => {
      const version = await versionById(t, ctx.tenantId, req.params.id);
      if (!version) return null;
      const entries = await entriesOf(t, version.id);
      return {
        version: {
          id: version.id, number: version.version_number, status: version.status,
          reason: version.change_reason, basedOn: version.based_on_version_id,
          publishedAt: version.published_at, signed: version.signature_id !== null,
          changeSummary: version.change_summary ?? [],
        },
        entries: entries.map((e) => ({
          kind: e.kind, key: e.key, payload: e.payload, overridesDefault: e.overrides_default,
        })),
      };
    });

    if (!body) return sendProblem(reply, notFound('No such configuration version.'));
    return reply.send(body);
  });

  /* ── Opening a draft ──────────────────────────────────────────────────── */

  app.post('/admin/config/draft', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = draftBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'A reason is required.'));
    }

    try {
      const draft = await tx(ctx, async (t) => {
        const created = await createDraft(t, {
          tenantId: ctx.tenantId, userId: ctx.userId, changeReason: parsed.data.changeReason,
        });
        await recordAudit(t, auditOf(ctx), {
          kind: 'CONFIGURATION', action: 'Configuration draft opened',
          detail: `version ${created.version_number} · ${parsed.data.changeReason}`,
          subjectTable: 'config_versions', subjectId: created.id,
        });
        return created;
      });
      return reply.send({ id: draft.id, number: draft.version_number });
    } catch (e) {
      return failed(reply, e);
    }
  });

  /* ── Editing it ───────────────────────────────────────────────────────── */

  app.put<{ Params: { id: string } }>('/admin/config/draft/:id/entry', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = entryBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest(parsed.error.issues[0]?.message ?? 'Invalid entry.'));
    }

    try {
      await tx(ctx, async (t) => {
        await upsertEntry(t, {
          tenantId: ctx.tenantId, versionId: req.params.id,
          kind: parsed.data.kind, key: parsed.data.key, payload: parsed.data.payload,
        });
        await recordAudit(t, auditOf(ctx), {
          kind: 'CONFIGURATION', action: 'Configuration entry edited',
          detail: `${parsed.data.kind} '${parsed.data.key}' in a draft`,
          subjectTable: 'config_entries', subjectId: req.params.id,
          changes: { kind: parsed.data.kind, key: parsed.data.key },
        });
      });
      return reply.send({ ok: true });
    } catch (e) {
      return failed(reply, e);
    }
  });

  app.delete<{ Params: { id: string; kind: string; key: string } }>(
    '/admin/config/draft/:id/entry/:kind/:key', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;
    if (!(ALL_CONFIG_KINDS as string[]).includes(req.params.kind)) {
      return sendProblem(reply, invalidRequest('Not a configurable kind.'));
    }

    try {
      await tx(ctx, async (t) => {
        await removeEntry(t, {
          tenantId: ctx.tenantId, versionId: req.params.id,
          kind: req.params.kind as ConfigKind, key: req.params.key,
        });
        await recordAudit(t, auditOf(ctx), {
          kind: 'CONFIGURATION', action: 'Configuration entry removed',
          detail: `${req.params.kind} '${req.params.key}' from a draft`,
          subjectTable: 'config_entries', subjectId: req.params.id,
        });
      });
      return reply.send({ ok: true });
    } catch (e) {
      return failed(reply, e);
    }
  });

  /* ── Reviewing it, before anything is committed to ────────────────────── */

  app.get<{ Params: { id: string } }>('/admin/config/draft/:id/review', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    try {
      const body = await tx(ctx, async (t) => {
        const changes = await diffDraft(t, ctx.tenantId, req.params.id);
        const problems = await publicationProblems(t, ctx.tenantId, req.params.id);
        return {
          changes,
          /**
           * What would stop this being published, ALL of it rather than the
           * first thing. An administrator fixing one problem at a time through
           * a screen that reveals the next one is how a configuration change
           * takes an afternoon.
           */
          problems,
          needsSignature: changesRequireSignature(changes),
          publishable: problems.length === 0 && changes.length > 0,
        };
      });
      return reply.send(body);
    } catch (e) {
      return failed(reply, e);
    }
  });

  /* ── Publishing ───────────────────────────────────────────────────────── */

  app.post<{ Params: { id: string } }>('/admin/config/draft/:id/publish', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    const parsed = publishBody.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(reply, invalidRequest('Invalid request.'));
    }
    const token = req.cookies[SESSION_COOKIE]!;

    let result;
    try {
      result = await tx(ctx, async (t) => {
        const draft = await versionById(t, ctx.tenantId, req.params.id);
        if (!draft) throw new ConfigAdminError('No such configuration version.');

        const changes = await diffDraft(t, ctx.tenantId, draft.id);
        const needsSignature = changesRequireSignature(changes);

        /**
         * Everything that would refuse this version is checked BEFORE the
         * signature is collected.
         *
         * `publishDraft` checks again — it is the guard, and a caller reaching
         * it another way must still be refused. But leaving it only there meant
         * the operator was asked to step up and sign, and only then told the
         * configuration could not be published, with the signature rolled back
         * along with everything else. Nobody should be asked to sign something
         * that was never going to be accepted.
         */
        const problems = await publicationProblems(t, ctx.tenantId, draft.id);
        if (problems.length > 0) {
          throw new ConfigAdminError('This configuration cannot be published.', problems);
        }
        if (changes.length === 0) {
          throw new ConfigAdminError(
            'This draft changes nothing. Publishing it would add a version to the history ' +
            'that no record was created under.',
          );
        }

        let signatureId: string | null = null;
        if (needsSignature) {
          if (!parsed.data.meaning) {
            throw new ConfigAdminError(
              'This version changes behaviour or security and must be signed. Choose a meaning.',
            );
          }
          const session = await loadLiveSession(t, hashToken(token), cfg.IDLE_TIMEOUT_MINUTES);
          if (!session) throw new ConfigAdminError('Your session has ended.');
          const key = await keys.active(t, ctx.tenantId, (m) => app.log.info(m));

          try {
            const signature = await applySignature(t, {
              tenantId: ctx.tenantId,
              signable: {
                kind: 'config_version',
                record: {
                  id: draft.id,
                  versionNumber: draft.version_number,
                  basedOnVersionId: draft.based_on_version_id,
                  // The signature covers the DIFF that was reviewed, not the
                  // whole configuration — see SignableConfigVersion.
                  changeDigest: changeDigest(changes),
                  changeCount: changes.length,
                },
              },
              subjectId: draft.id, signerUserId: ctx.userId,
              meaning: parsed.data.meaning as SignatureMeaning,
              session, signingWindowMinutes: cfg.SIGNING_WINDOW_MINUTES,
              // Configuration is not competence-gated: ISO 17034 6.3 is about
              // performing laboratory activities, not about administering the
              // system that records them.
              competenceBasis: null, requiresCompetence: false,
              key, timeSource: ctx.timeSource, region: ctx.region,
            });
            signatureId = signature.id;
          } catch (e) {
            // Throws so the transaction rolls back. Returning here would
            // publish the version unsigned — see SigningRejection.
            rejectSigning(e, {
              table: 'config_versions',
              label: `configuration version ${draft.version_number}`,
            });
          }
        }

        const published = await publishDraft(t, {
          tenantId: ctx.tenantId, draftId: draft.id, userId: ctx.userId, signatureId,
        });

        await recordAudit(t, auditOf(ctx), {
          kind: 'CONFIGURATION', action: 'Configuration version published',
          detail:
            `version ${draft.version_number} · ${draft.change_reason} · ` +
            `${published.changes.length} change(s)` +
            (published.needsSignature ? ' · signed' : ' · presentation only, unsigned'),
          subjectTable: 'config_versions', subjectId: draft.id,
          changes: { changes: published.changes, signed: published.needsSignature },
        });

        return {
          number: draft.version_number,
          changes: published.changes,
          signed: published.needsSignature,
        };
      });
    } catch (e) {
      if (e instanceof SigningRejection) {
        return refuseSigning({
          db, auditKey: cfg.LOTMARK_AUDIT_KEY, audit: auditOf(ctx), rejection: e, reply,
        });
      }
      return failed(reply, e);
    }

    return reply.send(result);
  });

  /* ── Discarding ───────────────────────────────────────────────────────── */

  app.delete<{ Params: { id: string } }>('/admin/config/draft/:id', async (req, reply) => {
    const ctx = await requireAdmin(req, reply);
    if (!ctx) return;

    try {
      await tx(ctx, async (t) => {
        const draft = await versionById(t, ctx.tenantId, req.params.id);
        await discardDraft(t, ctx.tenantId, req.params.id);
        await recordAudit(t, auditOf(ctx), {
          kind: 'CONFIGURATION', action: 'Configuration draft discarded',
          detail: `version ${draft?.version_number ?? '?'} · ${draft?.change_reason ?? ''}`,
          subjectTable: 'config_versions', subjectId: req.params.id,
        });
      });
      return reply.send({ ok: true });
    } catch (e) {
      return failed(reply, e);
    }
  });
}
