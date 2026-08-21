# Requirements traceability matrix

GENERATED — do not edit. Run `pnpm --filter @lotmark/api rtm`.

The source is `packages/domain/src/conformance.ts`, and every citation below is checked by `packages/domain/src/__tests__/conformance.test.ts`: the file must exist, and the test file must contain a test named by the cited phrase. Deleting the test that demonstrates a control, or renaming the file that implements it, fails the build rather than quietly leaving a claim behind.

## Summary

| Status | Count | Meaning |
|---|---|---|
| enforced | 25 | the code refuses the thing |
| partial | 3 | enforced on some paths; the gap is stated |
| declared | 1 | written down, nothing checks it |
| not implemented | 0 | absent, and recorded as absent |

A register in which everything is enforced is a register nobody can trust. The gaps below are the reason the rest is worth reading.

## 21 CFR 11 §11.10(a)

### REQ-SIG-ROLLBACK — enforced

A record that could not be signed is not retained as though it had been.

> Found in testing: a refused signing used to COMMIT the unsigned record, because returning from inside the transaction resolves it. The refusal is still recorded, on a separate transaction.

| | |
|---|---|
| Implemented by | `apps/api/src/services/signing.ts`<br>`apps/api/src/services/signing-refusal.ts` |
| Demonstrated by | `apps/api/src/__tests__/signing-rollback.test.ts` — "no record behind" |

## 21 CFR 11 §11.10(b)

### REQ-COPIES — enforced

Accurate and complete copies of records can be produced in human-readable and electronic form.

> Built to PDF/A-2b and checked against the structural subset this repository can verify. NOT veraPDF-verified — there is no Java on this machine — and the gate says so rather than printing a pass it did not earn.

| | |
|---|---|
| Implemented by | `apps/api/src/services/pdfa.ts`<br>`apps/api/src/services/icc.ts` |
| Demonstrated by | `apps/api/src/__tests__/pdfa.test.ts` — "PDF/A" |

## 21 CFR 11 §11.10(c)

### REQ-PROTECTION — partial

Records are protected to enable accurate retrieval throughout the retention period.

> A rehearsed restore proves the backup, the keys, the documents and the PRIVILEGE POSTURE — a restore with --no-privileges matches every row count while leaving the ledger writable. What is NOT covered: off-site copies, and any retention period longer than this installation has existed.

| | |
|---|---|
| Implemented by | `apps/api/scripts/dr-drill.mts`<br>`packages/domain/src/retention.ts` |
| Demonstrated by | — |
| Live evidence | `drills` on the conformance view |

## 21 CFR 11 §11.10(d)

### REQ-ACCESS — enforced

System access is limited to authorised individuals.

> Enforced at the database as well as the service: row-level security is FORCED, so a forgotten WHERE clause returns nothing rather than another organisation's data.

| | |
|---|---|
| Implemented by | `apps/api/src/plugins/session.ts`<br>`packages/db/migrations/0004_row_level_security.sql` |
| Demonstrated by | `packages/db/src/__tests__/rls.test.ts` — "tenant"<br>`packages/db/src/__tests__/holders.test.ts` — "own orders" |

## 21 CFR 11 §11.10(e)

### REQ-KEY-ROTATION — enforced

The integrity key can be changed without invalidating the history it already protects.

> A generation carries a COMMITMENT to its key rather than the key. Verification distinguishes "no key held" from "chain broken", because the two call for opposite responses.

| | |
|---|---|
| Implemented by | `packages/db/migrations/0019_audit_key_generations.sql` |
| Demonstrated by | `packages/db/src/__tests__/audit-rotation.test.ts` — "unbroken" |

## 21 CFR 11 §11.10(e) · ISO 17034 §8.4

### REQ-AUDIT-TRAIL — enforced

A secure, computer-generated, time-stamped audit trail records operator entries and actions, and does not obscure previously recorded information.

> Append-only at two layers — privilege and trigger — and hash-chained under a key held OUTSIDE the database, so somebody with SQL access cannot recompute it.

| | |
|---|---|
| Implemented by | `packages/db/migrations/0002_audit_chain.sql`<br>`apps/api/src/services/audit.ts` |
| Demonstrated by | `packages/db/src/__tests__/audit-chain.test.ts` — "altered entry"<br>`packages/db/src/__tests__/audit-chain.test.ts` — "append-only" |
| Live evidence | `chain` on the conformance view |

## 21 CFR 11 §11.10(f)

### REQ-SEQUENCING — enforced

Operational system checks enforce permitted sequencing of steps and events, and the permitted sequence is the tenant’s to declare.

