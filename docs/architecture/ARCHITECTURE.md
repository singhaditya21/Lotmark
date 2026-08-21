# LOTMARK — TECHNICAL ARCHITECTURE DECISION DOCUMENT

**Version:** 1.0 (for approval)
**Subject:** Turning the `lotmark-app.html` prototype into a real, multi-tenant, regulatorily defensible product that runs on one laptop with one command.
**Scope:** architecture only. No code is written by this document.

---

## 0. THE GOVERNING ARGUMENT

The prototype's domain modelling is, in several places, genuinely excellent — dated competence with a frozen basis snapshot, the three traceability closures, segregation of duties as data, uncertainty derived and never typed. Its *mechanisms* are all shapes without substance: a hash chain over a 32-bit FNV checksum, a §11.70 signature binding with no key, an MFA that accepts any six digits, a tenant that is a global variable, a retention schedule that is a table of prose.

**This architecture keeps every model and replaces every mechanism.** Five rules drive every decision below.

| # | Rule | Consequence |
|---|---|---|
| **R1** | An invariant that can be violated is not an invariant. | The sixteen `selfCheck()` assertions become foreign keys, CHECK constraints, exclusion constraints and role grants wherever expressible. Only the genuinely computational ones stay as jobs. |
| **R2** | Integrity must be provable to someone who does not trust the database. | The in-database chain proves ordering. A periodic Merkle **anchor**, asymmetrically signed by a key the application cannot read and stored outside the database, proves the chain was not rewritten. |
| **R3** | Authorisation is a property of the use case, not of the HTTP layer. | `guard()` is called by the application service. Jobs, importers, the seed harness and any future gRPC or mobile surface pass through the same decision point. |
| **R4** | Every validated behaviour must be executable against the installed instance. | IQ, OQ, PQ and the requirements traceability matrix are build outputs, not documents written beside the build. |
| **R5** | Two moving parts by default. | One Node process and one Postgres container. Everything heavier is behind a named port with a second adapter, so it can be added without a rewrite — and is not added until it earns its keep. |

The existing scaffold at `/Users/adityasingh/PersonalWork/Lotmark App` is consistent with this direction and is **retained**: pnpm workspace, Node 22, TypeScript 5.7 strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, `packages/domain` (permissions, roles, SoD, state machines, signatures, retention, invariants test), `packages/stats` (already stricter than the prototype — it rejects unbalanced designs rather than silently mis-analysing them), and `packages/db` with a **Drizzle** schema, split by domain group, including a keyed `audit_ledger` and an `audit_checkpoints` table. Section 1.4 explains why Drizzle stays.

---

## 1. STACK DECISION

### 1.0 Summary

| Layer | Decision | One-line reason |
|---|---|---|
| Runtime | **Node 22 LTS**, TypeScript 5.7 strict, ESM, pnpm workspaces | One permission vocabulary compiled into the enforcer, the UI and the OpenAPI document — the prototype's best property ("documentation cannot drift from enforcement") becomes a type error |
| HTTP framework | **Fastify 5**, modular monolith | Route `config` gives enumerable guard metadata for free; the hook chain is small enough to read in one sitting |
| **Authorisation placement** | **Called by the application service, not by route middleware** | Jobs, CLI, seed and future non-HTTP surfaces cannot bypass it (R3) |
| Database | **PostgreSQL 17** | RLS, `daterange` + GiST exclusion constraints, recursive CTEs, per-table grants, `pgcrypto`, partitioning, PITR — five load-bearing features, all non-negotiable |
| Query layer | **Drizzle ORM 0.38** (retained) + hand-written SQL migrations | The reviewed schema already exists; RLS, triggers and exclusion constraints stay as readable SQL an assessor can diff |
| Jobs & cron | **pg-boss 10**, separate worker process by default | Transactional outbox for free; a notification enqueued in the certificate-withdrawal transaction cannot be lost |
| Cache / counters | **Postgres only.** No Redis. | Lockouts and rate limits are evidence; anything that must survive a restart is not in Redis |
| Object storage | **Content-addressed local filesystem**, `fs` \| `s3` driver | Zero extra containers; the S3 driver exists so the interface is honest |
| PDF | **Typst** (vendored binary + vendored fonts) → **veraPDF conformance gate** → PDF/A-2b + PDF/UA | Deterministic and byte-reproducible; Chromium is not, and the gate proves the claim rather than asserting it |
| Crypto | SHA-256 chain in-database; **Ed25519** per-tenant record and anchor signatures; **Argon2id** passwords; TOTP with replay cache | Replaces every FNV digest, every keyless binding, and every "any six digits" |
| Tenancy | **Single schema + Row-Level Security + `generation`**, database-per-tenant/region as a deployment topology | Cheapest correct isolation; physical separation stays a connection-string decision |
| API | **REST + OpenAPI 3.1**, RFC 9457 errors, generated typed client | One endpoint = one permission = one audit kind = one OQ test = one RTM row |

### 1.1 Backend language: TypeScript

The prototype's most valuable asset is its policy code — `guard()`, `sodViolation()`, `competentAt()`, `snapshotBasis()`, `basisValid()`, `holdersOf()`, `lotsAffectedByEquipment()`. These **transcribe** into `packages/domain`. A port to another language is a re-derivation, and every re-derivation of regulated logic is a place a behavioural change hides. One language also means the permission union type is imported by the enforcer, by the console (to disable a button) and by the OpenAPI generator — they cannot disagree.

**Rejected — Python/FastAPI + SciPy.** Genuinely tempting for the statistics. Rejected because (a) SciPy is a COTS component you must still qualify under GAMP 5, so you do not skip the reference-dataset work; (b) the six routines total a few hundred lines of closed-form arithmetic, and NIST StRD certified datasets make an owned implementation *more* defensible than an unpinned scientific stack; (c) it splits the permission vocabulary across two languages. Reconsider only if the metrology scope grows to Bayesian consensus or MCMC.

**Rejected — Java/Spring, .NET 9.** Both strong in regulated industries and both would port cleanly from this design. Rejected on localhost footprint, iteration speed, and the loss of the shared-type contract with the frontend.

**Rejected — Go.** Excellent for the public certificate-retrieval service specifically, and a candidate to carve that one endpoint out later. Poor fit for a workflow-heavy domain with 55 tables and eight state machines.

### 1.2 HTTP framework: Fastify 5, not NestJS

The judges were right that Nest's decisive claimed advantage — an enumerable guard chain — is available from a Fastify route registry at a fraction of the ceremony. Route `config` objects are plain data; a boot pass over `app.printRoutes()`-equivalent metadata gives the same endpoint→permission matrix, the same completeness checks, and the same OpenAPI generation, without a DI container, decorators, provider scopes or module metadata.

The cost Nest imposes on a team of one to three is real and the benefit is duplicated. **Fastify, with the guard called from the application service (R3).** Route metadata drives OpenAPI and the boot-time completeness checks; it does not enforce.

### 1.3 Database: PostgreSQL 17, non-negotiable

| Domain requirement | Postgres feature |
|---|---|
| Competence and calibration windows must not overlap for the same subject | `EXCLUDE USING gist (person_id WITH =, activity WITH =, validity WITH &&)` + `btree_gist` |
| "Status as at a past date" for eight dated relations | `daterange` / `tstzrange` with `@>` and GiST indexes |
| Closures 1 and 2 as queries, not application loops | Recursive CTEs, lateral joins |
| Tenant isolation the application cannot forget | Row-Level Security, `FORCE`, non-`BYPASSRLS` app role |
| Append-only ledger the app role cannot rewrite | `REVOKE UPDATE, DELETE` + `BEFORE UPDATE OR DELETE` trigger |
| Digest the application cannot supply | `pgcrypto` inside a `BEFORE INSERT` trigger |
| Job queue and transactional outbox | `SKIP LOCKED`, `LISTEN/NOTIFY` (pg-boss) |
| One released lot per project; one certificate per lot | Partial unique indexes |

**Rejected — SQLite.** No roles, no RLS, no range types, no exclusion constraints. Every guarantee would move back into application code, which is the failure mode being fixed. **Rejected — MySQL/MariaDB** (three of the five load-bearing features absent). **Rejected — document stores** (the closures *are* the product).

### 1.4 Query layer: Drizzle retained, migrations hand-written

`packages/db` already contains a reviewed Drizzle schema across seven files, with an `audit_ledger` carrying a keyed chain link, `key_version` for rotation, structured before/after changes, and an `audit_checkpoints` notarisation table. **Discarding a reviewed artefact is a change-control event requiring an impact assessment nobody has written.** Drizzle stays.

Migrations are **hand-written, numbered, forward-only SQL**. Drizzle Kit may generate a first draft; a human owns the file, because RLS policies, triggers, exclusion constraints and grants are the schema's load-bearing parts and must be diffable by an assessor. Each migration header names the `REQ-` ids it implements and its change-control reference. A runner applies each in a transaction and records `(version, name, sha256, applied_at, applied_by)`; **on boot, a checksum mismatch on an already-applied migration is a hard refusal to start**, because a migration edited after application is a controlled-document violation and must present as an outage.

No down-migrations. Roll forward with a compensating migration.

### 1.5 Jobs: pg-boss, in a separate worker process

The decisive argument is transactional. `withdrawCertificate` must mark the issue, mark the lot, and notify every holder of every issue — atomically enough that a crash cannot leave a withdrawn certificate whose holders were never told. With pg-boss the job insert is in the *same transaction* as the state change.

**The worker is a separate process by default** (`apps/worker`), not `WORKERS=inline`. PDF renders, retention sweeps and nightly chain verification do not belong in the request process. `WORKERS=inline` remains available as a single-process demo mode.

**Rejected — BullMQ/Redis** (dual-write problem, second durability model, desynchronised restore). **Rejected — Temporal** (right eventually for multi-month CAPA effectiveness checks; a second stateful cluster today). Job payloads are shaped so a Temporal migration is possible.

### 1.6 No Redis

The prototype's `RL={}`, `FAILS={}`, `LOCKS={}` were page-local objects wiped by reload. The naive fix is Redis; it is rejected because **a lockout is evidence** (SEC-13 in the prototype's own control register) and a lockout a restart clears reinstates the exact defect. Rate-limit windows and lockout counters live in Postgres (`rate_limit_event`, `account_lockout`) behind a `throttle(key, max, window)` function. Step-up tokens live in Postgres so they are consumed inside the business transaction.

Postgres carries hundreds of producer tenants and 1,341 SKUs comfortably. `RateLimiter` and `JobQueue` are ports with a second adapter each, so Redis is a measured upgrade, not a habit.

### 1.7 Object storage: content-addressed filesystem

A `blob` table (`blob_id`, `sha256`, `size`, `media_type`, `tenant_id`, `retention_class`, `legal_hold`) and bytes at `var/blobs/<tenant>/<aa>/<bb>/<sha256>`, written `temp → fsync → rename`. The digest is recorded on the owning record, satisfying ALCOA+ "Original" and making tamper detection free. Driver interface: `fs` (default) and `s3` (`@aws-sdk/client-s3`, for MinIO or a bucket with Object Lock later). **MinIO is not in the compose file.** Blobs are served only through a permission-checked, read-audited endpoint.

### 1.8 PDF: Typst, with a conformance gate

`typst compile` as a subprocess (~30 MB, vendored under `vendor/typst/` for air-gap). Templates are a **block model in `jsonb`** compiled to Typst source; both the block model and the generated source are SHA-256'd into `certificate_template_version`.

**The judges' fatal finding is repaired:** PDF/A-2b and PDF/UA are **not asserted**. The render job runs `veraPDF` against the PDF/A-2b and PDF/UA-1 profiles and **fails the job on non-conformance**. Where Typst's output needs post-processing to conform (tagging, output intent, XMP), Ghostscript runs as a vendored post-step and veraPDF re-validates. A claim without a check is exactly what this architecture exists to remove.

**Rejected — headless Chromium.** ~400 MB, output that shifts between builds and font stacks, no defensible byte-reproducibility claim over a ten-year retention period. **Rejected — LaTeX** (toolchain weight). **Rejected — `@react-pdf`/`pdfmake`** (no layout engine, no PDF/A path).

### 1.9 Cryptography

| Purpose | Prototype | Decision |
|---|---|---|
| Audit chain digest | `h32` — 32-bit FNV | **SHA-256**, computed in a `BEFORE INSERT` trigger over a **length-prefixed** canonical payload including `seq` and `tenant_id` |
| Record signature (§11.70) | `h64` — keyless 64-bit FNV | **Ed25519 detached signature** over canonical material, per-tenant key. **Asymmetric, so an assessor or customer can verify with the public key alone** |
| Anchor signature | none | **Ed25519**, key held by a **separate signer process with its own credentials** (§4.5) |
| Password hashing | 2,000 FNV rounds, deterministic salt | **Argon2id** (`@node-rs/argon2`), m=64 MiB, t=3, p=1, 16-byte CSPRNG salt, pepper from `KeyService` |
| MFA | "any six digits but 000000" | **TOTP** RFC 6238, ±1 step, **used-(person, step) replay cache in Postgres**, encrypted secret, hashed recovery codes |
| Timestamping | none | Interface present; localhost emits a clearly-marked **development timestamp**. RFC 3161 TSA is a production adapter. **No PAdES profile is claimed** (§8.3) |
| Key custody | none | `KeyProvider` port: `file` (dev, KEK from env), `pkcs11` (HSM), `vault-transit`. Custody class is a first-class field (§8.5) |

---

## 2. HOW IT RUNS ON LOCALHOST

### 2.1 Topology — three processes, one container

```
┌──────────────────────────────────────────────────────────────┐
│ node apps/api            https://lotmark.localhost:4000      │
│   ├ /api/v1/**          console + storefront REST            │
│   ├ /public/v1/**       unauthenticated certificate/unit API │
│   ├ /verify/:token      server-rendered, NO JavaScript, print│
│   └ /*                  static web build (demo mode)         │
├──────────────────────────────────────────────────────────────┤
│ node apps/worker         pg-boss consumers + cron            │
│   └ spawns vendor/typst, vendor/veraPDF for render jobs      │
├──────────────────────────────────────────────────────────────┤
│ node apps/signer         anchor signer. Own OS user, own key.│
│   └ unix socket var/run/signer.sock — NOT reachable by api   │
└──────────────────────────────────────────────────────────────┘
        │ pg (host 5433 → container 5432)
┌───────▼──────────────────────────────────────────────────────┐
│ postgres:17-alpine  (docker, pinned by digest, named volume) │
│   pgcrypto · btree_gist · pg_trgm                            │
└──────────────────────────────────────────────────────────────┘

dev only, additionally:  vite :5173 (console)  ·  vite :5174 (storefront)
```

**Docker for Postgres only; native Node for application processes.** Postgres in Docker is pinned **by image digest, not tag** — that pin is IQ evidence. Native Node gives a debugger that attaches, sub-second reload, and no bind-mount file-watching pain. Host port 5433 so it never fights a local 5432.

The **signer is a third process** because the judges correctly identified that an anchor key sitting in `var/keys/` under a KEK from the API's own environment adds nothing against the adversary it exists to defeat. It runs as a different OS user, owns the anchor key, exposes only `sign(root) → signature` over a unix socket with filesystem permissions the API user does not hold, and is the localhost analogue of an HSM. Its `KeyProvider` adapter swaps to PKCS#11 unchanged.

### 2.2 One-command startup

