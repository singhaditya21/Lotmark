/**
 * What this API does, described once.
 *
 * ── The test is the deliverable ─────────────────────────────────────────────
 *
 * An OpenAPI document is worth exactly as much as its agreement with the
 * server, and hand-written ones stop agreeing within a release. None of these
 * routes carries a Fastify schema, so there is nothing to generate a document
 * FROM — the honest options were to annotate 45 routes with schemas, or to
 * describe them here and make the disagreement impossible to miss.
 *
 * This is the second. `openapi.test.ts` compares this registry against the
 * route table Fastify actually built, in both directions:
 *
 *   · a route with no operation fails the test — you cannot ship an
 *     undocumented endpoint;
 *   · an operation with no route fails it too — you cannot leave a description
 *     of something that no longer exists, which is the more insidious of the
 *     two because it reads as documentation.
 *
 * There is no allowlist and no "legacy routes" escape hatch. One was
 * considered; a list of exceptions that is allowed to exist is a list that
 * grows, and the point of the test is that it cannot be satisfied by adding a
 * line to it.
 *
 * ── What is described, and what is not ──────────────────────────────────────
 *
 * Method, path, summary, the permission required, and the tag. NOT the request
 * and response bodies: those are validated by zod at the route, and a second
 * copy here would be the drift this file exists to prevent, on a scale the test
 * could not check. The document says what each operation is FOR and who may
 * call it, which is what a reader of an API description actually needs.
 */

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

export interface Operation {
  readonly method: string;
  readonly url: string;
  readonly tag: string;
  readonly summary: string;
  /**
   * Whether a session is required, kept SEPARATE from the permission.
   *
   * The first version had only `permission: string | null` and let null mean
   * both "no session needed" and "a session, but no permission" — so the
   * generated document marked `/auth/me` as reachable without authentication,
   * which is untrue and is exactly the kind of thing somebody builds against.
   * The two questions are different and are asked separately.
   */
  readonly requiresSession: boolean;
  /** The permission required, or null when a session alone is enough. */
  readonly permission: string | null;
  /** Anything a caller has to know that the path does not say. */
  readonly note?: string;
}

/** An operation behind a session and a permission. */
const op = (
  method: string, url: string, tag: string, summary: string,
  permission: string, note?: string,
): Operation => (note === undefined
  ? { method, url, tag, summary, requiresSession: true, permission }
  : { method, url, tag, summary, requiresSession: true, permission, note });

/** A session, but no permission — signing out, asking who you are. */
const sessionOp = (
  method: string, url: string, tag: string, summary: string, note?: string,
): Operation => (note === undefined
  ? { method, url, tag, summary, requiresSession: true, permission: null }
  : { method, url, tag, summary, requiresSession: true, permission: null, note });

/**
 * Reachable with no session at all.
 *
 * Every one of these is a deliberate decision and carries the reason, because
 * the alternative is a route that forgot `requireSession` looking exactly the
 * same in the document.
 */
const publicOp = (
  method: string, url: string, tag: string, summary: string, note: string,
): Operation => ({ method, url, tag, summary, requiresSession: false, permission: null, note });

