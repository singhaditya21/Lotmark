# The estimate

Costing the plan in [`migration-plan.md`](migration-plan.md): retire IPC's legacy
Joomla site for the Gov.In CMS Platform and the DBIM standard.

**Basis date 1 September 2026.** Every quantity below was measured on that day
against the live source and the live destination. The model is in
[`model/`](model/) and reproduces: `python3 Estimation/model/simulate.py`.

---

## 0 · The answer

**A ₹20–30 lakh budget buys Stage 1 — remediate the live site and produce the
signed inventory and redirect map. It does not buy the migration.**

| | Person-days (P80) | Ex-GST | Inc-GST |
|---|---:|---:|---:|
| **Stage 1 · Remediate and baseline** ← **the recommendation** | **179** | **₹23.88 L** | **₹28.18 L** |
| Stage 2 · Migrate, audit, cut over | 207 | ₹27.76 L | ₹32.75 L |
| Stage 1 + 2 together | 406 | ₹53.10 L | ₹62.66 L |
| Priced options (not in either stage) | 621 | ₹58.16 L | ₹68.63 L |

The combined row is not the sum of the two above it: Stage 1 + 2 is its own
simulation run, sampling both risk sets in the same iterations and carrying
pass-through once rather than twice.

Boutique/specialist rates, 15% margin, P80. **8 named people, 1.55 average
FTE, 5.5 months.** The full envelope test is §7.

**One thing to settle before bidding:** IPC's own last IT tender demanded ISO
9001, ISO 27000 and CMMI Level 3, which excludes the boutique tier that makes
₹20–30 lakh work at all. §10 sets out three ways to resolve that — and one of
them expires on 30 September 2026.

That ₹20–30 lakh happens to buy exactly the engagement the plan already
recommends as the first contract — because §7 of the plan refuses to cost the
migration until Stage 1's inventory exists. **This is not a coincidence
engineered to fit the budget; it is what the evidence supports.** Stage 2's
figure above is indicative and should be re-derived from Stage 1's output, not
committed to now.

---

## 1 · What changed since the plan was written

Twelve measurements taken on 1 September 2026 against the live destination and
source. Four of them change the shape of the programme, not just its size.

### The destination has no bulk import

The Gov.In CMS Manual v1.0 (MeitY, May 2025, 95 pages) states that pages are
pre-defined containers that **can only be edited, not created**, and contains
zero occurrences of *bulk*, *import*, *CSV*, *slug* or *permalink* across
thirteen search terms. Every document is one hand-made post carrying six
mandatory fields — title, date, category, alt text, and a Hindi/English
bilingual flag.

**There is no migration pipeline to build, because there is nothing to build it
into.** Content volume converts directly into hand-keying. That moves the
largest line in the programme out of engineering and into an editorial decision
that only IPC can take.

### The reference implementation's answer to that was: migrate almost nothing

Measured from each tenant's own REST API:

| Tenant | Pages | Documents | Media |
|---|---:|---:|---:|
| MeitY | 50 | 334 | 6,653 |
| MSDE | 28 | 104 | 2,852 |
| **MoHFW** — IPC's own ministry | **28** | **0** | **10** |

MoHFW cut over between 5 and 11 April 2026. It carried across 28 layout pages,
ten media items and no documents at all. IPC's source estate is **1,084 content
items and 2,851 PDFs**.

Nobody on this platform has done what IPC would be asking to do. That is the
single most important commercial fact in this document, and it should be put to
the sponsor before anything is signed.

### Per-page redirects: the capability is there, the practice is not

The plan calls this "the single most important technical question in the
programme". It now has a split answer, and both halves matter.

- **Capability — yes.** `https://www.msde.gov.in/cms/wp-json/redirection/v1`
  returns HTTP 200 and enumerates twenty REST routes, including bulk import of a
  redirect map from file and export to CSV, Apache and nginx formats.
- **Practice — zero.** 201 real pre-migration URLs harvested from the Wayback
  index and re-requested live across mohfw, meity and msde returned **not one
  301**. Old URLs either hard-404 or return HTTP 200 carrying an empty shell.

So this stops being a technical risk and becomes a contractual one: the
mechanism exists and nobody has used it. Put redirect delivery in the contract
as an acceptance criterion with its own sign-off, exactly as the plan's §6 says.

### The destination reproduces IPC's own soft-404 defect

