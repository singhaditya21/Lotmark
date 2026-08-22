# LOTMARK — THE FIRST TENANT

**How to bring a real producer into existence on a fresh deployment, given that the seed refuses production and no script does the job.**

Companion to [`DEPLOYMENT.md`](DEPLOYMENT.md). Read §3 and §5 of that document first.

---

## 1. WHY THIS IS A DOCUMENT AND NOT A COMMAND

The seed refuses production, for two independently sufficient reasons stated in its own message: it `TRUNCATE`s every table including the append-only audit ledger, and it creates nine accounts sharing one published password. That refusal is correct and should not be worked around — the guard is code rather than a runbook entry because "the difference between seeding the demo and destroying a producer's records is one shell that had the wrong `DATABASE_URL` exported."

The refusal then points at the alternative:

> If this is a fresh deployment that needs a first tenant, provision it with `lotmark.provision_tenant` and create the first account through the admin API; neither destroys anything and neither mints a known credential.

**That path is not complete.** I traced every step of it:

| Step | Sanctioned mechanism | State |
|---|---|---|
| Create the tenant | `lotmark.provision_tenant(...)` | exists — and **no route or script anywhere calls it**; only the seed and the test suite do |
| Create an organisation | — | **nothing.** The only `INSERT INTO lotmark.organisations` outside tests is in the seed |
| Create the first user | `POST /admin/users` | requires a live session holding `user:manage`, and an `organisationId` that already exists |
| Grant it a role | `POST /admin/users/:id/roles` | reads the **active configuration version**, which a fresh tenant has none of |
| Publish configuration version 1 | `POST /admin/config/draft` → `…/publish` | requires a session holding `user:manage` |
| Register the first signing key | — | **nothing.** Under `env` custody, minting is impossible by construction (`DEPLOYMENT.md` §2.2) |

Every entry point into the admin API needs a privileged session, and the only way to get one is through records that only the admin API can create. It is a closed loop, and the seed is the only thing that has ever broken into it.

So the first tenant is a **one-off provisioning script that you must write**, run once, by hand, by a named person, with its output kept. It has to be a script rather than pure SQL for one unavoidable reason: the first user's `password_hash` must be produced by `hashPassword` from `@lotmark/security` (Argon2id with this build's parameters), and configuration version 1 is derived from code constants in `@lotmark/domain` rather than typed out. Neither is reachable from `psql`.

This document says exactly what that script must do, in order, with the schema it writes into. It has not been run — nothing in this repository has been run against a production deployment.

---

## 2. WHAT MUST EXIST, AND IN WHAT ORDER

The order is forced by foreign keys and by two constraints that are easy to miss. The seed states it in a comment of its own: "config_versions.created_by references a user, and role_assignments reference the tenant — so tenant, then people, then config."

```
  1. tenant                    ← provision_tenant (SECURITY DEFINER; the only way in)
  2. tenant.time_source, .region, .out_of_scope   ← UPDATE; see §3.3, this matters
  3. organisation (kind='producer')
  4. first user                ← password_hash from hashPassword(); TOTP secret from generateSecret()
  5. config version 1, status 'draft'   ← created_by = the first user
  6. config entries            ← derived from @lotmark/domain defaults
  7. publish: status → 'active', published_by, published_at
  8. role assignment           ← role_key must be a role key that step 6 wrote
  9. record signing key        ← generated out of band; public half registered here
 10. a ledger entry recording all of it
```

Steps 1–10 belong in **one transaction**, with `lotmark.tenant_id` and `lotmark.audit_key` set on it. Step 9's private half is generated *before* the transaction and never goes near the database.

Two constraints that will otherwise bite:

- **`config_versions` has a partial unique index `one_active_per_tenant` and another `one_draft_per_tenant`.** You can hold exactly one of each. Version 1 must also satisfy `CHECK (version_number = 1 OR based_on_version_id IS NOT NULL)`.
- **`role_assignments.role_key` is free text with no foreign key to the configuration.** Nothing stops you writing a role key that no config entry defines — and the result is a user who authenticates and can do nothing, with no error to explain it. Grant a key you know step 6 wrote.

---

## 3. BEFORE YOU START

### 3.1 Decide these values

