# ipc.gov.in → the Government of India standard web setup

A migration plan for the Indian Pharmacopoeia Commission's website.

Researched September 2026 against primary sources — NIC, MeitY, DBIM v3.0,
GIGW 3.0, S3WaaS, CERT-In and STQC — plus direct probing of both live sites.
The source-state measurements are in [`site-audit.md`](site-audit.md); the URL
inventories are in [`inventory/`](inventory/).

---

## 0 · The brief names the wrong destination

The request is usually phrased as *"migrate ipc.gov.in to india.gov.in"*. That
is not a thing that can be done, and a plan built on the phrasing is aimed at
the wrong artefact from day one.

**india.gov.in is a catalogue, not a destination.** The National Portal of India
is an aggregator built and run by NIC. Its own *About Us* states that "the
content available on India Portal is owned and managed by the respective
Ministries and Departments." No department's pages live inside it. Alongside it
sits IGOD (`goidirectory.gov.in`), a directory of ~6,700 government websites
with a *Suggest-A-Site* form.

So the india.gov.in workstream is real but small: **verify IPC's IGOD entry, add
the mandatory National Portal link to IPC's own pages, and contribute
scheme/service/form/document records to the Portal's depository.** Days of work,
present in every option below, never the destination.

**Correct this in writing at kickoff.** Ask the sponsor to re-issue the
objective as *"adopt DBIM and the Gov.In CMS Platform, and refresh IPC's
india.gov.in / IGOD metadata."*

## 1 · What is already true

Three things are commonly conflated. IPC already has one of them.

| | Status |
|---|---|
| **(a)** Publishing into india.gov.in catalogues | A metadata exercise, independent of platform |
| **(b)** Adopting the GoI standard front-end and CMS | **The actual work** |
| **(c)** Hosting on NIC infrastructure | ✅ **Already true** |

`ipc.gov.in` resolves to `164.100.112.224`, in `164.100.0.0/16` — WHOIS
**NICNET, INDIA**, allocation **NDC-PUNE**, the National Data Centre at Pune.
DNS is already `ns1/ns2/ns7/ns10.nic.in`, the same nameservers india.gov.in uses.

**This is not an infrastructure migration.** The domain does not move, DNS does
not move, and there is no hosting to procure. An entire class of risk —
registrar delays, propagation, mail disruption — does not arise. What is being
proposed is a **platform and standards migration**: retiring a legacy Joomla
build for the current NIC standard, and meeting the compliance bar with it.

Anyone costing this as a commercial "website migration" — new hosting, new
domain, data-centre cutover — is costing the wrong project.

## 2 · The standard changed in February 2025

A plan targeting "a GIGW-compliant Joomla refresh" is eighteen months out of
date and will be reworked.

Under the **Gov.In: Harmonisation of Government of India's Digital Footprint**
initiative — prompted by a Cabinet Secretary DO letter to all Secretaries — the
standard is now four things:

- **DBIM** — the Digital Brand Identity Manual (v3.0)
- **DBIM Toolkit** — design library, templates, components
- **GOV.IN CMS Platform** — the managed CMS
- **CCPS** — the central content publishing service

DBIM prescribes the homepage structure itself (header, hero banner, announcements
ticker, PM quote, about, updates, document/persona links, social channels, a
mandatory CCPS overlay banner, logo band, footer), Bhashini-powered translation,
and a KPI feed to a central dashboard.

**IPC's parent ministry has already migrated.** `mohfw.gov.in` is now a Next.js
application sharing one build hash (`d75b7d174657ce62.css`) with `meity.gov.in`,
`msde.gov.in` and `rural.gov.in` — one common codebase, not per-site theming,
with a per-entity CMS master under `digifootprint.gov.in`.

Two consequences: **IPC inherits MoHFW's look rather than commissioning a
design**, and **the approval route runs through MoHFW's CIO**.

DBIM anticipates bodies like IPC explicitly — §5.2 gives Organizations,
Authorities and Regulatory Bodies their own logo lockup (3A with the State
Emblem, 3B without), distinct from Ministries. IPC is not an edge case pleading
for an exemption.

## 3 · Target-state options

| | Option | What it means | Verdict |
|---|---|---|---|
| **0** | "Move onto india.gov.in" | Not a target state — see §0 | ❌ Not a destination |
| **1** | **Harden in place** | Keep Joomla; fix real 404s, UTF-8, CSP, policies | ✅ **Do immediately, regardless** |
| **2** | **S3WaaS** | NIC's WordPress-based SaaS, 3,100+ sites, STQC-verified templates | ⚠️ Likely ineligible |
| **3** | **Gov.In CMS + DBIM** | What MoHFW itself did | ✅ **Recommended** |
| **4** | **DBIM-aligned rebuild** | DBIM standard, IPC's own stack | ↩︎ Named fallback |

