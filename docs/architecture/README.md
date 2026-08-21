# Architecture

| Document | What it is |
|---|---|
| `MVP1-TIERS.md` | The MVP 1 definition: three go-live tiers (internal pilot, first real customer, IPC government) with features, evidence, effort and cost. Corrected against the working tree. |
| `MVP1-CRITIQUE.md` | Adversarial review of the above. Caught a stale RLS section, three count errors and an arithmetic slip of 40 person-days. |
| `mvp1-tiers.html` | The same, as a published decision page. |
| `ARCHITECTURE.md` | The architecture decision document (v1.0). 15 sections, 15 decisions to confirm, 12 open questions. |
| `ARCHITECTURE-CRITIQUE.md` | An adversarial completeness review of the above. 7 P0 errors, 12 P1 omissions, 15 P2 items — plus an explicit list of what is complete and must not be re-opened. |

Produced by a 14-agent analysis: six parallel readers over the three source
artefacts, three competing architectures written to different design lenses,
a three-judge panel, a synthesis, and a completeness critic.

Judge tally — pragmatic-monolith 25, product-platform 20.5, compliance-first 20.
The pragmatic monolith won and became the spine; the best ideas from the other
two were grafted in and the judges' fatal flaws repaired.

**Read the critique before implementing any section of the main document.** It
identifies seven things in v1.0 that will not work as written, including DDL
that Postgres rejects outright and a dev-mode cookie configuration that makes
sign-in impossible.