| Value | Where it goes | Notes |
|---|---|---|
| tenant UUID | `provision_tenant(p_id, …)` | generate one and **record it** — every signing-key environment variable name is derived from it |
| slug | `tenants.slug` | globally unique |
| name, short name | `tenants.name`, `.short_name` | on certificates |
| conformance frame | `tenants.conformance_frame` | e.g. `ISO 17034 + DPDP`. A profile string, not a control |
| lot numbering template | `tenants.lot_numbering_template` | display-only; the authoritative one is the `numbering` config entry |
| data residency | `tenants.data_residency` | a declaration. §3.3 |
| **time source** | `tenants.time_source` | **stamped on every ledger entry and signature.** §3.3 |
| **region** | `tenants.region` | same. §3.3 |
| out of scope | `tenants.out_of_scope` | a JSON array, and the thing an assessor or a procurement reviewer will actually be shown. Write it deliberately: the demonstration tenant's four entries are the prototype's, not yours (`DEPLOYMENT.md` §9.6) |
| first admin: code, email, display name | `users` | `(tenant_id, code)` and `(tenant_id, email)` are each unique |

### 3.2 Have the deployment environment ready

The script calls `loadConfig()` if it imports anything from `apps/api/src`, so under `NODE_ENV=production` it is subject to every refusal in `DEPLOYMENT.md` §5.2 — reported one at a time, in the fixed order that section's opening table gives, so expect several passes if the environment is incomplete. Give it the full production environment. You also need `openssl` on the machine for §4 (`DEPLOYMENT.md` §2.6). In particular `LOTMARK_AUDIT_KEY` and `LOTMARK_AUDIT_KEY_GENERATION` must be the real ones — the first ledger entry commits the generation to that key permanently, and getting it wrong means every subsequent write fails.

It connects as the **owner**, not `lotmark_app`: `organisations`, `config_versions` and `signing_keys` are ordinary writes the app role could do, but `provision_tenant` needs no special privilege and you want one connection for the whole transaction. Use `DATABASE_ADMIN_URL`.

### 3.3 `provision_tenant` does not set `time_source` or `region`, and their defaults are wrong for you

This is the trap in this document that costs the most to discover late.

```
time_source  DEFAULT 'pool.ntp.org (stratum 2)'
region       DEFAULT 'eu-central-1'
```

`provision_tenant` takes seven arguments and neither of these is among them. Both columns are **stamped onto every audit ledger entry and every signature** (`packages/db/src/schema/audit.ts:66-73`, `:133-134`). So a tenant provisioned and never updated writes `eu-central-1` into the region field of every immutable record it will ever produce — in a deployment whose whole residency argument is that it is in India.

Update both in the same transaction, immediately after `provision_tenant` and **before the first ledger entry**. The ledger is append-only; entries written with the wrong region cannot be corrected, only explained.

And make the value true. CERT-In requires clocks synchronised to a declared, traceable source (NIC or NPL NTP). `time_source` is a text label and nothing measures NTP offset or refuses to sign on drift — the application records the claim, the operating system has to make it true, and an assessor is entitled to ask you to demonstrate both.

---

## 4. STEP 0 — THE RECORD SIGNING KEY

Do this first, outside the database, because the transaction in §5 registers its public half and because the private half must never touch the machine that later reads it from a secrets manager.

Under `env` custody — which `DEPLOYMENT.md` §2.2 shows is the only class both implemented and production-legal — **the system cannot create this key for you.** `EnvCustody.write` throws by construction, so first-boot minting rolls back its own registration and `custody:move --to env` fails at step 2 of 5.

Generate an Ed25519 keypair. The private half must be PKCS#8 PEM, which is what `openssl genpkey` produces and what `loadPrivateKey` expects:

```bash
openssl genpkey -algorithm ed25519 -out lotmark-record-rec-v1.pem
```

Extract the public half as SPKI PEM — this is the form stored in `signing_keys.public_key_pem`:

```bash
openssl pkey -in lotmark-record-rec-v1.pem -pubout -out lotmark-record-rec-v1.pub.pem
```

Compute the fingerprint. It is the first 32 hex characters of SHA-256 over the SPKI DER — I verified this command reproduces `publicKeyFingerprint` exactly:

```bash
openssl pkey -in lotmark-record-rec-v1.pem -pubout -outform DER | openssl dgst -sha256 | awk '{print substr($2,1,32)}'
```

Encode the private PEM for the environment. `EnvCustody.read` base64-decodes the variable and expects the PEM text back:

```bash
base64 < lotmark-record-rec-v1.pem | tr -d '\n'
```

