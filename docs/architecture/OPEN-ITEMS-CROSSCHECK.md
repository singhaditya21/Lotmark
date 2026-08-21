# Cross-cluster integration review — 8 specs, 13 items, one repository

I read the live code and queried the live database. Several claims in these specs are **stale**: two of the thirteen items are already built and shipped in this working tree.

---

## 0. THE HEADLINE: TWO CLUSTERS ARE ALREADY DONE

**ITEM 1 (Cluster 1 — certificate reissue/withdrawal console) is implemented.** Verified:

- `apps/web/src/components/CertificatePanel.tsx` — 419 lines, header comment states the exact three rules the spec asks for ("holders shown BEFORE the act", "'you may not see the holders' is never rendered as 'there are no holders'", "notified and unreachable … never summed"). Mounted from `ProjectDetail.tsx:301`.
- `App.tsx:85` already passes `canReissue={held.has('cert:reissue')}`.
- `apps/api/src/routes/certificates.ts:57` — `GET /certificates/:id` returns the full issue history plus `currentIssue` (the highest non-withdrawn issue, null when the latest is withdrawn).
- `certificates.ts:156` — the holders route is **already widened**: `cert:reissue` OR `order:read_all`, plus a separate `pii:contact` decision that gates `contactUserId` and emits `hasContact` + `contactsVisible`. The spec's central finding ("exactly the operator who performs a reissue gets a 403") is fixed.
- `lots.ts:519-527` already selects `c.id AS certificate_id` with the comment "the console needs it to open the issue history".
- `apps/web/src/lib/api.ts` already declares `CertificateDetail`, `CertificateIssue`, `Holder`, `HoldersResponse`, `NotifiedParty`, `ReissueResult`, `WithdrawResult`, and `Lot.certificate_id`.

Implementing Cluster 1 as written produces a **second, parallel implementation**: a new `GET /certificates/:id/issues` duplicating `GET /certificates/:id`, and `ReissueCertificate.tsx` + `WithdrawIssue.tsx` + `HoldersToNotify.tsx` + `NotificationReport.tsx` + `lib/notices.ts` alongside the working `CertificatePanel.tsx`.

**ITEM 5 (Cluster 5 — PDF/A-2b) is implemented.** Verified:

- `certificate-pdf.ts:64` — `RENDERER_VERSION = 'lotmark-pdf-2'`, already bumped, with the comment "Incremented from `lotmark-pdf-1` when the OutputIntent, the subset prefixes…".
- `attachOutputIntent()` at `:324`, `pdfaid:part 2` / `conformance B` at `:422-423`, subset-prefix rewrite after `await pdf.flush()` at `:310`/`:385`.
- `apps/api/src/services/icc.ts` — generates the sRGB profile from first principles (`srgbProfile()`, `srgbProfileDigest()`), with `apps/api/scripts/icc-compare.mts` as the Apple cross-check.
- `apps/api/src/services/pdfa.ts` — **already exists and is the structural checker** (`checkPdfA2b`, `PdfaReport` with `conformsToCheckedSubset` and `notChecked`).
- `apps/api/scripts/verapdf-gate.mts` + `pnpm --filter @lotmark/api pdfa`; `apps/api/src/__tests__/pdfa.test.ts` and `certificate-pdf.test.ts:106-130` already assert `/^[A-Z]{6}\+DejaVu/` and content-derived tags.

**This is not merely duplicated work — it is a file overwrite.** Cluster 5 says `create apps/api/src/services/pdfa.ts` containing `attachSrgbOutputIntent` / `applySubsetPrefixes`. That path holds the existing 350-line checker. Landing Cluster 5 verbatim destroys it.

**Do not build Clusters 1 or 5.** Salvage from them: Cluster 1's `lib/notices.ts` pure-logic extraction and reconciliation test set (genuinely absent — every rule currently lives inline in `CertificatePanel.tsx` JSX, which is precisely what `lib/capa.ts` exists to prevent), and Cluster 5's `--require-verapdf` semantics if `verapdf-gate.mts` lacks them.

---

## 1. SHARED-FILE COLLISIONS AND MERGE ORDER

