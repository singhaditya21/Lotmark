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
pnpm db:migrate     # 3 migrations: schema, integrity constraints, audit chain
pnpm db:seed        # tenant, config v1, teams, and the prototype's dataset
pnpm api            # http://127.0.0.1:4000
```

Then, in another shell:

```bash
pnpm smoke ravi@producer.example
```

The smoke script signs in, completes the second factor, lists the projects that
account may see, recomputes an uncertainty budget from raw measurements, and
verifies the audit chain.

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