Put that string into your secrets manager under the derived name. The name is computed, not chosen: `LOTMARK_SIGNING_KEY_` followed by `<tenantId>_rec-v1` with every non-alphanumeric replaced by `_`, uppercased. For tenant `3f2b9c14-7d58-4a61-9e03-8c5b2a17d6f4`:

```
LOTMARK_SIGNING_KEY_3F2B9C14_7D58_4A61_9E03_8C5B2A17D6F4_REC_V1
```

Do not trust the name printed by the refusal message if you meet it — it passes the literal string `'<version>'` and prints `…__VERSION_`, which is not the name you need.

Then destroy the local private PEM, and confirm the key is retrievable from the secrets manager before you do. Every certificate this deployment ever issues will be signed with it, and there is no recovery path: a lost record key means every future certificate carries a new key version, and every past signature stays verifiable only through the public half in `signing_keys`.

---

## 5. STEP 1 — THE PROVISIONING TRANSACTION

### 5.1 What the script must write

The exact tables and the columns that matter. Everything not listed has a workable default.

```sql
-- 1. The tenant. SECURITY DEFINER, because the caller has no tenant context
--    yet and lotmark.tenants is itself under RLS. This is the only way in.
SELECT lotmark.provision_tenant(
  '<tenant-uuid>', '<slug>', '<name>', '<short name>',
  '<conformance frame>', '<lot numbering template>', '<data residency>');
```

```sql
-- 2. The two columns provision_tenant cannot set. See §3.3.
UPDATE lotmark.tenants
   SET time_source = '<declared, traceable NTP source>',
       region      = '<region>',
       out_of_scope = '["…"]'::jsonb
 WHERE id = '<tenant-uuid>';
```

```sql
-- Every table below is under FORCE RLS. Without this the inserts affect
-- ZERO ROWS and report success.
SELECT set_config('lotmark.tenant_id', '<tenant-uuid>', true),
       set_config('lotmark.audit_key', '<the real audit key>', true),
       set_config('lotmark.audit_key_generation', '<v1 or whatever you chose>', true);
```

```sql
-- 3. The producer organisation. kind is 'producer' or 'customer'.
INSERT INTO lotmark.organisations (id, tenant_id, code, name, kind, price_tier)
VALUES ('<org-uuid>', '<tenant-uuid>', '<code>', '<name>', 'producer', 'private');
```

```sql
-- 4. The first user. password_hash MUST come from hashPassword(); the value
--    below is a placeholder the script substitutes.
INSERT INTO lotmark.users
  (id, tenant_id, organisation_id, code, email, display_name,
   password_hash, totp_secret_encrypted, mfa_required, password_change_required)
VALUES ('<user-uuid>', '<tenant-uuid>', '<org-uuid>', '<code>', '<email>', '<name>',
        '<argon2id hash>', '<totp secret>', true, true);
```

`password_change_required = true` makes the issued credential enrolment-only: the session may ask who it is, replace the password and sign out, and every other route refuses it. That is how `POST /admin/users` behaves for every account it creates, and the first account should not be the exception. Migration 0024 records the obligation on the row rather than inferring it from the absence of a change.

```sql
-- 5. Configuration version 1, as a draft.
INSERT INTO lotmark.config_versions
  (id, tenant_id, version_number, status, change_reason, created_by)
VALUES ('<version-uuid>', '<tenant-uuid>', 1, 'draft',
        'Initial product configuration, derived from the built-in defaults',
        '<user-uuid>');
```

```sql
-- 6. One row per entry. kind ∈ role, workflow, field, picklist, layout, view,
--    dashboard, report, numbering, template, translation, sod, retention, flag.
INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
VALUES ('<tenant-uuid>', '<version-uuid>', '<kind>', '<key>', '<payload>'::jsonb);
```

```sql
-- 7. Publish. Entries can only be written while the version is a draft;
--    publishing is a separate, deliberate step, which is the point of the
--    two states.
UPDATE lotmark.config_versions
   SET status = 'active', published_by = '<user-uuid>', published_at = now()
 WHERE id = '<version-uuid>';
```

```sql
-- 8. The role. role_key must match a 'role' entry written in step 6 — there
--    is no foreign key, and a wrong key produces a user who can do nothing.
INSERT INTO lotmark.role_assignments
  (tenant_id, user_id, role_key, granted_by, granted_reason)
VALUES ('<tenant-uuid>', '<user-uuid>', 'tenantadmin', '<user-uuid>',
        'Initial provisioning');
```