All four DBIM reference sites return **HTTP 200 for unmatched paths at depth 1
and depth 2**, and only a real 404 at depth 3.

```
mohfw.gov.in     depth1=200  depth2=200  depth3=404
meity.gov.in     depth1=200  depth2=200  depth3=404
msde.gov.in      depth1=200  depth2=200  depth3=404
rural.gov.in     depth1=200  depth2=200  depth3=404
```

Of IPC's discovered navigation paths, 26 sit at depth 1 and 65 at depth 2 — 47%
in the band where the destination answers 200 to anything. **The plan's Phase 5
exit criterion, "retired paths return 404/410, never 200", cannot be met on the
destination as it stands.** Package 0.9 exists to prove this and design the
origin-side status layer before anyone commits to that criterion.

### Six smaller corrections

| Finding | Effect on the estimate |
|---|---|
| Hindi on the platform appears to be **runtime Bhashini machine translation** — all four tenants ship a "Bhashini Disclaimer" page and none stores a Hindi page estate | Makes the translation programme *provisionally removable* under Option 3, pending written confirmation. Held at reduced probability, not struck |
| **DBIM Annexure G** is titled *"For Ministry/Departments not onboarded on gov.in CMS Platform"* | The 26-KPI feed is an Option 4 obligation. Moved out of Stage 2 |
| DBIM v3.0 mandates **no india.gov.in footer link** and never names Bhashini; the mandated footer is Website Policy, Sitemap, Related Links, Help, Feedback | Plan §5 Phase 1 overstates this as a DBIM mandate |
| **CCPS is binding on IPC** (§7.4, "all government organizations", Checklist-1 item 40) and the platform already ships the banner component | Configuration, not build |
| **Joomla 3.8.10 (June 2018) on PHP 7.4.33** — both end-of-life, and `joomla.xml` is publicly readable | "Harden in place" means patching an EOL CMS on an EOL runtime. Package 1.5 tripled; risk E13 added |
| **NIC is an accepted auditor** — GIGW 3.0 accepts clearance from "NIC, STQC or a CERT-In empanelled vendor" | Audit cost is bimodal (₹0 or lakhs), not a band. Answers plan question 7 |

### Two corrections I rejected

Both came from research agents and both would have removed real work from scope.

**"The site now serves UTF-8."** It does not. The HTTP header returns
`charset=iso-8859-1` on all six paths tested, stable across three requests each,
while the document meta declares UTF-8. The header wins. The plan's original
statement is correct and package 1.2 stays.

**"No DBIM site publishes a working sitemap."** `meity.gov.in/sitemap.xml`
serves a real 50-URL XML sitemap; the agent had not followed the redirect to
`www.`. The narrower true claim is that one of four tenants has a sitemap and
none carries a `Sitemap:` directive in robots.txt.

---

## 2 · The quantities

Independently re-measured, superseding the 195-URL navigation inventory in
[`site-audit.md`](site-audit.md), which was always labelled a floor.

| Quantity | Measured | Method |
|---|---:|---|
| Live HTML paths | **1,727** | Wayback CDX ∪ live BFS crawl ∪ Common Crawl, two-signal validated, de-duplicated |
| — English | 1,322 | Plus 16 legacy `/~ajeet/` paths |
| — Hindi | 389 | Only ~79–86 genuinely translated; the rest are English under a Hindi URL |
| **Content items** | **1,084** | Joomla article-ID sweep, corroborated by 1,051 distinct titles (agree within 3%) |
| Duplicate-route surplus | **676** | URLs sharing a title with another URL — redirect work, not authoring work |
| Stub articles (<30 words) | **253** (23%) | Body word count; median article is 52.5 words |
| Live PDFs | **2,758** | 3,256 candidates probed with ranged requests, Content-Type validated |
| Hindi pages declaring `lang="hi"` | **0** | All 389 declare `en-gb` — a WCAG 3.1.1 failure |
| Distinct page templates | **9** | Layout-class fingerprinting; one template covers 83% of pages |
| Hostname families | **4** | Only `ipc.gov.in` is on NICNET; `iponline` and `onlinestore` are on AWS |