### `apps/api/src/app.ts` — 4 clusters
| Cluster | Change |
|---|---|
| C2 | `registerAdminConfigRoutes`, `registerAdminPeopleRoutes` |
| C3 | 5 registers (catalogue, orders, entitlements, shipments, vault) |
| C6 | `registerConformanceRoutes` + `onRoute` capture hook + operation registry |
| C8 | `loggerOptions(cfg)` replacing `{ level }` at :31-33, `app.decorate('metrics', …)`, `onResponse` hook, `/metrics`, `registerOpsRoutes` |

Additive except C8's logger line. **Order: C8's logger/hooks first** (it rewrites the Fastify constructor options block), then route registrations in any order, **C6 last** (its completeness test must see the final route table).

### `apps/web/src/App.tsx` — 5 clusters, and two of them are structurally incompatible
Current state: `type Route = 'projects' | 'capa' | 'audit'`, `useState<Route>('projects')`, ternary chain ending in Projects (`:82-90`). C4's diagnosis is correct and verified.

- **C4** replaces the union with a data-driven `SURFACES` table + `resolveRoute()` + an exhaustive `switch` whose `default: const unreachable: never = route` **fails to compile when any other cluster adds a route**.
- **C3** replaces it with `ConsoleRoute | StorefrontRoute` split on `me.organisation.kind`.
- **C2** adds `'configuration' | 'people'` + a global `<DraftBanner/>`.
- **C6** adds `'conformance'`.
- **C8** adds `'ops'` + a global `<JobHealthBanner/>`.

**Merge order: C4 first, and treat C4's `SURFACES` as the only router.** Every later cluster then adds one row to `SURFACES` (`{id, label, half, permission}`) plus one `case` — a two-line change instead of a rewrite. C4's `Surface.half` field is exactly the seam C3 needs. **Both global banners (C2's draft, C8's job-health) must be hoisted into one banner slot above `<main>`**, or two sticky warn-toned bars stack.

### `apps/web/src/lib/api.ts` — 5 clusters
- C1 **and** C2 both fix `needsStepUp` identically (verified broken at `:29`: compares `problem.title`, while `http/problem.ts` sets `title = humanise(code) = 'Step up required'`). C6 also depends on the fix for its PQ regression test. **Land the one-line fix first, standalone, as its own commit.**
- C2 adds `del()`; C3, C2, C4, C8 add response interfaces; C3 and C4 both extend `Me` (C3: `organisation`; C4: `roleKinds`). **Merge C4's `Me` extension and C3's into one interface** — see the contradiction in §3.

### `apps/web/src/styles.css` — 3 clusters
C1 adds `.note.warnbox`, C2 adds `.note.warn`, C8 needs a warn tone too. **Pick one name.** C2's `.note.warn` is the natural fit for the existing `.note.deny` / `.note.okbox` vocabulary.

### `packages/domain/src/config/defaults.ts` — 2 clusters, same function
C2 adds `{key:'competence', …}` to `defaultNumbering()`; C3 adds `entitlement` and `shipment`. Trivially mergeable but **both must land**, and neither reaches an existing tenant (see §3a).

### `packages/domain/src/permissions.ts` — **no collision, by deliberate convergence**
The parent named this as a collision point. It is not one. **No cluster modifies it**, and three of them explicitly refuse to: C3 rejects adding `catalogue:read`, C8 rejects `ops:read`, C6 reuses `conformance:read`. All three give the same correct reason — roles are stored config (`session.ts:72-76` reads `config_entries` of the active version), so a permission added in code never reaches an existing tenant. This convergence is the strongest signal in the batch; preserve it.

The real domain contention is `packages/domain/src/index.ts` (C3 one export line), `config/resolve.ts` (C4 adds `resolveRoleKinds`), `signatures.ts` (C2 adds `'config_version'` to `SignableKind`), `config/registry.ts` (C2), and both existing domain test files.

