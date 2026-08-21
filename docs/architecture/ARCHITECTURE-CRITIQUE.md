# COMPLETENESS REVIEW — Lotmark Technical Architecture Decision Document v1.0

Verdict: the trust spine (§3.5–§3.8, §4.4–§4.5), the temporal model (§4.6), the metrology defect list (§3.9) and the invariant mapping (§9.2) are genuinely complete and in several places better than the source analysis asked for. Do not re-open them. Everything below is what is missing, wrong, or asserted without a mechanism.

---

## P0 — CONCRETE ERRORS THAT WILL NOT WORK AS WRITTEN

**1. §4.2 — `audit_entry` cannot have `PRIMARY KEY (tenant_id, seq)` while `PARTITION BY RANGE (occurred_at)`.**
Postgres requires the partition key to be a subset of every unique/primary key on a partitioned table. As specified the DDL is rejected. Either make it `PK (tenant_id, seq, occurred_at)` (weakens nothing, `seq` is still unique per tenant by trigger + the `audit_head` lock) or drop partitioning and rely on BRIN on `occurred_at`. Same applies to `denial_ledger`. Decide and state it — this is the table the whole §4.5 argument rests on.

**2. §4.4 — the advisory lock key omits the ledger discriminator, and this deadlocks the denial path in §3.4.**
`pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0))` is the same key for `audit` and `denial`. §3.4 writes the denial on a second connection *while the business transaction is still open and holding that lock*. The denial write blocks until the business transaction rolls back — but §3.4 says the denial transaction is "opened before the business transaction rolls back, with the intent pre-written and confirmed", which is exactly the ordering that hangs. Fix: include `TG_ARGV[0]` in the lock key, and state explicitly that the denial writer is a **separate pooled connection** (Postgres has no autonomous transactions; the document uses the term without naming a mechanism, which is the only genuinely hand-waved primitive in §3).

**3. §4.4 — `audit_head` is never seeded, so the first entry per tenant/ledger never advances.**
`SELECT ... INTO h, s FROM audit_head WHERE ... FOR UPDATE` returns no row on a fresh tenant; `UPDATE audit_head SET ...` then updates zero rows. Every subsequent entry gets `seq = 1` and `prev_hash = \x00`. Either `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the trigger, or create the two head rows in the tenant-provisioning transaction and add a test that provisioning without them fails.

**4. §2.5 + §4.7 — generation-scoped RLS on the ledger contradicts §4.5's "chain verification passes across the boundary."**
§4.7's policy template is `USING (tenant_id = app.tenant_id() AND generation = app.generation())` and §2.5 says "**every** RLS policy includes `generation = app.generation()`". Under that rule the verifier cannot see the retired generation's entries, so the chain cannot be verified across a reset and the anchors covering retired entries will report `LEDGER_DISCONTINUITY` on every demo reset — the exact failure §4.5 says proves compromise. `audit_entry`, `denial_ledger`, `audit_anchor`, `audit_head` and `signature` must be tenant-scoped and **generation-agnostic**. Say so, and add it to the migration test in §9.2 ("every table has RLS enabled, forced, with a policy") so the two policy shapes are both enumerated.

**5. §5.2 — `GET /public/v1/certificates/{number}` is unresolvable, and no public read path through RLS is described.**
`certificate.certificate_number` is `UNIQUE(tenant)`, not globally unique, so the route is ambiguous across tenants. And every public endpoint runs without a session, while §4.7 states `app.tenant_id()` **raises** when unset — so the public API cannot read anything. Needed: either a globally unique public identifier (opaque token, as `/verify/:token` already has) or a `{tenant}/{number}` path; plus a named mechanism for public reads (a `SECURITY DEFINER` resolver function, or a dedicated `lotmark_public` role with its own policies restricted to non-PII columns). This is a Phase 3 blocker and currently unaddressed.

**6. §2.1 + §7 — the dev-mode cookie story does not work.**
The API serves `https://lotmark.localhost:4000` and sets `__Host-lm_sid; Secure; SameSite=Strict`. The console dev server is `http://localhost:5173`. Different scheme and different host ⇒ cross-site; `SameSite=Strict` will not send the cookie and `Secure` will not travel over http. As written you cannot log in during development. Fix (and state it): run Vite behind a same-origin proxy (`/api` → 4000 over the same mkcert https origin), or serve the dev bundles from the API. Also `make doctor` should check that `lotmark.localhost` resolves — macOS's system resolver does not resolve `*.localhost` by default even though browsers do, and `mkcert` does not add a hosts entry.