> Every lifecycle is an explicit transition table, and the table now comes from the ACTIVE configuration with the code machine as the fallback. One machine governs every record of an entity at a time, so publication refuses a change that would leave records in a state the new machine does not have. NOT yet extensible for studies: `studies.state` carries a CHECK listing its two states, and publication refuses a third rather than letting the INSERT fail. A transition’s `requiresSignature`, `signatureMeanings` and `systemInitiated` are ENFORCED: a move a tenant marked as signed is refused without one, and a refused signing rolls the move back rather than leaving it unsigned. Configuration can only ADD a signature — `ALWAYS_SIGNED` is a floor publication refuses to lower, whereas `requiresReason` is a DEFAULT a tenant may waive, and is enforced where it stands. `guards` are evaluated too: a small language with no execution, reading only a facts object the route builds — not the database, not other records, not the clock, not the actor — and failing CLOSED, since the safe reading of a rule nobody can apply is that the move is not allowed. Every guard is parsed and checked against the entity’s vocabulary at publication, so a broken one is a sentence at review rather than a refusal at the move.

| | |
|---|---|
| Implemented by | `packages/domain/src/state-machines.ts`<br>`packages/domain/src/config/workflows.ts`<br>`packages/domain/src/config/guards.ts`<br>`apps/api/src/services/workflows.ts` |
| Demonstrated by | `packages/domain/src/__tests__/workflows.test.ts` — "round trip is lossless"<br>`apps/api/src/__tests__/config-admin.test.ts` — "nowhere to go"<br>`packages/domain/src/__tests__/guards.test.ts` — "reads nothing but the facts it was handed"<br>`apps/api/src/__tests__/workflow-ceremony.test.ts` — "does not meet a condition" |

## 21 CFR 11 §11.10(g)

### REQ-AUTHORITY — enforced

Authority checks ensure only authorised individuals use the system, sign a record, or perform the operation at hand.

> The decision point is called by the SERVICE, never by route middleware, so a job, a CLI or a future mobile API reaches the same check. Segregation of duties is part of it: the rules live in code because they carry the conformance argument, and whether each is ENABLED is the tenant’s — a signed, audited configuration change that now takes effect, having been read by nothing until this. Two rules are declared and NOT enforced, and say so in the register: the refund threshold, because refunds are not modelled at all, and lot-creator-may-not-release, because the only path that releases a lot creates it in the same request so the rule could only ever refuse every release.

| | |
|---|---|
| Implemented by | `apps/api/src/services/guard.ts`<br>`packages/domain/src/sod.ts`<br>`apps/api/src/services/sod.ts` |
| Demonstrated by | `apps/api/src/__tests__/guard.test.ts` — "segregation"<br>`apps/api/src/__tests__/sod.test.ts` — "turns a rule ON when the tenant says so" |
| Live evidence | `segregation` on the conformance view |

## 21 CFR 11 §11.200(a)(1)

### REQ-SIG-COMPONENTS — enforced

The first signing of a session uses both identification components; subsequent signings in that session may use one.

| | |
|---|---|
| Implemented by | `apps/api/src/services/sessions.ts`<br>`apps/api/src/services/signing.ts` |
| Demonstrated by | `apps/api/src/__tests__/signing-rollback.test.ts` — "step-up" |

## 21 CFR 11 §11.30

### REQ-KEY-CUSTODY — partial

Signing keys are held so that a compromise of the records does not forge them.

> The key never enters the database. Custody classes dev_file, env and keychain work; kms and hsm are declared and NOT implemented, and refuse to construct. The class is printed on every certificate, so it cannot overclaim. Production refuses to start on a non-production class.

| | |
|---|---|
| Implemented by | `apps/api/src/services/custody.ts` |
| Demonstrated by | `apps/api/src/__tests__/custody.test.ts` — "custody" |
| Live evidence | `custody` on the conformance view |

## 21 CFR 11 §11.300(b)

### REQ-CREDENTIAL-ISSUANCE — enforced

A password issued to somebody by an administrator is an enrolment credential, not a standing one: the account must replace it before it can act.

> The gate is in requireSession, beside the second-factor gate and after it — so a route added tomorrow cannot forget it, and so the person replacing the credential is the one holding the authenticator. Not yet PERIODIC: §11.300(b) also contemplates password aging, and nothing here expires a password the holder chose.

| | |
|---|---|
| Implemented by | `apps/api/src/plugins/session.ts`<br>`apps/api/src/routes/auth.ts`<br>`packages/db/migrations/0024_password_change.sql` |
| Demonstrated by | `apps/api/src/__tests__/password-change.test.ts` — "refused BEFORE the permission check"<br>`apps/api/src/__tests__/password-change.test.ts` — "has not passed the second factor" |
| Live evidence | `credentials` on the conformance view |