### Other multi-cluster files
- `apps/api/src/jobs/context.ts` — **C3** (TenantContext gains `producerOrganisationId`, threaded through `forEachTenant`) and **C8** (open-then-close `job_runs`, new `JobRunHandle`, changed `JobOutcome`). Both rewrite `forEachTenant`. **C8 first** (it restructures the function); C3 then adds one field.
- `apps/api/src/routes/console.ts` — **C7 item 12** rewrites the `/audit/verify` handler for the new `verify_audit_chain` return shape; **C6** extracts the budget code path at `:88-143` into `services/uncertainty.ts`. Disjoint regions; C7 first.
- `apps/api/src/db.ts` — **C3** adds `organisationId`, **C7** adds `retiredAuditKeys`. Both optional fields on the same arg object; merge into one signature.
- `apps/api/src/plugins/session.ts` — **C3** (`organisationId`/`organisationKind`/`organisationName` + a join on the user SELECT at `:66-67`) and **C4** (`roleKinds`). Same `RequestContext` interface, same returned object literal.
- `apps/api/src/routes/auth.ts` `/me` at `:204-214` — C3 and C4 both add a field.
- `packages/db/src/__tests__/rls.test.ts` — every cluster adding a SQL function must add its own `REVOKE EXECUTE … FROM PUBLIC`, or `functions_public_can_execute()` fails. C2, C3, C6, C7, C8 all add functions. This test is the shared tripwire; **it will fail on the first cluster that forgets, and the failure will look like the test's fault.**
- `packages/db/src/seed/run.ts` — C3 (counters + organisation GUC), C7 (vault_holdings insert at `:421-423`, verified to omit `acquired_on`), C8 (nothing). C7's change is load-bearing (see §2).

---

## 2. MIGRATION ORDERING

**Live state verified:** 17 migrations `0000`–`0016` applied; `lotmark_meta.schema_migrations` has 17 rows. **Zero views exist in schema `lotmark`** (C6's `security_invoker` trap has never been hit — correct and unguarded). Next free number is **0017**, and **five clusters all claim it** (C2, C3, C6, C8, and C7's first of three).

`packages/db/src/migrate.ts` records a checksum per filename and refuses on drift, so renaming an applied file is unrecoverable. **Numbers must be allocated once, before anyone writes a file.**

| # | File | Cluster | Item |
|---|---|---|---|
| **0017** | `config_administration` | C2 | 2 |
| **0018** | `key_custody` | C7 | 9 |
| **0019** | `audit_key_generations` | C7 | 12 |
| **0020** | `acquired_on_not_null` | C7 | 13 |
| **0021** | `ops_observability` | C8 | 10/11 |
| **0022** | `commercial_surfaces` | C3 | 3 |
| **0023** | `conformance_views` | C6 | 6 |

### Hard must-precede constraints

1. **0020 before 0022.** This is the NOT NULL that needs a backfill, and it is worse than either spec knows. Verified: `vault_holdings.acquired_on` is nullable and **both live rows are NULL today** — 0011's backfill ran and `seed/run.ts:421-423` re-inserts without the column afterwards. So the backfill alone is insufficient; the `BEFORE INSERT` trigger is mandatory or `pnpm db:seed` and `constraints.test.ts` break. Separately: once C3's **restrictive** `organisation_isolation` policies exist on `orders`/`order_lines`/`vault_holdings`, 0020's backfill `UPDATE` reads those tables with no `lotmark.organisation_id` set. On this machine the migration connection is a superuser and it silently works; under the non-superuser owner 0005 describes, it affects **zero rows and reports success**. Running 0020 before 0022 sidesteps this entirely.
2. **0019 before 0023.** C7 replaces *both* arities of `verify_audit_chain` with new return columns (`generations`, `key_available`). C6's conformance service and assessment pack consume it. Coding C6 against the old shape means rewriting it.
3. **0021 before 0022.** C8's migration primes the CAPA numbering counter. Verified: the active config version's `capa` numbering template is `NCR-{SEQ}` with `resetPolicy: 'yearly'`, but the only counter row is `('capa','all',300)` — the yearly scope `'2026'` does not exist, so `nextCode` starts at `NCR-0001`, and existing CAPA codes are `NCR-0231, 1002, 2001, 2002, 3001`. C3's cold-chain service raises CAPAs through `nextCode`. Without C8's priming first, C3's first excursion CAPA collides with `capa_tenant_code_unique`.
4. **0017 before 0022.** C3's migration disables `config_entries_draft_only` (verified present) to insert `entitlement`/`shipment` numbering into the **active** version 1. C2 exists to make that impossible. See §3a.
5. **0023 last.** C6's clause views must be written against the final schema — C3's `entitlement_state_known`, C2's competence trigger, C7's custody vocabulary, C8's `job_runs` constraint.