```
make dev        # postgres up --wait → migrate (checksum-verified) → seed if empty
                # → api + worker + signer + two vite servers → print URL table
make demo       # build web → api(+inline worker)+signer, seeded, demo clock, open browser
make reset      # retire the demo tenant generation and reseed (§2.5)
make verify     # every runtime invariant + full chain + anchor verification
make check      # typecheck · lint · boundaries · unit · integration · e2e · a11y
make validation # signed IQ/OQ/PQ evidence pack + generated RTM
make doctor     # prerequisite check, one fix line per missing item
make bundle     # repo + node_modules + pinned image + typst + veraPDF + fonts → tarball
```

First `make dev` additionally runs `mkcert -install && mkcert lotmark.localhost` (so `__Host-` cookies, `Secure` and HSTS behave exactly as in production), vendors Typst and veraPDF if absent, and generates a development Ed25519 keypair into the signer's private directory.

`make doctor` is the difference between a one-command promise and a one-command claim: it checks Node, pnpm, Docker, mkcert, disk, ports, and the vendored binaries, and prints an exact fix line for each failure.

### 2.3 Seed data — executed, never asserted

**The seed performs the acts through the real application services under a simulated clock. It does not insert end states.** A seed that cannot be produced by the application's own workflows is a seed that hides defects — precisely what the prototype's boot-time `backfill-historic-signatures` patch existed to paper over, and precisely the class of bug that let `PV-01`/`PV-02` exist as authorised values with no signature and no competence basis.

Three packs:

| Pack | Contents |
|---|---|
| `minimal` | Reference data only: 28 permissions, 9 roles, retention classes, security controls, storage classes, one tenant, one admin. What real first-boot provisioning does. |
| `demo` | The prototype's exact estate, produced by executing it: two tenant profiles (`t-generic`, `t-ipc`), three organisations, nine users, four projects, thirteen studies with raw result rows, three property values, four lots, two certificates, three orders, logger traces, the facility excursion, `NCR-0231`. |
| `scale` | Generated: 1,341 SKUs, five-generation lot chains, 20,000 orders, 5M ledger entries. The target for performance work and closure-query timing. |

The `demo` pack preserves every deliberate trap, because each is a regression fixture:

- **Sunil's `study:sign` competence expiring 2026-06-30** — a permanent DENY fixture proving competence is checked at time of act.
- **EQ-02's calibration gap after 2026-05-31** → ST-1013 measured outside cover → CRT-2042 exposed. The Closure-1 fixture.
- **PRJ-0414's draft characterisation study** → incomplete budget → `Assign` blocked.
- **A synthetic `msB < msW` homogeneity dataset** — the prototype has none, so its floored `u*(bb)` branch was never exercised, and was wrong.

The frozen clock is preserved properly. `ClockService` is a port; `SimulatedClock` **refuses to construct unless `LOTMARK_ENV=demo`**, and every ledger entry and signature it touches is stamped `clock_source = 'simulated'`. Demo data is therefore permanently and visibly distinguishable from validated data. Business logic never reads `Date.now()`.

### 2.4 Offline operation

A hard requirement (NIC/MeitY), and cheap if held from day one.

- **Fonts self-hosted** — Inter, IBM Plex Mono, Noto Sans Devanagari, vendored and hashed. The prototype's `fonts.googleapis.com` links are fatal in an air-gapped deployment and a DPDP third-party-call problem.
- No CDN scripts, no telemetry egress, no error-reporting SaaS.
- Typst, veraPDF and the Postgres image are vendored/pinned; `make bundle` produces an installable tarball.
- Notifications go to a **local outbox** with an in-app Outbox screen. SMTP/SMS/webhook are drivers behind the same outbox.
- **A CI job runs the full e2e suite with network egress blocked at the namespace.** If it fails, something acquired an internet dependency. Offline is a test, not a discipline.

### 2.5 Reset-to-seed — generation retirement, never truncation

The prototype's `resetDemo()` discards the ledger and audits the discard *in the ledger it just discarded*. The replacement is generation retirement:

- `POST /api/v1/admin/tenants/{id}/reset` exists only when `LOTMARK_ENV=demo`, requires `tenant:reset`, requires a step-up signature and a typed confirmation of the tenant name, and is **refused by a database CHECK constraint** unless `tenant.environment_class = 'demo'`.
- It does not delete. It increments `tenant.generation`, stamps `retired_at` on the outgoing generation, and seeds a fresh one. Every RLS policy includes `generation = app.generation()`, so the reset is a clean slate to every user while nothing is destroyed.
- The reset is one more entry in the same unbroken ledger, citing the retired generation and its final chain head and anchor. **Chain verification passes across the boundary.**

This costs one integer column, one extra predicate per policy, and retired rows that accumulate in demo tenants only (a `retention.purge-retired-generations` job reclaims them after 90 days). It buys the ability to demo a reset in front of an assessor without explaining why a tamper-evident ledger has a delete button. `environment_class` is `demo | validation | production`; **`demo → validation` promotion is prohibited** (a demo tenant carries simulated-clock entries), but `validation → production` is permitted, which preserves a trial-to-paid path for real tenants provisioned as `validation`.

---

## 3. BACKEND ARCHITECTURE

### 3.1 Repository layout

```
apps/
  api/                  HTTP surface: routes, schemas, guard metadata, OpenAPI,
                        problem+json, the /verify SSR page
  worker/               pg-boss consumers, cron registrations, render jobs
  signer/               anchor signer. Separate OS user, separate key custody.
  console/              producer SPA
  storefront/           customer SPA
packages/
  domain/     ✓ exists  PURE. permissions, roles, SoD grammar, state machines,
                        signature material canonicalisers, ID/format rules,
                        retention classes, invariants. No I/O, no clock.
  stats/      ✓ exists  PURE. anova, regress, consensus, combine, coverage, round.
                        Versioned. Zero dependencies.
  db/         ✓ exists  Drizzle schema, hand-written SQL migrations, repositories,
                        RLS helpers, generated types
  core/                 Ports & services: Clock, Audit, Signing, Keys, Numbering,
                        Storage, Notification, Computation, Renderer, RateLimiter
  contracts/            Zod schemas + generated OpenAPI 3.1 + generated TS client
  ui/                   Design system, DataTable, SignatureDialog, AsOfControl, Can
  i18n/                 ICU catalogues EN/HI
  seed/                 typed fixture *scripts* that execute use cases
  conformance/          requirements registry, invariant suite, RTM + IQ/OQ generators
  testkit/              testcontainers harness, matchers, fixtures
modules/                mirrors the prototype's MODS groups (§3.2)
```

`eslint-plugin-boundaries` enforces the dependency graph in CI: `domain` and `stats` import nothing with I/O; `db` may import `domain`; `core` may import `domain` + `db`; modules import `core` and other modules' `ports/index.ts` only, never their internals, never circularly. A new cross-module edge that is not declared fails the build. This is the structural answer to the prototype's own recorded fork, which produced "fourteen duplicated infrastructure functions and two incompatible permission vocabularies" inside one working session.

### 3.2 Module map — prototype `MODS` → backend module → frontend route

| MODS group | Prototype module | Backend module | Owns (primary tables) | Console route |
|---|---|---|---|---|
| **Production** | `projects` | `production/projects` | `project`, `project_stage_history`, `candidate_material`, `process_step`, `packaging_run` | `/console/projects`, `/console/projects/$id` |
| | `studies` | `production/studies` | `study`, `study_equipment`, `study_result`, `characterisation_lab`, `outlier_exclusion`, `monitoring_point` | `/console/studies`, `/console/studies/$id` |
| | `values` | `production/values` | `property_value`, `property_value_version`, `uncertainty_component` | `/console/values` |
| | `authorise` | `production/values` | (same aggregate, distinct use cases) | `/console/authorise` |
| | `lots` | `certification/lots` | `lot`, `unit`, `catalogue_listing` | `/console/lots` |
| **Certification** | `certs` | `certification/certificates` | `certificate`, `certificate_issue`, `certificate_template`, `certificate_template_version`, `certificate_issue_diff` | `/console/certificates`, `/console/certificates/$id` |
| **Distribution** | `catalogue` | `distribution/catalogue` | `catalogue_listing` (view), `price`, `price_tier`, `search_event` | `/console/catalogue` |
| | `orders` | `distribution/orders` | `order`, `order_line`, `order_state_history`, `cart_line`, `vault_holding` | `/console/orders`, `/console/orders/$id` |
| | `entitlement` | `distribution/entitlements` | `entitlement` | `/console/entitlement` |
| | `dispatch` | `distribution/dispatch` | `shipment`, `logger_reading`, `excursion` | `/console/dispatch` |
| **Compliance** | `conformance` | `compliance/conformance` | clause predicate views, `assessment_pack` | `/console/conformance` |
| | `monitoring` | `production/studies` | `monitoring_point` | `/console/monitoring` |
| | `retention` | `compliance/retention` | `retention_class`, `retention_binding`, `legal_hold`, `erasure_request`, `consent` | `/console/retention` |
| | `equipment` | `compliance/equipment` | `equipment`, `calibration`, `facility`, `facility_lot` | `/console/equipment` |
| | `competence` | `compliance/competence` | `competence_authorisation`, `competence_basis`, `permission_competence_map` | `/console/competence` |
| | `subs` | `compliance/subcontractors` | `subcontractor`, `subcontracted_activity` | `/console/subcontractors` |
| | `capa` | `compliance/capa` | `capa`, `capa_action`, `capa_state_history` | `/console/capa` |
| | `audit` | `platform/audit` | `audit_entry`, `audit_anchor` | `/console/audit` |
| **Platform** | `trace` | `compliance/trace` | *no tables* — closure queries only | `/console/trace` |
| | `security` | `platform/security` | `security_control`, read-only registers | `/console/security` |
| | `build` | `conformance` (package) | *no tables* — live invariant results | `/console/build` |
| | `tenant` | `platform/tenancy` | `tenant`, `tenant_setting`, `numbering_series`, `tenant_out_of_scope` | `/console/tenant` |
| | `users` | `platform/identity`, `platform/governance` | `person`, `credential`, `role`, `permission`, `role_permission`, `person_role`, `session`, `mfa_secret`, `sod_rule`, `sod_rule_change` | `/console/users`, `/console/sod-rules` |
| — | *(new)* | `platform/notifications` | `notification`, `notification_outbox`, `delivery_receipt` | `/console/outbox` |
| — | *(new)* | `platform/blobs` | `blob` | *(embedded)* |
| — | *(new)* | `platform/integrations` | `integration`, `integration_run` | `/console/integrations` |

**Storefront routes:** `/shop`, `/shop/$lot`, `/cart`, `/orders`, `/orders/$id`, `/vault`, `/vault/scan`, `/account`.
**Public routes (no auth, server-rendered where noted):** `/verify/:token` *(SSR, no JS)*, `/public/v1/certificates/:number`, `/public/v1/units/:qrToken`.

### 3.3 Layering inside a module

```
routes/      HTTP only. Zod parse → call use case → map to DTO.
             Declares { permission, competence, subject, signature, concurrency }
             as METADATA for OpenAPI + boot checks. Does NOT enforce.
usecases/    The transaction boundary. Calls policy.guard() ITSELF (R3).
             One public method per act, named for the act.
domain/      Pure. State machines return discriminated results, never throw.
repositories/ Drizzle. Optimistic concurrency. Tenant predicate is RLS's job.
ports/       What other modules may call. Interfaces and DTOs only.
```

A lint rule forbids importing a repository from a route file. `canTransition(study, 'signed')` being a pure function is what removes the prototype's most common defect class — `signStudy` never asserting the prior state was `draft`.

### 3.4 The unit of work

Exactly one place opens a transaction:

```
unitOfWork.run(ctx, async (tx) => { ... })
```

It: begins; `SET LOCAL app.tenant_id`, `app.generation`, `app.person_id`, `app.session_id`, `app.correlation_id`, and `app.as_of` **on read-only requests only**; executes; writes the ledger entries queued during the transaction (so an audit entry cannot commit without its business fact, nor the reverse); flushes outbox rows; commits.

`SET LOCAL` exclusively — never `SET` — so a pooled connection cannot leak a GUC. Every repository method takes `tx`; there is no ambient pool.

**Denials are asymmetric and durable.** A `DENY` must be recorded even though the business transaction aborts. Rather than a fire-and-forget second transaction (which loses the record on a crash between rollback and commit), denials are written to a **separate `denial_ledger` with its own per-tenant chain**, in an autonomous transaction opened *before* the business transaction rolls back, with the intent pre-written and confirmed. The denial chain is anchored alongside the main chain. This keeps `audit_entry.seq` strictly gapless with a single writer, and makes a refusal recoverable rather than best-effort.

### 3.5 The guard chain

One ordered pipeline, one implementation, called from the use case. Message strings are kept byte-identical to the prototype so OQ scripts read like the UX.

```
 1. authenticated?              401 UNAUTHENTICATED       DENY "Unauthenticated action blocked"
 2. session valid, not idle?    401 SESSION_EXPIRED       AUTH
 3. tenant + generation match?  404 NOT_FOUND             DENY (real subject server-side only)
 4. permission held?            403 PERMISSION_DENIED     DENY "Permission denied"
 5. SUBJECT RESOLVED            (mandatory — see below)
 6. SoD rule violated?          403 SOD_VIOLATION         DENY "Segregation of duties violation blocked"
 7. competence at act time?     403 COMPETENCE_LAPSED     DENY "Competence check failed"
 8. step-up token valid?        428 SIGNATURE_REQUIRED    SECURITY
 9. If-Match version matches?   412 VERSION_CONFLICT      CONFLICT
10. state transition legal?     409 STATE_CONFLICT        —
```

Four boot-time assertions, each fixing a named prototype defect:

1. **Every SoD rule — enabled *or* disabled — whose `action` names a permission must have at least one registered use case supplying a `subject` loader carrying that rule's `field`.** Otherwise the process refuses to start. (A disabled rule can be enabled at runtime, so the check must cover both.) This is the fix for `sodViolation()` failing open when no record is passed, which made SoD-3 and SoD-4 unenforceable even when enabled.
2. **Every defined permission is enforced by at least one use case.** This catches `lot:create` — defined, granted to Production Lead, guarded nowhere, because `createLot()` guards `lot:release`.
3. **Every mutating use case declares a permission.**
4. **Every enabled SoD rule's `field` exists as a column on the subject's table.** SoD-4 was unenforceable because `lots` had no `by` column; `lot.created_by` now exists.

The SoD grammar is richer than `field ≠ actor`: `field_not_actor`, `n_eyes(n)`, `role_disjoint(roles)`, `not_same_actor_across_steps(step_a, step_b, subject)`. Rules are **effective-dated rows** with `created_by`, `approved_by` (dual control), a mandatory `disable_reason`, and an optional auto-expiry. There is no god-role: `tenantadmin`'s `Object.keys(PERMS)` grant is replaced by scoped admin roles plus time-boxed, justified break-glass elevation.

### 3.6 The competence service

Preserved almost verbatim — it is the best thing in the prototype — with four corrections:

- Competence is evaluated at **server act time** from `ClockService`, never a client date and never a frozen constant, and never from `app.as_of`.
- The **basis snapshot is written in the same transaction as the signature** and is append-only. A later correction cannot retroactively validate or invalidate a past act.
- A **`permission_competence_map` table** replaces the ad-hoc `{competence: 'cert:issue'}` argument, which is how `cert:reissue` ended up checking `cert:issue` competence by accident rather than by policy.
- A **`competence.reverification` job**: on any correction to a competence record, recompute `basisValid` for every historic signature it backs and **auto-raise a CAPA** if a past act loses its backing. ISO 17034 §6.3 requires you to notice; immutability alone is not enough.

