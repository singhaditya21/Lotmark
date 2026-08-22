# LOTMARK — DEPLOYMENT

**How to run this system for a real reference material producer, in the order the work has to happen.**

Date: 22 August 2026 · Basis: the working tree, verified by reading and running it

---

## 0. READ THIS FIRST

**This system has never been deployed anywhere.** Everything in this repository has only ever run on one laptop, against one PostgreSQL cluster, with one demonstration tenant seeded from a prototype. There is no Dockerfile, no compose file, no systemd unit, no Kubernetes manifest, no Helm chart and no Terraform — I looked for all of them. The CI workflow (`.github/workflows/ci.yml`) tests and qualifies; it never builds or publishes a deployable artefact.

So this is a plan, not a runbook that has been executed. Where it says "do X", nobody has done X here yet. §10 lists everything that is not ready, without softening, and you should read §10 before §1 if you are deciding whether to deploy at all.

Two things about the system's temperament that will save you hours:

**It fails closed, loudly, in production only.** `apps/api/src/config.ts` carries **seven** refusals that exist only when `NODE_ENV=production` — six `throw` sites, the last of which is a loop over two directories and produces two messages with two different fixes. A deployment that exports `NODE_ENV=production` and nothing else hits three of them, one at a time, in this order: the audit key, then the signing-key custody class, then `PUBLIC_ORIGIN`. This is deliberate — the refusals guard things that cannot be undone once done, like a certificate printed with a verification address pointing at a developer's laptop — but an operator who does not know it will conclude the software is broken. §5 is that list, in the order the code evaluates it, which is not the order the table is easiest to read in.

**It fails closed, silently, at the database.** All 51 ordinary tables in the `lotmark` schema are under `FORCE ROW LEVEL SECURITY`; `lotmark_meta.schema_migrations` is deliberately outside it, so the installation history survives dropping and rebuilding the schema. A `psql` session with no tenant set sees zero rows from every one of the 51 — including as the schema owner, which is what FORCE means, **provided the owner is not a superuser**. On the only machine this has ever run on the owner *is* a superuser and sees every row, which is a separate problem (§3.2). Two components in this repository's own history reported catastrophes that had not happened because of exactly this. §3.5 says what to do about it.

---

## 1. TOPOLOGY

### 1.1 What runs

| # | Component | Command | Shape | Runs as | Connects as |
|---|---|---|---|---|---|
| 1 | **API** | `pnpm --filter @lotmark/api start` | long-lived, HTTP | `lotmark-api` | `DATABASE_URL` → `lotmark_app` |
| 2 | **Worker** | `pnpm --filter @lotmark/api worker` | long-lived, no port | `lotmark-api` | queue on `DATABASE_ADMIN_URL`, work on `DATABASE_URL` |
| 3 | **Console** | built by `pnpm --filter @lotmark/web build`, served from `apps/web/dist` | files, served by the proxy | — | — |
| 4 | **Anchor signer** | `pnpm --filter @lotmark/api anchor` | periodic command | `lotmark-signer` | `DATABASE_SIGNER_URL` → `lotmark_signer` |
| 5 | **DR drill** | `pnpm --filter @lotmark/api dr:drill` | periodic command | backup operator | `DATABASE_ADMIN_URL` → owner, which needs `CREATEDB` (§8.3) |
| 6 | **Prober** | `./node_modules/.bin/tsx apps/api/scripts/prober.mts` | periodic command, **different machine** | ops host | `lotmark_probe` |
| 7 | **PostgreSQL 16** | — | the database | — | — |
| 8 | **Reverse proxy + TLS** | — | one public origin | — | — |

**Component 3 does not exist until you build it.** `apps/web/dist` is gitignored (`.gitignore:6`) and is produced by exactly one command, which appears nowhere else in this repository's tooling and is not run by CI:

```bash
pnpm --filter @lotmark/web build
```

That is `tsc -b && vite build` (`apps/web/package.json:8`). I ran it: it emits `dist/index.html`, `dist/assets/index-<hash>.js` (392 kB, 111 kB gzipped) and `dist/assets/index-<hash>.css`. The asset references in `index.html` are **absolute** (`/assets/…`), so the proxy must serve `dist` at the origin root and not under a sub-path. The root `pnpm build` (`pnpm -r build`) reaches the same script and nothing else — `@lotmark/api` has no `build`. Build it on a machine with the dev dependencies installed; see §10 item 9 before you decide that machine is the production host.

The OS user names are illustrative; the names are yours to choose. What is **not** a choice is that the anchor signer runs as a different OS user from the API, with a key directory the API cannot read — see §2.5. `config.ts` checks that the directories differ; nothing checks that the permissions do, and the permissions are the control.

Components 4, 5 and 6 are not daemons. Nothing in this repository schedules any of them; you schedule them. §7 and §8 say how often and why.

**The API and the worker are two processes and there is no way to make them one.** `apps/api/src/worker.ts` is explicit about it:

> By running THIS FILE, and by nothing else. There is no in-process switch: the API never constructs a Scheduler, so an API process runs no jobs regardless of how it is configured.

There used to be a `RUN_SCHEDULER` environment variable. It was parsed by `config.ts` and read by nothing, so an operator who set it got an API that ran no scheduled jobs and no indication of the fact. The setting was deleted rather than implemented. If you deploy only the API, none of §6.3's five jobs ever run and the only symptom is a screen nobody looks at.

### 1.2 Do not deploy with the root scripts

`package.json` at the root defines `pnpm api`, `pnpm worker`, `pnpm job` and `pnpm anchor`. All four set `NODE_ENV=development` themselves. They are the local demonstration. The package-level entry points (`pnpm --filter @lotmark/api start` and `worker`) deliberately state nothing, because a deployment has to say what it is. `.env.example:21` ends the paragraph on it with a flat instruction: **"Do not use the root scripts to deploy."**

### 1.3 The console and the API must share one origin

The console calls the API with a relative path and `credentials: 'same-origin'` (`apps/web/src/lib/api.ts:62-66`). The session cookie `lm_sid` is set `httpOnly`, `sameSite: 'lax'`, `secure` in production (`apps/api/src/app.ts:117-127`). In development, Vite proxies `/api` to the API so the browser sees one origin (`apps/web/vite.config.ts:17-19`).

`SameSite=Lax` is currently **the only CSRF defence in the product**. There is no CSRF token and no `Origin`-header check anywhere in `apps/api/src`. `docs/architecture/ARCHITECTURE.md:909` specifies a `__Host-` cookie, `SameSite=Strict`, an Origin check and a double-submit token; none of that is built. That makes "one origin" a security property, not a convenience.

Three options, and they are not equal:

| Option | What it costs | Verdict |
|---|---|---|
| **A. Reverse proxy in front of both** | Configuration only. No code change. | **Recommended.** |
| **B. Console and API on separate origins** | `credentials: 'include'`, an absolute API base URL, `sameSite: 'none'` — three code changes — plus a CORS layer that does not exist (`@fastify/cors` is in no `package.json`), and it removes the only CSRF defence rather than weakening one. | Reject. |
| **C. API serves the built console** | A CSP rewrite. `app.ts:105-113` sets `default-src 'none'` and declares no `connect-src`, so every `fetch('/api/v1…')` from a co-served page is blocked; `style-src` is `'unsafe-inline'` with no `'self'`, so the bundle's stylesheet is blocked too. (Verified against helmet 8.3.0, whose defaults contain no `connect-src`.) Also needs `@fastify/static` and an SPA fallback, neither of which exists. | Defensible later. Not now. |

**Option A, concretely.** One TLS origin — say `https://certificates.example.org` — routing:

| Path | Destination | Why it matters |
|---|---|---|
| `/api/*` | API :4000 | the console's only call path |
| `/verify/*` | API :4000 | **the one people forget** — see below |
| `/health/live`, `/health/ready` | API :4000 | the prober fetches these at the public origin |
| everything else | `apps/web/dist` (build it — §1.1), SPA fallback to `index.html` | the console |

**The `/verify/*` rule is not optional and nothing checks it for you.** Every certificate's footer prints `<origin>/verify/<token>`, and the origin comes from the issue's stored snapshot: `certificate-pdf.ts:290` prints `s.verificationOrigin`, which `certificate-issue.ts:102` freezes into `data_snapshot` from what the issuing route passed — `cfg.PUBLIC_ORIGIN`, at `routes/lots.ts:433` and `routes/certificates.ts:432`. (The `verifyUrl` fields at `lots.ts:476` and `certificates.ts:482`, and `verifyOrigin` at `commerce.ts:702`, are JSON for the console. They are not what reaches the paper — that distinction is why this was wrong once already; see §2.1.)

That route is served by the API (`apps/api/src/routes/public.ts:35`, registered with an empty prefix at `app.ts:222`). The development proxy covers `/api` **only**, so on the Vite origin `/verify/<token>` returns the console's `index.html` via SPA fallback rather than the verification page — and the console has no client-side router that would handle it. `config.ts` refuses a loopback `PUBLIC_ORIGIN` in production, but nothing anywhere checks that the configured origin actually routes `/verify/*` to the API. If you get this wrong, every certificate you print carries an address that returns a blank console to an auditor. Make it a post-deploy smoke check (§5.4).

### 1.4 Where the processes live: an open choice

Nothing in the repository decides this. Two workable shapes:

**Systemd units on one host.** The product's own deployment model is one producer per instance (`apps/api/src/services/tenancy.ts:22-27`: "The natural unit of deployment is one producer, which is also the unit CERT-In cares about for data residency"). One host running Postgres, the API, the worker, the signer under its own user, nginx or Caddy in front. No orchestration to learn, and the three-OS-user separation §3 requires falls out naturally. **Recommended for the first deployment**, because it is the smallest thing that satisfies every constraint in this document.

**Containers.** Needs a Dockerfile that does not exist, and there is a trap: `apps/api` has no `build` script, `start` is `tsx src/main.ts`, and `tsx` is a **devDependency** in all three manifests that run one (`apps/api/package.json:49`, `packages/db/package.json:32`, root `package.json:31`). An image built with `pnpm install --prod` loses far more than the entry point — every operator command in this document is a `tsx` script. §10 item 9 enumerates them and gives the remedy; decide it before you write the Dockerfile, not after. The three-user separation also has to be reconstructed as three images or three security contexts — a single container running the API and the signer defeats the control §3.2 exists for, and `config.ts` will not catch it because it only compares directory paths.

Whichever you pick, the signer must not be able to be read by the API, and vice versa. That is an OS-level property, not a configuration one.

---

## 2. DECIDE BEFORE THE FIRST BOOT

Three of these cannot be changed cheaply afterwards. Decide them on paper first.

### 2.1 `PUBLIC_ORIGIN` — printed on paper, cannot be recalled

This is not a setting. It is a promise printed on every certificate, telling a third-party auditor where to verify it. `config.ts:263-271` says so directly, and the refusal message says a printed certificate cannot be recalled.

**How it actually reaches the paper, because the answer changes what you can undo.** `PUBLIC_ORIGIN` is read once, at issue time, by the route that issues the certificate; it is written into the issue's frozen `data_snapshot` as `verificationOrigin`; and the renderer prints that snapshot field (`certificate-pdf.ts:290`). It is **not** read from configuration at render time, deliberately — `certificate-pdf.ts:118-134` gives the reason: a certificate is re-rendered years later, by the DR drill and by anyone checking a stored digest, and a value fetched live would make the bytes depend on today's environment rather than on what was issued.

Two consequences an operator has to hold at once:

- **A certificate re-renders under the origin it was ISSUED under, not today's.** Changing `PUBLIC_ORIGIN` does not retroactively alter anything already printed, and it must not — the stored digest would stop matching. It changes only what the next issue carries. So a domain move splits your issued certificates into two populations, each pointing where it pointed on the day it was signed, and both have to keep resolving.
- **There is a third population.** Until renderer version `lotmark-pdf-3` the footer was a hard-coded `http://localhost:5173/verify/<token>`. Any certificate carrying `lotmark-pdf-2` or earlier has that footer on the paper, has no `verificationOrigin` in its snapshot, and **is not re-rendered by the DR drill at all** — `dr-drill.mts:316` filters re-rendering to the current `RENDERER_VERSION`, because a renderer change legitimately changes the bytes. Those issues are covered by the stored-digest check and by nothing stronger. If any exist in a database you are deploying, they cannot be fixed by configuration; they have to be reissued.

