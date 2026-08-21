# Commercial artefacts — NOT product scope

`Lotmark_and_IPC_Estimate_v5.xlsx` is a **bid and costing workbook**. It is kept
because it is the best available statement of intended scope — 42 modules, the
phase breakdown, the risk register — and because it names non-functional
requirements (residency, STQC CQW, GIGW 3.0, DPDP) that the product must meet.

**Nothing in this workbook is a feature specification.**

Estimation, costing, rate cards, Monte Carlo effort modelling, scenario pricing
and margin analysis are a **separate concern from the Lotmark product** and are
not to be implemented inside it. Lotmark is a reference material producer
platform: it manages materials, studies, uncertainty, certificates, lots, orders
and conformance. It does not price software projects.

If estimation tooling is ever wanted, it is a different application with a
different data model and a different audience.

## What the workbook is legitimately used for

- Scope reference — which modules were intended, and their relative weight.
- Non-functional requirements sourcing.
- Sequencing input for the delivery plan.

## What it must never become

- A module in the console.
- A data model in `packages/db`.
- A screen, a report, or an API surface.