Plus `competence.expiry-horizon` (90/60/30-day warnings).

### 3.7 The signing service — sole writer of signatures

```
POST /api/v1/signing-challenges { subjectType, subjectId, subjectVersion, intent }
  → 201 { challengeId, componentsRequired: ['password','totp'] | ['totp'],
          meanings: [...], expiresAt }
POST /api/v1/signing-tokens     { challengeId, password?, totp, meaning }
  → 201 { signingToken, expiresAt }   // opaque 256-bit, 120 s, single use
```

The token is bound to `{sessionId, personId, subjectType, subjectId, subjectVersion, sha256(purpose), meaning}` and stored **hashed** in Postgres. The mutating request presents it in `X-Signing-Token`; the guard consumes it with `DELETE ... RETURNING` **inside the business transaction**, so replay is impossible and a rolled-back transaction leaves it unused (it expires). A token minted for ST-1001 v3 cannot sign ST-1001 v4 or ST-1002.

Session logic per §11.200(a)(1): both components on the first signing of a continuous session, one thereafter, **10-minute rolling window with a 60-minute absolute cap** — the prototype refreshed the window on every signing indefinitely. **The 60-minute floor is a code constant, not a settings row**, so it cannot be configured downward.

**Signed material — the prototype's most consequential defect.** `materialOf('study', r)` bound `rec.u`, a vestigial field no computation reads, and did **not** bind `DB.results[st.id]`, the sole input to every certified number. Editing a raw result silently moved the assigned value and U while every signature still verified. Corrected canonical material, RFC 8785 JCS-canonicalised then **length-prefixed** (a `|` inside `meta` forges a field boundary in the prototype's `join('|')`):

```
study  : study_id, project_id, type, sorted(equipment_ids),
         sha256(canonical(ordered study_result rows)),
         sha256(canonical(frozen uncertainty_components)),
         stats_engine_version
value  : value_id, project_id, property, value, unit, k, df_eff, u_combined,
         u_expanded, sha256(canonical(component set)), traceability_statement
issue  : certificate_id, lot_id, issue_no, value, U, k, df_eff,
         template_version_id, data_snapshot_digest
```

Signature: **Ed25519 detached**, per-tenant key, `key_version` recorded so an old signature verifies after rotation. Asymmetric, so **a customer, an assessor or a court can verify from the exported artefact plus the published public key with no database access** — an executable test (§9.3), not a claim.

All six signature-bearing acts route through this service: sign study, assign value, authorise value, issue certificate, reissue certificate, **withdraw certificate**. The prototype left withdrawal unsigned despite it being the act that tells a customer to stop using material in their GMP process, and `authoriseValue()` and `reissue()` stamped a §11.50 meaning and a §11.70 binding with **no ceremony at all**. Here that is impossible: `signature` is `INSERT`-only, granted to one role, held by one service.

### 3.8 The audit chain service

Thin, because enforcement is in the database (§4.4). Its API is `audit.append(tx, {kind, action, subject, before, after, meta})` — it takes the transaction handle, so an audit entry cannot be written outside the business transaction it describes, and a failed audit write fails the business write. There is no `update`, no `delete`, and no `tamper()`.

`before`/`after` capture the changed columns as `jsonb`, with PII stored as a hash plus a reference rather than cleartext. The prototype recorded an action sentence, which is a §11.10(e) shortfall — "shall not obscure previously recorded information".

### 3.9 The metrology service

`packages/stats` is pure, dependency-free, semver'd, and its version is recorded on every persisted component. Every blocking defect the analysis found is a named fix with a named test:

| Prototype defect | Fix |
|---|---|
| Floored `u*(bb)` uses `(a−1)(n−1)`; must be `ν_MSw = a(n−1)`. +4.7% at 6×2, +19% at 2×2 | Correct df. Property test asserts the floor equals `(s_w/√n)·⁴√(2/ν)` |
| Unbalanced designs: `reps` taken from group 0 | Effective replication `n₀ = (N − Σnᵢ²/N)/(a−1)` |
| **`k=2` hardcoded, no df anywhere; every seeded U understates its interval** (t₀.₉₇₅,₄ = 2.776) | Every routine returns `df`; `combine` returns `df_eff` by Welch–Satterthwaite; `coverage` returns t-based `k`. `k` and `df_eff` are printed on the certificate |
| `significant` compares to a fixed 2, not `t₀.₉₇₅,ₙ₋₂`; a significant slope has no consequence | Correct critical value; a significant slope **blocks value assignment** until a signed disposition is recorded |
| No outlier detection | Cochran + Grubbs (ISO 5725-2) run automatically; exclusion requires a **mandatory justification** and is itself a signed, audited act |
| No `u(sts)`; 3-term budget for a 4-term design | Short-term/transport stability is a first-class study type |
| One lab → `u(char)=0`, `complete=true` → certificate hazard | `df < 1` returns `null`; budget incomplete; issue blocked |
| `budget()` returns non-null `uc` from partial components, rendered as real | **`uc` is `null` unless complete.** There is no partial combined uncertainty |
| Horizon from the *signature* date, 30-day months, clamped ≥1, defaulting to 24 | Horizon = `shelf_end − t₀` in calendar months from the series origin. No default, no clamp, expired → typed error |
| `components()` regenerated on render — a 2026 certificate re-renders with 2027's basis | `uncertainty_component` is persisted, append-only, digest-covered, frozen at value assignment |
| Confirmatory retest counted in `components()` but ignored by `budget()` | One eligibility rule in one place, with a test that the two views cannot diverge |
| Double rounding of the certified value | `round(value, U)` implements GUM §7.2.6 **once**: U to two significant figures, value to U's decimal place. Stored `numeric` with explicit `decimal_places` |

`ComputationService` orchestrates: reads raw rows, calls pure functions, **persists** components with `stats_engine_version`, `input_digest` and `computed_at`. A `components.staleness-scan` job raises a review when raw data changes after issue. `pnpm stats:approve` is the **only** way to regenerate regression fixtures, and it bumps `STATS_ENGINE_VERSION` — a change to a certified number cannot be a refactor side effect.

### 3.10 The clock service

Two axes, explicitly separated, because the prototype conflates them and ALCOA+ "Contemporaneous" fails as a result:

- **System time** — `now()` from the server, `timestamptz` UTC, monotonic sequence for ordering. `SimulatedClock` only in `LOTMARK_ENV=demo`, stamping `clock_source='simulated'`.
- **Effective date** — the business date an act is deemed to occur. Normally equal to system time. Backdating is a separately permissioned, separately signed, separately audited act with a mandatory reason, and **can never precede the last anchored segment**.

NTP integrity is measured, not labelled: chrony syncs to the tenant's configured source (`samay1.nic.in` for an India-region tenant); the API **measures** offset and stratum, records both on every ledger entry and signature, and **refuses to mint a signing token when offset exceeds threshold**. The prototype's `TIME_SOURCES` is a string nothing queries.

### 3.11 Background jobs

Every job writes its execution to the ledger and is idempotent by key.

| Job | Cadence | Replaces |
|---|---|---|
| `ledger.anchor` | every 5 min / 10k entries | nothing |
| `ledger.verify-incremental` | hourly | a button on the Audit screen |
| `ledger.verify-full` | nightly | — |
| `certificate.render` | queue | inline PDF generation (see §8.4) |
| `monitoring.due-scan` | daily | render-time `monitoringDue()` |
| `expiry.notify` | daily, T-180/90/60/30/0 | manual `pushExpiryNotices()`, which re-sent on every press |
| `entitlement.revalidation-hold` | daily | `reval` was set and never read |
| `calibration.expiry-horizon`, `competence.expiry-horizon`, `subcontractor.expiry-horizon` | daily | chips on a screen |
| `competence.reverification` | on correction | nothing |
| `subcontractor.lapse-impact` | on lapse | flags every lot that relied on them since |
| `capa.overdue-escalation` | daily | no due dates existed |
| `retention.evaluate` (dry-run) / `retention.purge` (manually released) | weekly / monthly | a table of prose |
| `outbox.dispatch` | continuous | `DB.notifs.unshift()` |
| `outbox.reconcile` | daily | asserts every withdrawal has a dispatched notice per holder org |
| `components.staleness-scan` | daily | render-time recomputation |
| `blob.digest-verify` | weekly | nothing |
| `backup.verify` | nightly | nothing |
| `retention.purge-retired-generations` | monthly, demo tenants | — |

---

## 4. DATA LAYER

### 4.1 Conventions

- `tenant_id uuid NOT NULL REFERENCES tenant` and `generation int NOT NULL` on **every** business table. RLS enabled and **forced** on every one.
- Surrogate PK `uuid` (UUIDv7, time-ordered) plus a separate **business key** where one exists, `UNIQUE (tenant_id, business_key)`.
- `created_at/by`, `updated_at/by` everywhere. `version bigint NOT NULL DEFAULT 1` on every table with a state machine.
- Postgres `ENUM` types (they appear in `\d` output — IQ evidence). Added to, never reordered.
- **Money:** `bigint` minor units + `char(3)` currency. Never a float.
- **Certified values and uncertainties:** `numeric` with an explicit `decimal_places` derived once by the GUM rule. Computation happens in double precision inside `packages/stats`; storage is the reported quantity, rounded once.
- **Temperature and duration:** numeric with units in the column name (`peak_celsius`, `duration_minutes`). The prototype's `'14.2 °C'` and `'9 h'` strings are unqueryable.
- **PII classification:** `COMMENT ON COLUMN ... IS '@pii:contact'` generates a single registry driving serialiser redaction, log-pipeline redaction, and the retention/erasure engine. Declared once, applied in three places.

Markers used below: **[A]** append-only · **[T]** temporal validity range · **[V]** optimistic-lock `version` · **[H]** has a state-history child.

### 4.2 Full schema

#### Platform & identity

| Table | Key columns | Markers |
|---|---|---|
| `tenant` | `tenant_id PK`, `key UNIQUE`, `name`, `short_name`, `compliance_frame`, `data_region`, `time_source`, `environment_class ENUM(demo,validation,production)`, `generation int`, `bilingual bool`, `adr bool`, `publications bool`, `gov_tier bool` | [V] |
| `tenant_setting` | `tenant_id FK`, `key`, `value jsonb`, `valid_from`, `valid_to`, `changed_by`, `approved_by`, PK(tenant,key,valid_from) | [T][A] |
| `tenant_out_of_scope` | `tenant_id FK`, `item`, PK(both) | |
| `numbering_series` | `series_id PK`, `tenant_id FK`, `kind ENUM`, `template`, `next_seq bigint`, `pad_width`, `fiscal_year_start`, `reset_policy`, `imported_from bigint` | |
| `organisation` | `org_id PK`, `tenant_id FK`, `name`, `kind ENUM(producer,customer)`, `type`, `accreditation_body`, `accreditation_no`, `scope`, `phone_enc bytea @pii:contact`, `default_tier_id FK` | [V] |
| `person` | `person_id PK`, `tenant_id FK`, `org_id FK`, `full_name`, `email CITEXT`, `avatar_colour`, `status`, `locale`, UNIQUE(tenant,email) | [V] |
| `credential` | `person_id PK/FK`, `argon2_hash`, `params jsonb`, `pepper_key_version`, `rotated_at`, `breached_checked_at` | |
| `mfa_secret` | `person_id PK/FK`, `secret_enc bytea`, `key_version`, `enrolled_at`, `recovery_codes_hash[]` | |
| `mfa_step_used` | `person_id FK`, `step bigint`, `used_at`, PK(both) | [A] |
| `permission` | `permission_key PK`, `description`, `object`, `verb` | reference |
| `role` | `role_id PK`, `tenant_id FK`, `key`, `name`, `kind ENUM(producer,customer)` | |
| `role_permission` | `role_id FK`, `permission_key FK`, PK(both) | |
| `person_role` | `person_id FK`, `role_id FK`, `validity daterange`, PK(person,role,lower(validity)); `EXCLUDE (person_id =, role_id =, validity &&)` | [T] |
| `permission_competence_map` | `permission_key PK/FK`, `required_activity FK→permission` | reference |
| `session` | `session_id PK`, `token_hash`, `person_id FK`, `tenant_id FK`, `created_at`, `last_activity_at`, `absolute_expiry`, `ip`, `user_agent`, `revoked_at`, `end_reason`, `signing_session_started_at` | [T] |
| `signing_challenge` | `challenge_id PK`, `session_id FK`, `subject_type`, `subject_id`, `subject_version`, `purpose_hash`, `components_required[]`, `expires_at` | |
| `signing_token` | `token_hash PK`, `person_id`, `session_id`, `subject_type`, `subject_id`, `subject_version`, `purpose_hash`, `meaning`, `expires_at` | consumed by DELETE |
| `rate_limit_event` | `key`, `occurred_at`, index on both | |
| `account_lockout` | `key PK`, `locked_until`, `failure_count`, `escalation_level` | |
| `sod_rule` | `rule_id PK`, `tenant_id FK`, `code`, `guarded_permission FK`, `grammar ENUM`, `conflicting_field`, `params jsonb`, `owner_role`, `message`, `validity daterange`, `enabled bool`, `disable_reason`, `auto_expire_at` | [T][A] |
| `sod_rule_change` | `change_id PK`, `rule_id FK`, `proposed_by`, `approved_by`, `reason`, `applied_at`, `audit_seq` | [A] |
| `security_control` | `ref PK`, `control`, `driver`, `status`, `demo_hook` | reference |

#### Ledger

| Table | Key columns | Markers |
|---|---|---|
| `audit_entry` | `tenant_id FK`, `seq bigint`, PK(tenant,seq), `generation`, `occurred_at timestamptz`, `actor_id FK`, `role_id FK`, `kind audit_kind`, `action text`, `subject_type`, `subject_id`, `before jsonb`, `after jsonb`, `meta jsonb`, `correlation_id`, `clock_source`, `clock_offset_ms`, `region`, `prev_hash bytea`, `hash bytea` — **PARTITION BY RANGE (occurred_at)** | [A] |
| `denial_ledger` | same shape, own per-tenant chain, own anchors | [A] |
| `audit_anchor` | `anchor_id PK`, `tenant_id FK`, `ledger ENUM(audit,denial)`, `from_seq`, `to_seq`, `merkle_root bytea`, `prev_anchor_hash`, `signature bytea`, `signer_key_id`, `key_version`, `tsa_token bytea NULL`, `timestamp_class ENUM(development,rfc3161)`, `created_at` | [A] |
| `audit_head` | `tenant_id PK`, `ledger`, `seq`, `hash` | maintained by trigger |
| `signature` | `signature_id PK`, `tenant_id FK`, `subject_type`, `subject_id`, `subject_version`, `signed_by FK`, `signed_at timestamptz`, `effective_on date`, `meaning ENUM`, `material_canonical bytea`, `material_digest bytea`, `algorithm`, `key_version`, `sig bytea`, `time_source`, `clock_offset_ms`, `clock_source`, `region`, `basis_id FK` | [A] |
| `competence_basis` | `basis_id PK`, `tenant_id`, `competence_id FK`, `person_id FK`, `activity`, `valid_from`, `valid_to`, `checked_on`, `checked_at timestamptz` | [A] |

#### Production