**7. §14 Q1 contradicts §3.9.**
§3.9 lists "k=2 hardcoded, no df" as a *blocking defect* with the fix stated as committed: Welch–Satterthwaite `df_eff` and t-based `k`. §14 Q1 then asks whether the market expects Welch–Satterthwaite or `k=2` with ν_eff reported — an open question due Phase 2. Both cannot stand. Resolve by making the fix "always compute and store `df_eff`; the **reporting convention** (`k=2` vs `t(0.975, ν_eff)`) is a tenant setting with a certificate-visible statement", which satisfies both and removes the contradiction.

---

## P1 — MATERIAL OMISSIONS FROM THE SOURCE ANALYSIS

**8. Effort reconciliation is absent, and D12 contradicts D13.**
The workbook prices this exact scope (42 modules, 37 screens, 22 entities, 9 integration surfaces) at **P80 = 1,676 PD ≈ INR 2.54 Cr**. §11/§13 D13 offer 27–34 weeks for one engineer ≈ **170 PD** — a ~10× gap that is never named. Worse, D12 recommends an explicit **≥120 PD CSV line item**, which is 70% of the entire single-engineer budget. Either state plainly that the localhost build is a scoped subset of the workbook product (and say which modules are out), or restate the timeline. As written this is the single largest credibility problem in the document.

**9. Analytics / MIS (workbook X5, 31 PD; gap G19) is missing entirely.**
Not in the §3.2 module map, not in §5.2, not in any phase. `search_event` is captured in the schema and §6.3 cites "materials searched but unavailable" as the product's own commercial signal — and then nothing consumes it. Also missing: the reporting engine (role-scoped report definitions, scheduled reports, PDF/XLSX delivery — workbook D12, 36 PD). Either add a Phase 6 analytics module or add an explicit deferral with a reason.

**10. Payment, invoicing and order documents (gap G23) are absent with no deferral statement.**
No `invoice`, no proforma, no packing list, no payment state, no GST **IRN e-invoicing** (workbook E5, "mandatory above threshold, unmentioned in the source docs"), no refunds/cancellations. §5.2 exposes `GET /orders/{id}/documents` with no table behind it, and `order.state` has `cancelled` with no cancellation use case. The prototype's own gap register calls this out; the architecture inherits it silently.

**11. SoD-5 and the refund-threshold rule from the wireframe are missing.**
The wireframe defines **five** SoD rules; the document only ever discusses SoD-1…SoD-4. SoD-5 ("study signer must hold current competence") is arguably subsumed by the competence gate — say so explicitly — but the refund second-approver rule has no home, and §3.5's grammar (`n_eyes`, thresholds) exists precisely to express it. Also: **the document never states whether SoD-3 and SoD-4 ship enabled.** They shipped disabled in the prototype specifically because they were unenforceable; now that `lot.created_by` exists and subjects are mandatory, the default must be declared.

**12. `capa_state_history` and five other `[H]` children are promised and not defined.**
§3.2 says the CAPA module owns `capa_state_history`; §4.2 does not define it. `study`, `property_value`, `lot`, `entitlement`, `shipment` and `capa` all carry the `[H]` marker ("has a state-history child") but only `project_stage_history` and `order_state_history` exist in the schema. Either define the six missing tables or define one polymorphic `state_transition` table (`subject_type`, `subject_id`, `from_state`, `to_state`, `at`, `by`, `version`, `audit_seq`, `signature_id`) and drop the per-aggregate ones.

**13. Certificate holders acquired outside an order are invisible to withdrawal notification.**
`vault_holding.source` is `ENUM(order, qr_scan, upload, import)` — so the schema knows holdings exist without orders — but Closure 2 (§4.6, §5.2 `/holders`) is `order_line`-derived and `outbox.reconcile` (§3.11) only asserts "a dispatched notice per holder org" derived from orders. A lab that acquired a vial by QR scan, sample, free replacement or PT distribution gets no withdrawal notice. Since withdrawal notification is the document's stated safety obligation, the holder set must be `order_line ∪ vault_holding` (with the vault half caveated as self-declared), and `outbox.reconcile` must assert against the union.

**14. Reissue acknowledgement is not demonstrably per-issue.**
§8.5 correctly separates `notified_at` from `acknowledged_at`, but the key is `delivery_receipt(outbox_id)` → `notification(subject_type, subject_id)`. The prototype's actual bug was that `reissueAck` was keyed `(order, certificate)` rather than `(order_line, certificate_issue)`, so acknowledging issue 2 marked issue 3 acknowledged. State the key explicitly as `(order_line_id, certificate_id, issue_no)` and add it to the §9.2 new-invariant list.

**15. `recalled` lot state and the recall workflow have no path.**
`lot.state` includes `recalled` and `capa.recall_required` exists, but there is no recall use case in §5.2, no transition, no phase. ISO 17034 §8.6/§8.7 recall is the standard's teeth and the source gap register (G16) names it. Either add `POST /lots/{id}/recall` (signed, reason-mandatory, cascading to holders) or remove the enum value.

