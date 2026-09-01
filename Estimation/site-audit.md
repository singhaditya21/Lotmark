# ipc.gov.in — source-state audit

Measured directly against the live site, not inferred. Every figure here came
from a request made while writing this; re-run the commands in
[`inventory/`](inventory/) to refresh them.

**Audited:** September 2026 · **Method:** HTTP probing and a bounded crawl from
the homepage navigation plus twelve section pages.

---

## 1 · Platform

| | |
|---|---|
| CMS | **Joomla** — `lang="en-gb"`, `<meta name="author" content="Super User">`, `/404-page-not-found.html` |
| Web server | **Apache**, **HTTP/1.1** |
| Character set | **ISO-8859-1** |
| TLS | Present, with HSTS `max-age=31536000; includeSubDomains` |

Two of these are load-bearing for the migration.

**ISO-8859-1 cannot represent Devanagari.** A Latin-1 site serving Hindi is
relying on the browser overriding the declared charset. Any content migration
must transcode to UTF-8 and be verified character-by-character on the Hindi
pages, not spot-checked.

**HTTP/1.1** means no multiplexing — every asset is a serialised round trip.
india.gov.in is on HTTP/2.

## 1a · Hosting and DNS — the finding that reframes the project

| | ipc.gov.in | www.india.gov.in |
|---|---|---|
| A record | `164.100.112.224` | `23.195.105.66` |
| Network | **NICNET, INDIA** — allocation `NDC-PUNE` | **Akamai** (`edgesuite.net`) |
| Nameservers | `ns1/ns2/ns7/ns10.nic.in` | `ns1/ns2/ns7/ns10.nic.in` |

**ipc.gov.in is already inside NIC.** It resolves into `164.100.0.0/16`, which
WHOIS identifies as NICNET, and the specific allocation is the National Data
Centre at Pune. Its DNS is already served by NIC's nameservers — the same ones
india.gov.in uses.

This changes what the project is. "Migrating ipc.gov.in to the india.gov.in
setup" is **not** an infrastructure move: the domain does not change registrar,
DNS does not move, and the site is not leaving government hosting for it. What
is actually being proposed is a **platform and standards migration** — retiring
a legacy Joomla build in favour of the current NIC standard stack and template,
and meeting the compliance bar that goes with it.

The practical consequences are large and mostly favourable:

- **No domain or DNS transfer**, so an entire class of migration risk —
  registrar delays, propagation, mail disruption — does not arise.
- **No hosting procurement.** The relationship with NIC exists; this is a change
  of platform within it, not a new tenancy.
- The one infrastructure gap worth noting is the **CDN**. india.gov.in is fronted
  by Akamai; ipc.gov.in is served directly from Pune. That difference accounts
  for a good deal of the performance gap and is separable from the CMS work.

Anyone costing this as a "website migration" in the commercial sense — new
hosting, new domain, data-centre cutover — is costing the wrong project.

## 2 · Crawlability — the significant gap

| Check | ipc.gov.in | india.gov.in |
|---|---|---|
| `robots.txt` | **absent** — returns the 404 page | present (`Allow: /*`, `Crawl-delay: 10`) |
| `sitemap.xml` | **absent** — returns the 404 page | present, **55 URLs**, with `lastmod` |
| Missing page | **HTTP 200** (soft-404) | proper status |

The soft-404 is the one to fix first, and it is worse than it looks. Because
`https://ipc.gov.in/anything-at-all` answers **200 OK** with the "page not
found" body:

- Search engines index unlimited junk URLs as real pages.
- **Any crawl-based inventory is unreliable** — a link typo produces a "valid"
  page rather than an error. Every URL list in this folder was therefore built
  from links actually present in the markup, never from guessed paths.
- Link-checking tools report a clean site while links are broken.

There is no authoritative list of what this website contains. Building one is
the first real task of the migration, and §5 of the plan says how.

## 3 · Security headers

Present and correct: `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN`,
`X-Content-Type-Options: nosniff`.

The Content-Security-Policy is present but **not doing meaningful work**:

```
script-src 'self' * 'unsafe-inline' 'unsafe-eval'
```