The first measurement pass reported 1,906 / 2,851 / 497. An adversarial re-count
found percent-encoding variants of the same URL being counted as distinct paths.
Re-deriving from the committed raw inventory reproduces the corrected figures
exactly — 1,906 HTML rows collapse to 1,727 under unquote-and-casefold, 2,851
PDFs to 2,758, and the Hindi tree from 497 to 389. The de-duplicated figures are
what the model uses. The 1,084 item count is unaffected: it comes from the
article-ID oracle, not from URL enumeration.

The full row-level inventory —
[`inventory/ipc-live-inventory-2026-09-01.tsv`](inventory/ipc-live-inventory-2026-09-01.tsv),
4,757 rows with path, type, language tree, template and title — is committed. It
is a preview of what Stage 1 delivers, not a substitute for it: it has no
disposition column, no owner, and no reconciliation against the Joomla database.

**The three quantities drive three different lines, and conflating them is how
this estimate would go wrong:**

- **Authoring scales with items** — 1,084, nearly a quarter of them PDF stubs.
- **Redirect work scales with URLs** — 1,727, and rows will exceed paths. (The
  circulating GOV.UK "12 redirects per page" ratio did not survive audit; the
  direction holds, the magnitude is unknown.)
- **Accessibility scales with templates** — 9, one covering 83%.

Costing 1,727 as "pages to author" would overstate the content line by about
60%. The gap between 1,727 URLs and 1,084 items is 676 duplicate routes to the
same article: redirect work, not authoring work.

**Two rates are deliberately left unpriced.** The published per-document PDF
remediation figures did not survive audit, and neither did the redirect
rows-per-path ratio. A one-day sample of 30–50 of IPC's own PDFs would settle
the first and is the cheapest uncertainty reduction available anywhere in this
programme.

---

## 3 · Method

Identical to the prior workbook's Confidence sheet, so the two are comparable.

- Three-point per package. Expected = (o + 4m + p) / 6; sigma = (p − o) / 6.
- **Beta-PERT** marginals, not normal: durations are bounded below and
  right-skewed, and a normal both understates the upper tail and permits
  negative durations.
- Correlated through a **single-factor Gaussian copula** at ρ = 0.5 — one team,
  one client, one set of ambiguities. Sensitivity in §5.
- Exogenous risks sampled **inside each iteration**, never added to a percentile
  afterwards. A mean plus a percentile is neither.
- 100,000 iterations, seed 20260901, reproducible.

Client effort is tracked but never billed: **40–70 person-days of IPC
subject-matter time** for triage sign-off. Published evidence puts 60–80% of
content audit on the client side, and an under-resourced client is a schedule
risk that first presents itself as a cost saving.

---

## 4 · Work breakdown — Stage 1

The recommended scope. Four packages are handed to IPC and NIC rather than
bought; they are listed and struck, not silently dropped.

### Phase 0 · Mandate and decisions — 22.4 PD

| Ref | Package | O | M | P | Exp |
|---|---|---:|---:|---:|---:|
| 0.1 | Correct the brief; re-issue the objective in writing | 2 | 3 | 6 | 3.3 |
| 0.2 | Gov.In CMS intake via the MoHFW CIO route | 3 | 5 | 11 | 5.7 |
| ~~0.3~~ | ~~Governance: WIM, CIO/Tech SPOC, RACI~~ | | | | *IPC* |
| 0.4 | registry.gov.in control and DNS readiness | 1 | 2 | 4 | 2.2 |
| 0.5 | Security-audit route settled in writing | 1 | 2 | 4 | 2.2 |
| 0.6 | Redirect-capability determination | 2 | 3 | 7 | 3.5 |
| ~~0.7~~ | ~~S3WaaS eligibility ruled in or out~~ | | | | *IPC* |
| 0.8 | DBIM logo lockup 3A/3B determination | 0.5 | 1 | 2 | 1.1 |
| 0.9 | Destination status-code behaviour proven; origin status layer designed | 2 | 4 | 9 | 4.5 |

### Phase 1 · Emergency remediation — 18.2 PD

Destination-independent. None of it is wasted whichever target wins.

