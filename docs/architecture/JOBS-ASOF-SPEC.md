
===== JOB-CATALOGUE =====
# LOTMARK — BACKGROUND JOB CATALOGUE

Derived from the schema and routes as they stand. Every claim below is checked against the files cited.

---

## 0. CORRECTIONS TO THE STATED CURRENT STATE

Three of the given premises are now wrong; the spec depends on this.

1. **pg-boss IS installed.** `apps/api/package.json:22` declares `"pg-boss": "^12.27.0"`; it resolves in `pnpm-lock.yaml:1756` and is present at `apps/api/node_modules/pg-boss`. Nothing imports it — `grep -r "pg-boss" --include=*.ts` over `apps/` and `packages/` returns zero hits. So: **installed, unused, unwired.**
2. **A migration `0010_job_support.sql` now exists** (11 migrations, not 10). It adds `lotmark.all_tenants()` (SECURITY DEFINER), a `job_runs` CHECK + index, and a new `lotmark.notice_log` table with an append-only trigger pair.
3. **Two job files now exist**: `apps/api/src/jobs/context.ts` and `apps/api/src/jobs/notices.ts`. Nothing imports them, there is still no scheduler, and no `apps/worker`. `ls apps/` returns `api web` only.

`audit_checkpoints` is still never written and still has no signature column (`packages/db/src/schema/audit.ts:95-110`). There is still no `app.as_of` GUC.

---

## 1. THE TWO STRUCTURAL QUESTIONS

### 1.1 Who is the actor in the ledger?

`audit_ledger.actor_user_id` is **nullable** (`0000_initial_schema.sql:200`); `actor_label` and `actor_role_id` are `NOT NULL`. `packages/db/src/schema/_shared.ts` already declares the intent: *"Who did it — a user id, or the literal `'system'` for scheduled jobs."*

**Ruling: `actorUserId = null`, `actorLabel = 'system · <job-name>'`, `actorRoleId = 'system'`, `sessionId = null`.** This is what `systemAuditContext()` in `apps/api/src/jobs/context.ts:34-47` already does, and it is correct. A synthetic user row would be a lie in the one table that must not contain one, and it would be FK-resolvable — an assessor would follow it to a person who did nothing.

Three requirements this does not yet meet:

- **`'system'` must be a reserved role key.** Roles are loaded from `config_entries` where `kind = 'role'` (`apps/api/src/plugins/session.ts:88-92`), so a tenant can today create a role keyed `system` and make ledger attribution ambiguous. Add `system` to the reserved-key set in `packages/domain/src/config/registry.ts` and a CHECK on `config_entries`.
- **`timeSource` / `region` must come from the tenant row**, not a constant. `all_tenants()` returns both for exactly this reason; `forEachTenant` threads them through. Keep it — those two fields are inside the hashed payload (`lotmark.audit_payload`, `0002_audit_chain.sql`).
- **A job is not exempt from the state machine, only from `guard()`.** `guard()` requires a `ResolvedAuthority` and a job has none. But `ENTITLEMENT_MACHINE` (`packages/domain/src/state-machines.ts:128-139`) declares `approved → lapsed` as `requires: 'entitlement:decide'` while its own comment says *"lapsing is done by a job"* — the machine contradicts itself, and `lapseEntitlements()` currently just issues a raw `UPDATE`. **Add `systemInitiated: true` to the transition type**, and require every job transition to assert `canTransition(...)` **and** `transition.systemInitiated === true`. That is the job-shaped equivalent of the guard chain and it is checkable at boot (the existing boot-assertion pattern in `packages/domain/src/roles.ts`).

### 1.2 How does a job sweep all tenants without weakening RLS?

**It does not sweep. It iterates, and runs inside each tenant's context.** `lotmark.all_tenants()` (`0010_job_support.sql:24-27`) is `STABLE SECURITY DEFINER`, granted to `lotmark_app`, and returns only routing fields — the same narrow bootstrap shape as `resolve_tenant()` in `0006`. `forEachTenant()` (`jobs/context.ts:95-125`) then opens **one `inTenantTransaction` per tenant**, so `current_tenant()` is set and every policy applies unchanged.

This is the right answer and the reasoning in `0010`'s header is the reasoning to keep: a `BYPASSRLS` job role would create a privileged path exercised only by unattended code at 3am, which is the worst place for the policies to be untested. **No new role, no policy change, no `USING (true)` escape hatch.**

Four constraints that follow and are not yet honoured:

- **One tenant's failure must not abandon the rest.** `forEachTenant` already does this (per-tenant try/catch, aggregate outcome `partial`). Keep it; it is the reason `job_runs.outcome` has three values.
- **`job_runs.tenant_id` is nullable and that capability is dead.** The `0004` DO-loop gave `job_runs` the default predicate `tenant_id = current_tenant()`, so a row with `tenant_id IS NULL` can be neither inserted (`WITH CHECK` fails) nor read. **Make the column `NOT NULL`.** Do not "fix" it with `tenant_id IS NULL OR tenant_id = current_tenant()` — that leaks one global row into every tenant's view.
- **Never carry cross-tenant data into a tenant-scoped write.** The output of `all_tenants()` must never reach a `recordAudit` `detail` or `changes`, or a ledger entry in tenant A names tenant B.
- **pg-boss's own tables live outside `lotmark` and have no RLS.** `lotmark_app` holds `GRANT USAGE ON SCHEMA lotmark` and no DDL (`0005_app_role.sql:29-35`, deliberately), so pg-boss cannot bootstrap its schema as the app role. Its schema must be created by the migrator/owner as a numbered migration, and **job payloads must carry ids only — never names, values, PII, or the audit key.** A pg-boss payload is an unprotected cross-tenant table.

---

## 2. THE SHARED RUNNER CONTRACT

Every job in the catalogue, without exception:

| Property | Rule |
|---|---|
| Entry point | `forEachTenant(sql, { jobName, auditKey }, work)` — `jobs/context.ts` |
| Transaction | One per tenant, via `inTenantTransaction` (`apps/api/src/db.ts:36-49`). Both GUCs are `set_config(..., true)` so they cannot leak into the next borrower of the pool |
| Audit key | Needed **only if the job writes a ledger entry**. The chain trigger raises if it is unset (`0002_audit_chain.sql`, `audit_chain_append`), so a job that forgets `inTenantTransaction` fails loudly at its first audited act |
| Run record | `job_runs` row written per tenant per run, success **and** failure, on a separate transaction (a failed business transaction has rolled back). `job_run_outcome_is_recorded` CHECK (`0010`) enforces that a finished run names its outcome |
| Idempotency substrate | `lotmark.notice_log` unique key, or a state predicate in the `WHERE` clause, or a content-addressed digest. Never a `SELECT`-then-`INSERT` — that races two workers |
| Clock | `current_date` is evaluated in the **server's** `TimeZone`, not the tenant's `region`. Every date-boundary job must `SET LOCAL TimeZone` from the tenant, or compute in UTC and state so. Otherwise a 90-day notice fires a day early for half the tenants |
| Failure classes | **retry** (transient: lock timeout, connection loss) → pg-boss backoff, 5 attempts; **dead-letter** (poison: constraint violation, malformed config) → `job_runs.outcome='failure'` + alert, never retried blindly; **CAPA** (a control failed) → `capa` row. Only three jobs are in the CAPA class: `ledger.verify`, `document.digest-verify`, `monitoring.due-scan` |
| Never | Never `UPDATE`/`DELETE` `audit_ledger`, `signatures`, `state_transitions`, `notice_log` (revoked in `0005` and trigger-refused in `0002`/`0003`/`0010`). Never `TRUNCATE`. Never call `provision_tenant`. Never write a ledger entry with a real `actor_user_id` |

---

## 3. THE CATALOGUE

### Tier A — buildable now, no schema change

---

**A1 · `lot.expiry-notices`** *(exists at `jobs/notices.ts:22-110`, defective)*

- **Trigger** cron, daily 06:00 tenant-local.
- **Reads** `lots` (state `released`, `expiry_date`), `certificates`, `certificate_issues` (max `issue_number`), `lotmark.certificate_holders(cert_id, issue_no)` — which is `order_lines UNION vault_holdings` (`0009_holders.sql:36-88`), `users`, `notice_log`.
- **Writes** `notice_log`, `notifications`, one `audit_ledger` entry per tenant per run when `sent > 0`.
- **Idempotency** `notice_log` unique on `(tenant_id, notice_kind, subject_table, subject_id, threshold, organisation_id)`, claimed by `INSERT ... ON CONFLICT DO NOTHING RETURNING id` **before** the notification is written. Thresholds are **bands, not date equalities** — `expiry_date <= today+N AND expiry_date > today+tighter` — which is the property that makes a missed run recoverable: the next run still finds the lot inside its band. Keep this design.
- **Failure** retry. Never CAPA — a missed commercial reminder is not a nonconformity.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** notify on a `withdrawn` lot (withdrawal already notified via `notifyHolders`, `services/certificate-issue.ts:135-176`); never re-send an already-claimed threshold; never send from a job that cannot resolve a recipient (see defect below).
- **Must fix**
  1. Thresholds are `[90, 30, 7]`; `ARCHITECTURE.md §3.11` specifies T-180/90/60/30/0. Reconcile explicitly or state the deviation in `docs/deviations.md`.
  2. **Silent hole**: the `notice_log` row is claimed at `notices.ts:70`, but the recipient lookup at `:79-84` can yield `null` and the job `continue`s — the organisation is now permanently marked notified with nothing sent. `notifications.recipient_user_id` is `NOT NULL`, so there is no way to record "known holder, no contact". Either claim the log row **after** a successful notification insert, or add a nullable-recipient notification row for organisation-level notices.

---

**A2 · `monitoring.due-scan`** *(exists at `jobs/notices.ts:118-172`, defective)*

- **Trigger** cron, daily.
- **Reads** `monitoring_points` (`next_due_on < current_date`, latest `checked_on` per study — index `monitoring_points_due_idx` covers it), `studies`, `notice_log`, `config_entries` (numbering).
- **Writes** `notice_log`, `capa` (state `open`, severity `Major`, `due_on = current_date + 14`), `audit_ledger`.
- **Idempotency** `notice_log` keyed on `threshold = next_due_on` — i.e. one CAPA per missed due date, not one per run. Correct in intent.
- **Failure** raise a CAPA is the *output*; the job's own failure is retry.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** raise a second CAPA for the same `next_due_on`; never close or advance an existing CAPA (the workflow is `capa:manage`, a human act, `CAPA_MACHINE`).
- **Must fix (both are P0)**
  1. **The idempotency does not hold.** `notice_log`'s unique constraint includes `organisation_id`, and this job inserts `NULL` there (`notices.ts:141`). Postgres treats NULLs as **distinct** in a `UNIQUE` constraint by default, so `ON CONFLICT DO NOTHING` never conflicts — **the job raises a fresh CAPA on every single run**. This is precisely the double-run failure `notice_log` exists to prevent, and it lands on the nonconformity register. Fix in a new migration: `UNIQUE NULLS NOT DISTINCT (...)` (PG 15+), or a unique index over `coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid)`. This equally affects A4–A7 below, all of which have no organisation.
  2. **CAPA code is `NCR-${count(*)+1001}`** (`notices.ts:146-147`). This is the exact defect `0007_numbering_counters.sql` was written to remove and that `MVP1-TIERS.md` blocker 16 names for `CRT-{count(*)+2041}`. It races and collides with `capa_tenant_code_unique`. A `capa` numbering template already exists (`packages/domain/src/config/defaults.ts:108`, `NCR-{SEQ}`, yearly) — call `nextCode(tx, { tenantId, entity: 'capa', today })`.
  3. Ties on `max(checked_on)` (no unique on `(study_id, checked_on)`) yield two rows and two CAPAs. Order by `checked_on DESC, id DESC LIMIT 1` per study.

---

**A3 · `entitlement.revalidation-lapse`** *(exists at `jobs/notices.ts:182-215`, defective)*

- **Trigger** cron, daily.
- **Reads** `entitlements` (`state='approved' AND revalidation_due < current_date`), `organisations`.
- **Writes** `entitlements.state='lapsed'`, `state_transitions`, `organisations.price_tier='private'`, `audit_ledger`.
- **Idempotency** naturally idempotent — the `WHERE` predicate selects the state the `SET` clause leaves. A second run matches nothing.
- **Failure** retry.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** delete the entitlement (`ENTITLEMENT_MACHINE` terminal state is `lapsed`; the claim and its decision stay part of the record); never revert a tier the customer is still otherwise entitled to.
- **Must fix**
  1. **Tier revert is wrong when an organisation holds a second approved entitlement.** `notices.ts:194-196` unconditionally sets `price_tier='private'`. Guard it: revert only when `NOT EXISTS (SELECT 1 FROM entitlements WHERE organisation_id = ... AND state = 'approved')`.
  2. Raw `UPDATE` bypasses the machine. Assert `canTransition(ENTITLEMENT_MACHINE, 'approved', 'lapsed')` and the new `systemInitiated` flag (§1.1).
  3. `kind: 'ENTITLEMENT'` is not in the `AuditKind` union (`services/audit.ts:22-24`) — this does not typecheck. Same for `kind: 'NOTIFICATION'` at `notices.ts:103`. Either extend the union or map to `WORKFLOW`.

---

**A4 · `competence.expiry-horizon`** — new

- **Trigger** cron, daily.
- **Reads** `competence_records` (`valid_to` within 60/30/7 days, `superseded_by_record_id IS NULL`), `users` (`deactivated_at IS NULL`).
- **Writes** `notice_log`, `notifications` (to the holder and to every user holding `competence:manage`), `audit_ledger`.
- **Idempotency** `notice_log` keyed `('competence_expiry', 'competence_records', id, threshold, NULL)`.
- **Failure** retry.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** extend, renew, or supersede a competence record. **Never** revoke a session because competence is about to lapse — `loadLiveSession` (`services/sessions.ts:83-101`) does no competence check; `guard()` does it per-act at `services/guard.ts:106-127`, which is the correct place.
- **Why owed**: `MVP1-TIERS.md` blocker 12 — *"every authorisation in the seed expires and the system progressively locks itself shut with no recovery path."* `COMPETENCE_GATED` covers `study:sign`, `value:assign`, `value:authorise`, `cert:issue` — the four acts the product exists to perform.

---

**A5 · `calibration.expiry-horizon`** — new