Pick the origin you will still own in ten years. Certificates carry a ten-year retention floor (`electronic_signature`, `certificate_issue`: 3650 days — §9.2). A certificate issued today pointing at an origin you give up in three years is a certificate whose verification address is dead for seven.

It must be `https` in practice, because `secure: true` engages on the session cookie automatically in production (`app.ts:125`), which makes TLS mandatory for the console anyway.

### 2.2 Signing key custody — in practice there is exactly one choice

Five classes are declared. Two orthogonal tables decide what you may use (`services/custody.ts:441-455`):

| Class | Production-grade | Implemented in this build | Usable in production |
|---|---|---|---|
| `dev_file` | no | yes | no |
| `env` | **yes** | **yes** | **yes** |
| `keychain` | no | macOS only | no |
| `kms` | yes | **no** | no |
| `hsm` | yes | **no** | no |

The intersection is `env`, and nothing else. `kms` and `hsm` are marked production-grade-but-unimplemented on purpose: their constructor throws, so no certificate can carry a custody class this build cannot back. The class is **printed on every certificate**, which is why it is checked at boot rather than trusted.

`SIGNING_KEY_CUSTODY=env` means the private key is the **base64 of a PKCS#8 PEM**, in an environment variable, one per tenant per key version. The name is derived, not chosen (`custody.ts:124-128`): `LOTMARK_SIGNING_KEY_` followed by `<tenantId>_<keyVersion>` with every non-alphanumeric replaced by `_`, uppercased. For a tenant `3f2b9c14-7d58-4a61-9e03-8c5b2a17d6f4` and the record key version `rec-v1`:

```
LOTMARK_SIGNING_KEY_3F2B9C14_7D58_4A61_9E03_8C5B2A17D6F4_REC_V1
```

**And here is the part a plan must not paper over: the system cannot create that key for you.** `EnvCustody` is read-only by construction, and both documented paths to a first key run into it:

- **First-boot minting fails.** `KeyProvider.active` registers a new key in `signing_keys` and then calls `minting.write(...)` (`services/keys.ts:201`), which for `env` throws `Cannot write a signing key into the environment.` The transaction rolls back, so the tenant never acquires a record key. This is not a boot failure — the API starts fine and it surfaces as a 500 on the first act that needs a signature.
- **`custody:move --to env` fails too.** `scripts/move-custody.mts:109` calls `target.write(...)`, same throw, at step 2 of a 5-step procedure. The advice inside the refusal — "generate the key under another custody class and move it" — does not work for `env` as a destination.

So the key has to be generated out of band and registered by hand. There is no script for this in the repository. `FIRST-TENANT.md` in this directory is the procedure, with the exact commands.

### 2.3 The audit key, and its generation label

`LOTMARK_AUDIT_KEY` is the HMAC key for the append-only ledger. It lives outside the database on purpose (`config.ts:41-48`): an attacker with SQL access must not also hold the key, or the chain proves nothing. It is set transaction-locally on every write (`db.ts:123-129`), and the append trigger refuses without it:

> `lotmark.audit_key is not set on this session; refusing to append an unverifiable ledger entry`

Minimum 16 characters. Production refuses the published default. Generate it with a real random source and deliver it through a secrets mechanism, never a file beside the database and never in the database:

```bash
openssl rand -base64 32
```

`LOTMARK_AUDIT_KEY_GENERATION` (default `v1`) is **a commitment, not a label**. Migration 0019 binds each generation to `key_check = HMAC('lotmark-audit-key-check:<tenant>:<generation>', key)`, registered on first use. Setting the wrong generation with a valid key is worse than a boot failure — the process starts, and then every audited write fails at runtime with:

> `the audit key offered does not match the key registered for generation %. Either the wrong key is set on this session, or an attempt is being made to write history under a key of the writer's own choosing`

Decide the label once, per deployment, and record it beside the key in your secrets manager. Rotation is a separate, deliberate procedure (§8.5).

Note a scope quirk worth knowing: the default-key refusal fires only when `NODE_ENV === 'production'`, even though its message says "outside development". `NODE_ENV=test` on the published default is permitted.

### 2.4 The proxy's address

`req.ip` is written against every act in the 21 CFR 11 audit ledger and keys rate limiting. Whoever can set `X-Forwarded-For` therefore chooses what the audit trail says about them. `TRUST_PROXY` is how you decide who that is:

| Value | Meaning |
|---|---|
| `false` (default) | trust nothing; use the socket address. Correct if nothing is in front of the API. |
| `10.0.0.7` / `10.0.0.0/24` / a comma-separated list / `loopback`, `linklocal`, `uniquelocal` | trust exactly these |
| `true` | **refused in production** |
| any number | **refused everywhere** |

With Option A you have a proxy, so `TRUST_PROXY=false` would write the proxy's address into every ledger entry — silently wrong rather than loudly wrong. Name the proxy. A hop count is refused everywhere because Fastify 5.12.1 accepts one and then behaves exactly like `false`; accepting the form would let you configure proxy trust, believe you had it, and get none.

### 2.5 Three directories, three OS users

| Setting | Default | Held by | Contains |
|---|---|---|---|
| `SIGNING_KEY_DIR` | `.keys` | the API user | record signing keys (unused under `env` custody, but still checked) |
| `ANCHOR_KEY_DIR` | `.keys-anchor` | **the signer user** | the anchor key |
| `DOCUMENT_DIR` | `.documents` | the API user | rendered certificates |

Production refuses to boot if `SIGNING_KEY_DIR` overlaps either of the other two — same path, or one nested in the other. A shared prefix (`.keys` / `.keys-anchor`) is not an overlap.

The check is only about paths. **The property it exists for is filesystem permissions, and nothing enforces that.** The API must be unable to read the anchor key, or the anchor's attestations about the API's own ledger attest to nothing. Give the signer its own OS user and a directory mode 0700 owned by it. Use absolute paths in production; the defaults are relative and resolve against the process's working directory.

### 2.6 Versions, and the binaries this code shells out to

Pin them. The repository does not.

| | What the repo says | What to do |
|---|---|---|
| Node | root `package.json` says `>=22`; CI pins 22; there is no `.nvmrc` and no `.tool-versions` — I looked. The machine this was developed on runs 26.4.0, so the two versions the code has actually been exercised under are 22 (CI) and 26 (here), and nothing records which one you get | pin one version in the unit file or image and record it in the IQ record |
| PostgreSQL | CI pins `postgres:16`, "to match what the IQ protocol asserts and what the schema uses (generated columns, `WITH (FORCE)` on DROP DATABASE, jsonb paths)" | 16 or later; IQ asserts `>= 16` |
| pnpm | `packageManager: pnpm@9.15.9` | honour it; there is no npm here |
| `pgcrypto` | IQ asserts the extension is installed — the audit chain HMAC needs it | install it in the target database |

**Host binaries, which no part of this repository declares and several parts require.** A missing one is not a boot failure; it is a command that dies mid-procedure, in one case mid-backup.

| Binary | Needed by | Constraint |
|---|---|---|
| `pg_dump`, `pg_dumpall`, `pg_restore`, `createdb`, `dropdb` | `dr:backup`, `dr:drill`, `dr:sabotage` — all five are `execFileSync` calls in `dr-drill.mts` (`:99`, `:126`, `:175`, `:177`, `:190`) | **client major version ≥ the server's** — PostgreSQL's own rule, which nothing here checks: an older `pg_restore` cannot read a custom-format archive written by a newer `pg_dump`, and a 15 client against a 16 server is the shape this goes wrong in. Install the client package that matches your server major, on the host that runs the drill — which is not necessarily the database host |
| `psql` | every support and verification procedure in §3.5, §8 and `FIRST-TENANT.md` §6 | same |
| `openssl` | generating `LOTMARK_AUDIT_KEY` (§2.3) and the record signing keypair (`FIRST-TENANT.md` §4) | any version with `genpkey -algorithm ed25519` — OpenSSL 1.1.1 or later |
| a JRE, plus the `verapdf` binary | `pnpm --filter @lotmark/api pdfa` only | `verapdf-gate.mts:78` looks for it at `verapdf` on `PATH`, `$HOME/verapdf/verapdf`, then `/usr/local/bin/verapdf`. Without it the gate prints `PDF/A CONFORMANCE IS UNVERIFIED` and still exits 0; `--require-verapdf` makes its absence a failure. Not needed to run the product — needed to make the PDF/A claim (§9.5) |

The DR drill also needs a database privilege the rest of the system does not: see §8.3.

---

## 3. THE DATABASE

### 3.1 Roles

Four principals. Three are login roles the migrations create; the fourth is the schema owner, which you must create yourself.

| Role | Created by | Holds | Must NOT be |
|---|---|---|---|
| **owner** (schema owner) | you / your DBA | DDL, `TRUNCATE`, the `pgboss` schema | — but see §3.2 |
| `lotmark_app` | `0005_app_role.sql:24` | `USAGE` on schema; `SELECT/INSERT/UPDATE/DELETE` on tables; sequences; `EXECUTE` on functions; **no DDL** | superuser, `BYPASSRLS`, or the owner |
| `lotmark_signer` | `0012_audit_anchoring.sql:156` | `SELECT` on `audit_ledger`, `audit_head`, `tenants`, `signing_keys`; `SELECT/INSERT` on `audit_checkpoints` and `audit_checkpoint_exports`; `INSERT` on `signing_keys` (anchor purpose only); a short list of functions | superuser, `BYPASSRLS`, or able to call `provision_tenant` |
| `lotmark_probe` | `0034_probe_role.sql:69` | `USAGE` on schema and `EXECUTE` on exactly one function, `lotmark.ops_probe_summary()`. **No table privileges at all.** | anything more |

Why `lotmark_app` must not be a superuser, in one sentence from `0005_app_role.sql:4-12`: a superuser bypasses row-level security unconditionally, FORCE included, so an application connecting as one has no tenant isolation — and the isolation would look fine in development and first apply in production.