**16. Facility excursion disposition has no endpoint.**
§5.2 has `POST /shipments/{id}/excursion-disposition` only. ISO 17034 clause 6.5 (§5.2 `/conformance/clauses`) fails while any facility excursion sits at `under assessment`, and `excursion.subject_type` covers `facility` — so the clause is permanently red with no way to clear it. Add the facility disposition route.

**17. Regulatory obligations named in the analysis and absent from the document:**
- **CERT-In six-hour incident reporting with a named point of contact** (SEC-21) — no mention anywhere. Needs at minimum an incident runbook deliverable and a `security_control` row status.
- **CERT-In empanelled audit / two VAPT cycles** (SEC-20; workbook Q4/E12, ~31 PD each) — §9.1 lists ZAP baseline + semgrep + osv-scanner, which is not a penetration test. Say which is claimed.
- **GIGW 3.0 (88 mandatory guidelines) and STQC CQW certification** — mentioned only as a heading in §6.6 and a requirement source in §9.5. The cybersecurity chapter was written by CERT-In and **explicitly covers mobile apps**, which lands squarely on Phase 7. No conformance evidence workstream exists.
- **21 CFR 11 §11.10(h) device checks, §11.100(b) identity proofing, §11.300 password aging / loss management / periodic token testing** — unaddressed. The analysis contains a full clause-by-clause Part 11 status table; the document has no equivalent, so nobody can see what is and is not claimed. Add one — it is the single most useful page for an assessor and it is cheap.
- **DPDP Consent Manager registration and integration** (from 13 Nov 2026) — `consent` exists; the Consent Manager interoperability obligation does not.
- **TRAI DLT registration** for transactional SMS — `notification_outbox.channel` implies SMS with no DLT path.

**18. SKU, publications and subscriptions are unmodelled.**
The catalogue is lot-keyed throughout. The verified estate is **1,341 priced SKUs** plus publications, subscriptions, phytochemical standards and a calibrator tablet, and `tenant.publications` is a flag in §4.2 that nothing keys off — the same "display-only feature flag" defect the document criticises in the prototype (§12 R13's spirit). Either add a `sku` table above `lot` or state that v1 sells lots only and the tenant flag is deferred.

**19. §11.10(e) prior-value capture is designed but `before`/`after` capture is never specified.**
§3.8 says the changed columns are captured as `jsonb` "with PII stored as a hash plus a reference". Who computes the diff — the repository, a trigger, or the use case? A trigger-based capture is the only one that cannot be forgotten, and the document elsewhere insists on exactly that reasoning (R1). State the mechanism.

---

## P2 — UNDER-SPECIFIED, INTERNALLY INCONSISTENT, OR NEEDS A REASON

**20. §4.7 contradicts itself on cross-tenant queries.** Database-per-region is rejected partly because it "breaks every cross-tenant platform query"; four paragraphs later, moving a tenant to its own database is cheap "because no query spans tenants". Pick one. (The resolution is presumably: the *product* has no cross-tenant queries, the *operator console* does — say that.)

**21. §2.3 — the seed cannot execute the acts as described without two unstated mechanisms.** Signing thirteen historic studies through the real services requires (a) minting valid TOTP codes and step-up tokens, and (b) acts dated 2024–2026, which §3.10 says can only happen via a separately-permissioned, separately-signed backdating act that "can never precede the last anchored segment". The clean answer is that the seed advances `SimulatedClock` chronologically with anchoring following it — but the document never says so, and §3.10 + §4.5 as written forbid the naive approach. One paragraph fixes this; without it the best idea in §2 is unimplementable.

**22. The final permission catalogue is never enumerated, and the boot assertions depend on it.** §2.3 says the `minimal` pack seeds "28 permissions", but the design adds `tenant:configure` (§2.2/§5.2), `tenant:reset` (§2.5), per-module read permissions (§6.4: "each module gets its own read permission" — that is roughly ten new keys), and an unnamed permission for `POST /pii/reveals`. §3.5's boot check "every defined permission is enforced by at least one use case" cannot be evaluated against an unpublished list. Publish the final list as an appendix.

**23. SM-1 (Project.stage) is unaddressed.** The prototype's `authorisation` stage is unreachable and `authoriseValue()` jumps any stage straight to `released`. `project.stage ENUM` in §4.2 is left unspecified and the defect appears in neither §3.9 nor §9.2. State the stage set (the wireframe's is Planning → Homogeneity → Stability → Characterisation → Authorisation → Released) and the transition rules.

**24. §7 reintroduces a criticised behaviour without a reason.** "3 min for signing-capable surfaces" recreates the prototype's 180 s idle kill, which the source analysis called "hostile in a lab where a scientist reads a long table". Server-side activity tracking on real API calls mitigates it, but a scientist reading a results table makes no API calls either. Give the reason or raise the floor.