- **Trigger** cron, daily.
- **Reads** `calibrations` (`valid_to` within 60/30/7), `equipment`, and — for lapse impact — `study_equipment → studies → projects → lots → certificates`.
- **Writes** `notice_log`, `notifications`, `audit_ledger`.
- **Idempotency** `notice_log` keyed on `('calibration_expiry', 'calibrations', id, threshold, NULL)`.
- **Failure** retry.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** compute the impact closure against the *signature* date. `ARCHITECTURE.md §4.6` Closure 1 correction: cover is checked against measurement time. `study_results` has no `measured_at` column today (`packages/db/src/schema/production.ts`), so **the horizon notice ships now and the impact trace waits** for that column. Say so rather than shipping a trace judged on the wrong date — that is the prototype's inverted control.

---

**A6 · `subcontractor.accreditation-horizon`** — new

Identical shape to A5 over `subcontractors.accreditation_valid_to` (`packages/db/src/schema/compliance.ts:68`). Cheap; the table exists and nothing reads it.

**Never** auto-disable a subcontractor. Forbidden-activity enforcement is a domain rule at the service boundary, not a job.

---

**A7 · `capa.overdue-escalation`** — new

- **Trigger** cron, daily.
- **Reads** `capa` (`due_on < current_date AND state <> 'closed'`), `users`, `teams`.
- **Writes** `notice_log`, `notifications` to `owner_user_id` and to `owner_team_id`'s members, `audit_ledger`.
- **Idempotency** `notice_log` keyed on `('capa_overdue', 'capa', id, <days-overdue band: 1|7|30>, NULL)` — bands, so one CAPA does not generate a daily notice for a year.
- **Failure** retry.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** change `capa.state` or `capa.severity`. There is no `escalated_at` column and no stored escalation ladder; escalation is a **notice**, not a mutation. Auto-advancing a CAPA state would make the register self-clearing, which is the failure class `MVP1-TIERS.md` blocker 10 names: *"a control that looks green and does nothing."*

---

**A8 · `ledger.verify`** — new

- **Trigger** cron, hourly (incremental, once it exists) and nightly (full).
- **Reads** `lotmark.verify_audit_chain(p_tenant)` (`0002_audit_chain.sql`).
- **Writes** `audit_ledger` (a `SYSTEM` entry recording the verdict — this appends to the chain it just checked, which is correct: the next run covers this one, exactly as `routes/console.ts:245-258` already does for the manual path), and on failure a `capa`.
- **Idempotency** read-only over the ledger; the only write is one entry per run. Two runs produce two entries and that is correct — a verification is an event, not a state.
- **Failure** `ok = false` is **not** a job failure, it is a **finding**: raise a `capa` with `source = 'LEDGER_DISCONTINUITY'`, `severity = 'Critical'`, `subject_table = 'audit_ledger'`, `subject_id = broken_at`, and alert. `ARCHITECTURE.md §4.5` makes CAPA-raising the defined recovery. The job itself failing (no key, connection loss) is retry.
- **Tenant** per-tenant. **Audit key** yes — `verify_audit_chain` returns `ok=false, reason='lotmark.audit_key is not set'` without it, which would look identical to a broken chain. **The job must distinguish these two outcomes before raising anything.**
- **Never** attempt repair. Never suppress a divergence as "probably a restore."
- **Gap**: `verify_audit_chain(p_tenant)` takes no range and rescans from `seq = 1` every call — O(n) forever. `ARCHITECTURE.md §4.4` specifies `verify_chain(tenant, ledger, from_seq, to_seq)`. Add the ranged overload before scheduling this hourly; the hourly job verifies from the last checkpoint's `through_seq`, the nightly one verifies whole.

---

**A9 · `ledger.checkpoint`** — new

- **Trigger** cron, every 5 minutes (and on 10,000 new entries, once pg-boss carries the counter).
- **Reads** `audit_head` (`tenant_id`, `ledger='audit'`, `seq`, `head_hash`), `audit_checkpoints` (last `through_seq`).
- **Writes** `audit_checkpoints` (`through_seq`, `head_hash`, `entry_count`, `taken_at`).
- **Idempotency** skip when `head.seq = last_checkpoint.through_seq`. Two runs in the same 5-minute window with no new entries write nothing.
- **Failure** retry. Sustained failure (checkpoint age over threshold) is an alert, not a CAPA — nothing is yet wrong with the data.
- **Tenant** per-tenant. **Audit key** not required (no ledger entry; deliberately, so checkpointing does not itself advance the head it is trying to pin).
- **Never** `DELETE` a checkpoint (revoked in `0005:52` and trigger-refused at `0002`). `UPDATE` is permitted and is reserved for A10 setting `exported_at`.
- **Honest scope**: this is **not** the `ledger.anchor` of `ARCHITECTURE.md §4.5`. `audit_checkpoints` has no signature column and lives inside the database it notarises, so restoring a doctored backup restores the doctored checkpoints with it — the tamper-evidence argument is circular, exactly as `MVP1-TIERS.md` blocker 8 states. Ship A9 as `ledger.checkpoint`, name it that, and put `apps/signer` + Ed25519 anchors behind it as a separate 12–18 PD item.

---

**A10 · `ledger.checkpoint-export`** — new

- **Trigger** cron, every 15 minutes.
- **Reads** `audit_checkpoints WHERE exported_at IS NULL`.
- **Writes** an append-only JSONL file at a path the database cannot reach (`var/anchors/<tenant>/audit/<date>.jsonl`), then sets `exported_at` + `export_target`.
- **Idempotency** file line keyed on `(tenant_id, through_seq)`; re-export is a no-op. `exported_at IS NULL` is the work predicate, so a crash between write and update re-exports the same line and is absorbed.
- **Failure** retry; sustained failure alerts. A checkpoint that never leaves the database provides nothing, so **export age is the SLO, not checkpoint age.**
- **Tenant** per-tenant. **Audit key** no.
- **Never** write the export to a path the app role can also delete; never overwrite an existing line.

---

**A11 · `document.digest-verify`** — new

- **Trigger** cron, weekly.
- **Reads** `certificate_issues` (`document_sha256 IS NOT NULL`), `DocumentStore.get()` (`services/documents.ts:38-51`) — which already re-hashes and throws on mismatch.
- **Writes** `audit_ledger` on mismatch or missing file; `capa` (`severity='Critical'`) on mismatch.
- **Idempotency** pure read + compare. Running twice produces the same verdict. Only raise a CAPA if `notice_log` does not already carry `('document_mismatch', 'certificate_issues', id, sha256, NULL)`.
- **Failure** a mismatch or `DocumentMissingError` is a **finding** → CAPA. Job failure → retry.
- **Tenant** per-tenant. **Audit key** yes.
- **Never** re-render the document to "repair" it. The stored bytes are what the signature at `certificate_issues.document_signature` covers; regenerating produces different bytes and destroys the evidence.

---

**A12 · `session.retention-sweep`** — **replaces** `pruneSessions()` (`jobs/notices.ts:222-236`), which is wrong as written

- **Trigger** cron, daily.
- **Reads** `sessions`, `legal_holds` (active: `released_at IS NULL`, `retention_classes @> '["session_and_access_log"]'`).
- **Writes** deletes `sessions` rows older than the retention floor.
- **Idempotency** predicate-driven; a second run finds nothing.
- **Failure** retry.
- **Tenant** per-tenant. **Audit key** no ledger entry per row, **one** summary entry per run (see below).
- **Never** delete inside the retention floor. **Never** run while a legal hold covers the class.
- **Must fix (P0)**: `pruneSessions` deletes at `expires_at < now() - 7 days`. Retention class `session_and_access_log` (`packages/domain/src/retention.ts:96-104`) is *"180 days, in India"* minimum, 13 months maximum, `indiaResident: true`, `erasureRefusable: true`. **The `sessions` table is the access log — there is no separate one.** A 7-day sweep destroys the CERT-In-mandated record. Floor at 180 days, ceiling at 13 months. And the comment *"Deliberately NOT audited"* is defensible for the individual row but not for the run: the sweep must write one summary `audit_ledger` entry (count, floor date, hold check) or a deletion of security telemetry leaves no trace at all.

---

### Tier B — owed, but each needs one named schema change first

**B1 · `notification.dispatch` (outbox drain)** — **blocked, and honestly so.**
`notifications` (`packages/db/src/schema/distribution.ts:180-213`) has `read_at` and `acknowledged_at` but **no `channel`, no `dispatched_at`, no `attempts`, no `last_error`**. There is no `notification_outbox` table (`ARCHITECTURE.md §4.2` names one; `MVP1-TIERS.md:17` lists it among the 26 absent tables). And **no route reads `notifications` at all** — `grep -rn "notifications" apps/api/src/routes` returns nothing. So the table is currently a write-only sink with no drain state and no reader.
**Prerequisite**: add `channel`, `dispatched_at`, `attempts`, `last_error`, `dedupe_key UNIQUE`. Then the drain is: claim with `UPDATE ... SET attempts = attempts + 1 WHERE dispatched_at IS NULL AND attempts < 5 RETURNING ...` under `FOR UPDATE SKIP LOCKED`; idempotent because `dispatched_at IS NULL` is the claim; dead-letter at 5; **never suppress a withdrawal notice** for any preference reason (`ARCHITECTURE.md §12 R14`: legal override).

**B2 · `notification.reconcile`** — same prerequisite.
Asserts that every `certificate_issues` row with `withdrawn = true` has a dispatched notice for **every** organisation returned by `lotmark.certificate_holders(...)` — i.e. `order_lines ∪ vault_holdings`, not orders alone (`ARCHITECTURE-CRITIQUE.md` P1-13). Failure → CAPA, `severity = 'Critical'`. This is the assertion that makes the safety obligation checkable rather than assumed.

**B3 · `shipment.excursion-detect`** — **reshaped, because the candidate as posed does not exist in the schema.**
`logger_readings.shipment_id` references `shipments`, not `facilities` (`distribution.ts:120-134`). `facility_excursions.facility_id` references `facilities` and has **no reading source at all** — the rows are hand-entered (`seed/run.ts:437`). So **"facility excursion detection from logger_readings" is underivable**; there is no facility-level temperature data in the 43-table schema.
What *is* derivable is **shipment** excursion detection: `logger_readings.celsius` against `shipments.temperature_class` (a `text` like `'2-8'`, which must first be parsed into bounds — today nothing does). Output per `ARCHITECTURE.md §11 Phase 4`: an auto-raised CAPA with computed blast radius, MKT, duration and contiguity. Prerequisites: a `shipment_excursions` table (or extend `facility_excursions.subject_type` polymorphically), parsed limits on `temperature_class`, and MKT in `packages/stats`. **Do not** write excursion detection against `facility_excursions` — you would be inventing a data source.

---

## 4. NOT NEEDED YET, AND WHY

| Candidate | Why not |
|---|---|
| **Retention sweep / purge** (beyond A12) | `RETENTION_SCHEDULE` ids exist only in TypeScript. **No business table carries a `retention_class` column**, so a sweep cannot find rows by class — it would have to hardcode the mapping, which is the "table of prose" defect the schedule was built to replace. `legal_holds.retention_classes` is `jsonb string[]` with `subject_table`/`subject_id` nullable, so a hold's scope is ambiguous. Add the column and a per-class predicate before scheduling anything that deletes |
| **DPDP erasure execution** | Per `ARCHITECTURE.md §12 R10` this is a **decision procedure** (erase / pseudonymise / refuse-with-reason), producing a refusal artefact citing the retention row. That is a screen and an endpoint, not a job |
| **`competence.reverification`** | Fires on *correction* of a competence record. There is no competence create/edit endpoint (`MVP1-TIERS.md` blocker 12) and `competence_records` is append-only in effect. No trigger exists to hook. Build with A4's endpoint, not before |
| **`components.staleness-scan`** | `uncertainty_component` and `property_value_version` do not exist (`MVP1-TIERS.md` blocker 15). `property_values.components` is a `jsonb` snapshot with no `input_digest`, so "stale" is not computable |
| **`certificate.render` as a job** | Rendering is currently synchronous **inside** the issue transaction (`renderAndStoreIssue`, `services/certificate-issue.ts:44-127`). Decoupling it is blocker 16, and doing it as a job before the veraPDF gate exists buys asynchrony for a renderer that has no conformance check to fail on |
| **Order / dispatch / allocation jobs** | No order routes exist — `orders`, `order_lines`, `shipments`, `vault_holdings` are seed-only. Nothing produces the data these would consume |
| **`backup.verify`, `dr:drill`** | Blocker 11; depends on the signer process (blocker 8). Its acceptance test *is* anchor verification, so it cannot precede A10 + a real anchor |
| **`retention.purge-retired-generations`** | There is no `generation` column (`MVP1-TIERS.md` blocker 5). Nothing to purge |
| **Session/token cleanup as a separate job** | Folded into A12. Idle and expiry are already enforced **at use** (`loadLiveSession`, `services/sessions.ts:83-101`), deliberately — *"so a session cannot be used in the gap between falling idle and being swept."* A job that also expired sessions would be a second, weaker copy of a control that already holds |
| **Facility excursion detection** | See B3. No data source in the schema |

---

## 5. IMPLEMENTATION ORDER

1. **Fix `notice_log`'s NULL-organisation unique** (new migration). Until then every organisation-less notice job re-fires on every run — A2 raises a duplicate CAPA daily.
2. **`job_runs.tenant_id` → `NOT NULL`**; extend `AuditKind`; reserve the `system` role key; add `systemInitiated` to the transition type.
3. **Fix A1–A3** (recipient hole, `nextCode` for CAPA, tier-revert guard, machine assertion). **Replace `pruneSessions` with A12.**
4. **Wire pg-boss**: owner-role migration for its schema, `apps/worker` as a separate process (`ARCHITECTURE.md §1.5`, `§13 D6`), `WORKERS=inline` for demo. Cron registrations only — no queue consumers until B1.
5. **A8 → A9 → A10** in that order. A8 without A9 has nothing to verify incrementally from; A9 without A10 is circular.
6. **A4–A7, A11.** All cheap, all read tables nothing currently reads.
7. **B1/B2** once the outbox columns land; **B3** once `temperature_class` is parseable.

**Files to create**: `apps/worker/` (new package), `apps/api/src/jobs/ledger.ts`, `apps/api/src/jobs/horizons.ts`, `apps/api/src/jobs/retention.ts`, `packages/db/migrations/0011_job_fixes.sql`.
**Files to change**: `apps/api/src/jobs/notices.ts`, `apps/api/src/jobs/context.ts`, `apps/api/src/services/audit.ts`, `packages/domain/src/state-machines.ts`, `packages/domain/src/config/registry.ts`.