Why it must not be the owner either: FORCE RLS subjects the owner to policies, but the owner can still `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, drop triggers and drop CHECKs. Append-only is enforced twice on `audit_ledger`, `signatures` and `state_transitions` — by trigger *and* by revoked grant — so that a dropped trigger does not silently open a delete path. That argument only holds if the application is not the owner.

Two structural facts about `lotmark_signer` worth carrying into a security review: the application **loses** `INSERT` on `audit_checkpoints` when the signer gains it, because a component that writes the ledger and also signs statements about it attests to nothing; and the signer is refused `EXECUTE` on `provision_tenant` by an explicit `REVOKE … FROM PUBLIC` issued *before* the role is created — Postgres grants function `EXECUTE` to `PUBLIC` by default, and schema `USAGE` was the only thing gating it.

**Roles carry no passwords.** All three are created `LOGIN` with no secret, because role creation is cluster-level and a migration should not mint credentials. `0005:22-23` and `0034:66-68` both say a deployed instance grants `LOGIN` with a real secret out of band. That out-of-band step exists nowhere in this repository — it is yours to design, and `.env.example` does not mention the prober's connection at all.

Either give the migration owner `CREATEROLE`, or pre-create the three roles as your DBA; each migration wraps its `CREATE ROLE` in an idempotent `DO` block so both paths work.

### 3.2 Give the schema a non-superuser owner

On this development machine the `lotmark` schema is owned by `adityasingh`, which is `rolsuper=t, rolbypassrls=t`, and all 33 recorded migrations show `applied_by = adityasingh`. I measured this. It means **FORCE-RLS-against-the-owner — the exact property migration 0004 was written for — has never been exercised here.**

Two consequences for you:

- Create a dedicated, non-superuser, non-`BYPASSRLS` owner role for the `lotmark` schema. It needs `CREATEROLE` only if you want it to create the three login roles, and `CREATEDB` if it is also the principal that runs the DR drill — which creates and drops a scratch database on the same cluster (§8.3).
- **Expect migration DML over tenant-scoped tables to behave differently than it did in development.** `ALLOCATION.md:34-41` raises this about migration 0020's backfill: under the superuser owner used here the backfill works, "but under the non-superuser owner that migration 0005 describes, it would match **zero rows and report success**." Any future migration containing DML over a tenant-scoped table inherits that hazard. Verify row counts after any such migration rather than trusting its exit code.

A related trap: `0005:38-41` sets `ALTER DEFAULT PRIVILEGES` so that future tables inherit the app grants — but default privileges apply only to objects created by the role that issued the statement. If a later deployment migrates under a *different* owner role, tables created after that point will not inherit the grants and the application will get permission errors on new tables only.

### 3.3 Migrations

Runner: `packages/db/src/migrate.ts`. Files in `packages/db/migrations`, sorted lexically, each required to start with a four-digit prefix. Each file is SHA-256'd; the record lives in `lotmark_meta.schema_migrations` (filename PK, checksum, applied_at, applied_by, duration_ms), deliberately outside the `lotmark` schema so that dropping and rebuilding that schema in development does not erase the installation history. Each migration runs in its own transaction with its bookkeeping insert, so a failure leaves earlier migrations applied and recorded.

Two hard refusals, never warnings:

> `Migration '<file>' has changed since it was applied.` … `The database is not what this code believes it is. Refusing to continue.` `Either restore the file, or write a NEW migration that makes the change.`

> `Migration '<file>' was applied to this database but is missing from <dir>.` `A migration cannot be un-applied by deleting it. Refusing to continue.`

All already-applied files are verified **before** anything new runs, because detecting a tampered migration after applying three more is not much of a detection.

Things a deployment must respect:

- **Checksums key on the filename.** Renaming an applied migration is unrecoverable. Numbers are allocated in `ALLOCATION.md` before files are written, and withdrawn numbers (0023, 0031) are retired rather than reused.
- **0031 is a live hazard for any database that ever saw it.** It was written, applied and reverted within an hour. The 33 rows in this development database are 0000–0034 with 0023 and 0031 absent, so nothing here is wedged — but a database that ever recorded `0031_signature_algorithm_known.sql` will refuse *every* migration until that row is dealt with deliberately.
- **The runner takes no advisory lock.** Two concurrent deployers would both read the recorded set and race on the same file. Run migrations from exactly one place, and make that a property of your deploy pipeline rather than a convention.
- **Nothing verifies schema state at boot.** `main.ts` is 19 lines; `app.ts` never mentions `schema_migrations`. A partially migrated database will start the API cleanly and fail at request time. Your deploy gate is the migrator's exit code plus `migrate:status`, not the API coming up.

### 3.4 The `DATABASE_URL` collision — read this before running the migrator

`migrate()` defaults its connection to `process.env.DATABASE_URL ?? ADMIN_URL`, and `ADMIN_URL` is the hard-coded literal `postgres://localhost:5432/lotmark_dev`. In a deployment `DATABASE_URL` is the **application** role, which by design cannot do DDL. So running the migrator inside the API's own environment attempts the entire schema as `lotmark_app` and fails on the first `CREATE`. The migrator has no `DATABASE_ADMIN_URL` support and no comment acknowledging the collision.

Run it with `DATABASE_URL` explicitly pointed at the owner, and nothing else from the API's environment:

```bash
DATABASE_URL='postgres://lotmark_owner@db.internal:5432/lotmark' pnpm --filter @lotmark/db migrate
```

Then confirm:

```bash
DATABASE_URL='postgres://lotmark_owner@db.internal:5432/lotmark' pnpm --filter @lotmark/db migrate:status
```

Order, and it is not negotiable: **(1)** roles exist → **(2)** migrations run to completion as the owner → **(3)** the API and worker start.

### 3.5 Row-level security, and what it means at a `psql` prompt

51 ordinary tables in the `lotmark` schema. All 51 have RLS enabled **and** forced — I counted. One `tenant_isolation` policy per table covers every command with both `USING` and `WITH CHECK`, because a read-only policy would happily let a row be written into another tenant. `lotmark.current_tenant()` returns NULL when the GUC is unset or malformed, which makes every policy match nothing. Failing closed is deliberate: a forgotten context returns no rows rather than erroring, which surfaces in testing, whereas failing open surfaces as a data breach.

On top of that, migration 0022 adds **RESTRICTIVE** organisation policies to `orders`, `order_lines`, `entitlements`, `shipments`, `logger_readings`, `vault_holdings` and `notifications`, keyed on `lotmark.organisation_id` and `lotmark.organisation_kind`. These also fail closed.

Four things a support engineer must know before opening `psql` against this database:

1. **An empty result is the default state, not evidence.** `SELECT * FROM lotmark.lots` as `lotmark_app` returns **zero rows** until the session sets a tenant. The same is true of the schema owner — that is what FORCE adds — **but only if the owner is neither a superuser nor `BYPASSRLS`**, which is the owner §3.2 tells you to create and is *not* the owner this repository has ever run under. Measured on `lotmark_dev` as it exists today: as `lotmark_app`, 0 rows; as `adityasingh`, the superuser owner, 3 rows. So a support engineer who reads this section, connects to the development estate as the owner, and sees rows has not disproved RLS — they have demonstrated point 3. Check `rolsuper` and `rolbypassrls` for the role you are connected as before you conclude anything from a row count. This has already produced two confidently wrong conclusions in this codebase's own history: the prober reporting "no tenant has ever recorded a sweep" against a database holding a 90-second-old sweep and five open alerts, and the DR drill reporting every single table mismatched after a perfectly good restore. Someone who does not know this will diagnose data loss that has not happened.

2. **A support session must set its context explicitly.** `lotmark.tenant_id` always. `lotmark.organisation_kind = 'producer'` (or an `organisation_id`) to see anything commercial. `lotmark.audit_key`, and `lotmark.audit_key_generation` if you are not on `v1`, before **any** write to an audited table. And `lotmark.as_of` must be unset, or the read-only trigger refuses every write with `read_only_sql_transaction`.

```sql
SELECT set_config('lotmark.tenant_id', '<tenant-uuid>', false),
       set_config('lotmark.organisation_kind', 'producer', false);
```

3. **Connecting as a superuser is not a shortcut, it is a different security posture.** A superuser or any `BYPASSRLS` role ignores RLS entirely, FORCE included, so the session sees and can write across every tenant, and the grants that make the ledger append-only do not apply either. The append-only triggers still fire — but a superuser can disable them. Any cross-tenant support query should be a deliberate, logged, time-boxed act with a named human attached, not the default way support connects.

4. **`lotmark_reader` does not exist.** It is discussed at length in `docs/architecture/JOBS-ASOF-SPEC.md` and `JOBS-ASOF-REVIEW.md`. There is no `CREATE ROLE lotmark_reader` anywhere in the migrations. Do not put it in an access-control document as an existing role.

### 3.6 Creating a real tenant — the seed refuses, and the alternative is incomplete

`pnpm --filter @lotmark/db seed` refuses production before it opens a connection:

> `The seed refuses to run with NODE_ENV=production.`
> `It TRUNCATEs every table, including lotmark.audit_ledger — the append-only record that 21 CFR 11 §11.10(e) exists to protect, and which no application role is granted the privilege to touch.`
> `It then creates nine demonstration accounts sharing one password that is printed in this file and one authenticator secret.`

The guard is code and not a runbook entry for a stated reason: "the difference between seeding the demo and destroying a producer's records is one shell that had the wrong `DATABASE_URL` exported."

The refusal then points at `lotmark.provision_tenant` plus the admin API. **That path is not complete, and the plan should say so rather than repeating the message as though it were a procedure.** I checked all of it:

- `provision_tenant` inserts a `tenants` row and nothing else — no organisation, no configuration version, no user.
- The only `INSERT INTO lotmark.organisations` outside tests is in the seed. There is no route that creates one.
- `POST /admin/users` requires a live session holding `user:manage`, and an `organisationId` that must already exist in the tenant. Granting a role reads the **active configuration version**, which a fresh tenant does not have.
- **No route and no script anywhere calls `provision_tenant`** — only the seed and the test suite.

So the first tenant is a hand-run provisioning step. `FIRST-TENANT.md` in this directory is the ordered procedure with commands, including the signing-key registration that §2.2 says has no script.

---

## 4. THE ENVIRONMENT

There is **no dotenv anywhere in this repository**, on purpose: "a process that silently picks up a file it happens to be standing next to is a process whose configuration you cannot read off its unit file." Configuration comes from the unit file, the container environment, or the secrets manager. `.env.example` is a reference, and nothing reads it.

### 4.1 Everything `loadConfig` parses

| Variable | Required | Default | Production consequence of getting it wrong |
|---|---|---|---|
| `NODE_ENV` | **yes, no default** | — | unset ⇒ boot refusal. Every production check is gated on it. |
| `HOST` | no | `127.0.0.1` | **unchecked, and a live deployment trap** — see §4.3 |
| `PORT` | no | `4000` | — |
| `DATABASE_URL` | effectively | `postgres://lotmark_app@localhost:5432/lotmark_dev` | not validated and not connected eagerly: a wrong value boots cleanly and fails on the first query |
| `DATABASE_ADMIN_URL` | worker + drill | `postgres://localhost:5432/lotmark_dev` | wrong ⇒ the worker cannot start pg-boss; the API is unaffected |
| `DATABASE_SIGNER_URL` | signer | `postgres://lotmark_signer@localhost:5432/lotmark_dev` | if it is the same role as `DATABASE_URL` the anchor attestation is worthless — **and nothing enforces that**; only directory separation is checked |
| `LOTMARK_AUDIT_KEY` | **yes in prod** | `dev-audit-key-change-me`, min 16 | boot refusal on the default; under 16 chars is a config error |
| `LOTMARK_AUDIT_KEY_GENERATION` | no | `v1` | wrong-but-nonempty ⇒ every audited write 500s at runtime, not at boot |
| `LOTMARK_AUDIT_KEYS` | no | — | **not validated as JSON at boot**; malformed JSON surfaces from Postgres as `lotmark.audit_keys is not valid JSON` when someone verifies. Also not an active line in `.env.example` — §4.2 |
| `SIGNING_KEY_CUSTODY` | **yes in prod** | `dev_file` | the default is refused in production |
| `SIGNING_KEY_DIR` | no | `.keys` | overlap check |
| `ANCHOR_KEY_DIR` | no | `.keys-anchor` | overlap check |
| `DOCUMENT_DIR` | no | `.documents` | overlap check |
| `KEYCHAIN_SERVICE` | no | `lotmark.signing-key` | irrelevant in production |
| `PUBLIC_ORIGIN` | **yes in prod** | `http://localhost:5173` | two boot refusals |
| `TRUST_PROXY` | no | `false` | `true` refused in production; shape checked everywhere |
| `SESSION_TTL_MINUTES` | no | `480` | — |
| `IDLE_TIMEOUT_MINUTES` | no | `30` | — |
| `SIGNING_WINDOW_MINUTES` | no | `15`, max 60 | 21 CFR 11 §11.200(a)(1)(ii) continuous-session window |

A test walks `apps/api/src` and `apps/api/scripts` and asserts every key in the schema is read by real code, so there are no dead settings in that table.

### 4.2 Read outside `loadConfig` — these appear in no configuration audit

| Variable | Read by | Note |
|---|---|---|
| `LOTMARK_SIGNING_KEY_<TENANT>_<VERSION>` | `services/custody.ts:127,131` | **the production signing key.** Not in the schema, not in `.env.example`, not checked at boot |
| `LOTMARK_AUDIT_KEY_NEXT` | `scripts/rotate-audit-key.mts:152` | deliberately env-only, never argv, never printed |
| `PROBE_ORIGIN` | `scripts/prober.mts:57` | alias for `PUBLIC_ORIGIN` on the ops host |
| `DATABASE_URL` (direct) | `packages/db/src/client.ts:11`, `migrate.ts:58`, `seed/run.ts:86`, `drizzle.config.ts:8`, `scripts/prober.mts:121` | bypasses `loadConfig` — see §3.4 and §7.2, where it means two different roles |
| `HOME` | `scripts/verapdf-gate.mts:78` | veraPDF binary lookup |

**What `.env.example` does not carry.** It is the only inventory of settings anyone is likely to copy from, and it holds 18 active assignments. These are not among them, and every one of them matters to a deployment:

| Missing from `.env.example` | State there | Consequence |
|---|---|---|
| `LOTMARK_AUDIT_KEYS` | present only as a **commented** example at `:54` | §8.5 tells you to set it after every rotation. Anyone who copies the uncommented lines does not have it, and the omission is silent — verification of pre-rotation history just reports those generations *unverified* |
| `LOTMARK_SIGNING_KEY_<TENANT>_<VERSION>` | absent entirely | the production signing key. Not in the schema, not checked at boot, and the first thing an `env`-custody deployment needs |
| `LOTMARK_AUDIT_KEY_NEXT` | absent entirely | the rotation input (§8.5) |
| `PROBE_ORIGIN`, and the prober's own `DATABASE_URL` | absent entirely; the word "probe" does not appear in the file | the prober is a second machine with a second environment, and nothing here tells you it exists (§7.2) |