```sql
-- 9. The record signing key. Public half only. custody='env' is what makes
--    the certificate footer true, and what arms the ratchet in migration 0029.
INSERT INTO lotmark.signing_keys
  (tenant_id, key_version, algorithm, public_key_pem, fingerprint,
   custody, purpose, activated_at)
VALUES ('<tenant-uuid>', 'rec-v1', 'ed25519', '<SPKI PEM from §4>',
        '<fingerprint from §4>', 'env', 'record', now());
```

Then step 10: write one ledger entry recording the provisioning, so that the first thing in the tenant's append-only history is an account of how it came to exist. `recordAudit` from `apps/api/src/services/audit` takes the actor context (`tenantId`, `actorUserId`, `actorLabel`, `actorRoleId`, `sessionId`, `timeSource`, `region`) and the entry (`kind`, `action`, `detail`, `subjectTable`, `subjectId`, `changes`) — `scripts/rotate-audit-key.mts` is a worked example of using it outside a request.

### 5.2 Where the configuration entries come from

Do not type them. They are **derived from code constants** on purpose, so that "a permission added to a role in `roles.ts` appears in the seeded configuration automatically", and so that the derivation itself proves the configuration model can express everything that used to be hardcoded.

The exports to use, all from `@lotmark/domain`, exactly as `packages/db/src/seed/run.ts` uses them:

| Kind | Source | Count in the demonstration tenant |
|---|---|---|
| `role` | `defaultRoles()` | 9 — `tenantadmin`, `quality`, `techmgr`, `prodlead`, `scientist`, `commercial`, `dispatch`, `labbuyer`, `labqm` |
| `workflow` | `defaultWorkflows()` | the seven state machines |
| `sod` | `defaultSodConfig()` | the segregation-of-duties rules |
| `numbering` | `defaultNumbering()` | override the `lot` entry's `template` here if the tenant wants its own |
| `flag` | `defaultFlags()` | |
| `retention` | optional | omit it and every class falls back to its statutory floor, which is the safe default. Publishing a period **below** a floor is refused, naming the regime |

Picklists, custom fields and layouts are tenant content rather than product defaults; the seed derives its own from the prototype fixture. A fresh producer can start with none of them.

Use the driver's JSON serialisation (`sql.json(payload)` with postgres.js), not `JSON.stringify(...)::jsonb`. The seed carries the scar: pre-stringifying stores a JSON *string* rather than an object, and every reader then gets a string where it expects a record.

The role you grant in step 8 should be `tenantadmin`, which is the only default role holding `user:manage` — the permission every admin route gates on. Without it the first account cannot create the second.

### 5.3 A skeleton

**Untested. Nobody has run this.** It is the shape of the script, lifted from what `seed/run.ts` and `admin-people.ts` actually do, so that the parts that are easy to get wrong are already right. Read it against those two files before you trust it.