===== ANCHORING =====
Read: `0002_audit_chain.sql`, `0003_signing.sql`, `0000_initial_schema.sql` (lines 185–200), `0004_row_level_security.sql`, `0005_app_role.sql`, `packages/db/src/schema/audit.ts`, `apps/api/src/services/{keys,signing,audit,documents}.ts`, `apps/api/src/{db,config,app}.ts`, `apps/api/src/routes/console.ts`, `packages/security/src/signing.ts`, `packages/db/src/__tests__/audit-chain.test.ts`, ARCHITECTURE §3.11/§4.4/§4.5, CRITIQUE P0-4, MVP1-TIERS §4 wave 2.

# AUDIT ANCHORING — SPECIFICATION

## 0. The gap, stated precisely

`lotmark.audit_ledger` is chained with HMAC-SHA256 under `lotmark.audit_key`, a session GUC set from `LOTMARK_AUDIT_KEY` (`apps/api/src/db.ts:46`, `apps/api/src/config.ts:29`). The chain is strong against anyone who does *not* hold that key. It is worth nothing against anyone who does — and the API process holds it on every transaction. An attacker who reaches the API's environment can rewrite any entry and recompute every subsequent `entry_hash` and the `audit_head` row, and `lotmark.verify_audit_chain()` (`0002_audit_chain.sql:222`) will report `ok = true`.

`audit_checkpoints` was supposed to close this. It does not, for four separate reasons, all verified:

1. **Never written.** No INSERT exists anywhere. Only references are the schema definition (`0000_initial_schema.sql:185`), the DELETE trigger (`0002_audit_chain.sql:173`), the DELETE revoke (`0005_app_role.sql:53`), and the seed's truncate list (`packages/db/src/seed/run.ts:114`).
2. **No signature column.** `through_seq, head_hash, entry_count, taken_at, exported_at, export_target` — a claim with no attestation.
3. **UPDATE is open.** `0002` creates only `audit_checkpoints_no_delete`; `0005:53` revokes only `DELETE`. `lotmark_app` can `UPDATE audit_checkpoints SET head_hash = ...` on every row today. This is a live hole, not a design gap.
4. **Same storage, same attacker.** A doctored `pg_dump` carries the doctored checkpoints with it.

Anchoring closes 1–4 by moving the attestation to a **different signer, a different credential, and a different medium**.

---

## 1. Anchor content — what exactly is signed

### 1.1 The decision

**Both a head hash and a Merkle root over the segment, in one signed statement, plus a digest of the previous anchor.** Neither alone is sufficient, and the reason is specific to this schema.

### 1.2 Why the head hash alone is not enough

`entry_hash` at seq *N* commits transitively to entries 1..*N*, because `prev_hash` is inside `lotmark.audit_payload()` (`0002_audit_chain.sql:57`). A signed head hash is therefore already a complete accumulator over the whole ledger. What it costs you:

- **Verification requires the HMAC key.** To recompute the head from restored rows you must run `verify_audit_chain()`, which reads `lotmark.audit_key` (`0002:229`). Every verifier is therefore a forger — the exact objection `packages/security/src/signing.ts` raises against HMAC for record signatures ("an HMAC cannot be handed to an assessor"). An assessor cannot be given a key that lets them mint the history they are auditing. Head-hash-only anchoring reproduces that problem at the notarisation layer.
- **No selective disclosure.** Proving one entry is in the anchored history means handing over the entire tenant ledger, including `audit_ledger.changes` (jsonb before/after), `actor_label` and `detail` for every other customer's acts.
- **No localisation.** A mismatch says "somewhere in 1..*N*". You binary-search.

### 1.3 Why a Merkle root, and how the leaf must be built

The leaf must **not** be `entry_hash` alone. `entry_hash` is an HMAC output — opaque without the key — so an inclusion proof over raw `entry_hash` values proves only "this 32-byte value was in a set", which tells an assessor nothing.

```
leaf_i = SHA256( 0x00
               || lp("lotmark.leaf.v1")
               || lp(seq)
               || lp(entry_hash)
               || lp(entry_content) )
```

where `entry_content` is the byte-identical output of `lotmark.audit_payload(prev_hash, tenant_id, seq, actor_label, actor_role_id, kind, action, detail, subject_table, subject_id, occurred_at, time_source, region, changes)` — reusing the existing canonical form rather than inventing a second one, so a change to the chain payload and a change to the leaf payload cannot drift apart.

`lp()` is the length-prefix from `0002_audit_chain.sql:44`, reimplemented in `packages/security/src/anchor.ts` for the Node signer. Length prefixing, not delimiter joining, for the reason already given in `0002`.

This construction gives three things head-hash-only cannot:

- **Key-free inclusion proof.** `SHA256` over disclosed content is unkeyed. An assessor holding only the anchor public key, one ledger row, and a ~17-node Merkle path can verify that *that specific act* was in the anchored history. They hold nothing that could forge one. This is the property that makes the anchor an assessor-facing artefact rather than an internal check.
- **`entry_hash` inside the leaf binds the unkeyed tree to the keyed chain.** An anchor cannot be built over content that disagrees with the chain, so the two layers cannot be attacked independently.
- **O(log n) localisation.** Compare subtree roots to find the exact altered `seq` rather than the first divergent one.

**Tree construction: RFC 6962.** Domain-separation prefix `0x00` for leaves, `0x01` for interior nodes; an odd node is **promoted unchanged, never duplicated** (duplicate-last is CVE-2012-2459); `merkle_leaf_count` is inside the signed payload so a promoted node cannot be reinterpreted at a different tree shape.

### 1.4 Why the head hash is still carried

It costs one column that already exists. It is what makes **anchor-to-anchor continuity** checkable: anchor *n*'s `from_seq` must equal anchor *n−1*'s `through_seq`, and the head at `through_seq` must be the anchored `head_hash`. It also catches the case where entry content is unchanged but the HMAC generation differs — a key rotation, which must be reported as a key rotation and not as tampering.

### 1.5 Why the anchors chain to each other

Without `prev_anchor_digest` and a gap-free `anchor_seq`, an attacker deletes the inconvenient anchors and keeps the rest. With them, a deleted anchor is a hole in a signed sequence — `ANCHOR_DISCONTINUITY` — and is as visible as a deleted ledger entry.

### 1.6 Canonical signed payload — `lotmark.anchor.v1`

Defined in `packages/security/src/anchor.ts` as `anchorPayload()`, fixed field order, length-prefixed:

```
lp("lotmark.anchor.v1")
|| lp(tenantId) || lp(ledger) || lp(anchorSeq)
|| lp(fromSeq)  || lp(throughSeq) || lp(entryCount)
|| lp(headHash) || lp(merkleRoot) || lp(merkleLeafCount)
|| lp(prevAnchorDigest)
|| lp(takenAt)                    -- 'YYYY-MM-DDTHH:MM:SS.ssssssZ'
|| lp(coveredThroughOccurredAt)   -- same format
|| lp(auditKeyVersion)
|| lp(keyVersion) || lp(keyFingerprint) || lp(custody)
```

Two deliberate inclusions:

- **`auditKeyVersion`.** `audit_ledger.key_version` exists per row (`schema/audit.ts`) but nothing writes anything but `'v1'`, and there is no rotation path. The anchor records which HMAC generation the segment was chained under, so a future rotation does not make every historical segment look tampered.
- **`custody` is inside the signed bytes.** Changing `dev_separate_user` to `hsm` breaks the signature. The honesty caveat cannot be stripped from the artefact.