### Constraints verified safe against live data
- C2's `config_version_risky_change_is_signed`: the single `config_versions` row is `version 1 / active / signature_id NULL / change_summary '[]'` → passes.
- C3's `entitlement_decided_is_accountable` and `entitlement_approved_has_revalidation`: the only row is `ENT-124 / under_review / decided_by NULL` → passes.
- C3's `order_state_known`: live states are `placed`, `dispatched`, `delivered` → passes.
- C2's `config_versions_one_draft_per_tenant`: no drafts exist → passes.

---

## 3. CONTRADICTIONS

**(a) C3's migration violates C2's entire governance model — the sharpest conflict in the batch.**
C3 lifts `config_entries_draft_only` and writes two numbering entries into the **published, active** config version, arguing that minting a version 2 from a migration "writes governance history attributing a deliberate tenant configuration change to a schema upgrade". C2's migration and console exist to make "a published version is never edited" a database property, and its `diffAgainstActive` will subsequently show entries that no `change_summary` in any version records. **Resolution:** C3 stops touching `config_entries`. The two entries go into `defaultNumbering()` (new tenants) plus a one-off CLI built on C2's `publishDraft` that creates draft v2 with them and publishes it as a behaviour change with a stated reason. That is also the cleanest demonstration of the configuration model in the product.

**(b) C3 and C4 derive "which half of the product" from two different sources.**
C4: `resolveRoleKinds()` over the user's **role assignments'** declared `RoleConfig.kind`, with an explicit argument that inferring the half from anything else lets a tenant-configured grant promote a laboratory into the producer console. C3: `me.organisation.kind` from **`organisations.kind`** on the loaded user row, with an equally explicit argument that a boundary the caller can name is not a boundary. On the seed they agree (meera/labqm sits at a customer org). They disagree the moment a producer-org employee is granted a customer role, or a customer-org user is granted `audit:read`. **Resolution:** organisation kind is the *data* boundary (RLS, what you can see); role kind is the *product* boundary (which half you land in). `/me` returns both; `SURFACES.half` matches on role kind; RLS matches on organisation. Say so in one comment in `surfaces.ts` or the next person will collapse them.

**(c) C4's Access page tells customers the laboratory half does not exist; C3 builds it.**
C4 specifies literal copy: *"The laboratory half of Lotmark — ordering, entitlements and the vault — is not built in this release."* If C3 lands, that sentence is false on the screen the two customer personas land on. **C4's copy must be conditional on the storefront surfaces being registered**, or C4's Access page becomes a documented lie the moment C3 merges.

**(d) C6's operation registry is opt-in for everybody else.**
C6 adds `apps/api/src/http/operation.ts` with a completeness test asserting Fastify's real route table ⊆ `OPERATIONS ∪ LEGACY_ROUTES`, and that `LEGACY_ROUTES` **never grows**. C2 adds ~20 routes, C3 adds ~20, C8 adds 2 — all with bare `app.get`/`app.post`. If C6 lands first, every subsequent cluster breaks that test. **C6 must land last**, and its `LEGACY_ROUTES` baseline must be taken after C2/C3/C8 have merged.

**(e) C3 will empty the certificate holder list — and the console that consumes it now ships.**
C3's restrictive policies on `orders`/`order_lines`/`vault_holdings` fail closed with no `lotmark.organisation_id`. `certificate_holders()` (verified: `LANGUAGE sql STABLE`, no `SECURITY DEFINER`) reads all three. Its callers are `certificates.ts:181`, `services/certificate-issue.ts`, and `jobs/notices.ts`. C3 knows this. What C3 does not know is that **`CertificatePanel.tsx` now renders that list to a Technical Manager before she withdraws a certificate** — so the failure mode is no longer a curl command returning `[]`, it is a withdrawal screen that says "no holders on record" to the person deciding whether to withdraw. Non-negotiable: C3's organisation threading and the holder-list regression test land in the same commit as the policies.

