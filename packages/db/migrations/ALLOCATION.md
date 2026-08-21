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
| 0023 | `conformance_views` | 6 — conformance view and assessment pack | all of the above |

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

- **0023 last.** Its clause views must be written against the final schema.