## 21 CFR 11 §11.50

### REQ-SIG-MANIFEST — enforced

A signed record shows the signer, the date and time, and the MEANING of the signature.

> The meaning is chosen by the signer and never inferred from context.

| | |
|---|---|
| Implemented by | `packages/domain/src/signatures.ts`<br>`apps/web/src/components/SignAction.tsx` |
| Demonstrated by | `apps/api/src/__tests__/guard.test.ts` — "signature" |
| Live evidence | `signatures` on the conformance view |

## 21 CFR 11 §11.70

### REQ-SIG-BINDING — enforced

Signatures are linked to their records so they cannot be transferred to another record by ordinary means.

> Ed25519 over a canonical payload. Asymmetric on purpose: an assessor can verify with the public key alone, holding nothing that could produce a signature. Every HMAC verifier is also a forger.

| | |
|---|---|
| Implemented by | `packages/security/src/signing.ts`<br>`apps/api/src/services/signing.ts` |
| Demonstrated by | `packages/security/src/__tests__/signing.test.ts` — "excision resistance"<br>`packages/security/src/__tests__/signing.test.ts` — "a verifier cannot forge" |

## DPDP Act 2023 · CERT-In 2022

### REQ-RETENTION — partial

Records are retained for their statutory minimum, and an erasure request cannot remove a record still needed to support a live certificate.

> The schedule and its classes exist and are enforced where records are deleted. There is no erasure-request workflow, so the refusal path has never been exercised by a real request.

| | |
|---|---|
| Implemented by | `packages/domain/src/retention.ts` |
| Demonstrated by | `packages/domain/src/__tests__/invariants.test.ts` — "retention" |

## GAMP 5 · 21 CFR 11 §11.10(a)

### REQ-CONFIG-VERSION — enforced

A change to what the system does is versioned, reviewed, and attributable, and records state which version they were created under.

> A published version is never edited. Security and behaviour changes require a signature; presentation changes are audited but unsigned, because demanding one to move a field trains people to sign without reading.

| | |
|---|---|
| Implemented by | `apps/api/src/services/config-admin.ts`<br>`packages/domain/src/config/registry.ts` |
| Demonstrated by | `apps/api/src/__tests__/config-admin.test.ts` — "lock everybody out" |
| Live evidence | `config` on the conformance view |

## GAMP 5 · interface specification

### REQ-API-DESCRIPTION — enforced

The published interface description matches the interface.

| | |
|---|---|
| Implemented by | `apps/api/src/http/operations.ts`<br>`apps/api/src/http/openapi.ts` |
| Demonstrated by | `apps/api/src/__tests__/openapi.test.ts` — "undocumented route" |

## GAMP 5 · operational monitoring

### REQ-JOB-HEALTH — enforced

Unattended work that fails is visible, and a job that has never run is distinguishable from one with nothing to do.

> Nothing pages anyone, and these checks run inside the API so they cannot detect the API being down. Both stated on the Operations page.

| | |
|---|---|
| Implemented by | `apps/api/src/services/ops.ts`<br>`packages/db/migrations/0021_ops_observability.sql` |
| Demonstrated by | `apps/api/src/__tests__/ops.test.ts` — "never run" |
| Live evidence | `jobs` on the conformance view |

## ISO 17034 §6.3

### REQ-COMPETENCE — enforced

Personnel performing a reference-material activity are authorised for that activity, and the authorisation is valid on the day they perform it.

> Holding the permission is necessary and not sufficient. The basis relied on is COPIED onto the signature, so editing a competence record later cannot rewrite whether a past act was authorised.

| | |
|---|---|
| Implemented by | `apps/api/src/services/guard.ts`<br>`packages/domain/src/permissions.ts` |
| Demonstrated by | `apps/api/src/__tests__/guard.test.ts` — "competence" |
| Live evidence | `competence` on the conformance view |

## ISO 17034 §7.10 · ISO Guide 35

### REQ-UNCERTAINTY — enforced

The assigned value carries an expanded uncertainty combining every contribution, and is reproducible from the raw measurements.

> Recomputed from raw results on every request. Nothing reads a stored summary and no screen offers a field to type a value into.

| | |
|---|---|
| Implemented by | `packages/stats/src/budget.ts`<br>`apps/api/src/routes/console.ts` |
| Demonstrated by | `packages/stats/src/__tests__/golden.test.ts` — "combine" |
| Live evidence | `uncertainty` on the conformance view |

## ISO 17034 §7.11

### REQ-WITHDRAWAL — enforced

When a certified value is found to be wrong, every holder of the affected certificate is identified and told.

