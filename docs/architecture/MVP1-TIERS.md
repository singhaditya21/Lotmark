# LOTMARK — MVP 1 DEFINITION

**Three go-live tiers, what each buys, what each costs, and what each cannot claim.**

Date: 21 August 2026 · Basis: verified code state, `docs/architecture/ARCHITECTURE.md`, `docs/architecture/ARCHITECTURE-CRITIQUE.md`, `docs/commercial/Lotmark_and_IPC_Estimate_v5.xlsx`

---

## 1. WHERE WE ARE

The domain core is real and it is the hard part. Seven state machines, 29 permissions, six segregation-of-duties rules including SoD-5 and the refund threshold (`packages/domain/src/sod.ts:92–160`), a 14-kind configuration model with risk-tiered ceremony (`packages/domain/src/config/registry.ts:40–57`), the ISO Guide 35 statistics engine golden-tested at exact float equality (`packages/stats/src/homogeneity.ts:48`), Ed25519 detached signatures bound to length-prefixed canonical material with a `canonical_version` for forward compatibility, Argon2id password hashing with a TOTP replay cache, Postgres-backed lockouts, and a 43-table schema with an HMAC-chained append-only audit ledger (`packages/db/migrations/0002_audit_chain.sql`). 223 tests pass. Every package typechecks clean. The guard chain — permission, then competence, then SoD, then step-up, then state machine — is enforced at every one of the five signing sites that exist, and the competence a signer relied on is frozen into the signature basis rather than looked up again later. Measured against 21 CFR 11, clause **11.10(g)** authority checks and clause **11.70** signature-record binding are the strongest things in the build, and they are genuinely done.

What is absent is the ability to operate the system. There is **no way to create any business record**: of the 19 routes, the only POSTs are the four auth routes plus study-sign, value-assign, value-authorise, lot-release, certificate-issue and audit-verify. There is no `POST /projects`, no `POST /studies`, no `PUT /studies/:id/results`, no `POST /competence`. Every project, study, raw result and property value in the system originates in `packages/db/src/seed/run.ts`. **Row-level security has since landed** and this paragraph's original claim that it had never run is superseded: `0004_row_level_security.sql` is applied, RLS is `ENABLE`d and `FORCE`d on 43 of 43 tables with 43 policies, `0005_app_role.sql` creates the non-superuser `lotmark_app` the API now connects as, `0006_tenant_resolution.sql` supplies the `SECURITY DEFINER` bootstrap read, and `rls.test.ts` asserts isolation in 10 tests driven off `pg_class`/`pg_policies`. What remains of that blocker is the `generation` column, the generation-agnostic ledger-policy shape, and the raise-versus-NULL decision on `current_tenant()`. There is no PDF pipeline, so nothing the product exists to produce can leave the building. There are no background jobs, so the audit chain is never anchored and the monitoring schedule generates no work. `audit_checkpoints` has no signature column and lives inside the database it notarises, which makes the tamper-evidence argument circular. Signing key custody is `dev_file`, meaning the API process can read the key that signs its own anchors.

| Area | Built and working | Verified gap |
|---|---|---|
| **Domain model** | 43 tables, 7 applied migrations, 7 state machines, 29 permissions, 6 SoD rules, retention schedule with `ERASURE_REFUSABLE`/`INDIA_RESIDENT` sets | 26 tables named in ARCHITECTURE §3.2/§4.2 absent, incl. `uncertainty_component`, `property_value_version`, `denial_ledger`, `certificate_template`, `blob`, `notification_outbox` |
| **Statistics** | `oneWayAnova`, `linearStability`, `shelfLifeMonthsBetween`, `combineBudget`, `expandedUncertainty` — golden-tested at exact float equality | No ν_eff, no Welch–Satterthwaite; `k` is a **caller-supplied parameter** (`packages/stats/src/budget.ts:68` says so in its own comment); consensus is an unweighted mean with no outlier handling (`characterisation.ts:25`) |
| **Security** | Argon2id, TOTP + replay cache, Ed25519, server-side sessions, idle timeout checked at use, DB-backed lockouts, **RLS forced on 43/43 tables with 43 policies + non-superuser app role** | `generation` column absent; ledger policies not yet generation-agnostic; `current_tenant()` returns NULL where §12 R1 wants a raise; key custody `dev_file`; no per-tenant DEKs; no `denial_ledger` — `services/guard.ts:35` builds a structured `Denial` that nothing persists |
| **Audit** | HMAC-SHA256 chain, append-only triggers, `GET /audit`, `POST /audit/verify` | Checkpoints unsigned and in-database (§4.5 requires Ed25519 anchors from a separate signer process); no `before`/`after` capture; no anchor or verify jobs |
| **Workflow** | Study sign, value assign, value authorise, lot release, certificate issue — all with permission + competence + SoD + step-up + state machine | No create/edit for **anything**; no reissue, withdrawal, recall, CAPA workflow, order, dispatch |
| **Certificates** | `certificates` + `certificate_issues` tables with per-issue unique index, `withdrawn*` and `reissue_reason` columns | **No PDF pipeline at all.** No template model, no blob store, no document signature, no QR, no verify page. The `withdrawn*` columns are read and written by nothing |
| **Platform** | Fastify API, React console (4 views), `/health` | No OpenAPI, no RFC 9457 problem+json, no jobs/worker, no migration runner, no backup tooling, no admin UI, no `/readyz` or `/metrics` |
| **Validation** | 223 tests — the raw material of an OQ pack | No `packages/conformance`, no RTM, no IQ/OQ/PQ, no validation plan. §13 **D12** prices this at ≥120 PD and none of it exists |

**The one number to internalise.** The workbook `Product Build` sheet prices this scope at **P50 = 1,557 PD, P80 = 1,676 PD ≈ ₹2.54 Cr**, against ARCHITECTURE §11's phase table of 27–34 weeks ≈ **170 PD** for a single engineer. That is a ~10× gap the architecture never reconciles. Critique item 8 calls it "the single largest credibility problem in the document." This document resolves it by tiering: the gap is real, but it is not uniform — build compresses, certification and customer execution do not.

---

## 2. THE THREE TIERS

### T1 — INTERNAL PILOT