| Ref | Package | O | M | P | Exp |
|---|---|---:|---:|---:|---:|
| 1.1 | Real HTTP 404: error-document status, not a 302 to a 200 page | 1.5 | 3 | 7 | 3.4 |
| 1.2 | Charset: header says iso-8859-1 over 497 Hindi pages | 2 | 4 | 9 | 4.5 |
| ~~1.3~~ | ~~Stale branding removal and content review sweep~~ | | | | *IPC* |
| 1.4 | GIGW policy pages and portal links — DBIM mandates no india.gov.in link | 1 | 2 | 4 | 2.2 |
| ~~1.5~~ | ~~Joomla/PHP EOL patch path~~ | | | | *NIC* |
| 1.6 | robots.txt and a stopgap sitemap | 0.5 | 1 | 2 | 1.1 |
| 1.7 | CSP hardening on the live site | 2 | 4 | 10 | 4.7 |
| 1.8 | `lang="hi"` across 497 pages; close the joomla.xml disclosure | 1 | 2 | 5 | 2.3 |

### Phase 2 · Inventory, triage and the redirect map — 60.7 PD

The deliverable that makes Stage 2 costable. This is the majority of the value.

| Ref | Package | O | M | P | Exp |
|---|---|---:|---:|---:|---:|
| 2.1 | Joomla database extraction and reconciliation | 2 | 4 | 10 | 4.7 |
| 2.2 | Live crawl with the two-signal validator | 3 | 5 | 10 | 5.5 |
| 2.3 | Wayback / Common Crawl orphan recovery | 2 | 3 | 7 | 3.5 |
| 2.4 | Search Console traffic overlay | 1 | 2 | 4 | 2.2 |
| 2.5 | Union of four sources into one authoritative register | 2 | 3 | 7 | 3.5 |
| 2.6 | Triage facilitation — keep / archive / retire | 6 | 10 | 20 | 11.0 |
| 2.7 | PDF estate inventory and disposition (~2,851 documents) | 5 | 8 | 18 | 9.2 |
| 2.8 | Redirect map — ~1,906 source paths; rows exceed paths | 10 | 16 | 32 | 17.7 |
| 2.9 | Hindi pairing by hreflang; bilingual gap quantified | 2 | 3 | 7 | 3.5 |

### Programme management — 29.3 PD

| Ref | Package | O | M | P | Exp |
|---|---|---:|---:|---:|---:|
| P.1a | Programme and delivery management | 8 | 13 | 24 | 14.0 |
| P.2a | Business analysis and content governance | 5 | 8 | 15 | 8.7 |
| P.3a | Documentation, SOPs and the Stage 2 cost baseline | 4 | 6 | 12 | 6.7 |

**Stage 1 lean: 130.6 PD expected + 26.8 PD risk EMV.**

Stage 2 (24 packages, 151.0 PD expected) and the seven priced options (533.2 PD
expected) are in [`model/wbs.json`](model/wbs.json) at the same fidelity.

---

## 5 · Confidence

| | P50 | P70 | P80 | P90 | P95 |
|---|---:|---:|---:|---:|---:|
| **Stage 1 (lean)** | 156 | 170 | **179** | 191 | 201 |
| Stage 1 (full scope) | 177 | 193 | 202 | 216 | 227 |
| Stage 2 | 179 | 196 | 207 | 222 | 234 |
| Options | 525 | — | 621 | 673 | — |

**Bid at P80.** P50 is even odds and nobody should quote it. P90 is for when
liquidated damages bite hard and the schedule cannot move.

Correlation sensitivity — the assumption is visible rather than buried:

| ρ | P50 | P80 | P90 | Reading |
|---|---:|---:|---:|---|
| 0.0 | 178 | 191 | 197 | Independent packages. Unrealistic. |
| 0.3 | 177 | 198 | 210 | Weak common cause. |
| **0.5** | **177** | **203** | **216** | **Recommended.** One team, one client. |
| 0.7 | 176 | 206 | 222 | Use if requirements are unfrozen at award. |

**Where the uncertainty actually lives** (share of Stage 1 variance):

| Share | Package |
|---:|---|
| 23.2% | 2.8 · Redirect map |
| 12.6% | P.1a · Programme management |
| 12.0% | 1.5 · Joomla/PHP EOL |
| 9.5% | 2.6 · Triage facilitation |
| 7.8% | 2.7 · PDF estate |

Nearly a quarter of the spread is one package. A day spent agreeing the redirect
convention at kickoff is worth more than a week of estimating discipline
anywhere else.

---

## 6 · Rate card, resource levels and counts

Role rates are the mid-tier reference, consistent with the prior workbook so the
two documents can be read together. **The blended rate is an output of the role
mix in the packages, not an input** — change the mix and it moves.

