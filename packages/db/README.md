# @lotmark/db

Drizzle schema and migrations. 34 tables in the `lotmark` schema — never `public`.

## Running it locally

Postgres 16 is already running via Homebrew on `:5432`, so there is no container
to start.

```bash
createdb lotmark_dev
pnpm --filter @lotmark/db generate   # regenerate SQL from the TS schema
pnpm --filter @lotmark/db migrate    # apply
```

## Decisions worth knowing

**Multi-tenancy is row-level security, not a WHERE clause.** Every table carries
`tenant_id`. The API sets `SET LOCAL lotmark.tenant_id` per transaction and the
RLS policy does the filtering, so a forgotten filter returns nothing rather than
another tenant's data. Chosen over schema-per-tenant (migrations multiply by
tenant) and database-per-tenant (no shared catalogue, heavy on one laptop).

**Dates are ISO text, not `date`.** The domain compares dates lexically —
competence intervals, calibration coverage, "as at" queries — and these are
calendar facts, not instants. Round-tripping through a JS `Date` reintroduces
timezone drift, and in this domain that drift can move a signature across a
competence boundary.

**Money is integer minor units.** Never floating point.

**Append-only tables.** `audit_ledger`, `signatures`, `certificate_issues` and
`competence_records` are insert-only; UPDATE/DELETE are blocked by trigger and
revoked at the role level. A reissue is a new row, never an overwrite — which is
what makes "who held issue 1" answerable years later.

**The audit chain is HMAC, not a plain hash.** With a plain hash (as the
prototype used) anyone who can edit a row can recompute every subsequent link
and leave no trace. Under a keyed MAC they cannot, unless they also hold the key
— which lives outside the database. `audit_checkpoints` additionally pins the
head hash periodically, so even a wholesale rewrite of the whole ledger is
detectable.

## Still to come

The generated migration creates tables, columns, indexes and foreign keys. The
RLS policies, append-only triggers, gap-free per-tenant sequence, calibration
overlap exclusion constraints and the study-type CHECK constraints are
hand-written migrations layered on top — a generator cannot infer them, and they
are the part that carries the conformance argument.