A wildcard source combined with `unsafe-inline` and `unsafe-eval` permits script
from any origin, inline handlers, and `eval()` — which is approximately the
policy you would get with no CSP at all. Compare india.gov.in, which allowlists
named hosts and adds `object-src 'none'`, `base-uri 'self'` and
`form-action 'self'`.

This will be raised at a CERT-In empanelled security audit. It is cheap to fix
on a new platform and awkward to fix on an old Joomla theme with inline script
throughout.

> Worth noting in passing: india.gov.in emits `x-content-type-options: no sniff`
> — with a space. The valid token is `nosniff`, so that particular header is
> inert on the reference site too. Do not copy it.

## 4 · Content inventory

195 URLs discovered — see [`inventory/ipc-gov-in-urls.tsv`](inventory/ipc-gov-in-urls.tsv).

| Section | URLs |
|---|---:|
| `mandates` | 62 |
| `about-us` | 55 |
| `news-highlights` | 32 |
| `images` | 6 |
| `e-services` | 5 |
| `rti`, `employees-corner` | 3 each |
| `related-website-links`, `orders-circulars-notices`, `careers` | 2 each |
| standalone (`tenders`, `faq`, `shop`, `icmed-certification`, `pharmacopoeial-harmonization`, `covid-19-updates`, `PvPI`) | 1 each |

**Depth:** 1 level 26 · 2 levels 65 · **3 levels 88** · 4 levels 14.

The hierarchy is deep and the URLs are Joomla-shaped — `.html`-suffixed and
carrying their whole ancestry, e.g.

```
/about-us/departments/quality-assurance/proficiency-testing-division.html
```

Every one of these changes under any new platform. Redirect mapping is not a
tidying task at the end; it is a deliverable in its own right (§5).

## 5 · Bilingual coverage — the biggest single gap

| Language | Pages | Share |
|---|---:|---:|
| English | 183 | **94%** |
| Hindi (`/hi/`) | **12** | **6%** |

Only twelve Hindi pages exist, and they are the shallow ones — home,
news-highlights, employees-corner and their like. The department pages, the
mandates, the technical content: English only.

GIGW treats bilingual content as an obligation rather than an enhancement, so
this is not a defect the migration inherits quietly — it converts into a
**translation programme of roughly 170 pages**, and that is likely to be the
largest line item in the whole estimate. It is also the one most easily missed
when costing "a website migration", because the page count looks like 195 when
the work is nearer 195 + 170.

## 6 · Applications, not pages

Three sections are almost certainly applications with their own data and
sessions, not content to be copied:

- **`/e-services`** (5 URLs)
- **`/shop`** — a storefront
- **`/PvPI/`** — Pharmacovigilance Programme of India, which appears to be a
  distinct sub-site

These must be scoped separately. A content-migration estimate that silently
includes them will be wrong by a large multiple. Confirm with the department
what each one is, who operates it, and whether it moves, stays, or is replaced.

## 7 · What this audit could not establish from outside

> **Since this was written, deeper research revised the scale.** The real
> surface is approximately **1,787 HTML paths and 2,519 PDFs across four
> hostnames** — about ten times what the navigation exposes. Two estates are
> invisible from the homepage: the **PvPI** section and an eight-year
> news archive of ~858 pages, plus legacy `/~ajeet/` tilde directories and
> ASP-era `/writereaddata/` paths. The 195 figure below is the mega-menu, and
> is retained because it is what a homepage crawl honestly yields — which is
> exactly the trap this section warns about. See
> [`migration-plan.md` §4](migration-plan.md).

- **Page count is a floor, not a total.** 195 is what is reachable from the
  navigation. Orphaned pages, archived news beyond the visible listing, and
  anything behind `employees-corner` are not counted.
- **Document volume is unknown.** Only six PDFs are linked from the homepage,
  but government sites of this kind typically hold hundreds across tenders,
  circulars and annual reports. This needs a server-side file listing.
- **No view of the CMS.** Template count, extension list, custom modules, editor
  workflow and user count all need Joomla administrator access.
- **No view of traffic.** Which pages actually matter — and therefore which
  redirects are critical — needs analytics or server logs.

These four unknowns are the difference between an estimate and a guess. They are
carried into the plan's open questions.