| Ref | Role | ₹/PD | PD | Avg FTE | Heads | Shape |
|---|---|---:|---:|---:|---:|---|
| ME | Migration Engineer | 12,000 | 65.9 | 0.57 | 1 | Continuous — the core of the team |
| BA | Content Strategist / Business Analyst | 13,000 | 55.1 | 0.48 | 1 | Continuous |
| EL | Engagement Lead / Programme Manager | 22,000 | 29.7 | 0.26 | 1 | ~1.5 days/week |
| SA | Solution Architect — Gov.In CMS / DBIM | 24,000 | 12.4 | 0.11 | 1 | Called in |
| SE | Security Engineer | 20,000 | 7.1 | 0.06 | 1 | Called in |
| QA | QA Engineer | 9,500 | 3.9 | 0.03 | 1 | Called in |
| CO | Content Operations | 7,500 | 3.4 | 0.03 | 1 | Called in |
| AX | Accessibility Specialist | 15,000 | 1.3 | 0.01 | 1 | Called in |
| | **Total (P80)** | | **178.8** | **1.55** | **8** | over 5.5 months |

Eight named people, an average of 1.55 FTE, a peak near 3. Two roles carry 68%
of the effort; the other six are specialists called in for days, not months.

**The scarce skill is SA.** Twelve days of Gov.In CMS and DBIM knowledge is the
whole reason to hire outside — everything else IPC could plausibly staff or
train. If that person is not available, the engagement does not work at this
price.

Stage 2, for comparison: the same eight roles, 207 PD over 9 months, 1.16
average FTE — a longer, thinner engagement with security and accessibility rising
from cameo to substantial.

---

## 7 · The envelope test

The same work costs different amounts from different suppliers, so tier is a
real lever and not a fudge factor. Multipliers are the prior workbook's own.

Stage 1 lean, contract value in ₹ lakh:

| Tier | Margin | P50 ex-GST | **P80 ex-GST** | P80 inc-GST | P90 ex-GST |
|---|---:|---:|---:|---:|---:|
| **T1 · Boutique/specialist** | **15%** | 21.00 ✅ | **23.88** ✅ | **28.18** ✅ | 25.45 ✅ |
| T1 · Boutique/specialist | 20% | 22.31 ✅ | 25.38 ✅ | 29.94 ✅ | 27.04 ✅ |
| T2 · Mid-tier SI | 15% | 28.71 ✅ | 32.71 | 38.60 | 34.88 |
| T3 · Tier-1 SI | 15% | 39.72 | 45.33 | 53.49 | 48.37 |

**T1 is the only tier that fits ₹20–30 lakh at the bid percentile.** At mid-tier
rates the same scope is ₹32.7 lakh; at Tier-1, ₹45.3 lakh — and mid-tier fits
only at P50, which is even odds and not a basis anyone should bid. If the procurement route forces a large
supplier, the budget does not buy this scope and the honest response is to say
so at the outset rather than descope quietly during delivery.

**Recommended bid basis: T1, 15% margin, P80 — ₹23.88 lakh ex-GST, ₹28.18 lakh
inclusive of GST.** Inside the envelope on both readings, with ₹1.8 lakh of
headroom against the ceiling if the envelope is read inclusive of tax.

Build-up at that point: 179 PD × ₹10,800 blended = ₹19.30 L effort + ₹1.00 L
pass-through = ₹20.30 L cost → ₹23.88 L ex-GST → ₹28.18 L inclusive.

---

## 8 · Pass-through and statutory costs

Stage 1 carries ₹0.6 / 1.0 / 1.8 lakh: crawl and validation tooling, a
commercial rank and traffic data pull, and the IDN. Everything else falls in
Stage 2 or the options, and most of it genuinely cannot be priced yet.