Treat `.env.example` as a partial reference; `apps/api/src/config.ts` plus the table above is the authority.

`apps/web` reads no environment at all. There are no `VITE_*` variables to set.

### 4.3 `HOST` is the gap in an otherwise careful set

Every other deployment-relevant value gets a production refusal. `HOST` does not. The default binds loopback only, so in a container the process starts, logs `Lotmark API on http://127.0.0.1:4000`, passes its own health checks from inside, and is unreachable from outside. Nothing refuses it and nothing warns.

Set it explicitly. If the proxy is on the same host, `127.0.0.1` is correct and deliberate; if not, bind the interface the proxy reaches — and never bind a public interface without the proxy in front, because TLS terminates there.

### 4.4 Almost every command reads the same config

Eight entry points call `loadConfig()`: `app.ts` (so `main.ts`), `worker.ts` (so `job`), `signer.ts`, `dr-drill.mts`, `validation.mts`, `rotate-audit-key.mts` (`audit:generations`, `audit:rotate`, `audit:claim`), `move-custody.mts` (`custody:show`, `custody:move`) and `custody-verify.mts`. Under `NODE_ENV=production` **all eight** are subject to the `PUBLIC_ORIGIN`, custody, `TRUST_PROXY` and directory-overlap refusals — including the DR drill, the anchor signer and the audit-key rotation, none of which has any use for `PUBLIC_ORIGIN`. Give every one of them the full production environment, or they will refuse to start for reasons that have nothing to do with what they do, one reason per attempt (§5).

**The prober is the exception, and deliberately so.** `scripts/prober.mts` never calls `loadConfig`; it reads `PUBLIC_ORIGIN`/`PROBE_ORIGIN` and `DATABASE_URL` straight from the environment (`:57`, `:121`). That is what lets it run on a machine that holds no production secrets — see §7.2, and note that it reuses two of the API's variable names with different meanings.

---

## 5. FIRST BOOT: THE REFUSALS, IN ORDER

This is the most useful section in this document. The system fails closed in production by design, and an operator meeting these for the first time will think it is broken. It is not. Each one is guarding something that cannot be undone.

**`loadConfig` reports exactly one refusal per attempt, and the order is fixed.** This matters more than it sounds: an operator who fixes a value the code has not reached yet will see the same message again and conclude the fix did nothing. The everywhere-refusals and the production-only refusals are **interleaved**, so working one table to the bottom before starting the other is working against the code. This is the whole order, measured by calling `loadConfig` against nineteen environments:

| Step | `config.ts` | Refusal | Table |
|---|---|---|---|
| 1 | `:198` | the zod envelope — `Invalid configuration:` and one line per issue, including an unset or misspelled `NODE_ENV` | §5.1 #1 |
| 2 | `:202` | `LOTMARK_AUDIT_KEY` is the published default | §5.2 #1 |
| 3 | `:216` | custody class not implemented in this build | §5.1 #2 |
| 4 | `:230` | custody class not fit for production | §5.2 #2 |
| 5 | `:243` | `TRUST_PROXY` is malformed | §5.1 #3 |
| — | `:252` | **everything below is skipped outside production** | |
| 6 | `:276` | `PUBLIC_ORIGIN` is not an http/https origin | §5.2 #3 |
| 7 | `:284` | `PUBLIC_ORIGIN` names this machine | §5.2 #4 |
| 8 | `:302` | `TRUST_PROXY=true` | §5.2 #5 |
| 9 | `:325`, first pass | `SIGNING_KEY_DIR` overlaps `ANCHOR_KEY_DIR` | §5.2 #6 |
| 10 | `:325`, second pass | `SIGNING_KEY_DIR` overlaps `DOCUMENT_DIR` | §5.2 #7 |

Two consequences worth stating flat, both measured: `{NODE_ENV: production, SIGNING_KEY_CUSTODY: kms, TRUST_PROXY: yes}` reports the **audit key**, not the unimplemented custody class and not the proxy. `{NODE_ENV: production, LOTMARK_AUDIT_KEY: <real>, TRUST_PROXY: yes}` reports **custody not fit for production**, not the proxy.

### 5.1 Refusals that fire in every environment

These are steps 1, 3 and 5 above. They are not a phase you get through before the production ones start.

| # | Trigger | Message (exact) | Fix |
|---|---|---|---|
| 1 | any zod violation, including `NODE_ENV` | `Invalid configuration:` then one indented line per issue. Unset: `NODE_ENV: NODE_ENV is not set. It must be stated: development, test or production. Every production refusal in this file is conditional on it, so an unset NODE_ENV would turn all of them off. For a local process: NODE_ENV=development.` Misspelled: `NODE_ENV: Invalid enum value. Expected 'development' \| 'test' \| 'production', received 'prod'` | fix the named value. `NODE_ENV=production` in the unit file — `pnpm --filter @lotmark/api start` deliberately does not set it. `LOTMARK_AUDIT_KEY` under 16 characters and `SIGNING_WINDOW_MINUTES` over 60 land here too, and all issues are reported together in this one message. |
| 2 | custody class not built | `SIGNING_KEY_CUSTODY='kms' is not implemented in this build. Available here: dev_file, env, keychain.` — that list is **`dev_file, env` on Linux**: `keychain` is implemented only where `process.platform === 'darwin'`. Asking for `keychain` off macOS adds `(it needs macOS; this is linux)` | use `env`. See §2.2. |
| 3 | malformed `TRUST_PROXY` | `TRUST_PROXY='<x>' cannot be used: <problem>. Write false to trust nothing, or name the proxy: its address, a CIDR block, a comma-separated list of either, or a named set (loopback, linklocal, uniquelocal).` For a number the problem reads: `a hop count does nothing in this version of Fastify — it fails closed and behaves exactly like false, so configuring one would give you no proxy trust while looking like it had` | name the proxy's address or CIDR |

### 5.2 Refusals that exist only in production

Seven of them, from six checks — #6 and #7 are one loop over two directories, and they take different fixes. Numbered in the order `loadConfig` evaluates them, which is *interleaved* with §5.1's: see the table above for the whole sequence.

A deployment that exports only `NODE_ENV=production` meets **#1, then #2, then #4** — one boot each. It never meets #3, because the default `PUBLIC_ORIGIN` is a perfectly well-formed http origin that happens to name this machine.

| # | Trigger | Message (exact) | Fix |
|---|---|---|---|
| 1 | `LOTMARK_AUDIT_KEY` is the published default | `LOTMARK_AUDIT_KEY must be set to a real secret outside development.` | §2.3 |
| 2 | custody class not production-grade (`dev_file`, `keychain`) — **the default is `dev_file`** | `SIGNING_KEY_CUSTODY='dev_file' is not fit for production. Use env custody with a secrets manager, or implement the kms or hsm adapter. This value is printed on every certificate; running production on it would be an accurate statement of a bad situation rather than a good one.` | `SIGNING_KEY_CUSTODY=env` |
| 3 | `PUBLIC_ORIGIN` is not an http/https origin | `PUBLIC_ORIGIN='<x>' is not an http or https origin. It is printed on every certificate as the address an auditor is told to visit, so it must be the address this deployment is actually reachable at, e.g. https://certificates.example.org.` | §2.1 |
| 4 | `PUBLIC_ORIGIN` names this machine (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `[::1]`, `[::]`) — **the default is `http://localhost:5173`** | `PUBLIC_ORIGIN='<x>' points at this machine. Every certificate issued would tell an auditor to verify it at their own computer, and a printed certificate cannot be recalled. Set it to the public address of this deployment before starting it in production.` | §2.1 |
| 5 | `TRUST_PROXY=true` | `TRUST_PROXY=true trusts the X-Forwarded-For header from ANY client. The address it produces is written into the audit ledger and keys rate limiting, so blanket trust lets a caller choose what the audit trail says about them. Name the proxy instead — its address or CIDR block — or set TRUST_PROXY=false if nothing sits in front of this process.` | §2.4 |
| 6 | `SIGNING_KEY_DIR` overlaps `ANCHOR_KEY_DIR` | `SIGNING_KEY_DIR='<a>' overlaps ANCHOR_KEY_DIR='<b>': <resolved a> and <resolved b> are the same place, or one is inside the other. The anchor key signs statements about the ledger this process writes; if this process can read it, those statements attest to nothing. Give the signer its own directory, owned by its own OS user.` | §2.5 |
| 7 | `SIGNING_KEY_DIR` overlaps `DOCUMENT_DIR` | same opening, then: `Documents are served to callers and copied wholesale by the DR drill, so a signing key inside that directory leaves the building with them.` | §2.5 |

Also production-only, but not refusals: session cookies gain `secure: true`, and the log level drops from `debug` to `info`.

### 5.3 Failures that are not boot failures — the ones that will catch you later

These start cleanly and fail when something is asked of them. They are harder to diagnose precisely because the boot was clean.

| What | When it surfaces | Why |
|---|---|---|
| **First signature under `env` custody** | 500 on the first act requiring a signature | `KeyProvider.active` registers the key then calls `EnvCustody.write`, which throws `Cannot write a signing key into the environment.` and rolls the transaction back. §2.2 |
| **The first `anchor` run on an `env` tenant** | the anchor command aborts | `services/anchor.ts:174-178` registers the anchor key with a hard-coded `'dev_file'`, and migration 0029's ratchet refuses a non-production-grade custody for a tenant that has ever reached a production-grade one: `This tenant already holds keys under % custody, and this would register key % under %, which is not fit for production use. The usual cause is a development process pointed at a production database: check DATABASE_URL before anything else.` This is not speculation — `apps/api/src/__tests__/custody-ratchet.test.ts` asserts exactly this sequence. **Anchoring cannot currently run on a production-custody tenant.** §10, item 6. |
| **Wrong `LOTMARK_AUDIT_KEY_GENERATION`** | every audited write 500s | §2.3 |
| **Wrong `DATABASE_URL`** | first query, not boot | `createDb` does not connect eagerly |
| **A development process pointed at the production database** | the ratchet refusal above | which is what it is for. Read the message literally: check `DATABASE_URL` before anything else. |

### 5.4 Smoke checks after the first successful boot

Run all five. Each one catches something no boot check can.

```bash
curl -fsS https://certificates.example.org/health/live
```

```bash
curl -fsS https://certificates.example.org/health/ready
```

`-f` is right on both of those: a 503 from `/health/ready` *should* fail the check. It is wrong on the next one, for a reason worth understanding rather than copying.

The `/verify/*` proxy rule (§1.3). An unknown token must return the API's server-rendered page, not the console shell.

**Do not use `curl -f` here.** An unknown token is a deliberate **404** — `routes/public.ts:83` returns `.code(v ? 200 : 404)`, and the same 404 answers a malformed token and a tenant with public verification switched off, so that an unauthenticated caller cannot probe which. `-f` throws the body away and exits 22 on a 4xx, so the check can never pass; the operator then reads the failure as a broken proxy rule when the rule is right. Match on the title instead and let `grep` be the verdict:

```bash
curl -sS https://certificates.example.org/verify/definitely-not-a-real-token \
  | grep -qi '<title>Certificate verification</title>' \
  || { echo '/verify/* is NOT routed to the API'; exit 1; }
```

I ran this three ways against a live API and a stand-in console. Against the API: `<title>Certificate verification</title>` on a 404 body, exit 0. Against an SPA fallback serving `apps/web/dist/index.html`, whose title is `<title>Lotmark</title>`: exit 1. Against a port with nothing on it: exit 1 — `curl` writes nothing, `grep` finds nothing, and the pipeline status is `grep`'s. The `-f` form measured on the same 404: `curl: (22) The requested URL returned error: 404`, pipeline exit 1 with an empty body and no way to tell the two failures apart.

The installation qualification, against the production database (§10 item 26 for the caveat about what it prints):

```bash
DATABASE_ADMIN_URL='postgres://lotmark_owner@db.internal:5432/lotmark' SIGNING_KEY_CUSTODY=env pnpm --filter @lotmark/api iq
```

The external prober, from the ops host (§7.2):

