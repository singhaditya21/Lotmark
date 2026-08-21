## REVIEW: LOTMARK MVP 1 DEFINITION

Verified against the working tree at `/Users/adityasingh/PersonalWork/Lotmark App` (16 commits, HEAD `fff1b3a`). Findings are ordered by how much they change the document.

---

## P0 — CLAIMED-AS-VERIFIED BUT FALSE AGAINST THE CURRENT TREE

**1. The RLS story is stale, and it is the document's single most-repeated claim.** Commit `fff1b3a` ("Add row-level security — and fix the reason it would have been untested") landed after the gap-map was written. Verified now:

- `package.json:16` chains **seven** migrations, `0000` through `0006` — `0004_row_level_security.sql` is applied, not orphaned.
- `packages/db/migrations/0005_app_role.sql` creates `lotmark_app` — a non-superuser, non-owner role, with `REVOKE UPDATE, DELETE` on `audit_ledger`, `signatures`, `state_transitions` and `REVOKE DELETE` on `audit_checkpoints`. `apps/api/src/config.ts:20` defaults `DATABASE_URL` to `postgres://lotmark_app@localhost:5432/lotmark_dev`. That is blocker 5's sub-part (c), done.
- `packages/db/migrations/0006_tenant_resolution.sql` adds `lotmark.resolve_tenant()`, `SECURITY DEFINER`, returning routing fields only. That is sub-part (d) — the public/bootstrap read mechanism the document says item 1 hard-depends on — done, and done in the shape the critique asked for.
- `packages/db/src/__tests__/rls.test.ts` exists with **10 tests**, driven off `pg_class`/`pg_policies` exactly as §12 R1 and your §7 mitigation demand — including "is enabled AND forced on every table", "every table has a policy", the unfiltered-select test, the tenant-switch test, and the `study_equipment` join-table reach-through. That is sub-parts (a) and (e), done.

Passages that must be rewritten, not softened: §1 prose ("has **never run** — `package.json:16` chains `psql -f 0000 … -f 0003` and stops"); §1 table row *Security* ("RLS on **0 of 43 tables, 0 policies**"); §4 blocker 5's framing; §6 item 1's "**written and sitting unexecuted** — adding it to `package.json:16` and running it is hours"; §7 risk 1 ("RLS is unapplied").

What actually remains of blocker 5, and it is much less than 39–44 PD: the `generation` column (grep confirms it exists nowhere outside a comment in `audit.ts:78` about HMAC key generation — a different thing); the generation-agnostic ledger-table policy shape (critique P0-4 — the current `DO` loop gives `audit_ledger`, `audit_head`, `audit_checkpoints`, `signatures` the same flat `tenant_id = current_tenant()` predicate as everything else); and the raising-vs-NULL decision on `current_tenant()`. **Your §7 observation that it returns NULL rather than raising is correct and survives — keep it, it is now the only live half of that risk.** Re-base the number and re-rank §6; RLS is no longer the top cost-of-deferral item.

**2. Consequential count drift.** §1 says "43 tables, **4 applied migrations**" — now 7. "**211 tests** pass" — that figure predates `rls.test.ts`; the count is now ~221 (208 `it(` across ten files plus `golden.test.ts`, which uses `test(`). Both appear in the paragraph that establishes the document's credibility on verified state.

**3. "27 permissions" is wrong — there are 29.** `packages/domain/src/permissions.ts:12–40`. A naive regex undercounts because `order:read_own` and `order:read_all` contain underscores. The claim appears twice (§1 prose and the §1 table). Seven state machines, six SoD rules, 43 tables all check out.

**4. Line-number drift in §4 blocker 2.** `problem()` is genuinely duplicated verbatim in six files and genuinely returns only `{type, title, detail}` — the finding is sound. But the citations are off: `routes/auth.ts:218` (not 215), `plugins/session.ts:164` (not 162). The other four are exact. In a document whose authority rests on citation precision, fix these.

---

## P1 — ARITHMETIC

