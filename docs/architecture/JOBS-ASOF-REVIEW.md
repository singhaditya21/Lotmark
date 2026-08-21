I have read the code. Findings below, all checked against the repository.

# ADVERSARIAL REVIEW — THREE SPECS AGAINST THE ACTUAL REPOSITORY

---

## 1. FACTS THE SPECS GET WRONG

### 1.1 JOB-CATALOGUE §0 "Corrections to the stated current state" is itself stale

The spec asserts pg-boss is "installed, unused, unwired", that "there is still no scheduler", and that `grep -r "pg-boss" over apps/ and packages/ returns zero hits`. All three are false.

- `apps/api/src/jobs/scheduler.ts` exists (119 lines). Line 1: `import { PgBoss } from 'pg-boss'`. It defines `JOBS` (four cron entries), `Scheduler.start()` which calls `boss.createQueue`/`boss.work`/`boss.schedule`, `runNow()`, and `stop()`.
- `apps/api/src/worker.ts` exists — a complete worker entry point with `--list`, `job <name>`, and signal draining. Root `package.json` has `"worker"` and `"job"` scripts; `apps/api/package.json:11-12` has both.
- `apps/api/src/config.ts:56` declares `DATABASE_ADMIN_URL`, `:59` declares `RUN_SCHEDULER`.

The named import is correct: pg-boss 12.27 exports `export class PgBoss` (`apps/api/node_modules/pg-boss/dist/index.js:32`), not a default.

**The real gap nobody names:** `RUN_SCHEDULER` is parsed and read by **nothing**. `apps/api/src/app.ts` and `main.ts` never construct `Scheduler`. So the scheduler runs only via `pnpm worker`, and the config flag is dead. That is a one-hour fix and it is not in any of the three specs.

**Consequence for the plan:** JOB-CATALOGUE §5 step 4 ("Wire pg-boss: owner-role migration for its schema, `apps/worker` as a separate process, `WORKERS=inline` for demo") describes work that is ~80% done, under a different env var name, with a different schema strategy. Rewrite that step as "wire `RUN_SCHEDULER` into `app.ts`" and delete the rest.

### 1.2 JOB-CATALOGUE A3 fix #3 is simply wrong

> "`kind: 'ENTITLEMENT'` is not in the `AuditKind` union (`services/audit.ts:22-24`) — this does not typecheck. Same for `kind: 'NOTIFICATION'`."

`apps/api/src/services/audit.ts:20-24`:

```ts
export type AuditKind =
  | 'AUTH' | 'DENY' | 'SECURITY' | 'WORKFLOW' | 'SIGNATURE' | 'CERTIFICATE'
  | 'CONFIGURATION' | 'PII' | 'SYSTEM' | 'QUERY' | 'GOVERNANCE'
  // Written by scheduled work, which has no session and no user.
  | 'NOTIFICATION' | 'ENTITLEMENT';
```

Both are present, with a comment saying exactly why. Cut the item.

### 1.3 ANCHORING §1.6 miscites the timestamp precedent, and the precedent disagrees with itself

> "Timestamps come from Postgres, not Node: `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, exactly as `applySignature` in `apps/api/src/services/signing.ts:96` already does, and for the same reason — the ledger's microsecond rendering (`0002:74`) and the anchor's must be the same instant in the same form."

`services/signing.ts:102` (not `:96`, which is a comment) reads:

```ts
const [clock] = await tx`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`;
```

**Second precision. No `.US`.** The ledger (`0002_audit_chain.sql:77`) uses `.US`. So the codebase already has two incompatible canonical instant renderings, and the anchor spec cites the wrong one as its model. This matters concretely: `covered_through_occurred_at` is inside the signed payload and must be recomputable by the verifier from the stored `occurred_at`. Specify `.US` explicitly and note the divergence from `signing.ts` rather than claiming consistency with it.

Related and load-bearing: `apps/api/src/db.ts:18-25` and `packages/db/src/client.ts:15` override the driver's parser for OIDs 1082/1114/1184 to return **raw server text**. A Node signer reading `taken_at` gets whatever the session `DateStyle`/`TimeZone` produces, not ISO-8601 UTC. Every timestamp entering `anchorPayload()` must be rendered by `to_char(...)` in SQL. The spec's conclusion is right; its justification is wrong, and the wrong justification is the one an implementer will copy.

### 1.4 Smaller citation drift

