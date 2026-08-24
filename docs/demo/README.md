# The static demonstration

<https://singhaditya21.github.io/Lotmark/>

The real console, with the API replaced by a recording. Sign in as any of the
listed accounts with the password shown on the screen, then any six digits at
the authenticator step.

## What is real and what is not

**Real.** Every screen, the navigation, the role-dependent views, form
validation, the refusals, and the signing ceremony — including the step-up
authentication a signature demands under 21 CFR 11 §11.200, which the demo
enforces rather than skips. The uncertainty budgets, workflow machines and
conformance register are the product's own, rendering the product's own shapes.

**Not real.** Everything behind them. `apps/web/src/demo/fixture.json` is a
recording of a real seeded run, captured by `scripts/capture-fixture.mts` by
driving the actual Fastify app and writing down what came back. Writes are
applied to an in-memory copy and survive until the tab is reloaded.

**So it does not demonstrate**: that the API works, that the database enforces
anything, that signatures verify, or that any of it holds under load. Those are
claims the test suites and the conformance register make, and this page is not
evidence for them. Somebody will show this to a customer; it should not be
allowed to say more than it knows.

## Building it

```bash
pnpm demo
```

Serving it needs the `/Lotmark/` base path the build assumes:

```bash
mkdir -p /tmp/serve && cp -R apps/web/dist /tmp/serve/Lotmark && (cd /tmp/serve && python3 -m http.server 8899)
```

Then open <http://localhost:8899/Lotmark/>.

## Re-capturing the fixture

Needs a migrated and seeded PostgreSQL, because it drives the real app:

```bash
pnpm demo:capture
```

It refuses to write a fixture that still contains any of the forbidden terms —
see the substitution table at the top of the script. Fix the table rather than
editing the JSON, or the next capture puts the term back.

## Why the demo build is a flag and not a fork

`VITE_DEMO` is read at exactly one place in the product code — `request()` in
`apps/web/src/lib/api.ts`, the single function every API call passes through —
and at the sign-in screen's credentials hint. A normal build folds the constant
to `false`, drops the branch and tree-shakes the fixture away entirely; this is
checked, because an earlier version used bracket access on `import.meta.env`,
which Vite does not substitute, and the production bundle shipped the whole
recording.

A separate demo application would drift from the product within a release, and
the drift would show up as a demonstration of software that no longer exists.


## Recording shortcuts

Deep-link straight to a screen so a take starts where you want it:

```
https://singhaditya21.github.io/Lotmark/?screen=conformance
```

Any surface id works: `projects`, `capa`, `orders`, `catalogue`, `tiers`,
`audit`, `conformance`, `people`, `configuration`, `forms`, `flows`,
`operations` (producer), and `shop`, `my-orders`, `vault`, `my-tiers`
(customer). An unknown id falls back to the default screen.

**Reset** — the "Reset" link in the demo bar unwinds everything done this
session to the recorded starting point, without signing out or reloading, for a
clean re-take between recordings.

**A withdrawn certificate to film.** The public verification page has two
faces; the striking one is the recall. This certificate is seeded withdrawn, so
you can film the red "do not rely on this certificate" page directly:

```
https://singhaditya21.github.io/Lotmark/verify/p5Sl5-u5OXZ5Snb-7gDAIjiD
```

You can also verify by typing a code at the bare landing:

```
https://singhaditya21.github.io/Lotmark/verify
```

Enter `CRT-2041`. Both verification pages offer **Download this record**, which
saves the shown facts as JSON — the demo's stand-in for the signed PDF the real
product hands over.

The current (green) page is reached from any holder's Certificate vault by
clicking **check**.

**Two producers.** The demo bar's "Switch to Aurora Standards Ltd" toggles
between two producer tenants running the same platform with isolated,
differently-named data — a different lab, different materials, different people.
It is how multi-tenancy looks from the inside.