```bash
PUBLIC_ORIGIN=https://certificates.example.org ./node_modules/.bin/tsx apps/api/scripts/prober.mts
```

---

## 6. RUNNING IT

### 6.1 Health probes — wire them to the right decisions

Both are registered before any route prefix, unauthenticated, and exempt from rate limiting (`@fastify/rate-limit` is registered `global: false`), so a probe every second will not be throttled. Neither says anything about the data: "A health endpoint that leaks tenant counts is a reconnaissance endpoint."

| Endpoint | Answers | Checks | Returns | Wire it to |
|---|---|---|---|---|
| `GET /health/live` | is this process running? | **nothing, deliberately** | always 200 with `{status, uptimeSeconds}` while the process answers | the **restart** decision — Kubernetes `livenessProbe`, systemd watchdog, container healthcheck |
| `GET /health/ready` | can it serve a request? | `SELECT 1` against the app connection | 200 `{status:'ready', database:'reachable', checkedInMs, uptimeSeconds}` or **503** `{status:'not_ready', database:'unreachable', detail, …}` — `detail` is described below | the **rotation** decision — load-balancer target health, `readinessProbe` |

**Never invert these.** The comment at `app.ts:136-159` is a post-mortem of the inversion: there used to be one `/health` that queried the database and a second endpoint that queried it, caught the failure, and returned 200 with `database: 'unreachable'` in the body — "A load balancer reads the STATUS CODE." A liveness probe that fails on a database outage makes every instance restart at once, turning a recoverable outage into a crash loop. A readiness probe that only reports in the body keeps a broken instance in rotation.

**`detail` on the 503 is the field to page on, and it names the failure.** `app.ts:184-190` builds it from the driver's `code` *and* its message, because postgres.js raises an `Error` whose `message` is the empty string for the commonest production failure there is — the field used to be blank exactly when an operator most needed it. Measured against a running process, one instance per failure:

```
ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:59999
ENOTFOUND: getaddrinfo ENOTFOUND nonexistent.invalid
3D000: database "no_such_database_here" does not exist
28000: role "no_such_role_at_all" does not exist
```

The first two are `DATABASE_URL` pointing where nothing is listening or nothing resolves. The last two are SQLSTATEs: the connection was made and the server refused it, which means **`not_ready` does not imply a network problem** — a database renamed, a role dropped, credentials rotated on one side only, all land here reading `unreachable`. If the driver supplies neither code nor message the field says so in words rather than going empty: `the database did not answer, and the driver gave no reason`. `/health/live` stays **200** through all of it; I checked, against a process whose database was refusing connections.

**The worker has no port and no health endpoint.** There is no liveness probe you can point at it. Its only external liveness signal is `alert_sweeps.last_swept_at`, which is what the prober reads (§7.2). Plan for that: the worker being dead is invisible from inside the system.

### 6.2 Starting the two processes

```bash
NODE_ENV=production pnpm --filter @lotmark/api start
```

```bash
NODE_ENV=production pnpm --filter @lotmark/api worker
```

Both handle `SIGINT`/`SIGTERM`: the API closes the server and ends the DB pool; the worker drains pg-boss and ends the pool.

**There is no graceful drain.** The API closes immediately on `SIGTERM` — there is no window in which `/health/ready` starts returning 503 while in-flight requests finish, and the `readyState` needed to implement one does not exist. A rolling deploy will drop requests arriving between the signal and the load balancer noticing. Mitigate outside the process: deregister from the load balancer, wait longer than one health-check interval, then signal.

### 6.3 The scheduled jobs

Queued in Postgres via pg-boss — no Redis, no broker, no second durability story to back up. The queue connects as the **owner** (pg-boss maintains its own `pgboss` schema and needs DDL); job handlers do their work on the ordinary application connection under RLS. "The queue is infrastructure; the work is not, and mixing the two privileges would hand every job a bypass it does not need."

All crons are scheduled `{ tz: 'UTC' }`. The times below are UTC.

| Job | Cron (UTC) | Tolerance | What it does | What its absence means |
|---|---|---|---|---|
| `lot-expiry-notices` | `0 7 * * *` | 36 h | writes a `notifications` row to each holder organisation at 90, 30 and 7 days before lot expiry | no holder is ever told a lot is approaching expiry, and nothing is filed either |
| `monitoring-due` | `15 7 * * *` | 36 h | raises a CAPA (Major, due +14 days) per study whose latest monitoring point is past `next_due_on` — ISO 17034 §7.8 | no nonconformity is ever raised; the conformance record shows no findings, **which reads as compliance** |
| `entitlement-revalidation` | `30 7 * * *` | 36 h | lapses approved entitlements past `revalidation_due` and reverts the organisation's `price_tier` from `government` to `private` | an expired government discount stays commercially in force |
| `alert-sweep` | `*/15 * * * *` | 1 h | turns known job health and DR-drill state into deduplicated `operational_alerts` rows, and stamps `alert_sweeps.last_swept_at` | nothing is ever written to `operational_alerts`; the prober's staleness check has nothing to read |
| `session-prune` | `0 3 * * *` | 36 h | deletes sessions past the tenant's `session_and_access_log` retention, floored at the CERT-In 180-day statutory minimum | **over-retention past the configured window**, not data loss — but it is the only retention deletion in the product (§9.2) |

Tolerance is declared, not derived from the cron expression: "the number wanted here is not the schedule anyway — it is the tolerance, which includes retries, restarts and a night where the machine was asleep." `alert-sweep`'s asymmetric 15-minute cadence against a one-hour tolerance is deliberate — it only notices, and the value of noticing decays fast.

Retries are per queue: two attempts, 60-second delay, backoff. Every job runs once per tenant inside that tenant's RLS context, never with a `BYPASSRLS` role, and each tenant is its own transaction so one tenant's failure does not abandon the rest. The `job_runs` row is opened **before** work starts, so a process killed mid-run leaves a visible open row rather than nothing at all.

Ad-hoc invocation is the same code path as the scheduled one, and exits 1 if any tenant failed:

```bash
NODE_ENV=production pnpm --filter @lotmark/api job monitoring-due
```

```bash
NODE_ENV=production pnpm --filter @lotmark/api job --list
```

**The compounding failure.** A never-run job is scored *critical*, above stale, because "`never_run` reads like 'new' and is usually 'the worker has never been started in this deployment' — which means nothing any scheduled job does has ever happened here, including the retention deletions a regulator asks about." But the sweep that would raise that alert is itself one of the jobs that never ran. Only the external prober closes this (§7.2).

### 6.4 The anchor signer

Not a worker job, and deliberately so: "the point of an anchor is that the component which writes the ledger cannot also produce the statements attesting to it." It runs as a different OS user, as a different database role, against a key directory the API cannot read.

```bash
NODE_ENV=production pnpm --filter @lotmark/api anchor
```

```bash
NODE_ENV=production pnpm --filter @lotmark/api anchor verify
```

```bash
NODE_ENV=production pnpm --filter @lotmark/api anchor export
```

**Nothing schedules any of these.** Anchors exist only if you run the command. The anchor interval *is* the exposure window — an anchor proves the ledger contained exactly the entries it commits to, in that order, and proves nothing about entries written since. Choose the interval as a risk decision and write it down; hourly is a reasonable starting point for a producer issuing certificates daily.

`anchor export` copies anchors out of the database, because an anchor inside the database it notarises is still a row the same attacker controls. The export target is **not configurable**: it is hard-coded to `../.anchors-exported` relative to `ANCHOR_KEY_DIR`. Getting it off the machine — to separate media or a WORM store — is a step you have to add, and the export records its target so nobody has to guess which was done.

**Read §5.3 and §10 item 6 before scheduling this.** As the code stands, the first `anchor` run against a tenant whose record key is under `env` custody is refused by the custody ratchet. Anchoring is not currently usable in production without a code change.

### 6.5 Logs

The API logs via pino, at `info` in production. The worker logs with bare `console.log`. **Nothing ships either anywhere.** The worker's failure output — the `— N TENANT(S) FAILED` line — is the most detailed record of a failing job that exists outside the database, so where that stream goes is a deployment decision with no default. Capture both units' stdout/stderr into whatever you already run, and set a retention on it that matches §9.2's thinking about access logs rather than a default seven days.

---

## 7. WATCHING IT

### 7.1 What the alert sweep does, and what it cannot do

The sweep does no new detection. It reads facts the system already knows — job health, and the most recent DR drill — and writes them into `operational_alerts` under stable condition keys (`job:<name>:<state>`, `recovery:last-drill`), deduplicated so that re-raising the same key updates `last_seen_at` and `occurrences` rather than creating a second row. `failing` and `never_run` are critical; `stale` is a warning. A failed drill is critical; no drill ever, or an incomplete one, is a warning.

What it cannot do, in its own words:

> That it is not running. A sweep cannot alert on its own absence any more than a stopped worker can report that it has stopped, and pretending otherwise is how monitoring gets trusted for a job it never did.

Migration 0032 says the same twice, including that the table "is NOT … Delivery. Nothing here sends anything, because there is no email, SMS or webhook path anywhere in this codebase."

**`operational_alerts` has no read surface.** This matters, because the prober's own output assumes otherwise. `GET /api/v1/ops` returns job statuses and DR drills and never queries the alerts table; `openAlerts()` is referenced nowhere outside its own test file; the string "alert" does not appear anywhere in `apps/web/src`. So the deduplicated rows the sweep exists to write are, today, reachable only by direct SQL — and the prober will tell your operator "4 critical alerts are open" and then send them to a screen that will not tell them which four. §10, item 12.

### 7.2 The external prober

The one check that runs somewhere else. Its thesis: "Each of those is the same shape: the component asked to report the failure is the component that failed." It has no dependency on the application and is meant to run on a **different machine** — an ops host, a laptop on a cron, a monitoring service that can run a command.

Four checks: `GET /health/live`, `GET /health/ready`, sweep freshness against a 45-minute threshold, and open/critical alert **counts** (never alert text — "an unauthenticated ops host does not need them to know somebody must sign in and look"). Every fetch carries a 10-second timeout, because the failure being probed for includes "answers, eventually, in four minutes". When any tenant is unswept it prints an explicit disclaimer that a low alert count "is an absence of checking rather than an absence of problems".

**How to run it.** There is no package script — this is the documented form:

```bash
PUBLIC_ORIGIN=https://certificates.example.org tsx apps/api/scripts/prober.mts
```

The origin must be the address **as reached from outside**: "probing localhost from the same host proves the process is up and nothing about whether anybody can reach it." `PROBE_ORIGIN` is accepted as an alias where reusing the name would be confusing.

**Its `DATABASE_URL` is not the API's.** It is optional; without it the two database checks are skipped and the script says so. With it, it must be a `lotmark_probe` connection. As `lotmark_app` it fails hard — `permission denied for function ops_probe_summary` — which is loud rather than silent, but is also no monitoring. **The prober needs its own environment file**, and note that it reuses the names `PUBLIC_ORIGIN` and `DATABASE_URL` with different meanings from the API's.

**Exit codes are the integration point.**

| Code | Meaning |
|---|---|
| 0 | everything checked was fine |
| 1 | something is wrong and a person should look |
| 2 | the prober could not do its job — "which is also worth waking for, because a check that silently stops checking is worse than none" |

I ran it: no origin ⇒ exit 2; a dead origin ⇒ exit 1 with both health findings FAIL.

**Do not run it through pnpm.** I measured this: `pnpm --filter @lotmark/api exec tsx scripts/prober.mts` prints `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 2` and then exits **1** itself, destroying the deliberate 1-vs-2 distinction. Invoke `tsx` directly:

```bash
PUBLIC_ORIGIN=https://certificates.example.org ./node_modules/.bin/tsx apps/api/scripts/prober.mts
```

### 7.3 The honest statement about alerting

**Nothing in this system sends anything.** Not email, not SMS, not a webhook. I grepped for every plausible library and found only the disclaimers. This is stated in four independent places in the codebase and I found no code contradicting any of them.

The prober's argument for why it does not add one is worth repeating to whoever asks:

> every operator already has something that turns a failing command into a message they will see — cron's own mail, `systemd` OnFailure=, a Kubernetes liveness probe, an uptime service running a shell check, Nagios, Sentry crons. Building a half-implemented notifier here would compete with whichever of those they already trust, and lose.

So **the prober's exit code is the integration point**. Wire it to the thing your operator already answers at 3am:

- systemd timer with `OnFailure=` pointing at your notifier unit
- cron, letting cron's own mail carry the non-zero exit
- a monitoring service that runs a shell check and alerts on exit status

Run it at least as often as the sweep tolerance is tight — every 5 to 15 minutes — and from a host that is not the one being watched.

This is a real gap, not just a design stance: an in-app notification is a row in `lotmark.notifications` visible to someone who signs in. For ISO 17034 §7.11 recall, `packages/domain/src/conformance.ts:199-206` states the consequence plainly — "a holder who does not sign in is never told" — and calls that "the difference between informing a customer and filing a note that they were informed." §10, item 1.

---

## 8. BACKUP AND RECOVERY

### 8.1 What a backup set contains

`dr:backup` and `dr:drill` write into `.backups/<ISO-timestamp>`, created mode 0700. **`.backups` is a relative path** — the set lands wherever the process's working directory is. Fix that in the unit file.

| Item | How | Note |
|---|---|---|
| `database.dump` | `pg_dump --format=custom` on `DATABASE_ADMIN_URL` | |
| `SIGNING_KEY_DIR/` | recursive copy | record signing keys |
| `ANCHOR_KEY_DIR/` | recursive copy | **the anchor key** |
| `DOCUMENT_DIR/` | recursive copy | every rendered certificate |
| `roles.sql` | `pg_dumpall --roles-only --no-role-passwords`, mode 0600 | roles are cluster-level and not in the dump. Passwords are excluded because "a backup that contains credentials is a credential store nobody is treating as one" |

Missing directories are logged and skipped; failure to capture roles is a warning, not an error.

### 8.2 The backup set is key material, and that decides where it may live

This is the most consequential paragraph in this section.

In one 0700 directory sit: the full database dump, the record signing keys, the anchor signing keys, and every certificate. **Anyone holding a backup set can forge certificates and anchors for every tenant in it.**

Two things follow, and the second contradicts a control the config enforces:

1. **Backup storage inherits the trust level of the signing key store.** It cannot go to ordinary object storage, an unencrypted offsite disk, or a developer's laptop. It needs encryption at rest under a key that is *not* in the set, access control equal to the key store's, and its own retention and destruction policy.

2. **The drill collapses the OS-user separation `config.ts` refuses to boot without.** `config.ts:325-339` refuses to start if `SIGNING_KEY_DIR` overlaps `ANCHOR_KEY_DIR`, on the stated grounds that the anchor key must be unreadable by the API — "if this process can read it, those statements attest to nothing". The drill then copies both into one directory anyway. Whoever runs `dr:drill` must be able to read the signer's key directory. Resolve it deliberately: either the drill runs as a principal that has that access **by design and is documented as a third trust boundary**, or the anchor half is backed up separately by the signer's own owner and the drill's key check is scoped to the record keys. Do not leave it accidental.

The one secret **not** in the set is the audit HMAC key, which lives only in the environment. Keep it that way and store it somewhere else, or a single stolen backup makes the chain forgeable too.

### 8.3 The drill, and what its three outcomes mean

"A backup that has never been restored is a hypothesis. The failure everyone has is not 'the backup was missing' — it is 'the backup restored, and the thing we needed was not in it'."

```bash
NODE_ENV=production pnpm --filter @lotmark/api dr:drill
```

**What the host it runs on must have.** The drill is not self-contained: it shells out to five PostgreSQL client binaries — `pg_dump` (`dr-drill.mts:99`), `pg_dumpall` (`:126`), `dropdb` (`:175`), `createdb` (`:177`) and `pg_restore` (`:190`). Install them at a major version **at or above the server's** (§2.6), on whichever host runs the drill. And the drill's own principal needs a privilege nothing else in this system needs: `dropdb` and `createdb` are given `--maintenance-db` pointed at the `postgres` database on the server named by `DATABASE_ADMIN_URL`, so that role must be able to **connect to `postgres`** and must hold **`CREATEDB`**. This is how the drill reaches a cluster that is not the local machine — the two tools take no connection string of their own and would otherwise fall back to `PGHOST` and the local socket while `pg_restore` went to `DATABASE_ADMIN_URL`. I checked that it now holds: with `PGHOST=nonexistent.invalid` exported and `DATABASE_ADMIN_URL` naming `localhost`, the drill still ran, printing the host it chose:

```
restoring into lotmark_drill on localhost:5432 (dropped and recreated)
```

Read that line every run. It is the only thing that tells you which cluster you just rehearsed against.

It restores into a scratch database `lotmark_drill` (dropped and recreated each run, and guarded against being the live one), restores **with** privileges and `--no-owner`, and then checks:

- a tenant exists;
- row counts for `audit_ledger`, `certificate_issues`, `signatures`, `users`, `lots` — described by the script itself as "almost decoration";
- **the privilege posture, which is the point** — `lotmark_app` holds exactly `INSERT,SELECT` on `audit_ledger`, `key_custody_events` and `audit_key_generations`; `functions_public_can_execute()` returns zero; every relation has RLS enabled *and* forced;
- the audit chain verifies in the restored database;
- stored certificates match their recorded `document_sha256` on disk;
- one certificate re-renders **byte-identically** — restricted to issues produced by the *current* `RENDERER_VERSION`, because a renderer change legitimately changes the bytes (§2.1);
- the backup set carries key material alongside the database.

| Outcome | Means | Exit |
|---|---|---|
| `passed` | everything ran and succeeded | 0 |
| `incomplete` | nothing failed, but at least one check **could not run** | **1** |
| `failed` | something failed | 1 |

**`incomplete` deserves its own paragraph, because it exists as a result of a real defect.** The document checks used to record `ok: true` with the word "skipped" buried in the detail text; `passed = checks.every(c => c.ok)` came out true, `dr_drills.outcome` was written `passed`, and the conformance view read that as a satisfied control. "The printed line said 'skipped'. The stored boolean said 'ok'. The boolean is what an assessor is shown." Migration 0028 widened the CHECK and documented the column: **incomplete has not demonstrated that a certificate survives a restore, and the conformance view does not report it as satisfied.** Pre-existing rows keep `passed` deliberately, because rewriting history is not available to an append-only system.

`incomplete` is the *expected* result on any database with no certificate rendered by the current renderer version. **So a drill against a production database with no issued certificate never executes its strongest checks.** Make issuing at least one real certificate a prerequisite of the first meaningful drill, and treat an `incomplete` result as a finding rather than a pass.

To prove the drill is actually looking, run the sabotage mode. It restores the same backup with `--no-privileges` — the flag people reach for when a restore complains about a missing role — and **requires the drill to fail**:

```bash
NODE_ENV=production pnpm --filter @lotmark/api dr:sabotage
```