```ts
// scripts/provision-producer.mts — write this, run it once, keep its output.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { hashPassword, generateSecret, enrolmentUri, publicKeyFingerprint } from '@lotmark/security';
import {
  defaultRoles, defaultWorkflows, defaultSodConfig, defaultNumbering, defaultFlags,
} from '@lotmark/domain';

const TENANT = '<tenant-uuid>';
const ORG = '<org-uuid>';
const USER = '<user-uuid>';
const VERSION = '<version-uuid>';

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });

// Shown ONCE, never stored in readable form, never in the ledger. The account
// owes a password change, so this is an enrolment credential and not a
// standing one — the same contract POST /admin/users offers.
const initialPassword = randomBytes(18).toString('base64url');
const totpSecret = generateSecret();
const publicKeyPem = /* the SPKI PEM produced in §4 */ '';

await sql.begin(async (tx) => {
  await tx`SELECT lotmark.provision_tenant(${TENANT}, /* … six more … */)`;
  await tx`UPDATE lotmark.tenants SET time_source = ${'…'}, region = ${'…'} WHERE id = ${TENANT}`;

  await tx`SELECT set_config('lotmark.tenant_id', ${TENANT}, true)`;
  await tx`SELECT set_config('lotmark.audit_key', ${process.env.LOTMARK_AUDIT_KEY!}, true)`;
  await tx`SELECT set_config('lotmark.audit_key_generation',
                             ${process.env.LOTMARK_AUDIT_KEY_GENERATION ?? 'v1'}, true)`;

  await tx`INSERT INTO lotmark.organisations /* … */`;
  await tx`INSERT INTO lotmark.users (/* … */ password_hash, totp_secret_encrypted,
                                      mfa_required, password_change_required)
           VALUES (/* … */ ${await hashPassword(initialPassword)}, ${totpSecret}, true, true)`;

  await tx`INSERT INTO lotmark.config_versions /* … version_number 1, status 'draft' … */`;

  const entries: Array<[string, string, unknown]> = [
    ...defaultRoles().map((r) => ['role', r.key, r] as [string, string, unknown]),
    ...defaultWorkflows().map((w) => ['workflow', w.key, w] as [string, string, unknown]),
    ...defaultSodConfig().map((s) => ['sod', s.ruleId, s] as [string, string, unknown]),
    ...defaultNumbering().map((n) => ['numbering', n.key, n] as [string, string, unknown]),
    ...defaultFlags().map((f) => ['flag', f.key, f] as [string, string, unknown]),
  ];
  for (const [kind, key, payload] of entries) {
    await tx`INSERT INTO lotmark.config_entries (tenant_id, version_id, kind, key, payload)
             VALUES (${TENANT}, ${VERSION}, ${kind}, ${key}, ${tx.json(payload as never)})`;
  }

  await tx`UPDATE lotmark.config_versions SET status = 'active',
             published_by = ${USER}, published_at = now() WHERE id = ${VERSION}`;

  await tx`INSERT INTO lotmark.role_assignments
             (tenant_id, user_id, role_key, granted_by, granted_reason)
           VALUES (${TENANT}, ${USER}, 'tenantadmin', ${USER}, 'Initial provisioning')`;

  await tx`INSERT INTO lotmark.signing_keys
             (tenant_id, key_version, algorithm, public_key_pem, fingerprint,
              custody, purpose, activated_at)
           VALUES (${TENANT}, 'rec-v1', 'ed25519', ${publicKeyPem},
                   ${publicKeyFingerprint(publicKeyPem)}, 'env', 'record', now())`;

  // …and one recordAudit() call, so the first entry in the tenant's history
  // is an account of how the tenant came to exist.
});

console.log('initial password :', initialPassword);
console.log('enrolment URI    :', enrolmentUri({ secret: totpSecret, accountEmail: '…', issuer: 'Lotmark' }));
console.log('\nShown once. Not recoverable. Not in the ledger.');
await sql.end();
```

**Handle the output like a credential, because it is one.** Deliver it to the named first administrator through a channel that is not the terminal scrollback of whoever ran the script, and require the password change immediately. Then delete the script's output from wherever it landed.

---

## 6. VERIFY, IN THIS ORDER

**1. Installation qualification, against the production database.** Note the explicit `SIGNING_KEY_CUSTODY` — the `iq` script sets `NODE_ENV=development` itself and reads custody from the ambient environment, so without it the installation record will say `dev_file` for a deployment that runs `env`:

```bash
DATABASE_ADMIN_URL='postgres://lotmark_owner@db.internal:5432/lotmark' SIGNING_KEY_CUSTODY=env pnpm --filter @lotmark/api iq
```

Among other things it asserts that the roles are not superusers, that RLS is forced on every table, that `PUBLIC` can execute nothing, that the append-only tables really are — and that **no active account is still holding the password it was issued**, which the first administrator will fail until they have changed it. Capture the output; nothing persists it (`DEPLOYMENT.md` §10, item 2).

**2. Sign in as the first administrator.** Expect to be forced through the password change before anything else works: the issued credential authenticates but does not authorise, and the API answers `403` with code `password_change_required`.

**3. Confirm the tenant's own view of itself is right.** `time_source`, `region` and `data_residency` are what an assessor will read, and §3.3 is where they most often end up wrong:

```bash
psql "$DATABASE_ADMIN_URL" -c "SELECT slug, time_source, region, data_residency FROM lotmark.tenants"
```

**4. Confirm the signing key is readable from the environment as the API will read it.** The failure mode is a 500 on the first act needing a signature, which is a bad place to discover a base64 problem. The cheapest check is to issue a real certificate and see it signed.

**5. Issue one real certificate.** This is not optional ceremony. Until a certificate exists that was rendered by the current renderer version, the DR drill's two strongest checks — that stored certificates match their recorded digest, and that one re-renders byte-identically — cannot run, and the drill comes out `incomplete` (`DEPLOYMENT.md` §8.3).

