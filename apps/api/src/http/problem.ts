import type { FastifyReply } from 'fastify';

/**
 * RFC 9457 problem details.
 *
 * Was duplicated verbatim in six route files, each returning only
 * `{type, title, detail}` — no status, no machine-readable code, and no link
 * back to the ledger. Collapsing it now is trivial at 19 error sites and a
 * week of tedium at eighty.
 *
 * `auditSeq` is the part that matters. A refusal is evidence that a control
 * fired, and the ledger holds the proof. Carrying the sequence number on the
 * response is what lets a user — or an assessor reading a support ticket —
 * connect the message someone saw to the entry that recorded it.
 */
export const PROBLEM_BASE = 'https://lotmark.local/problems';

export interface Problem {
  /** Stable URI identifying the problem TYPE, not this occurrence. */
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  /** Machine-readable code a client can branch on without parsing prose. */
  readonly code: string;
  /** The ledger entry that recorded this refusal, where one was written. */
  readonly auditSeq?: string;
  /** Field-level detail for validation failures. */
  readonly errors?: ReadonlyArray<{ field: string; message: string }>;
}

export function problem(args: {
  code: string;
  status: number;
  detail: string;
  title?: string | undefined;
  auditSeq?: string | bigint | null | undefined;
  errors?: ReadonlyArray<{ field: string; message: string }> | undefined;
}): Problem {
  return {
    type: `${PROBLEM_BASE}/${args.code}`,
    title: args.title ?? humanise(args.code),
    status: args.status,
    detail: args.detail,
    code: args.code,
    ...(args.auditSeq != null ? { auditSeq: String(args.auditSeq) } : {}),
    ...(args.errors && args.errors.length > 0 ? { errors: args.errors } : {}),
  };
}

/**
 * Send a problem with the correct status and content type.
 *
 * `application/problem+json` is what RFC 9457 specifies; a client that
 * distinguishes error shapes by content type gets nothing useful from
 * `application/json`.
 */
export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type('application/problem+json').send(p);
}

/* ── The vocabulary, so a code is never invented at a call site ─────────── */

export const notAuthenticated = (detail = 'Sign in to continue.') =>
  problem({ code: 'not_authenticated', status: 401, detail });

export const sessionExpired = (detail = 'Your session has ended. Sign in again.') =>
  problem({ code: 'session_expired', status: 401, detail });

export const secondFactorRequired = (detail = 'Complete the second factor to continue.') =>
  problem({ code: 'second_factor_required', status: 401, detail });

/**
 * The session is real and the second factor is satisfied; the account simply
 * may not act until its issued password is replaced.
 *
 * 403 rather than 401 on purpose. 401 means "authenticate", and the console
 * answers a 401 by showing the sign-in screen — which would send the user round
 * a loop they cannot leave, because signing in again lands them in the same
 * state. This is an authenticated caller who is not permitted, which is 403.
 */
export const passwordChangeRequired = (
  detail = 'Set your own password before continuing.',
) => problem({ code: 'password_change_required', status: 403, detail });

export const stepUpRequired = (detail: string, auditSeq?: string | bigint | null | undefined) =>
  problem({ code: 'step_up_required', status: 401, detail, auditSeq });

export const authenticationFailed = (detail: string) =>
  problem({ code: 'authentication_failed', status: 401, detail });

export const forbidden = (code: string, detail: string, auditSeq?: string | bigint | null | undefined) =>
  problem({ code, status: 403, detail, auditSeq });

export const notFound = (detail: string) =>
  problem({ code: 'not_found', status: 404, detail });

export const conflict = (detail: string) =>
  problem({ code: 'conflict', status: 409, detail });

export const unprocessable = (detail: string) =>
  problem({ code: 'unprocessable', status: 422, detail });

export const invalidRequest = (
  detail: string,
  errors?: ReadonlyArray<{ field: string; message: string }> | undefined,
) => problem({ code: 'invalid_request', status: 400, detail, errors });

export const notProvisioned = (detail = 'No tenant is provisioned.') =>
  problem({ code: 'not_provisioned', status: 503, detail });

function humanise(code: string): string {
  return code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Turn a Zod issue list into field errors a form can render inline. */
export function fieldErrors(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): Array<{ field: string; message: string }> {
  return issues.map((i) => ({
    field: i.path.map(String).join('.') || '(body)',
    message: i.message,
  }));
}