| Spec claim | Actual |
|---|---|
| ANCHORING: production guard at `config.ts:69` | `config.ts:81` (the default at `:29` is correct) |
| ASOF: `decide()` at `guard.ts:76` | `guard.ts:72` (the `onDate` doc comment at `:56` is correct) |
| ASOF: "26 route handlers already call `inTenantTransaction`" | 29 call sites; 29 route registrations total (task prompt's "34 routes" is also high) |
| JOB: `guard()` competence at `guard.ts:106-127` | `guard.ts:101-121` |
| ASOF: the `superseded_at IS NULL` bug "is already written three times" | **Four**: `routes/lots.ts:44`, `values.ts:41`, `workflow.ts:40`, `certificates.ts:91` |

The last one strengthens the ASOF argument, not weakens it.

---

## 2. THINGS THAT WILL BREAK AGAINST THE ACTUAL SCHEMA

### 2.1 ★ HIGHEST-IMPACT DEFECT: the anchor key stops certificate issuance

`0000_initial_schema.sql:732`:
```sql
CREATE UNIQUE INDEX "signing_keys_tenant_version_unique" ON "lotmark"."signing_keys" ("tenant_id","key_version");
```

`apps/api/src/services/keys.ts:49-53`:
```ts
const [row] = await sql`
  SELECT key_version, public_key_pem, fingerprint, custody
  FROM lotmark.signing_keys
  WHERE tenant_id = ${tenantId} AND retired_at IS NULL
  LIMIT 1`;
```

No `purpose` filter. No `ORDER BY`. It works today **only because `signing_keys_one_active_per_tenant` (`0003:10-11`) guarantees exactly one un-retired row.**

ANCHORING §6.5 removes that guarantee (one active key per `(tenant_id, purpose)`), and §10 states `apps/api/src/services/keys.ts` is *"Unchanged, deliberately — it must never learn the anchor key."*

The moment an anchor key is registered, `KeyProvider.active()` can return it. It then calls `readPrivate(tenantId, 'anchor-v1')` against `SIGNING_KEY_DIR`, which by design does not hold the anchor private key, and throws at `keys.ts:64-68`. **Every `study:sign`, `value:authorise` and `cert:issue` fails**, nondeterministically by heap order. Two further consequences:

- `key_version` remains globally unique per tenant, so the anchor key **cannot** be `'v1'` — and `keys.ts:88` hardcodes `generateSigningKeyPair('v1')`. The anchor key needs its own version string.
- `lotmark.public_signing_key(p_tenant_name, p_key_version)` (`0008:100-107`) resolves by version alone and will happily hand a verifier an anchor key. It should return `purpose`.

**Required additions to the spec:** `keys.ts:52` gains `AND purpose = 'record'`; the anchor key takes a distinct version; `public_signing_key` returns `purpose`. `keys.ts` is not "unchanged, deliberately" — that sentence is the bug.

### 2.2 ANCHORING §6.3 contradicts ANCHORING §3(c) and kills JOB-CATALOGUE A10

§6.3 adds:
```sql
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION lotmark.refuse_mutation();
REVOKE INSERT, UPDATE, DELETE ON audit_checkpoints FROM lotmark_app;
```

`lotmark.refuse_mutation()` (`0002:153-159`) raises **unconditionally, for every role** — that is precisely why `audit-chain.test.ts:186-196` proves it stops the owner.

But §3(c) requires the signer to "re-read it, check the digest, and only then set `exported_at` and `export_target`", and JOB-CATALOGUE A9 states "`UPDATE` is permitted and is reserved for A10 setting `exported_at`", with A10's entire work predicate being `exported_at IS NULL`.

As written, `exported_at` can never be set by anyone, and the verifier's step 8 reports `ANCHOR_NOT_EXPORTED` forever.

**Pick one, in the spec:**
- (a) a column-scoped BEFORE UPDATE trigger permitting only `exported_at`/`export_target` — the `refuse_published_config_change()` pattern (`0002:177-196`) is the precedent already in this codebase; or
- (b) drop `exported_at`/`export_target` and record exports in an insert-only `audit_checkpoint_exports` table.

(b) is better: it keeps the anchor row genuinely immutable and §6.3's blanket REVOKE needs no exception.

### 2.3 Enumerated function grants do not close the SECURITY DEFINER hole

ASOF §1.3: *"Grants for `lotmark_reader` must be **enumerated, never `ALL FUNCTIONS`**. `0005` grants `EXECUTE ON ALL FUNCTIONS ... TO lotmark_app`; repeating that for the reader would hand it `lotmark.provision_tenant`."*

`grep -n "REVOKE" packages/db/migrations/*.sql` returns four lines, all table-level, **none against `PUBLIC`**. PostgreSQL grants `EXECUTE` on functions to `PUBLIC` by default. So `lotmark_reader` and `lotmark_signer` will hold EXECUTE on `provision_tenant`, `resolve_tenant`, `verify_certificate`, `public_signing_key` and `all_tenants` **regardless of what the migration enumerates**. The read-only role can create tenants; the signer role can enumerate every tenant.

**Required:** before granting anything to either new role —
```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "lotmark" FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "lotmark" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```
`lotmark_app` survives this — `0005:34` grants it explicitly, and every SECURITY DEFINER function has its own explicit grant (`0004:111`, `0006:33`, `0008:95,108`, `0009:89`, `0010:29`). But note `0005` has **no** `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS`, so every new function in `0011+` needs an explicit grant to `lotmark_app` once PUBLIC is revoked. That is a real regression risk and must be stated.

### 2.4 ASOF's `as_of_state()` violates ASOF's own timezone rule and is off by one

§4.4:
```sql
AND occurred_at <= ("lotmark".as_of() + 1)::timestamptz
```

`date::timestamptz` resolves in the **session `TimeZone`** — the exact hazard §1.1(c) forbids ("Both use `(now() AT TIME ZONE 'UTC')::date`, never `current_date`… a client in IST could set tomorrow and pass the check"). And `<=` includes midnight of the following day, so a transition stamped exactly `00:00:00Z` on day *d+1* is returned for as-of day *d*.

Should be:
```sql
AND occurred_at < ((("lotmark".as_of() + 1)::text) || ' 00:00:00+00')::timestamptz
```
This is the same class of error the JOB-CATALOGUE correctly flags in its own runner contract (`current_date` in the server's TimeZone) and the ASOF spec then commits.

### 2.5 ASOF §4.1's proposed CHECK is a midnight outage, not a hardening

```sql
CHECK (competence_checked_on IS NULL
       OR competence_checked_on::date = (signed_at AT TIME ZONE 'UTC')::date)
```

`competence_checked_on` derives from `ctx.today`, computed **once per request** at `plugins/session.ts:128`. `signed_at` comes from the DB clock inside `applySignature` at `signing.ts:102`, in a **later transaction**. A signing request that begins at 23:59:59.9Z and inserts at 00:00:00.1Z violates the CHECK and returns a 500 on a legitimate signature.

The spec's stated prerequisite ("`ctx.today` must come from the database clock") **narrows the window; it does not close it.** Closing it requires `today` and `signedAt` to come from the same `SELECT` in the same transaction — which is a real refactor of `requireSession`, not a one-line change.

Meanwhile §8.10(d) already specifies the same assertion as an invariant query, which costs nothing and provides the same evidence to an assessor against a restored backup. **Ship the query; cut the CHECK from the sweep migration.** As specified it is the only item in `0010_as_of.sql` that can break a currently-working path, and putting it in a 44-table sweep means a rollback of the sweep to fix it.

### 2.6 Neither test harness can run the tests either spec specifies

**ASOF §8** says "modelled on `rls.test.ts` (same `twoTenants` rollback harness)". `rls.test.ts:20-39` runs the entire body inside **one** `sql.begin` and never commits. `set_as_of` is transaction-local, so once set, *every subsequent statement in that transaction* — including further fixture writes — raises `LM_ASOF_WRITE`. And §8.7 ("set inside `sql.begin`, then on the *same pooled connection after commit* assert `current_setting` is NULL") is inexpressible in a harness that never commits and holds one connection for the whole body.

Required: per-assertion `set_config('lotmark.as_of','',true)` resets, and §8.7 as a standalone test outside `twoTenants`. Say so, or the first implementer improvises.

(§8.3's ordering claim — BEFORE STATEMENT fires before BEFORE ROW, so `LM_ASOF_WRITE` beats the audit-key error — **is correct**.)

**ANCHORING §8** is worse, and the cause is a §2 design decision. `audit-chain.test.ts` is entirely rollback-based (`inRollback`, `withFixtures`, `adminRollback`). §2.2.2 requires the signer to be *"a separate process… connects to Postgres as its own role `lotmark_signer`, reads `audit_head` and the ledger rows itself."* **A separate process cannot see uncommitted fixture rows.** Tests §8.1, §8.2, §8.5 and §8.7 — every one that needs "anchor at seq 50, then tamper" — are unrunnable as specified.

**Required, and it is a spec decision not an implementation detail:** factor sealing into a pure function

```
sealSegment(tx, { tenantId, ledger, fromSeq, throughSeq }, sign: (payload) => string)
```

in `packages/security/src/anchor.ts` (or a `packages/db` helper), taking a connection and a signing callback. `apps/signer/src/seal.ts` becomes a thin wrapper supplying its own connection and its own key. Without this, **§8.2 — the test that is the entire justification for the deliverable — cannot be written.**

### 2.7 Confirmed live bugs the specs found (verified, with corrections)

**`monitoringDue` raises a duplicate CAPA every run — confirmed, P0.** `0010_job_support.sql:63-64` is a plain `UNIQUE`, so NULLs are distinct; `notices.ts:141-146` inserts `NULL` for `organisation_id` with a bare `ON CONFLICT DO NOTHING`, which therefore never conflicts. Local PostgreSQL is **16.14**, so `UNIQUE NULLS NOT DISTINCT` is available. Two corrections: you cannot `ALTER` a constraint into `NULLS NOT DISTINCT` — drop and recreate `notice_once_per_threshold`; and it must be a new migration, because `migrate.ts:86-96` hard-refuses a changed checksum on `0010_job_support.sql`.

**`certificate_holders()`'s `from_vault` has no time predicate — confirmed.** `0009_holders.sql:67-75` cross-joins `window_bounds` and filters only `v.lot_id = w.lot_id AND v.quantity > 0`.

**But the proposed fix, as written, makes it worse.** `seed/run.ts:420-422` inserts `vault_holdings` with **no `acquired_on`**:
```sql
INSERT INTO lotmark.vault_holdings (tenant_id, organisation_id, lot_id, storage_location, quantity)
```
Every seeded row has `acquired_on IS NULL`. Adding `AND v.acquired_on <= w.from_at::date` therefore returns **zero vault holders for every issue** — silently emptying the holder list on the withdrawal path. The fix is three parts: backfill `acquired_on`, decide and state what NULL means (recommend: treat NULL as "held since before issue 1", i.e. `v.acquired_on IS NULL OR ...`, and add a `NOT NULL` in a later migration), and fix the seed.

**`notifyHolders` has the same silent hole A1 was flagged for, on the safety path, with a comment that lies.** `certificate-issue.ts:144-151`:
```ts
// A holder with no named contact still gets a notification row: the
// organisation must appear in the notification report even when the
// producer has to reach them another way.
const recipientId = h.contact_user_id ?? (recipient as { id: string } | undefined)?.id;
if (!recipientId) continue;
```
The JOB-CATALOGUE found this in A1 (`notices.ts:86`) and missed it here, where it is a **withdrawal** notice. Same fix, same migration.

**`job_runs.tenant_id` nullable — confirmed** (`compliance.ts:161`, `0000:565`); `0004`'s ELSE branch gives it `tenant_id = current_tenant()`, so a NULL row is unwritable and unreadable. `NOT NULL` is correct. Note `recordRun` (`context.ts:129-144`) already always writes a tenant on its own transaction — that part is "verify", not "build".

**ASOF §5.4's four temporal gaps — all confirmed.** `study_equipment` (`0000:362-365`, two FKs), `study_results` (`0000:367-380`, no `measured_at`), `facility_lots` (`0000:558-561`, two FKs), `vault_holdings` (`0000:498-507` + `0009:22`).

**ASOF §2.3's four escapes — all confirmed and this is the strongest argument in any of the three documents.** `audit_chain_append` writes `audit_head` at `0002:112` and `0002:135`; `nextCode` writes `numbering_counters` at `numbering.ts:52-61`; four SECURITY DEFINER functions exist; `study_equipment.study_id` is `ON DELETE cascade`. No objection.

---

## 3. ORDERING AND DEPENDENCY VIOLATIONS

### 3.1 All three specs claim migration `0010`, which is already applied

- ANCHORING §10: `packages/db/migrations/0010_audit_anchors.sql`
- ASOF §7: `0010_as_of.sql`
- JOB-CATALOGUE §5: `0011_job_fixes.sql` — the only one that is right

`0010_job_support.sql` exists and is checksum-recorded. `migrate.ts:37-51` sorts lexically; `:97-104` hard-refuses a recorded file missing from disk. Two files named `0010_*` would both apply in lexical order and the numbering would stop meaning anything. **Fix this first — it is ten minutes and everything else is blocked on it.**

### 3.2 JOB-CATALOGUE A9/A10 and ANCHORING §3/§7 are the same work, built by incompatible processes

A9 (`ledger.checkpoint`) and A10 (`ledger.checkpoint-export`) are specified as pg-boss cron jobs running on `lotmark_app`. ANCHORING §6.3 **revokes INSERT on `audit_checkpoints` from `lotmark_app`**, and §7 argues at length that the signer must have its own timer precisely because *"putting the only tamper-evidence mechanism behind a queue that the compromised component can enqueue into is a dependency inversion."*

A9 and A10 will fail with `permission denied for table audit_checkpoints` the moment the anchoring migration lands. **Cut A9 and A10 from the job catalogue.** They are ANCHORING §3 and §7 assigned to the wrong process with the wrong privileges. Keep A8 (`ledger.verify`) as a worker job — verification is read-only and belongs there.

### 3.3 A8 is not "Tier A, no schema change"

A8 says the hourly job "verifies from the last checkpoint's `through_seq`". `lotmark.verify_audit_chain(p_tenant)` (`0002:225`) takes one argument and rescans from `seq = 1`. The ranged form `verify_chain(tenant, ledger, from_seq, to_seq)` that `ARCHITECTURE.md:614` specifies **does not exist**. The spec notes this as a "gap" and then lists A8 under "buildable now, no schema change". Move A8 into the anchoring migration, where verification step 6 needs the same overload.

### 3.4 A1's fix is not schema-free either, and it is the same change as B1

A1's must-fix needs "a nullable-recipient notification row for organisation-level notices" — `notifications.recipient_user_id` is `.notNull()` (`distribution.ts:159`). B1's prerequisite is `channel, dispatched_at, attempts, last_error, dedupe_key`. Both are `ALTER TABLE notifications`. Do them in one migration; A1 is not Tier A.

### 3.5 ANCHORING deviates from ARCHITECTURE in two places without recording it

- `ARCHITECTURE.md` §4.5 bullet 2 names a table `audit_anchor`. The spec extends `audit_checkpoints` instead. Defensible; record it.
- `ARCHITECTURE.md` §2.1 says the signer *"exposes only `sign(root) → signature`"*, and §4.5 says `apps/worker` builds the Merkle tree. ANCHORING §2.2.2 **inverts this**: the signer builds its own statement and never signs caller-supplied bytes. This is a genuine strengthening and the right call — but it is a deviation, it is the direct cause of §2.6's untestability, and `docs/deviations.md` **does not exist** (confirmed: `ls docs/deviations.md` → No such file).

### 3.6 Both sweeps enumerate the same catalog; whichever ships second must not re-run the other's

The ASOF `DO` loop and `0004`'s loop both select `relkind='r'` in `lotmark`. If as-of ships first and anchoring second, `CREATE TRIGGER as_of_read_only` on a table that already has it fails with "trigger already exists". Use `CREATE OR REPLACE TRIGGER` (PG14+, available) or guard with `DROP TRIGGER IF EXISTS`. Also: ANCHORING §6.6 says `audit_checkpoints` "must be on the exemption list the wave-1 sweep builds" while ASOF §2.2 says "**No exemptions.** Not `audit_ledger`, not `audit_checkpoints`." They mean different sweeps (`generation` vs as-of). Say which.

---

## 4. OVERCLAIMS

ANCHORING §9 is the best-calibrated section in the three documents. Three overclaims survive it.

**(a) "a rewrite requires compromising both."** The one-sentence assessor summary leads with the strong claim and qualifies it after a semicolon. On a laptop with one admin account, compromising the API process and compromising the signer are the same event for anything reaching sudo — which is the developer's own password. §9's own bullet says this. The summary sentence has to **lead** with the ceiling, not close on it.

**(b) The key-free inclusion proof is real but the product cannot emit one.** §1.2 chooses a Merkle tree over the head hash primarily for selective disclosure. But nothing in §10 produces a path: `merklePath`/`verifyMerklePath` are listed as library functions, with no endpoint, no CLI subcommand, and no console screen. Until `GET /audit/:seq/inclusion-proof` exists, the selective-disclosure property belongs to the data structure and not to the deliverable. Either add the endpoint to §10 or say the tree is currently for O(log n) localisation only.

**(c) Not flagged at all — the `entry_hash`-in-leaf binding is not a property the assessor gets.** `leaf_i` includes `lp(entry_hash)`, and the assessor recomputes the leaf from the disclosed row's stored `entry_hash`. They cannot check that `entry_hash` is the correct HMAC of `entry_content` — that needs `LOTMARK_AUDIT_KEY`. The inclusion proof still holds (content is in the leaf), so the property survives. But §1.3's stated *reason* for including `entry_hash` — "binds the unkeyed tree to the keyed chain, so the two layers cannot be attacked independently" — is only true for a verifier holding the key, i.e. the operator, not the assessor. §9's third "Proves" bullet implies the assessor gets both. Separate the two verifier roles explicitly.

**(d) §5.2.1's permanence claim.** "It is chained like any other entry and is covered by the next anchor, so the discontinuity is permanently on the record" — true only if the signer is still running with a working key. In the scenario that produced the finding (restored forensic copy, API compromised) neither holds. Permanence belongs to the **anchor file**, not the ledger entry.

**(e) ASOF §3(b) states R8's reproducibility property unconditionally, and it is false for 16 tables.** *"for any record and `d1 < d2 < now`, the answer at `d1` computed today equals the answer at `d1` computed at `d2`."* §5.2 admits Class B rows are mutated in place with no version history, so the answer at `d1` computed today carries today's column values. The property holds for Class A and for state via `state_transitions`, and nowhere else. §8.9's property test only exercises `competence_records` — Class A — so it passes while the general claim stays false. State the property with its scope attached, in both places.

---

## 5. WHAT TO CUT

| Cut | Why |
|---|---|
| **JOB A9 + A10 entirely** | ANCHORING §3/§7 by the wrong process with revoked privileges (§3.2 above) |
| **JOB §1.1's reserved `system` role key** | No `RESERVED` set exists in `packages/domain/src/config/registry.ts` — it would have to be invented. And the ambiguity is unreachable: a tenant role keyed `system` yields entries with non-null `actor_user_id` and a person's `actor_label`; `systemAuditContext` (`jobs/context.ts:41-43`) yields `NULL` and `'system · <job>'`. Replace with one CHECK on `audit_ledger`: `actor_role_id <> 'system' OR actor_user_id IS NULL`. Cheaper, and actually enforces the property |
| **JOB §1.1's "assert at boot" apparatus for `systemInitiated`** | Keep the flag (the `ENTITLEMENT_MACHINE` self-contradiction at `state-machines.ts:137` is real). Cut the boot assertion: `packages/domain/src/roles.ts:100` explicitly *"Returns the offending grants rather than throwing"*, so the cited precedent does the opposite of what is claimed. And for `lapseEntitlements` the `WHERE state = 'approved'` predicate already **is** the transition guard, and it holds under concurrency in a way a TypeScript assertion does not |
| **JOB §1.2 bullet 4's numbered migration for pg-boss's schema** | `scheduler.ts:74-77` already connects on `DATABASE_ADMIN_URL` with `schema: 'pgboss'`; pg-boss 12 self-migrates and version-checks its own schema on `start()`. A hand-written migration will drift and be migrated over. Keep the *rule* (payloads carry ids only, never names, values, PII or the audit key) — that one is sound and unenforced |
| **ASOF §7 item 7 — the `signature_basis_checked_on_is_act_time` CHECK** | §2.5 above. Ship §8.10(d)'s invariant query instead |
| **ASOF: the claim that branding `WriteTx`/`AsOfTx` is free** | Keep the design — it is right. But `Sql = ReturnType<typeof postgres>` (`db.ts:4`) is the parameter type of every service and every one of 29 `inTenantTransaction` call sites. Branding it is a mechanical touch of every service signature, not "without a single new argument at any call site". Budget it honestly |

**Do not cut:** `lotmark_meta.temporal_class`. It is the single best idea across the three documents — a machine-readable fidelity claim an assessor can `SELECT`, in the same spirit as the `@pii:` registry. One note: `lotmark_meta` is created at runtime by `migrate.ts:66`, so the migration must `CREATE TABLE` there explicitly rather than assume it.

---

## 6. THE SINGLE HIGHEST-RISK ITEM

**Not the anchoring circularity. Not as-of. It is `certificate_holders()`'s `from_vault` CTE (`0009_holders.sql:67-75`), because it is live, wrong, and on the safety path — and both callers already ship notices from it.**

`0009`'s own header states the case: *"If an assigned value turns out to be wrong, everyone holding that certificate must be told. That is the product's central safety obligation, and it is only as good as the holder list."* Today every self-declared holding is returned for **every** issue number, so `notifyHolders` (`certificate-issue.ts:152`) sends issue-1 withdrawal notices to organisations that acquired the material after issue 3 — and, once `acquired_on` is populated, the set will be wrong in both directions. Compounding it, `certificate-issue.ts:150` silently drops any holder organisation with no active user, under a comment claiming the opposite.

Second-ranked: `monitoringDue` writing a fresh Critical-register CAPA every single day. Loud rather than silent, but it poisons the nonconformity register, which is an assessor-facing artefact.

**Build first, before any spec's main body:** renumber the migrations (§3.1), then one migration carrying the four live defects, then the `keys.ts` purpose split. Roughly three days, and it retires more risk than the twelve-to-eighteen-day anchoring item does.

---

## 7. CONSOLIDATED BUILD ORDER

### Step 0 — Renumber and reconcile · 0.5 d
One file per four-digit prefix across all three specs' outputs. Fix ANCHORING §10 and ASOF §7 to `0013_` and `0012_`.

**Done when:** `pnpm db:migrate` applies cleanly on a fresh database and `pnpm db:status` lists them in order.
**Test:** a `migrate.test.ts` asserting `loadMigrations()` returns strictly increasing, non-duplicated prefixes. Three lines; does not exist; would have caught this.

---

### Step 1 — `0011_live_defects.sql` + the four job fixes · 2–3 d
**Migration:** `certificate_holders()` gains the issue-window predicate on `from_vault`, *with* an `acquired_on` backfill and a stated NULL semantic; `notice_once_per_threshold` dropped and recreated `UNIQUE NULLS NOT DISTINCT`; `job_runs.tenant_id NOT NULL`; `notifications.recipient_user_id` nullable + `CHECK (recipient_user_id IS NOT NULL OR organisation_id IS NOT NULL)`.
**Code:** `notices.ts` A1 claims the `notice_log` row *after* the notification insert; A2 uses `nextCode(tx, {entity:'capa'})` (template seeded at `defaults.ts:108`, counter seeded at `seed/run.ts:471`) and `ORDER BY checked_on DESC, id DESC LIMIT 1`; A3 guards the tier revert with `NOT EXISTS (... state='approved')`; `certificate-issue.ts:150` drops the `continue`. Seed writes `acquired_on`.

**Tests that must exist for this to count as done:**
- `packages/db/src/__tests__/holders.test.ts` — two issues, a vault holding acquired between them: present for issue 2, **absent** for issue 1. *This is the acceptance test for the entire `0009` design and it does not exist.*
- `apps/api/src/__tests__/jobs.test.ts` — `monitoringDue` run twice in one transaction ⇒ `count(capa) == 1`. Cannot be written before the migration; is the only proof of the fix.
- Same file — `lotExpiryNotices` run twice ⇒ identical `notifications` count; a holder org with no active user ⇒ **no** `notice_log` row claimed.
- Same file — `lapseEntitlements` with an org holding two approved entitlements ⇒ `price_tier` stays `'government'`.

---

### Step 2 — `0012_as_of.sql` · 5–8 d
ASOF §7 items 1–6 and 8. **Cut item 7.** Fix `as_of_state`'s timezone and boundary (§2.4). Add the `REVOKE EXECUTE ... FROM PUBLIC` pair *before* granting `lotmark_reader` (§2.3), plus explicit `GRANT EXECUTE` to `lotmark_app` on every function `0011`/`0012` introduce.

Ship this before anchoring, for ASOF §7's reason and one more: the anchoring migration adds columns to `audit_checkpoints`, and attaching the invariant first means anchoring inherits it rather than being retrofitted into it.

**Tests:**
- §8.1 `pg_trigger` completeness, mirroring `rls.test.ts:127-143`. This is what makes a table added in 2027 fail the build.
- §8.4 the **zero-row UPDATE** test — the only test that distinguishes `FOR EACH STATEMENT` from `FOR EACH ROW`. A row trigger passes every other test in the file and fails this one.
- §8.2, §8.3, §8.5, §8.6, §8.8, §8.9 (the competence property test — catches the bug written **four** times), §8.11.
- §8.7 rewritten standalone, outside `twoTenants` (§2.6).
- **New, not in the spec, and mandatory:** `has_function_privilege('lotmark_reader','lotmark.provision_tenant(uuid,text,text,text,text,text,text)','EXECUTE') = false`. Without it, §1.3's central claim is untested and false.
- **New:** `SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='lotmark_reader' AND privilege_type <> 'SELECT'` is zero.

---

### Step 3 — `signing_keys.purpose` + `keys.ts` · 0.5 d, one commit
Column with `DEFAULT 'record'`, the index redefinition, `keys.ts:52` gains `AND purpose = 'record'`, `public_signing_key` returns `purpose`. **Land all of it together and only then mint an anchor key.**

**Test:** `apps/api/src/__tests__/keys.test.ts` — register a second un-retired key with `purpose='anchor'` and a distinct `key_version`, assert `KeyProvider.active()` still returns the record key. Does not exist; §2.1 is invisible without it.

---

### Step 4 — `0013_audit_anchors.sql` + `apps/signer` · 12–18 d
ANCHORING §6 with four required amendments: §2.2's `exported_at` resolution (recommend the separate insert-only table); the ranged `verify_audit_chain` overload that A8 and verification step 6 both need; `sealSegment()` as a library function so §8 is runnable; `.US` timestamps rendered by `to_char` in SQL.

**Tests:** §8.1–§8.8, all runnable because of `sealSegment`. **§8.2 is the acceptance test for the deliverable** — the attacker holds `LOTMARK_AUDIT_KEY`, `verify_audit_chain` returns `ok = true`, the anchor returns `SEGMENT_ALTERED at seq 30`. If that test does not exist, anchoring is not done regardless of what else passes. Plus `audit-chain.test.ts:377-385` ("no trigger in the schema is left disabled") must still pass with the new triggers in place.

---

### Step 5 — Wire the scheduler that already exists · 1–2 d
`RUN_SCHEDULER` into `app.ts`; stop the `Scheduler` in `main.ts`'s signal handler. Register only jobs whose defects step 1 fixed.
**Tests:** `worker.ts --list` in CI; every name in `JOBS` resolves through `runNow()` against an empty tenant without throwing.

### Step 6 — A12 session retention · 1–2 d
Replace `pruneSessions` (`notices.ts:215-225`). Floor 180 days, ceiling 13 months per `retention.ts` `session_and_access_log`, legal-hold check, one summary ledger entry per run. The current 7-day sweep destroys CERT-In-mandated data and the spec's reasoning is correct.
**Test:** 30-day-expired session survives; 200-day is deleted; with an active `legal_holds` row carrying `session_and_access_log`, nothing is deleted and `job_runs` records `success / 0 items` with a stated reason.

### Step 7 — A8 `ledger.verify` as a worker job · 1 d
Now that the ranged overload exists. CAPA workflow is still absent (MVP1 blocker 10, and `apps/api/src/routes/` has no CAPA routes — confirmed), so emit `capaRequired: true` and a `job_runs` failure; do not auto-raise.
**Test:** unset audit key ⇒ the job reports "not verifiable", **not** "chain broken". `0002:235-238` returns `ok=false` for both, and conflating them is the spec's own stated hazard.

### Step 8 — A4, A5, A6, A7, A11 · 3–5 d
Each needs one test: run twice, assert one notice.

### Step 9 — notifications outbox (B1/B2) · 5–8 d, then B3
B2's assertion — every withdrawn issue has a dispatched notice for every org from `certificate_holders()` — only becomes meaningful **after step 1** fixes that function. Ordering it before step 1 would ship an assertion that certifies a broken holder list.

---

**Correctly deferred, and I found nothing to add to JOB-CATALOGUE §4** except one sharpening: `certificate.render` as a job is *more* blocked than stated. `renderAndStoreIssue` (`certificate-issue.ts:44-127`) performs an `UPDATE certificate_issues` inside the issue transaction, and `0008:46-58`'s `certificate_document_provenance_is_whole` CHECK requires all eight document columns be whole-or-null. Decoupling the render leaves the issue row in the null state, so that CHECK has to be re-read as "eventually whole" — which weakens the constraint whose comment says *"A half-recorded provenance is worse than none: it looks reproducible."* Name that trade before touching it.