**5a. Confirm the origin it froze.** `PUBLIC_ORIGIN` is read once, at issue time, and written into the issue's snapshot; the footer prints that stored value, not today's configuration (`DEPLOYMENT.md` §2.1). So this is the moment the promise becomes permanent for that certificate, and it is cheap to read back:

```bash
psql "$DATABASE_ADMIN_URL" \
  -c "SELECT set_config('lotmark.tenant_id','<tenant-uuid>',false)" \
  -c "SELECT issue_number, renderer_version,
             data_snapshot ->> 'verificationOrigin' AS origin
        FROM lotmark.certificate_issues ORDER BY issue_number"
```

`origin` must be your production origin and `renderer_version` must be `lotmark-pdf-3`. A `NULL` origin means the issuing route did not pass one, and the printed footer will read `undefined/verify/…`; stop and fix it before issuing anything else.

**6. Verify it at the public origin.** This is the check nothing in the code does for you: the origin is printed on the certificate, and nothing verifies that it actually routes `/verify/*` to the API rather than to the console's SPA fallback.

```bash
curl -sS "https://certificates.example.org/verify/<the real token>" \
  | grep -qi '<title>Certificate verification</title>' \
  || { echo 'the printed address does not reach the verification page'; exit 1; }
```

The console's own title is `Lotmark`, so an SPA fallback fails this check — as does an unrouted `/verify/*`, which the API answers **404** for an unknown token. Do not add `curl -f`: it discards the body on any 4xx and turns a diagnosable result into exit 22 (`DEPLOYMENT.md` §5.4). If this fails, fix the proxy before you issue a second certificate — a printed certificate cannot be recalled, and changing `PUBLIC_ORIGIN` afterwards does not change the one already printed.

**7. Run the first DR drill, and then the sabotage mode**, in that order (`DEPLOYMENT.md` §8.3). The drill records itself in `lotmark.dr_drills`, which is the one qualification artefact this system persists.

---

## 7. WHAT YOU STILL CANNOT DO

**Anchoring will be refused.** `services/anchor.ts:174-178` registers the anchor key with a hard-coded `'dev_file'`, and migration 0029's custody ratchet refuses a non-production-grade custody for a tenant that has already reached a production-grade one — which step 9 above just made true. The first `pnpm --filter @lotmark/api anchor` run therefore aborts with:

> `This tenant already holds keys under % custody, and this would register key % under %, which is not fit for production use. The usual cause is a development process pointed at a production database: check DATABASE_URL before anything else. Custody is printed on every certificate a key signs, so this is refused rather than recorded.`

The message is right about the usual cause and wrong about this one. This needs a code change — the anchor registration must take its custody class from configuration the way record keys do — and until it lands, the tamper-evidence argument that anchoring exists to make cannot be exercised in production. `DEPLOYMENT.md` §10, item 6.

Do not work around it by registering the record key as `dev_file`. The custody class is printed on every certificate, and a certificate that says `dev_file` is telling the truth about a bad situation. Making it say `env` while the key is a file on disk would be worse than either.

**The performance qualification cannot be run here.** `scripts/validation.mts` is hard-wired to `http://127.0.0.1:4000/api/v1` and to the seeded demonstration accounts with their published password. It is a development artefact. `DEPLOYMENT.md` §10, item 3.

---

## 8. AFTERWARDS — THE SYSTEM PROVISIONS ITSELF

Once one account holds `user:manage` under a published configuration version, everything else goes through the API and none of it needs `psql` again.

| To do this | Use |
|---|---|
| Create a user | `POST /admin/users` — random one-time password, fresh TOTP secret, both shown once and never in the ledger, `password_change_required = true` |
| Grant a role | `POST /admin/users/:id/roles` — only role keys the active configuration defines |
| Close an account | `POST /admin/users/:id/deactivate` — deactivation, never deletion, so the ledger keeps referring to it |
| Change configuration | `POST /admin/config/draft` → `PUT …/entry` → `…/publish` — one draft at a time, risky changes signed |
| Add a team | `POST /admin/teams`, `POST /admin/teams/:id/members` |
| Record competence | `POST /admin/competence` |

**There is still no route that creates an organisation.** Every customer laboratory you sell to needs an `organisations` row, and today that is a hand-written `INSERT` with the tenant context set — the same §5.1 step 3, one transaction at a time. Add it to the same one-off script rather than doing it ad hoc at a prompt, so that there is a record of who created which customer and when.
