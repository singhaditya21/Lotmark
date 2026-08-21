# The low-code architecture

Lotmark is a configurable platform, not an application with a settings screen.
This note states where the line falls and why.

## The fixed floor — code, never configuration

Three things can never become configurable, because the conformance argument
rests on them:

| Fixed | Why |
|---|---|
| **The permission vocabulary** | A permission is a capability the code enforces at a specific call site. A tenant inventing a permission would invent a capability nothing checks. |
| **The statistics engine** | A configurable uncertainty calculation is an uncertainty nobody can reproduce. |
| **The audit chain and signature binding** | Configurable integrity is not integrity. |

Everything above that floor is data.

**Configuration composes capabilities; it never invents them.** A configured role
may only grant permissions that exist. A configured workflow transition may only
require a permission that exists. Both are enforced by the Zod schemas in
`packages/domain/src/config/schemas.ts` and covered by tests that assert an
invented permission is rejected.

## Why configuration is versioned

Under GAMP 5 and 21 CFR Part 11, validation evidence attests *what the system
does*. If a tenant reconfigures a workflow at runtime, the evidence for that
workflow is stale the moment they do — and records created yesterday were
created under different rules than today's.

The product already solves this shape of problem three times:

- a signature freezes the competence basis it relied on
- a certificate reissue never overwrites its predecessor
- every act appends to a hash-chained ledger

Configuration is the fourth. A version is **immutable once published**; editing
means creating a new draft from it. Every business record stamps the
`config_version_id` it was created under, so *"under what rules was this
certificate issued"* is always answerable, and re-validation is scoped to what
actually changed between two versions rather than to the whole system.

## Change control by risk

Not every change deserves the same ceremony. Demanding a signature to move a
field on a form trains people to sign without reading, which is worse than not
asking.

| Risk | Kinds | Ceremony |
|---|---|---|
| `security` | role, sod, retention | Audited **and signed** |
| `behaviour` | workflow, field, picklist, numbering, template, report, flag | Audited **and signed** |
| `presentation` | layout, view, dashboard, translation | Audited only |

The diff between two versions drives all three of: whether a signature is
required, which OQ tests must re-run, and the summary an approver reads before
signing. `diffConfig` compares structurally with stable key ordering — a
spurious "modified" would demand a signature and a re-validation cycle for a
change that did not happen.

Two limits configuration cannot cross: **retention may be lengthened, never
shortened** below the statutory floor, and the signature requirements on signing
a study and authorising a value cannot be removed.

## User → Team → Role

The prototype had one role per user, globally. Real laboratories do not work
that way.

```
role assignment scope:
  team_id IS NULL  → tenant-wide; applies everywhere
  team_id = <team> → applies only to records owned by that team
```

A scientist can sign studies for Organics and only read Inorganics. Assignments
are **dated**, so leave cover expires on its own rather than depending on
somebody remembering to revoke it — the same pattern as competence records.

Every authorisation question therefore has two parts: *may this person do this
at all*, and *may they do it to **this** record*. `can()` requires a scope
argument rather than defaulting, because a caller that does not know which team
a record belongs to has not loaded the record, and is not in a position to
authorise an action on it. Answering only the first part is the classic
broken-object-level-authorisation bug.

Note that a **team grant never satisfies a tenant scope** — holding admin over
one section is not authority over the whole producer.

## The four tiers

| Tier | What | Where it lives |
|---|---|---|
| **A** Security & settings | roles, teams, SoD enablement and thresholds, numbering, templates, i18n, flags, retention | `config_entries`, kinds `role`/`sod`/`numbering`/`template`/`translation`/`flag`/`retention` |
| **B** Custom fields | tenant-defined fields and picklists on built-in entities | kinds `field`/`picklist`; values in `custom_field_values` |
| **C** Workflows | states, transitions, guards, signature and competence requirements | kind `workflow` |
| **D** Presentation | form layouts, table views, dashboards, reports | kinds `layout`/`view`/`dashboard`/`report` |

## Defaults are derived, not retyped

`packages/domain/src/config/defaults.ts` derives the product's default
configuration **from the code constants** — `ROLES`, `ALL_MACHINES`,
`SOD_RULES`, `RETENTION_SCHEDULE`.

Two reasons. They cannot drift: a permission added to a role appears in the
seeded configuration automatically. And it **proves the configuration model can
express everything that used to be hardcoded** — if some rule could not survive
the round trip, the derivation fails to compile or fails its schema. That is
exactly the check worth having when moving from code to a low-code platform, and
it is asserted by tests.

## Two things deliberately not configurable as data

**Custom field values are JSONB, not EAV.** The whole document is read and
written with its parent and never joined across records; JSONB gives GIN
indexing where it must be searched. EAV would turn every detail view into an
N-row join for no benefit.

**Reports and dashboards select from named server-side queries, never raw SQL.**
Configuration shapes and filters; it does not execute. A configuration language
that can run arbitrary SQL is a privilege-escalation path wearing a report
builder's clothes.
