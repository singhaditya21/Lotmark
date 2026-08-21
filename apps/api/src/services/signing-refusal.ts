import type { FastifyReply } from 'fastify';
import type { Sql } from '../db';
import { inTenantTransaction } from '../db';
import { recordAudit, type AuditContext } from './audit';
import type { SigningRejection } from './signing';
import { sendProblem, stepUpRequired, conflict } from '../http/problem';

/**
 * What to do once a signing refusal has rolled its transaction back.
 *
 * Two things have to happen, and they are in tension:
 *
 *  1. The half-made record must be GONE. That is what the rollback achieves,
 *     and it is why `rejectSigning` throws rather than returning.
 *
 *  2. The refusal must be RECORDED. A control that fired and left no trace
 *     cannot be shown to an assessor, and this codebase treats a denial as
 *     evidence rather than as an absence.
 *
 * The tension is that an audit entry written inside the doomed transaction
 * rolls back with it. So the entry is written here, on a FRESH transaction,
 * after the rollback has already happened — the same shape `forEachTenant`
 * uses when it records a failed job run whose own transaction has aborted.
 *
 * The entry says the record was discarded, because "signing refused" on its own
 * leaves open the question of what happened to the thing being signed, and that
 * question is the whole point.
 */
export async function refuseSigning(args: {
  readonly db: Sql;
  readonly auditKey: string;
  readonly audit: AuditContext;
  readonly rejection: SigningRejection;
  readonly reply: FastifyReply;
}): Promise<FastifyReply> {
  const { rejection } = args;

  await inTenantTransaction(
    args.db,
    { tenantId: args.audit.tenantId, auditKey: args.auditKey },
    (tx) =>
      recordAudit(tx, args.audit, {
        kind: 'SECURITY',
        action: 'Signing refused; the unsigned record was discarded',
        detail: `${rejection.subject.label}: ${rejection.message}`,
        subjectTable: rejection.subject.table,
        changes: { code: rejection.code, discarded: true },
      }),
  );

  return sendProblem(
    args.reply,
    rejection.httpStatus === 401
      ? stepUpRequired(rejection.message)
      : conflict(rejection.message),
  );
}