**(f) C1 vs. the declared domain config on withdrawal.** C1 argues (correctly, and the shipped code agrees) that withdrawal is unsigned server-side, while `defaults.ts:77` puts `cert:reissue` in `SIGNATURE_REQUIRED` and `state-machines.ts` declares `released->withdrawn` as requiring `cert:reissue`. The code and the declaration disagree today. Nobody resolves it. Flag as an accepted, documented divergence, or make withdrawal signed — but not silently.

**(g) C7 drops `audit_ledger.key_version`** (verified present, single value `'v1'`, no reader). C6's assessment pack serialises ledger rows. If C6's `ledger.jsonl` schema is written before 0019 lands, its manifest digests change.

---

## 4. DUPLICATED WORK

1. **`ApiError.needsStepUp`** — C1 and C2 specify the identical fix; C6 tests it. Land once, first.
2. **Certificate issue history endpoint** — C1's proposed `GET /certificates/:id/issues` duplicates the shipped `GET /certificates/:id`.
3. **Holder preview + notification report** — C1's four new components duplicate `CertificatePanel.tsx`.
4. **PDF/A production helpers + checker** — C5 duplicates `certificate-pdf.ts` + `icc.ts` + `pdfa.ts` + `verapdf-gate.mts`, under a colliding filename.
5. **Per-tenant SoD settings** — C3 creates `services/sod-settings.ts` to read `tenants.sod_settings`; C6 independently identifies the same unread column as a conformance finding. One implementation; C6 consumes it.
6. **Reason-required from declared workflow** — C3's `services/workflow-config.ts` overlaps C2's config-reading service (`entriesOf`/`activeVersion`). Same query shape as `numbering.ts:34-39`. Build one config-entry reader.
7. **`.note.warn` / `.note.warnbox`** — C1, C2, C8.
8. **CAPA numbering repair** — C8 fixes `notices.ts:150` (`count(*)+1001`) and primes the counter; C3 independently vows not to copy that pattern. Same defect, one fix.
9. **`security` keychain custody** — C7 (signing keys) and C8 (audit-key escrow for backups) both shell out to `/usr/bin/security` with the same argv-exposure and locked-keychain traps. One provider module.
10. **Pure web presentation modules** — C1 `lib/notices.ts`, C3 `lib/orders.ts`, C4 `lib/surfaces.ts`, C8 `lib/ops.ts`, C2 `lib/config.ts`. Not duplicates, but five clusters independently reinvent the `lib/capa.ts` pattern; agree the convention once.

---

## 5. GAPS — things in the thirteen items no spec covers