**What it is for.** One design-partner producer. Producer staff only, no customers on the system. Lotmark runs *alongside* the existing paper QMS; the paper certificate remains the record of record. The purpose is to prove the domain model against real materials and to produce the artefact that wins the deal.

**What it adds over today**

| | Feature |
|---|---|
| Operate | `POST/PATCH /projects`, `POST /studies`, `PUT /studies/:id/results`, `POST /property-values`, `POST/GET /competence`, `GET/POST /users` + `/roles` — the system becomes usable without editing the seed file |
| Trust spine | Migration runner with checksum refusal; RLS applied and asserted on 43/43 tables; `generation` column; non-owner app role; cross-tenant fuzz suite; Ed25519 anchors from a separate signer process (§4.5); pg-boss worker + `ledger.anchor`, `ledger.verify-incremental`, `ledger.verify-full` |
| Metrology | ν_eff via Welch–Satterthwaite always computed and stored; `uncertainty_component` and `property_value_version` tables so a component set is **frozen** and bound to the signature; GUM rounding |
| Certificate | Full document pipeline: `numbering_series` with `FOR UPDATE`, content-addressed blob store, template model with enforced Guide 31 cardinality, Typst → veraPDF gate → PDF/A, Ed25519 document signature, reproducibility triple (`template_version_id` + `data_snapshot_digest` + `renderer_version`) |
| Recall | `POST /lots/:id/recall` — closes ISO 17034 §8.6/§8.7, currently a reachable enum value with no transition |
| Platform hygiene | RFC 9457 `problem+json` with `code` and `auditSeq` at all 19 routes; OpenAPI 3.1 with `x-requirement`/`x-permission`/`x-audit-kind`; `correlation_id` inside the ledger hash payload; `GET /invariants` |
| CAPA | The workflow, before the first automatic emitter writes into it |
| DR | Backup/restore tooling and the `dr:drill` whose acceptance test is: restore a backup missing entries, get `LEDGER_DISCONTINUITY` |
| Documents | The Part 11 clause-by-clause status table; `docs/deviations.md`; RTM generator; `make validation` stub |

**Evidence and certification required**

| Regime | In scope at T1 |
|---|---|
| 21 CFR 11 | §§11.10(d)(e)(f)(g), 11.50, 11.70, 11.100(a), 11.200(a)(1), 11.300(a) — 9 clauses. Plus the written status table declaring 11.200(b) not applicable and 11.10(h)/11.300(e) justified as not applicable while manual entry and software TOTP are the only paths |
| ISO 17034 | §6.2, §6.3, §7.2, §7.5, §7.7, §7.8, §7.9, §8.4 |
| ISO Guide 35 | Budget derivation and degrees of freedom, incl. the floored `msB < msW` branch that §9.3 says no seeded dataset reaches |
| CSV | RTM generator + requirements-as-data + signed IQ record only. **Not** the signed pack |
| Accessibility | Contrast audited to 4.5:1 with a CI check; status never by colour alone. No certification |
| Out entirely | DPDP · CERT-In · GIGW/STQC · TRAI DLT · VAPT · Guide 31 third-party validation · PDF/UA |

**Effort — arithmetic visible**

| Step | PD | Source |
|---|---|---|
| Module base (P50) | 599 | Σ of 31 workbook `Product Build` modules × T1 fraction |
| × 1.2461 (P50 → P80) | **746** | Workbook: 1,676 P80 ÷ 1,345 Expected. The workbook's own `Scenarios & Cost` method |
| less credit for built work | −224 to −283 | 180–307 PD gross at P50 scale, capped at the 56% engineering ceiling from `Team & Rate Card` (R3+R6+R7) |
| plus enumerated rework | +35 to +70 | 15 named P0/P1 fixes from the critique; ~80% lands here because it is all trust-spine and schema |
| plus CSV | +30 to +60 | §13 D12 floor, T1 share |
| **T1 TOTAL** | **528 – 652 PD** | Upper bound corrected: 746 − 224 + 70 + 60 = 652 |

**Elapsed.** 21 PD = 1 person-month (workbook `Read Me`, UNITS).

| | Elapsed |
|---|---|
| 1 engineer | 25 – 33 months — **not viable** |
| 2 engineers | 13 – 17 months — still not viable as stated |
| At the workbook's own ~7 FTE ramp | **3.6 – 4.7 months** |

*This is the honest tension and it should be read, not skipped.* ARCHITECTURE §11/D13 says one engineer does phases 0–7 in 27–34 weeks. The workbook says the same scope is 1,676 PD. Both cannot be right. The reconciliation: the git history (`1fcc6f4` 09:29 → `65da2cb` 11:13, 15 commits, ~11,700 LOC) shows a large real multiplier over *code generation*. It says nothing about a metrologist's review under **D15**, a customer UAT, a VAPT cycle, or PQ against a customer's SOPs. **The tier numbers assume the multiplier applies to build and not to certification, review or execution.** If your engineer is generating code at that rate, T1 is plausibly 8–14 weeks of build plus the review gates. If they are not, it is the workbook number. Name which you are betting on before committing a date.

---

### T2 — FIRST REAL CUSTOMER

**What it is for.** Certificates leaving the building **are** the record. A customer's GMP file contains a Lotmark PDF. Defensible under ISO 17034 and 21 CFR 11 to that customer's quality team and their auditor.

**What it adds over T1**

| | Feature |
|---|---|
| Distribution | Orders with `FOR UPDATE` deterministic allocation, mandatory `If-Match` on transitions, entitlement claim/decide with SoD-2, catalogue listing rule as one SQL view, break-glass PII reveal |
| Dispatch | Shipments, logger binding and readings, excursion detection with MKT + duration + contiguity + low-side limits, delivery blocked without a logger reading, `POST /shipments/:id/excursion-disposition`, **facility excursion disposition** (critique 16 — without it clause 6.5 is permanently red with no way to clear it) |
| Safety loop | Reissue with recomputation + reason + basis + diff; withdrawal; **holder set as `order_line ∪ vault_holding`** (critique 13); acknowledgement keyed `(order_line_id, certificate_id, issue_no)` (critique 14); `notification_outbox` + `delivery_receipt` + `outbox.dispatch`/`outbox.reconcile`; `/verify/:token` SSR no-JS page and the three `/public/v1/*` endpoints |
| Compliance | 13 ISO 17034 clause predicates as as-at SQL views; the three closures as recursive CTEs; equipment/calibration routes with the signing gate; subcontractor register with the forbidden-activity `CHECK`; retention/erasure/consent tables and the erasure decision procedure |
| Jobs | The remaining jobs of §3.11 — `monitoring.due-scan`, `calibration.expiry-horizon`, `competence.expiry-horizon`, `competence.reverification`, `entitlement.revalidation-hold`, `retention.evaluate`, `backup.verify`, `components.staleness-scan` |
| Security | CERT-In clock service with the refusal threshold answered (Q9), 180-day in-India security telemetry as a separate retention class, incident runbook + named contact, VAPT cycle |