> The holder set is order lines UNION self-declared vault holdings, because a vial received as a sample or a replacement has no order line. Holders nobody can be addressed at are reported SEPARATELY and never counted as notified.

| | |
|---|---|
| Implemented by | `apps/api/src/routes/certificates.ts`<br>`apps/api/src/services/certificate-issue.ts` |
| Demonstrated by | `packages/db/src/__tests__/holders.test.ts` — "holder list" |
| Live evidence | `holders` on the conformance view |

## ISO 17034 §7.11 · 21 CFR 11 §11.10(b)

### REQ-REPRODUCIBLE — enforced

A certificate can be reproduced exactly from the record of what was issued.

> Dates come from the issue rather than the clock, and the document ID from the content digest. Re-rendering an issue made under an EARLIER renderer version legitimately differs; those are covered by the stored digest instead.

| | |
|---|---|
| Implemented by | `apps/api/src/services/certificate-pdf.ts` |
| Demonstrated by | `apps/api/src/__tests__/certificate-pdf.test.ts` — "byte-identical"<br>`apps/api/src/__tests__/certificate-pdf.test.ts` — "wall clock" |

## ISO 17034 §7.11 · ISO Guide 31

### REQ-CERTIFICATE — enforced

The certificate states the assigned value, its uncertainty, the coverage factor, expiry, storage and who authorised it.

| | |
|---|---|
| Implemented by | `apps/api/src/services/certificate-pdf.ts` |
| Demonstrated by | `apps/api/src/__tests__/certificate-pdf.test.ts` — "certified figure" |
| Live evidence | `certificates` on the conformance view |

## ISO 17034 §7.12

### REQ-STORAGE — enforced

Storage and transport conditions are specified and departures are acted on.

> A logger reading outside the shipment class raises a CAPA automatically.

| | |
|---|---|
| Implemented by | `apps/api/src/routes/commerce.ts` |
| Demonstrated by | `apps/api/src/__tests__/commerce.test.ts` — "cold chain" |
| Live evidence | `coldchain` on the conformance view |

## ISO 17034 §7.4

### REQ-SUBCONTRACT — declared

Work that may not be subcontracted is identified, and subcontracted work is controlled.

> DECLARED AND NOT ENFORCED. The schema comment says a forbidden-activity list "lives in @lotmark/domain and is enforced at the service boundary". It does not exist — only the subcontractor:manage permission does. This is recorded as a gap rather than described as a control.

| | |
|---|---|
| Implemented by | `packages/db/src/schema/compliance.ts` |
| Demonstrated by | — |

## ISO 17034 §7.7 · ISO Guide 35

### REQ-HOMOGENEITY — enforced

Between-unit variation is assessed and contributes to the uncertainty budget.

| | |
|---|---|
| Implemented by | `packages/stats/src/homogeneity.ts` |
| Demonstrated by | `packages/stats/src/__tests__/golden.test.ts` — "homogeneity" |
| Live evidence | `homogeneity` on the conformance view |

### REQ-STABILITY — enforced

Stability over the shelf life is assessed and contributes to the uncertainty budget.

| | |
|---|---|
| Implemented by | `packages/stats/src/stability.ts` |
| Demonstrated by | `packages/stats/src/__tests__/golden.test.ts` — "stability" |
| Live evidence | `stability` on the conformance view |

## ISO 17034 §7.8

### REQ-MONITORING — enforced

Stability is monitored after release, and an overdue check is acted on.

> A scheduled job raises a CAPA when monitoring falls overdue. Whether that job is running is itself reported — see REQ-JOB-HEALTH.

| | |
|---|---|
| Implemented by | `apps/api/src/jobs/notices.ts` |
| Demonstrated by | `apps/api/src/__tests__/ops.test.ts` — "never run" |
| Live evidence | `monitoring` on the conformance view |

## ISO 17034 §7.9 · ISO Guide 35

### REQ-CHARACTERISATION — enforced

The property value is characterised, and the interlaboratory spread contributes to the uncertainty budget.

| | |
|---|---|
| Implemented by | `packages/stats/src/characterisation.ts` |
| Demonstrated by | `packages/stats/src/__tests__/golden.test.ts` — "characterisation" |
| Live evidence | `characterisation` on the conformance view |

## ISO 17034 §8.7

### REQ-CAPA — enforced

Nonconformities are recorded, investigated, corrected and checked for effect.

| | |
|---|---|
| Implemented by | `apps/api/src/routes/capa.ts`<br>`packages/domain/src/state-machines.ts` |
| Demonstrated by | `apps/web/src/lib/__tests__/capa.test.ts` — "close" |
| Live evidence | `capa` on the conformance view |