**5. T1's upper bound is overstated by 40 PD.** 746 − 224 + 70 + 60 = **652**, not 692. (The lower bound is right: 746 − 283 + 35 + 30 = 528.) T2 and T3 both compute correctly — 439 − 26 + 17 + 150 = 580, 492 − 15 + 50 = 527 — so this is an isolated slip, inherited from the effort source, not a method error.

The correction *strengthens* the document. Cumulative becomes 981–1,232 and the whole becomes **1,458–1,759**. Against the workbook's 1,676 P80 + 120–260 CSV = 1,796–1,936, the difference becomes **177–338 PD** — which matches the effort register's stated net credit of 178–339 almost exactly. With 692 in place the sanity check only appears to close. Cascade: T1 mid-tier becomes ₹0.80–0.99 Cr, boutique ₹0.58–0.71 Cr, Tier-1 SI ₹1.12–1.38 Cr; all-three ₹1.59–1.92 / ₹2.21–2.66 / ₹3.09–3.73 Cr; T1 elapsed 25–31 mo / 12.6–15.5 mo / **3.6–4.4 mo** at the ramp.

**6. "The 137–355 PD difference" is unsourced.** The effort register says the credit is 137–339 PD at P80 scale. 355 appears nowhere upstream. Also, the sentence calls the difference "exactly the net credit" when the tier totals additionally *add* 44–87 PD of rework — the difference is credit minus rework. Say that; it is still a clean reconciliation.

**7. §4's blocker sizes account for barely half of T1, and the document never says so.** Summing the seventeen rows plus the "running alongside" block: **254–371 PD** against a T1 total of 528–652. A reader who adds up §4 — and they will, the sizes are right there — is left with 270–280 PD unexplained. Notably, **no frontend or UI effort is sized anywhere in §4**, yet T1's premise is that a producer operates the system: today that is four React views, and blockers 12–15 add project, study, result-entry, competence and user-admin screens that the workbook prices inside P1–P8. Either add a closing line ("the seventeen blockers are 254–371 PD of the 528–652; the remainder is UI, the console build-out, test authoring and review cycles priced in the module base") or retitle §4 so it does not read as the T1 scope.

**8. The template model is unfunded.** §5 draws the line carefully — "the *model* with enforced cardinality is a T1 blocker; the multi-tenant *designer* is workbook C2, 39 PD" — but the effort model allocates C2 **100% to T3**, and no PD moves. The Guide 31 cardinality model is inside blocker 16's 45–60 PD alongside `numbering_series`, the blob store, Typst, veraPDF, the document signature, QR and the verify page. That is thin. Move a defensible slice of C2 (say 10–14 PD) from T3 to T1 and say you did.

---

## P2 — INTERNAL INCONSISTENCY AND TIER LEAKAGE

**9. `/verify/:token` is in both tiers, and it breaks T1's cut justifications.** Blocker 16 ends "→ QR → `/verify/:token` through the wave-1 public path," and §8 says "decide [Q11] before wave 3 builds `/verify/:token`" — wave 3 is T1. But the T2 feature table also claims "`/verify/:token` SSR no-JS page and the three `/public/v1/*` endpoints" as new at T2. Pick one. This is not bookkeeping: three T1 cut rows are justified by *"Localhost"*, *"No production deployment"* and *"no third party's personal data"*. A publicly reachable verification page at T1 falsifies all three, and §11.30 (Q11 open/closed) stops being free to defer. The clean answer is to build the pipeline and the QR token at T1 and hold the public page at T2 — which is also what §2's "not the record of record" framing implies.

**10. Guide 31 is claimed at both tiers.** T1's regime table says "Out entirely: … Guide 31 third-party validation," but blocker 16 delivers enforced Guide 31 cardinality *and* the reproducibility triple, while T2's regime table lists "ISO Guide 31 — certificate required content with enforced cardinality; reproducibility of an issued certificate" as newly in scope. If T1 builds both, T1's regime table should claim them and T2's should not re-claim them.