**Evidence and certification required**

| Regime | In scope at T2 |
|---|---|
| 21 CFR 11 | The remaining 14 clauses — 11.10(a)(b)(c)(i)(j)(k), 11.30 open/closed determination, 11.100(b)(c), 11.200(a)(2)(3), 11.300(b)(c)(d) |
| ISO 17034 | §6.4, §6.5, §7.4, §7.6, §7.10, §7.11, §8.6, §8.7 recall |
| ISO Guide 31 | Certificate required content with enforced cardinality; reproducibility of an issued certificate |
| GAMP 5 / Annex 11 | **Full signed IQ + OQ + PQ bundle**, validation plan, validation summary, change control with migration-checksum hard refusal |
| DPDP | Consent, purpose limitation, retention enforcement, erasure with lawful refusal, 90-day grievance, field-level redaction |
| CERT-In | NTP sync, 180-day in-India logs, six-hour incident reporting, independent VAPT |
| WCAG | 2.1 AA with `@axe-core/playwright` as a merge gate, manual NVDA/VoiceOver passes, VPAT |
| TRAI DLT | Only if SMS is used. **Choosing email-only is a legitimate deferral but must be a stated decision** |

**Effort**

| Step | PD |
|---|---|
| Module base (P50) | 352 |
| × 1.2461 | **439** |
| less credit | −26 to −65 |
| plus rework | +9 to +17 |
| plus CSV | **+70 to +150** |
| **T2 TOTAL** | **453 – 580 PD** |

Note the shape: T2 carries the **smallest module base** and the **largest CSV load**. That is not an accident — it is where record-of-record certification lands, and certification does not compress.

**Elapsed:** 22–28 person-months. 1 engineer 22–28 months · 2 engineers 11–14 months · at the workbook ramp **3.1 – 3.9 months**. Cumulative with T1: **981 – 1,272 PD**.

---

### T3 — IPC GOVERNMENT DEPLOYMENT

**What it is for.** A second paying tenant provisioned from scratch (the §11 Phase 6 milestone: "IPC is a profile, not a fork"), public-sector Indian deployment, customer-facing surfaces.

**What it adds over T2**

Certificate template designer (workbook C2, 39 PD — `Product Sensitivity` rank 4 calls this "the multi-tenant hinge", ±135 PD) · admin UI for all 14 config kinds + dual-approval signed config publish · EN/HI throughout with a Hindi certificate template · integrations framework (`integration`, `integration_run`) · analytics and MIS — **absent from §3.2, §5.2 and every phase; an architecture gap, not merely unbuilt** (critique 9) · customer storefront, document vault, standalone laboratory vault · public API surfaces per D14 · customer PWA and dispatch handheld with offline signed queued intents (D9) · GST IRN e-invoicing · per-tenant DEKs and in-country residency routing · metrological traceability chain as data (§14 Q10, ~3 tables, extends Closure 1 by one hop).

**Evidence and certification required.** Everything at T2, plus all **88 GIGW 3.0 mandatory guidelines** and the **17 added success criteria** beyond WCAG 2.1 AA; **STQC CQW certification** (document review + frontend and backend testing); **CERT-In empanelled-auditor audit**; DPDP Consent Manager integration (duty live from 13 Nov 2026); 11.10(h) device checks and 11.300(e) device testing, which become live controls once LIMS ingest or hardware tokens exist; per-language DLT template registration.

**Effort**

| Step | PD |
|---|---|
| Module base (P50) | 395 |
| × 1.2461 | **492** |
| less credit | −15 to −35 |
| plus CSV | +20 to +50 |
| **T3 TOTAL** | **477 – 527 PD** |

**Elapsed:** 23–25 person-months. 1 engineer 23–25 months · 2 engineers 11–13 months · at the workbook ramp **3.2 – 3.6 months**. Cumulative: **1,458 – 1,799 PD**.

**Sanity check on the whole model.** 1,458–1,799 against the workbook's 1,676 P80 + 120–260 CSV = 1,796–1,936. The 137–355 PD difference is exactly the credit for built work. The model closes.

**Cost** (`Team & Rate Card` vendor tiers):

| | Boutique ₹10,894/PD | Mid-tier ₹15,130/PD | Tier-1 SI ₹21,182/PD |
|---|---|---|---|
| T1 | ₹0.58–0.75 Cr | ₹0.80–1.05 Cr | ₹1.12–1.47 Cr |
| T2 | ₹0.49–0.63 Cr | ₹0.69–0.88 Cr | ₹0.96–1.23 Cr |
| T3 | ₹0.52–0.57 Cr | ₹0.72–0.80 Cr | ₹1.01–1.12 Cr |
| **All three** | **₹1.59–1.96 Cr** | **₹2.21–2.72 Cr** | **₹3.09–3.81 Cr** |

Plus cash pass-throughs, not person-days (`Scenarios & Cost`): STQC CQW ₹8–18 lakh, CERT-In empanelled audit ₹12–28 lakh, accessibility audit ₹5–14 lakh — all T2/T3.

---

## 3. THE TEN-SECOND TABLE

