# The demo script

A talk track for showing Lotmark to somebody live. **Say** is roughly what to
say; **Do** is exactly what to click. Nothing here is a rehearsal requirement —
the point is that you can open the link cold and still have a spine to follow.

> **The demo** — <https://singhaditya21.github.io/Lotmark/>
>
> Sign in with any listed account. Password `demo-viewer`, then **any** six
> digits at the authenticator step.

For a recorded version of all of this, see [`videos/`](videos/README.md). For
filming your own take, see [`shot-list.md`](shot-list.md).

---

## Before you start · 60 seconds

1. Open the link and sign in as `admin@producer.example` once, so the assets are
   warm and you are not watching a spinner on the call.
2. Press **Reset** in the demo bar at the bottom. That unwinds anything a
   previous run did, without signing you out.
3. Sign out, so you begin where your audience does.
4. Full-screen the browser. The console is at its best around 1600 px wide or
   more — below about 1280 the navigation wraps.

**Know your exit:** the **Reset** link in the demo bar restores everything to
the recorded starting point at any moment. If a demo goes sideways, press it and
carry on; you do not need to reload or sign in again.

---

## The full walkthrough · about 12 minutes

The order matters. Each step is caused by the one before it, which is what makes
it a story rather than a features tour.

### 1 · Land where the work is · `ravi@producer.example`

**Say:** "This is a platform for producers of certified reference materials —
the materials other laboratories calibrate against. A scientist signs in, and
rather than a table of everything, the console opens on his own work."

**Do:** Sign in as `ravi@`. Point at **Home**: the badge, the counts, and
*Waiting on you*. Note the counts are scoped — these are things **he** can act
on, not everything that exists.

### 2 · A signature is a ceremony, not a click

**Say:** "Signing is where regulated software either means something or does
not."

**Do:** **Projects → PRJ-0412 · Paracetamol**. In **Studies**, find `ST-1014`,
still `draft`. Click **Sign**, choose a meaning, click **Sign** again.

The **Confirm your identity** dialog appears. Let it sit for a moment.

**Say:** "It is asking for the password *and* a fresh authenticator code, to
sign something he is already signed in to do. That is 21 CFR 11 §11.200 — a
signature needs a fresh authentication, not just a live session."

**Do:** Complete it, then sign the study. The row flips to `signed` with today's
date and the signer's name.

> The first signed act opens a signing session that lasts a few minutes, so the
> next few steps will not re-prompt. That is the intended rhythm, not a lapse —
> say so if anyone asks.

### 3 · Four eyes · hand off to `admin@producer.example`

**Say:** "The person who assigns a value never authorises it. Different person,
enforced by the server — not by hiding a button."

**Do:** Sign out, sign in as `admin@`, return to **PRJ-0412**. In **Property
values**, `PV-02 · Water content` is `assigned`. Click **Authorise**.

*(Notice the work Ravi did is still there. Switching persona does not throw away
the session.)*

### 4 · Release a lot, and certify it

**Say:** "A lot only exists against an authorised value. That is the whole point
of the previous step."

**Do:** **Lot register → Release a lot**. Set an expiry, stock units, a price,
**Sign and release**. The new lot appears — with its own code, and *superseding*
the batch before it. Then **Issue certificate** on that row.

**Say:** "That certificate is the document a laboratory will one day hold in its
hands and want to check. Remember it — we come back to it."

### 5 · The buyer's world · `meera@genpharm.example`

**Say:** "Half this product belongs to the customer."

**Do:** Sign in as `meera@`. Note the navigation is *four items* — no producer
screens at all. Show the **Catalogue**: released lots only, each with its
certified value and expiry. Set a quantity, **Place order**.

### 6 · Dispatch, and the cold chain · `vikram@producer.example`

**Do:** Sign in as `vikram@` (dispatch). **Orders & dispatch** → advance the
order to `packed`, then `dispatched`. A courier and a **tracking reference**
attach as it goes.

**Do:** On a shipment, click **readings** and paste:

```
2026-08-25T09:00:00Z, 14.2
```

**Say:** "This material ships between two and eight degrees. That reading is
fourteen."

**Do:** **Record**. Read the confirmation aloud — it names a CAPA it raised.

**Say:** "Nobody had to notice that. The readings are data, not a PDF somebody
files, so an excursion can raise a corrective action by itself."

### 7 · The corrective action · `neha@producer.example`

**Do:** Sign in as `neha@` (quality). **Complaints & CAPA**. The CAPA dispatch
just raised is at the top — *Cold chain excursion*, open.

**Say:** "Dispatch cannot even open this screen. Quality can. The system carried
it across."

**Do:** **Move to Investigating**, give a reason, sign. Then expand
**History** — the move is there with who, when, why, and that it was signed.

