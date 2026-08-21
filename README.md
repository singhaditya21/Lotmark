# Lotmark

An ISO 17034 reference material producer platform. Configurable, multi-tenant,
and built to be defensible under 21 CFR Part 11 and ISO 17034 rather than merely
to look like it.

## Running it

PostgreSQL 16+ must be running. **No Docker required** — this runs as native
processes against your local Postgres.

```bash
pnpm install
createdb lotmark_dev
pnpm db:migrate     # 4 migrations: schema, constraints, audit chain, signing
pnpm db:seed        # tenant, config v1, teams, and the prototype's dataset
pnpm dev            # API on :4000, console on :5173
```

Open **http://localhost:5173**. The console proxies `/api` to the API on the
same origin, so the session cookie needs no `SameSite` relaxation and
development behaves the way production will.

### Smoke scripts

With the API running, these drive the real flows from the command line:

```bash
node apps/api/scripts/smoke.mjs neha@producer.example
node apps/api/scripts/sign-smoke.mjs
node apps/api/scripts/sod-smoke.mjs
node apps/api/scripts/pipeline-smoke.mjs
```

`pipeline-smoke` runs the whole slice: sign a study, assign a value, watch
segregation of duties refuse the assigner, have a second person authorise,
release a lot, issue a certificate, and verify the chain.

### Demonstration accounts

Password `demo-password-1234` for all. Authenticator secret
`JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (one entry covers every account — demo data,
deliberately published).

| Account | Role | Scope |
|---|---|---|
| `ravi@producer.example` | RM Scientist | Organics, plus dated leave cover on Inorganics |
| `sunil@producer.example` | Production Lead | Organics |
| `asha@producer.example` | Technical Manager | Organics |
| `neha@producer.example` | Quality Manager | Tenant-wide |
| `arjun@producer.example` | Commercial | Tenant-wide |
| `vikram@producer.example` | Dispatch | Tenant-wide |
| `admin@producer.example` | Tenant Admin | Tenant-wide |
| `meera@genpharm.example` | Laboratory QM | Customer |
| `suresh@sdtl.gov.example` | Laboratory Buyer | Customer |

## Layout

| Package | What |
|---|---|
| `packages/domain` | The rules: permissions, roles, SoD, state machines, signatures, retention, and the configuration model |
| `packages/stats` | ISO Guide 35 computation — ANOVA, regression, consensus, uncertainty budget |
| `packages/security` | Argon2id passwords, TOTP with replay protection |
| `packages/db` | Drizzle schema, hand-written migrations, seed |
| `apps/api` | Fastify API |

## Certificates

A certificate is a real document, not a database row:

```bash
# after issuing, the response carries the download and verification URLs
curl -s localhost:4000/verify/<token>            # public page, no account needed
node apps/api/scripts/verify-certificate.mjs \
     <cert.pdf> <public-key.pem> <signature>     # no database, no imports
```

Rendering is **deterministic** — the same issue renders byte-identical, because
the dates come from the issue rather than the wall clock and the document ID is
derived from a content digest. That is what makes "here is the document we
issued" a checkable claim rather than a figure of speech.

The Ed25519 signature is over the PDF bytes, so a customer's auditor verifies it
with the public key alone — no account, no database, no cooperation from the
producer.

**Not claimed: PDF/A.** That needs an sRGB OutputIntent, six-letter font subset
prefixes, and a veraPDF gate in CI. Fonts are fully embedded and XMP metadata
carries the provenance, but an unverified conformance claim is worth less than
an honest absence of one. See the header of `certificate-pdf.ts`.

## Documents

- [`docs/architecture/`](docs/architecture) — the architecture decision document, its adversarial critique, and [the low-code design](docs/architecture/LOW-CODE.md)
- [`docs/artefacts/`](docs/artefacts) — the source prototype and wireframe
- [`docs/commercial/`](docs/commercial) — the estimate workbook. **Not product scope.**

## Testing

```bash
pnpm -r test        # unit + integration (db tests need lotmark_dev)
pnpm -r typecheck
```

The statistics engine is golden-tested at **exact float equality** against values
produced by the original prototype, because a certificate states an assigned
value and an expanded uncertainty — if those drift, every certificate issued
under the old code becomes unreproducible.