| Table | Key columns | Markers |
|---|---|---|
| `project` | `project_id PK`, `tenant_id`, `code UNIQUE(tenant)`, `material_name`, `cas_number`, `sku_prefix`, `stage ENUM`, `owner_person_id FK`, `min_intake`, `target_uncertainty`, `intended_use`, `material_class`, `traceability_route`, `unit_size`, `planned_units` | [V][H] |
| `project_stage_history` | `project_id FK`, `from_state`, `to_state`, `at`, `by`, `version`, `audit_seq`, `signature_id` | [A] |
| `candidate_material` | `material_id PK`, `project_id FK`, `supplier`, `supplier_batch`, `received_on`, `qty_received`, `purity_claimed`, `receipt_condition`, `quarantine_state` | [V] |
| `process_step` | `step_id PK`, `project_id FK`, `seq`, `step_name`, `method`, `equipment_id FK`, `operator_person_id FK`, `performed_at timestamptz`, `note`, `record_blob_id FK` | |
| `packaging_run` | `run_id PK`, `project_id FK`, `container_type`, `fill_qty`, `units_filled`, `fill_order_recorded bool` | |
| `study` | `study_id PK`, `tenant_id`, `code UNIQUE(tenant)`, `project_id FK`, `study_type ENUM(homogeneity,long_term_stability,short_term_stability,characterisation,confirmatory_retest)`, `design jsonb`, `t0_date`, `state ENUM(draft,signed)`, `signed_by FK`, `signed_at`, `signature_id FK`, `basis_id FK`, `shelf_life_to`, `storage_class_id FK`, `transport_class_id FK`, `slope_disposition jsonb` | [V][H] |
| `study_equipment` | `study_id FK`, `equipment_id FK`, PK(both) | |
| `study_result` | `result_id PK`, `study_id FK`, `unit_no`, `replicate_no`, `timepoint_months`, `laboratory_id FK`, `value numeric`, `measured_at timestamptz`, `equipment_id FK`, `entered_by`, `entered_at`, `source ENUM(manual,lims,import)` | [A] after sign |
| `characterisation_lab` | `laboratory_id PK`, `study_id FK`, `name`, `subcontractor_id FK`, `accreditation`, `method`, `u_reported numeric`, `included bool` | |
| `outlier_exclusion` | `exclusion_id PK`, `study_id FK`, `result_id FK`, `test ENUM(grubbs,cochran,manual)`, `statistic numeric`, `justification text NOT NULL`, `signature_id FK NOT NULL` | [A] |
| `uncertainty_component` | `component_id PK`, `project_id FK`, `study_id FK`, `symbol ENUM(u_bb,u_lts,u_sts,u_char)`, `value numeric`, `df numeric`, `basis_text`, `stats_engine_version`, `input_digest bytea`, `computed_at`, `frozen_at` | [A] once frozen |
| `property_value` | `value_id PK`, `tenant_id`, `code UNIQUE(tenant)`, `project_id FK`, `property_name`, `unit`, `value numeric`, `decimal_places int`, `u_combined numeric`, `df_eff numeric`, `k numeric`, `u_expanded numeric`, `state ENUM(draft,submitted,authorised)`, `assigned_by FK`, `assigned_at`, `assign_signature_id FK`, `assign_basis_id FK`, `authorised_by FK`, `authorised_at`, `auth_signature_id FK`, `auth_basis_id FK`, `traceability_statement` — `CHECK (state <> 'authorised' OR (auth_signature_id IS NOT NULL AND auth_basis_id IS NOT NULL))` | [V][H] |
| `property_value_version` | `value_id FK`, `version_no`, snapshot columns, `superseded_at`, PK(both) | [A] |
| `monitoring_point` | `point_id PK`, `study_id FK`, `due_on`, `performed_on`, `performed_by`, `result_id FK`, `signature_id FK`, `units_reserved`, `state ENUM(scheduled,done,overdue)` | |

#### Certification

| Table | Key columns | Markers |
|---|---|---|
| `lot` | `lot_id PK`, `tenant_id`, `lot_code UNIQUE(tenant)`, `project_id FK`, `previous_lot_id FK→lot`, `valid_to date`, `units_produced`, `stock_available int CHECK >= 0`, `state ENUM(pending_release,released,superseded,withdrawn,recalled)`, `storage_class_id FK`, `cold_chain bool`, `list_price_minor bigint`, `currency`, `tierable bool`, `created_by FK`, `released_at`, `released_by FK`, `superseded_at` — **partial unique: `(project_id) WHERE state='released'`** | [V][H] |
| `unit` | `unit_id PK`, `lot_id FK`, `unit_number`, `fill_sequence`, `qr_token UNIQUE`, `reserved_for ENUM(sale,monitoring)` | |
| `certificate` | `certificate_id PK`, `tenant_id`, `certificate_number UNIQUE(tenant)`, `lot_id FK UNIQUE` | |
| `certificate_issue` | `certificate_id FK`, `issue_no int`, PK(both), `issued_at`, `issued_by FK`, `signature_id FK NOT NULL`, `basis_id FK NOT NULL`, `assigned_value numeric`, `decimal_places`, `u_expanded numeric`, `k numeric`, `df_eff numeric`, `data_snapshot jsonb`, `data_snapshot_digest bytea`, `template_version_id FK`, `renderer_version`, `pdf_blob_id FK`, `pdf_sha256 bytea`, `reason text`, `withdrawn bool`, `withdrawn_at`, `withdrawn_by`, `withdrawal_reason`, `withdrawal_signature_id FK` | [A] — narrow column-level UPDATE grant for the four withdrawal columns only |
| `certificate_issue_diff` | `certificate_id FK`, `issue_no`, `field`, `previous`, `current`, PK(cert,issue,field) | [A] |
| `certificate_template` | `template_id PK`, `tenant_id`, `name`, `material_class`, `language` | |
| `certificate_template_version` | `template_version_id PK`, `template_id FK`, `version_no`, `blocks jsonb`, `blocks_sha256`, `typst_source`, `source_sha256`, `font_bundle_sha256`, `approved_by`, `approved_at`, `effective_from`, `supersedes_id FK` | [T][A] |

#### Distribution

| Table | Key columns | Markers |
|---|---|---|
| `storage_class` | `class_id PK`, `tenant_id`, `code`, `min_celsius`, `max_celsius`, `excursion_tolerance_minutes`, `logger_required bool` | reference |
| `price_tier` | `tier_id PK`, `tenant_id`, `code`, `multiplier numeric` | |
| `price` | `price_id PK`, `lot_id FK`, `tier_id FK`, `amount_minor bigint`, `currency`, `validity daterange`; `EXCLUDE (lot_id =, tier_id =, validity &&)` | [T] |
| `catalogue_listing` | `listing_id PK`, `lot_id FK`, `channel`, `validity daterange` | [T] |
| `entitlement` | `entitlement_id PK`, `tenant_id`, `code`, `org_id FK`, `tier_id FK`, `claimed_by FK`, `evidence_blob_id FK`, `state ENUM(under_review,approved,rejected,expiring,lapsed,on_hold)`, `raised_on`, `decided_by FK`, `decided_on`, `rationale`, `validity daterange`, `revalidate_on` | [V][T][H] |
| `cart_line` | `person_id FK`, `lot_id FK`, `quantity`, PK(both) | |
| `order` | `order_id PK`, `tenant_id`, `order_number UNIQUE(tenant)`, `org_id FK`, `placed_by FK`, `channel ENUM`, `tier_id FK`, `total_minor bigint`, `currency`, `state ENUM(placed,packed,dispatched,delivered,cancelled)`, `placed_at`, `version bigint` | [V][H] |
| `order_line` | `line_id PK`, `order_id FK`, `lot_id FK NOT NULL`, `quantity`, `unit_price_minor`, `allocated_at timestamptz`, `certificate_issue_no` | |
| `order_state_history` | `order_id FK`, `from_state`, `to_state`, `at`, `by`, `version`, `audit_seq` | [A] |
| `shipment` | `shipment_id PK`, `order_id FK`, `shipment_number`, `carrier`, `service`, `consignment_no`, `pack_configuration`, `coolant`, `logger_required bool`, `logger_serial`, `logger_bound_at`, `logger_bound_by`, `dispatched_at`, `delivered_at`, `disposition ENUM(pending,accept,quarantine,replace)`, `disposition_signature_id FK` | [V][H] |
| `logger_reading` | `reading_id PK`, `shipment_id FK`, `read_at timestamptz`, `celsius numeric` | [A] |
| `excursion` | `excursion_id PK`, `subject_type ENUM(shipment,facility)`, `subject_id`, `from_ts`, `to_ts`, `peak_celsius numeric`, `min_celsius numeric`, `duration_minutes int`, `mkt_celsius numeric`, `limit_low`, `limit_high`, `breach_count`, `disposition ENUM`, `disposed_by`, `disposed_at`, `capa_id FK` | |
| `vault_holding` | `holding_id PK`, `org_id FK`, `lot_id FK`, `location`, `quantity`, `source ENUM(order,qr_scan,upload,import)`, `order_id FK`, `validity tstzrange` | [T] |
| `search_event` | `event_id PK`, `tenant_id`, `person_id`, `query`, `result_count`, `occurred_at` | [A] |

#### Compliance

| Table | Key columns | Markers |
|---|---|---|
| `equipment` | `equipment_id PK`, `tenant_id`, `code`, `name`, `asset_type`, `location`, `status ENUM` | [V] |
| `calibration` | `calibration_id PK`, `equipment_id FK`, `validity daterange`, `certificate_blob_id FK`, `performed_by`; `EXCLUDE (equipment_id =, validity &&)` | [T] |
| `facility` | `facility_id PK`, `tenant_id`, `name`, `storage_class_id FK` | |
| `facility_lot` | `facility_id FK`, `lot_id FK`, `validity tstzrange`, PK(facility,lot,lower(validity)); `EXCLUDE (facility_id =, lot_id =, validity &&)` | [T] |
| `competence_authorisation` | `competence_id PK`, `tenant_id`, `person_id FK`, `activity FK→permission`, `validity daterange`, `evidence_blob_id FK`, `granted_by FK`, `superseded_by FK`; `EXCLUDE (person_id =, activity =, validity &&)` | [T][A] |
| `subcontractor` | `subcontractor_id PK`, `tenant_id`, `name`, `accreditation_ref`, `accreditation_blob_id FK`, `scope_verified bool`, `assessed_on`, `validity daterange`, `next_due` | [T] |
| `subcontracted_activity` | `id PK`, `subcontractor_id FK`, `project_id FK`, `study_id FK`, `activity`, `evidence_blob_id FK` — `CHECK (activity NOT IN (five forbidden))` | |
| `capa` | `capa_id PK`, `tenant_id`, `code`, `source ENUM`, `subject_type`, `subject_id`, `severity`, `state ENUM(open,investigation,action,effectiveness_check,closed)`, `owner FK`, `raised_on`, `due_on`, `description`, `immediate_action`, `root_cause_method`, `root_cause`, `corrective_action`, `effectiveness_check`, `verified_by`, `closed_on`, `recall_required bool` | [V][H] |
| `capa_action` | `action_id PK`, `capa_id FK`, `description`, `owner`, `due_on`, `completed_on` | |
| `retention_class` | `class_id PK`, `record_class`, `legal_basis[]`, `min_retention`, `max_retention`, `region_pin`, `erasure_stance ENUM`, `resolution_note` | reference |
| `retention_binding` | `class_id FK`, `table_name`, `predicate`, PK(both) | reference |
| `legal_hold` | `hold_id PK`, `tenant_id`, `subject_type`, `subject_id`, `reason`, `placed_by`, `placed_at`, `released_at` | [A] |
| `erasure_request` | `request_id PK`, `tenant_id`, `org_id`, `person_ref`, `received_at`, `decision ENUM(erase,pseudonymise,refuse)`, `refusal_class_id FK`, `decided_by`, `decided_at`, `sla_due_at` | |
| `consent` | `consent_id PK`, `tenant_id`, `org_id`, `person_ref`, `purpose`, `notice_version`, `locale`, `given_at`, `withdrawn_at`, `artefact_blob_id FK` | [A] |
| `blob` | `blob_id PK`, `tenant_id`, `sha256 UNIQUE(tenant)`, `size`, `media_type`, `retention_class_id FK`, `legal_hold bool`, `created_at/by` | [A] |
| `notification` | `notification_id PK`, `tenant_id`, `person_id FK`, `title`, `body`, `subject_type`, `subject_id`, `created_at timestamptz`, `read_at` | |
| `notification_outbox` | `outbox_id PK`, `notification_id FK`, `channel ENUM`, `dedupe_key UNIQUE`, `attempts`, `notified_at`, `failed_at`, `last_error` | |
| `delivery_receipt` | `outbox_id FK`, `acknowledged_at`, `acknowledged_by FK`, PK(outbox_id) | [A] |
| `integration` | `integration_id PK`, `tenant_id`, `system ENUM`, `direction`, `auth_mode`, `state` | |
| `integration_run` | `run_id PK`, `integration_id FK`, `started_at`, `finished_at`, `records`, `errors`, `state` | [A] |
| `applied_migration` | `version PK`, `name`, `sha256`, `applied_at`, `applied_by`, `req_ids[]`, `change_ref` | [A] |

### 4.3 Mutability classes and grants

| Class | Enforcement |
|---|---|
| Append-only ([A]) | `REVOKE UPDATE, DELETE FROM lotmark_app` **and** a `BEFORE UPDATE OR DELETE` trigger raising `LM_IMMUTABLE`. Belt and braces: a future accidental `GRANT` must still fail, and the trigger is self-documenting for an assessor. |
| Temporal ([T]) | `INSERT` plus `UPDATE` of `upper(validity)` only (close-out). Supersession is close + insert, never edit. `EXCLUDE USING gist` makes overlap unrepresentable. |
| Versioned mutable ([V]) | `UPDATE ... SET version = version + 1 WHERE id = $1 AND version = $2`; zero rows → 412. State-machine trigger; `*_state_history` child. |
| Reference | `SELECT` for the app role; written only by migrations, so a permission change is a controlled-document change. |
| `certificate_issue` | Column-level `UPDATE` grant on `withdrawn`, `withdrawn_at`, `withdrawn_by`, `withdrawal_reason`, `withdrawal_signature_id` only, NULL→value once, via a `SECURITY DEFINER` function. |

### 4.4 The audit chain in SQL