| | **T1 Internal pilot** | **T2 First real customer** | **T3 IPC government** |
|---|---|---|---|
| **What you can do** | Run one producer's full RM lifecycle end to end on real materials: create a project, enter measurements, compute a budget, authorise a value, release a lot, issue a signed PDF/A certificate, recall a lot, verify the ledger, restore a backup and detect a truncation | Sell and dispatch material; certificates in customers' GMP files; reissue, withdraw and notify every holder; cold-chain evidence; live ISO 17034 conformance view; signed IQ/OQ/PQ bundle; clean VAPT | Provision a second tenant from scratch; bilingual certificates; template designer; public API; customer portal and vault; field apps; STQC-certified surfaces |
| **What you cannot claim** | Not the record of record. No DPDP, no CERT-In, no VAPT, no accessibility certification, no PAdES, no HSM. Signature timestamp is a development timestamp and must be named as one (D8). Traceability is a *statement*, not a chain | Not GIGW-conformant, no STQC CQW, no empanelled audit, no Consent Manager interop, no per-tenant DEKs, no HSM, no Hindi, no mobile, no traceability-as-data, no analytics/MIS | — |
| **Effort** | **528 – 652 PD** | **453 – 580 PD** | **477 – 527 PD** |
| **Elapsed, 1 eng** | 25–33 mo | 22–28 mo | 23–25 mo |
| **Elapsed, 2 eng** | 13–17 mo | 11–14 mo | 11–13 mo |
| **Elapsed, workbook ramp (~7 FTE)** | **3.6 – 4.7 mo** | **3.1 – 3.9 mo** | **3.2 – 3.6 mo** |
| **Cost, mid-tier** | ₹0.80–1.05 Cr | ₹0.69–0.88 Cr | ₹0.72–0.80 Cr |

---

## 4. THE T1 BLOCKER LIST, IN BUILD ORDER

Seventeen blockers. Order is dependency-derived, not priority-derived. Sizes are rough PD at the P80 scale.

### Wave 0 — days, not weeks. Precedes everything.

| # | Blocker | Why it blocks | Depends on | Size | If deferred |
|---|---|---|---|---|---|
| 1 | **Migration runner with checksum refusal** | `package.json:16` is a literal `psql -f 0000 -f 0001 -f 0002 -f 0003` chain. There is no `schema_migrations` table, no checksum, no way to apply 0004 to a database that has already run 0000–0003 except by editing that line. Every blocker below ships DDL | — | 2–4 | This is precisely how RLS shipped unnoticed. And §1.4 makes a checksum mismatch on an applied migration a **hard refusal to start** — a system whose schema state cannot be asserted cannot carry an IQ record |
| 2 | **RFC 9457 collapse** | `problem()` is duplicated **verbatim in six files** (`plugins/session.ts:162`, `routes/values.ts:315`, `routes/lots.ts:418`, `routes/workflow.ts:308`, `routes/console.ts:269`, `routes/auth.ts:215`), each missing §5.3's `status`, `code` and `auditSeq` | — | 2–3 | §11 Phase 1's milestone is a `problem+json` carrying its `auditSeq` — the demonstrable link between a refusal a user saw and the ledger entry proving the control fired. Trivial at 19 error sites; a week of tedium at 80. **Cheapest item on the list and it only gets more expensive** |
| 3 | **`correlation_id` into the ledger hash payload** | The payload is fixed by `lotmark.audit_payload()` in `0002_audit_chain.sql`. Adding it later means old entries verify under the old function and new under the new | 1 | 1–2 | A versioned hash payload in the one table that must verify for ten years. Add the column now even if nothing reads it |
| 4 | **Typst → veraPDF spike** | §12 R4 admits veraPDF may refuse Typst's PDF/UA-1 output. It is a pure function from snapshot JSON to bytes and can be spiked in total isolation, off the critical path | — | 3–5 | Finding out at week 20 forces an unbudgeted Ghostscript path or a public scope reduction. **Spike it week 1 against fixture JSON** |

### Wave 1 — the stop-the-world table sweep, done once

| # | Blocker | Why it blocks | Depends on | Size | If deferred |
|---|---|---|---|---|---|
| 5 | **~~RLS applied~~ (DONE) + `generation` + generation-agnostic ledger policies** | **Largely closed since this was written.** Originally: RLS was on 0 of 43 tables. A policy-less table returns **everything** rather than erroring (§12 R1). Item 2 is really five things: (a) policies on 43 tables, (b) `generation` on ~40, (c) non-owner role with no `BYPASSRLS`, (d) the public-read mechanism `/verify/:token` needs, (e) cross-tenant fuzz asserting 404-never-403 (§4.7) | 1; a decision on the ledger-table policy shape — critique P0-4 requires `audit_ledger`, `audit_head`, `audit_checkpoints`, `signatures` be tenant-scoped and **generation-agnostic** or the chain cannot verify across a §2.5 reset | **6–10** (was 39–44; (a) policies, (c) non-owner role, (d) bootstrap read and (e) the `pg_class` assertion are all done) | **O(tables × routes), and both are about to triple** — 43→~60 tables, 19→70+ routes. Note `app.tenant_id()` as written returns NULL, which fails closed for reads but silently defeats §12 R1's stated raising mechanism |
| 6 | **As-of machinery in the same migration** | The `app.as_of` GUC, the `LM_ASOF_WRITE` read-only trigger on every business table, and §4.6 rule 2 (`as_of ≤ now()`) | 5 | 8–12 | **The least obvious insight in this document:** both 5 and 6 are "attach one thing to all 43 tables." Two sweeps six months apart cost more than twice one sweep, because the second must re-verify the first, and a table missed by either fails silently. Until the trigger exists, one forgotten call path running under `app.as_of` is a backdated signature |
| 7 | **Write the 13 conformance predicates as failing SQL, here** | Zero SQL views exist in any migration. Writing them now forces each clause to name the data it needs *before* that data's schema freezes | 5, 6 | 5–8 | Built last, you discover which clauses cannot be computed from the data you chose to store. §14 **Q10** is exactly such a discovery — the document says "the answer changes the schema" |

### Wave 2 — the trust spine, in this order specifically