**11. Recall (blocker 17) sits in the wrong tier, and its cheap alternative was dropped.** T1's ISO 17034 scope is "§6.2, §6.3, §7.2, §7.5, §7.7, §7.8, §7.9, §8.4" — §8.6/§8.7 are listed under T2. Blocker 17 nonetheless says it "closes ISO 17034 §8.6/§8.7" at T1. More substantively, recall's operative half is telling holders to stop using the material, and there are no holders until T2 ships orders and vault holdings. A T1 `POST /lots/:id/recall` can move a state and nothing else. The gap-map offered the cheap answer and the document dropped it: *"Either build `POST /lots/{id}/recall` or delete the enum value."* At T1, constraining `LOT_MACHINE` / the enum so no unreachable state exists costs ~1 PD and removes the finding; the executable recall belongs with the holder closure at T2.

**12. T1 claims 21 CFR 11.10(e) with no work item behind it.** The clause requires that changes "shall not obscure previously recorded information." §1's own table concedes "no `before`/`after` capture," §3.8 of the architecture calls the prototype's action-sentence approach "a §11.10(e) shortfall," and critique 19 asks who computes the diff. The regulatory source puts this squarely in *"T1 must still deliver … the before/after prior-value capture mechanism named and built."* It appears in §1's gap table and then in no tier list, no blocker row, and no cut row. Add it to wave 0 or wave 1 (it is a trigger or a use-case-populated `changes` jsonb — critique 19 argues one column, not a trigger) or move 11.10(e) to T2. Right now the document claims a clause it has not funded.

**13. T1's stated scope has outgrown the module base it was priced from.** The effort model defines T1 as *"phases 0, 1, 2, and the issue-half of 3."* T1 as written here contains the full PDF/A pipeline, the blob store, the template model, the numbering series, the reproducibility triple, the QR, the verify page and recall — that is essentially all of Phase 3 except reissue/withdrawal/holders. The 599 PD base was allocated under the narrower reading (C1 100% to T1, C3 20%). Either narrow T1 back to "issue and render, no public surface, no recall execution," or restate the allocation. This is the root cause of findings 8, 9, 10 and 11.

---

## P3 — NAMED IN THE SOURCE, ABSENT FROM THE DOCUMENT

**14. The denial ledger, which is the largest omission.** ARCHITECTURE §11 Phase 1 lists it explicitly among "Ledger trigger, **denial ledger**, signer process, Ed25519 anchors, verification jobs." `0002_audit_chain.sql:31` already reserves it — `CHECK (ledger IN ('audit', 'denial'))`. `apps/api/src/services/guard.ts:35` builds a structured `Denial` with the comment "Structured detail for the denial ledger" and nothing persists it. The regulatory analysis makes it the gating gap for **11.300(d)** ("Absent: the `denial_ledger`, alerting"), which the document itself places in T2. It appears once in §1's gap table and is then in no tier, no blocker list, and no cut list.

**15. Which produces a genuine dependency violation.** Blocker 2 sits in wave 0 and is justified by §11 Phase 1's milestone: *"a `problem+json` **carrying its `auditSeq`**."* For a **denial** — which is the case the milestone is about, the demonstrable link between a refusal a user saw and the ledger entry proving the control fired — there is no `auditSeq` to carry until the denial is written somewhere. Wave 0 can deliver the RFC 9457 shape and `code`; it cannot deliver the milestone. Either add the denial ledger to wave 0/1 (it is one table and a write in `guard()`), or state that `auditSeq` is populated on audited acts in wave 0 and on denials once the denial ledger lands.

**16. The `@pii:` column registry.** The sequencing source names exactly two non-deferrable pieces inside "observability," for the same reason: `correlation_id` (which you kept, correctly, as blocker 3) and the `@pii:` column registry driving the redaction **allowlist** — *"an allowlist added after logs exist means you have already logged the PII."* You dropped the second. It also underpins critique 28, which you cite twice elsewhere (`person.email` and `person.full_name` unmarked). It is a wave-0 item and costs ~1 PD.

**17. NIST StRD goldens.** §9.3 mandates `Norris`, `Longley`, `Wampler1-5`, `SiRstv`, `AtmWtAg` asserted to certified digits; ARCHITECTURE Phase 2's milestone is literally "**NIST goldens green**." Verified: `packages/stats/src/__tests__/golden.test.ts` contains no NIST fixture — the goldens pin agreement with the *prototype*. Given that T1's stated purpose is producing numbers and §12 R3 is called "the largest technical risk in T1," this belongs in T1's metrology row next to ν_eff and the floored `msB < msW` branch. (The floored branch is implemented — `homogeneity.ts:102` — so your framing of it as a *test* gap is right.)

