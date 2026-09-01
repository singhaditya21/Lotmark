# Estimation

Research and planning for migrating **ipc.gov.in** — the Indian Pharmacopoeia
Commission's website — onto the current Government of India standard web setup.

Researched September 2026 against primary sources (NIC, MeitY, DBIM v3.0,
GIGW 3.0, S3WaaS, CERT-In, STQC) and by direct probing of the live sites.

| Document | What it is |
|---|---|
| [`estimate.md`](estimate.md) | **The estimate** — what it costs, who does it, and what a ₹20–30 lakh budget actually buys |
| [`IPC-Migration-Programme-Estimate.xlsx`](IPC-Migration-Programme-Estimate.xlsx) | **The workbook** — all three stages: timeline, twelve milestones, payments, cash flow, resourcing, options and confidence |
| [`model/`](model/) | The effort model: 62 work packages, a seeded Monte Carlo, and the builder that generates the workbook |
| [`migration-plan.md`](migration-plan.md) | The plan — target-state options, a recommendation, seven phases with exit criteria, risks, and the questions that must be answered before anything is costed |
| [`site-audit.md`](site-audit.md) | Measured source state of ipc.gov.in: platform, hosting, crawlability, security headers, content inventory, bilingual coverage |
| [`inventory/ipc-gov-in-urls.tsv`](inventory/ipc-gov-in-urls.tsv) | 195 URLs discovered from the navigation, with section, depth, language and type |
| [`inventory/india-gov-in-sitemap-urls.txt`](inventory/india-gov-in-sitemap-urls.txt) | The 55 URLs in india.gov.in's published sitemap |

## The answer, if you read nothing else

**₹20–30 lakh buys Stage 1: remediate the live site, and produce the signed
inventory and redirect map. It does not buy the migration.** That is 179
person-days at P80 — ₹23.88 lakh excluding GST — delivered by eight named people
averaging 1.55 FTE over 5.5 months. The full migration is roughly ₹53 lakh, and
the priced options beyond it another ₹58 lakh.

Stage 1 is also what the plan independently recommends as the first contract,
because it refuses to cost the migration until the inventory exists. And it sits
inside the Secretary-cum-Scientific Director's own ₹50 lakh sanction power,
where the ₹53 lakh full programme would escalate to the Governing Body.

**Before bidding, settle one thing:** IPC's own last IT tender demanded ISO 9001,
ISO 27000 and CMMI Level 3 — a bar that excludes the boutique tier which makes
₹20–30 lakh possible. See [`estimate.md` §10](estimate.md).

## The three findings that matter most

**1 · The brief names the wrong destination.** india.gov.in is the National
Portal — a catalogue whose own *About Us* says content "is owned and managed by
the respective Ministries and Departments." No department's pages move into it.
The real destination is **DBIM + the Gov.In CMS Platform**, the standard since
February 2025, which IPC's own ministry (`mohfw.gov.in`) has already adopted.

**2 · IPC is already on NIC.** `ipc.gov.in` resolves into `164.100.0.0/16` —
NICNET, allocation NDC-PUNE — on NIC nameservers. There is no hosting to
procure, no domain to transfer, no DNS to move. This is a platform and
standards migration, not an infrastructure one, and costing it as the latter
prices the wrong project.

**3 · The site is roughly ten times larger than its menu suggests.** The
navigation exposes 195 pages; measured, the estate is **1,906 live HTML paths
and 2,851 PDFs across four hostnames**. But the number that drives authoring is
**1,084 content items** — the rest are duplicate routes to the same article, and
that is redirect work, not authoring work.

**And a fourth, found while costing it:** the destination has **no bulk import**.
MoHFW's own migration onto this platform carried across 28 pages and no
documents at all. Content volume converts directly into hand-keying, which makes
triage the whole project rather than a tidying step.

## Two defects worth fixing this month, whatever is decided

- **Every missing page returns HTTP 200.** `ipc.gov.in/anything-at-all` answers
  200 OK with the "not found" body, so search engines index junk, link checkers
  report a clean site, and no crawl-based inventory can be trusted.
- **The charset is ISO-8859-1**, which cannot represent Devanagari — the Hindi
  pages render only because browsers override the declared encoding.

Both are cheap, both are destination-independent, and the first one blocks the
inventory that everything else depends on.

## Reproducing the measurements

```bash
# Crawlability
curl -sI https://ipc.gov.in/sitemap.xml          # returns the 404 page
curl -so /dev/null -w '%{http_code}\n' \
     https://ipc.gov.in/this-does-not-exist-xyz  # 200 — the soft-404

# Hosting
dig +short ipc.gov.in A | tail -1 | xargs whois | grep -i netname
dig +short ipc.gov.in NS
```

> **Scope note.** This folder is desk research from outside the organisation.
> The estimate's quantities are measured and its method is reproducible; its
> rates are a mixture of published benchmarks and stated judgement, and no
> statutory fee in it is a quote.
> It has no access to the Joomla database, the CMS, server logs or analytics,
> and the plan says where each of those gaps changes the answer. Treat the page
> and document counts as floors with a stated method, not as an audited total.