I ran it. That flag leaves every row count identical — audit ledger 2 → 2, users 9 → 9, lots 3 → 3 — while `lotmark_app` loses every grant on the three append-only tables and `PUBLIC` regains `EXECUTE` on every function in the schema (43 on this database; the count tracks the schema, and the script's own comment saying 37 is out of date). A drill that checked only row counts would report a perfect restore of a database whose append-only ledger is writable. The run ends `THE DRILL WORKS — it caught 4 problem(s) a row-count check would have missed` and exits 0; a sabotage run that comes out anything other than `failed` exits **1** with `THE DRILL IS NOT WORKING`.

Two things about sabotage mode that the printed output does not tell you:

- **It writes no `dr_drills` row.** `--sabotage` calls the prover with recording switched off, deliberately: it is a test of the test, not a rehearsal, and recording it would put a `failed` drill into the conformance record for a restore nobody was relying on. So do not run sabotage and then look for its result in `lotmark.dr_drills` — only `dr:drill` records.
- **It leaves the scratch database sabotaged.** Every run leaves `lotmark_drill` in place for inspection, and whichever of the two commands ran last is what is in it. Finish on `dr:sabotage` and the database sitting there for the next person to inspect is the deliberately broken one, with no marker saying so. Either finish on `dr:drill` or write down which you ran.

**Known defect — fix before relying on the drill for the empty-restore case.** `apps/api/scripts/dr-drill.mts:207` returns `false` from a function declared `Promise<Outcome>`:

```ts
if (!tenant) { record('a tenant exists in the restored database', false); return false; }
```

At runtime the drill crashes with `outcome.toUpperCase is not a function` instead of reporting a failed drill and writing the `dr_drills` row. The case it breaks on — a restore into a database with no tenant — is precisely a real disaster-recovery scenario.

It is invisible to CI because `apps/api/tsconfig.json` includes only `src/**/*`: `pnpm -r typecheck`, the first gate in the workflow, matches **zero** files under `apps/api/scripts/` — I confirmed by listing the files the project actually loads. That blind spot is not hypothetical and this is not the only thing living in it. Pointing `tsc` at `scripts/**/*` with the same options reports three errors, not one (§10 item 7).

### 8.4 What a real backup regime needs beyond this script

The drill proves a backup; it is not a backup regime. Not covered, and all of it yours to build:

| Missing | Consequence |
|---|---|
| **WAL archiving / PITR** | this is a periodic full dump only, so RPO = time since the last run |
| **Off-host and offsite copies** | `.backups` is a local relative path. 21 CFR 11 §11.10(c) is recorded `partial` in the conformance register precisely because "off-site copies" are not covered |
| **Retention, rotation and destruction** | nothing prunes `.backups`, and §8.2 means every retained set is a forgeable key store |
| **Integrity checks on the backup files themselves** | the drill proves a restore; nothing detects bit rot in a set nobody restored |
| **A schedule** | `dr-drill` is not in `JOBS`; nothing schedules a backup or a drill. The sweep raises `recovery:last-drill` when no restore has been rehearsed and tells the operator to run the script by hand |
| **Restore-time targets** | unmeasured here |
| **Credential re-issue after a restore** | `roles.sql` carries no passwords, so a restore onto a fresh cluster needs all three roles' credentials re-issued out of band |

The scratch database is left in place after every run, deliberately, for inspection. Account for the disk.

### 8.5 Rotating the audit key

A deployment procedure, not a code change, and it belongs beside backup because the same principle governs both: **keep the old key.**

Inspect what generations exist and whether the chain verifies:

```bash
NODE_ENV=production pnpm --filter @lotmark/api audit:generations
```

Rotate. The new key comes from the environment and is never argv — argv is visible to every user on the machine through `ps` — and it is never printed, for the same reason a password prompt does not echo:

```bash
LOTMARK_AUDIT_KEY_NEXT="$(openssl rand -base64 32)" NODE_ENV=production pnpm --filter @lotmark/api audit:rotate -- --generation v2 --reason "annual rotation"
```

Three things happen in **one** transaction: the new generation is registered with a commitment to the new key (an HMAC of a fixed string, so the database can recognise the key later without ever being able to produce a signature with it); the session switches onto the new key; and the ledger entry recording the rotation is written — becoming the first entry of the new generation, so the ledger itself says where the boundary is. A rotation that registered a generation and then failed to write its first entry would leave a generation nothing was written under, and the next append would silently start using it.

Refusals you will meet: `--generation is required, e.g. --generation v2`; `--reason is required. A rotation with no stated reason cannot be reviewed.`; a `LOTMARK_AUDIT_KEY_NEXT` under 16 characters gets the full explanation of why it is not an argument; and `The new key is identical to the current one. That is not a rotation.`

**Afterwards, before the next audited action**, set `LOTMARK_AUDIT_KEY` to the new key and `LOTMARK_AUDIT_KEY_GENERATION` to the new generation — and put **both** keys into `LOTMARK_AUDIT_KEYS` as a JSON map so history written under the old one can still be verified. `LOTMARK_AUDIT_KEYS` is not one of `.env.example`'s eighteen active lines; it appears there only as a commented example (`:54`), so it is the variable an operator working from that file is most likely never to have set (§4.2). Nothing validates it at boot either, so a malformed map is discovered by whoever next runs a verification, not by the process that was handed it. Losing the old key does not break the chain; verification reports those entries `chain is UNVERIFIED (not broken): no key held for <gens>` rather than broken. That distinction is deliberate and is stated in three places in the code. But nobody will ever be able to check them again.

**One thing to do once, on the first day.** Migration 0019 carried existing history forward as generation `v1` with no commitment, because a migration cannot see a key that lives outside the database. The first append commits it — which in practice is seconds later — but until then anyone who could already write to the ledger could commit a key of their own. It also improves diagnosis: with no commitment recorded, a verifier given the *wrong* key is indistinguishable from a tampered chain. Close the window on demand rather than waiting for traffic:

```bash
NODE_ENV=production pnpm --filter @lotmark/api audit:claim
```

---

## 9. COMPLIANCE CONSTRAINTS ON THE DEPLOYMENT

This section covers only what binds *where and how you deploy*. The clause-by-clause register lives in `packages/domain/src/conformance.ts` and is regenerated into `docs/validation/RTM.md`: 29 requirements, 24 `enforced`, 4 `partial`, 1 `declared`.

### 9.1 Data residency — the unit is the deployment, not the row

`tenants.data_residency` and `tenants.region` are columns, seeded for the demonstration tenant as `'NIC / MeitY, in-country'` and `'ap-south-1'`, and `region` is written onto every audit entry and signature. But residency is satisfied by **placing the instance**, not by routing inside it. `services/tenancy.ts:22-27` argues it: "A reference material producer is an accredited institution. The natural unit of deployment is one producer, which is also the unit CERT-In cares about for data residency and the unit an ISO 17034 assessment covers."

Two things not to overclaim:

- **`INDIA_RESIDENT` is declared and enforced by nothing.** `packages/domain/src/retention.ts:125-126` exports the set; a repository-wide search finds no reader outside that file, one doc mention, and one invariant test that only checks the flags are self-consistent with `drivenBy`. Nothing pins a copy to a region and nothing refuses to move one.
- **The region router is deliberately deferred.** `ARCHITECTURE.md:1124` (decision D2): the column "exists in the schema from day one so the hook has somewhere to read from, but the router, per-region migration fan-out and log/backup pinning ship with the first sovereign contract."

Practically: put the database, the API, the worker, the document store, the key stores **and the backups** in the declared region. Backups are the one people forget, and §8.2 makes them the highest-value target in the estate.

One correction the architecture documents carry and that a deployment plan should not get backwards: **do not build data localisation for DPDP — build it for CERT-In.** `MVP1-TIERS.md:318` records that the earlier localisation argument for DPDP was wrong: the final Rules use a blacklist model for cross-border transfer, not localisation.

### 9.2 Retention floors — including the CERT-In 180 days

`packages/domain/src/retention.ts` reconciles four regimes that disagree in the open. Its own header: "DPDP says minimise. CERT-In says 180 days held in India. 21 CFR Part 11 says as long as the record. ISO 17034 says the life of the material."

| Class | Floor (days) | Driven by |
|---|---|---|
| `audit_ledger_entry` | 180 | CERT-In 2022 · ISO 17034 §8.4 |
| `session_and_access_log` | 180 | CERT-In 2022 |
| `consent_artefact` | 1095 | DPDP Rules 2025 |
| `study_and_property_value` | 1825 | ISO 17034 §7.5–7.8 |
| `order_and_allocation` | 2920 | Tax law · ISO 17034 §7.10 |
| `electronic_signature` | 3650 | 21 CFR 11 §11.10(e) |
| `certificate_issue` | 3650 | ISO Guide 31 · Part 11 |
| `competence_record` | 3650 | ISO 17034 §6.3 |
| `customer_contact_data` | **0** | DPDP Act 2023 — minimisation is a *maximum* and an obligation to erase, not a minimum to keep |

Enforced in two layers on purpose: publication refuses a period below the floor, naming the regime, and the runtime takes the greater of the stored period and the floor — because "the safe reading of an unlawfully short period is the lawful one".

**The honest limit, and it must be stated to an assessor rather than discovered by one:** `retentionDaysFor` has exactly **one** production caller, `pruneSessions`. The only retention-driven deletion in the entire API is `DELETE FROM lotmark.sessions`. **Every other floor in that table is a declaration an assessor can read, not a period any code enforces.** A tenant with no retention configuration gets the statutory floors by default, which is the safe outcome — but the floors on signatures, certificates and competence records are honoured by nothing deleting them, not by anything checking.

The 180-day session floor has a history worth knowing: the prune job deleted sessions after **seven days** against a schedule that has always said 180, with a comment calling them "housekeeping, not evidence" — the product's view, not the regulator's. That is fixed and tested. The `sessions` table **is** the access log; there is no separate one.

### 9.3 CERT-In Directions 2022 — what binds the deployment

`MVP1-TIERS.md:266` is the scoping sentence: the empanelled-auditor audit is a procurement artefact that can be cut, but "**6-hour reporting, 180-day in-India logs and VAPT do not get cut** — those bind any Indian body corporate."

| Obligation | Where it lands |
|---|---|
| **180 days of security telemetry, held in India** | the `sessions` table, enforced by `session-prune` — so **the worker must be running**, and §9.2's floor is the enforcement |
| **Clocks synchronised to a declared, traceable source** (NIC or NPL NTP) | **an OS-level obligation.** `tenants.time_source` is a declared text column stamped onto every ledger entry and signature; nothing measures NTP offset and nothing refuses to sign on drift. The application records a label. You must supply the actual discipline, and the label must be true |
| **Six-hour incident reporting with a named point of contact** | not in the product at all. An operations obligation: an incident runbook and a named human |
| **Independent VAPT** | not in the product. `ARCHITECTURE-CRITIQUE.md:63` notes that ZAP baseline + semgrep + osv-scanner "is not a penetration test" |

### 9.4 DPDP Act 2023

Two retention classes cite it directly (§9.2). The conformance requirement `REQ-RETENTION` is recorded **`partial`**, and its note should be quoted verbatim in any assessment pack rather than paraphrased: the floor is now enforced at publication and at runtime, but "there is no erasure-request workflow, so the refusal path has never been exercised by a real request, and nothing actively erases customer contact data once no order is open — **DPDP minimisation is declared and not performed**."

What the deployment must be able to do that the product cannot yet: **refuse an erasure request with a lawful reason.** The schedule exists precisely so the producer can — "a customer cannot erase a competence record that backs a signature, or an order line that makes a certificate holder list computable" — but the screen and endpoint do not exist. Until they do, it is a manual procedure with a written decision per linked class (erase / pseudonymise / refuse-with-reason), citing the retention row.

Dates the tiering document carries: DPDP full compliance is described as due **13 May 2027**; the Consent Manager registration duty is live from 13 Nov 2026 and is argued to fall on Consent Managers rather than a B2B producer. Note that `MVP1-TIERS.md`'s "90-day grievance" carries **no statutory citation anywhere in this repository** — it is asserted by that document alone. Verify it before putting it in a compliance claim.

### 9.5 21 CFR Part 11 — the clauses that constrain deployment rather than code

| Clause | Status | What the deployment must do |
|---|---|---|
| §11.10(e) audit trail | enforced | deliver `LOTMARK_AUDIT_KEY` through a secrets mechanism, never in or beside the database. Rotation is a deployment procedure (§8.5) |
| §11.10(e), the IP field | — | **the reverse-proxy topology is a Part 11 control, not an ops detail.** `req.ip` is written against every act; whoever can set `X-Forwarded-For` chooses what the trail says. See §2.4 |
| §11.10(c) protection for retrieval | **partial** | the drill proves backup, keys, documents and privilege posture. Explicitly **not** covered: "off-site copies, and any retention period longer than this installation has existed." Off-site backup is a named deployment deliverable |
| §11.30 key custody | **partial** | `SIGNING_KEY_CUSTODY=env` plus a real secrets manager, or write the KMS/HSM adapter first. The class is printed on every certificate, so it cannot be overclaimed. `MVP1-TIERS.md:269` permits deferring HSM "provided `custody_class` is printed on the validation-pack cover page" |
| Anchoring / separation of duty | — | three OS users, three directories, and an off-instance anchor export destination. `services/anchor.ts` says of its own `dev_file` anchor custody: "it is **NOT an HSM**. Saying so is the difference between a control and a claim" |
| §11.10(b) human-readable copies | enforced | **not veraPDF-verified.** The CI `pdfa` job runs `continue-on-error: true`, so its result is advisory (§10 item 22). A deployment claiming PDF/A has to run the gate itself, with `--require-verapdf`, on a host carrying a JRE and the veraPDF binary (§2.6) — and has to fix the gate's fixture first (§10 item 7) |
| §11.300(b) | enforced, with a stated shortfall | "Not yet PERIODIC: §11.300(b) also contemplates password aging, and nothing here expires a password the holder chose" |

### 9.6 GIGW 3.0 and STQC — scope, before anyone assumes

Neither appears in any conformance requirement. I checked the clause list: there is no GIGW entry and no STQC entry. GIGW exists as part of the demonstration tenant's profile string (`conformance_frame` is seeded `ISO 17034 + GIGW 3.0 + DPDP`), as an architecture heading, and — importantly — as the first element of that tenant's own **`out_of_scope`** array. Read from `packages/db/src/seed/run.ts:171-175` and confirmed against the live database, that array has exactly four entries:

```json
["GIGW 3.0 portal and CMS", "Bilingual content authoring",
 "PvPI outreach pages", "Events, forum, recruitment"]
```

**STQC is not among them.** It is out of scope on the argument below, not on the tenant's record — which is the distinction to hold onto, because this is a procurement conversation and `out_of_scope` is the thing you will be asked to show. Whatever your own tenant's array says is what an assessor reads; write it deliberately (`FIRST-TENANT.md` §3.1).

The scoping argument, from `MVP1-TIERS.md:264-265`: GIGW binds Indian **government** websites and apps; a private producer is out of its scope, and even for a government tenant it binds the portal and CMS rather than this platform. STQC "certifies a *website*, not a production platform."

If the tenant *is* a government body, GIGW brings 88 mandatory guidelines plus 17 success criteria beyond WCAG 2.1 AA, demonstrable via an accessibility audit — and `ARCHITECTURE-CRITIQUE.md:64` states plainly that **no conformance evidence workstream exists** for it. Do not let a procurement document assume otherwise.

### 9.7 Air-gapped and offline operation

`ARCHITECTURE.md:197` calls offline operation "a hard requirement (NIC/MeitY)": fonts self-hosted and hashed (Google Fonts links are "fatal in an air-gapped deployment and a DPDP third-party-call problem"), no CDN scripts, no telemetry egress, no error-reporting SaaS, a vendored and pinned toolchain, notifications to a local outbox. One consequence to record on paper before you deploy into such an environment: an air-gapped instance "may have **no reachable RFC 3161 TSA at all**, in which case anchors carry a development timestamp permanently."

### 9.8 What an assessor will ask to see

| Ask | Where it comes from | State today |
|---|---|---|
| The installation record | `pnpm --filter @lotmark/api iq`, plus `lotmark_meta.schema_migrations` | **runnable, and persists nothing** — see §10 item 2 |
| The requirements traceability matrix | `docs/validation/RTM.md`, generated from `conformance.ts`, CI-gated against drift | good |
| The operational qualification | the automated test suite, mapped by the RTM. There is deliberately no separate OQ document, because it "would create a second thing to keep true" | good, but no execution record survives a run |
| The performance qualification | `pnpm --filter @lotmark/api pq` | **cannot run against a production deployment** — see §10 item 3 |
| A rehearsed restore | `lotmark.dr_drills` — the one qualification artefact that *is* persisted, with `passed`/`incomplete`/`failed` | good; see §8.3 on `incomplete` |
| Key custody class | printed on every certificate, and recorded per key in `signing_keys.custody` | honest by construction |
| The retention schedule per record class | `retention.ts`, plus the conformance view | declared; only sessions are enforced (§9.2) |
| Audit chain verification, including across a key rotation | `POST /audit/verify`, `audit:generations` | good; retired-generation keys must be held in `LOTMARK_AUDIT_KEYS` or the chain reports *unverified*, which is deliberately not the same as *broken* |
| Six-hour incident procedure, VAPT report | — | **not in the product.** Yours |

---

## 10. WHAT IS NOT READY

Everything below is verified against the working tree by me, not inherited. Nothing here is softened, and nothing here is a matter of taste.

**1. There is no notification delivery of any kind.** No email, no SMS, no webhook. I searched for every plausible library and found only the disclaimers, in four independent places. "Notification" in this system means a row in `lotmark.notifications` visible to someone who signs in. The consequence is stated in the conformance register itself for ISO 17034 §7.11 recall: identification of holders is enforced; telling them is not, and "a holder who does not sign in is never told". A reference material producer that cannot reliably tell a laboratory its certified value was wrong has a safety obligation it cannot discharge.

**2. IQ, OQ and PQ persist no execution records.** `scripts/validation.mts` writes to stdout and, for `--rtm`, to `docs/validation/RTM.md`. There is no table for a qualification run — I enumerated every `CREATE TABLE` in the migrations; `dr_drills` is the only qualification artefact that survives. So an IQ that passed on Tuesday leaves nothing an assessor can be shown on Friday except a terminal scrollback. Capture the output yourself, deliberately, with a timestamp and a named human, until this is built.

**3. The performance qualification cannot run against a deployment at all.** `validation.mts:208` hard-codes `BASE = 'http://127.0.0.1:4000/api/v1'`; it signs in as `asha@producer.example`, `meera@genpharm.example`, `vikram@producer.example` and `admin@producer.example` with the published password `demo-password-1234` and the seed's shared TOTP secret. Those accounts exist only because the seed created them, and the seed refuses production. **The only executable PQ in this repository requires the demonstration data that production is forbidden to have.** PQ is therefore a development-only artefact today, and any validation plan that lists it as a production acceptance test is wrong.

**4. There is no path to a first tenant.** No route and no script calls `provision_tenant`; there is no organisation-creation route; there is no way to publish a first configuration version without an already-privileged session, which needs a user, which needs an organisation and a published role. The seed's own refusal message points at a procedure that does not exist end to end. `FIRST-TENANT.md` documents what has to be done by hand and what has to be written.

**5. A first signing key cannot be created under the only production-legal custody class.** `EnvCustody.write` throws by construction, so both routes to a first key fail: first-boot minting (`keys.ts:201`) rolls back its own registration, and `custody:move --to env` fails at step 2 of 5. The refusal even prints the wrong variable name — it passes the literal string `'<version>'`, so the operator is told to set `LOTMARK_SIGNING_KEY_<tenant>__VERSION_`. Registering a key is a hand-run SQL step with no tooling.

**6. Audit anchoring cannot run on a production-custody tenant.** `services/anchor.ts:174-178` registers the anchor key with a hard-coded `'dev_file'`. Migration 0029's custody ratchet refuses a non-production-grade custody for a tenant that has ever held a production-grade key. So on a tenant whose record key is `env`, the first `anchor` run is refused. This is asserted by the repository's own test suite (`custody-ratchet.test.ts` registers `env` then `dev_file` and requires the refusal). **The tamper-evidence argument that anchoring exists to make cannot be exercised in production without a code change.**

**7. `apps/api/scripts/` is not type-checked by anything, and three real errors are living there.** `apps/api/tsconfig.json` includes only `src/**/*`, so `pnpm -r typecheck` — the first gate in CI — loads zero files from that directory. I pointed `tsc` at it with the same options and got three:

- `dr-drill.mts:207` returns `false` from a function declared `Promise<Outcome>`. At runtime the drill dies at `outcome.toUpperCase is not a function` and writes no `dr_drills` row. The case it breaks on is a restore into a database with no tenant — exactly the disaster-recovery scenario.
- `verapdf-gate.mts:35` and `pdfa-check.mts:4` construct a `CertificateSnapshot` **without `verificationOrigin`**, which became a required field when the verification footer stopped being hard-coded. These are not type errors that stay on paper: the PDF/A gate still runs, still reports `PASS — 8 checked requirement(s) met`, and renders a certificate whose footer reads — decoded from the rendered bytes, not inferred —

  ```
  undefined/verify/k3nQ8vRtY2wPzL9mA4xB6dF1
  ```

  So the artefact the PDF/A gate qualifies is not the artefact this system issues. Fix the fixtures before quoting the gate at an assessor (§9.5).

Adding `scripts/**/*` to the `include` is a one-line change that turns all three into build failures. Nobody has made it.

**8. There is no packaging or process supervision of any kind.** No Dockerfile, no compose file, no systemd unit, no Procfile, no Kubernetes manifest, no Helm chart, no Terraform. CI never runs `pnpm build`, and `pnpm build` — `pnpm -r build`, which today reaches only `pnpm --filter @lotmark/web build` — is what produces the console bundle you are asked to serve. CI typechecks and tests the console's *sources* and stops there; no workflow has ever produced the bundle. I ran `vite build` once by hand while writing §1.1, and that is the whole history of it: no gate exercises it, nothing checks that the emitted asset paths suit the topology §1.3 recommends, and the result is published nowhere. All of this has to be specified from scratch, and none of it has been reviewed by anyone.

**9. `tsx` is a devDependency, and every operator command in this document is a `tsx` script.** Not just the entry point — `start` is `tsx src/main.ts`, but so is everything else. From `apps/api/package.json`: `start`, `worker`, `job`, `anchor`, `pdfa`, `custody:show`, `custody:move`, `audit:generations`, `audit:rotate`, `audit:claim`, `dr:backup`, `dr:drill`, `dr:sabotage`, `openapi`, `iq`, `pq`, `rtm`. From `packages/db/package.json`: `migrate`, `migrate:status`, `seed`. Plus `scripts/prober.mts`, which this document tells you to invoke as `./node_modules/.bin/tsx` — the root binary, from the root's own devDependencies.

`tsx` is a devDependency in **all three** manifests (`apps/api/package.json:49`, `packages/db/package.json:32`, root `package.json:31`). An image built with `pnpm install --prod` therefore has: no migrator, no `migrate:status`, no disaster recovery, no backup, no anchoring, no audit-key rotation, no `audit:claim`, no IQ — and no way to start the API or the worker. The failure is not at deploy time; it is the first time somebody needs to rotate a key or rehearse a restore.

Three remedies, and they are not equal:

| | What it costs | Verdict |
|---|---|---|
| **Install with dev dependencies** — `pnpm install --frozen-lockfile`, no `--prod` | a larger image carrying `vitest`, `drizzle-kit` and a TypeScript compiler into production | **What CI does, and what works today.** Ugly and honest. |
| **Move `tsx` to `dependencies`** in `apps/api`, `packages/db` and the root | a three-line change; `--prod` then keeps the runtime transpiler and prunes the rest | the smallest deliberate fix, and the one to make if you want `--prod` |
| **Compile ahead of time** | there is no `build` script for `@lotmark/api`, and `apps/api/tsconfig.json` sets `noEmit: true` and includes only `src/**/*` — so this means writing a build, changing that config to emit, extending it to cover `scripts/`, and fixing the three errors §10 item 7 found there | correct eventually; not a thing to discover on deployment day |

The code takes no position. Take one before you write the Dockerfile, not after.

**10. Nothing in this repository serves the built console, and nothing builds it either.** The API registers no static-file plugin — there is no `@fastify/static` in any manifest, no `sendFile`, no SPA fallback. `apps/web/dist` is gitignored and read by nothing here. The bundle does exist as a command — `pnpm --filter @lotmark/web build`, which I ran (§1.1) — but no script, workflow or unit invokes it, so in production as the code stands there is no process that builds the console and none that serves it. §1.3 Option A puts serving on the proxy and §1.1 names the build; both are gaps in the software rather than preferences.

**11. `HOST` defaults to loopback and is unchecked in production.** Every other deployment-relevant value gets a refusal. An operator who sets everything else correctly and forgets `HOST` gets a process that starts cleanly, passes its own health checks from inside, and is unreachable — and only the external prober will say so, if the prober exists yet.

**12. `operational_alerts` has no read surface.** The sweep's whole purpose is to write deduplicated, resolvable alert rows; `GET /api/v1/ops` never queries them, `openAlerts()` is called only by its own test, and the word "alert" does not appear in `apps/web/src`. The prober tells the operator "Sign in to the operations screen for what they are" and the operations screen will not tell them. Today the only way to read an alert is direct SQL.

**13. There is no graceful drain.** `SIGTERM` closes the server immediately. A rolling deploy drops in-flight requests. The `readyState` that would let `/health/ready` fail first does not exist.

**14. Nothing schedules the two things whose absence the system alerts on.** Neither the DR drill nor the anchor signer is in `JOBS`. The sweep raises `recovery:last-drill` and tells the operator to run a script by hand. There is no backup schedule anywhere in the repository, and the anchor export target is a hard-coded relative path.

**15. Running more than one API instance or more than one worker is unaddressed.** Nothing in the code or its comments discusses it. pg-boss would be the coordination mechanism for workers, but no comment claims it has been tested that way and I have not tested it, so I will not assert that it works. Deploy one of each until somebody has.

**16. There is no log destination and no log retention.** The API logs via pino; the worker logs via `console.log`; nothing ships either. The worker's `— N TENANT(S) FAILED` line is the most detailed record of a failing job outside the database.

**17. No credentials exist for any database role.** All three login roles are created without passwords, each with a comment saying a deployed instance grants LOGIN with a real secret out of band. That out-of-band step exists nowhere, and `.env.example` does not mention the prober's connection at all.

**18. The schema owner on the only machine this has ever run on is a superuser.** So FORCE-RLS-against-the-owner — the property migration 0004 was written for — has never actually been exercised, and migration DML over tenant-scoped tables may match zero rows and report success under a correct non-superuser owner. §3.2.

**19. `pnpm --filter @lotmark/db reset` is broken, and `@lotmark/db` does not resolve.** `packages/db/package.json` declares `main`/`types`/`exports` as `./src/index.ts` and a `reset` script pointing at `src/reset.ts`; **neither file exists.** Nothing imports the package today, so it is latent — but any runbook citing `pnpm db:reset` will fail.

**20. DPDP minimisation is declared and not performed.** There is no erasure-request workflow, so the lawful-refusal path has never been exercised by a real request, and nothing erases customer contact data once no order is open. The conformance register says so itself.

**21. Only one retention floor is enforced by code.** The single retention-driven deletion in the product is `DELETE FROM lotmark.sessions`. Every other floor is a declaration. §9.2.

**22. PDF/A conformance is not verified in CI.** The `pdfa` job runs `continue-on-error: true`, and the reason is not that CI lacks a Java runtime — it installs one, `actions/setup-java@v4` with `temurin` 21 (`.github/workflows/ci.yml:102-103`). The workflow's own comment gives the real reason twice over: veraPDF needs a JRE that the **main `check` job** does not have, so the gate was split into a separate job, and that job is allowed to fail "while the gate is still being taught to run here" (`ci.yml:89-95`). So its result is advisory by decision, not by accident, and a red `pdfa` job does not fail the build. Separately, on a machine with no veraPDF at all the gate prints `PDF/A CONFORMANCE IS UNVERIFIED` and still exits **0** unless `--require-verapdf` is passed — which is the right behaviour and still means the claim is unverified. See also item 7: the document the gate renders is currently missing its verification origin.

**23. There is no CSRF defence beyond `SameSite=Lax`, and no CORS layer.** No token, no `Origin` check. The architecture specifies a `__Host-` cookie, `SameSite=Strict`, an Origin check and a double-submit token; none of it is built. This is survivable **only** under the same-origin topology in §1.3, which is why Option B is rejected rather than merely discouraged.

**24. The declared time source is a string, not a measurement.** `tenants.time_source` is stamped onto every ledger entry and signature. Nothing measures NTP offset and nothing refuses to sign on drift; `MVP1-CRITIQUE.md:70` flags the refusal threshold as an open question. Under CERT-In, the discipline is real and the application only records a label — so the label must be made true at the OS level and audited there.

**25. The migration runner takes no advisory lock.** Two concurrent deployers race. Nothing in the code prevents it.

**26. `pnpm iq` sets `NODE_ENV=development` and reads `SIGNING_KEY_CUSTODY` from the ambient environment.** So an IQ run made without the production environment exported prints `dev_file — printed on every certificate this key signs` into the installation record for a deployment that runs `env`. The IQ output is a compliance artefact; make the environment explicit when you run it (§5.4) or the record will be false.

**27. No assessor has reviewed any of this.** No ISO 17034 assessment, no Part 11 audit, no CERT-In empanelled audit, no VAPT, no STQC, no accessibility audit. The conformance register is the development team's own reading of the clauses. It is careful and it is candid about its gaps, and it is still self-assessment.

**28. It has never run anywhere but a laptop.** One machine, one database, one seeded demonstration tenant, 33 migrations all applied by a single superuser. No production origin has ever been configured, no certificate has ever been issued with a real verification address, and no restore has ever been rehearsed against anything but a development dump. Every procedure in this document is the first time it will have been done.

---

## Companion

- [`FIRST-TENANT.md`](FIRST-TENANT.md) — bringing the first real tenant into existence, given that the seed refuses production and no script does the job.