**18. The §9.3 offline verification test.** The regulatory analysis rates 11.70 `A` with one caveat: *"Missing only the §9.3 offline verification test — verify with the public key, no database — which is the form an assessor can repeat."* ARCHITECTURE Phase 3's milestone requires it verbatim. §1 presents 11.70 as "genuinely done" with no caveat, and the test appears nowhere. It is a day's work and it is the single most repeatable piece of evidence T1 produces.

**19. The Phase 0 local-dev contract.** ARCHITECTURE Phase 0's milestone is *"Clean clone → `make dev` on a machine with no internet → HTTPS login page."* The document carries `make validation`, the RTM generator and `docs/deviations.md` but drops mkcert TLS, the boundary lint (no repository import from a route file), CI, and offline operation. Related: **D10 generation retirement** appears only inside a risk mitigation, yet `generation` is a wave-1 blocker column — nothing in §4 says what consumes it or funds `POST /admin/tenants/{id}/reset`.

**20. The clock service is placed a tier late.** ARCHITECTURE puts "clock service with measured NTP offset" in **Phase 1**; the document puts it at T2 under CERT-In. But §14 Q9 — the offset above which *signing is refused* — gates the signing act, which is T1's entire deliverable, and every ledger entry already writes `time_source` and `region` (`tenants` table, lines 33–34). Either move the offset-refusal threshold to T1 or state that T1 signs without a clock gate and name that as a deviation.

**21. `lots.ts` has the same counting defect as `certificates.code`, unmentioned.** You flag `CRT-${count(*)+2041}` (`routes/lots.ts:296–298`, verified exact). `renderLotCode` at `routes/lots.ts:52–55` does `SELECT count(*) … FROM lots WHERE tenant_id = …` then `+1` for `{SEQ}`. §4.8's "a gap in a certificate series is a finding" applies to the lot register under ISO 17034 §7.9 too, and `numbering_series` with `FOR UPDATE` fixes both. Cite both — it makes the case for blocker 16's numbering series stronger at no cost.

---

## P4 — CLASSIFICATION AND ONE STRUCTURAL HOLE

**22. The "do the sweep once" argument does not cover its own plan.** §4 blocker 6's reasoning is the sharpest thing in the document — two 43-table sweeps six months apart cost more than twice one sweep. But waves 2 through 4 then add roughly ten new tables *after* the sweep: `schema_migrations`, anchor storage, `numbering_series`, `blob`, `certificate_template`, `certificate_template_version`, `uncertainty_component`, `property_value_version`, `capa_action`, `denial_ledger` (per finding 14). §6 item 1 even uses "43→~60 tables" as the argument for sweeping now. The mitigation is already in the repository and should be named: `rls.test.ts`'s two `pg_class` assertions fail on any policy-less or unforced table, so the sweep becomes a *convention plus a CI gate* rather than a one-time event — and the same gate must be extended to `generation` and the `LM_ASOF_WRITE` trigger, or those two silently exempt every table added after wave 1.

**23. Deferrable, currently marked blocker.** Recall execution at T1 (finding 11 — constrain the enum instead, ~1 PD). The public verify page at T1 (finding 9). Arguably the veraPDF *gate*: at T1, running veraPDF advisory rather than build-failing preserves the R4 information without letting an unreachable PDF/UA verdict block a pilot — §12 R4 itself concedes the outcome may be "scoped in the release notes."

**24. Blocker, currently unmarked.** The denial ledger (14). Before/after capture (12). And the raising-vs-NULL `current_tenant()` decision — the document confines it to a §7 risk note, but it is a wave-1 DDL-adjacent decision with a behavioural consequence: NULL fails closed for reads and silently defeats the mechanism §12 R1 specifies, and changing it after 43 policies are live means re-verifying every one. It belongs in §8's decision table alongside Q7, Q10 and Q11.