| Item | Position | Basis |
|---|---|---|
| `.सरकार.भारत` IDN | **₹0** | registry.gov.in FAQ: no fee for registration or renewal under GOV.IN. Note the government IDN is at the third level, `.सरकार.भारत`, not plain `.भारत` |
| Gov.In CMS / NIC hosting | **Unpriced in both directions** | The CMS Manual is operational only. No published tariff and no published statement that it is free. A genuine void, not a gap in searching |
| Security audit | **Bimodal: ₹0 or lakhs** | GIGW 3.0 accepts NIC, STQC *or* a CERT-In empanelled vendor. If NIC performs it, this line is zero. If procured, no Indian government body publishes a VAPT rate card — 143 empanelled organisations, priced by quotation |
| STQC Certified Quality Website | **No GIGW 3.0 fee is published** | The circulating ₹10,000 + ₹30,000 + ₹10,000 is real and still served, but its own §6.1 scopes it to *"GIGW version 2009 (L1)"* and 87 test points. Quoting ₹40,000 for this programme quotes an eight-year-old price for a superseded standard |
| IAAP Certified Auditor Review | **New mandatory gate** | STQC OM F.No. STQC/IT&eGov/WQC/2022 dated 30.06.2025 makes it a pre-requisite for GIGW evaluation. Absent from the plan; added as option X.6. Commencement language is equivocal — confirm before relying on the date |
| Hindi translation | **Rate, not a total** | Volume is unknowable until Stage 1. The National Translation Mission's published GoI schedule (₹0.50–1.00/word, 2020) is a scholar honorarium roughly a quarter of market — using it would gut the largest line. Carry ₹1.00 / 2.50 / 6.00 per word |
| Bhashini | **Not free for production** | The official developer documentation states API usage "shall be for the purposes of PoC only". Production pricing unpublished. `bhashini.ai` is a separate commercial site — its prices are not the platform's |

Throughput note for scheduling: 150 valid CQW certificates existed at
20.01.2026, of which 46 under GIGW 3.0 since 29.11.2024 — roughly 3.3 per month
nationally across all STQC laboratories.

---

## 9 · What would change this number

Ordered by how much they move it. Each needs a named owner and a date.

| Question | Swing | Why |
|---|---|---|
| **How much content actually survives triage?** | **The whole programme** | MoHFW's answer was 28 pages and no documents. IPC's source is 1,084 items and 2,851 PDFs. There is no bulk import, so every surviving item is hand-keyed |
| Does IPC staff the authoring, or does the supplier? | **+60 to +190 PD** | Option X.7. Excluded here on the assumption IPC's editors author |
| Are the ~2,851 PDFs loaded, tiered, or declared? | **+60 to +190 PD** | Option X.8. One hand-made post each, six mandatory fields |
| Will MoHFW's CIO schedule onboarding in writing? | Gates everything | No published intake form, queue, timeline or price |
| Does IPC accept runtime Bhashini for Hindi? | −40 to −160 PD | Deletes the translation programme under Option 3 |
| Do the applications come into scope? | +60 to +280 PD | `/shop` is a live OpenCart storefront (re-verified 1 Sep 2026); `iponline` and `onlinestore` are a DSpace/JSPUI estate on AWS |
| NIC audit or procured auditor? | ₹0 or lakhs | Bimodal, not a band |
| Is the Joomla database available? | ±8 PD and inventory quality | Without it there is no authoritative published/unpublished distinction |
| Is STQC certification in scope? | +20 to +60 PD and an unpriced fee | Plus the IAAP gate ahead of it |
| **Which supplier tier can actually bid?** | **₹24 L → ₹33 L → ₹45 L** | IPC's own pre-qualification excludes boutiques. See §10 |
| What does per-document PDF remediation actually cost? | Up to ±500 PD on the options | Left unpriced; a one-day sample of 30–50 documents settles it |

**Do not spend the Stage 1 fee and then re-argue Stage 2 from opinion.** Package
P.3a exists to produce the Stage 2 cost baseline as a deliverable of Stage 1.

---

## 10 · Procurement — and a direct challenge to this estimate

IPC has already shown its hand. On **13 July 2026** it published
**GEM/2026/B/7781379** on GeM under *"Hiring of Agency for IT Projects —
Milestone basis"*: estimated value ₹15 lakh, QCBS 70:30, EMD at 4%, ePBG at 5%
for 60 months, six-year contract. Same buyer, same category, same commercial
shape a website programme would take.

### The tension you have to resolve

That bid's pre-qualification bar was **ISO 9001, ISO 27000, CMMI Level 3, at
least ten IT professionals on payroll, and ₹15 lakh minimum average annual
turnover.**

**That bar excludes the boutique tier this estimate is priced at** — and
boutique is the only tier that fits ₹20–30 lakh. CMMI Level 3 is not a
seven-person-firm credential. So the budget and IPC's own revealed procurement
standard are in tension, and it has to be resolved before anyone bids rather
than discovered at evaluation.