```sql
CREATE OR REPLACE FUNCTION ledger_append() RETURNS trigger AS $$
DECLARE h bytea; s bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
  SELECT hash, seq INTO h, s FROM audit_head
    WHERE tenant_id = NEW.tenant_id AND ledger = TG_ARGV[0] FOR UPDATE;

  NEW.seq       := COALESCE(s, 0) + 1;
  NEW.prev_hash := COALESCE(h, '\x00'::bytea);
  NEW.hash := digest(
      lp(NEW.prev_hash)  || lp(NEW.tenant_id) || lp(NEW.generation) || lp(NEW.seq)
   || lp(NEW.occurred_at)|| lp(NEW.actor_id)  || lp(NEW.role_id)
   || lp(NEW.kind)       || lp(NEW.action)
   || lp(NEW.subject_type)|| lp(NEW.subject_id)
   || lp(NEW.before)     || lp(NEW.after)     || lp(NEW.meta)
   || lp(NEW.correlation_id) || lp(NEW.clock_source)
   || lp(NEW.clock_offset_ms) || lp(NEW.region), 'sha256');

  UPDATE audit_head SET seq = NEW.seq, hash = NEW.hash
    WHERE tenant_id = NEW.tenant_id AND ledger = TG_ARGV[0];
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

`lp(x) = int32_be(octet_length(x)) || x`. **Length prefixing, not `|`-joining**, removes the separator-forgery the prototype allows. `seq` and `tenant_id` are inside the digest, so renumbering and cross-tenant interleaving break the chain. The application cannot supply `seq`, `prev_hash` or `hash` — an attempt raises.

`verify_chain(tenant, ledger, from_seq, to_seq)` recomputes forward and returns the first divergent `seq`.

### 4.5 The anchor — what survives a database compromise

A hash chain proves internal consistency, not immutability: whoever can rewrite a row can recompute every subsequent digest. Four mechanisms close that.

1. **The signer process.** Every 5 minutes and every 10,000 entries, `apps/worker` builds a Merkle tree over the unsealed range and asks `apps/signer` — a **separate process, separate OS user, separate credentials, socket the API user cannot open** — to sign the root with **Ed25519** (asymmetric, so anyone with the published public key can verify, and the judges' "an HMAC cannot be handed to an assessor" objection is closed). Production adapters: PKCS#11 HSM, Vault Transit.
2. **Anchors live outside the database.** Each anchor is written to `audit_anchor` **and** to `var/anchors/<tenant>/<ledger>/<date>.jsonl`, which is committed to a git repository the application has no write access to. On production, S3 Object Lock in compliance mode plus an RFC 3161 TSA token.
3. **Append-only at the grant level.** The app role cannot `UPDATE` or `DELETE`. Restore runs as the migrator role and is itself an audited event in the *new* chain.
4. **Continuous verification.** Hourly incremental since the last good anchor, nightly full, both writing their result to the ledger and alerting on divergence.

**Restore semantics.** `make verify --anchors` fetches every anchor, verifies each Ed25519 signature against the published public key, recomputes each range's Merkle root over the restored entries, and **checks that the highest anchored `to_seq` ≤ the restored head.** If an anchor covers entries the restored database does not contain, the verifier reports `LEDGER_DISCONTINUITY` with the anchor, the missing `seq` range, and the timestamp proving those entries existed.

Recovery from a genuine discontinuity is a governed procedure: a first-class `LEDGER_DISCONTINUITY` entry is appended to the restored head citing the anchor and the gap range, the anchor is attached as impact evidence, and **a CAPA is auto-raised**. The chain continues; it does not pretend. **The restore drill's acceptance test is this verification**, not "the database started".

### 4.6 Temporal querying

Three axes, kept distinct:

- **Validity time** (`validity` ranges) — what was true in the world.
- **System time** (`created_at`, `superseded_at`, `*_state_history`) — what the system believed. This is why every state-machine aggregate has a history child: "what did the system believe on 4 June" has a home outside the ledger.
- **Effective date** (`effective_on` on acts) — when the act is deemed to have occurred.

`app.as_of` is a transaction-scoped GUC; views read `app.as_of()`, a `STABLE` function returning `coalesce(current_setting('app.as_of', true)::date, current_date)`, so one view answers both "today" and "as at".

**Three enforced rules:**

1. **`app.as_of` makes the transaction read-only** — a trigger on every business table raises `LM_ASOF_WRITE` on any `INSERT`/`UPDATE`/`DELETE` while it is set. Not a guard convention: one forgotten internal call path is otherwise a backdated signature.
2. **`app.as_of` may never exceed `now()`** — reconstruction is backwards only.
3. **The guard never reads `app.as_of`** — enforcement always uses act time. Additionally, every repository method that reads a dated relation takes an `AsOf` argument as a **type-level requirement**, so forgetting it is a compile error.

The closures become SQL, with three corrections:

- **Closure 1** — recursive CTE `equipment → calibration(range) → study_result → study → project → lot → certificate_issue`, cover checked against **`study_result.measured_at`**, not the signature date. The prototype inverts the control: a study measured in May and signed in July is judged against July. `process_step` joins the same closure, so a lapse during drying or milling is visible — `DB.process` was dead data read by nothing.
- **Closure 2** — `certificate_issue` window `[issued_at, next.issued_at)` joined to `order_line` **keyed on `allocated_at` (dispatch), not `order.placed`**. The certificate that physically travels is fixed at pack time; an order placed before a reissue and shipped after receives issue *n+1*.
- **Closure 3** — `signature → competence_basis`, unchanged in spirit, now with FK integrity and immutability.

### 4.7 Multi-tenancy — the recommendation

**Shared schema + RLS + `generation`, with per-tenant Ed25519 signing keys and per-tenant DEKs for PII columns. Database-per-tenant and database-per-region are deployment topologies over identical migrations.**

```sql
ALTER TABLE lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot FORCE  ROW LEVEL SECURITY;
CREATE POLICY lot_tenant ON lot
  USING      (tenant_id = app.tenant_id() AND generation = app.generation())
  WITH CHECK (tenant_id = app.tenant_id() AND generation = app.generation());
```

`app.tenant_id()` **raises when unset**, so a query outside the unit of work fails closed rather than returning everything. The app role is not the table owner and has no `BYPASSRLS`; one separate admin role has it and is used by exactly two audited utilities, protected by a lint rule.

**Rejected — schema-per-tenant.** Migration fan-out over N schemas with partially-applied failure modes, `search_path` juggling in a pool, dynamic SQL for cross-tenant platform queries, exploding object counts. It buys isolation RLS already provides.

**Rejected — database-per-region on day one** (the compliance-first proposal's approach). Three residency databases before a second customer exists forces a connection router, per-region migration fan-out, and breaks every cross-tenant platform query — to demonstrate a property that three databases in one Postgres instance does not actually demonstrate. It is pure cost with no observable localhost benefit.

**Retained as topology.** Because no query spans tenants, moving a tenant to its own database or region is a connection-string decision plus an operations runbook, not a rewrite. `tenant.data_region` exists in the schema from day one so the routing hook has somewhere to read from; the router itself ships when the first sovereign customer signs. **This is an explicit deferral and appears in §13 as a decision to confirm.**

**Test discipline:** a cross-tenant fuzz suite iterates every endpoint with tenant A's session and tenant B's ids, asserting **404, never 403** — a 403 confirms the id exists.

### 4.8 Numbering

`numbering_series` allocation takes `SELECT ... FOR UPDATE` on the series row inside the business transaction — gapless and monotonic, at the cost of serialising issuance per (tenant, kind). At tens per day this is microseconds and entirely acceptable; it is documented explicitly so nobody later "optimises" it into a sequence and silently introduces gaps, because **a gap in a certificate series is a finding**.

Templates are real (`IPRS{MAT}{SEQ}` vs `RMP-{MAT}-{SEQ}`). **`imported_from` lets a migrating producer's existing series continue unbroken** — non-negotiable, five lines if designed now, a data-migration nightmare if not. The prototype's `length + base` generators collide on delete, disagree with their own seed formats (`PRJ-417` vs `PRJ-0412`), and ignore the tenant template entirely.

---

## 5. API DESIGN

### 5.1 REST + OpenAPI 3.1

**One endpoint = one business operation = one permission = one audit kind = one OQ test = one RTM row.** An assessor can be handed `POST /property-values/{id}/authorisation` and shown on one page the permission it requires, the SoD rule it evaluates, the competence it demands, the signature it produces, the ledger entry it writes, and the test that proves all five.

**Rejected — GraphQL** (field-level authorisation over an arbitrary query graph is far harder to prove correct than a fixed serialiser, and "prove correct" is the deliverable; also the public API must be edge-cacheable and per-consumer rate-limitable). **Rejected — trpc** (TypeScript-only; the second consumers are a LIMS, an ERP, a courier and two field apps). DX is preserved by generating the typed client from OpenAPI into `packages/contracts`.

Conventions: `/api/v1`, cursor pagination, `ETag`/`If-Match`, `Idempotency-Key` on creating POSTs with a 24-hour replay table, `Accept-Language`, `?asOf=YYYY-MM-DD` on temporal reads (echoed as `X-As-Of-Applied`). Every operation carries `x-requirement`, `x-permission`, `x-audit-kind` — machine-readable RTM inputs. The generated document is committed; a CI diff makes any unreviewed contract change visible.

### 5.2 Core surface

```
AUTH & SESSION
  POST   /auth/login                         200 | 202 {mfaRequired} | 423 locked
  POST   /auth/mfa
  DELETE /auth/session
  GET    /me/bootstrap                       identity, permissions[], modules[],
                                             tenant config, features, locales
  GET    /me/sessions   DELETE /me/sessions/{id}
  POST   /signing-challenges   POST /signing-tokens

PRODUCTION
  GET/POST /projects           GET/PATCH /projects/{id}
  GET      /projects/{id}/uncertainty-budget      uc null unless complete
  GET/POST /projects/{id}/process-steps
  GET/POST /studies            GET /studies/{id}
  PUT      /studies/{id}/results                  frozen once signed
  POST     /studies/{id}/outlier-exclusions       justification + signature
  GET      /studies/{id}/statistics               + stats_engine_version, df
  POST     /studies/{id}/signature                study:sign + competence + STEP-UP
  POST     /studies/{id}/slope-disposition        required when slope significant
  POST     /studies/{id}/monitoring-checks        MUST carry a measurement
  GET/POST /property-values
  POST     /property-values/{id}/assignment       value:assign + competence + step-up
  POST     /property-values/{id}/authorisation    value:authorise + SoD-1 + step-up
  POST     /property-values/{id}/return           value:authorise + SoD-1 + reason

CERTIFICATION
  GET/POST /lots               POST /lots/{id}/release       lot:release + SoD-4
  POST     /lots/import                                      dry-run + commit
  GET      /certificates       GET /certificates/{id}
  POST     /certificates                          issue: cert:issue + SoD-3 + step-up
  POST     /certificates/{id}/issues              reissue: recomputes, reason, basis
  GET      /certificates/{id}/issues/{n}
  GET      /certificates/{id}/issues/{n}/document → 200 PDF | 202 rendering
  GET      /certificates/{id}/issues/{n}/diff
  GET      /certificates/{id}/issues/{n}/holders  Closure 2, keyed at dispatch
  POST     /certificates/{id}/issues/{n}/withdrawal  reason + step-up
  POST     /certificates/{id}/issues/{n}/notifications
  GET/POST /certificate-templates
  POST     /certificate-templates/{id}/versions   dual approval

DISTRIBUTION
  GET      /catalogue                              listing rule is one view
  GET/PUT/DELETE /cart-lines
  POST     /orders                                 FOR UPDATE allocation
  GET      /orders  GET /orders/{id}  GET /orders/{id}/documents
  POST     /orders/{id}/transitions {to}           If-Match REQUIRED
  GET/POST /entitlements   POST /entitlements/{id}/decision   SoD-2
  POST     /shipments/{id}/logger-binding
  POST     /shipments/{id}/logger-readings
  POST     /shipments/{id}/delivery                BLOCKED without a logger reading
  POST     /shipments/{id}/excursion-disposition   signed; auto-raises a CAPA
  GET      /vault/holdings   POST /vault/holdings:scan
  GET      /vault/audit-pack

COMPLIANCE
  GET      /conformance/clauses?asOf=              13 live predicates
  POST     /conformance/assessment-packs           202 → job → signed bundle
  GET/POST /equipment   POST /equipment/{id}/calibrations
  GET      /equipment/{id}/impact?asOf=            Closure 1
  GET/POST /competence  GET /competence/matrix?asOf=
  GET/POST /subcontractors  POST /subcontracted-activities
  GET/POST /capa  POST /capa/{id}/transitions
  GET      /audit/entries?cursor=&kind=&actor=
  POST     /audit/verifications  POST /audit/exports
  GET      /trace/lots/{id}?asOf=   /trace/facilities/{id}?asOf=
  GET      /retention/schedule  POST /erasure-requests  POST /legal-holds
  GET      /monitoring/due

PLATFORM
  GET/PATCH /tenants/{id}/settings                 tenant:configure + dual approval
  GET/POST  /numbering-series  POST /numbering-series/{id}/import
  GET/POST  /users  GET/POST /roles
  GET       /sod-rules  POST /sod-rules/{id}/change-requests  POST .../approvals
  GET       /notifications  POST /notifications/{id}/acknowledgement  ← holder only
  GET       /invariants                            live selfCheck successor
  GET       /blobs/{id}                            permission-checked, read-audited
  POST      /admin/tenants/{id}/reset              demo-class only
  GET       /healthz  /readyz  /metrics

PUBLIC — unauthenticated, cacheable, rate-limited, no PII
  GET  /public/v1/certificates/{number}            JSON + signature + status
  GET  /public/v1/certificates/{number}/verify     {valid, issuedAt, withdrawn,
                                                    supersededBy, publicKey}
  GET  /public/v1/units/{qrToken}                  resolves the vial, not the SKU
  GET  /verify/{token}                             SSR HTML, NO JavaScript, printable
```

`/verify/{token}` is server-rendered by the API with no JavaScript and a print stylesheet: a QA officer with a QR code and a locked-down browser must still get an answer. It shows the status of that exact issue — including "SUPERSEDED — issue 2 is current" and "WITHDRAWN — do not use".

### 5.3 Error model — RFC 9457

```json
{
  "type": "https://lotmark.dev/problems/segregation-of-duties",
  "title": "Segregation of duties",
  "status": 403,
  "code": "SOD_VIOLATION",
  "detail": "Segregation of duties (SoD-1): the account that assigned this value cannot authorise it.",
  "instance": "/api/v1/property-values/PV-03/authorisation",
  "rule": { "id": "SoD-1", "field": "assigned_by", "owner": "Quality Manager" },
  "auditSeq": 84213,
  "correlationId": "01JD..."
}
```

`auditSeq` on every refusal means the denial a user sees and the ledger entry an assessor reads are the same event, and the user can cite it.

| Condition | Status | `code` | Ledger |
|---|---|---|---|
| Not signed in | 401 | `UNAUTHENTICATED` | DENY |
| Session idle/expired | 401 | `SESSION_EXPIRED` | AUTH |
| Wrong tenant/generation | **404** | `NOT_FOUND` | DENY (subject server-side only) |
| Role lacks permission | 403 | `PERMISSION_DENIED` | DENY |
| SoD rule fires | 403 | `SOD_VIOLATION` | DENY |
| No current competence | 403 | `COMPETENCE_LAPSED` (+`activity`, `lastValidTo`) | DENY |
| **Step-up required** | **428** | `SIGNATURE_REQUIRED` + challenge params | SECURITY |
| Token invalid/expired/mismatched | 401 | `SIGNING_TOKEN_INVALID` | SECURITY |
| Missing `If-Match` | 428 | `PRECONDITION_REQUIRED` | — |
| Version mismatch | 412 | `VERSION_CONFLICT` (+`expected`,`actual`) | CONFLICT |
| Illegal transition | 409 | `STATE_CONFLICT` (+`from`,`allowed[]`) | — |
| Budget incomplete / no authorised value | 409 | `PRECONDITION_UNMET` | — |
| Clock offset over threshold | 503 | `CLOCK_UNTRUSTED` | SECURITY |
| Validation | 422 | `VALIDATION_FAILED` + field issues | — |
| Rate limited | 429 | `RATE_LIMITED` + `Retry-After` | SECURITY |
| Write while `asOf` set | 400 | `ASOF_READONLY` | — |

**428 for step-up** is deliberate: semantically distinct from "you may never do this", it carries the challenge parameters so the client opens the signing dialog without guessing.

### 5.4 The signing round trip

```
POST /property-values/PV-03/authorisation                      → 428 + challenge
POST /signing-challenges {subject, version, intent}            → 201 challengeId
POST /signing-tokens {challengeId, password?, totp, meaning}   → 201 signingToken
POST /property-values/PV-03/authorisation
     X-Signing-Token: st_...   If-Match: "3"                   → 201