**25. One mis-citation with real weight: D13's chosen option.** The document says "ARCHITECTURE §13 D13 says 27–34 weeks for one engineer" and builds the whole D12-vs-D13 credibility argument on it. `ARCHITECTURE.md:1135` reads: *"(a) 27–34 weeks, one engineer; (b) 18–22 weeks, two engineers … **(b) if funded, otherwise (a)**."* The *decision* is two engineers at 18–22 weeks — 180–220 PD, which is the number the D12 ≥120 PD CSV line should be compared against (55–67%, not 70%). The effort source got this right and this document dropped the second half. It does not change the conclusion; it does change whether a reader trusts the citation.

---

## WHAT IS SOUND — DO NOT REWORK

- **The tier construction itself.** Three tiers, each droppable from the top without invalidating the tier below, is the right design and §8 is right that it is what §12 R15 asks for. T2 does not quietly contain T3: the T3 list (template *designer*, EN/HI, integrations, analytics, storefront, vault, PWA, handheld, per-tenant DEKs, traceability-as-data, GIGW/STQC) is cleanly separable, and each T3 item has a workbook module or a named architecture gap behind it. The leakage is all in the T1/T2 boundary (findings 9–13), not T2/T3.
- **§6 items 3, 4 and 5** — the as-of trigger bundled into the wave-1 sweep, `correlation_id` inside `audit_payload()`, and the per-issue acknowledgement key. All three are correctly sourced, correctly reasoned, and the ack-key argument ("no way to reconstruct which issue was actually acknowledged") is the sharpest paragraph in the document. The `audit_payload()` reasoning is verified against `0002_audit_chain.sql`.
- **§5's cut lists.** Every row carries a reason and the reasons trace. The GIGW-is-a-tenant-profile argument (`lotmark-app.html:179–180`, `outside`) is the strongest deferral in the set, and the "state the deferral with a reason rather than inheriting the architecture's silence" instruction on analytics/MIS is exactly right for critique 9.
- **§7.** Faithful to §12 R1–R15 and both workbook registers. The DPDP arithmetic — 13 May 2027, ~9 months from today, a 10–12 month T2 landing on or after it, therefore design it in from T1 — is correct and correctly framed, as is the "do not build data localisation for DPDP, build it for CERT-In" correction.
- **§8's three schema-affecting decisions** (Q10, Q11, Q7) and the "answering them after the sweep is the most expensive possible moment" framing. Q7 in wave 0 before the first blob is written is a genuinely non-obvious call and it is right.
- **The silent correction on `df_eff`.** The regulatory source asserts "`df_eff` and `k` are columns in `property_value`." Verified: `property_values` has `coverage_factor double precision DEFAULT 2` and no `df_eff` (`0000_initial_schema.sql:318–339`). The document is right and its source was wrong — but say so explicitly, because a reader cross-checking against the analysis will think you missed it. Same for the source's ISO 17034 §7.2/§7.3 row, which claims `GET/POST /projects` exists; verified, only `GET /projects` does.
- **The §1 opening.** The "domain core is real and it is the hard part / what is absent is the ability to operate the system" framing is accurate, well-evidenced and the right thing to lead with — once the RLS paragraph is corrected.

---

## THE FIVE EDITS THAT MATTER MOST

1. Rewrite every RLS passage against `fff1b3a`; re-base blocker 5 from 39–44 PD to what actually remains (`generation`, generation-agnostic ledger policies, raising `current_tenant()`); demote §6 item 1 and find a new "cheapest high-value line."
2. Fix T1's upper bound to 652 and cascade it — the sanity check then closes exactly, which is a better story than the one currently told.
3. Add the denial ledger to T1 wave 0/1, and fix blocker 2's `auditSeq` claim accordingly.
4. Resolve the T1/T2 certificate boundary in one pass: `/verify/:token`, Guide 31 cardinality, the reproducibility triple, and recall. Decide whether T1 is "phases 0–2 plus certificate issue" or "phases 0–3," then make the regime tables, the blocker list and the 599 PD base all say the same thing.
5. Add the four dropped source items — before/after capture, the `@pii:` registry, NIST goldens, the offline verification test — to T1. Together they are under 10 PD and three of them are clauses T1 already claims.