| # | Blocker | Why it blocks | Depends on | Size | If deferred |
|---|---|---|---|---|---|
| 8 | **Signer process + Ed25519 anchors outside the DB** | `audit_checkpoints` has `through_seq, head_hash, entry_count, taken_at, exported_at, export_target` and **no signature column**, and lives inside the database it notarises. Restore a doctored backup and you restore the doctored checkpoints with it. §4.5 requires `apps/signer` — separate process, separate OS user, separate credentials — writing to `var/anchors/<tenant>/<ledger>/<date>.jsonl` | 1 | 12–18 | **This is the one dependency inversion in the whole plan.** The DR drill (#11) cannot pass its own acceptance test without it. Without anchors the tamper-evidence claim is circular and unqualifiable to an assessor |
| 9 | **pg-boss runner + `apps/worker` + the three ledger jobs** | §1.5 requires a separate worker process. `apps/worker` does not exist — this is a new deployment unit with a second pool that must set the tenant GUC and authenticate as the wave-1 non-owner role | 1, 5 | 10–14 | **Split it.** The runner is a day; the 18 jobs of §3.11 belong to their owning modules. 12 of the 18 replace something the prototype did at render time — a late runner means each module ships the render-time version and the prototype's defects come back (`components()` on render, `monitoringDue()` in the view) |
| 10 | **CAPA workflow** | Structurally almost free — `capa` already has `root_cause`, `corrective_action`, `preventive_action`, `effectiveness_check`, `state`, `severity`, `owner_user_id` (`compliance.ts:81–106`). It is the **sink for four automatic emitters**: `LEDGER_DISCONTINUITY`, `competence.reverification`, excursion-on-delivery, `capa.overdue-escalation` | 9 for due dates and escalation | 8–12 | Must land **before or with** the first emitter. An auto-raise writing to a table with no workflow behind it is a control that looks green and does nothing — the exact failure class the critique attacks |
| 11 | **Backup, restore, `dr:drill`** | §11 Phase 1's own milestone: restore a backup missing entries, get `LEDGER_DISCONTINUITY`. It is the proof, not a feature | 8, 9, 10, 1 | 12–16 | §10: "a 10-year ledger with 35-day backups is not a 10-year ledger." **The one item whose failure mode is silent until you need it** |

### Wave 3 — making the system operable

| # | Blocker | Why it blocks | Depends on | Size | If deferred |
|---|---|---|---|---|---|
| 12 | **Competence grant and renewal** (`GET/POST /competence`) | Signing is gated on current competence and there is no endpoint to grant or renew one | 5 | 6–10 | **Every authorisation in the seed expires and the system progressively locks itself shut with no recovery path.** Put this first among the CRUD items |
| 13 | **User and role administration** | Nobody can be onboarded when they join or offboarded when they leave | 5 | 10–14 | Both an operational dead end and a §11.10(d) access-control failure |
| 14 | **Project + study create/edit + raw result entry** | No `POST /projects`, no `POST /studies`, no `PUT /studies/:id/results`. Every record originates in the seed file | 5, 12, 13 | 35–50 | The golden-tested statistics engine has nothing to compute on. A pilot that cannot enter a measurement proves nothing. Also closes SM-1: `project.stage` is an unspecified ENUM with no transition rules (critique 23) |
| 15 | **Frozen uncertainty components + ν_eff / k** | `uncertainty_component` and `property_value_version` do not exist, so components are **recomputed, never frozen**, and the signature cannot bind a component set. `expandedUncertainty(uCombined, coverageFactor)` takes k from the caller | 14 | 18–25 | The U printed on a certificate is neither reproducible nor bound to the signature that authorised it. **§14 Q1 (k=2 vs t(0.975,ν_eff)) changes every certificate's U** and contradicts §3.9 (critique 7). Resolution: always compute and store `df_eff`, make the *reporting convention* a tenant setting with a certificate-visible statement |

### Wave 4 — the certificate

| # | Blocker | Why it blocks | Depends on | Size | If deferred |
|---|---|---|---|---|---|
| 16 | **Certificate document pipeline** | `numbering_series` with `FOR UPDATE` → blob store → template model with enforced Guide 31 cardinality → issue snapshot + reproducibility triple → Typst → veraPDF gate → Ed25519 document signature → QR → `/verify/:token` through the wave-1 public path | 4, 5, 15 | 45–60 | A certificate that cannot be rendered, signed as a document and handed to a customer's GMP file **is not a certificate, and the whole product exists to produce them.** Note `certificates.code` is currently `CRT-{count(*)+2041}` (`routes/lots.ts:296–298`) — neither globally unique nor gapless, and §4.8 says a gap in a certificate series is a finding |
| 17 | **Lot recall path** | `lot.state` admits `recalled` with no transition and no use case (critique 15) | 10, 16 | 6–10 | ISO 17034 §8.6/§8.7 recall is "the standard's teeth" and has no execution path. Either build `POST /lots/:id/recall` or delete the enum value — but a live enum value with no transition is worse than either |

### Running alongside — cannot be a wave

| | Item | Size | Why not deferrable |
|---|---|---|---|
| **CSV** | RTM generator, requirements-as-data (`packages/conformance/requirements/REQ-*.yaml`), `make validation` stub, signed IQ record, `docs/deviations.md` | 30–60 | §12 **R9**: "the OQ pack is the CI suite with a different runner, so it cannot be written later." §11 puts it in **Phase 0** |
| **Doc** | Part 11 clause-by-clause status table | 2–4 | Critique 17: "the single most useful page for an assessor and it is cheap." It is the T1 deliverable that wins the deal |
| **Doc** | The three decisions in §8 below | 0 | Schema-affecting. Answering them after wave 1 attaches RLS, `generation` and as-of triggers to 43 tables is the most expensive possible moment |

**Not blockers, despite appearing on candidate lists.** The admin config UI — the domain side is already built (`packages/domain/src/config/*`) and a tenant is provisionable by seed plus a config-version insert; what *is* blocking and gets conflated with it is the dual-approval signed config-change endpoint and the `config_version_id` stamp on business records, both API not UI, and §11 itself puts the settings screen in Phase 6. The KMS/HSM adapter — `signing_keys.custody` already models it honestly and §8.5's control (custody class surfaced everywhere) is what matters; §14 Q4 is customer-gated. Observability exporters and dashboards — §10 makes the OTel exporter a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, by design. The signed assessment pack, as distinct from the conformance predicates — the predicates define what data you must store; the bundle is a job over data you already have.

---

## 5. WHAT IS EXPLICITLY CUT

### Cut at T1

| Cut | Reason |
|---|---|
| The entire signed IQ/OQ/PQ pack | No production material, no GMP filing, no agency will inspect a pilot. The RTM generator and `make validation` stub **still ship** (§11 Phase 0, §12 R9) — the *signed pack* waits |
| 11.10(b) accurate copies for agency inspection | No agency will inspect a pilot |
| 11.10(c) retention enforcement, backups for retention | Pilot data is disposable by definition. Note backup *tooling* is **not** cut — the DR drill is a T1 blocker; what is cut is retention-period compliance |
| 11.10(i) training records, (j)/(k) written policies, 11.100(b) identity proofing, 11.100(c) FDA letter | All procedural, all cheap, none win a deal. Competence-at-signing already demonstrates the hard half |
| 11.300(b) password aging, (c) loss management, (d) urgent reporting, (e) device testing | No real credentials, no real attackers |
| 11.30 open/closed determination | Neither the public verifier nor the customer portal exists — **but see §8, the determination is free now and expensive after Phase 3** |
| All of DPDP | One producer, staff accounts only, no customer personal data |
| All of CERT-In | No production deployment, no logs of consequence, nothing to report an incident about |
| All of GIGW 3.0 and STQC CQW | Not a government tenant |
| TRAI DLT | Send no SMS |
| VAPT, penetration testing, empanelled audit | Localhost |
| Third-party accessibility certification, VPAT | Build accessibly — contrast, non-colour status, keyboard — because retrofitting costs 3×. Certify nothing |
| PDF/UA (as distinct from PDF/A) | PDF/A is a T1 blocker because it is the reproducibility substrate. PDF/UA is the accessibility claim and §12 R4 concedes it may be unreachable via Typst |
| Metrological traceability as data (§14 Q10) | A traceability *statement* suffices — **but decide and record that now** (critique 34), so the retrofit is bounded |
| Orders, dispatch, storefront, vault | No customers on the system at T1, by definition |

### Cut at T2

| Cut | Reason |
|---|---|
| All 88 GIGW guidelines + the 17 added success criteria | GIGW binds Indian **government** websites and apps. A private producer is out of its scope. The prototype models this correctly: GIGW sits inside the IPC tenant profile with the portal/CMS and STQC listed as **`outside`** product scope (`lotmark-app.html:179–180`) |
| STQC CQW certification | Same. It certifies a *website*, not a production platform |
| CERT-In empanelled-auditor audit | A procurement artefact. A commercial customer's own security team review substitutes. **6-hour reporting, 180-day in-India logs and VAPT do not get cut** — those bind any Indian body corporate |
| DPDP Consent Manager integration | The 13 Nov 2026 registration duty falls on Consent Managers. A B2B producer needs consent, purpose limitation, retention and grievance — not interop |
| Per-tenant DEKs / column encryption (SEC-19) | RLS + disk encryption + the redaction serialiser is defensible. **Say so in the status table** rather than leaving SEC-19 as a label (critique 28) |
| HSM key custody | §14 Q4 is due Phase 6. Vault Transit or `DEV_SIGNER_PROCESS` is acceptable **provided `custody_class` is printed on the validation-pack cover page** — which is exactly what §8.5 exists to guarantee |
| PAdES-B-LT and RFC 3161 timestamping | D8 is explicit: a self-signed development key cannot satisfy the profile, and claiming it "is exactly the overclaim being removed." Ship "PDF/A with an embedded Ed25519 detached signature and a development timestamp" and **name it that**. §14 Q5 notes an air-gapped deployment may have no reachable TSA at all |
| 11.10(h) device checks, 11.300(e) device testing | Justified not applicable while manual entry and software TOTP are the only paths — **document the justification** |
| Hindi, bilingual anything, per-language DLT templates | Only IPC-class tenants need it |
| Mobile app, dispatch handheld, offline field capture | §11: "If time runs out, Phase 7 is dropped whole — the compliance spine is never partially built" |
| Analytics/MIS, reporting engine, invoicing, GST IRN | Critique 9 and 10 — real gaps, commercial rather than regulatory. **State the deferral with a reason** rather than inheriting the architecture's silence. Note analytics is absent from §3.2, §5.2 *and every phase* — it needs a Phase 6 module or an explicit reasoned deferral, not omission |
| Certificate template *designer* (as distinct from the template *model*) | The model with enforced cardinality is a T1 blocker — Guide 31 conformance depends on it. The multi-tenant designer is workbook C2, 39 PD, and `Product Sensitivity` rank 4 at ±135 PD |

### Cut at T3

Nothing is cut at T3. T3 is defined as the completion of the workbook's module list. What T3 does not include is anything outside `Product Build` — the IPC estate migration, OpenCart reconciliation and NIC/MeitY onboarding are separate programme lines (`Risk Register (reclassified)` K1, K4) and are not product scope.

---

## 6. THE COST OF DEFERRAL

Five items are cheap now and expensive later. Ranked by the ratio.

| Item | Cost now | Cost later | Why the ratio is what it is |
|---|---|---|---|
| **1. RLS + `generation`** | 39–44 PD | 39–44 PD **× ~2.5**, plus unbounded audit risk | The cost is **O(tables × routes)** and both are about to triple: 43→~60 tables, 19→70+ routes. The API currently hand-writes `WHERE tenant_id = ${ctx.tenantId}` at ~120 query sites across 19 routes, so RLS today is defence-in-depth. That is the argument *for* doing it now, not against: a policy-less table returns **everything** rather than erroring, so the failure is silent, and multi-tenancy rests on every future query remembering its `WHERE` clause. **Since superseded in part:** the policies, the non-superuser role, the bootstrap read and the catalog-driven assertion are done, leaving 6–10 PD of `generation` and ledger-policy shape. The argument for doing it early held, and the discovery that a **superuser bypasses RLS unconditionally** — so the policies would have been inert in development and first exercised in production — is exactly the class of finding that gets more expensive the later it lands |
| **2. CSV / validation** | 30–60 PD at T1 | 120–260 PD, and it lands at T2 where you can least afford it | §13 **D12** floors it at ≥120 PD from Phase 0. §12 **R9** calls retrofitting "the classic multiplier." The mechanism: §9.5 makes requirements *data* — `REQ-*.yaml` cross-referenced from three machine-readable places (`@requirement()` test tags, `x-requirement` on OpenAPI operations, REQ ids in migration headers) with **build failure on any uncovered requirement**. That is a property of how tests and migrations are *written*, not a document you author afterwards. `Team & Rate Card` R4 names a **191-obligation matrix**; at 0.6 PD each that is ~115 PD before IQ/OQ/PQ authoring. **The tiering is itself the fix:** 30–60 PD against T1's 528–652 is 6–11%, which is plannable. D12's 120 PD against D13's 170 PD total is 70%, which is not |
| **3. As-of read-only trigger** | Bundled free into the wave-1 sweep | A second 43-table sweep | Deferred almost always, because as-at querying reads like a reporting feature. It is not — it is a **write-blocking trigger on every business table**, and until it exists one forgotten internal call path running under `app.as_of` is a backdated signature. Identical shape and cost curve to RLS, which is why they belong in one migration |
| **4. `correlation_id` in the ledger hash payload** | 1–2 PD | A versioned hash payload, permanently | Change what `lotmark.audit_payload()` commits to *after* entries exist and old entries verify under the old function, new under the new — in the one table that must verify for ten years. Add the column now even if nothing reads it |
| **5. The per-issue acknowledgement key** | 3 columns | A data migration over already-dispatched safety notices | Critique 14: the key must be `(order_line_id, certificate_id, issue_no)`. Retrofit it later and there is **no way to reconstruct which issue was actually acknowledged**. The prototype's real bug was exactly this |

**And one deferred for good reason.** The KMS/HSM adapter. `signing_keys.custody` is already `enum('dev_file','env','kms','hsm')` and reported per key (`packages/db/src/schema/keys.ts`); §8.5 makes custody a first-class reported field precisely so "we have an HSM interface" is never read as "we have an HSM." §13 D7 explicitly rejects requiring an HSM in dev. Building against an HSM you may not procure is the wrong bet.

---

## 7. RISKS

### Bearing on T1

| Risk | Source | Mitigation |
|---|---|---|
| **RLS bypassed or forgotten** | §12 R1 | **Downgraded.** RLS is now applied and forced on 43/43 tables and the API connects as a non-superuser, so the primary exposure is closed. What survives: `current_tenant()` **returns NULL** where §12 R1 specifies a *raising* function. Fails closed for reads, silently defeats the stated mechanism. Mitigation is inside wave 1's 39–44 PD; the control is the `pg_class` assertion driven off Postgres catalogs, **not** off Drizzle — `state_transitions` and `audit_head` exist only in `0003_signing.sql:70` and not in the Drizzle schema, so a Drizzle-driven test under-counts by two tables |
| **Our own metrology engine puts numbers on certificates** | §12 R3 | The largest technical risk in T1 because T1's entire purpose is producing numbers. Gate on **D15** — named external metrologist signs off `packages/stats` before Phase 2 closes — and resolve §14 Q1 per critique 7: always compute and store `df_eff`, make the reporting convention a tenant setting with a certificate-visible statement |
| **"Match the prototype" preserves its defects** | §12 R6 | `(a−1)(n−1)` df, fail-open SoD, `lot.prev` as string, render-time budgets. The control is `docs/deviations.md`, a Phase 0 deliverable that does not exist |
| **veraPDF refuses Typst's output** | §12 R4 | Spike week 1 against fixture JSON, off the critical path. The fallback is an unbudgeted Ghostscript path or a scoped accessibility claim — R4 is honest that if PDF/UA proves unreachable "the release notes say so" rather than the claim being quietly dropped |
| **Demo scaffolding leaks into a real tenant** | §12 R13 | `TODAY`, `resetDemo()`, `tamper*()`. A `validation` tenant must **never** see a `clock_source='simulated'` entry. Generation retirement (D10) is the mechanism |
| **No LIMS or QC source at the first customer** | Workbook K2, p 0.7, 35 PD marginal; §14 Q2 | X4's own note says "manual entry path ships first," so T1 is the tier that must ship a manual QC console. Blocker #14 is that console. Answer Q2 before committing T2 integration scope |
| **Bitemporal half-done is worse than none** | §12 R8 | Wave 1 lands the as-of machinery whole or not at all |

### Bearing on T2 — the highest-risk tier

| Risk | Source | Mitigation |
|---|---|---|
| **Validation debt if CSV starts late** | §12 R9 | The classic multiplier, and T2 is where it lands. This is why the CSV line is 70–150 PD here and why the T1 stub is non-negotiable |
| **DPDP full compliance due 13 May 2027** | Workbook K8, p 0.5, 40 PD — **hard statutory date, outside the product simulation** | Today is 21 Aug 2026: ~9 months. A T2 go-live 10–12 months from a standing start lands **on or after** the date. **DPDP must be designed in from T1, not remediated at T2.** Note the workbook `Read Me` correction that changes the architecture: "v1 argued Google Analytics conflicts with DPDP on localisation grounds. That was wrong: the final Rules use a blacklist model for cross-border transfer, not data localisation." **Do not build data localisation for DPDP — build it for CERT-In** |
| **DPDP erasure vs Part 11 / ISO 17034 retention deadlock** | §12 R10 | Erasure over contact data an order line needs to make the holder list computable. Wrong either way is a breach or a destroyed trail. The design is a **decision procedure** per linked class — erase / pseudonymise / refuse-with-reason — and the refusal artefact citing the retention row is a deliverable of the screen, not a failure |
| **Notification delivery fails silently** | §12 R14 | A withdrawal is a safety notice. `outbox.reconcile` must assert against `order_line ∪ vault_holding` (critique 13), not orders alone — a lab that acquired a vial by scan gets no notice otherwise |
| **Ledger append is a per-tenant serialisation point** | §12 R2 | A Phase 1 gate under k6 at 5M entries, but it *bites* at production volume. §14 **Q3** volumetrics (a 4k–18k orders/yr band) are answerable from the customer's own order table in minutes. Close it before T2 sizing |
| **Reproducibility drifts** on a Typst/font/Ghostscript bump | §12 R5 | Underwrites the whole reissue argument. Pin and hash the toolchain in the IQ record |
| **STQC/CERT-In third remediation cycle** | Workbook K5, p 0.45, 40 PD | Budget one remediation cycle; the third is the tail |
| **Cold-chain workflow unscoped** | Workbook K11, p 0.45, 22 PD | Lands squarely on the T2 dispatch module. Scope excursion detection (MKT, duration, contiguity, low-side) explicitly |

### Bearing on T3

| Risk | Source | Mitigation |
|---|---|---|
| **Field apps are offline** — "the one gap that could force a rewrite" | §12 R11 | **D9 decides it now** — signed queued intents replayed through the guard chain — precisely so T3 is not a rewrite. If D9 is not honoured in T1's schema, T3's 64 PD of F1+F2 becomes unbounded |
| **Tenancy depth** | `Product Sensitivity` **rank 3, ±175 PD — the largest single product cost swing** | D1 recommends shared-schema + RLS. If a sovereign customer forces schema- or database-per-tenant, add up to 175 PD to T3 |
| **Certificate templating: one format vs a designer** | `Product Sensitivity` rank 4, ±135 PD | That is C2, entirely inside T3, and it is "the multi-tenant hinge" |
| **Scope: 55 tables, 22 modules, ~40 screens** | §12 R15 — "the genuine risk. Phase 7 slips and validation gets cut" | **The tiering is itself the mitigation:** T3 is droppable whole without invalidating T2's certificates |
| **NIC/MeitY onboarding** | Workbook K4, p 0.6, 55 PD | Deployment risk, outside the product build, but it gates a government go-live and has procurement lead time. Related: §14 Q4 (HSM at go-live) and Q5 (an air-gapped NIC deployment may have **no reachable RFC 3161 TSA at all**, in which case anchors carry a development timestamp permanently and D8's claim must be scoped) |
| **PCI scope escalates to full DSS** | Workbook K9, p 0.15, exposure **₹280 lakh** | Cost-only, carried on the cost side not in person-days. Triggered by taking payment inside the storefront |

### Bearing on all three

**Attrition and re-ramp** — workbook K14, p 0.8, 150 PD over 16 months, the register's largest transferring EMV at 120 PD. It **scales with duration**, which is the strongest single argument for tiering: three 3–5 month tiers carry materially less re-ramp than one 12-month run.

**And the honest closing statement on every number in this document.** `Product Sensitivity` rank 1 is overall estimate accuracy — every module ±30%, P80 swinging **1,251–2,101 PD**. That is an 850 PD swing, and it dominates every tier boundary, module allocation and credit judgement made here. Each tier figure is also a *share of the whole-programme P80*, not a standalone P80; a smaller portfolio pools less variance, so **if any tier is committed as standalone fixed price, add 3–6%.**

---

## 8. RECOMMENDATION

**Aim at T1. Commit to T1 only. Price T2 openly and do not commit a date to it until three questions are answered.**

The reasoning is not caution. T1 is where the deal is won and it is the only tier whose scope is fully knowable today. Every one of the 17 blockers is a known quantity with a named file and a named section; none depends on a customer decision, a procurement cycle, or an institution's calendar. T2 by contrast contains three things that do not compress no matter who is building: a CERT-In VAPT cycle, a customer UAT, and PQ executed against a customer's own materials and SOPs. Committing a T2 date before there is a customer means committing a date whose critical path you do not control.

The second reason is that T1 as scoped here is **not a throwaway pilot**. The wave-1 sweep, the anchors, the CAPA sink and the frozen uncertainty components are all trust-spine work that T2 and T3 build directly on top of, and all of it is exactly the work that is 2.5× more expensive if deferred. §11 says "Phase 1 is the phase not to shorten" and "the compliance spine is never partially built." Cutting T1 to a demo saves 100 PD and costs 250.

**The decision hinges on three things, in this order.**

**First — which productivity basis you are betting on.** ARCHITECTURE §13 D13 says 27–34 weeks for one engineer across all eight phases. The workbook says 1,676 PD. The implied multiplier over a mid-tier SI's blended eleven-role team is **8.2× at 170 PD, 6.3× at 220 PD**. The 1h44m git history says a large multiplier over code generation is real; it says nothing about D15's metrologist review, a UAT, a VAPT cycle or PQ execution. **Resolve D12 vs D13 in writing before quoting any date** — critique 8 calls this contradiction the single largest credibility problem in the document, and it is unresolved as of this pass.

**Second — three schema-affecting decisions that must land before the wave-1 sweep freezes anything.** Answering them after RLS, `generation` and as-of triggers are attached to 43 tables is the most expensive possible moment.

| Decision | Why now | The defensible answer |
|---|---|---|
| **§14 Q10** — metrological traceability as data | The document says "**the answer changes the schema**" — ~3 tables, extends Closure 1 by one hop. Due Phase 2. Critique 34 notes there is no stated fallback | **T1/T2 default: traceability statement only. Chain deferred to T3, priced at ~3 tables + one closure hop.** State it; do not leave it open |
| **§14 Q11** — open or closed system under §11.30 | Neither the public verifier nor the customer portal exists, so the determination is **free today and expensive after Phase 3**. If "open," §11.30 adds document encryption and digital signature standards on top of everything in §11.10 | Decide before wave 3 builds `/verify/:token` |
| **§14 Q7** — is the retention subject the snapshot, the PDF, or both | It binds retention classes and blob lifecycle **before blocker #16 writes its first blob** | Decide in wave 0 |

**Third — is there a customer, and are their records FDA-regulated.** T2's entire justification is that a certificate enters someone's GMP file. Without a named design partner, T2 is speculative scope. And 11.100(c) — the producer's written certification to FDA — only bites if the customer's records are FDA-regulated; if they are not, roughly a third of T2's Part 11 load becomes a documented not-applicable rather than a build.

**What to put in front of the client.** T1 at **528–652 PD**, ₹0.80–0.99 Cr mid-tier, 3.6–4.4 months at the workbook's own ramp — with the explicit note that a single engineer at the demonstrated code-generation rate may land materially inside that, and that the number does not compress the review gates. Then T2 at **453–580 PD** as a *priced option, not a commitment*, contingent on a named design partner and the three decisions above. Then T3 at **477–527 PD** as a clearly separable programme that can be dropped whole without invalidating a single certificate T2 issued.

That last property — that each tier is droppable from the top without invalidating the tier below — is the actual design of this plan, and it is what §12 R15 asks for.