1. **Creating customer users.** C3 builds the storefront; C2 builds `POST /admin/users` (which mints the initial password and TOTP secret). C3 does not depend on C2, so if C3 ships alone there is no supported way to create a laboratory account except the seed. **C3 depends on C2 and neither says so.**
2. **The forbidden-subcontracting list.** `packages/db/src/schema/compliance.ts` claims it "lives in `@lotmark/domain` and is enforced at the service boundary"; it does not exist (grep finds only the `subcontractor:manage` permission string). C6 correctly reports it as `declared, not enforced`. **No cluster implements it.** ISO 17034 §7.4 stays half-answered.
3. **Re-rendering historic certificates.** C6's assessment pack byte-compares a re-render. Verified live: of four `certificate_issues` rows, **three carry `renderer_version` NULL and one carries `lotmark-pdf-1`; none carries the current `lotmark-pdf-2`.** So C6's strongest reproducibility check skips 100% of existing data on day one. Nobody covers back-filling or re-issuing under the current renderer.
4. **The anchor circle is open.** `lotmark.audit_checkpoints` holds one signed anchor; `apps/api/.anchors-exported` does not exist. C8's DR drill's best check ("re-verify an exported statement against the restored database") has nothing to verify. Nobody schedules `anchor export`.
5. **Alerting off-box.** C8 raises a CAPA and shows a console banner. Nothing pages anyone, and nothing detects the API being down. C8 is honest that the watcher cannot see its own absence; nobody closes it.
6. **`order:refund`.** The permission exists and is granted to `commercial`; C3 deliberately leaves it unimplemented (SoD rule `refund-above-threshold-needs-second-approver` is `pending-subject`). Correct, but item 3 is therefore incomplete by design.
7. **Government tier rate.** No percentage or tier price list exists anywhere. C3 charges list price and records the tier. An approved entitlement has no observable commercial effect. Accept explicitly or add a `tier` config kind.
8. **`lotmark.organisations` stays tenant-scoped.** C3 deliberately declines to restrict it (`lots.ts:355-359` LEFT JOINs it for the producer accreditation and would silently lose the line). So one customer's rows remain visible at the database level to another customer's session. Documented, not fixed.
9. **The vault half of `certificate_holders` has no lower bound.** Verified at 0011:155 — `AND (w.to_at IS NULL OR v.acquired_on IS NULL OR v.acquired_on < w.to_at::date)`, versus the order half's two-sided bound at :142-143. Once C7's 0020 removes NULL, the asymmetry is bare and unaddressed. C7 defers it explicitly. It decides who gets a withdrawal notice.
10. **No component testing anywhere.** `apps/web` has vitest with no jsdom and no testing-library (verified in `package.json`). Five clusters ship UI. All push logic into `lib/*.ts` — correct — but the rendered surfaces of C1/C2/C3/C4/C8 have zero automated coverage, and C6's PQ explicitly qualifies the API, not the console.
11. **No HTTP test harness.** All four `apps/api/src/__tests__` files are pure. C6's PQ needs `app.inject()`, C2's and C3's authorisation attacks need it. Standing one up is unbudgeted work every cluster assumes exists.
12. **`pnpm db:reset` is broken** — `packages/db/package.json` wires it to `src/reset.ts`, which does not exist. C8 notices; nobody fixes it.
13. **A new workspace package needs a `pnpm install`.** C6 adds `packages/conformance` and a `workspace:*` dependency from `@lotmark/api`. The environment says no npm; pnpm 9.15 exists and a pure workspace link is offline-resolvable, but the lockfile changes. Verify before committing to C6's structure.

---

## 6. OVERCLAIMS

| Cluster | Overclaim | Reality |
|---|---|---|
| **C5** | The whole cluster | Already built. Its own honesty about veraPDF is correct and already encoded in `verapdf-gate.mts`. `/usr/bin/java` exists as the macOS stub and exits 1 — C5's insistence on executing `java -version` rather than testing for the binary is the one thing worth checking survives in the existing script. |
| **C1** | "Adds ~13 web tests to the 274 that pass today" | The feature exists; the tests would pin a second implementation. Only `lib/notices.ts` is genuinely new value. |
| **C7 (item 9)** | "Real key custody" | The only new class that actually works is `keychain`, and it is macOS-only. `kms` and `hsm` throw at construction. C7's own production guard means **this build cannot lawfully run in production under any custody class**, on any platform. That is honest, but it means item 9 delivers better *dev* custody plus a refusal, not real custody. Additionally, `security add-generic-password -w <pem>` puts the private key in argv where `ps` can read it — C7 flags this; it is a genuine limit of the approach, not a detail. |
| **C6** | "OpenAPI 3.1 that cannot drift" | Verified: **no route anywhere declares a Fastify `schema`** (`grep 'schema:' apps/api/src` finds only `schema: 'pgboss'`). C6's own estimate migrates 2 of 33 routes. The document covers those two; the other 31 sit on an allowlist. "Cannot drift" is true only of the registry, and the completeness test is what makes it meaningful — so **the test is the deliverable, not the JSON.** |
| **C6** | IQ probes read `lotmark_meta.schema_migrations` | Verified: `lotmark_app` has neither USAGE on the schema nor SELECT on the table. Without C6's `SECURITY DEFINER` accessor the IQ record reports **zero applied migrations and looks like an answer.** The mitigation is in the spec; it must not be dropped as a nicety. |
| **C6** | Assessment-pack `chain.json` proves ledger completeness | `verify_audit_chain` walks from seq 1 and checks continuity + HMAC; a truncated ledger returns `ok=true`. Only the manifest's captured entry count makes it a real check. C6 knows this; it is the single easiest thing to lose in implementation. |
| **C3** | Government tier applied | `tierApplied` is always `false`. The commercial half of item 3 does not exist. |
| **C8** | DR drill proves restorability | `pg_dump` does not dump roles; restoring with `--no-privileges` produces a database where every REVOKE from 0005/0012/0015 is gone and **all row counts still match**. C8's privilege-posture assertions are the load-bearing part. Also: the drill escrows the audit key via macOS keychain — again macOS-only. |
| **C2** | Config administration reaches existing tenants | It does, but only through its own publish path — which is precisely why C3's trigger-lift must not ship. |