export const OPERATIONS: readonly Operation[] = [
  /* ── Public ───────────────────────────────────────────────────────────── */
  publicOp('GET', '/health', 'Public', 'Liveness, and whether the database answers',
    'Unauthenticated by design, and says nothing about the data.'),
  publicOp('GET', '/verify/:token', 'Public',
    'Verify a certificate issue from the address printed on it',
    'Unauthenticated DELIBERATELY: an auditor holding a printed certificate must ' +
    'not need an account with the producer whose certificate is in question.'),
  publicOp('GET', '/api/v1/ops/alive', 'Public', 'Liveness and readiness in one place',
    'Deliberately thin. A health endpoint that leaks tenant counts is a ' +
    'reconnaissance endpoint.'),

  /* ── Authentication ───────────────────────────────────────────────────── */
  publicOp('POST', '/api/v1/auth/sign-in', 'Authentication', 'Password authentication',
    'Rate limited to ten attempts a minute per IP. A session created here ' +
    'authorises nothing until the second factor is satisfied.'),
  sessionOp('POST', '/api/v1/auth/second-factor', 'Authentication',
    'Satisfy the second factor',
    'Needs the partial session from sign-in — a cookie that exists and ' +
    'authorises nothing.'),
  sessionOp('POST', '/api/v1/auth/step-up', 'Authentication',
    'Re-authenticate to open a signing window',
    '21 CFR 11 §11.200(a)(1): the first signing of a session needs both ' +
    'components. Subsequent signings within the window may use one.'),
  /* ── Custom fields ────────────────────────────────────────────────────── */
  op('GET', '/api/v1/custom-fields/:entity', 'Custom fields',
    'The shape of the custom-field form for a record type', 'project:read',
    'Definitions only, no data. The permission required depends on the entity — see '
    + 'CUSTOM_FIELD_PERMISSIONS; project:read is named here as the commonest of them.'),
  op('GET', '/api/v1/custom-fields/:entity/:recordId', 'Custom fields',
    'The form and what this record currently holds', 'project:read',
    'Returns the current revision number, which a save must be based on. 0 means nothing '
    + 'has been recorded yet.'),
  op('GET', '/api/v1/custom-fields/:entity/:recordId/history', 'Custom fields',
    'Every revision of a record\u2019s custom fields', 'project:read',
    'Append-only: 21 CFR 11 \u00a711.10(e) requires that a change does not obscure what it replaced.'),
  op('PUT', '/api/v1/custom-fields/:entity/:recordId', 'Custom fields',
    'Record the next revision of a record\u2019s custom fields', 'project:manage',
    'Optimistic: basedOnRevision must be the revision the caller read, and a concurrent save '
    + 'is a 409 rather than a silent overwrite. The permission required depends on the entity.'),

  sessionOp('POST', '/api/v1/auth/password', 'Authentication', 'Replace your own password',
    'Requires the current password as well as the session. Reachable while the account still '
    + 'owes a password change — it is the only route that can clear that state. Ends every other '
    + 'session the user holds.'),
  sessionOp('POST', '/api/v1/auth/sign-out', 'Authentication', 'End the session'),
  sessionOp('GET', '/api/v1/auth/me', 'Authentication',
    'The signed-in person, their teams, permissions and half of the product',
    'Permissions are advisory, for hiding controls. Every act is re-decided ' +
    'server-side.'),

  /* ── Production ───────────────────────────────────────────────────────── */
  op('GET', '/api/v1/projects', 'Production', 'Projects visible to the caller', 'project:read',
    'Filtered by the teams the caller holds project:read in, derived from the ' +
    'same authority object the guard uses.'),
  op('POST', '/api/v1/projects', 'Production', 'Create a project', 'project:manage'),
  op('GET', '/api/v1/projects/:id/budget', 'Production',
    'The uncertainty budget, recomputed from raw measurements', 'project:read',
    'Nothing here reads a stored summary. ISO Guide 35.'),
  op('GET', '/api/v1/projects/:id/studies', 'Production', 'Studies and their state', 'project:read'),
  op('POST', '/api/v1/projects/:id/studies', 'Production', 'Create a study', 'project:manage'),
  op('GET', '/api/v1/projects/:id/values', 'Production', 'Property values', 'project:read'),
  op('POST', '/api/v1/projects/:id/values', 'Production', 'Create a property value', 'value:assign'),
  op('GET', '/api/v1/projects/:id/as-of', 'Production',
    'The register as it stood on a past date', 'project:read',
    'Authorisation is evaluated against TODAY, never the as-of date: reading ' +
    'history is a present-tense act.'),
  op('GET', '/api/v1/projects/:id/lots', 'Production', 'The lot register', 'project:read'),
  op('POST', '/api/v1/projects/:id/release-lot', 'Production',
    'Release a lot, signed', 'lot:release'),
  op('PUT', '/api/v1/studies/:id/results', 'Production', 'Record measurements', 'study:run'),
  op('POST', '/api/v1/studies/:id/sign', 'Production', 'Sign a study and freeze its uncertainty', 'study:sign',
    'Competence-gated: ISO 17034 6.3. The basis is frozen onto the signature.'),
  op('GET', '/api/v1/studies/:id/signature', 'Production', 'The signature on a study', 'project:read'),
  op('POST', '/api/v1/values/:id/assign', 'Production', 'Assign a property value', 'value:assign'),
  op('POST', '/api/v1/values/:id/authorise', 'Production', 'Authorise a property value', 'value:authorise',
    'Segregation of duties: the person who assigned it cannot authorise it.'),
  op('GET', '/api/v1/equipment', 'Production', 'Equipment and calibration', 'project:read'),
  op('GET', '/api/v1/teams', 'Production', 'Teams in the tenant', 'project:read'),

  /* ── Certificates ─────────────────────────────────────────────────────── */
  op('POST', '/api/v1/lots/:id/certificate', 'Certificates', 'Issue a certificate', 'cert:issue'),
  op('GET', '/api/v1/certificates/:id', 'Certificates',
    'A certificate and every issue of it', 'project:read',
    'Issue 1 stays here forever. A reissue never overwrites.'),
  op('GET', '/api/v1/certificates/:id/issues/:n/pdf', 'Certificates',
    'The rendered PDF for an issue', 'project:read'),
  op('GET', '/api/v1/certificates/:id/issues/:n/holders', 'Certificates',
    'Who holds an issue', 'cert:reissue',
    'Also open to order:read_all. Contact identities need pii:contact and ' +
    'reading them is audited.'),
  op('POST', '/api/v1/certificates/:id/reissue', 'Certificates',
    'Reissue, and notify holders', 'cert:reissue',
    'Signed and competence-gated. A refused signing rolls the whole thing back.'),
  op('POST', '/api/v1/certificates/:id/issues/:n/withdraw', 'Certificates',
    'Withdraw an issue and notify holders', 'cert:reissue',
    'Also removes the lot from the catalogue. Unsigned server-side — see ' +
    'docs/architecture/DIVERGENCES.md.'),

  /* ── Quality ──────────────────────────────────────────────────────────── */
  op('GET', '/api/v1/capa', 'Quality', 'Complaints and CAPAs', 'capa:manage'),
  op('GET', '/api/v1/capa/workflow', 'Quality', 'The declared CAPA state machine', 'capa:manage',
    'The console renders transitions from this rather than deciding for itself.'),
  op('POST', '/api/v1/capa/:id/transition', 'Quality', 'Move a CAPA to its next state', 'capa:manage'),
  op('GET', '/api/v1/audit', 'Quality', 'The audit ledger, newest first', 'audit:read'),
  op('POST', '/api/v1/audit/verify', 'Quality', 'Verify the hash chain', 'audit:verify',
    'Reports UNVERIFIED separately from BROKEN: not holding a retired ' +
    'generation key is not evidence of tampering.'),

  /* ── Commerce ─────────────────────────────────────────────────────────── */
  op('GET', '/api/v1/catalogue', 'Commerce', 'Released lots available to buy', 'order:create',
    'Also open to catalogue:manage and order:read_all. A withdrawn lot is absent.'),
  op('PUT', '/api/v1/catalogue/:id', 'Commerce', 'Set a lot price and tier eligibility', 'catalogue:manage'),
  op('GET', '/api/v1/orders', 'Commerce', 'Orders, with their lines and shipments', 'order:read_all',
    'Also open to order:read_own. Which rows exist is decided by row-level ' +
    'security on the organisation, not by a WHERE clause.'),
  op('POST', '/api/v1/orders', 'Commerce', 'Place an order', 'order:create',
    'Stock and lot state are re-read under a row lock inside the transaction.'),
  op('POST', '/api/v1/orders/:id/advance', 'Commerce', 'Advance an order', 'order:advance'),
  op('POST', '/api/v1/orders/:id/shipment', 'Commerce', 'Create a shipment', 'order:advance'),
  op('POST', '/api/v1/shipments/:id/readings', 'Commerce', 'Record logger readings', 'order:advance',
    'A reading outside the temperature class raises a CAPA automatically.'),
  op('GET', '/api/v1/entitlements', 'Commerce', 'Price-tier claims', 'entitlement:decide',
    'Also open to entitlement:claim. An approved tier is recorded and changes ' +
    'no price; there is no tier price list.'),
  op('POST', '/api/v1/entitlements', 'Commerce', 'Claim a price tier', 'entitlement:claim'),
  op('POST', '/api/v1/entitlements/:id/decide', 'Commerce', 'Decide a claim', 'entitlement:decide',
    'SoD-3: you cannot decide a claim you raised.'),
  op('GET', '/api/v1/vault', 'Commerce', 'The laboratory’s own holdings', 'vault:use'),

  /* ── Administration ───────────────────────────────────────────────────── */
  op('GET', '/api/v1/admin/config', 'Administration', 'Configuration versions', 'user:manage'),
  op('GET', '/api/v1/admin/config/:id', 'Administration', 'One version and its entries', 'user:manage'),
  op('POST', '/api/v1/admin/config/draft', 'Administration', 'Open a configuration draft', 'user:manage',
    'One draft per tenant. Two would be a fork.'),
  op('PUT', '/api/v1/admin/config/draft/:id/entry', 'Administration',
    'Write a configuration entry', 'user:manage'),
  op('DELETE', '/api/v1/admin/config/draft/:id/entry/:kind/:key', 'Administration',
    'Remove a configuration entry', 'user:manage'),
  op('GET', '/api/v1/admin/config/draft/:id/review', 'Administration',
    'The diff, and everything that would refuse publication', 'user:manage'),
  op('POST', '/api/v1/admin/config/draft/:id/publish', 'Administration',
    'Publish a draft', 'user:manage',
    'A security or behaviour change must be signed. Publishability is checked ' +
    'BEFORE the signature is collected.'),
  op('DELETE', '/api/v1/admin/config/draft/:id', 'Administration', 'Discard a draft', 'user:manage'),
  op('GET', '/api/v1/admin/people', 'Administration',
    'Users, roles, teams and competence', 'user:manage'),
  op('POST', '/api/v1/admin/users', 'Administration', 'Create an account', 'user:manage',
    'Returns an initial credential ONCE. It is deliberately not in the ledger.'),
  op('POST', '/api/v1/admin/users/:id/deactivate', 'Administration',
    'Deactivate an account', 'user:manage',
    'Never deletion: the id is referenced by signatures that must stay ' +
    'resolvable. Ends sessions and revokes role assignments.'),
  op('POST', '/api/v1/admin/users/:id/roles', 'Administration', 'Grant a role, at a scope and optionally dated', 'user:manage'),
  op('DELETE', '/api/v1/admin/users/:id/roles/:assignmentId', 'Administration',
    'Revoke a role', 'user:manage', 'Revoked, not deleted: an as-of view has to find it.'),
  op('POST', '/api/v1/admin/teams', 'Administration', 'Create a team', 'user:manage'),
  op('POST', '/api/v1/admin/teams/:id/members', 'Administration',
    'Add somebody to a team', 'user:manage', 'Membership is belonging; it grants nothing.'),
  op('DELETE', '/api/v1/admin/teams/:id/members/:userId', 'Administration',
    'End a team membership', 'user:manage'),
  op('POST', '/api/v1/admin/competence', 'Administration',
    'Record a competence authorisation', 'user:manage', 'ISO 17034 6.3.'),

  /* ── Conformance ──────────────────────────────────────────────────────── */
  op('GET', '/api/v1/conformance', 'Conformance',
    'Clause-by-clause conformance, evidenced from the records', 'conformance:read',
    'Reports what the RECORDS show, not what the specification claims. A clause ' +
    'takes the status of its weakest requirement.'),
  op('POST', '/api/v1/conformance/pack', 'Conformance',
    'Assemble and sign the assessment pack', 'audit:export',
    'A separate act from reading, and audited: a pack leaves the building. ' +
    'Signed, digested per section, and reproducible for a given database state.'),

  /* ── Operations ───────────────────────────────────────────────────────── */
  op('GET', '/api/v1/ops', 'Operations',
    'Scheduled job health and disaster-recovery drills', 'audit:read',
    'Says what it cannot see: these checks run inside the API, so they cannot ' +
    'detect the API being down.'),
];

/** Comparable identity for an operation or a route. */
export const routeKey = (r: { method: string; url: string }): string =>
  `${r.method.toUpperCase()} ${r.url}`;
