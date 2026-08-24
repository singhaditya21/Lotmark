# The recording shot list

Eight journeys, in the order I'd cut them into a reel — strongest proof first.
Each is one take. All start points are deep-links into the live demo:

**Base:** `https://singhaditya21.github.io/Lotmark/`

## Before you record

- **Sign-in:** password `demo-viewer`, then **any six digits** at the
  authenticator step. The email decides the role.
- **Deep-link to a screen:** append `?screen=<id>` — `projects`, `capa`,
  `orders`, `catalogue`, `tiers`, `audit`, `conformance`, `people`,
  `configuration`, `forms`, `flows`, `operations` (producer); `shop`,
  `my-orders`, `vault`, `my-tiers` (customer).
- **Reset between takes:** the **Reset** link in the demo bar unwinds
  everything done in the session to the recorded starting point — no reload,
  no re-login. Use it before every re-take.
- Film in one tenant unless the clip is specifically about the second one.

---

## 1 — The signed release chain *(≈90s · the spine)*

**Story:** a certified value becomes a released, publicly-verifiable
certificate, and every hand on it signs.

**Start:** `admin@producer.example` → `?screen=projects` → open
**PRJ-0412 · Paracetamol**.

**Steps:**
1. **Studies** — `ST-1014 · confirmatory retest` is in state **draft** with a
   **Sign** button. Click it → choose a meaning → **Sign**. The first signature
   opens the **Confirm your identity** step-up ceremony ("You are about to Sign
   study ST-1014" — 21 CFR 11 §11.200); complete it, then **Sign again** to
   finish. The row flips to **signed** with today's date, and the "still
   unsigned" note clears.
2. **Property values** — `PV-02 · Water content (Karl Fischer)` is in state
   **assigned** with an **Authorise** button. Authorise it → because the signing
   session opened in step 1 is still live, this goes straight through, no second
   ceremony → the value reads **authorised** and a lot moves towards releasable.
   (`PV-01` is already authorised, for contrast.)
3. **Lot register** — show the lifecycle across states
   (study → authorisation → released → withdrawn).
4. **Issues & reissue** (top of the project) → **Reissue…** the certificate,
   reason "uncertainty budget corrected" → a new issue is recorded and the
   holders are marked notified. (Or **Withdraw issue #1…** for a recall — which
   sets up journey 2.)
5. `?screen=audit` — the **Audit ledger** now carries all of it at the top,
   under *Tenant Administrator*: `study.sign`, `value.authorise`, and the
   certificate act, each with the time source and region.

**Capture:** the step-up dialog once; the study row flipping to signed with its
date; the stacked ledger rows seconds later.

> **The ceremony shows once.** The first signed act opens a signing session that
> stays live for a few minutes, so steps 2 and 4 don't re-prompt — sign the
> study, and the authorise and reissue flow without interruption. That is the
> intended 21 CFR 11 rhythm, not a glitch.

---

## 2 — Public certificate verification *(≈30s · the trust shot)*

**Story:** anyone can check a certificate without an account.

**Start (recall):**
`https://singhaditya21.github.io/Lotmark/verify/p5Sl5-u5OXZ5Snb-7gDAIjiD`
→ the red **"WITHDRAWN — do not rely on this certificate"** page, with the
reason (a homogeneity re-assessment invalidated the value).

**Then (current):** `https://singhaditya21.github.io/Lotmark/verify` → type
`CRT-2041` → **Check** → the green **Current** page with the full assay facts.

**Capture:** the red→green contrast, and **Download this record** on either.

---

## 3 — Publish a configuration under signature *(≈45s · change control)*

**Story:** the platform governs its own configuration the same way it governs
data — a signed, versioned act.

**Start:** `admin@producer.example` → `?screen=configuration`. A draft
(version 2) is already waiting with two real changes.

**Steps:**
1. Show the versions table — v1 **active**, v2 **draft (2 changes)**.
2. **Review and publish the draft** → the two changes (a second approval before
   dispatch; a storage-condition field on every lot).
3. **Sign and publish** → step-up ceremony → complete it → publish again.
4. Result: **"Version 2 is now active — 2 change(s), signed."** v1 is
   superseded; `?screen=audit` shows the `config.publish` entry naming both keys.

**Capture:** the version table flipping, and the ledger entry.

---

## 4 — Customer order + cold chain *(≈60s)*

**Story:** the buyer's side, from order to a tracked, temperature-monitored
shipment.

**Start (customer):** `meera@genpharm.example` → `?screen=catalogue`.

**Steps:**
1. Set a quantity on a product → **Place order** → it comes back coded and
   priced, against GenPharm, and appears in **My orders**.
2. Switch to the producer: `admin@producer.example` (or `vikram@`, dispatch)
   → `?screen=orders` → advance the order to **dispatched** — a courier and a
   **tracking reference** are attached.
3. Show a shipment logging a temperature reading, and an **excursion** flagged
   in the ledger.

**Capture:** the priced order in My orders; the excursion flag.

---

## 5 — Role & tenant isolation *(≈45s · it's real multi-tenant SaaS)*

**Story:** the same screens change by role, and two producers share the
platform without seeing each other.

**Steps:**
1. `admin@producer.example` — full nav (Configuration, People, everything).
2. Sign out → `ravi@producer.example` — bench scientist, team-scoped; fewer
   screens.
3. Sign out → `meera@genpharm.example` — a customer sees only **Catalogue**,
   **My orders**, **Vault**; no producer screens.
4. Back as `admin@` → demo bar **"Switch to Aurora Standards Ltd"** — a second
   producer, isolated, differently-named data.

**Capture:** the nav shrinking by role; the tenant name and data changing on
switch.

---

## 6 — Forced-password first login *(≈20s · security posture)*

**Story:** a new hire can't touch anything until they replace the password they
were issued.

**Start:** `newuser@producer.example` (password `demo-viewer`, any six digits).

**Steps:** the console opens straight on **"Set your own password"** and goes
nowhere else → set any twelve-plus characters → lands on the bench scientist's
console with a **"Password changed"** notice.

---

## 7 — Complaint → CAPA *(≈40s · quality-system depth)*

**Story:** a nonconformity is worked to a root cause and closed with its
reasoning — never deleted.

**Start:** `admin@producer.example` (or `neha@`, quality) → `?screen=capa`.

**Steps:** open **NCR-0231 · Temperature excursion** (state *investigation*)
→ transition it (e.g. to root cause) with a reason → step-up if required → the
move and its reason land in the ledger.

**Capture:** the state moving; the reason recorded.

---

## 8 — Guided tour *(≈30s · the intro clip)*

**Story:** a narrated overview for the top of the reel.

**Start:** any producer sign-in → demo bar **"Guided tour"** → arrow keys
through the six stops (projects, conformance, audit, flows, forms, operations).
