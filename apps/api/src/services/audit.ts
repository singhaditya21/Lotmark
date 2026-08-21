import type { Sql } from '../db';

/**
 * Writing to the ledger.
 *
 * The chain itself is built by a database trigger, so an entry cannot be
 * written with a wrong hash or out of sequence no matter what this code does.
 * This module's only job is to supply well-formed, honest content.
 */
export interface AuditContext {
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly actorRoleId: string;
  readonly sessionId: string | null;
  readonly timeSource: string;
  readonly region: string;
}

export type AuditKind =
  | 'AUTH' | 'DENY' | 'SECURITY' | 'WORKFLOW' | 'SIGNATURE' | 'CERTIFICATE'
  | 'CONFIGURATION' | 'PII' | 'SYSTEM' | 'QUERY' | 'GOVERNANCE'
  // Written by scheduled work, which has no session and no user.
  | 'NOTIFICATION' | 'ENTITLEMENT';

export async function recordAudit(
  tx: Sql,
  ctx: AuditContext,
  entry: {
    readonly kind: AuditKind;
    readonly action: string;
    readonly detail?: string;
    readonly subjectTable?: string;
    readonly subjectId?: string;
    readonly changes?: Record<string, unknown>;
  },
): Promise<void> {
  await tx`
    INSERT INTO lotmark.audit_ledger
      (tenant_id, actor_user_id, actor_label, actor_role_id, session_id,
       kind, action, detail, subject_table, subject_id, changes, time_source, region)
    VALUES (${ctx.tenantId}, ${ctx.actorUserId}, ${ctx.actorLabel}, ${ctx.actorRoleId},
            ${ctx.sessionId}, ${entry.kind}, ${entry.action}, ${entry.detail ?? ''},
            ${entry.subjectTable ?? null}, ${entry.subjectId ?? null},
            ${entry.changes ? tx.json(entry.changes as never) : null},
            ${ctx.timeSource}, ${ctx.region})`;
}

/**
 * The anonymous actor, for events with no established identity — a failed
 * sign-in, a rate-limit trip.
 *
 * `actorLabel` still carries the attempted identity. A security ledger that
 * records "somebody failed to sign in" without saying who they claimed to be is
 * not much of a security ledger.
 */
export function anonymousContext(args: {
  tenantId: string; attemptedIdentity: string; timeSource: string; region: string;
}): AuditContext {
  return {
    tenantId: args.tenantId,
    actorUserId: null,
    actorLabel: args.attemptedIdentity,
    actorRoleId: '—',
    sessionId: null,
    timeSource: args.timeSource,
    region: args.region,
  };
}
