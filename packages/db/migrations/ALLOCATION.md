# Migration number allocation

`packages/db/src/migrate.ts` records a checksum per **filename** and refuses to
run on drift. Renaming a migration that has already been applied somewhere is
therefore unrecoverable — you cannot fix a collision after the fact.

So the numbers are allocated here, once, before any of the files are written.
Take the next free number from this table and add a row; do not take it from
`ls`, because a number may be claimed here before its file exists.

| # | File | Open item | Must land after |
|---|---|---|---|
| 0017 | `config_administration` | 2 — admin UI for the config model | — |
| 0018 | `key_custody` | 9 — real key custody | — |
| 0019 | `audit_key_generations` | 12 — ledger generation + key rotation | — |
| 0020 | `acquired_on_not_null` | 13 — `vault_holdings.acquired_on` | 0019 |
| 0021 | `ops_observability` | 10, 11 — DR drill records, job health | — |
| 0022 | `commercial_surfaces` | 3 — orders, entitlements, dispatch, vault | 0017, 0020, 0021 |
| 0023 | ~~`conformance_views`~~ | 6 — **withdrawn, never written** | — |
| 0024 | `password_change` | Forced password change on first sign-in | — |
| 0025 | `custom_field_values_live` | Form designer — make `field`/`picklist`/`layout` live | 0017 |
| 0026 | `signed_state_transitions` | Flow designer — a configured move can demand a signature | 0017 |
| 0027 | `flags_have_one_home` | Pre-build audit — two stores for the same four facts | — |
| 0028 | `drill_incomplete` | A recovery drill that skipped checks is not a pass | 0021 |
| 0029 | `custody_ratchet` | Custody must not silently downgrade for a tenant | 0018 |
| 0030 | `signable_config_version` | Publishing a signed configuration hit the CHECK | 0026 |
| 0031 | ~~`signature_algorithm_known`~~ | **withdrawn, written and reverted** — see below | — |
| 0032 | `operational_alerts` | Conditions were detected and nobody was told | 0021 |
| 0033 | `revoke_custody_helper` | 0029 revoked one function and not its sibling | 0029 |
| 0034 | `probe_role` | The prober must see every tenant, and nothing else | 0032 |

## Why those orderings, specifically

- **0020 before 0022.** 0020 back-fills `vault_holdings.acquired_on` before
  making it NOT NULL. 0022 adds *restrictive* organisation-isolation policies to
  `vault_holdings` and `orders`, which fail closed when no
  `lotmark.organisation_id` is set — which is exactly the state a migration runs
  in. On this machine the migration connection is a superuser and the backfill
  would silently still work; under the non-superuser owner that migration 0005
  describes, it would match **zero rows and report success**. Running 0020 first
  avoids depending on which of those two is true.

- **0019 before 0023.** 0019 changes the return shape of `verify_audit_chain`.
  The conformance views and the assessment pack read it, and coding them against
  the old shape means writing them twice.

- **0021 before 0022.** 0021 primes the CAPA numbering counter. The active
  configuration's `capa` template is `NCR-{SEQ}` with a yearly reset, but the
  only counter row is the un-scoped `('capa','all',300)` — so the current year's
  scope does not exist and `nextCode` would restart at `NCR-0001`, colliding
  with the seeded `NCR-0231`. 0022 raises CAPAs automatically on a cold-chain
  excursion and would hit that collision first.

- **0017 before 0022.** 0022 needs `entitlement` and `shipment` numbering
  templates. Those must arrive through the configuration model's own publish
  path — a migration that edits a published config version to insert them would
  contradict the immutability rule the whole model rests on, and would leave
  entries no `change_summary` in any version accounts for.

- **0023 was withdrawn.** It was allocated for SQL views backing the conformance
  screen. The screen was built instead from `packages/domain/src/conformance.ts`
  plus live queries in `apps/api/src/services/conformance.ts`, so no migration
  was needed and none was written. The number is retired rather than reused:
  `migrate.ts` keys its checksums on the FILENAME, and a `0023_something_else`
  appearing later would be indistinguishable from a renamed migration to anyone
  reading this table. Retiring a number costs nothing; reusing one costs the
  ability to trust the sequence.

- **0025 after 0017.** It makes `custom_field_values` append-only and its
  `config_version_id` NOT NULL. Every revision is stamped with the ACTIVE
  configuration version, so the one-draft-per-tenant rule and the
  risky-change-is-signed CHECK that 0017 added are what make that stamp mean
  something. Safe to run as written only because the table is empty: it has
  existed since 0000 and nothing has ever written to it.

- **0026 after 0017.** A transition can now demand an electronic signature
  because the tenant's published workflow says so, so the signature's
  `subject_kind` vocabulary has to admit a workflow move. Depends on 0017 only
  in the sense that the demand arrives through the configuration publish path.

- **0027 stands alone.** It drops four boolean columns from `tenants` that
  duplicate `config_entries` of kind `flag`. Safe because nothing reads either
  store — verified by grep across the repository before it was written.

- **0034 after 0032.** It reads the two tables 0032 creates.

- **0033 after 0029.** It revokes a privilege on a function 0029 creates.

- **0032 after 0021.** 0021 built `job_health()` and `dr_drills`, which are
  two of the three things the sweep reads.

- **0031 withdrawn.** It added `CHECK (algorithm = 'ed25519')` to
  `signatures`, matching the constraint 0003 gave `signing_keys` and never gave
  the signature's own copy. It was written, applied, and reverted the same
  hour.

  The reason is worth keeping. `verifyStoredSignature` was found never to read
  the column at all, so a row claiming any other algorithm was verified as
  Ed25519 — reported as tampering when the bytes did not match, and reported
  VALID when they did. The read side now reports such a row `unverifiable`, and
  the regression tests for that have to CONSTRUCT such a row.

  With the constraint in place they cannot. Tests connect as `lotmark_app`,
  which does not own the table and so cannot lift a CHECK, and `signatures`
  refuses DELETE, so a fixture row cannot be inserted under a dropped
  constraint and cleaned up afterwards.

  That trade is not worth taking. The write side is already closed in code —
  `applySignature` writes `SIGNING_ALGORITHM`, the same constant the verifier
  compares against, so this application cannot produce a bad row. The constraint
  would only have guarded against hand-written SQL, while removing the coverage
  protecting the defence that matters: a row from a restore, from replication,
  or from a newer deployment still has to be read safely, and that path must
  stay testable.

- **0030 after 0026.** 0026 last rewrote `signature_subject_kind_known`, and
  0030 rewrites it again. Applying them out of order would drop a constraint
  that does not exist yet.

- **0029 after 0018.** 0018 created the custody vocabulary and
  `key_custody_events`. The ratchet reads both, so it cannot precede them.

- **0028 after 0021.** 0021 gave `dr_drills` its outcome vocabulary of
  `passed` and `failed`. A drill can also skip checks it had no data to run, and
  that is a third thing.

- **0024 stands alone.** It adds two columns to `users` and depends on nothing.
  It deliberately does NOT back-fill `password_changed_at`, and its default of
  `false` means deploying it locks nobody out — see the file's own header.