Three ways out, in order of preference:

1. **Procure Stage 1 as a consultancy assignment, not an IT project.** It is
   advisory and analytical work — an inventory, a triage register, a redirect
   map — and the Department of Expenditure's *Manual for Procurement of
   Consultancy Services* is the fitting instrument. Different category,
   proportionate pre-qualification.
2. **Use the NICSI route.** NICSI's Board-approved SOP allows a work order to
   empanelled agencies **without an open tender**. But the Application and
   Website Development panel — 28 vendors — **expires 30 September 2026**, four
   weeks from this basis date, with no successor tender visible. If this route is
   wanted, it is time-critical.
3. **Accept mid-tier and re-baseline the budget** to roughly ₹33 lakh ex-GST.

### The budget threshold is a governance boundary, and it favours two stages

IPC's own published bye-laws, Schedule I: the **Secretary-cum-Scientific
Director may sanction scheme expenditure up to ₹50 lakh**; above that it
escalates to the Chairman of the Governing Body (to ₹2 crore), and then the
Governing Body itself — which is chaired by the Secretary (Health & Family
Welfare), with a Standing Finance Committee chaired by MoHFW's Additional
Secretary (Health).

**A ₹20–30 lakh Stage 1 sits inside the Secretary's own sanction power. The
₹53 lakh full programme does not.** So the two-stage structure is not only the
right delivery sequence — it is the one that clears at the lowest governance
tier, which is very often the difference between starting this quarter and
starting next year.

### Calendar

The tender is not the long pole. IPC ran its last bid **11 days** from
publication to close (16 after a corrigendum) against a GeM floor of 10 clear
days — but gave itself **180 days of bid validity**, and that is the real award
window. Plan the governance chain, not the tender.

No NICSI rate card is in the public domain as of 1 September 2026, so the rate
card in §6 remains a constructed one rather than a published benchmark.

Primary sources for all of the above are committed under
[`sources/procurement/`](sources/procurement/).

---

## 11 · Timeline, milestones and payments

**76 weeks end to end:** Stage 1 W1–W24, a 12-week procurement gap, Stage 2
W37–W76. One workbook covers all of it —
[`IPC-Migration-Programme-Estimate.xlsx`](IPC-Migration-Programme-Estimate.xlsx),
ten sheets, regenerated by
[`model/build_programme.py`](model/build_programme.py) so it cannot drift from
the model.

```
       W1     W12    W24  │ gap │  W37    W48    W60    W72  W76
Ph 0   ██████████          │     │
Ph 1     ███████           │     │
Ph 2      ████████████████ │     │
Ph 3                       │     │  ████████████████
Ph 4                       │     │            ██████████
Ph 5                       │     │                  ████████
PMO    ████████████████████│     │  ██████████████████████████
        ◆M1  ◆M2 ◆M3 ◆M4 ◆M5 ◆M6 │  ◆N1  ◆N2    ◆N3  ◆N4 ◆N5 ◆N6
```

**Phase 2 starts in week 3, alongside Phase 1 rather than after it** — the
302-to-404 behaviour is a usable existence oracle, so the inventory is not
blocked on the 404 fix. That takes about six weeks off the plan's sequencing.

**The gap is drawn, not hidden.** Stage 2 cannot be procured until Stage 1
delivers the baseline that makes it costable. Twelve weeks is the planning
figure (range 8–16): IPC's last bid ran 11 days from publication to close but
carried 180 days of bid validity, and the governance chain — Secretary, then
Chairman of the Governing Body, then the Governing Body — is the long pole.

### Stage 1 · ₹2,388,290 ex-GST

| Ref | Week | Milestone | Share | Ex-GST |
|---|---:|---|---:|---:|
| **M1** | W2 | Mobilisation and inception report | 10% | ₹238,829 |
| **M2** | W8 | Live site remediated | 20% | ₹477,658 |
| **M3** | W12 | Platform decision pack | 15% | ₹358,244 |
| **M4** | W16 | Draft inventory: the union register | 20% | ₹477,658 |
| **M5** | W20 | Signed disposition register and redirect map | 25% | ₹597,072 |
| **M6** | W24 | Stage 2 cost baseline and handover | 10% | ₹238,829 |

