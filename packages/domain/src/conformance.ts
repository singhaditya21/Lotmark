/**
 * What this system claims to do, and where the proof is.
 *
 * ── Why a register, and why here ────────────────────────────────────────────
 *
 * Under GAMP 5 and 21 CFR Part 11 the validation evidence has to attest what
 * the system actually does. That means somebody has to be able to ask "show me
 * where you enforce competence" and get an answer that is checked rather than
 * asserted — and a traceability matrix maintained by hand rots within two
 * releases, because nothing fails when it stops being true.
 *
 * So each requirement names its evidence as PATHS AND TEST NAMES, and
 * `conformance.test.ts` asserts every one of them resolves: the file exists,
 * and a test in it is DECLARED under that name. A requirement whose evidence
 * has been deleted or renamed fails the suite. The matrix in docs/validation is
 * generated from this; it is a report, never a source.
 *
 * What that check does NOT do is run the test. This paragraph used to claim it
 * asserted the test "passes", which it never did — a citation is a pointer, and
 * whether the thing it points at is green is what CI is for. It also used to
 * match the name anywhere in the file, so an IMPORT of a function with the
 * right name satisfied a requirement; it now parses `it`/`test`/`describe`
 * titles, which is what caught four bad citations, two of them written the same
 * day as this correction.
 *
 * ── Status is not a grade ───────────────────────────────────────────────────
 *
 * `enforced` means the code refuses the thing. `declared` means the rule is
 * written down and nothing checks it — which is worse than absent, because it
 * reads as a control. `partial` means enforced in some paths. `not_implemented`
 * means exactly that.
 *
 * Being honest about `declared` and `not_implemented` is the point. An
 * assessment pack listing everything as enforced is a pack nobody can trust.
 */

export type RequirementStatus = 'enforced' | 'partial' | 'declared' | 'not_implemented';

export interface Requirement {
  readonly id: string;
  /** The clause or regulation this comes from. */
  readonly clause: string;
  readonly statement: string;
  readonly status: RequirementStatus;
  /** Repo-relative paths that implement it. Checked to exist. */
  readonly code: readonly string[];
  /**
   * Test files that demonstrate it, and a phrase from a test name within them.
   * Both are checked: the file must exist and contain the phrase.
   */
  readonly tests: readonly { readonly file: string; readonly named: string }[];
  /**
   * A key the live conformance view resolves against real data, when the
   * requirement is one that can be evidenced from the records themselves.
   */
  readonly live?: string;
  /** Anything a reader needs, especially about a limit. */
  readonly note?: string;
}