**Option 1 is nobody's endpoint but everybody's first move.** It buys legality
and measurability in weeks, and 100% of it is reusable whichever destination
wins. It is Phase 1 below.

**Option 2 is probably not available.** The S3WaaS FAQ restricts the
free-of-cost model to district websites, Raj Bhawans, state portals, Divisional
Commissioners and Chief Ministers. It also converts the job into a
Joomla → WordPress content migration inside a deliberately template-bound IA.
Rule it in or out *on the record* in Phase 0 rather than letting it be assumed
in as "the cheap option".

**Recommendation: target Option 3, execute Option 1 unconditionally now, and
carry Option 4 as the named fallback with a hard decision date at Phase 0 exit.**

Option 3 wins on three specifics: DBIM's own compliance matrix says Checklist 1
is "generic and applicable for all government organizations"; IPC has a
documented access route (Gov.In CMS access "can be granted by the CMS Admin
(Tech SPOC) or the Ministry/Department's CIO/WIM"); and MoHFW is already there,
so the visual target is fixed and its homepage already carries an *Our
Organizations* section linking to bodies like IPC.

## 4 · The sizing correction

**Do not cost this from the homepage.** The 195 paths in
[`inventory/`](inventory/) are what the mega-menu exposes. Deeper research puts
the real surface at approximately:

| | Count |
|---|---:|
| HTML paths | **~1,787** |
| PDFs | **~2,519** |
| Hostnames | **4** |

That is roughly an order of magnitude above the navigation inventory. Two whole
estates are invisible from the homepage — the **PvPI** section and an eight-year
news archive of ~858 pages — plus legacy `/~ajeet/` tilde directories and
ASP-era `/writereaddata/` paths.

**Refuse to cost anything before Phase 2's inventory lands**, and present the
re-baselined count to the sponsor as an explicit correction with the delta
explained, rather than absorbing it quietly.

## 5 · Phases

Durations are ranges with their driver named. They are effort-and-dependency
estimates, not commitments — several depend on answers only the department can
give (§7).

### Phase 0 · Mandate, ownership and the platform decision
**6–12 weeks**, parallel with Phase 1; longer if the CIO route is cold.

- Correct the brief in writing with the sponsor (§0).
- Approach **MoHFW's CIO formally** for Gov.In CMS intake — the only documented route.
- Determine IPC's DBIM logo lockup (3A vs 3B) under the State Emblem Rules, 2007.
- Appoint the **Web Information Manager** (GIGW expects Joint-Secretary level) and CIO/Tech SPOC.
- Verify **registry.gov.in** account control and whether contacts are inside the six-monthly window.
- Settle the **security audit route** in writing: NIC's division, or a separately procured CERT-In empanelled auditor?
- Settle **redirect capability** in writing (see the risk in §6 — this is the most important technical question in the programme).

**Exit:** written intake confirmation from MoHFW's CIO **or** a signed decision to take Option 4 · WIM appointed · registry control confirmed · redirect answer in writing.

### Phase 1 · Emergency remediation on the live site
**2–4 weeks**, starting week 1. Destination-independent — none of it is wasted.

- **Make missing paths return a real HTTP 404** with a branded error page. This unblocks everything downstream; nothing can be measured until it lands.
- **Fix the charset.** The header says `iso-8859-1` while the document declares UTF-8 and contains Devanagari — the header wins.
- Remove stale branding (the G20 presidency logo) — a Content Review Policy failure.
- Add the mandatory **india.gov.in link** (currently absent).
- Patch Joomla and all third-party extensions.
- Publish `robots.txt`.

**Exit:** `/this-does-not-exist-xyz` returns a genuine 404 under both a browser and a bare UA · homepage is UTF-8 and Hindi renders · zero G20 assets · Portal link present.

### Phase 2 · True inventory, triage and the redirect map
**10–16 weeks.** The crawl takes days; the duration is IPC's subject-matter sign-off.

- **Union four sources by authority:** (1) the Joomla database (`#__content`, `#__menu`) — the only authoritative published/unpublished distinction; (2) a live crawl; (3) Wayback/CommonCrawl for orphans; (4) Search Console for what actually has inbound traffic.
- **Live-verify with a two-signal validator** *after* the 404 fix: browser UA, reject empty bodies, require a non-empty `<title>` and at least one in-content link. Never deduplicate by content hash — the soft-404 body varies by request.
- **Triage into keep / archive / retire** with named IPC content owners. Force explicit dispositions on PvPI, the news archive, the tilde directories and the PDF estate.
- **Build the redirect map by hand** — one decided row per source URL. There is no regex rule: the destination uses flat permalinks and the source is six levels deep.
- **Pair Hindi from existing `hreflang` tags**, never by URL transformation.

**Exit:** a signed CSV where every verified URL appears exactly once with a disposition · Hindi rows validated as intact UTF-8 after a round-trip through the real toolchain · signed dispositions for PvPI and the archive.

### Phase 3 · Build and content load
**16–28 weeks.** Driven by surviving page count, editorial headcount and the Hindi decision — not by platform engineering, which the CMS absorbs.

- Re-express IPC's deep trees inside the platform's flat IA.
- **Reserve the CCPS banner slot from the first wireframe** — retrofitting it is the classic rework.
- **Adopt the platform's accessibility behaviour wholesale.** Do not port Joomla templates: 50 of GIGW 3.0's 88 guidelines are the full WCAG 2.1 A+AA set, and the current markup fails structurally (no `h1` anywhere, `lang="en-gb"` on Devanagari pages).
- Make **alt text and heading structure required fields at import time** — retrofitting across thousands of assets is the expensive path.
- **Re-enter Hindi as authored content, byte-verified.** A latin-1/UTF-8 round-trip corrupts Devanagari silently.
- Register the mandatory **Devanagari IDN** in `.भारत` (Punycode `xn--h2brj9c`), required since 04/03/2024.

**Exit:** staging frozen and complete · WCAG 2.1 AA passes on a stratified sample covering every template plus 10% of pages · Hindi renders with correct `lang` and `hreflang`.

### Phase 4 · Security audit and clearance
**6–14 weeks elapsed.** Driven by auditor procurement, pre-audit paperwork, and remediation rounds — assume at least one.

- **Freeze staging.** GIGW 5.3.1 requires Audit Clearance before production hosting, and the auditor must test a frozen instance.
- Treat pre-audit paperwork as its own calendar item: NDA, agreed report structure, written penetration-test authorisation, auditor roster.
- **Pre-clear the obvious findings** before the auditor arrives: disable TLS 1.0/1.1/3DES/RC4, ≥2048-bit SHA-256 certificate, HTTP→HTTPS with HSTS, and a CSP that is not `* 'unsafe-inline' 'unsafe-eval'`.
- Confirm **in writing** that WAF and 180-day log retention are in the hosting service, not assumed.
- Run VAPT against the current OWASP Top 10; remediate; retest.

**Exit:** Audit Clearance certificate naming the specific instance · every finding closed or formally accepted by the WIM · **zero code changes after retest** — any change reopens the obligation.

### Phase 5 · Cut-over and hypercare
**1–2 weeks** cut-over, **4–6 weeks** hypercare. Driven by DNS TTL and the Phase 0 registry answer.

- Lower DNS TTL well ahead.
- Execute as a **single A-record edit** at registry.gov.in. **The MX records (`mx.mgovcloud.in`, `mx2`, `mx3` — NICeMail) must not be touched.**
- Bring the redirect layer live.
- Publish an XML sitemap and `robots.txt` and submit to Search Console — do not assume the platform provides them: `meity.gov.in` serves a real sitemap, `mohfw.gov.in` does not.
- Point the Devanagari IDN at its decided destination.
- Refresh the IGOD entry and begin Portal depository contributions.

**Exit:** 100% of redirect rows return a 301 to a 200, asserted automatically · retired paths return 404/410, never 200 · sitemap accepted in Search Console · **post-cut-over mail delivery test passes**.

### Phase 6 · Certification and steady state
**3–6 months** to a Certified Quality Website mark if in scope; ongoing thereafter.

- Submit the Website Quality Manual, application, agreement and security clearance to STQC.
- Stand up recurring obligations each with a **named owner and a calendar entry**: annual surveillance and surprise audits against three-year CQW validity, security re-audit cadence, content review and archival cycles.
- Operate the DBIM Annexure G KPI feed continuously.

**Exit:** CQW issued **or** a dated decision to defer · every recurring obligation owned · first surveillance passed.

## 6 · Principal risks

| Risk | Mitigation |
|---|---|
| **The brief names the wrong destination** | Correct in writing at kickoff; show the sponsor the India Portal *About Us* text |
| **Gov.In CMS intake has no published form, queue, timeline or price** | Hard decision gate at Phase 0 exit; fall to Option 4 on that date. Never let Phases 1–2 wait — both are destination-independent |
| **Sizing from the homepage undersizes by ~10×** | Refuse to cost before Phase 2; present the re-baseline as an explicit correction |
| **The soft-404 fabricates pages and hides broken links** | Fix real 404s first; two-signal validator; never dedupe by content hash |
| **The destination may not support per-page 301s at all** | Settle in writing in Phase 0. Fallback: a redirect layer on the ipc.gov.in origin ahead of the CMS. An unanswered question here blocks Phase 2 exit |
| **~2,500 PDFs get renamed to opaque CDN numerics** | Redirect old file paths to human-readable document *landing pages*, not raw files; publish a persistent document register keyed by original filename |
| **Hindi corrupts silently** | Fix charset in Phase 1; pair by `hreflang`; UTF-8 discipline with no Excel round-trip; emit rules for both canonical and double-encoded forms |
| **Accessibility treated as a line item when it is the majority of the work** | Budget it as ~57% of conformance effort; adopt platform behaviour wholesale; alt text required at import |
| **GIGW/STQC never checks URL continuity** — zero occurrences of "migrat", "301", "404", "robots" in GIGW 3.0 | Put the redirect map, sitemap, robots and 404-log review into the contract as explicit acceptance criteria with their own sign-off |
| **Registry access blocks cut-over** | Verify login control and contact currency in Phase 0, weeks ahead |
| **A careless DNS edit kills IPC's email** | A runbook that changes exactly one record and names MX untouchable; mail test as an exit criterion |
| **Re-audit becomes continuous** — GIGW requires audit on any source-code change | Prefer configuration-only changes; document a content-vs-code change classification before go-live; agree cadence contractually |
| **Cost is genuinely unknown on every line** | No programme budget until Phase 0 answers land. No number without a written quote — particularly STQC |

## 7 · What must be answered before this can be costed

Ordered by how much they move the estimate. Each needs a named owner and a date.

1. **Will MoHFW's CIO sponsor and schedule Gov.In CMS onboarding, in writing, with a date?** Everything downstream is priced differently by the answer.
2. **Does the destination support arbitrary per-page 301 redirects** — and if not, will NIC permit a redirect layer on the ipc.gov.in origin? *The single most important technical question in the programme.*
3. **Is DBIM adoption formally binding on an autonomous body** under MoHFW, or advisory?
4. **Do we have the Joomla database, and does a Search Console property exist?** Without the database there is no authoritative published/unpublished distinction.
5. **Who holds the registry.gov.in login**, are contacts current, and is an A-record change self-service or letter-driven?
6. **Who is the Web Information Manager**, and what rank satisfies "Joint Secretary level" for a commission rather than a department?
7. **Does NIC audit as part of hosting, or must IPC procure a CERT-In empanelled auditor?** Quote and lead time.
8. **Disposition of PvPI, the ~858-page news archive, `/~ajeet/`, `/writereaddata/`** — keep, archive or retire, and who signs each?
9. **Hindi policy:** curated pages preserved as authored content, or Bhashini machine translation? Where does the `.भारत` IDN point?
10. **The bilingual-PDF gap.** DBIM Annexure G reports "PDFs not having both Hindi and English version" to the central dashboard. Against ~2,500 documents — close it, close it by priority tier, or declare it?
11. **Do `iponline.` and `onlinestore.ipc.gov.in` persist?** They are one AWS-hosted DSpace/JSPUI application off the Joomla origin entirely.
12. **How will the evaluator read GIGW Quality item 21** (API integration with India Portal, DigiLocker, Aadhaar, SSO, MyGov, MyScheme) for an autonomous body? *The largest single scope swing.*
13. **Is STQC CQW certification in scope or deferred, and at what current fee?** Do not use circulating figures — they come from a page STQC itself has withdrawn.
14. **Will NIC permit parallel running**, for how long, and is a temporary gov.in staging hostname available for the audit?
15. **Who owns the budget** — IPC, MoHFW, or absorption into a ministry-level arrangement?

## 8 · The one-paragraph version

IPC is already inside NIC's data centre on NIC's DNS, so this is not an
infrastructure move; it is retiring a legacy Joomla site for the Gov.In CMS
Platform and the DBIM standard that IPC's own ministry already adopted. Fix the
live site's soft-404s, charset and CSP immediately — that work is
destination-independent and unblocks everything else. In parallel, get a written
intake commitment from MoHFW's CIO, and a written answer on whether the
destination can serve per-page redirects. Do not cost the programme from the 195
pages the menu shows: the real surface is nearer 1,800 pages and 2,500 documents,
the Hindi estate is 6% complete against a bilingual obligation, and accessibility
is the majority of the conformance work rather than a line item at the end.