Timestamps come from Postgres, not Node: `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, exactly as `applySignature` in `apps/api/src/services/signing.ts:96` already does, and for the same reason — the ledger's microsecond rendering (`0002:74`) and the anchor's must be the same instant in the same form.

---

## 2. The signing identity

### 2.1 The requirement, and what currently violates it

`apps/api/src/services/keys.ts` `KeyProvider.readPrivate()` reads the Ed25519 PEM from `.keys/<tenant>.<version>.pem` **into the API process**. Custody `'dev_file'`. If the API can read the key, the API can sign anchors, and an attacker who compromises the API can rewrite the ledger *and* re-anchor it. The anchor would prove exactly as much as the checkpoint does today.

### 2.2 The minimum honest separation on one laptop

**A separate process, running as a separate OS user, holding a key the API user cannot read, that never signs arbitrary bytes and never holds the HMAC key.**

```
apps/signer/src/main.ts        long-running; own timer; no HTTP
apps/signer/src/keystore.ts    reads .signer-keys/, mode 0600, owned by lotmark-signer
apps/signer/src/socket.ts      unix socket, owner lotmark-signer, mode 0660, group lotmark
```

Four properties, each doing real work:

1. **Filesystem-enforced key isolation.** `.signer-keys/` is `0700`, owned by OS user `lotmark-signer`. The API runs as a different user. This is not a convention — the kernel refuses the read. `apps/api/src/services/keys.ts` must never learn this directory: `SIGNING_KEY_DIR` and the anchor key directory are separate config values and the API's `KeyProvider` is not given the second.

2. **The signer builds its own statement.** The socket accepts one message: `{ tenantId, ledger }` — a request to *seal now*. The signer then connects to Postgres **as its own role `lotmark_signer`**, reads `audit_head` and the ledger rows itself, computes `from_seq`, `through_seq`, the leaves, the root and the head hash, and signs what it computed. It never signs bytes supplied by the caller. A compromised API can ask for a seal; it cannot choose what gets sealed.

3. **The signer does not hold the HMAC key.** This is the load-bearing point, and it works because of how `0002` is built: computing leaves needs `entry_hash` and the entry columns, both of which are *stored*; computing the head needs `audit_head.head_hash`, also stored. Nothing in the anchor construction requires `lotmark.audit_key`. Therefore:

   - The **API** holds the HMAC key and can rewrite history — but cannot produce an anchor signature over the rewrite.
   - The **signer** holds the Ed25519 key and can attest — but cannot write or alter a ledger entry (its role has `SELECT` on `audit_ledger`, and `audit_ledger` is INSERT-only by trigger and revoke anyway).

   Neither process can both write history and notarise it. That is a genuine separation of duties between two processes on one machine, and it is achievable today with no new infrastructure.

4. **A second active key, which the current schema forbids.** `0003_signing.sql` creates `signing_keys_one_active_per_tenant ON signing_keys (tenant_id) WHERE retired_at IS NULL`. A tenant cannot have both a record-signing key and an anchor key. Migration `0010` must add `purpose text NOT NULL DEFAULT 'record' CHECK (purpose IN ('record','anchor'))` and redefine the index as `(tenant_id, purpose) WHERE retired_at IS NULL`. Without this the anchor key cannot be registered at all.

### 2.3 The fallback when there is only one OS user

Many developer laptops have one account. The honest fallback is a separate process whose key file lives outside the API's working tree and whose file descriptor is closed after load — a runtime-compromise-only barrier. It is **strictly weaker** and gets its own custody value.

### 2.4 What must be REPORTED, and where

Add to the `custody` domain (`signing_keys.custody` has no CHECK today — `0003` constrains only `algorithm`; add one in `0010`):

| custody | Meaning | Honest statement carried with every verdict |
|---|---|---|
| `dev_separate_user` | Key held by OS user `lotmark-signer`, unreadable by the API user | "Protects against compromise of the API process. Does **not** protect against anyone with root, sudo, or physical access to this machine." |
| `dev_separate_process` | Separate process, same OS user | "Protects against a runtime compromise of the API process only. Any local process running as this user can read the key." |
| `dev_file` | Same process | "**Not a separation.** The anchor proves only that this build signed this statement. It is a self-attestation." |
| `kms` / `hsm` | Existing values, unchanged | — |

Reporting obligations, all mandatory:

- **Inside the signed payload** (§1.6), so it cannot be edited off.
- **In every anchor file**, as a top-level `assurance` string in plain English.
- **In the `POST /api/v1/audit/verify` response** (`apps/api/src/routes/console.ts:233`) as `custody` + `assurance`, alongside the existing `ok`/`entries`/`brokenAt`.
- **In the CLI output, printed before the verdict, not after** — a verifier must never emit the word "VERIFIED" without the custody line adjacent to it.
- **The development-key check.** `LOTMARK_AUDIT_KEY` defaults to `'dev-audit-key-change-me'` (`apps/api/src/config.ts:29`); the production guard at `config.ts:69` only fires when `NODE_ENV === 'production'`. The verifier must hash the audit key in use, compare against the published default's digest, and on a match print:

  > `AUDIT KEY IS THE PUBLISHED DEVELOPMENT DEFAULT — this run demonstrates the mechanism and proves nothing about this data.`

  Without this, a demo verification screenshot reads as evidence.

`apps/api/src/services/keys.ts` already carries the right reasoning in its header comment — that `custody` exists "so that upgrading to KMS or an HSM is a recorded fact about each key rather than a claim in a document." This design extends the same discipline to the anchor key and to every verdict printed from it.

---

## 3. Where anchors are stored

Three copies, each defeating a different attacker. Name what each does, and name the one that is missing.

**(a) `var/anchors/<tenant>/<ledger>/<YYYY>/<MM>/<anchorSeq>-<throughSeq>.json` — written by the signer, not the API.**
Directory owned by `lotmark-signer`, files `0444`, directories `0755`. The API user has read and no write. The medium is different from the database, so a doctored `pg_dump` does not carry doctored anchors. The writer is different from the API, so a compromised API cannot append a fabricated anchor even to the filesystem. `var/anchors` is a git working tree; the signer commits after each write, giving a hash chain over the anchor directory and a `git push` as the export mechanism. This follows ARCHITECTURE §4.5's "committed to a git repository the application has no write access to".

**(b) `lotmark.audit_checkpoints` — the index, explicitly not the evidence.**
The row is convenient for the console and for range queries. It is written by the **`lotmark_signer` role**, and `0010` revokes `INSERT, UPDATE, DELETE` on the table from `lotmark_app` (today `lotmark_app` holds all three; `0005:53` revokes only `DELETE`). So it is not "another row the same attacker controls" — the attacker who holds `lotmark_app` holds no write on it. The migration comment must say in one line that the row is a cache and the file is the evidence, so nobody later verifies from the table.

**(c) The mirror — the copy that is currently absent, and must be reported absent.**
`LOTMARK_ANCHOR_MIRROR_DIR`, an operator-configured path (external volume, synced folder, remote git). The signer copies the file, re-reads it, checks the digest, and only then sets `exported_at` and `export_target` — the two columns that already exist on `audit_checkpoints` and have never had a meaning. Until an operator configures this, **every copy is on one disk under one root**, and the verifier must print `anchors_exported: 0 of N` in the summary rather than implying otherwise.

The layered claim, stated exactly:

- Different **writer** (`lotmark_signer`, not `lotmark_app`) → defeats the compromised API and the compromised app-role DBA.
- Different **medium** (filesystem + git, not Postgres) → defeats the doctored backup/restore.
- Different **machine** (mirror) → would defeat root on this laptop. **Not present by default. Report it as not present.**

---

## 4. Verification procedure

Delivered as `pnpm audit:verify` (`packages/db/src/verify-anchors.ts`, with a bin entry), runnable **with the API stopped**, because "the API is compromised" and "this is a restored forensic copy" are both in scope. Read-only by default; `--record-discontinuity` is a separate, explicit mode (§5).

**Step 0 — Declare the ground.** Print, before any verdict: anchor directory, anchor count, anchor public key fingerprint, `custody` + `assurance`, mirror configured yes/no, audit-key-is-development-default yes/no. A verdict without this header is not a verdict.

**Step 1 — Load anchors from the filesystem. Never seed from `audit_checkpoints`.** Reading the anchor set from the database would reintroduce the circularity this whole design exists to remove.

**Step 2 — Ed25519 signature per anchor.** Recompute `anchorPayload()` from the file's fields, verify against the public key named by `key_version` / `key_fingerprint`, using `verifyPayload` from `packages/security/src/signing.ts`. Failure → **`ANCHOR_SIGNATURE_INVALID`**, naming the file. If `anchor_payload_version` is not the one this build canonicalises, say so explicitly rather than reporting tampering — the same distinction `verifyStoredSignature` already makes at `signing.ts:186`.

**Step 3 — Anchor chain continuity.** `anchor_seq` gap-free from 1; `prev_anchor_digest` equals `SHA256(payload || signature)` of anchor *n−1*; `from_seq(n) == through_seq(n−1)`; `taken_at` non-decreasing. Any hole → **`ANCHOR_DISCONTINUITY`** — an anchor was removed. Reported separately from ledger findings, because it means the *evidence set* is incomplete, not that the ledger is bad.

**Step 4 — In-database chain check.** `SELECT * FROM lotmark.verify_audit_chain($tenant)` (`0002:222`), which needs `lotmark.audit_key`. Failure → **`CHAIN_BROKEN at seq N`** with the function's own reason string.

**Step 5 — `LEDGER_DISCONTINUITY`, the restored-backup test.**

```
A = max(through_seq) over anchors that passed steps 2–3
H = SELECT seq FROM lotmark.audit_head WHERE tenant_id = $1 AND ledger = 'audit'
```

- `A > H` → **`LEDGER_DISCONTINUITY`**. Entries `H+1 .. A` existed when the covering anchor was signed and are not in this database. Report: the anchor file, the missing `seq` range, the anchor's `taken_at`, and the signature as the proof. Note that this is detected **without possessing the missing entries** — which is why `through_seq` must be inside the signed payload, and is the entire mechanism behind the drill.
- `A == H` → fully anchored.
- `A < H` → normal. `H − A` entries were written since the last anchor. Report as **`unanchored_tail: N entries since <taken_at>`** and state plainly that those entries carry chain protection only, which an HMAC-key holder can rebuild. This is the honest boundary of the design and belongs in the summary, not a footnote.

Cross-check against `audit_ledger` too: `SELECT max(seq), count(*) FROM lotmark.audit_ledger WHERE tenant_id = $1` — if `count(*) <> max(seq)` the gap-free invariant is already violated, which `verify_audit_chain` will also catch at step 4 but which should be reported as a distinct fact.

**Step 6 — Segment recomputation, per anchor.** For `(from_seq, through_seq]`: rebuild every leaf per §1.3 from the restored rows, rebuild the RFC 6962 root, compare to `merkle_root`. Mismatch → **`SEGMENT_ALTERED at seq N`**, localised by subtree comparison, naming the anchor. Also compare `entry_hash` at `through_seq` to the anchored `head_hash`. If `audit_key_version` on the anchor differs from the version the chain is now keyed with, report **`AUDIT_KEY_MISMATCH`** and *not* tampering — today `verify_audit_chain` would say "entry was altered after it was written" after a key rotation, which is a false accusation waiting to happen.

Step 6 is the step that proves the anchor adds something the chain cannot: an attacker holding `LOTMARK_AUDIT_KEY` passes step 4 and fails step 6.

**Step 7 — Cross-check `audit_checkpoints` against the files.** Row with no file, or a row whose values differ from the signed file → **`CHECKPOINT_TAMPERED`**. File with no row → corroborates step 5 (the database was restored to a point before that anchor). The file is authoritative in both directions.

**Step 8 — Mirror.** Each anchor present at the mirror path with an identical digest. Missing → **`ANCHOR_NOT_EXPORTED`** (warning, not failure, at T1 — but it appears in the summary line).

**Step 9 — Emit.** Machine-readable JSON plus a human summary. Non-zero exit on any of: `ANCHOR_SIGNATURE_INVALID`, `ANCHOR_DISCONTINUITY`, `CHAIN_BROKEN`, `LEDGER_DISCONTINUITY`, `SEGMENT_ALTERED`, `CHECKPOINT_TAMPERED`.

**In-app path.** `POST /api/v1/audit/verify` (`apps/api/src/routes/console.ts:233`) keeps its `audit:verify` permission gate and its self-recording `SYSTEM` entry, and extends the response with `anchors`, `highestAnchoredSeq`, `unanchoredTail`, `custody`, `assurance`, and the finding list. The API path is convenience; the CLI is the evidence, because it does not depend on the component under suspicion.

---

## 5. Failure — who is told, and does it raise a CAPA

### 5.1 Severity, per finding — do not inflate

| Finding | Class | CAPA |
|---|---|---|
| `LEDGER_DISCONTINUITY` | Record integrity | Critical — yes |
| `SEGMENT_ALTERED` | Record integrity | Critical — yes |
| `CHAIN_BROKEN` | Record integrity | Critical — yes |
| `ANCHOR_SIGNATURE_INVALID` | Evidence integrity | Critical — yes |
| `ANCHOR_DISCONTINUITY` | Evidence integrity | Critical — yes |
| `CHECKPOINT_TAMPERED` | Evidence integrity | Critical — yes |
| `AUDIT_KEY_MISMATCH` | Explained, not a defect | No — reported as a key rotation |
| `ANCHOR_NOT_EXPORTED` | Control degraded | Major, no auto-CAPA |
| `unanchored_tail` over threshold / anchor job overdue | Control degraded | Major, no auto-CAPA |

The last three say the *control* is weaker than intended, not that the *record* is wrong. Conflating them produces CAPA fatigue and devalues the six that matter.

### 5.2 What happens on a Critical finding

**1. The ledger.** Append a first-class entry to the **restored** head: `kind: 'SECURITY'`, `action: 'LEDGER_DISCONTINUITY'`, `detail` citing the anchor `id`, the anchor file `sha256`, the missing `seq` range and the anchor's `taken_at`, with the anchor statement in `changes`. Actor `system`. It is chained like any other entry and is covered by the next anchor, so the discontinuity is permanently on the record. **The chain continues; it does not pretend** (ARCHITECTURE §4.5).

Two mechanical constraints:
- The append requires `lotmark.audit_key` on the session or the trigger raises (`0002:106`), so it must go through `inTenantTransaction` (`apps/api/src/db.ts:38`) — not through the read-only CLI path.
- It is therefore gated behind `--record-discontinuity`. A verification run against a forensic copy must not mutate it. Default read-only.

**2. People.** One row in `lotmark.notifications` (`packages/db/src/schema/distribution.ts:156`) per user whose authority includes `audit:verify` — the same permission `console.ts:238` already gates the verify action on. Subject: "Audit ledger discontinuity detected". On a laptop there is no mail transport; the console reads this table, and that is honest.

**3. The console.** The Audit screen renders a discontinuity as a hard state that cannot be dismissed — only superseded by a later clean verification, which is itself a ledger entry.

**4. `job_runs`.** When the signer or the scheduled verify runs, write `job_runs` (`packages/db/src/schema/compliance.ts:160`) with `outcome: 'failure'` and `error_text`. The table exists and nothing writes it; a missed anchor must be diagnosable.

**5. CAPA — yes, but gated.** `capa` (`compliance.ts:81`) has `source`, `subject_table`, `subject_id`, `severity`, `state`, `raised_on`, `due_on`, `owner_user_id`. The auto-raise is `source: 'Ledger discontinuity'`, `severity: 'Critical'`, `subject_table: 'audit_checkpoints'`, `subject_id: <anchor id>`.

  **It must not be wired until the CAPA workflow exists.** There are no CAPA routes (`apps/api/src/routes/` is auth, console, workflow, values, lots, create, public, certificates). MVP1-TIERS blocker 10 states the rule directly: "an auto-raise writing to a table with no workflow behind it is a control that looks green and does nothing." Until then the verifier emits `capaRequired: true` in its output and the runbook says a human raises it. This ordering is a deliverable, not a caveat.

### 5.3 What does *not* happen

Issuance is **not** halted. A producer who cannot operate cannot withdraw certificates already in the field, which is a worse safety outcome than an operating producer with a flagged ledger. What is blocked: any fresh "audit trail intact" attestation, and the conformance/assessment pack must carry the open finding.

---

## 6. Schema changes — `packages/db/migrations/0010_audit_anchors.sql`

### 6.1 `audit_checkpoints` — new columns

Current: `id, tenant_id, through_seq, head_hash, entry_count, taken_at, exported_at, export_target`.

| Column | Type | Why |
|---|---|---|
| `ledger` | `text NOT NULL DEFAULT 'audit'`, `CHECK (ledger IN ('audit','denial'))` | `audit_head` is keyed `(tenant_id, ledger)` (`0002:26`). Without this the denial ledger can never be anchored. |
| `anchor_seq` | `bigint NOT NULL` | Gap-free per `(tenant, ledger)`, so a deleted anchor is a visible hole. |
| `from_seq` | `bigint NOT NULL` | The segment's exclusive lower bound. A Merkle root without it is uninterpretable and `entry_count` is uncheckable. |
| `merkle_root` | `text NOT NULL`, `CHECK (length = 64)` | §1.3. |
| `merkle_leaf_count` | `integer NOT NULL` | Signed, so a promoted odd node cannot be reinterpreted. |
| `prev_anchor_digest` | `text NOT NULL`, `CHECK (length = 64)` | `repeat('0',64)` for anchor 1. Makes the anchor set itself a chain. |
| `signature_value` | `text NOT NULL`, `CHECK (<> '')` | Base64 Ed25519. **The column whose absence is the entire problem.** |
| `signature_algorithm` | `text NOT NULL DEFAULT 'ed25519'`, `CHECK (IN ('ed25519'))` | Mirrors `signing_key_algorithm_known` (`0003:5`). |
| `key_version` | `text NOT NULL` | Which key signed. |
| `key_fingerprint` | `text NOT NULL` | **Copied, not joined** — same reasoning as the frozen competence basis in `0003`: if `signing_keys` is rewritten the anchor must still name what signed it. |
| `custody` | `text NOT NULL`, CHECK over the §2.4 domain | Copied at signing time, and inside the signed payload. |
| `anchor_payload_version` | `text NOT NULL DEFAULT '1'` | Mirrors `signatures.canonical_version`; lets the verifier say "this build canonicalises v2" instead of "tampered". |
| `audit_key_version` | `text NOT NULL DEFAULT 'v1'` | The HMAC generation the segment was chained under. Prevents a rotation reading as tampering. |
| `covered_through_occurred_at` | `timestamptz NOT NULL` | The `occurred_at` of the entry at `through_seq` — pins a business instant, not only a wall-clock one. |
| `file_path` | `text` | Where the signer wrote it. |
| `file_sha256` | `text` | Digest of those bytes, so row↔file is checkable in both directions. |

`exported_at` / `export_target` keep their names and finally acquire a meaning (§3c).

### 6.2 Constraints and indexes

```sql
CHECK (through_seq > from_seq)
CHECK (entry_count = through_seq - from_seq)
CHECK (length(head_hash) = 64)
UNIQUE (tenant_id, ledger, anchor_seq)
UNIQUE (tenant_id, ledger, through_seq)
INDEX  (tenant_id, ledger, through_seq DESC)   -- "highest anchored seq" is the hot query
```

### 6.3 The UPDATE hole — close it

```sql
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE ON "lotmark"."audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_mutation();
```

mirroring `audit_ledger_no_update` (`0002:161`). Plus, at the privilege layer — the belt-and-braces `0005` already argues for:

```sql
REVOKE INSERT, UPDATE, DELETE ON "lotmark"."audit_checkpoints" FROM lotmark_app;
```

`0005:53` revoked only `DELETE`. `UPDATE` and `INSERT` are open to the application today.

**No trigger computes the signature.** If the database signed its own notarisation the argument would be circular again. The row is inserted with the signature already in it, by a role the API does not hold.

### 6.4 The signer role

```sql
CREATE ROLE lotmark_signer LOGIN;
GRANT USAGE ON SCHEMA "lotmark" TO lotmark_signer;
GRANT SELECT ON "lotmark"."audit_ledger", "lotmark"."audit_head",
                "lotmark"."signing_keys", "lotmark"."tenants" TO lotmark_signer;
GRANT INSERT ON "lotmark"."audit_checkpoints" TO lotmark_signer;
```

Nothing else. Not a superuser, not the owner — RLS applies to it, and it sets `lotmark.tenant_id` per transaction like everything else. It never sets `lotmark.audit_key` and never needs to (§2.2.3). Idempotent `DO $$ ... IF NOT EXISTS`, following the pattern in `0005:19`.

### 6.5 `signing_keys` — the blocking index

```sql
ALTER TABLE "lotmark"."signing_keys"
  ADD COLUMN purpose text NOT NULL DEFAULT 'record'
    CHECK (purpose IN ('record','anchor')),
  ADD CONSTRAINT signing_key_custody_known
    CHECK (custody IN ('dev_file','dev_separate_process','dev_separate_user','env','kms','hsm'));

