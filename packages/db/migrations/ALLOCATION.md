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

- **0024 stands alone.** It adds two columns to `users` and depends on nothing.
  It deliberately does NOT back-fill `password_changed_at`, and its default of
  `false` means deploying it locks nobody out — see the file's own header.