**25. `order` is a reserved word.** `CREATE TABLE "order"` needs quoting everywhere forever. Rename to `sales_order` now — this is a five-minute decision that is permanent afterwards.

**26. `vault_holding` has no uniqueness constraint** and the prototype's specific defect (repeat order of the same lot does not increment quantity) is never listed as fixed. Add `UNIQUE (org_id, lot_id, location, lower(validity))` or equivalent, and add the fix to `docs/deviations.md`.

**27. Bulk-imported lots and supersession.** `runImport` wrote `prev: '—'`, breaking lineage. `previous_lot_id` is now a real FK, but §5.2's `/lots/import` says nothing about establishing lineage. IPC needs ≥5 generations and the `scale` pack tests it; the importer must be able to build the chain.

**28. Per-tenant DEK design is one phrase.** §4.7 promises "per-tenant DEKs for PII columns" and §4.2 has `phone_enc bytea`. Which columns? How does key rotation re-wrap? How does anything search or sort an encrypted contact field? `person.email` and `person.full_name` are unmarked as PII in §4.2 despite the `@pii:` registry being the mechanism for redaction in three places. This is SEC-19 and it is currently a label.

**29. jsonb in the chain payload.** `lp(NEW.before)` hashes jsonb's text rendering. jsonb normalises key order deterministically *within* a major version; that is not a documented cross-version guarantee. For a ten-year verifiable chain, canonicalise to a `bytea` (RFC 8785 JCS, as §3.7 already does for signature material) before hashing rather than relying on the type's output format.

**30. `make verify` vs `make verify --anchors`.** §2.2 lists the former as covering "every runtime invariant + full chain + anchor verification"; §4.5 introduces a flag. Trivial, but §2.2 is the contract a reader will run.

**31. Phase 2's milestone "alter a raw result → the study signature breaks" is not reachable through the app** — `study_result` is `[A]` after signing (§4.3), so the demo is a psql-level tamper. Say so, as Phase 1's tamper demo does.

**32. Notification template management and preference centre** (workbook D9, C8) — `/console/outbox` exists; templating, scheduling and delivery reports do not. Minor, but the bilingual certificate story in §6.5 implies bilingual notification templates that must be **pre-registered per language** for DLT.

**33. Session concurrency cap and audited reads of PII-bearing ledger entries** — both named in the analysis, both absent. `/me/sessions` exists without a cap; blob reads are audited but ledger reads containing PII references are not.

**34. Q10 has no fallback.** Metrological traceability-as-data is flagged as schema-affecting and due in Phase 2. If the answer is late, what ships? State the default (traceability *statement* only) and the cost of adding the chain later, so the risk is bounded rather than open.

---

## WHAT IS GENUINELY COMPLETE — DO NOT ADD WORK HERE

- **§3.5 guard chain and its four boot assertions.** The fail-open `sodViolation`, the dead `lot:create` permission, and SoD-4's missing `by` column are all closed structurally, and covering *disabled* rules in assertion 1 is the correct subtlety.
- **§3.7 signing service.** Subject-and-version binding, single-use consumption inside the business transaction, and the 60-minute cap as a code constant close every §11.200 defect in the source. Extending the ceremony to withdrawal is right.
- **§3.7 signed material.** Including digests of the raw result set and the frozen component set, length-prefixed rather than `|`-joined, fixes the most consequential defect in the prototype.
- **§3.9 metrology defect list.** Every blocking and statistical item from the science-engine analysis is present with a named fix, including the `(a−1)(n−1)` df error and the `msB < msW` fixture that no seeded dataset reached. NIST StRD as golden data is a better answer than the analysis proposed.
- **§4.6 temporal rules.** Read-only-under-`asOf` as a trigger rather than a convention, `asOf ≤ now()`, the guard never reading `asOf`, and `AsOf` as a type-level repository requirement — four rules, all enforced, all correct.
- **§4.6 closure corrections.** Cover against `measured_at` not signature date; holder window keyed at `allocated_at` not `order.placed`; `process_step` joined into Closure 1. These are the three real bugs and all three are fixed.
- **§9.2 invariant mapping.** All sixteen mapped, with the vacuous-pass bugs (11/12) eliminated by `NOT NULL` rather than by better filtering, plus fourteen new invariants the prototype could not express.
- **§9.5 RTM from three machine-readable sources with build failure on uncovered requirements.** The correct descendant of `build.py sync`.
- **§2.5 generation retirement** and **§4.5 `LEDGER_DISCONTINUITY` as a first-class, CAPA-raising outcome.** Both are better than anything in the source material.
- **§9.4 `docs/deviations.md`.** The right control for the transcription strategy's central risk.