export const REQUIREMENTS: readonly Requirement[] = [
  /* ── ISO 17034 ────────────────────────────────────────────────────────── */
  {
    id: 'REQ-COMPETENCE',
    clause: 'ISO 17034 §6.3',
    statement:
      'Personnel performing a reference-material activity are authorised for that ' +
      'activity, and the authorisation is valid on the day they perform it.',
    status: 'enforced',
    code: ['apps/api/src/services/guard.ts', 'packages/domain/src/permissions.ts'],
    tests: [{ file: 'apps/api/src/__tests__/guard.test.ts', named: 'competence' }],
    live: 'competence',
    note:
      'Holding the permission is necessary and not sufficient. The basis relied ' +
      'on is COPIED onto the signature, so editing a competence record later ' +
      'cannot rewrite whether a past act was authorised.',
  },
  {
    id: 'REQ-SUBCONTRACT',
    clause: 'ISO 17034 §7.4',
    statement:
      'Work that may not be subcontracted is identified, and subcontracted work ' +
      'is controlled.',
    status: 'declared',
    code: ['packages/db/src/schema/compliance.ts'],
    tests: [],
    note:
      'DECLARED AND NOT ENFORCED. The schema comment says a forbidden-activity ' +
      'list "lives in @lotmark/domain and is enforced at the service boundary". ' +
      'It does not exist — only the subcontractor:manage permission does. This ' +
      'is recorded as a gap rather than described as a control.',
  },
  {
    id: 'REQ-HOMOGENEITY',
    clause: 'ISO 17034 §7.7 · ISO Guide 35',
    statement:
      'Between-unit variation is assessed and contributes to the uncertainty budget.',
    status: 'enforced',
    code: ['packages/stats/src/homogeneity.ts'],
    tests: [{ file: 'packages/stats/src/__tests__/golden.test.ts', named: 'homogeneity' }],
    live: 'homogeneity',
  },
  {
    id: 'REQ-STABILITY',
    clause: 'ISO 17034 §7.7 · ISO Guide 35',
    statement:
      'Stability over the shelf life is assessed and contributes to the uncertainty budget.',
    status: 'enforced',
    code: ['packages/stats/src/stability.ts'],
    tests: [{ file: 'packages/stats/src/__tests__/golden.test.ts', named: 'stability' }],
    live: 'stability',
  },
  {
    id: 'REQ-MONITORING',
    clause: 'ISO 17034 §7.8',
    statement: 'Stability is monitored after release, and an overdue check is acted on.',
    status: 'enforced',
    code: ['apps/api/src/jobs/notices.ts'],
    tests: [{ file: 'apps/api/src/__tests__/ops.test.ts', named: 'never run' }],
    live: 'monitoring',
    note:
      'A scheduled job raises a CAPA when monitoring falls overdue. Whether that ' +
      'job is running is itself reported — see REQ-JOB-HEALTH.',
  },
  {
    id: 'REQ-CHARACTERISATION',
    clause: 'ISO 17034 §7.9 · ISO Guide 35',
    statement:
      'The property value is characterised, and the interlaboratory spread contributes ' +
      'to the uncertainty budget.',
    status: 'enforced',
    code: ['packages/stats/src/characterisation.ts'],
    tests: [{ file: 'packages/stats/src/__tests__/golden.test.ts', named: 'characterisation' }],
    live: 'characterisation',
  },
  {
    id: 'REQ-UNCERTAINTY',
    clause: 'ISO 17034 §7.10 · ISO Guide 35',
    statement:
      'The assigned value carries an expanded uncertainty combining every ' +
      'contribution, and is reproducible from the raw measurements.',
    status: 'enforced',
    code: ['packages/stats/src/budget.ts', 'apps/api/src/routes/console.ts'],
    tests: [{
      file: 'packages/stats/src/__tests__/golden.test.ts',
      named: 'uncertainty budget reproduces the prototype',
    }],
    live: 'uncertainty',
    note:
      'Recomputed from raw results on every request. Nothing reads a stored ' +
      'summary and no screen offers a field to type a value into.',
  },
  {
    id: 'REQ-CERTIFICATE',
    clause: 'ISO 17034 §7.11 · ISO Guide 31',
    statement:
      'The certificate states the assigned value, its uncertainty, the coverage ' +
      'factor, expiry, storage and who authorised it.',
    status: 'enforced',
    code: ['apps/api/src/services/certificate-pdf.ts'],
    tests: [{ file: 'apps/api/src/__tests__/certificate-pdf.test.ts', named: 'certified figure' }],
    live: 'certificates',
  },
  {
    id: 'REQ-REPRODUCIBLE',
    clause: 'ISO 17034 §7.11 · 21 CFR 11 §11.10(b)',
    statement:
      'A certificate can be reproduced exactly from the record of what was issued.',
    status: 'enforced',
    code: ['apps/api/src/services/certificate-pdf.ts'],
    tests: [
      { file: 'apps/api/src/__tests__/certificate-pdf.test.ts', named: 'byte-identical' },
      { file: 'apps/api/src/__tests__/certificate-pdf.test.ts', named: 'wall clock' },
    ],
    note:
      'Dates come from the issue rather than the clock, and the document ID from ' +
      'the content digest. Re-rendering an issue made under an EARLIER renderer ' +
      'version legitimately differs; those are covered by the stored digest ' +
      'instead.',
  },
  {
    id: 'REQ-WITHDRAWAL',
    clause: 'ISO 17034 §7.11',
    statement:
      'When a certified value is found to be wrong, every holder of the affected ' +
      'certificate is identified and told.',
    status: 'partial',
    code: [
      'apps/api/src/routes/certificates.ts',
      'apps/api/src/services/certificate-issue.ts',
    ],
    tests: [{ file: 'packages/db/src/__tests__/holders.test.ts', named: 'holder list' }],
    live: 'holders',
    note:
      'IDENTIFICATION is enforced. The holder set is order lines UNION ' +
      'self-declared vault holdings, because a vial received as a sample or a ' +
      'replacement has no order line, and holders nobody can be addressed at are ' +
      'reported SEPARATELY and never counted as notified. ' +
      'TELLING is not. This said `enforced` on the strength of the first half of ' +
      'its own sentence. Withdrawal writes a row in `notifications` addressed to ' +
      'a user at the holding organisation, and that is the whole of the delivery: ' +
      'there is no email, SMS or webhook path anywhere in this codebase, so a ' +
      'holder who does not sign in is never told. Nothing escalates an unread ' +
      'notice either, though `read_at` and `acknowledged_at` are recorded and ' +
      'would support it. For a §7.11 recall that gap is the difference between ' +
      'informing a customer and filing a note that they were informed.',
  },
  {
    id: 'REQ-STORAGE',
    clause: 'ISO 17034 §7.12',
    statement: 'Storage and transport conditions are specified and departures are acted on.',
    status: 'enforced',
    code: ['apps/api/src/routes/commerce.ts'],
    tests: [{ file: 'apps/api/src/__tests__/commerce.test.ts', named: 'cold chain' }],
    live: 'coldchain',
    note: 'A logger reading outside the shipment class raises a CAPA automatically.',
  },
  {
    id: 'REQ-CAPA',
    clause: 'ISO 17034 §8.7',
    statement: 'Nonconformities are recorded, investigated, corrected and checked for effect.',
    status: 'enforced',
    code: ['apps/api/src/routes/capa.ts', 'packages/domain/src/state-machines.ts'],
    /**
     * Server evidence FIRST, and it used to be the only citation that was a
     * console test. `apps/web` tests assert what the console does with an
     * answer; they cannot assert that the server refuses anything, and this
     * product is explicit that hiding a control is a courtesy rather than a
     * control. A requirement evidenced only from the browser is evidenced by
     * something incapable of demonstrating it.
     */
    tests: [
      { file: 'apps/api/src/__tests__/workflow-ceremony.test.ts', named: 'refuses a CAPA move that does not state why' },
      { file: 'apps/web/src/lib/__tests__/capa.test.ts', named: 'close' },
    ],
    live: 'capa',
    note:
      'The register cited only a CONSOLE test for this until an evidence check ' +
      'was tightened to reject that. The server-side rule an assessor cares ' +
      'about — a nonconformity cannot close without a recorded root cause and ' +
      'corrective action — is enforced in the route and is now what is cited.',
  },

  /* ── 21 CFR Part 11 ───────────────────────────────────────────────────── */
  {
    id: 'REQ-AUDIT-TRAIL',
    clause: '21 CFR 11 §11.10(e) · ISO 17034 §8.4',
    statement:
      'A secure, computer-generated, time-stamped audit trail records operator ' +
      'entries and actions, and does not obscure previously recorded information.',
    status: 'enforced',
    code: ['packages/db/migrations/0002_audit_chain.sql', 'apps/api/src/services/audit.ts'],
    tests: [
      { file: 'packages/db/src/__tests__/audit-chain.test.ts', named: 'altered entry' },
      { file: 'packages/db/src/__tests__/audit-chain.test.ts', named: 'append-only' },
    ],
    live: 'chain',
    note:
      'Append-only at two layers — privilege and trigger — and hash-chained under ' +
      'a key held OUTSIDE the database, so somebody with SQL access cannot ' +
      'recompute it.',
  },
  {
    id: 'REQ-KEY-ROTATION',
    clause: '21 CFR 11 §11.10(e)',
    statement:
      'The integrity key can be changed without invalidating the history it ' +
      'already protects.',
    status: 'enforced',
    code: ['packages/db/migrations/0019_audit_key_generations.sql'],
    tests: [{ file: 'packages/db/src/__tests__/audit-rotation.test.ts', named: 'unbroken' }],
    note:
      'A generation carries a COMMITMENT to its key rather than the key. ' +
      'Verification distinguishes "no key held" from "chain broken", because the ' +
      'two call for opposite responses.',
  },
  {
    id: 'REQ-ACCESS',
    clause: '21 CFR 11 §11.10(d)',
    statement: 'System access is limited to authorised individuals.',
    status: 'enforced',
    code: ['apps/api/src/plugins/session.ts', 'packages/db/migrations/0004_row_level_security.sql'],
    tests: [
      { file: 'packages/db/src/__tests__/rls.test.ts', named: 'tenant' },
      { file: 'packages/db/src/__tests__/holders.test.ts', named: 'own orders' },
    ],
    note:
      'Enforced at the database as well as the service: row-level security is ' +
      'FORCED, so a forgotten WHERE clause returns nothing rather than another ' +
      'organisation\'s data.',
  },
  {
    id: 'REQ-CREDENTIAL-ISSUANCE',
    clause: '21 CFR 11 §11.300(b)',
    statement:
      'A password issued to somebody by an administrator is an enrolment ' +
      'credential, not a standing one: the account must replace it before it ' +
      'can act.',
    status: 'enforced',
    code: [
      'apps/api/src/plugins/session.ts',
      'apps/api/src/routes/auth.ts',
      'packages/db/migrations/0024_password_change.sql',
    ],
    tests: [
      { file: 'apps/api/src/__tests__/password-change.test.ts', named: 'refused BEFORE the permission check' },
      { file: 'apps/api/src/__tests__/password-change.test.ts', named: 'has not passed the second factor' },
    ],
    live: 'credentials',
    note:
      'The gate is in requireSession, beside the second-factor gate and after ' +
      'it — so a route added tomorrow cannot forget it, and so the person ' +
      'replacing the credential is the one holding the authenticator. Not yet ' +
      'PERIODIC: §11.300(b) also contemplates password aging, and nothing here ' +
      'expires a password the holder chose.',
  },
  {
    id: 'REQ-SEQUENCING',
    clause: '21 CFR 11 §11.10(f)',
    statement:
      'Operational system checks enforce permitted sequencing of steps and ' +
      'events, and the permitted sequence is the tenant\u2019s to declare.',
    status: 'enforced',
    code: [
      'packages/domain/src/state-machines.ts',
      'packages/domain/src/config/workflows.ts',
      'packages/domain/src/config/guards.ts',
      'apps/api/src/services/workflows.ts',
    ],
    tests: [
      { file: 'packages/domain/src/__tests__/workflows.test.ts', named: 'round trip is lossless' },
      { file: 'apps/api/src/__tests__/config-admin.test.ts', named: 'refuses removing a state records are sitting in' },
      { file: 'packages/domain/src/__tests__/guards.test.ts', named: 'reads nothing but the facts it was handed' },
      { file: 'apps/api/src/__tests__/workflow-ceremony.test.ts', named: 'refuses the move when the condition does not hold' },
    ],
    note:
      'Every lifecycle is an explicit transition table, and the table now comes ' +
      'from the ACTIVE configuration with the code machine as the fallback. One ' +
      'machine governs every record of an entity at a time, so publication ' +
      'refuses a change that would leave records in a state the new machine does ' +
      'not have. NOT yet extensible for studies: `studies.state` carries a CHECK ' +
      'listing its two states, and publication refuses a third rather than ' +
      'letting the INSERT fail. A transition\u2019s `requiresSignature`, ' +
      '`signatureMeanings` and `systemInitiated` are ENFORCED: a move a tenant ' +
      'marked as signed is refused without one, and a refused signing rolls the ' +
      'move back rather than leaving it unsigned. Configuration can only ADD a ' +
      'signature — `ALWAYS_SIGNED` is a floor publication refuses to lower, ' +
      'whereas `requiresReason` is a DEFAULT a tenant may waive, and is enforced ' +
      'where it stands. `guards` are evaluated too: a small language with no ' +
      'execution, reading only a facts object the route builds — not the ' +
      'database, not other records, not the clock, not the actor — and failing ' +
      'CLOSED, since the safe reading of a rule nobody can apply is that the ' +
      'move is not allowed. Every guard is parsed and checked against the ' +
      'entity\u2019s vocabulary at publication, so a broken one is a sentence ' +
      'at review rather than a refusal at the move.',
  },
  {
    id: 'REQ-AUTHORITY',
    clause: '21 CFR 11 §11.10(g)',
    statement:
      'Authority checks ensure only authorised individuals use the system, sign a ' +
      'record, or perform the operation at hand.',
    status: 'enforced',
    code: [
      'apps/api/src/services/guard.ts',
      'packages/domain/src/sod.ts',
      'apps/api/src/services/sod.ts',
    ],
    tests: [
      { file: 'apps/api/src/__tests__/guard.test.ts', named: 'segregation' },
      { file: 'apps/api/src/__tests__/sod.test.ts', named: 'turns a rule ON when the tenant says so' },
    ],
    live: 'segregation',
    note:
      'The decision point is called by the SERVICE, never by route middleware, ' +
      'so a job, a CLI or a future mobile API reaches the same check. ' +
      'Segregation of duties is part of it: the rules live in code because they ' +
      'carry the conformance argument, and whether each is ENABLED is the ' +
      'tenant\u2019s — a signed, audited configuration change that now takes ' +
      'effect, having been read by nothing until this. Two rules are declared ' +
      'and NOT enforced, and say so in the register: the refund threshold, ' +
      'because refunds are not modelled at all, and lot-creator-may-not-release, ' +
      'because the only path that releases a lot creates it in the same request ' +
      'so the rule could only ever refuse every release.',
  },
  {
    id: 'REQ-SIG-MANIFEST',
    clause: '21 CFR 11 §11.50',
    statement:
      'A signed record shows the signer, the date and time, and the MEANING of ' +
      'the signature.',
    status: 'enforced',
    code: ['packages/domain/src/signatures.ts', 'apps/web/src/components/SignAction.tsx'],
    tests: [{ file: 'apps/api/src/__tests__/guard.test.ts', named: 'signature' }],
    live: 'signatures',
    note: 'The meaning is chosen by the signer and never inferred from context.',
  },
  {
    id: 'REQ-SIG-BINDING',
    clause: '21 CFR 11 §11.70',
    statement:
      'Signatures are linked to their records so they cannot be transferred to ' +
      'another record by ordinary means.',
    status: 'enforced',
    code: ['packages/security/src/signing.ts', 'apps/api/src/services/signing.ts'],
    tests: [
      { file: 'packages/security/src/__tests__/signing.test.ts', named: 'excision resistance' },
      { file: 'packages/security/src/__tests__/signing.test.ts', named: 'a verifier cannot forge' },
    ],
    note:
      'Ed25519 over a canonical payload. Asymmetric on purpose: an assessor can ' +
      'verify with the public key alone, holding nothing that could produce a ' +
      'signature. Every HMAC verifier is also a forger.',
  },
  {
    id: 'REQ-SIG-COMPONENTS',
    clause: '21 CFR 11 §11.200(a)(1)',
    statement:
      'The first signing of a session uses both identification components; ' +
      'subsequent signings in that session may use one.',
    status: 'enforced',
    code: ['apps/api/src/services/sessions.ts', 'apps/api/src/services/signing.ts'],
    tests: [{ file: 'apps/api/src/__tests__/signing-rollback.test.ts', named: 'step-up' }],
  },
  {
    id: 'REQ-SIG-ROLLBACK',
    clause: '21 CFR 11 §11.10(a)',
    statement:
      'A record that could not be signed is not retained as though it had been.',
    status: 'enforced',
    code: ['apps/api/src/services/signing.ts', 'apps/api/src/services/signing-refusal.ts'],
    tests: [{ file: 'apps/api/src/__tests__/signing-rollback.test.ts', named: 'no record behind' }],
    note:
      'Found in testing: a refused signing used to COMMIT the unsigned record, ' +
      'because returning from inside the transaction resolves it. The refusal is ' +
      'still recorded, on a separate transaction.',
  },
  {
    id: 'REQ-COPIES',
    clause: '21 CFR 11 §11.10(b)',
    statement:
      'Accurate and complete copies of records can be produced in human-readable ' +
      'and electronic form.',
    status: 'enforced',
    code: ['apps/api/src/services/pdfa.ts', 'apps/api/src/services/icc.ts'],
    tests: [{ file: 'apps/api/src/__tests__/pdfa.test.ts', named: 'PDF/A' }],
    note:
      'Built to PDF/A-2b and checked against the structural subset this ' +
      'repository can verify. NOT veraPDF-verified — there is no Java on this ' +
      'machine — and the gate says so rather than printing a pass it did not earn.',
  },
  {
    id: 'REQ-PROTECTION',
    clause: '21 CFR 11 §11.10(c)',
    statement: 'Records are protected to enable accurate retrieval throughout the retention period.',
    status: 'partial',
    code: ['apps/api/scripts/dr-drill.mts', 'packages/domain/src/retention.ts'],
    tests: [],
    live: 'drills',
    note:
      'A rehearsed restore proves the backup, the keys, the documents and the ' +
      'PRIVILEGE POSTURE — a restore with --no-privileges matches every row count ' +
      'while leaving the ledger writable. What is NOT covered: off-site copies, ' +
      'and any retention period longer than this installation has existed.',
  },
  {
    id: 'REQ-KEY-CUSTODY',
    clause: '21 CFR 11 §11.30',
    statement: 'Signing keys are held so that a compromise of the records does not forge them.',
    status: 'partial',
    code: ['apps/api/src/services/custody.ts'],
    tests: [{ file: 'apps/api/src/__tests__/custody.test.ts', named: 'custody' }],
    live: 'custody',
    note:
      'The key never enters the database. Custody classes dev_file, env and ' +
      'keychain work; kms and hsm are declared and NOT implemented, and refuse ' +
      'to construct. The class is printed on every certificate, so it cannot ' +
      'overclaim. Production refuses to start on a non-production class.',
  },

  /* ── Operating the system ─────────────────────────────────────────────── */
  {
    id: 'REQ-JOB-HEALTH',
    clause: 'GAMP 5 · operational monitoring',
    statement:
      'Unattended work that fails is visible, and a job that has never run is ' +
      'distinguishable from one with nothing to do.',
    status: 'enforced',
    code: ['apps/api/src/services/ops.ts', 'packages/db/migrations/0021_ops_observability.sql'],
    tests: [{ file: 'apps/api/src/__tests__/ops.test.ts', named: 'never run' }],
    live: 'jobs',
    note:
      'Nothing pages anyone, and these checks run inside the API so they cannot ' +
      'detect the API being down. Both stated on the Operations page.',
  },
  {
    id: 'REQ-CONFIG-VERSION',
    clause: 'GAMP 5 · 21 CFR 11 §11.10(a)',
    statement:
      'A change to what the system does is versioned, reviewed, and attributable, ' +
      'and records state which version they were created under.',
    status: 'enforced',
    code: ['apps/api/src/services/config-admin.ts', 'packages/domain/src/config/registry.ts'],
    tests: [{ file: 'apps/api/src/__tests__/config-admin.test.ts', named: 'lock everybody out' }],
    live: 'config',
    note:
      'A published version is never edited. Security and behaviour changes ' +
      'require a signature; presentation changes are audited but unsigned, ' +
      'because demanding one to move a field trains people to sign without ' +
      'reading.',
  },
  {
    id: 'REQ-API-DESCRIPTION',
    clause: 'GAMP 5 · interface specification',
    statement: 'The published interface description matches the interface.',
    status: 'enforced',
    code: ['apps/api/src/http/operations.ts', 'apps/api/src/http/openapi.ts'],
    tests: [{ file: 'apps/api/src/__tests__/openapi.test.ts', named: 'undocumented route' }],
  },
  {
    id: 'REQ-RETENTION',
    clause: 'DPDP Act 2023 · CERT-In 2022',
    statement:
      'Records are retained for their statutory minimum, and an erasure request ' +
      'cannot remove a record still needed to support a live certificate.',
    status: 'partial',
    code: [
      'packages/domain/src/retention.ts',
      'apps/api/src/services/retention.ts',
      'apps/api/src/jobs/notices.ts',
    ],
    tests: [
      { file: 'packages/domain/src/__tests__/invariants.test.ts', named: 'retention' },
      { file: 'apps/api/src/__tests__/retention.test.ts', named: 'CERT-In' },
      { file: 'apps/api/src/__tests__/config-admin.test.ts', named: 'below the statutory minimum' },
    ],
    live: 'retention',
    note:
      'The statutory floor is now enforced in BOTH places the schema always ' +
      'claimed: publication refuses a period below it, naming the regime, and ' +
      'the runtime takes the greater of the stored period and the floor. ' +
      'CORRECTION to what this note used to say — it claimed the schedule was ' +
      '"enforced where records are deleted", and the only deletion path in the ' +
      'product removed sessions after SEVEN days against the 180 CERT-In 2022 ' +
      'requires of an access log. That is fixed and tested. Still PARTIAL: ' +
      'there is no erasure-request workflow, so the refusal path has never been ' +
      'exercised by a real request, and nothing actively erases customer ' +
      'contact data once no order is open — DPDP minimisation is declared and ' +
      'not performed.',
  },
];

export const ALL_REQUIREMENT_IDS = REQUIREMENTS.map((r) => r.id);

export function requirementsByStatus(): Record<RequirementStatus, Requirement[]> {
  const out: Record<RequirementStatus, Requirement[]> = {
    enforced: [], partial: [], declared: [], not_implemented: [],
  };
  for (const r of REQUIREMENTS) out[r.status].push(r);
  return out;
}

/** Clauses, each with the requirements that evidence it. */
export function byClause(): Array<{ clause: string; requirements: Requirement[] }> {
  const map = new Map<string, Requirement[]>();
  for (const r of REQUIREMENTS) {
    const list = map.get(r.clause) ?? [];
    list.push(r);
    map.set(r.clause, list);
  }
  return [...map].map(([clause, requirements]) => ({ clause, requirements }))
    .sort((a, b) => a.clause.localeCompare(b.clause));
}