**Say:** "Every move records its reason. A CAPA is closed with its reasoning, and
never deleted."

### 8 · The recall · `admin@producer.example`

**Do:** **Projects → PRJ-0412 →** a lot with a certificate → **Issues &
reissue** → **Withdraw issue #1…**, give a reason, withdraw.

**Say:** "And every laboratory holding that material is told — the panel lists
who was notified, and who could not be reached."

### 9 · Anyone can check · signed out

**Do:** Open <https://singhaditya21.github.io/Lotmark/verify> in a new tab and
type `CRT-2041`. Green: **current**, with the assay, the expiry, the producer.

Then open the recall page:

```
https://singhaditya21.github.io/Lotmark/verify/p5Sl5-u5OXZ5Snb-7gDAIjiD
```

Red: **WITHDRAWN — do not rely on this certificate**, with the reason.

**Say:** "No account, no login. An assessor holding a printed certificate should
not need a login from the producer whose certificate is in question."

### 10 · Proving it · `neha@` or `admin@`

**Do:** **Audit ledger**. Scroll — everything from the last ten minutes is
there, under the person who did it. Click **Verify the chain**.

**Say:** "Every entry is hash-linked to the one before it under a key held
outside the database. Removing or altering one breaks every link that follows."

**Do:** **Conformance**. Click the **with a gap** count to isolate them.

**Say:** "Nothing here rounds a gap up to a pass. Status is what the code
enforces; evidence is what the records currently show — and they are reported
separately, because they can disagree. That disagreement is the finding."

### 11 · Configuration is signed too · `admin@`

**Do:** **Configuration**. A draft is waiting with two real changes. **Review and
publish the draft → Sign and publish**, complete the ceremony.

**Say:** "Version two is now active, version one superseded, and it is in the
ledger. Which is what makes *under what rules was this certificate issued*
answerable years later."

### 12 · Close on the thing they did not expect

Pick whichever fits the room:

- **Low-code** — **Form designer**: add a field, watch the preview (that is the
  real record renderer, not a mock-up). **Flow designer**: the state machines the
  server actually enforces. "This is configuration, not a change request."
- **Multi-tenant** — demo bar → **Switch to Aurora Standards Ltd**. Same
  platform, a different producer, fully isolated.
- **⌘K** — press it, type `NCR` or `CRT`. "Everything here is cited by a code.
  This goes straight to the record."

---

## Shorter versions

**Three minutes** — steps 2, 4 and 9. The ceremony, the release, and the public
recall page. That is the product in three beats.

**Six minutes** — steps 1, 2, 3, 6, 7, 9. Skips configuration, conformance and
the designers; keeps the causal chain from signature to excursion to recall.

**Fifteen minutes** — the full walkthrough plus all three closers in step 12.

---

## Questions you will be asked

**"Is this a real product or a prototype?"**
The screens, navigation, validation, guards and the signing ceremony are the
real application. What is behind them on this link is a recording: responses
captured from the real API by driving it, so the shapes are correct by
construction. The full stack — Fastify, PostgreSQL with row-level security,
the signing service — runs locally.

**"Does anything persist?"**
Within your browser tab, yes: sign a study, switch persona, it is still signed.
Close the tab and it starts fresh. **Reset** clears it deliberately.

**"Is the audit chain really hash-linked?"**
In the product, yes — HMAC-SHA256 over each entry linked to the one before,
under a key held outside the database, and the verifier recomputes it. On this
static demo the *verification result* is a captured one; the ledger you see
growing as you click is real behaviour, computed in the browser.

**"Can I have the certificate PDF?"**
The product renders a signed PDF/A with the verification address printed on it.
On this demo, **Download this record** hands you the same facts as JSON — there
is no server to render a PDF.

**"Two producers — is that really isolated?"**
In the product, row-level security in PostgreSQL, enforced for a non-superuser
role, with tests that fail if a query can see another tenant's rows. On this
demo the second producer is a projection of the recorded one, so you can see
what isolation *looks like* without a second database.

**"What is not built?"**
Say it plainly — the conformance screen already does. Subcontracting is declared
and not enforced; key custody is honest about running from a development file
rather than an HSM. Open **Conformance** and show them. It is more persuasive
than a claim that everything is green.

---

## If something goes wrong

| Symptom | Do this |
|---|---|
| A dialog is stuck, or state looks wrong | **Reset** in the demo bar — no reload, no re-login |
| A signature is refused | The signing session lapsed. Complete the ceremony again; it lasts a few minutes |
| A screen looks empty | Check which persona you are — most screens are scoped, and empty is often correct |
| The navigation wraps to two lines | Widen the window; the full producer nav wants ~1600 px |
| A `/verify/…` link 404s in a checker | Expected. The static host returns 404 and serves the app, which routes it — it renders correctly in a browser |