**Nothing in the batch claims Docker, Redis, npm, cloud KMS, or network access.** All eight specs correctly treat those as unavailable. That is a genuine strength.

---

## 7. RECOMMENDED BUILD ORDER

**Phase 0 — Retire the stale clusters (half a day).**
Delete Clusters 1 and 5 from the plan; salvage `lib/notices.ts` (extract the rules already inline in `CertificatePanel.tsx`) and confirm `verapdf-gate.mts` has `--require-verapdf`. *Reason: two of thirteen items are done, and Cluster 5 would overwrite a working file.*

**Phase 1 — The one-line fixes and the number allocation (half a day).**
`ApiError.needsStepUp` → branch on `problem.code`; allocate migration numbers 0017–0023 in a committed table; agree on `.note.warn`. *Reason: three clusters specify the same fix, and a migration-number collision is unrecoverable once applied.*

**Phase 2 — C4, the router (1–2 days, no migration).**
Land `SURFACES` + `resolveRoute` + `Access.tsx` + `resolveRoleKinds` + `roleKinds` on `/me`. *Reason: it fixes a live bug where four of nine personas land on an empty screen, and it establishes the router model that C2, C3, C6 and C8 each extend by one row instead of rewriting.*

**Phase 3 — C2, configuration administration (migration 0017).**
Including the CLI that publishes config version 2. *Reason: it is the only supported way to add numbering entries, roles or permissions to an existing tenant, and C3 needs `entitlement`/`shipment` templates before its routes can create anything.*

**Phase 4 — C7 items 9, 12, 13 (migrations 0018, 0019, 0020).**
In that order. *Reason: 0019 rewrites `verify_audit_chain` and `audit_chain_append`, the deepest shared machinery, so everything downstream should code against the final shape; 0020 must finalise `certificate_holders` and back-fill `acquired_on` while the migration connection can still see `orders` and `vault_holdings` unrestricted.*

**Phase 5 — C8's migration and observability half (migration 0021; defer the DR drill).**
`job_runs` open-then-close, `job_health()`, `dr_drills`, the CAPA counter priming, the redacting logger, `/metrics`, `routes/ops.ts`, the banner. *Reason: the counter priming must precede C3's cold-chain CAPA path, and the redacting logger should be in place before five clusters start logging new request shapes.*

**Phase 6 — C3, commercial surfaces (migration 0022).**
Land the migration + organisation threading (`db.ts`, `session.ts`, `certificates.ts`, `jobs/context.ts`) + the holder-list regression test **alone**, confirm the full suite green, then the routes, then the storefront. *Reason: restrictive RLS can silently empty the certificate holder list, which is now rendered on a live withdrawal screen — this is the highest blast radius in the batch and must not share a commit with anything else.*

**Phase 7 — C8's DR drill (no migration).**
`services/dr.ts`, `src/dr.ts`, `verify-pack`. *Reason: it rehearses a restore of everything above, so it should be written against the final schema and the final artefact set.*

**Phase 8 — C6, conformance / RTM / OpenAPI (migration 0023).**
Clause views, assessment pack, requirement register, IQ/OQ/PQ, operation registry with its `LEGACY_ROUTES` baseline taken now. *Reason: it catalogues and gates everything the other phases built; landing it earlier means either a wrong catalogue or a completeness test that every subsequent cluster breaks.*

Phases 2 and 4 can run in parallel (different files entirely). Phases 3 and 5 can overlap. Phases 6, 7 and 8 are strictly sequential.