DROP INDEX "lotmark".signing_keys_one_active_per_tenant;
CREATE UNIQUE INDEX signing_keys_one_active_per_tenant_purpose
  ON "lotmark"."signing_keys" (tenant_id, purpose) WHERE retired_at IS NULL;
```

Without this the anchor key cannot be registered — `0003:11` permits exactly one un-retired key per tenant.

### 6.6 RLS

`0004` applies `tenant_id = current_tenant()` to every relation in the schema by loop, so the new columns are covered with no change. One forward note: CRITIQUE P0-4 requires `audit_ledger`, `audit_head`, `audit_checkpoints` and `signatures` be tenant-scoped and **generation-agnostic**, or anchors covering a retired generation report `LEDGER_DISCONTINUITY` on every demo reset — the exact failure that is supposed to prove compromise. `generation` does not exist yet, so nothing to do now; `audit_checkpoints` must be on the exemption list the wave-1 sweep builds.

---

## 7. Cadence, and why it does not wait for pg-boss

ARCHITECTURE §3.11 lists `ledger.anchor` at every 5 min / 10k entries under pg-boss. pg-boss is not installed and `apps/worker` does not exist (MVP1-TIERS blocker 9).

**The signer must not depend on either.** It is a long-running process with its own timer: poll `audit_head.seq` per tenant every 30 s; seal when `seq > last through_seq` and (`age(last taken_at) > 5 min` or `delta >= 10_000`). Reasons this is right and not a shortcut:

- Putting the only tamper-evidence mechanism behind a queue that the compromised component can enqueue into is a dependency inversion.
- MVP1-TIERS already flags blocker 8 as "the one dependency inversion in the whole plan" — the DR drill (blocker 11) cannot pass its own acceptance test without anchors. Making anchors wait on blocker 9 deepens exactly that inversion.
- The signer also accepts an explicit **seal-now** on its socket, so `pnpm audit:verify` and any backup routine can force a final anchor first, closing the unanchored tail before the snapshot.

At T1 only `ledger = 'audit'` is anchored; `denial_ledger` does not exist, though `audit_head.ledger` already admits it (`0002:26`).

---

## 8. Acceptance tests — `packages/db/src/__tests__/anchors.test.ts`

Structured like `audit-chain.test.ts`, which already runs two identities: `sql` as `lotmark_app` and `admin` as the owner playing the attacker who can disable triggers.

1. **Restored backup missing entries.** Anchor at seq 50; `admin` deletes seqs 45–50 with triggers disabled; verify → `LEDGER_DISCONTINUITY`, naming the anchor, the range `45..50`, and its `taken_at`. *This is the drill ARCHITECTURE §4.5 names as the acceptance test.*
2. **Attacker holds the HMAC key.** Anchor at seq 50; `admin` edits `detail` at seq 30 and recomputes seqs 30–50 and `audit_head` using `KEY`; verify → `verify_audit_chain` reports **ok**, the anchor reports `SEGMENT_ALTERED at seq 30`. **This is the test that proves anchoring adds something the chain cannot, and the current suite cannot express it.**
3. **Anchor file deleted** → `ANCHOR_DISCONTINUITY`, naming the missing `anchor_seq`.
4. **Checkpoint row rewritten.** As `lotmark_app` → refused by both the new trigger and the revoke. As `admin` → `CHECKPOINT_TAMPERED` on the file cross-check.
5. **HMAC key rotated** → `AUDIT_KEY_MISMATCH`, explicitly *not* a tampering finding.
6. **Development-default audit key** → the §2.4 warning appears above the verdict.
7. **Unanchored tail** → 12 entries after the last anchor are reported as unanchored, not as a discontinuity.
8. **Custody honesty** → an anchor whose `custody` is edited in the file fails at step 2, because `custody` is inside the signed payload.

---

## 9. What this design proves, and what it does not

### Proves

- For entries at or below the highest anchored `seq`, and given **one surviving authentic anchor copy**: the ledger as it stands is the one that was anchored. Alteration, deletion and reordering are all detectable.
- That entries were removed after anchoring — which ones, how many, and as of which anchor — **without possessing the removed entries**.
- That a specific ledger row was in the anchored history, to a verifier holding only the **public key**, that row, and a Merkle path. No HMAC key. No full ledger dump. No other customer's `changes` or `detail`.
- That the anchor set itself is complete, via the anchor chain and gap-free `anchor_seq`.
- That a rewrite by anyone holding **only the database** — including `lotmark_app`, including a DBA, including a restored doctored dump — is detectable, because they cannot produce the Ed25519 signature.
- That a rewrite by anyone holding **only the API's environment** (and therefore `LOTMARK_AUDIT_KEY`) is detectable, because the signer's key is on the other side of a filesystem boundary.

### Does NOT prove

- **Existence at a stated time.** `taken_at` is the signer's own clock, attested by nobody. Whoever holds the anchor key can backdate an anchor. This design proves **order and integrity, not time.** An RFC 3161 timestamp token or an external witness is what proves time, and neither is in scope. This is the most likely overclaim and must be stated in the verifier output.
- **Anything about the unanchored tail.** Entries after the last anchor have chain protection only, which an HMAC-key holder can rebuild. At a 5-minute cadence that is up to 5 minutes of history; before the signer process actually runs, it is *all* history.
- **Anything against root on this laptop.** Root reads `.signer-keys/`, mints anchors for any history it likes, and rewrites the files and the rows. `dev_separate_user` custody protects against compromise of the API process. Nothing more. That sentence is the design's honest ceiling until the mirror in §3c and a real KMS/HSM exist.
- **That the recorded facts were true.** Anchoring proves the record was not altered. It says nothing about whether it was honest when written. A perfectly anchored lie is still a lie.
- **Completeness of what should have been recorded.** The chain is gap-free over what *was written*, not over what *happened*. The trigger refusing without a key (`0002:104`) means a path forgetting `inTenantTransaction` fails loudly — but a path that never calls `recordAudit` (`apps/api/src/services/audit.ts:25`) leaves no gap at all. That is a code-coverage problem, and anchoring does not touch it.
- **Non-repudiation by a person.** The anchor is signed by a system key. It attests to the ledger, not to who acted within it — that is what `signatures` and `applySignature` do, under a per-user competence basis.
- **That the evidence is off-box.** Until `exported_at` / `export_target` are set against a mirror the operator actually configured, every copy shares one disk and one root. The verifier must report `anchors_exported: 0 of N` rather than implying otherwise.

### The one-sentence version, for the assessor-facing page

> Two processes on this machine hold two different keys: the application can write history but cannot notarise it, and the signer can notarise history but cannot write it — so a rewrite requires compromising both, and until it does, a rewrite is detectable with the public key alone; this proves the record's integrity and order, it does not prove when anything happened, and it does not defend against anyone with root on this machine.

---

## 10. Files touched

| Path | Change |
|---|---|
| `packages/db/migrations/0010_audit_anchors.sql` | New: §6 in full |
| `packages/security/src/anchor.ts` | New: `lp`, `leafDigest`, `merkleRoot`, `merklePath`, `verifyMerklePath`, `anchorPayload`; reuses `signPayload`/`verifyPayload` from `signing.ts` |
| `packages/security/src/index.ts` | Export the above |
| `apps/signer/src/{main,keystore,socket,seal}.ts` | New process, separate OS user, `lotmark_signer` DB role |
| `packages/db/src/verify-anchors.ts` + bin | New: §4, runnable with the API stopped |
| `apps/api/src/services/anchors.ts` | New, **read-only**: anchor listing for the console |
| `apps/api/src/routes/console.ts:233` | Extend `POST /audit/verify` response with anchor verdict, `custody`, `assurance` |
| `apps/api/src/config.ts` | `LOTMARK_ANCHOR_DIR`, `LOTMARK_ANCHOR_MIRROR_DIR`; the API gets **no** anchor key path |
| `apps/api/src/services/keys.ts` | Unchanged, deliberately — it must never learn the anchor key |
| `packages/db/src/__tests__/anchors.test.ts` | New: §8 |
| `packages/db/src/seed/run.ts:114` | Truncate list already covers `audit_checkpoints`; the seed must also clear `var/anchors` or a reset leaves anchors for a ledger that no longer exists |

===== ASOF =====
# AS-OF (POINT-IN-TIME) MACHINERY — FULL SPECIFICATION

## 0. Naming: one deviation, recorded up front

`ARCHITECTURE.md` §4.6 writes the GUC as `app.as_of` and the function as `app.as_of()`. The code uses the `lotmark.` prefix for both GUC namespace (`lotmark.tenant_id`, `lotmark.audit_key` — `apps/api/src/db.ts:43-44`) and schema (`lotmark.current_tenant()` — `packages/db/migrations/0004_row_level_security.sql`). §4.7's `app.tenant_id()` was already implemented as `lotmark.current_tenant()`. This spec uses **`lotmark.as_of` (GUC)** and **`lotmark.as_of()` / `lotmark.as_of_is_set()` (functions in schema `lotmark`)**, consistent with what shipped. Record it in `docs/deviations.md` (which does not yet exist — it is on the MVP1 "running alongside" list) alongside the `app.tenant_id()` → `lotmark.current_tenant()` rename, so §4.6 and §4.7 read against the same vocabulary.

---

## 1. THE MECHANISM

### 1.1 Three functions, deliberately not one

```sql
-- Is the transaction in historic mode? The TRIGGER reads this, not the value.
CREATE OR REPLACE FUNCTION "lotmark".as_of_is_set() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('lotmark.as_of', true), ''), NULL) IS NOT NULL;
$$;