### Stage 2 · ₹2,775,579 ex-GST — indicative, re-derive from M6

| Ref | Prog. week | Milestone | Share | Ex-GST |
|---|---:|---|---:|---:|
| **N1** | W40 | Mobilisation and platform tenancy live | 10% | ₹277,558 |
| **N2** | W46 | Information architecture and templates approved | 15% | ₹416,337 |
| **N3** | W58 | Content loaded and staging frozen | 25% | ₹693,895 |
| **N4** | W70 | Audit clearance certificate issued | 20% | ₹555,116 |
| **N5** | W73 | Cut-over complete and redirects asserted | 20% | ₹555,116 |
| **N6** | W76 | Hypercare complete and handover | 10% | ₹277,558 |

Every milestone pays against a checkable exit criterion, not a date. M2 is
closed by an assertion suite run in front of the client; M5 by an automated
check that every source path resolves to exactly one redirect row; N4 by the
audit clearance certificate naming the specific frozen instance; N5 by a
redirect assertion over every row **and** a post-cut-over mail delivery test,
because the one irreversible way to damage IPC during cut-over is to touch the
MX records.

**Cash flow.** Peak negative position **−₹7.14 lakh in week 8** on a four-week
payment lag — 30% of the Stage 1 contract. That is working capital, not margin.

**Percentiles do not add.** Stage 1 at P80 (179 PD)
plus Stage 2 at P80 (207 PD) is
386 PD, but a
joint run sampling both in the same iterations gives
**382 PD** — the stages diversify against
each other. They are priced as two contracts because that is how they would be
procured.

---

## 12 · What this supersedes

`docs/commercial/Lotmark_and_IPC_Estimate_v5.xlsx`, sheet **Effort - Website**
(67 modules, 1,849 PD expected, dated 18 August 2026) prices a **bespoke build**
of a full digital platform — CMS, AI layer, chatbot, forum, e-commerce
replatform — against a tender's Doc A and Doc B.

Under Gov.In CMS adoption roughly 584 PD of those 1,849 survive. But the
headline is misleading unless it is split, and the split is the point:

| | PD | What it is |
|---|---:|---|
| Platform or NIC supply | 444 | Genuinely free. Search, documents, gallery, video, menus, theme, translation |
| **Descope / out-of-boundary** | **586** | **Not a saving.** Forum, polls, calendar, recruitment, commerce, chatbot — absent from the platform, so each needs a sponsor decision to drop |
| QA and programme scaling | 160 | Follows the reduced build |
| Unattributed residual | 75 | Shown rather than swept into the bucket above |

That sheet also carries three baselines that no longer hold: it sized migration
at "~137 English menu pages" and "~1,500 items" against a measured 1,084 items
and 1,906 URLs; it did not know `ipc.gov.in` is already inside NICNET; and it
predates the February 2025 Gov.In standard entirely.

**It is not wrong so much as aimed elsewhere.** Read it for the module list and
the non-functional requirements; read this for what the migration costs.

---

## 13 · Reproducing the figures

```bash
python3 Estimation/model/simulate.py            # full report
python3 Estimation/model/simulate.py --json     # machine-readable
python3 Estimation/model/simulate.py --rho 0.7  # correlation sensitivity
```

| File | What |
|---|---|
| [`model/wbs.json`](model/wbs.json) | 62 packages, 13 exogenous risks, 8 roles, measured quantities |
| [`model/simulate.py`](model/simulate.py) | Beta-PERT + Gaussian copula, seeded at 20260901 |
| [`model/results.json`](model/results.json) | Last run, committed so figures here are checkable |
| [`model/schedule.json`](model/schedule.json) | Start/end weeks for both stages, twelve milestones with exit criteria, commercial terms, unpriced exclusions |
| [`model/build_programme.py`](model/build_programme.py) | Builds the whole-programme workbook from the model |
| [`model/prior-website-modules.json`](model/prior-website-modules.json) | The 67 superseded modules |

> **Standing of these numbers.** The quantities are measured and the method is
> reproducible. The rates are a defensible mixture of published benchmarks and
> stated judgement — content migration at 15–45 min/page is well evidenced;
> hand-decided redirect mapping has no published rate at all and is reasoned
> from the estate's own shape. No statutory fee here is a quote. Treat Stage 1
> as costable now and Stage 2 as indicative until Stage 1 delivers.