```

The retry re-evaluates the **entire** guard chain — the prototype's double-guard TOCTOU defence, made structural.

---

## 6. FRONTEND ARCHITECTURE

### 6.1 Three bundles, one design system

| Bundle | Route | Rationale |
|---|---|---|
| `console` | `/console/*` | Producer. 23 modules. Behind auth. |
| `storefront` | `/shop`, `/orders`, `/vault`, `/account` | Customer. Different vocabulary, different a11y risk profile — and the surface most likely to be replaced by a tenant's own commerce layer. |
| `verify` | `/verify/:token` | **Server-rendered by the API. No JavaScript.** ~0 KB, own SLO, own DR tier. |

**The core/commodity split is physical.** The storefront consumes exactly five API surfaces, published as a contract so a tenant can bring their own shop window: catalogue and availability; tier-resolved price; current lot and validity; certificate and safety-document links; order creation and status.

**Rejected — Next.js:** two runtimes, a second server holding session state, and RSC/route-handler ambiguity about *where authorisation runs* — the one question this product must answer unambiguously. SEO does not apply (the console is behind auth; the public verifier is SSR'd by the API).

### 6.2 Routing and state

- **TanStack Router v1** — typed routes, typed search-param schemas. Module, detail id, search, page, sort and `asOf` all live in the URL, fixing the prototype's global `S.page` bleeding across modules and making every view linkable — an assessor asking "show me exactly what you showed me" needs a URL.
- **TanStack Query v5** — the only server-state cache. `ETag`/`If-Match` handled in the shared fetch layer; a `VERSION_CONFLICT` triggers a refetch and a "this changed under you — reload" banner, generalised from `advance()`.
- **Zustand** for the small residue: sidebar collapse, toast queue, signing-dialog transient state, idle countdown. No Redux; the prototype's single mutable `S`/`DB` object is the pattern being removed.
- **react-hook-form + zod resolver** sharing schemas from `packages/contracts`, so client and server validation cannot diverge.

### 6.3 Tables

One `<DataTable>` on TanStack Table v8, used ~41 times, with an opinionated API:

```ts
<DataTable
  caption="Signed studies and the authorisation each relied on"  // required: string
  columns={...} query={...} />
```

`caption` is a **required prop of type `string`, not `string | undefined`**. The prototype had one caption across forty-one tables and fixed it with a post-render DOM walk hunting for the nearest heading. A compile error is cheaper and correct.

The component owns: server-driven pagination/sort/filter (client-side `filt()` over eleven rows will not survive 1,341 SKUs), `scope="col"`, `aria-sort` on real `<button>` headers, permission-gated row actions, and empty/loading/error/denied states. **Every catalogue search emits a `search_event`** — "materials searched but unavailable" is the product's own stated commercial signal and the prototype captured none of it.

### 6.4 Permission-aware navigation

`GET /me/bootstrap` returns the effective permission set and module list, computed server-side from the same tables the guard reads. Locked modules render **visibly disabled with a reason** — the prototype's choice, and the right one: hiding teaches nothing, showing locked teaches the model. Each module gets **its own read permission**, correcting the prototype's coarse `project:read` covering `monitoring`, `equipment`, `competence`, `trace` and `tenant` — the last of which let any producer switch the global tenant profile.

The client permission set is **UX only**, documented as such in code, and proven by the cross-tenant fuzz suite and the guard integration tests.

### 6.5 i18n

**Lingui v5** with ICU MessageFormat.

- `<html lang>` and `dir` switch. The prototype hardcoded `lang="en"` even for the `bilingual:true` tenant.
- **Domain content is data, not JSON keys** — material names, storage classes, clause text and certificate block labels live in a `translation` table with per-locale rows, so a tenant adds a material and its Hindi name without a deploy.
- `Intl` for dates, numbers and currency with the tenant locale.
- **Bilingual certificates are a template-version property**, not string concatenation.
- Pseudo-localisation in CI catches concatenation and truncation; a lint rule bans literal strings in JSX; a CI check fails on untranslated keys in an enabled locale.

### 6.6 Accessibility — WCAG 2.1 AA + GIGW 3.0

**Kept:** skip link, `<main>`, `prefers-reduced-motion`, `aria-live` toasts, focus-trapped modal with focus restoration, `aria-current`, `aria-disabled` on locked modules.

**Added:** Radix primitives for every interactive widget (never hand-write `trap()` again); a token palette audited to 4.5:1 with a CI contrast check (the prototype's 11.5 px `.muted` text will fail); **status never conveyed by colour alone** — every chip carries text or an icon, enforced by a lint rule banning raw colour-coded spans in table cells; a keyboard "Move to…" menu on the dispatch board instead of a drag metaphor; `aria-describedby` on field errors; **tagged PDF/UA output validated by veraPDF**; and a generated VPAT/ACR per release. `axe-core` via `@axe-core/playwright` on every route, zero serious/critical violations as a merge gate, plus manual NVDA/VoiceOver/TalkBack passes per phase.

### 6.7 The as-at control

`<AsOfControl>` writes `?asOf=` into the URL, applies a persistent amber "Historic view — 4 June 2026" band to the whole shell, and **disables every mutating control while set**. That is UX; the enforcement is the database trigger (§4.6). Available on every compliance surface, not the prototype's two. Setting it writes `QUERY / Point-in-time view` — who looked at what, as at when, is itself evidence.

### 6.8 Print and PDF

The client never renders a certificate. `GET .../document` streams the server-rendered, signed artefact. A print stylesheet exists for screen-derived worksheets; anything with legal weight comes from the renderer, so what the customer files is byte-identical to what the producer issued.

---

## 7. AUTHN / AUTHZ, CONCRETELY

| Concern | Decision |
|---|---|
| **Session** | Server-side, opaque 256-bit token, stored **hashed**, cookie `__Host-lm_sid; HttpOnly; Secure; SameSite=Strict; Path=/`. mkcert makes this behave identically to production on localhost and exercises SEC-18 in dev. |
| **Why not JWT** | Every property needed is server state: immediate revocation on logout, role change, competence withdrawal, password change, tenant suspension; idle timeout; the signing window; concurrent-session listing; lockouts. A JWT needs a denylist for all of it, at which point it is a session with a larger attack surface. JWT appears only for machine integrations (OAuth 2.1 client credentials, scoped, short-lived) and phase-7 mobile (OAuth 2.1 + PKCE, rotating refresh). |
| **CSRF** | `SameSite=Strict` + `Origin` check on every unsafe method + double-submit token. |
| **Passwords** | Argon2id m=64 MiB t=3 p=1, 16-byte CSPRNG salt, **pepper from `KeyService`** so a database dump alone is not offline-crackable. Length ≥ 12, no composition rules (NIST SP 800-63B), checked against a local k-anonymity breach corpus. Params per row, rehash on next login. |
| **MFA** | TOTP RFC 6238, ±1 step, **used-(person, step) replay cache in Postgres**, encrypted secret, Argon2-hashed recovery codes. **MFA is a role/tenant policy attribute** — producer roles mandatory — not the prototype's per-user boolean shipping `false` for both customer accounts, including the one that can claim a 50% price reduction. WebAuthn in phase 7 and preferred thereafter for §11.200(a)(3). |
| **Lockout & rate limits** | Postgres-backed sliding windows: `login:<email>` 6/60 s with lockout after 3 failures for 60 s escalating; `signing:<person>` 8/60 s; `pii-reveal:<person>` 20/hour with a QM alert. Plus IP and tenant dimensions the prototype lacks. Survives restart. |
| **Idle timeout** | Authoritative server-side `last_activity_at`, refreshed by real API calls, not `click`/`keydown` listeners (which logged out a scientist reading a long table). Per tenant and role: 15 min console default, **3 min for signing-capable surfaces**. Absolute cap 12 h. |
| **Step-up** | §3.7. 10-min rolling, **60-min absolute cap as a code constant**. |
| **PII break-glass** | Redaction in the **serialiser**, so an unentitled principal never receives the value. Reveal is `POST /pii/reveals` with a **reason from a controlled vocabulary plus free text**, returns one field of one subject, **15-minute TTL** after which it re-masks, rate-limited, QM-alerted on volume anomaly, cleared on logout. The prototype's `S.revealed` was permanent, reasonless, scopeless and survived sign-out. |
| **Admin** | No god-role. `Object.keys(PERMS)` is replaced by scoped admin roles plus time-boxed, justified, dual-approved break-glass elevation. |

---

## 8. CERTIFICATES AND DOCUMENTS

### 8.1 Template model

`certificate_template` → `certificate_template_version` (append-only, dual-approved, effective-dated). `blocks` is a validated structure with **enforced cardinality**:

- **locked** — producer header, accreditation mark
- **required** — property value table, uncertainty statement **including k and df_eff**, traceability statement, validity, storage and transport
- **optional** — instructions for use, safety, custom

A `CHECK` rejects any version missing a required block. **A tenant cannot style their way out of ISO Guide 31 conformance** — which is the actual reason templating is "the multi-tenant hinge" rather than a theming feature. Block content is constrained rich text with typed placeholders resolved from the issue snapshot; there is no expression language and no user-supplied logic.

### 8.2 The reproducibility triple

Every `certificate_issue` records **`template_version_id` + `data_snapshot_digest` + `renderer_version`** (Typst binary hash + `font_bundle_sha256` + veraPDF/Ghostscript versions). Given the same three, output is byte-identical. A CI job re-renders every historical fixture on any renderer bump and **fails on an unexplained byte diff** — the alarm you want, because it means historical certificates would no longer reproduce.

Fallback, stated plainly rather than discovered later: the **signed original PDF is retained in the blob store forever**, so a re-render is a convenience, never the source of truth. If byte identity is ever lost, the claim degrades to content identity verified by structural diff against the retained original — which is the stronger claim anyway.

### 8.3 Pipeline

```
issue snapshot (canonical JSON, digest computed and SIGNED)
  → template_version.blocks + locale → generated Typst source (hashed)
  → typst compile
  → Ghostscript post-step (output intent, XMP, tagging) if required
  → veraPDF: PDF/A-2b + PDF/UA-1 profiles.  NON-CONFORMANCE FAILS THE JOB.
  → embed machine-readable JSON payload (PDF/A-3b attachment)
  → Ed25519 detached signature over sha256(PDF bytes), + development timestamp
  → blob store, digest recorded on certificate_issue
  → audit CERTIFICATE / Document rendered {sha256, templateVersion, rendererVersion}
```

**No PAdES profile is claimed on localhost.** The artefact is "PDF/A with an embedded Ed25519 detached signature and a development timestamp". PAdES-B-LT with a real CA and an RFC 3161 TSA is the production adapter behind the same `SigningService.sign` interface, and the swap is configuration. Claiming a profile name a self-signed development key cannot satisfy is precisely the overclaim this architecture exists to remove.

### 8.4 Issue and render are decoupled

**The certificate record is issued and signed independently of its PDF.** The PDF is a derived, retryable, idempotent job artefact regenerable from the snapshot at any time. `GET .../document` returns `202 Accepted` while rendering. This is the single most important robustness decision in the pipeline: a hung or failing renderer must never block certificate issuance, and it removes the last argument for running workers inline.

### 8.5 Reissue, withdrawal, custody

- **Reissue appends.** It **recomputes** value and U from current signed studies (`prev.val − 0.07` is hardcoded demo arithmetic), requires a reason, records a competence basis (the prototype records none, leaving a bound signature with no authorisation behind it), renders against the template version in force at reissue, and writes a machine-generated `certificate_issue_diff`.
- **Withdrawal** is signed, reason-mandatory, sets the lot state, and enqueues notifications to every holder of every issue with **delivery receipts and escalation on non-acknowledgement**. `notified_at` and `acknowledged_at` are separate columns and only the holder's authenticated act writes the second — the prototype's `reissueAck` was set by the *producer's* notify action, so "acknowledged" meant "we sent it".
- **Key custody is a first-class field.** `KeyProvider` reports `custody_class ∈ {DEV_FILE, DEV_SIGNER_PROCESS, PKCS11_HSM, VAULT_TRANSIT}`. It is surfaced in `GET /tenants/{id}/settings`, printed on the validation-pack cover page, and recorded in the IQ record. This honesty control stops "we have an HSM interface" being read as "we have an HSM".
- **Every certificate carries a QR** to `/verify/{token}`.

---

## 9. TESTING AND VALIDATION

### 9.1 The pyramid

| Level | Tool | Scope |
|---|---|---|
| Unit | Vitest | Domain state machines, SoD grammar, canonical serialisation, temporal resolution, `packages/stats` |
| Property | fast-check | Metrology invariants (scale/translation equivariance, u ≥ 0, balanced == unbalanced when balanced); chain serialisation injectivity; as-at monotonicity |
| Integration | Vitest + Testcontainers | Every use case against real Postgres: RLS, triggers, exclusion constraints, chain, concurrency. Where most of the value is |
| Contract | Generated OpenAPI + schema fuzzing | Every response validates; a schema change without a doc change fails |
| E2E | Playwright | The 44 journeys from the screens inventory, both locales |
| Accessibility | `@axe-core/playwright` | Every route, zero violations |
| Cross-tenant | Custom fuzz | Every endpoint, A's session against B's ids → 404 |
| Offline | e2e with egress blocked | Fails if any internet dependency exists |
| Load | k6 against the `scale` pack | §12 targets |
| Security | ZAP baseline, semgrep, osv-scanner, CycloneDX SBOM | Per release |

### 9.2 Traceability — prototype `selfCheck` → enforced constraint or test

| # | Invariant (prototype) | Becomes | Evidence artefact |
|---|---|---|---|
| 1 | Every granted permission is defined | FK `role_permission.permission_key → permission` + TS union type + boot assertion | Negative test: insert an undefined grant → FK violation |
| 2 | Every sidebar module has a renderer | Typed route registry + boot check + per-role nav walk test | E2E: for each role, fetch nav, follow every module, assert 200 |
| 3 | Every SoD rule guards a defined permission | FK `sod_rule.guarded_permission → permission`; `CHECK` on `conflicting_field` against the subject's columns | Negative test: unknown action → FK violation; unknown field → CHECK violation |
| 4 | Audit chain verifies | `BEFORE INSERT` trigger + `REVOKE UPDATE, DELETE` + immutability trigger + **hourly `ledger.verify-incremental`, nightly full, anchors** | Tests: UPDATE → exception; DELETE → exception; planted corruption → verifier names the `seq`; restore-with-gap → `LEDGER_DISCONTINUITY`; concurrent writers → no fork |
| 5 | Every order line references an existing lot | FK `order_line.lot_id`, `ON DELETE RESTRICT`, `NOT NULL` | Negative test |
| 6 | Every vault holding references an existing lot | FK + `CHECK (quantity > 0)` | Negative test + a DPDP erasure that must not orphan a holding |
| 7 | Every study references existing equipment | `study_equipment` junction, FKs both sides, `ON DELETE RESTRICT` | Negative test **plus** the new rule: signing a study whose equipment had no calibration covering `measured_at` is blocked |
| 8 | Every lot belongs to a real project | FK | Negative test |
| 9 | Competence names a real user and activity | FK ×2 + `CHECK (lower < upper)` + `EXCLUDE` on overlap | Negative tests: unknown activity; inverted dates; overlapping windows |
| 10 | Every signed study carries a valid basis | `CHECK (state <> 'signed' OR basis_id IS NOT NULL)`; basis written in the signing transaction; append-only | Test: shortening the competence record afterwards leaves the historic signature valid **and** raises a CAPA via `competence.reverification` |
| 11 | Every bound study signature verifies | Immutability trigger on signed material columns + nightly verification sweep | Tests: UPDATE a signed study's `u` → rejected; DB-level tamper → verifier reports BROKEN; **verify from the exported artefact + public key with no DB** |
| 12 | Every bound certificate signature verifies | `certificate_issue.signature_id NOT NULL` — **the vacuous-pass bug is gone** (nothing to filter out) | Same as #11; plus a withdrawn issue's signature still verifies |
| 13 | Every certificate belongs to a real lot | FK + `UNIQUE (lot_id)` — "one lot, one certificate" was asserted in prose and enforced nowhere | Negative test: second certificate for a lot → unique violation |
| 14 | Every listed lot has a current, unwithdrawn certificate | **The `catalogue_listing` view's definition is the rule.** One definition replaces the prototype's three slightly-different call sites | Tests: withdraw → gone from catalogue, storefront and in-flight carts; reissue → stays; stock 0 → delisted; concurrent withdraw+order → order rejected |
| 15 | Every uncertainty component derives from raw data | `uncertainty_component` has no writable API (400 on POST); `input_digest` + `stats_engine_version` persisted; `components.staleness-scan` | Tests: direct POST → 400; result change → recompute + review raised; issue with incomplete budget → blocked; **NIST StRD golden datasets** |
| 16 | Coverage map classifies every row | Docs CI check — **and asserts the narrative counts match the data** (the prototype's own page says three `n/a` rows where there are four) | CI gate |

**New invariants the prototype could not express:**

| Invariant | Enforcement |
|---|---|
| Every certificate issue carries a competence basis | `basis_id NOT NULL` (the prototype's reissue records none) |
| Every authorised property value carries signature and basis | `CHECK (state <> 'authorised' OR both NOT NULL)` (seeded `PV-01`/`PV-02` had neither and were certifiable) |
| Every signature was produced by a consumed step-up token | `signature` INSERT-only, one role, one service; test each of six acts without a token → 403 |
| Stock never negative | `CHECK (stock_available >= 0)` + `FOR UPDATE` allocation |
| At most one released lot per project | Partial unique index |
| Withdrawn ⇒ delisted and unorderable | Catalogue view + order validation |
| `seq` gapless and monotonic per tenant per ledger | Trigger + `audit_head FOR UPDATE`; concurrency test |
| SoD toggles are four-eyed | `sod_rule_change` requires distinct `proposed_by`/`approved_by`; self-approval → rejected |
| Entitlement revalidation enforced | `entitlement.revalidation-hold` job; advance the clock past `revalidate_on` → tier holds, price reverts, holder notified |
| Every mandated notification was delivered | `outbox.reconcile` asserts every withdrawal has a dispatched notice per holder org |
| No mutation of a signed/authorised/issued record | Immutability triggers on four record classes |
| Every table has RLS enabled, forced, with a policy | Migration test over `pg_class`; a new table without one fails CI |
| No cross-tenant read | Fuzz suite, every endpoint, asserting 404 |
| Every enabled SoD rule has a subject loader | Boot assertion; process refuses to start |
| Every defined permission is enforced somewhere | Boot assertion (catches `lot:create`) |

`GET /invariants` and `make verify` run the runtime subset live, preserving the prototype's Build & Verification screen — self-checking in production is the right instinct — but now the screen reports on constraints and jobs rather than being the only thing between the data and nonsense.

### 9.3 Golden tests

- **Metrology — NIST Statistical Reference Datasets**: `Norris`, `Longley`, `Wampler1-5` for linear regression (certified slope, intercept, standard errors to 15 digits); `SiRstv`, `AtmWtAg` for one-way ANOVA. Asserted to the certified digits. **Strictly better than fixtures generated from R or scipy**, because the certified values are published and the fixture is itself defensible evidence rather than a script someone must trust.
- **`prototype-golden.json`** pins agreement with the prototype where the prototype was right, **annotated at every point where it is deliberately deviated from**, cross-referenced to `docs/deviations.md`.
- **Certificate reproducibility** — render a golden issue, assert `sha256(PDF)` matches; runs on every commit and in the OQ pack.
- **Offline verification** — export a signed certificate plus the tenant public key and verify in a separate process with **no database access**. This is §11.70 in the form an assessor can repeat.
- **Ledger** — a fixture chain with a planted mutation at entry N; the verifier must report exactly N.
- **Degenerate inputs** — 1 unit, 1 replicate, 2 timepoints, identical timepoints, 1 laboratory, missing values, and `msB < msW` (the floored branch no seeded dataset reaches).

### 9.4 `docs/deviations.md`

A checked-in register: **every deliberate divergence from the prototype, the defect it fixes, the artefact line reference, and the test that pins the new behaviour.** Read at the start of each phase. This is the change-control artefact that stops "transcribe the prototype" from silently importing the prototype's defects, and it is what the golden fixtures annotate against.

### 9.5 IQ / OQ / PQ and the RTM, as commands

**Requirements are data** — `packages/conformance/requirements/REQ-*.yaml`, each with `id`, `source` (ISO 17034 §, 21 CFR 11 §, GIGW guideline, DPDP obligation), `statement`, `risk`.

They are referenced from **three machine-readable places**: `@requirement('REQ-…')` tags on tests, `x-requirement` on OpenAPI operations, and `REQ` ids in migration file headers (which is what ties a schema change to a change-control reference). A build step joins all three and emits the RTM as CSV + HTML. **A requirement with no covering test fails the build.** Nobody maintains a spreadsheet — the direct descendant of the prototype's best structural idea, `build.py sync` regenerating the coverage map so the verifying artefact cannot drift from the product.

```
make validation
```

- **IQ** — OS/kernel, container image **digests**, Postgres version + extensions + **role grants dump + RLS policy dump**, applied-migration checksums, blob-store configuration, **key custody class**, Typst/veraPDF/Ghostscript hashes, font hashes, lockfile hash, CycloneDX SBOM, git commit and build provenance. Signed JSON + PDF. Re-running and diffing is the change-control evidence.
- **OQ** — the tagged suites against the installed instance: every negative constraint test, every invariant, every guard-chain refusal (each guard site, each SoD rule, each competence boundary), every legal and illegal state transition, the NIST goldens, the reproducibility test, the offline verification test, the cross-tenant fuzz, the axe pass, and **every row of `security_control` (SEC-01…SEC-22) exercised** — the prototype's "nothing is asserted without a way to test it", promoted from a UI affordance to a release gate. Signed report keyed to REQ ids.
- **PQ** — scripted Playwright scenarios against the customer's own materials, roles and SOPs, with screenshots, timings and a ledger extract per step.

`make validation` ships as a **stub in Phase 0 that grows**. Retrofitting validation is the classic cost blow-up; the estimate carries no CSV line at all, so **budget it explicitly at ≥120 person-days** rather than absorbing it into contingency.

### 9.6 The `build.py` successor

`make check` inherits all 23 static checks: ESLint with `boundaries`, `tsc --noEmit`, dead-permission check, dead-module check, migration-checksum check, OpenAPI-drift check, i18n-key check, docs-drift check, duplicate-declaration check, feature-flag-age check. **Each prints its own assertion count and fails below an expected floor** — the prototype's V10 lesson, that three green results came from tests that never ran, is worth keeping.

---

## 10. OBSERVABILITY, BACKUP, DISASTER RECOVERY

**Observability.** OpenTelemetry SDK wired but exporting to a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so production instrumentation is configuration, not a rewrite. `pino` structured logs with a **PII redaction serialiser driven by the schema's `@pii:` column registry — an allowlist, not a denylist**, because denylists eventually leak. `correlation_id` propagates into every ledger entry, so an operational trace and a business audit entry join. `prom-client` at `/metrics`: RED per route, job lag, chain-verification age, anchor age, signature-verification failures, outbox depth and age, blob-store size, RLS policy count. Alerts: chain divergence, anchor failure, clock offset over threshold, job lag, unacknowledged withdrawal notices, PII-reveal volume anomaly, RLS policy count drift. **Security telemetry is a separate retention class** (CERT-In 180 days, region-pinned) from application logs, in the schema from day one.

**Backup.** `pg_dump --format=custom` nightly plus `archive_mode=on` WAL archiving (RPO ≤ 15 min) into `var/backups/`; `make backup` / `make restore <file>`. Blobs are content-addressed, so blob backup is an rsync of an append-only tree, verified weekly against recorded digests. **`var/anchors/` and the signer's key directory are backed up separately from the database** — that separation is what makes the anchor argument work. Production: pgBackRest to object storage with lifecycle policies **derived from `retention_class`**, not hand-configured, and backups inheriting the region pin (a 10-year ledger with 35-day backups is not a 10-year ledger; a 90-day PII erasure with 1-year backups is not an erasure).

**DR targets.** RTO ≤ 4 h console, **RTO ≤ 1 h for `/public/v1` and `/verify`** (customer GMP systems depend on them), RPO ≤ 15 min. Degraded mode is defined: certificate retrieval and verification continue read-only; signing does not.

**`make dr:drill`** restores the latest backup into a scratch database and runs the §4.5 verification. **Its acceptance test is the chain and anchor verification, not "the database started."** It runs on a schedule in CI against the `scale` pack, so "we have backups" is a passing test rather than a belief.

---

## 11. PHASED DELIVERY

Each phase ends in something demonstrable end-to-end on localhost. Nothing is left half-cut across phases. Estimates assume one to two engineers.

| # | Phase | Weeks | Contents | Milestone demo |
|---|---|---|---|---|
| **0** | Foundations | 2–3 | Workspace completion, `make dev`/`doctor`/`bundle`, mkcert TLS, migration runner with checksum refusal, RLS scaffolding + `pg_class` policy test, `packages/domain` completed, boundary lint, CI, **`make validation` stub + RTM generator**, `docs/deviations.md` | Clean clone → `make dev` on a machine with no internet → HTTPS login page; `make validation` prints a signed IQ record; RTM renders with zero orphan tests |
| **1** | Trust spine | 4–5 | Identity, Argon2id, TOTP with replay cache, Postgres-backed lockouts and rate limits, sessions, idle timeout. **The guard chain in the application service + all four boot assertions.** RLS on every table, `generation`. **Ledger trigger, denial ledger, signer process, Ed25519 anchors, verification jobs.** Clock service with measured NTP offset. Problem+json, OpenAPI. | Sign in with real TOTP; each denial class produces a distinct ledger entry and a `problem+json` carrying its `auditSeq`; tamper a row via psql → `make verify` names the exact `seq`; restore a backup missing entries → `LEDGER_DISCONTINUITY` with the anchor as proof + a CAPA raised; tenant B is invisible (404) |
| **2** | Production & signing | 5–6 | Projects, studies, results with `measured_at` and per-result equipment, **`packages/stats` completed with df, Welch–Satterthwaite k, u(sts), outlier tests, GUM rounding**, persisted components, property values with versions, assign/authorise/return, **signing service + step-up + competence basis + `permission_competence_map` + reverification job**, `GET /invariants` | The full prototype journey, server-side and audited: sign a study with step-up; be refused as Sunil for lapsed competence; be refused by SoD-1 for self-authorisation; PV-03 blocked by an incomplete budget. **NIST goldens green.** Alter a raw result → the study signature breaks |
| **3** | Certification | 4–5 | Lots with supersession and `previous_lot_id` FK, numbering series with import, template model with enforced cardinality, **Typst → veraPDF gate → PDF/A + PDF/UA**, async render job, Ed25519 document signature, QR, reissue with recomputation and diff, withdrawal with holder notification and receipts, **`/verify/:token` SSR no-JS page** | Issue a certificate; download the PDF; **verify its signature in a separate process with no database**; scan its QR on a phone and get the no-JS page; reissue → diff + holder list; withdraw → lot leaves the catalogue, holders notified, in-flight carts fail closed |
| **4** | Distribution | 4–5 | Catalogue view, per-person cart, orders with `FOR UPDATE` deterministic-order allocation, entitlement with revalidation job, dispatch with `If-Match`, shipments, logger binding, **excursion detection with MKT, duration, contiguity and low-side limits**, delivery blocked without a logger reading, vault with dated holdings, search events | Two concurrent orders for the last unit — exactly one succeeds; advance an order from two tabs → 412 + `CONFLICT` entry; deliver with an excursion → a CAPA auto-raised with its computed blast radius |
| **5** | Compliance & jobs | 4–5 | Conformance clauses as as-at SQL views, **the three closures as recursive CTEs with the three corrections**, equipment + calibration, competence matrix, subcontractors with forbidden-activity CHECK, CAPA workflow with due dates and effectiveness checks, retention classes + legal hold + erasure decision procedure + consent, **all background jobs**, assessment pack as a signed bundle | Set as-at to a past quarter → clause table re-resolves; lapse a calibration → exposed lots and certificates listed; correct a competence record → a CAPA raised for the signature that lost its backing; run the retention dry-run → refuse an erasure with a cited reason |
| **6** | Platform & hardening | 4 | Tenant settings with versioning and dual approval, typed feature-flag registry with removal dates, **full EN/HI i18n including a Hindi certificate template and translated domain content**, notification channels, integration framework **with the manual-entry path first**, observability, backup + `dr:drill`, k6 against `scale`, ZAP, full axe pass, VPAT | **Provision a second tenant from scratch — different numbering series, different locales, different certificate template — side by side with the first.** "IPC is a profile, not a fork", demonstrated rather than asserted |
| **7** | Validation & field | 4–5 | Complete OQ/PQ scripts, validation plan and summary, unit serialisation + QR at packaging + fill-order capture, customer PWA, dispatch handheld with scan-to-confirm and logger binding, **offline-first field capture (§12 R11)** | Hand over a signed IQ+OQ+PQ bundle and a generated RTM as one artefact; scan a vial and get the right unit, the right lot, and a one-tap reorder of the replacement if superseded |

Phases 3 and 4 may overlap once Phase 2 lands. **Phase 1 is the phase not to shorten.** If time runs out, **Phase 7 is dropped whole** — the compliance spine is never partially built. CSV work (§9.5) runs continuously from Phase 0.

**Realistic total: 27–34 weeks for one engineer, 18–22 for two.** The judges were right that 55 tables and 22 modules in 28 weeks single-handed is optimistic by roughly 2×; the honest range is stated here rather than discovered in month five.

---

## 12. TOP RISKS AND MITIGATIONS

| # | Risk | Why it is real here | Mitigation |
|---|---|---|---|
| **R1** | **RLS bypassed or forgotten**, one query leaks across tenants | A new table without a policy, or a connection without `SET LOCAL`, silently returns everything | `FORCE ROW LEVEL SECURITY`; app role is not the owner and has no `BYPASSRLS`; `app.tenant_id()` **raises** when unset; a migration test enumerates `pg_class` and fails on any policy-less table; the cross-tenant fuzz suite hits every endpoint on every PR; `SET LOCAL` only, every query inside a transaction, repositories take `tx` |
| **R2** | **Ledger append is a per-tenant serialisation point** | Every business write emits a ledger entry; they queue behind the advisory lock | Entries are batched and written once at the end of the unit of work, not per statement; monthly partitions keep indexes shallow; measured under k6 at 5M entries as a Phase 1 gate. Escape hatch: one chain link over an ordered *set* of entries, cutting lock acquisitions by an order of magnitude while preserving the proof. **Never** async audit writes — that breaks the same-transaction guarantee, which is the point |
| **R3** | **Our own metrology engine puts numbers on certificates** | Rejecting SciPy means every statistical defect is ours; the prototype shipped a wrong df in the floored branch that nobody noticed because no dataset reached it | NIST StRD goldens to certified digits; property tests over random designs; a second independent implementation in a spreadsheet cross-checked as OQ evidence; `stats_engine_version` + `input_digest` persisted so a bad-version recall is a query; synthetic fixtures for every branch; `pnpm stats:approve` as the only path to changing a certified number; a named metrologist reviews `packages/stats` as a release gate |
| **R4** | **PDF/A and PDF/UA claimed but not achieved by Typst** | Typst's PDF/A support is partial and its tagging is not a shipping guarantee | **veraPDF gate fails the render job on non-conformance** — the claim is a test. Ghostscript post-step where needed, then re-validate. If conformance proves unreachable for PDF/UA, the release notes say so and the accessibility claim is scoped to the HTML surfaces — stated, not quietly dropped |
| **R5** | **Reproducibility drifts** on a Typst, font or Ghostscript bump | Re-render fidelity underwrites the whole reissue argument | The reproducibility triple on every issue; all three vendored and hashed into the IQ record; CI re-renders every historical fixture on any bump and fails on an unexplained diff; **the signed original PDF is retained forever**, so a re-render is a convenience, not the source of truth |
| **R6** | **"Match the prototype" preserves its defects** | The transcription strategy that saves months also copies `(a−1)(n−1)`, `lot.prev` as a string, `reissueAck` meaning "notified", the fail-open SoD, render-time budgets | `docs/deviations.md`, read at the start of each phase; golden fixtures annotated at every deliberate divergence; every fix in §3.9 and §9.2 has a named test |
| **R7** | **Signing token becomes an attack surface** | A bearer token that authorises a signature is exactly what an attacker wants | 256-bit, hashed at rest, 120 s, single use, consumed with `DELETE ... RETURNING` inside the business transaction, bound to `{session, person, subject, subject_version, purpose_hash, meaning}` — a token for ST-1001 v3 cannot sign v4 or ST-1002. Rate-limited. Never in a URL or localStorage. Every mint, consumption and rejection is a `SECURITY` entry. The 60-minute cap is a code constant |
| **R8** | **Bitemporal modelling half-done is worse than none** | Three axes across ten dated tables is where "just this once" current-state columns appear and as-at answers silently start lying | One `temporal` module owns all range arithmetic; no module writes a range directly. `EXCLUDE USING gist` makes overlap unrepresentable. `AsOf` is a type-level repository requirement. `LM_ASOF_WRITE` trigger prevents the likeliest corruption. Property test: for any record and d1 < d2 < now, the answer at d1 computed today equals the answer at d1 computed at d2 |
| **R9** | **Validation debt if CSV starts late** | This stack has more qualifiable components than average, and retrofitting IQ/OQ/PQ is the classic multiplier | `make validation` and the RTM generator ship in **Phase 0**, before any domain code. A requirement with no covering test fails the build from day one. The OQ pack is the CI suite with a different runner, so it cannot be "written later" |
| **R10** | **DPDP erasure vs Part 11 / ISO 17034 retention deadlock** | Erasure over contact data that an order line needs to make the holder list computable — wrong either way is a breach or a destroyed trail | `retention_class` is a column, not a document. The erasure workflow is a **decision procedure** per linked class: erase, pseudonymise (keep the relational spine), or refuse-with-reason — and **the refusal artefact citing the retention row is a deliverable of the screen**, not a failure. Legal hold overrides every purge and is audited. Backups inherit the schedule. Dry-run with a diff report before any apply |
| **R11** | **Field apps are offline; the concurrency and signing stories assume a live server** | A dispatch handheld in a cold room and a vault scan in a basement will both be offline, and `If-Match` plus a step-up round trip both require connectivity. This is the one gap that could force a rewrite | Decide now, not in Phase 7: **field capture produces signed, queued, idempotent *intents*, never direct mutations.** An intent carries a client-generated UUIDv7, the observed subject version, a device-bound signature, and a captured timestamp; the server replays it through the normal guard chain and returns accept/reject/conflict. Conflicts surface as a device-side queue the operator resolves. This is the only design decision in the document taken before its phase, because retrofitting it is a rewrite |
| **R12** | **Modular monolith erodes** | 55 tables, 22 modules, a small team, deadline pressure. The prototype's own tenant screen documents a fork producing fourteen duplicated infrastructure functions inside one session | `eslint-plugin-boundaries` with declared allowed edges; one `index.ts` per module; a dependency-graph check failing on undeclared edges; one permission source of truth generated into both the DB reference table and the TS union with a boot check they agree; duplicate-declaration and orphan-permission checks inherited from `build.py` |
| **R13** | **Demo scaffolding leaks into a validated deployment** | `TODAY`, `resetDemo()`, `tamper*()` and the account picker are the prototype's most dangerous inheritance | `SimulatedClock` refuses to construct outside `LOTMARK_ENV=demo`; every entry it touches is `clock_source='simulated'`. Reset is gated by a DB CHECK on `environment_class`. Tamper routes exist only in a demo build target excluded from the release artefact, and **a CI check greps the production bundle for their symbols**. `demo → validation` promotion is prohibited |
| **R14** | **Notification delivery becomes a distributed problem that fails silently** | A withdrawal is a safety notice; an outbox that stalls looks like it worked, which is worse than the prototype's array | Transactional outbox with dedupe keys, delivery receipts, bounce handling, **escalation on unacknowledged withdrawal notices**; depth and age are SLO'd with alerts; `outbox.reconcile` asserts every withdrawal has a dispatched notice per holder org; a preference centre exists but carries a **legal override** — a withdrawal notice is not suppressible |
| **R15** | **Scope: 55 tables, 22 modules, ~40 screens** | The genuine risk. Phase 7 slips and validation gets cut | Phases are independently demonstrable and shippable; `make validation` grows from Phase 0; if time runs out Phase 7 is dropped **whole**; the compliance spine is never partially built. The 27–34 week range is stated up front |

---

## 13. DECISIONS THE USER MUST CONFIRM

Each has a recommendation. Approving this document approves the recommendations unless marked otherwise.

| # | Decision | Options | **Recommendation** |
|---|---|---|---|
| **D1** | Tenancy isolation depth for v1 | (a) Shared schema + RLS; (b) schema-per-tenant; (c) database-per-tenant | **(a)** — with per-tenant Ed25519 keys and per-tenant DEKs for PII, and (c) retained as a deployment topology over identical migrations. This is the estimate's largest single cost swing (+175 PD); (a) captures most of (c)'s value at a fraction of the cost and preserves the exit |
| **D2** | Data residency | (a) Defer the region router until a sovereign customer signs; (b) build three-region routing now | **(a)** — `tenant.data_region` exists in the schema from day one so the hook has somewhere to read from, but the router, per-region migration fan-out and log/backup pinning ship with the first sovereign contract. Building it now is cost with no observable benefit on a laptop |
| **D3** | Query layer | (a) Retain Drizzle; (b) migrate to Kysely | **(a)** — a reviewed schema already exists; migrating is a change-control event nobody has assessed. Migrations stay hand-written SQL either way |
| **D4** | Certificate renderer | (a) Typst + veraPDF gate; (b) headless Chromium; (c) LaTeX | **(a)** — deterministic, 30 MB, vendorable, and the veraPDF gate makes the PDF/A claim testable |
| **D5** | Redis | (a) None; (b) add for rate limits and sessions | **(a)** — lockouts are evidence and must survive a restart; a second durability model is a second backup and restore story |
| **D6** | Worker topology | (a) Separate process by default, `inline` for demo; (b) always inline | **(a)** |
| **D7** | Anchor key custody on localhost | (a) Separate signer process, separate OS user; (b) key file readable by the API; (c) require an HSM in dev | **(a)** — (b) makes the anchor argument worthless; (c) makes localhost impossible. Custody class is reported everywhere so nobody mistakes (a) for an HSM |
| **D8** | Timestamping claim | (a) Development timestamp, PAdES named as a production adapter; (b) claim PAdES-B-LT now | **(a)** — a self-signed dev key cannot satisfy the profile; claiming it is exactly the overclaim being removed |
| **D9** | Field-app offline model | (a) Signed queued intents replayed through the guard chain; (b) direct mutations with `If-Match`; (c) decide in Phase 7 | **(a), decided now** — (c) is a rewrite risk; this is the only pre-phase decision in the document |
| **D10** | Demo reset semantics | (a) Generation retirement; (b) truncate and record the discard | **(a)** — no delete path exists at all, and the ledger stays unbroken across a reset |
| **D11** | Tenant environment promotion | (a) `demo` can never become `validation`; `validation → production` permitted | **(a)** — a demo tenant carries simulated-clock entries and can never be validated, but real tenants provisioned as `validation` retain a trial-to-paid path |
| **D12** | CSV budget | (a) Explicit ≥120 PD line item from Phase 0; (b) absorb into contingency | **(a)** — the workbook has no CSV line at all; retrofitting is the classic blow-up |
| **D13** | Timeline | (a) 27–34 weeks, one engineer; (b) 18–22 weeks, two engineers; (c) the original 28-week single-engineer plan | **(b) if funded, otherwise (a)** — (c) is optimistic by roughly 2× and (a) says so honestly |
| **D14** | Storefront ownership | (a) Ship a reference storefront and publish the five API surfaces; (b) treat the storefront as core product | **(a)** — the wireframe's own core/commodity split, made physical, and the reason a tenant can keep their existing shop |
| **D15** | Statistics review gate | (a) A named external metrologist reviews `packages/stats` before Phase 2 signs off; (b) internal review only | **(a)** — these numbers appear on certificates in customers' GMP files |

---

## 14. OPEN QUESTIONS

| # | Question | Why it matters | Who answers | Needed by |
|---|---|---|---|---|
| **Q1** | Which coverage-factor convention does the target market expect — Welch–Satterthwaite `t(0.975, ν_eff)`, or the ISO Guide 35 convention of `k=2` with ν_eff reported alongside? | Every seeded certificate's U changes. Both are defensible; a producer's existing certificates set the expectation and a change is customer-visible | Metrologist + first customer | Phase 2 |
| **Q2** | Is a real LIMS or QC digital source available at the first customer, or is manual entry the permanent path? | Workbook risk K2 (p=0.7). Determines whether `study_result.source` sees `lims` at all, and whether a manual QC console is a first-class module | First customer | Phase 5 |
| **Q3** | What are the actual order and page volumetrics? The workbook's traffic baseline is formally retracted and orders/yr is a 4k–18k band | Sets the k6 targets, the ledger partition strategy, and whether R2's escape hatch is needed | Customer's existing order table — answerable in minutes | Phase 4 |
| **Q4** | Does the first deployment require an HSM at go-live, or is Vault Transit acceptable? | Changes the `KeyProvider` adapter, the IQ custody class, and procurement lead time | Customer security team | Phase 6 |
| **Q5** | Which RFC 3161 TSA, and is it reachable from the deployment network? | An air-gapped NIC deployment may have no TSA at all, in which case anchors carry a development timestamp permanently and the claim must be scoped | Customer infrastructure | Phase 6 |
| **Q6** | Which Hindi content is authored by the tenant vs shipped by the product? | Determines how much of the `translation` table is seed data and how much is a tenant-authoring screen | First IPC-class customer | Phase 6 |
| **Q7** | Is `certificate_issue.data_snapshot` the retention subject, or the rendered PDF, or both? | Affects retention class bindings, blob lifecycle, and the size of the ledger archive over ten years | Quality function | Phase 3 |
| **Q8** | Should `denial_ledger` be exported in the assessment pack, or is it internal security telemetry? | A refusal is evidence of a working control, but a stream of denials also reads as an access-review finding | Quality function | Phase 5 |
| **Q9** | What is the acceptable clock-offset threshold above which signing is refused? | Too tight and a laptop demo fails; too loose and the traceable-clock claim weakens | Metrologist + IT | Phase 1 |
| **Q10** | Does the metrological traceability chain need to be modelled as data — which CRM or primary standard each characterisation result is traceable to, that standard's own certificate and validity — or is a traceability *statement* sufficient? | **The panel identified this as a gap in all three proposals.** If a reference standard's certificate is withdrawn by its issuing NMI, the blast radius is identical to an expired calibration, and no design here can compute it. Modelling it extends Closure 1 by one hop and adds ~3 tables | Metrologist + accreditation body expectations | **Phase 2 — the answer changes the schema** |
| **Q11** | Is this a closed system or an open system under 21 CFR 11 §11.30? The public verification endpoint and the customer portal arguably make parts of it open | Open systems require additional controls (encryption, digital signature standards) beyond §11.10 | Regulatory affairs | Phase 3 |
| **Q12** | Is a §11.10(i) *training* record needed distinct from competence authorisation — "trained on this system version" as opposed to "authorised for this activity"? | A separate Part 11 requirement and a separate ISO 17034 §6.2 one; competence answers only the second. Adds a `training_record` table and a system-version dimension | Quality function | Phase 5 |

---

## 15. THE ONE-PARAGRAPH VERSION

Postgres 17 is the compliance engine, not the storage layer: row-level security with `FORCE` and a non-`BYPASSRLS` application role gives tenant isolation the code cannot forget; `daterange` with GiST exclusion constraints makes overlapping competence and calibration windows unrepresentable; per-table grants plus triggers make append-only a database property; and the sixteen prototype invariants become constraints whose negative tests are the OQ scripts. On top sits a two-layer ledger — an in-database SHA-256 chain over a length-prefixed payload covering every field including `seq` and `tenant_id`, and a five-minute Merkle anchor signed with **Ed25519 by a separate signer process the API cannot read**, stored outside the database, which is the only thing that survives a database compromise or a truncating restore and converts data loss into a bounded, provable, CAPA-raising gap. Signatures are Ed25519 over canonical material that finally includes digests of the raw study results and the frozen uncertainty components, minted exclusively by a signing service that consumes a single-use, subject-and-version-bound step-up token inside the business transaction — so all six signature-bearing acts, including withdrawal, carry a real ceremony. Around that: a TypeScript modular monolith on Fastify with the prototype's policy code transcribed into a decision point **called by the use case, not by HTTP middleware**, refusing to boot if any SoD rule lacks a subject loader or any permission lacks an enforcer; three React bundles including a server-rendered, JavaScript-free public verifier; Typst rendering certificates **behind a veraPDF conformance gate**, asynchronously, so a renderer failure never blocks issuance; and pg-boss jobs turning every "someone presses a button" in the prototype into a scheduled, audited, idempotent obligation. The whole thing starts with `make dev` — one Node process group, one pinned Postgres container, entirely offline, with a seed that *executes* the prototype's estate through the real services rather than asserting it — and it prints its own Installation Qualification record, runs its own Operational Qualification, and generates its own traceability matrix from three machine-readable sources, because in this domain evidence you cannot execute is not evidence.