-- The effective date. Views compare against this; unset means today, so ONE
-- view answers both "now" and "as at" (§4.6).
CREATE OR REPLACE FUNCTION "lotmark".as_of() RETURNS date
LANGUAGE plpgsql STABLE AS $$
DECLARE v text; d date;
BEGIN
  v := nullif(current_setting('lotmark.as_of', true), '');
  IF v IS NULL THEN
    RETURN (now() AT TIME ZONE 'UTC')::date;
  END IF;
  BEGIN
    d := v::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'LM_ASOF_MALFORMED: lotmark.as_of is % and is not a date', v
      USING ERRCODE = '22007';
  END;
  IF d > (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'LM_ASOF_FUTURE: lotmark.as_of (%) is later than today', d
      USING ERRCODE = '22008';
  END IF;
  RETURN d;
END $$;

-- The only sanctioned setter.
CREATE OR REPLACE FUNCTION "lotmark".set_as_of(p_as_of date) RETURNS date
LANGUAGE plpgsql AS $$
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'LM_ASOF_NULL: use inTenantTransaction for live reads, not set_as_of(NULL)';
  END IF;
  IF p_as_of > (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'LM_ASOF_FUTURE: as-of (%) is later than today', p_as_of
      USING ERRCODE = '22008';
  END IF;
  PERFORM set_config('lotmark.as_of', p_as_of::text, true);   -- true = transaction-local
  RETURN p_as_of;
END $$;

GRANT EXECUTE ON FUNCTION "lotmark".as_of(), "lotmark".as_of_is_set(),
                          "lotmark".set_as_of(date) TO lotmark_app;
```

**Three things about this are load-bearing and none are cosmetic:**

**(a) `as_of()` RAISES on a malformed value; `current_tenant()` returns NULL.** This asymmetry is the point. `current_tenant()`'s `EXCEPTION WHEN others THEN RETURN NULL` fails *closed*: no tenant means no rows. The identical idiom applied to `as_of` would fail *open in the dangerous direction* — a garbled GUC would silently fall back to `current_date`, hand a live answer to a historic question, and (because `as_of_is_set()` is a separate function reading the raw string) the read-only trigger would still fire, so nothing would look wrong. Copying the `current_tenant()` pattern here is the single most likely implementation mistake. State it in the migration comment.

**(b) `as_of_is_set()` is separate from `as_of()` precisely because `as_of()` coalesces.** The trigger cannot ask "is `as_of()` today?" — today is a legal as-of value, and an as-of read at today's date must still be read-only. The trigger asks whether the *setting exists*.

**(c) Both use `(now() AT TIME ZONE 'UTC')::date`, never `current_date`.** `current_date` follows the session `TimeZone`, so a client in IST could set tomorrow and pass the check. `lotmark.audit_payload()` (`0002_audit_chain.sql:79`) already fixes UTC rendering for exactly this class of reason ("a session with a different setting would hash the same instant differently"); as-of inherits the rule.

### 1.2 How it is set — `apps/api/src/db.ts`

`inTenantTransaction` (db.ts:38-48) is left **structurally unchanged**, and a sibling is added rather than an optional `asOf?` argument. An optional parameter on the existing function is the wrong shape: every one of the 26 route handlers already calls it, and an optional field invites a caller to pass `asOf` into a mutating path where the only thing stopping the write is a database trigger. Two functions returning two *branded* types make the mistake a compile error instead.

```ts
declare const WRITE: unique symbol;
declare const ASOF:  unique symbol;
export type WriteTx = Sql & { readonly [WRITE]: true };
export type AsOfTx  = Sql & { readonly [ASOF]:  true };

export async function inTenantTransaction<T>(
  sql: Sql, args: { tenantId: string; auditKey: string },
  fn: (tx: WriteTx) => Promise<T>,
): Promise<T> { /* unchanged body; cast to WriteTx */ }

/**
 * A HISTORIC read.
 *
 * Separate from inTenantTransaction because the two are different acts, not one
 * act with a flag. The audit key is NOT set: nothing in this transaction may
 * append to the ledger, and a missing key makes that refusal loud (0002) rather
 * than leaving the trigger as the only thing standing in the way.
 */
export async function inAsOfTransaction<T>(
  readSql: Sql, args: { tenantId: string; asOf: string },
  fn: (tx: AsOfTx) => Promise<T>,
): Promise<T> {
  return readSql.begin(async (tx) => {
    await tx`SELECT set_config('lotmark.tenant_id', ${args.tenantId}, true)`;
    await tx`SELECT lotmark.set_as_of(${args.asOf}::date)`;
    return fn(tx as unknown as AsOfTx);
  }) as Promise<T>;
}
```

Then change the three services that write so they cannot receive an `AsOfTx` at all:

- `recordAudit(tx: WriteTx, …)` — `apps/api/src/services/audit.ts:26`
- `applySignature(tx: WriteTx, …)` — `apps/api/src/services/signing.ts:49`
- `nextCode(tx: WriteTx, …)` — `apps/api/src/services/numbering.ts:24`
- `renderAndStoreIssue(tx: WriteTx, …)` — `apps/api/src/services/certificate-issue.ts:43`

This is §4.6 rule 3's "`AsOf` as a type-level requirement", implemented the cheap way: instead of threading an `AsOf` argument through every repository, brand the *transaction handle*. `tsc` then rejects the whole class of "a read path called a writer" without a single new argument at any call site.

### 1.3 The second connection — privilege, as well as trigger

`inAsOfTransaction` takes `readSql`, a **second pool authenticated as a new role `lotmark_reader`** holding `SELECT` and `EXECUTE`-on-STABLE-functions, and no `INSERT/UPDATE/DELETE`, mirroring `0005_app_role.sql` exactly.

This is necessary, not decorative, and the reason is uncomfortable: **the GUC is resettable by the session that set it.** `set_config('lotmark.as_of', '', true)` is available to `lotmark_app`, and `SET TRANSACTION READ WRITE` at top level is likewise permitted by Postgres. So the trigger alone guarantees *"a transaction while `as_of` is set cannot write"* — it does not guarantee *"an as-of request cannot write"*. Against the realistic threat (a forgotten internal call path, which is what §4.6 rule 1 names) the trigger is sufficient. Against a code path that clears the GUC to "just do this one write", only a role with no write grant is sufficient. `0005_app_role.sql` already argues this exact position for the ledger: *"The triggers already refuse. Revoking as well means an attacker who finds a way to disable a trigger still holds no grant."* As-of inherits the doctrine.

Grants for `lotmark_reader` must be **enumerated, never `ALL FUNCTIONS`**. `0005` grants `EXECUTE ON ALL FUNCTIONS ... TO lotmark_app`; repeating that for the reader would hand it `lotmark.provision_tenant` (SECURITY DEFINER) and any future SECURITY DEFINER writer. Add a test (§8.11).

### 1.4 The as-of request shape, end to end

Three transactions, in this order, per historic request:

1. **Write transaction (`inTenantTransaction`, app role, no `as_of`)** — `requireSession` loads the session and resolves authority (`plugins/session.ts`), and `recordAudit(tx, ctx, { kind: 'QUERY', action: 'Point-in-time view', detail: 'as at <date>' })` is written. §6.7 requires this entry ("who looked at what, as at when, is itself evidence"). It **must** happen here, before the historic read opens, because `audit_ledger` carries the read-only trigger and the append itself writes to `audit_head` (`0002_audit_chain.sql:112,135`). Same structural reason §3.4 gives for denials: the record of the act must not depend on the act succeeding.
2. **Read transaction (`inAsOfTransaction`, reader role, `as_of` set)** — the actual query.
3. Nothing. No write follows.

`?asOf=YYYY-MM-DD` is parsed at the route edge (§5.1 already specifies the parameter and the `X-As-Of-Applied` echo header). **Any non-GET route that receives `asOf` returns 400 before the guard runs.** Not 403 — the request is malformed, not refused; and rejecting at the edge means a mutating route never reaches a state where the trigger is its last defence.

---

## 2. THE READ-ONLY RULE

### 2.1 The trigger

```sql
CREATE OR REPLACE FUNCTION "lotmark".refuse_write_under_as_of() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "lotmark".as_of_is_set() THEN
    RAISE EXCEPTION
      'LM_ASOF_WRITE: % on "lotmark".% is refused while lotmark.as_of is set (%). '
      'A point-in-time view is read-only; reconstruction never writes.',
      TG_OP, TG_TABLE_NAME, current_setting('lotmark.as_of', true)
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;   -- statement-level BEFORE trigger: return value is ignored
END $$;
```

Attached to **every** table by the same enumerator `0004` used, so the two sweeps cannot disagree about what "every table" means:

```sql
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'lotmark' AND c.relkind = 'r' ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER as_of_read_only BEFORE INSERT OR UPDATE OR DELETE ON "lotmark".%I
         FOR EACH STATEMENT EXECUTE FUNCTION "lotmark".refuse_write_under_as_of()', t.relname);
    EXECUTE format(
      'CREATE TRIGGER as_of_read_only_truncate BEFORE TRUNCATE ON "lotmark".%I
         FOR EACH STATEMENT EXECUTE FUNCTION "lotmark".refuse_write_under_as_of()', t.relname);
  END LOOP;
END $$;
```

**`FOR EACH STATEMENT`, not `FOR EACH ROW`, and the choice is substantive.** A row trigger does not fire when a statement matches zero rows. Every optimistic-lock update in this codebase has the shape `UPDATE … WHERE id = $1 AND version = $2` and treats zero rows as a 412 (§4.3, "zero rows → 412"). Under a row trigger, a stale-version update issued from an as-of transaction would return 412 — a *plausible, benign-looking* error that hides the fact that a mutating path ran in historic mode. A statement trigger fires on the attempt. It is also one invocation per statement rather than per row, so it costs nothing on a 20,000-row insert.

`BEFORE TRUNCATE` is belt-and-braces in the idiom of `0005`'s own comment ("The application must never TRUNCATE… it bypasses row triggers"). The app role has no `TRUNCATE` grant; the reader role has none either; the trigger costs one line and covers a future accidental grant.

### 2.2 Which tables get it: all of them, including the ledger

No exemptions. Not `audit_ledger`, not `signatures`, not `state_transitions` (already append-only by `refuse_mutation()` in `0002`/`0003`), not `audit_head`, not `numbering_counters`, not `job_runs`.

Exempting the already-append-only tables would be *reasoning*, and the enumerator is what makes the sweep verifiable. An exemption list is a second place for a new table to be forgotten. The redundancy is free.

The one case that looks like it needs an exemption — §6.7's `QUERY / Point-in-time view` ledger entry — is resolved by *sequencing* (§1.4), not by exemption. This is strictly better: the entry exists even if the historic read then fails.

### 2.3 Why a convention would be insufficient — four concrete escapes

This is not "developers forget". These are writes that **no application-level convention can see**, because they do not originate in application code:

1. **Trigger-generated writes.** `lotmark.audit_chain_append()` (`0002_audit_chain.sql:112` and `:135`) performs `INSERT INTO audit_head … ON CONFLICT DO NOTHING` and `UPDATE audit_head SET seq = …`. A repository-level "check `asOf` before writing" rule never runs; the write is emitted by the database in response to somebody else's insert. Same for `numbering_counters_monotonic()` (`0007`).

2. **Read-shaped helpers that write.** `nextCode()` (`services/numbering.ts:52-62`) does `INSERT … ON CONFLICT DO NOTHING` followed by `UPDATE … SET next_value = next_value + 1`. Its name, its position in the file, and its return type all say "compute an identifier". A convention placed on repositories does not cover a service that looks like a pure function.

3. **SECURITY DEFINER functions.** `lotmark.provision_tenant`, `lotmark.resolve_tenant`, `lotmark.verify_certificate`, `lotmark.public_signing_key` run as the owner and bypass RLS by design. A convention living in TypeScript has no jurisdiction inside them. (The trigger does: it fires on the table regardless of who the statement's effective user is.)

4. **Cascades.** `study_equipment.study_id` is `ON DELETE cascade` (`0000_initial_schema.sql:665`), as are the session FKs. A delete propagates to tables the calling code never named.

And a fifth, which is the one §4.6 rule 1 actually cares about: **the failure is silent and the artefact is permanent.** A signature written under `as_of = 2026-05-01` would carry `competence_checked_on = '2026-05-01'` and would satisfy the CHECK constraint `signature_competence_basis_covers_the_day` (`0003_signing.sql`), because that constraint validates the *internal* consistency of the frozen triple, not its relation to now(). The database's own belt-and-braces check would certify the forgery. There is no later query that finds it. A convention that fails this way is not a control.

---

## 3. `as_of` MAY NEVER EXCEED `now()`

Enforced twice — in `set_as_of()` at set time and in `as_of()` at read time — because the setter is application code and the reader is what every view actually calls.

Three reasons, in increasing order of force:

**(a) A future date is a prediction wearing the costume of a record.** Every temporal predicate in this schema is an expiry: `competence_records.valid_to`, `calibrations.valid_to`, `subcontractors.accreditation_valid_to`, `lots.expiry_date`, `entitlements.revalidation_due`, `monitoring_points.next_due_on`. Set `as_of` forward six months and the conformance surface fills with red — lapsed competences, expired calibrations, out-of-date lots — none of which have happened. That screen is indistinguishable from an assessment finding. It is also exportable. §6.7's amber band says "Historic view"; there is no honest band for "speculative view".

**(b) The reproducibility property that makes as-of *evidence* holds only backwards.** §12 R8 states the property test: *for any record and `d1 < d2 < now`, the answer at `d1` computed today equals the answer at `d1` computed at `d2`*. That property is true for the past because the record of the past is complete — no row can be inserted with a `created_at` before now. For `d > now` it is false **by construction**: tomorrow's answer changes every time a row arrives. An as-of view whose answers are not stable is not a reconstruction of anything; it cannot back a claim, and it cannot be cited in an assessment pack. This is the reason that survives argument.

**(c) It closes the forward-dating half of the trapdoor.** §3.10 already forbids backdating that precedes the last anchored segment. Without rule 2, `as_of` is a lever that changes what the system reports about the future with the visual authority of the ledger — and if any read-only path is ever broken (a missed table, a cleared GUC), a *forward*-dated write is worse than a backdated one: it lands ahead of every existing anchor and every existing `seq`, so nothing detects it as out of order.

**Boundary:** `as_of = today` is legal and must behave identically to a live read except for being read-only. That equivalence is testable (§8.7) and is what proves the "one view answers both" claim in §4.6 rather than asserting it. There is no lower bound; an `as_of` before the tenant's `created_at` returns nothing, which is the correct answer.

---

## 4. WHAT CHANGES UNDER `as_of`, AND WHAT MUST NOT

### 4.1 The guard must never read `as_of` — what breaks if it does

`decide()` (`services/guard.ts:76`) takes `onDate` (`guard.ts:57`) and uses it for exactly one consequential thing: selecting the competence basis via `competenceFor` (`guard.ts:104-120`). Every one of the 15 call sites passes `ctx.today` (`routes/lots.ts:107,274,490`; `values.ts:181`; `workflow.ts:109,269`; `certificates.ts:51,102,282`; `create.ts:120,214,321,413`; `console.ts:84,184,214,240`), and `ctx.today` is built at `plugins/session.ts:128` from the process clock.

If `as_of` ever reached `ctx.today`, three things break, in ascending severity:

1. **Competence resurrection.** `competenceBasis()` (`routes/lots.ts:39-51`, `values.ts:36-47`, `workflow.ts:34-48`) filters `valid_from <= onDate AND valid_to >= onDate`. The seed's deliberate Sunil fixture — `study:sign` competence expiring 2026-06-30 (§2.3, "a permanent DENY fixture") — becomes a permanent ALLOW fixture for anyone who appends `?asOf=2026-05-01`.

2. **Privilege escalation through a query parameter.** `plugins/session.ts:136` calls `resolveAuthority({ userId, assignments, roles, asOf: today })`, and `assignmentActiveOn()` (`packages/domain/src/config/resolve.ts:62-64`) filters on `role_assignments.valid_from/valid_to`. A person whose Quality Manager assignment ended in June re-acquires it by asking for a date in May. The guard's step 1 (`can(...)`) then passes. This is not a competence subtlety; it is a role grant a query string re-issues.

3. **The forgery is self-certifying.** The competence basis resolved under an as-of date is frozen onto `signatures.competence_checked_on` (`services/signing.ts:117-129`), and `0003_signing.sql`'s `signature_competence_basis_covers_the_day` CHECK compares `competence_valid_from <= competence_checked_on <= competence_valid_to` — all three fields drawn from the same falsified date. The constraint passes. `verifyStoredSignature` (`signing.ts:~165`) also passes, because it recomputes over the *stored* material. Nothing in the system can later tell the act from a legitimate one.

**Also:** the guard's *denial* path writes. `recordAudit(tx, …, { kind: 'DENY', … })` (`routes/lots.ts:110`, and the equivalent in every mutating route) would trip `LM_ASOF_WRITE`, so a refusal issued in historic mode would be unrecordable — the control fires and leaves no evidence, which §3.4 exists to prevent. This is the reason `asOf` on a mutating route is rejected at the edge with 400 (§1.4) rather than being allowed to reach the guard.

**The structural fix, not a rule:** `RequestContext.today` (`plugins/session.ts:29`) is the *act clock* and nothing else. `as_of` never enters `RequestContext`; it is parsed per-route into a local passed only to `inAsOfTransaction`. `GuardRequest.onDate` should be renamed `actedOn` so that no future reader thinks the field is a place an as-of date might belong — its doc comment currently reads *"normally today, or an as-at date"* (`guard.ts:56`), which is precisely the sentence that will cause this bug. Delete it.

**One further hardening, cheap and in this codebase's idiom** (add to the migration):

```sql
ALTER TABLE "lotmark"."signatures"
  ADD CONSTRAINT signature_basis_checked_on_is_act_time CHECK (
    competence_checked_on IS NULL
    OR competence_checked_on::date = (signed_at AT TIME ZONE 'UTC')::date
  );
```

This makes the guard/as-of separation a database refusal instead of a code review item. It requires one prerequisite change: `ctx.today` must come from the database clock, not `new Date()` (`plugins/session.ts:128`), or the constraint will reject a legitimate signature that straddles UTC midnight. `services/signing.ts:102` already takes its instant from the database *for the identical reason* ("Two API instances can disagree by seconds; the ledger and the signature must not"). Making `today` consistent with it is a one-line change with a precedent in the same repository.

### 4.2 The signing service must never read `as_of`

`applySignature` takes `signedAt` from `SELECT now()` in the transaction (`services/signing.ts:102`). The rule is not merely "don't pass it an as-of date" — it is **`as_of` must never be implemented as a clock override.** No `lotmark.now()` wrapper, no `SET` of a simulated time, no view that substitutes `as_of()` for `now()`. `as_of` is a *filter over stored dates*; it is not a clock. `SimulatedClock` (§2.3) is the only sanctioned clock substitution and it refuses to construct outside `LOTMARK_ENV=demo`.

If it were a clock override:

- `signaturePayload({ …, signedAt })` binds `signedAt` into the signed material, and `verifyStoredSignature` recomputes with the *stored* `signed_at`. A backdated signature therefore verifies forever. The mechanism designed to detect tampering certifies it.
- `signatures.signed_at` propagates to `certificate_issues.issued_at`, and `issued_at` is the window boundary in `lotmark.certificate_holders()` (`0009_holders.sql`, `window_bounds` CTE). A backdated issue silently moves the boundary between issue *n* and *n+1*, which changes **who is deemed to hold which certificate** — i.e. who receives a withdrawal notice. That is the product's central safety obligation (0009's header comment), reachable through a date.
- `signing_keys.activated_at/retired_at` and the partial unique index `signing_keys_one_active_per_tenant` (`0003_signing.sql`) would resolve to a retired key.

In practice the signing service is also unreachable under `as_of`: the `INSERT INTO lotmark.signatures` (`signing.ts:117`) trips `LM_ASOF_WRITE`, and `inAsOfTransaction` never sets `lotmark.audit_key`, so no accompanying ledger entry could be written either (`0002` refuses without it). Three independent refusals. That is the intended depth.

### 4.3 The audit chain append must never read `as_of` — and the ledger must never be read *through* it

**Append.** `audit_chain_append()` sets `NEW.occurred_at := coalesce(NEW.occurred_at, now())` (`0002_audit_chain.sql:125`) and hashes `occurred_at` into the payload via `audit_payload()`. If that `now()` became `as_of`:

- The chain would still verify. `seq` is assigned from `audit_head` and `verify_audit_chain` walks by `seq`, so a backdated `occurred_at` breaks nothing the verifier checks. You would hold a cryptographically intact chain with non-monotonic timestamps — the worst possible artefact, because it is *provably unaltered* and *wrong*.
- Every time-window consumer breaks: the anchor ranges of §4.5, the `/audit` screen (`routes/console.ts:208`, ordered by `seq`, displayed by `occurred_at`), retention evaluation, and incremental verification "since the last good anchor". An entry claiming to predate an already-anchored segment makes backdating indistinguishable from a legitimate append — which is exactly the failure §3.10's rule ("can never precede the last anchored segment") exists to prevent.

**Read.** The five ledger tables — `audit_ledger`, `audit_head`, `signatures`, `audit_checkpoints`, `state_transitions` — are **read live, always, never filtered by `as_of`**, while still carrying the write-refusal trigger.

The reason is sharper than "history should be visible". `verify_audit_chain(p_tenant)` (`0002_audit_chain.sql:225`) walks entries ordered by `seq` and asserts `r.seq = v_count` at each step. If an as-of predicate (`occurred_at::date <= as_of()`) ever filtered `audit_ledger`, the walk would see a **contiguous prefix** — seq 1..N — and return `ok = true, entries = N`. Verification would pass while ignoring every entry after the as-of date. A verification that passes over a prefix is worse than no verification, because it produces a green result an assessor will rely on. So: no view, no policy, and no repository helper may apply a temporal predicate to `audit_ledger`.

Corollary: `POST /audit/verify` (`routes/console.ts:234`) must never accept `?asOf`. It also writes a `SYSTEM` entry (`console.ts:249`), so it is a mutating route by the §1.4 classification and rejects `asOf` with 400 on both grounds.

**One more must-not:** `keys.publicKeyFor(tx, tenantId, sig.key_version)` (`services/signing.ts`) resolves the key by the `key_version` **stored on the signature**, not by which key was active on a date. A "which key was in force on 4 June" report is a legitimate as-of question over `signing_keys` (§5, class A); signature verification is not. Keeping these apart is what lets an old signature verify after rotation.

### 4.4 Queries that *do* change under `as_of`

The as-of surfaces, and the column each resolves against:

| Question | Tables | Predicate |
|---|---|---|
| Was this person competent for X? | `competence_records` | `valid_from ≤ as_of ≤ valid_to` **and** `superseded_at IS NULL OR superseded_at::date > as_of` |
| Was this instrument in calibration? | `calibrations` | validity: `daterange(valid_from, valid_to,'[]') @> measured_on`; system: `created_at::date ≤ as_of` |
| Who held which role / which team? | `role_assignments`, `team_memberships` | `valid_from/valid_to`, `revoked_at`; `joined_on/left_on` — **report only** |
| Was the subcontractor accredited? | `subcontractors` | `accreditation_valid_to ≥ as_of AND created_at::date ≤ as_of` |
| Which certificate issue was current? | `certificate_issues` | `issued_at ≤ as_of < next issue's issued_at`; `withdrawn_at` |
| Who held it then? | `order_lines`+`orders`, `vault_holdings` | via `lotmark.certificate_holders()` — see §5.4, currently broken for the vault half |
| Was the lot in date / released? | `lots` | `expiry_date ≥ as_of`, `released_at ≤ as_of`, state via `state_transitions` |
| Was monitoring overdue? | `monitoring_points` | `next_due_on < as_of` with no `checked_on` in between |
| Entitlement state | `entitlements` | `raised_on`, `decided_at`, `revalidation_due` |
| Facility excursion open? | `facility_excursions` | `from_date/to_date`, `disposition_at` |
| CAPA overdue / open | `capa` | `raised_on ≤ as_of`, `due_on`, `closed_at` |
| Which configuration applied? | `config_versions` | greatest `published_at ≤ as_of` where `status <> 'draft'` — **but see §5.5** |
| The 13 conformance clause predicates (MVP1 blocker 7) | all of the above | every clause is an as-of query by construction |

The state-machine aggregates (`projects`, `studies`, `property_values`, `lots`, `orders`, `capa`, `entitlements`) resolve state through `state_transitions` (`0003_signing.sql:70`), which is append-only and carries `occurred_at`, `from_state`, `to_state`, `subject_type`, `subject_id`. Add one function:

```sql
CREATE OR REPLACE FUNCTION "lotmark".as_of_state(p_subject_type text, p_subject_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_state FROM "lotmark"."state_transitions"
  WHERE subject_type = p_subject_type AND subject_id = p_subject_id
    AND occurred_at <= ("lotmark".as_of() + 1)::timestamptz
  ORDER BY occurred_at DESC, id DESC LIMIT 1;
$$;
```

Null result means "no transition yet" → the aggregate's initial state (`draft` for lots/studies/property_values, `placed` for orders, `open` for capa, `under_review` for entitlements — all present as column defaults in `0000_initial_schema.sql`).

---

## 5. WHICH TABLES NEED TEMPORAL TREATMENT, AND BY WHAT COLUMN

44 tables exist: 41 in `0000`, plus `audit_head` (`0002`), `state_transitions` (`0003`), `numbering_counters` (`0007`). Every one gets the **trigger**. A much smaller set gets a **temporal predicate**, and the classes are genuinely different in what they can honestly claim.

### 5.1 Class A — dated validity interval. As-of is EXACT. (13 tables)

The as-of date is compared to a stored range; the answer is reconstructable to the day.

| Table | Validity columns | Note |
|---|---|---|
| `competence_records` | `valid_from`, `valid_to` (+ `superseded_at`) | see §5.6 — the live query is wrong for as-of |
| `calibrations` | `valid_from`, `valid_to` | `calibration_no_overlap` EXCLUDE (`0001`) guarantees a single-valued answer |
| `role_assignments` | `valid_from`, `valid_to` (nullable), `revoked_at` | report only, never authority (§4.1) |
| `team_memberships` | `joined_on`, `left_on` | |
| `subcontractors` | `accreditation_valid_to` | open-start interval |
| `entitlements` | `raised_on`, `decided_at`, `revalidation_due` | + state via `state_transitions` |
| `facility_excursions` | `from_date`, `to_date`, `disposition_at` | |
| `lots` | `expiry_date`, `released_at` | + state |
| `signing_keys` | `activated_at`, `retired_at` | as-of for reporting; **never** for verification (§4.3) |
| `config_versions` | `published_at`, `status` | see §5.5 |
| `legal_holds` | `placed_at`, `released_at` | |
| `monitoring_points` | `checked_on`, `next_due_on` | |
| `certificate_issues` | `issued_at`, `withdrawn_at` | the issue-in-force window |

### 5.2 Class B — "as at" means filtering on a system timestamp. As-of is EXACT for existence, and for state where `state_transitions` covers it; APPROXIMATE for every other mutable column. (16 tables)

`projects`, `studies`, `study_results`, `property_values`, `certificates`, `orders`, `order_lines`, `shipments`, `logger_readings`, `process_steps`, `capa`, `equipment`, `facilities`, `organisations`, `users`, `teams`, `notifications`, `custom_field_values`.

Predicate: `created_at::date <= as_of` (or the domain-specific stamp: `logger_readings.read_at`, `process_steps.performed_on`, `orders.placed_on`, `capa.raised_on`).

**The honest limitation, which must be stated in the product and not only in this document.** These rows are mutated in place — every one of them carries `updated_at` and none carries a version history. `property_value_version` and `uncertainty_component` are specified in `ARCHITECTURE.md` §4.2 and **do not exist** (MVP1 blocker 15 confirms: "components are recomputed, never frozen"). So `created_at <= as_of` gives you *the rows that existed then, carrying today's column values*. A `material_name` corrected last week, a re-priced `unit_price_minor`, an edited `intake_quantity` — all show their current value on a screen labelled "as at 4 June 2026".

That is precisely §12 R8's failure mode ("bitemporal half-done is worse than none"). The resolution is not to fake it and not to abandon it, but to **scope the claim and make the scope machine-readable**:

```sql
CREATE TABLE lotmark_meta.temporal_class (
  table_name    text PRIMARY KEY,
  class         text NOT NULL CHECK (class IN ('validity','system','ledger','none')),
  validity_from text, validity_to text, system_column text,
  fidelity      text NOT NULL CHECK (fidelity IN ('exact','state-only','existence-only')),
  note          text NOT NULL
);
```

In `lotmark_meta` — the schema `packages/db/src/migrate.ts` already creates for `schema_migrations` — so it sits outside the RLS sweep (`0004`'s loop would otherwise demand a `tenant_id` predicate on tenant-less reference data) and reads as installation metadata, which is what it is. Written by migration only; read by the as-of repository helpers, by the boot check, and by an assessor with a `SELECT`. Same spirit as §4.1's `@pii:` comment registry: declared once, applied in several places.

The as-at band (§6.7) then carries a second line generated from this table: *"Exact as at 4 June for competence, calibration, certificate issue and workflow state. Attributes without version history show their current value."* A user who is told is not misled; a user shown a silent mixture is.

### 5.3 Class C — ledger. Read live, write never. (5 tables)

`audit_ledger`, `audit_head`, `signatures`, `audit_checkpoints`, `state_transitions`.

Never filtered by `as_of` (§4.3). `state_transitions` is the one nuance: it is *read* live, and the as-of *predicate lives in the query* (`occurred_at <= as_of`) inside `lotmark.as_of_state()`, not in a view over the table. The distinction matters because a blanket view would also truncate the transition history shown on a detail screen.

### 5.4, 5.5, 5.6 — Class D and the four genuine gaps

**Class D — as-of is meaningless: `tenants`, `audit_head`, `numbering_counters`, `job_runs`, `sessions`, `config_entries`, `signing_keys`(for verification).** `audit_head` and `numbering_counters` are cursors, not facts — "what was the counter on 4 June" has no consumer. `job_runs` has `started_at` and is filterable, but it is operational telemetry, not a compliance surface; classify `none` so nobody builds an as-of report on it. `config_entries` resolves through its `version_id`, never through a date.

**But four tables are misclassified by their own schema, and as-of exposes it. These are prerequisites, not consequences:**

1. **`study_equipment` (`0000_initial_schema.sql:362`) has no dates at all.** Two columns, both FKs. "Which equipment was on ST-1013 on 4 June" is unanswerable, so **Closure 1 as-of is unanswerable** — the closure traverses `equipment → calibration → study_result → study`, and the study-to-equipment hop uses today's set. The EQ-02 calibration-gap fixture (§2.3) would resolve against the current equipment list. Needs `added_at`/`removed_at`, or per-result equipment as §4.6 specifies (`study_result.equipment_id`, also absent).

2. **`study_results` has no `measured_at`** — only `created_at`. §4.6's Closure 1 correction is explicit: cover must be checked against `study_result.measured_at`, "not the signature date… a study measured in May and signed in July is judged against July." The column does not exist, so the correction cannot be implemented and the as-of closure inherits the prototype's inverted control.

3. **`facility_lots` (`0000_initial_schema.sql:558`) has no dates.** `ARCHITECTURE.md` §4.2 specifies `validity tstzrange` plus an EXCLUDE constraint; the built table is two FKs. "Which lots were in this facility during the excursion" — the entire blast radius of a facility excursion — is unanswerable as-of.

4. **`vault_holdings` has no validity interval, and this is already a live bug, not merely an as-of gap.** `ARCHITECTURE.md` §4.2 specifies `validity tstzrange`; `0009` added `acquired_on` but nothing uses it. Look at `lotmark.certificate_holders()` in `0009_holders.sql`: the `from_orders` CTE correctly bounds by the issue window (`o.created_at >= w.from_at AND (w.to_at IS NULL OR o.created_at < w.to_at)`), but the **`from_vault` CTE cross-joins `window_bounds` and then uses no time predicate at all** — only `v.lot_id = w.lot_id AND v.quantity > 0`. Every self-declared holding is returned for *every* issue number. So the holder list for issue 1 already includes organisations that acquired the material after issue 3. Minimum fix: `AND v.acquired_on <= w.from_at::date` plus the upper bound; proper fix: `valid_from`/`valid_to` on the holding, since a holding is consumed and a `UNIQUE (organisation_id, lot_id, storage_location)` row (`0001`) is overwritten in place with no history.

**`config_versions` (§5.5) needs a rule, not just a column.** Business records carry `config_version_id` (`lots`, `studies`, `property_values`, `certificate_issues` — FKs in `0001`). "Which configuration was active on 4 June" is one question; "under which configuration was this lot released" is a different one, and only the second is what a historic screen should render with. **Rule: when displaying a record as-of, resolve its configuration from the record's stamped `config_version_id`, not from the as-of date.** Otherwise a 2026 record renders under a config version that was active on the as-of date but was never the one it was created under — a subtle, plausible, wrong screen.

**`competence_records` (§5.6) — the live query is wrong for as-of, and the bug is already written three times.** `competenceBasis()` filters `superseded_at IS NULL` (`routes/lots.ts:44`, `routes/values.ts:41`, `routes/workflow.ts:41`). Correct for a live check. **Wrong for as-of**: a record superseded on 1 July was live on 4 June, and excluding it makes a person look uncertified on a day they were certified. The as-of predicate must be `(superseded_at IS NULL OR superseded_at::date > as_of())`. Note the `competence_no_overlap` EXCLUDE constraint (`0001`) is `WHERE (superseded_at IS NULL)` — it constrains live rows only, so an as-of read *can* legitimately see two overlapping records (one superseded, one current) and must take the one live at the date, not `LIMIT 1` on an unordered scan. This is the concrete bug the property test in §8.8 is designed to catch.

---

## 6. COMPOSITION WITH RLS

`lotmark.tenant_id` and `lotmark.as_of` are both transaction-local session settings set by the same wrapper. Five interaction points; one is a real risk.

**(a) Order of setting is irrelevant.** Both are read by `STABLE` functions at statement-execution time (`lotmark.current_tenant()`, `lotmark.as_of()`), not captured at `BEGIN`. Setting either before the other is equivalent. What matters is that both are set before the first statement touching a business table, which `inAsOfTransaction` guarantees structurally.

**(b) The failure modes are opposite by design, and must not be unified.** Unset tenant → `current_tenant()` returns NULL → every policy matches nothing → empty result (fail closed, silent, correct — a developer sees an empty screen in testing). Unset `as_of` → live answer (correct default). Malformed `as_of` → **raise** (§1.1a). Three different behaviours for three different meanings; a future refactor that "makes the GUC helpers consistent" would break exactly one of them.

**(c) The real risk: leakage into a pooled connection.** `set_config(name, value, is_local => true)` is transaction-local only if a transaction block is open. Outside one it behaves as a session-level `SET` and survives into the next borrower of the pooled connection (`max: 10`, `apps/api/src/db.ts:16`). A leaked `lotmark.tenant_id` is a cross-tenant read. A leaked `lotmark.as_of` is worse in one way and better in another: the read-only trigger makes the *next write* fail loudly (`LM_ASOF_WRITE` on an unrelated request — confusing but safe), while the next *read* silently returns historic data to a live request. `inAsOfTransaction` uses `readSql.begin`, so this cannot happen by construction; test §8.6 asserts it, because the property depends on a call-site discipline the type system does not express.

**(d) `lotmark.as_of()` must not be marked `LEAKPROOF`.** RLS quals are evaluated before non-leakproof user quals; a leakproof temporal predicate could be pushed below the tenant policy and evaluated against rows the caller may not see. `STABLE` and nothing more. (`SECURITY DEFINER` on it would be worse still.)

**(e) SECURITY DEFINER functions must never read `as_of`.** `lotmark.verify_certificate(text)` (`0008`) is `SECURITY DEFINER` and runs for unauthenticated public callers with no tenant context. If it read `as_of`, a member of the public could ask "what did this certificate say in March" and — because the function bypasses RLS — get an answer across the tenant boundary. `lotmark.certificate_holders()` (`0009`) is by contrast a plain `STABLE` invoker function, so RLS applies to it and it *is* a legitimate as-of surface. Add a test asserting no `SECURITY DEFINER` function in schema `lotmark` references `as_of` (`pg_proc.prosrc NOT LIKE '%as_of%' WHERE prosecdef`).

**(f) `generation` is a third setting on the same tables** (MVP1 blocker 5 residue, critique P0-4). It is not yet implemented. When it lands, note that critique P0-4 requires the ledger tables to be **tenant-scoped and generation-agnostic** or the chain cannot verify across a `make reset` — which composes cleanly with §4.3's rule that ledger tables are never as-of filtered either. The ledger's policy shape is: tenant, and nothing else.

---

## 7. MIGRATION SHAPE — AND AN HONEST ANSWER ON THE RIDE-ALONG

MVP1 blocker 6 argued: blockers 5 (RLS) and 6 (as-of) are both "attach one thing to all 43 tables", so they must ship as one sweep, because *"two sweeps six months apart cost more than twice one sweep, because the second must re-verify the first."*

**That argument is now mostly wrong, and it was partly wrong when it was written.** Three parts:

**(1) The re-verification cost the argument feared has already been paid, and it is automated.** `0004_row_level_security.sql` applied policies with a `DO $$ … FOR t IN SELECT relname FROM pg_class WHERE nspname='lotmark' AND relkind='r'` loop, and `packages/db/src/__tests__/rls.test.ts` ends with two `pg_catalog` completeness assertions ("is enabled AND forced on every table", "every table has a policy"). The as-of sweep reuses the *same enumerator verbatim* and adds a mirrored `pg_trigger` assertion. Re-verifying the first sweep costs one already-passing test run, not an O(tables) audit. **The general lesson worth recording: a table-wide sweep is cheap to repeat exactly when the invariant it establishes has a `pg_catalog` completeness test.** RLS has one. So the coupling is dissolved.

**(2) The two sweeps were never as coupled as claimed.** RLS attaches a **policy expression** that must be reasoned about per table (`0004` has three distinct predicates: `tenants` by its own `id`, `study_equipment` and `facility_lots` reaching through their parent). As-of attaches a **trigger with no per-table variation at all** — the same function, the same arguments, 44 times. There is no shared design decision between them. The real cost of blocker 6 was never the sweep; it was deciding the per-table temporal semantics (§5), which is table-by-table analysis that a joint migration would not have accelerated by one hour.

**(3) So: ship the as-of machinery now, as its own migration `0010_as_of.sql`, standalone.** Blocker 1 (the checksum-refusing migration runner) is **done** — `packages/db/src/migrate.ts` exists with `lotmark_meta.schema_migrations` and a hard refusal on checksum mismatch — so `0010` applies cleanly to a database already carrying `0000`–`0009`. The reason to ship now rather than later is not sweep economics; it is that **the completeness test is what enforces the invariant forever, and the table count is about to go from 44 to ~60.** A table added between now and Wave 3 is missed only if the test does not yet exist.

**What should still ride together, in a later `0011`:** the `generation` column on ~40 tables plus the rewrite of all 44 policies from `0004` (critique P0-4's generation-agnostic ledger decision must be made in the same file), plus `correlation_id` into `lotmark.audit_payload()` (blocker 3), plus the four temporal columns from §5.4 (`study_results.measured_at`, `study_equipment.added_at/removed_at`, `facility_lots.validity`, `vault_holdings.valid_from/valid_to`). Those genuinely are one sweep: they are `ALTER TABLE`s on the same tables, they rewrite the same rows, and the generation work must re-touch every policy anyway.

### `0010_as_of.sql` — contents, in order

1. `lotmark.as_of_is_set()`, `lotmark.as_of()`, `lotmark.set_as_of(date)` + `GRANT EXECUTE` (§1.1).
2. `lotmark.refuse_write_under_as_of()` (§2.1).
3. The `DO` loop attaching `as_of_read_only` and `as_of_read_only_truncate` to every `relkind='r'` in `lotmark` (§2.1).
4. `lotmark.as_of_state(text, uuid)` over `state_transitions` (§4.4).
5. `CREATE TABLE lotmark_meta.temporal_class` + one row per table, with `fidelity` and a `note` (§5.2). Every table gets a row, including `class = 'none'` ones — so adding a table forces an explicit decision rather than defaulting to silence.
6. `CREATE ROLE lotmark_reader` (idempotent, mirroring `0005:20-27`), `GRANT USAGE ON SCHEMA`, `GRANT SELECT ON ALL TABLES`, enumerated `GRANT EXECUTE` on the `STABLE` invoker functions only, `ALTER DEFAULT PRIVILEGES … GRANT SELECT`. **No `GRANT EXECUTE ON ALL FUNCTIONS`** (§1.3).
7. The `signature_basis_checked_on_is_act_time` CHECK on `signatures` (§4.1) — conditional on the `ctx.today` source change landing in the same commit.
8. Header naming the `REQ-` ids and the change-control reference, per §1.4. Forward-only; no down migration.

Application-side, same commit: the branded `WriteTx`/`AsOfTx` types and `inAsOfTransaction` in `apps/api/src/db.ts`; the second pool; `WriteTx` on `recordAudit`/`applySignature`/`nextCode`/`renderAndStoreIssue`; `?asOf` parsing and the 400-on-mutating-route rule; `ctx.today` from the database clock (`plugins/session.ts:128`); the `GuardRequest.onDate` → `actedOn` rename and the deletion of its misleading doc comment (`services/guard.ts:56`).

---

## 8. THE TEST THAT PROVES IT

`packages/db/src/__tests__/as-of.test.ts`, modelled on `rls.test.ts` (same `twoTenants` rollback harness, same `pg_catalog` completeness idiom), plus two API-level tests. Eleven properties; the sweep tests and the property test are the ones that matter.

1. **Completeness — every table has the trigger.** Query `pg_trigger` joined to `pg_proc` for `refuse_write_under_as_of`, restricted to `tgtype` indicating BEFORE/STATEMENT/INSERT|UPDATE|DELETE; assert the list of tables *without* it is `[]`. This is the test that makes a table added in 2027 fail the build. Directly mirrors rls.test.ts's `'is enabled AND forced on every table'`.

2. **Completeness — every table has a `lotmark_meta.temporal_class` row.** Forces an explicit semantic decision for every new table.

3. **Write refusal, all four verbs.** With `as_of` set: `INSERT INTO lotmark.projects` raises `LM_ASOF_WRITE`; `DELETE` raises; `INSERT INTO lotmark.audit_ledger` raises `LM_ASOF_WRITE` (not the audit-key error — statement triggers fire before row triggers, so this holds regardless of trigger name).

4. **Zero-row UPDATE still raises.** `UPDATE lotmark.projects SET material_name='x' WHERE id = gen_random_uuid()` — matches nothing, must still raise. This is the assertion that proves `FOR EACH STATEMENT` was chosen deliberately; a row trigger passes every other test in this file and fails this one.

5. **Future dates refused at both layers.** `SELECT lotmark.set_as_of(current_date + 1)` raises `LM_ASOF_FUTURE`; and, bypassing the setter, `set_config('lotmark.as_of', (current_date+1)::text, true)` followed by `SELECT lotmark.as_of()` also raises.

6. **Malformed raises; it does not silently fall back to today.** `set_config('lotmark.as_of','yesterday',true)` then `SELECT lotmark.as_of()` → error. Guards against someone copying the `current_tenant()` exception handler.

7. **The GUC does not survive the transaction.** Set inside `sql.begin`, then on the *same pooled connection* after commit assert `current_setting('lotmark.as_of', true)` is NULL. Guards the pooled-connection leak (§6c).

8. **`as_of = today` equals a live read.** Same query, once live and once with `as_of` set to today, byte-identical result sets. Proves §4.6's "one view answers both" rather than asserting it.

9. **The reproducibility property — §12 R8, and the one that actually proves as-of works.** Insert a `competence_records` row valid `2026-01-01`–`2026-06-30`; later insert a superseding record with `superseded_at` set on the first. Then assert: `competent_on('2026-03-01')` computed with `as_of` unset **equals** `competent_on('2026-03-01')` computed with `as_of = '2026-07-01'`. Generalise over `d1 < d2 ≤ today`.
   This test fails against the naive predicate. The three existing `competenceBasis()` implementations use `superseded_at IS NULL` (`routes/lots.ts:44`, `values.ts:41`, `workflow.ts:41`); reused in a temporal view, they report the person as uncertified on 1 March. **The test's value is that it catches a bug that is already written three times in the repository** and would be copied a fourth time into the first as-of view.

10. **The guard is blind to `as_of` — API level.**
    (a) `GET /api/projects/:id/budget?asOf=2026-05-01` with a user whose `study:sign` competence expired 2026-06-30 succeeds and shows historic competence.
    (b) `POST /api/studies/:id/sign?asOf=2026-05-01` → 400 at the edge.
    (c) With the edge check bypassed in the test harness and `as_of` forced on the transaction, the sign path raises `LM_ASOF_WRITE` on `INSERT INTO lotmark.signatures` — proving the trigger is a real second line, not decoration.
    (d) **Invariant over the whole table, runnable in `make verify`:** `SELECT count(*) FROM lotmark.signatures WHERE competence_checked_on::date <> (signed_at AT TIME ZONE 'UTC')::date` is zero. Once the CHECK from §4.1 lands this is enforced rather than tested, but the query stays in the invariant suite because it is the assertion an assessor can run against a restored backup with no application present.

11. **Ledger integrity under as-of.** With `as_of` set to a date before the last ledger entry, `SELECT count(*) FROM lotmark.audit_ledger` returns **all** entries, not a prefix — proving no as-of predicate reached the ledger. Paired with: `verify_audit_chain` returns `ok = true, entries = <full count>` when run in an as-of transaction. And the SECURITY DEFINER assertion from §6e: no `pg_proc` row with `prosecdef = true` in schema `lotmark` mentions `as_of`.

**What the demo must show** (§11 Phase 5's milestone, made concrete): set the as-at control to a past quarter → the conformance clause table re-resolves and a clause that is green today shows red then; every mutating control in the shell is disabled and the amber band names both the date and the fidelity scope; attempt a write through `psql` with `lotmark.as_of` set → `LM_ASOF_WRITE` naming the table and the date; and the `QUERY / Point-in-time view` entry is in the ledger with the viewer's identity and the as-of date, appended *before* the read, verifying under `verify_audit_chain`.

---

## 9. PREREQUISITES — WHAT MUST LAND FOR AS-OF TO BE HONEST

The trigger, the GUC, the rules and the tests can ship in `0010` today and are worth shipping standalone. But four of the questions the as-at control invites are **currently unanswerable**, and shipping the control without saying so is the R8 failure:

| Gap | File | Consequence |
|---|---|---|
| `study_equipment` has no dates | `0000_initial_schema.sql:362` | Closure 1 as-of resolves against today's equipment set |
| `study_results.measured_at` absent | `0000_initial_schema.sql:367` | §4.6's Closure 1 correction (cover at measurement, not signature) cannot be implemented |
| `facility_lots` has no `validity` | `0000_initial_schema.sql:558` | facility-excursion blast radius as-of is unanswerable |
| `vault_holdings` has no validity interval | `0000`, `0009` | `certificate_holders()`'s `from_vault` CTE has **no time predicate at all** — a live defect, not only an as-of one |

Ship `0010` with `lotmark_meta.temporal_class.fidelity = 'existence-only'` and an explicit `note` on each of these four, so the limitation is a row an assessor can query rather than a paragraph in a design document nobody reads. Close them in `0011` alongside the `generation` sweep.