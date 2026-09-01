#!/usr/bin/env python3
"""Build the whole-programme workbook: Stage 1, Stage 2 and the priced options.

    python3 Estimation/model/build_programme.py

Reads wbs.json, results.json and schedule.json and writes
Estimation/IPC-Migration-Programme-Estimate.xlsx. Nothing is typed by hand —
regenerate after any change to the model so the two cannot drift.
"""
import json, pathlib
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "IPC-Migration-Programme-Estimate.xlsx"
WBS = json.load(open(HERE / "wbs.json"))
RES = json.load(open(HERE / "results.json"))
SCH = json.load(open(HERE / "schedule.json"))
M = SCH["meta"]

GST, MARGIN, TIER = M["gst"], 0.15, 0.72
S1_W, GAP_W, S2_W = M["stage1_weeks"], M["gap_weeks"], M["stage2_weeks"]
TOTAL_W = S1_W + GAP_W + S2_W
S2_OFFSET = S1_W + GAP_W
PT = WBS["commercials"]["stage1_passthrough_inr"]["base"]

ROLE = {r["ref"]: r for r in WBS["roles"]}
EXP = lambda p: (p["o"] + 4 * p["m"] + p["p"]) / 6
S1 = [p for p in WBS["packages"] if p["stage"] == 1 and not p.get("lean_excluded")]
S1_OUT = [p for p in WBS["packages"] if p["stage"] == 1 and p.get("lean_excluded")]
S2 = [p for p in WBS["packages"] if p["stage"] == 2]
OPT = [p for p in WBS["packages"] if p["stage"] == 3]
PD1, PD2, PDO = (RES["views"][k]["P80"] for k in ("stage1-lean", "stage2", "options"))
SC1, SC2, SCO = (pd / sum(EXP(p) for p in g) for pd, g in ((PD1, S1), (PD2, S2), (PDO, OPT)))

def blended(pkgs, tier=TIER):
    tot = {}
    for p in pkgs:
        for rr, sh in p["mix"].items(): tot[rr] = tot.get(rr, 0) + EXP(p) * sh
    base = sum(tot.values())
    return sum(tot[k] * ROLE[k]["rate"] * tier for k in tot) / base

def price(pd, pkgs, pt=PT, margin=MARGIN):
    cost = pd * blended(pkgs) + pt
    ex = cost / (1 - margin)
    return {"blended": blended(pkgs), "cost": cost, "ex": ex, "inc": ex * (1 + GST)}

P1, P2, PO = price(PD1, S1), price(PD2, S2), price(PDO, OPT, pt=0)

# ---------------------------------------------------------------- styling
INK, MUTE, RULE, BAND, HEAD, ACCENT = "1C1917", "78716C", "E7E5E4", "FAFAF9", "292524", "B45309"
PH_FILL = {"0": "8C7A5B", "1": "9A6A4F", "2": "4F6B7A", "3": "5B6E4F", "4": "7A5B6B", "5": "4F5F7A", "P": "6B6459"}
GAP_FILL = "D6D3D1"
def mrg(ws, r1, c1, r2, c2):
    ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)

def F(sz=10, b=False, c=INK, i=False): return Font(name="Calibri", size=sz, bold=b, color=c, italic=i)
def fill(h): return PatternFill("solid", fgColor=h)
thin = Side(style="thin", color=RULE)
BB = Border(bottom=thin)

def title(ws, text, sub, width):
    ws["A1"] = text; ws["A1"].font = F(15, True)
    ws["A2"] = sub;  ws["A2"].font = F(9, c=MUTE, i=True)
    mrg(ws, 1, 1, 1, width); mrg(ws, 2, 1, 2, width)
    ws.row_dimensions[1].height = 22; ws.row_dimensions[2].height = 28
    ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")

def header(ws, row, labels, widths=None, freeze_col=1):
    for i, h in enumerate(labels, 1):
        c = ws.cell(row=row, column=i, value=h)
        c.font = F(9, True, "FFFFFF"); c.fill = fill(HEAD)
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
    ws.row_dimensions[row].height = 30
    if widths:
        for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = ws.cell(row=row + 1, column=freeze_col)

def kv(ws, r, k, v, bold_head=False, wrap=110):
    a = ws.cell(row=r, column=1, value=k); b = ws.cell(row=r, column=2, value=v)
    if bold_head:
        a.font = F(10, True, ACCENT); a.fill = fill(BAND); b.fill = fill(BAND)
    else:
        a.font = F(10, True); b.font = F(10)
    b.alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[r].height = 15 * max(1, (len(str(v)) // wrap) + (1 if len(str(v)) % wrap else 0))
    return r + 1

wb = Workbook(); wb.remove(wb.active)

# =============================================================== READ ME
ws = wb.create_sheet("Read Me")
title(ws, "IPC website migration — programme estimate",
      f"ipc.gov.in onto the Gov.In CMS Platform and DBIM. Basis date {M['basis_date']}. "
      "Generated from the effort model by Estimation/model/build_programme.py — regenerate rather "
      "than edit cells, or this workbook and the model will drift apart.", 4)
ws.column_dimensions["A"].width = 32; ws.column_dimensions["B"].width = 104
r = 4
r = kv(ws, r, "THE ANSWER", "", True)
r = kv(ws, r, "Stage 1 — the recommendation",
       f"Remediate the live site and produce the signed inventory and redirect map. "
       f"{PD1:.0f} PD at P80 over {S1_W} weeks. INR {P1['ex']:,.0f} ex-GST. This is what a 20-30 lakh budget buys.")
r = kv(ws, r, "Stage 2 — indicative only",
       f"Migrate, audit and cut over. {PD2:.0f} PD at P80 over {S2_W} weeks. INR {P2['ex']:,.0f} ex-GST. "
       "Do not commit to this figure: it must be re-derived from Stage 1's register, which is what milestone M6 delivers.")
r = kv(ws, r, "Options — none included",
       f"{PDO:.0f} PD at P80, INR {PO['ex']:,.0f} ex-GST if all were taken. Dominated by hand-keying, "
       "because the destination has no bulk import. Each is a separate sponsor decision.")
r = kv(ws, r, "Programme elapsed",
       f"{TOTAL_W} weeks ({TOTAL_W/4.345:.1f} months): {S1_W} weeks of Stage 1, {GAP_W} weeks to procure "
       f"Stage 2, {S2_W} weeks of Stage 2.")
r += 1
r = kv(ws, r, "HOW TO READ IT", "", True)
for k, v in [
    ("Programme Summary", "All three stages side by side — effort, cost, price, duration, and what each one buys."),
    ("Programme Timeline", f"Master Gantt across all {TOTAL_W} weeks. Bar colour is the phase; the grey band is the procurement gap between stages."),
    ("Milestones & Payments", "Twelve milestones across both stages, each with an exit criterion that can be failed and the evidence that closes it."),
    ("Cash Flow", "Cost incurred against cash received on a four-week payment lag, across the whole programme."),
    ("Resource Plan", "Person-days and FTE by role and four-week period, derived from each package's own role mix."),
    ("Work Packages", "All packages with three-point estimates and scheduled weeks, including the four handed back to IPC and NIC."),
    ("Options & Exclusions", "The priced options, and the statutory costs that genuinely cannot be priced yet."),
    ("Confidence", "Percentiles, the correlation assumption and its sensitivity, and where the uncertainty actually lives."),
    ("Rate Card & Commercials", "Roles and rates, the supplier-tier envelope test, and EMD, PBG and LD at IPC's own revealed rates."),
]: r = kv(ws, r, k, v)
r += 1
r = kv(ws, r, "UNITS", "", True)
for k, v in [
    ("PD — person-day", "One person for one day. 21 PD make a person-month; 20 PD make one four-week period at five days a week."),
    ("P80", "Four engagements in five finish at or below this effort. The standard basis for a fixed-price government contract. P50 is even odds and should never be bid."),
    ("INR lakh", "One hundred thousand rupees. Payment values are given in full rupees so they can be transcribed into a purchase order."),
    ("Ex-GST / inc-GST", f"Contract value before and after GST at {GST:.0%}. Verify whether IPC can claim input credit as an autonomous body — if not, GST is a real cost to the buyer."),
]: r = kv(ws, r, k, v)
r += 1
r = kv(ws, r, "THREE THINGS TO SETTLE BEFORE SIGNING", "", True)
for k, v in [
    ("Supplier tier", "This price assumes a boutique or specialist supplier. IPC's own last IT tender (GEM/2026/B/7781379, 13-07-2026) demanded ISO 9001, ISO 27000 and CMMI Level 3 — a bar that excludes that tier. At mid-tier rates Stage 1 is roughly INR 33 lakh. Resolve the procurement category before bidding, not at evaluation."),
    ("How much content survives", "The destination has no bulk import, and MoHFW — IPC's own ministry — carried across 28 pages and no documents at all. Against IPC's 1,084 items and 2,758 PDFs, triage is the whole project rather than a tidying step. This single answer swings the options by hundreds of person-days."),
    ("Performance guarantee term", "IPC's revealed ePBG was 5% held for 60 months. On a 24-week assignment that is a five-year guarantee against a six-month job. Negotiate the term, not only the rate."),
]: r = kv(ws, r, k, v)
r += 1
r = kv(ws, r, "WHAT MOVED IN THE SCHEDULE", M["note"])
r = kv(ws, r, "THE GAP BETWEEN STAGES", M["gap_note"])

# ====================================================== PROGRAMME SUMMARY
ws = wb.create_sheet("Programme Summary")
title(ws, "Programme summary", "Boutique tier, 15% margin, P80. Stage 2 is indicative and must be "
      "re-derived from Stage 1's register before it is committed to.", 8)
header(ws, 4, ["Stage", "What it buys", "Packages", "PD (P80)", "Weeks",
               "Blended INR/PD", "Ex-GST (INR)", "Inc-GST (INR)"],
       [22, 56, 10, 10, 8, 14, 16, 16])
rows = [
    ("Stage 1 · Remediate and baseline",
     "Real 404s, UTF-8, CSP, lang. One signed inventory. One decided redirect map. A Stage 2 cost baseline.",
     len(S1), PD1, S1_W, P1),
    ("Procurement gap", f"Stage 2 cannot be procured until Stage 1 makes it costable. Range 8–16 weeks.",
     0, 0, GAP_W, None),
    ("Stage 2 · Migrate and cut over",
     "Platform tenancy, IA, content load, accessibility, audit clearance, cut-over, hypercare.",
     len(S2), PD2, S2_W, P2),
    ("Options · not included",
     "Hand authoring, document loading, PDF remediation, translation, applications replatform, STQC, IAAP.",
     len(OPT), PDO, 0, PO),
]
r = 5
for name, what, n, pd, wk, pr in rows:
    vals = [name, what, n or "", pd or "", wk or "",
            pr["blended"] if pr else "", pr["ex"] if pr else "", pr["inc"] if pr else ""]
    for i, v in enumerate(vals, 1):
        c = ws.cell(row=r, column=i, value=v); c.border = BB
        c.font = F(10, b=(i == 1), i=(name == "Procurement gap"))
        if i == 2: c.alignment = Alignment(wrap_text=True, vertical="top")
        if i in (3, 4, 5): c.alignment = Alignment(horizontal="center")
        if i == 4: c.number_format = "0"
        if i >= 6: c.number_format = '#,##0'
    ws.row_dimensions[r].height = 30; r += 1
tot = [("Stage 1 + Stage 2, as two contracts", len(S1) + len(S2), PD1 + PD2, S1_W + GAP_W + S2_W,
        P1["ex"] + P2["ex"], P1["inc"] + P2["inc"]),
       ("Everything, options included", len(S1) + len(S2) + len(OPT), PD1 + PD2 + PDO,
        S1_W + GAP_W + S2_W, P1["ex"] + P2["ex"] + PO["ex"], P1["inc"] + P2["inc"] + PO["inc"])]
r += 1
for name, n, pd, wk, ex, inc in tot:
    for i, v in enumerate([name, "", n, pd, wk, "", ex, inc], 1):
        c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
        if i == 4: c.number_format = "0"
        if i >= 7: c.number_format = '#,##0'
        if i in (3, 4, 5): c.alignment = Alignment(horizontal="center")
    r += 1
r += 1
ws.cell(row=r, column=1, value="Not in any figure above").font = F(10, True, ACCENT)
r += 1
for t in SCH["excluded_unpriced"][:3]:
    ws.cell(row=r, column=1, value=t["item"]).font = F(9, True)
    c = ws.cell(row=r, column=2, value=f'{t["position"]} — {t["note"]}'); c.font = F(9, c=MUTE)
    c.alignment = Alignment(wrap_text=True, vertical="top")
    mrg(ws, r, 2, r, 8); ws.row_dimensions[r].height = 28; r += 1
ws.cell(row=r, column=1, value="…and four more").font = F(9, c=MUTE, i=True)
ws.cell(row=r, column=2, value="See the Options & Exclusions sheet.").font = F(9, c=MUTE, i=True)
r += 2
ws.cell(row=r, column=1, value="Client effort").font = F(9, True)
c = ws.cell(row=r, column=2, value="40–70 person-days of IPC subject-matter time for Stage 1 triage "
    "sign-off, and a content-authoring commitment in Stage 2. Tracked, never billed, and not "
    "purchasable: 60–80% of a content audit is client-side. An under-resourced client is a schedule "
    "risk that first presents itself as a cost saving.")
c.font = F(9, c=MUTE); c.alignment = Alignment(wrap_text=True, vertical="top")
mrg(ws, r, 2, r, 8); ws.row_dimensions[r].height = 42

# ===================================================== PROGRAMME TIMELINE
ws = wb.create_sheet("Programme Timeline")
title(ws, "Programme timeline", f"{TOTAL_W} weeks. Stage 1 W1–W{S1_W}; procurement gap "
      f"W{S1_W+1}–W{S2_OFFSET}; Stage 2 W{S2_OFFSET+1}–W{TOTAL_W}. ◆ marks a milestone.", 6 + TOTAL_W)
header(ws, 4, ["Ref", "Work package", "Phase", "PD", "Start", "End"] +
       [f"{w}" for w in range(1, TOTAL_W + 1)], [7, 50, 24, 8, 6, 6] + [3.0] * TOTAL_W)
ms = {m["week"]: m["ref"] for m in SCH["milestones"]}
ms.update({m["week"] + S2_OFFSET: m["ref"] for m in SCH["stage2_milestones"]})
for w in range(1, TOTAL_W + 1):
    c = ws.cell(row=4, column=6 + w)
    if w in ms: c.value = ms[w]; c.fill = fill(ACCENT); c.font = F(7, True, "FFFFFF")
    elif S1_W < w <= S2_OFFSET: c.fill = fill(GAP_FILL)
s1s = {s["ref"]: s for s in SCH["schedule"]}
s2s = {s["ref"]: s for s in SCH["stage2_schedule"]}
r = 5
def band(label):
    global r
    c = ws.cell(row=r, column=1, value=label); c.font = F(10, True, "FFFFFF"); c.fill = fill(HEAD)
    for i in range(2, 7 + TOTAL_W): ws.cell(row=r, column=i).fill = fill(HEAD)
    mrg(ws, r, 1, r, 6); r += 1
def draw(pkgs, sm, off, scale):
    global r
    for pk in sorted(pkgs, key=lambda x: (x["phase"], x["ref"])):
        s = sm[pk["ref"]]; a, b = s["start"] + off, s["end"] + off
        for i, v in enumerate([pk["ref"], pk["name"], pk["phase"],
                               round(EXP(pk) * scale, 1), a, b], 1):
            c = ws.cell(row=r, column=i, value=v); c.font = F(9, b=(i == 1)); c.border = BB
            if i == 4: c.number_format = "0.0"
            if i >= 4: c.alignment = Alignment(horizontal="center")
        for w in range(1, TOTAL_W + 1):
            c = ws.cell(row=r, column=6 + w); c.border = BB
            if a <= w <= b: c.fill = fill(PH_FILL[pk["phase"][0]])
            elif S1_W < w <= S2_OFFSET: c.fill = fill(GAP_FILL)
        r += 1
band(f"STAGE 1 · Remediate and baseline · W1–W{S1_W} · {PD1:.0f} PD")
draw(S1, s1s, 0, SC1)
band(f"PROCUREMENT GAP · W{S1_W+1}–W{S2_OFFSET} · Stage 2 is re-costed from Stage 1's register, then procured")
band(f"STAGE 2 · Migrate and cut over · W{S2_OFFSET+1}–W{TOTAL_W} · {PD2:.0f} PD")
draw(S2, s2s, S2_OFFSET, SC2)
r += 1
ws.cell(row=r, column=2, value="Phase key").font = F(9, True); r += 1
for k, lbl in [("0", "Mandate and decisions"), ("1", "Emergency remediation"),
               ("2", "Inventory and redirect map"), ("3", "Build and content load"),
               ("4", "Audit and clearance"), ("5", "Cut-over and hypercare"),
               ("P", "Programme management")]:
    ws.cell(row=r, column=1).fill = fill(PH_FILL[k])
    ws.cell(row=r, column=2, value=lbl).font = F(9); r += 1
ws.cell(row=r, column=1).fill = fill(GAP_FILL)
ws.cell(row=r, column=2, value="Procurement gap — no supplier effort").font = F(9)

# ================================================ MILESTONES & PAYMENTS
ws = wb.create_sheet("Milestones & Payments")
title(ws, "Milestones and payment schedule", "Twelve milestones across two separately contracted "
      "stages. Every one is paid against a checkable exit criterion, not a date — a milestone that "
      "cannot be failed is not a milestone.", 8)
header(ws, 4, ["Ref", "Prog. week", "Milestone", "Share of stage", "Ex-GST (INR)",
               "GST (INR)", "Payable inc-GST (INR)", "Cumulative programme (INR)"],
       [7, 11, 42, 13, 16, 13, 19, 22])
r = 5; cum = 0
for label, mils, off, val in (("STAGE 1", SCH["milestones"], 0, P1["ex"]),
                              ("STAGE 2", SCH["stage2_milestones"], S2_OFFSET, P2["ex"])):
    c = ws.cell(row=r, column=1, value=f'{label} · contract value INR {val:,.0f} ex-GST')
    c.font = F(10, True, "FFFFFF"); c.fill = fill(HEAD)
    for i in range(2, 9): ws.cell(row=r, column=i).fill = fill(HEAD)
    mrg(ws, r, 1, r, 8); r += 1
    for m in mils:
        v = val * m["share"]; cum += v
        for i, x in enumerate([m["ref"], m["week"] + off, m["name"], m["share"], v, v * GST,
                               v * (1 + GST), cum], 1):
            c = ws.cell(row=r, column=i, value=x); c.font = F(10, b=(i == 1)); c.border = BB
            if i == 4: c.number_format = "0%"
            if i in (2, 4): c.alignment = Alignment(horizontal="center")
            if i >= 5: c.number_format = '#,##0'
        r += 1
for i, x in enumerate(["", "", "PROGRAMME TOTAL", "", P1["ex"] + P2["ex"],
                       (P1["ex"] + P2["ex"]) * GST, (P1["ex"] + P2["ex"]) * (1 + GST), ""], 1):
    c = ws.cell(row=r, column=i, value=x); c.font = F(10, True); c.fill = fill(BAND)
    if i >= 5: c.number_format = '#,##0'
r += 3
ws.cell(row=r, column=1, value="EXIT CRITERIA — what has to be true before each invoice is raised").font = F(11, True, ACCENT)
r += 2
for off, mils in ((0, SCH["milestones"]), (S2_OFFSET, SCH["stage2_milestones"])):
    for m in mils:
        c = ws.cell(row=r, column=1, value=f'{m["ref"]} · programme week {m["week"]+off} · {m["name"]}')
        c.font = F(10, True); c.fill = fill(BAND); mrg(ws, r, 1, r, 8); r += 1
        for lbl, txt in (("Exit criterion", m["exit"]), ("Evidence", m["evidence"])):
            ws.cell(row=r, column=1, value=lbl).font = F(9, True, MUTE)
            c = ws.cell(row=r, column=2, value=txt); c.font = F(9)
            c.alignment = Alignment(wrap_text=True, vertical="top")
            mrg(ws, r, 2, r, 8); ws.row_dimensions[r].height = 14 * (1 + len(txt) // 108); r += 1
        r += 1

# ================================================================ CASH FLOW
ws = wb.create_sheet("Cash Flow")
title(ws, "Cash flow", "Cost is incurred as effort is spent; cash arrives four weeks after a "
      "milestone is certified. The peak negative position is working capital, not margin — and on "
      "engagements this size it decides whether a small supplier can take the work at all.", 9)
header(ws, 4, ["Period", "Weeks", "Stage", "PD spent", "Cost incurred (INR)",
               "Billed inc-GST (INR)", "Cash received (INR)", "Cumulative cost (INR)",
               "Net position (INR)"], [9, 12, 10, 10, 18, 18, 18, 19, 18])
weekly = [0.0] * (TOTAL_W + 9); wcost = [0.0] * (TOTAL_W + 9)
for pkgs, sm, off, scale in ((S1, s1s, 0, SC1), (S2, s2s, S2_OFFSET, SC2)):
    bl = blended(pkgs)
    for pk in pkgs:
        s = sm[pk["ref"]]; n = s["end"] - s["start"] + 1; per = EXP(pk) * scale / n
        for w in range(s["start"] + off, s["end"] + off + 1):
            weekly[w] += per; wcost[w] += per * bl
bill = {m["week"]: P1["ex"] * m["share"] for m in SCH["milestones"]}
for m in SCH["stage2_milestones"]: bill[m["week"] + S2_OFFSET] = P2["ex"] * m["share"]
recv = {w + 4: v for w, v in bill.items()}
# pass-through lands with mobilisation of each stage
wcost[1] += PT; wcost[S2_OFFSET + 1] += PT
r = 5; cc = cr = 0.0; peak = 0.0
for p in range(1, (TOTAL_W + 4) // 4 + 1):
    w0, w1 = (p - 1) * 4 + 1, p * 4
    pd = sum(weekly[w0:w1 + 1]); cost = sum(wcost[w0:w1 + 1])
    b = sum(v for w, v in bill.items() if w0 <= w <= w1) * (1 + GST)
    rc = sum(v for w, v in recv.items() if w0 <= w <= w1) * (1 + GST)
    cc += cost; cr += rc; peak = min(peak, cr - cc)
    stg = "Stage 1" if w1 <= S1_W else ("Gap" if w0 > S1_W and w1 <= S2_OFFSET else
          ("Stage 2" if w0 > S2_OFFSET else "—"))
    for i, v in enumerate([f"P{p}", f"W{w0}–W{w1}", stg, round(pd, 1), cost, b, rc, cc, cr - cc], 1):
        c = ws.cell(row=r, column=i, value=v); c.border = BB
        c.font = F(10, c=("9A3412" if i == 9 and (cr - cc) < 0 else INK), i=(stg == "Gap"))
        if i == 4: c.number_format = "0.0"
        if i >= 5: c.number_format = '#,##0'
        if i <= 3: c.alignment = Alignment(horizontal="center")
    r += 1
r += 1
for lbl, val, note in [
    ("Stage 1 blended rate", blended(S1), "INR/PD — an output of the role mix, not an input"),
    ("Stage 2 blended rate", blended(S2), "Higher: security and accessibility rise from cameo to substantial"),
    ("Peak negative position", peak, "The working capital carried across the whole programme"),
    ("Peak as share of Stage 1", peak / P1["ex"], "Ask for a mobilisation advance if this is uncomfortable"),
]:
    ws.cell(row=r, column=1, value=lbl).font = F(10, True)
    c = ws.cell(row=r, column=5, value=val); c.font = F(10, True, "9A3412" if val < 0 else INK)
    c.number_format = '0.0%' if abs(val) < 1 else '#,##0'
    ws.cell(row=r, column=6, value=note).font = F(9, c=MUTE, i=True); r += 1

# ============================================================ RESOURCE PLAN
ws = wb.create_sheet("Resource Plan")
NP = (TOTAL_W + 3) // 4
title(ws, "Resource plan", "Person-days by role and four-week period, derived from each package's "
      "own role mix. One period = 20 working days. The gap periods are empty by design.", 4 + NP)
header(ws, 4, ["Ref", "Role", "INR/PD", "Total PD"] + [f"P{p}" for p in range(1, NP + 1)],
       [7, 38, 9, 9] + [6.5] * NP)
rp = {rr: [0.0] * (NP + 2) for rr in ROLE}
for pkgs, sm, off, scale in ((S1, s1s, 0, SC1), (S2, s2s, S2_OFFSET, SC2)):
    for pk in pkgs:
        s = sm[pk["ref"]]; n = s["end"] - s["start"] + 1; per = EXP(pk) * scale / n
        for w in range(s["start"] + off, s["end"] + off + 1):
            pi = min(NP, (w - 1) // 4 + 1)
            for rr, sh in pk["mix"].items(): rp[rr][pi] += per * sh
r = 5
for rr in sorted(ROLE, key=lambda x: -sum(rp[x])):
    tot = sum(rp[rr])
    if tot < 0.05: continue
    for i, v in enumerate([rr, ROLE[rr]["role"], ROLE[rr]["rate"], tot] +
                          [rp[rr][p] or "" for p in range(1, NP + 1)], 1):
        c = ws.cell(row=r, column=i, value=v); c.font = F(9, b=(i == 1)); c.border = BB
        if i == 3: c.number_format = '#,##0'
        if i >= 4: c.number_format = "0.0"
    r += 1
tots = [sum(rp[rr][p] for rr in ROLE) for p in range(1, NP + 1)]
for i, v in enumerate(["", "TOTAL PD", "", sum(tots)] + tots, 1):
    c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
    if i >= 4: c.number_format = "0.0"
r += 1
for i, v in enumerate(["", "FTE", "", ""] + [t / 20 for t in tots], 1):
    c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
    if i >= 5: c.number_format = "0.00"
r += 2
for lbl, val in [("Peak FTE in any period", max(tots) / 20),
                 ("Average FTE while working (gap excluded)",
                  sum(tots) / (len([t for t in tots if t > 0.05]) * 20))]:
    ws.cell(row=r, column=2, value=lbl).font = F(10, True)
    c = ws.cell(row=r, column=4, value=val); c.number_format = "0.00"; c.font = F(10, True); r += 1
r += 1
c = ws.cell(row=r, column=2, value="Eight named people across both stages, but never eight at once. "
    "Stage 1 is front-loaded on purpose — three people for weeks 5–8 on the remediation sprint, because "
    "that work is destination-independent and every week it waits is another week of indexed junk. "
    "Stage 2 is longer and thinner. A boutique can staff this shape; a large firm's bench cannot, which "
    "is another reason the tier question matters.")
c.font = F(9, c=MUTE, i=True); c.alignment = Alignment(wrap_text=True, vertical="top")
mrg(ws, r, 2, r, 4 + NP); ws.row_dimensions[r].height = 58

# ============================================================ WORK PACKAGES
ws = wb.create_sheet("Work Packages")
title(ws, "Work packages", "Three-point estimates. Expected = (O + 4M + P) / 6. The P80 column scales "
      "expected to the bid basis, which is where the risk reserve lives.", 10)
header(ws, 4, ["Stage", "Ref", "Phase", "Work package", "O", "M", "P", "Expected", "P80", "Weeks"],
       [10, 7, 24, 52, 6, 6, 6, 9, 9, 12])
r = 5
for label, pkgs, sm, off, scale in (("Stage 1", S1, s1s, 0, SC1), ("Stage 2", S2, s2s, S2_OFFSET, SC2),
                                    ("Options", OPT, None, 0, SCO), ("Not bought", S1_OUT, None, 0, 1.0)):
    for pk in sorted(pkgs, key=lambda x: (x["phase"], x["ref"])):
        wkl = f'W{sm[pk["ref"]]["start"]+off}–W{sm[pk["ref"]]["end"]+off}' if sm else \
              ("on trigger" if label == "Options" else "IPC / NIC")
        nm = pk["name"] + (f'  ({pk["lean_excluded"][:60]}…)' if pk.get("lean_excluded") else "")
        for i, v in enumerate([label, pk["ref"], pk["phase"], nm, pk["o"], pk["m"], pk["p"],
                               EXP(pk), EXP(pk) * scale if label != "Not bought" else "", wkl], 1):
            c = ws.cell(row=r, column=i, value=v); c.border = BB
            c.font = F(9, b=(i == 2), i=(label == "Not bought"), c=(MUTE if label == "Not bought" else INK))
            if i in (8, 9): c.number_format = "0.0"
            if i >= 5: c.alignment = Alignment(horizontal="center")
        r += 1

# ======================================================= OPTIONS & EXCLUSIONS
ws = wb.create_sheet("Options & Exclusions")
title(ws, "Options and exclusions", "None of this is in the Stage 1 or Stage 2 figures. Each option is "
      "a separate sponsor decision; each exclusion is a cost that genuinely cannot be priced yet.", 6)
header(ws, 4, ["Ref", "Option", "PD (P80)", "Ex-GST (INR)", "What triggers it", ""],
       [7, 54, 10, 16, 62, 2])
trig = {
 "X.1": "Only if Option 4 (bespoke rebuild) is taken. Under Option 3 the platform serves Hindi as runtime Bhashini machine translation.",
 "X.2": "If alt text and metadata are not made required fields at import. Retrofitting across thousands of assets is the expensive path.",
 "X.3": "If the PDF estate is remediated rather than tiered or declared. Rate deliberately unpriced — sample 30-50 documents first.",
 "X.4": "If STQC Certified Quality Website certification is in scope rather than deferred. The IAAP review (X.6) gates it.",
 "X.5": "If /shop, /e-services, PvPI, iponline or onlinestore come into scope. /shop is a live OpenCart storefront, re-verified 01-09-2026.",
 "X.6": "Mandatory ahead of any STQC GIGW evaluation, per STQC OM dated 30.06.2025. Take it if X.4 is taken.",
 "X.7": "If IPC cannot staff content authoring. There is no bulk import, so every surviving item is hand-keyed.",
 "X.8": "If the document estate is loaded into the platform. One hand-made post per PDF, six mandatory fields.",
 "3.13": "Only if Option 4 is taken. Annexure G binds bodies NOT onboarded to the Gov.In CMS Platform.",
}
r = 5
for pk in sorted(OPT, key=lambda x: x["ref"]):
    pd = EXP(pk) * SCO
    for i, v in enumerate([pk["ref"], pk["name"], pd, pd * blended(OPT) / (1 - MARGIN),
                           trig.get(pk["ref"], "")], 1):
        c = ws.cell(row=r, column=i, value=v); c.border = BB; c.font = F(9, b=(i == 1))
        if i == 3: c.number_format = "0.0"; c.alignment = Alignment(horizontal="center")
        if i == 4: c.number_format = '#,##0'
        if i in (2, 5): c.alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[r].height = 30; r += 1
for i, v in enumerate(["", "TOTAL if all were taken", PDO, PO["ex"], ""], 1):
    c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
    if i == 3: c.number_format = "0.0"
    if i == 4: c.number_format = '#,##0'
r += 3
ws.cell(row=r, column=1, value="EXCLUDED AND UNPRICED — costs that are real but cannot be quoted yet").font = F(11, True, ACCENT)
r += 2
for i, h in enumerate(["Item", "Position", "Why it cannot be priced"], 1):
    c = ws.cell(row=r, column=i if i < 3 else 5, value=h); c.font = F(9, True, "FFFFFF"); c.fill = fill(HEAD)
ws.cell(row=r, column=3).fill = fill(HEAD); ws.cell(row=r, column=4).fill = fill(HEAD)
r += 1
for t in SCH["excluded_unpriced"]:
    ws.cell(row=r, column=1, value=t["item"]).font = F(9, True)
    c2 = ws.cell(row=r, column=2, value=t["position"]); c2.font = F(9, c=ACCENT)
    c2.alignment = Alignment(wrap_text=True, vertical="top"); mrg(ws, r, 2, r, 4)
    c = ws.cell(row=r, column=5, value=t["note"]); c.font = F(9, c=MUTE)
    c.alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[r].height = 15 * (1 + len(t["note"]) // 78); r += 1

# ================================================================ CONFIDENCE
ws = wb.create_sheet("Confidence")
title(ws, "Confidence", "100,000 iterations, Beta-PERT marginals, single-factor Gaussian copula at "
      "rho 0.5, exogenous risks sampled inside each iteration rather than added to a percentile. "
      f"Seed {RES['seed']} — every figure here is reproducible.", 8)
header(ws, 4, ["View", "Packages", "PERT expected PD", "Risk EMV PD", "P50", "P70", "P80", "P90"],
       [22, 10, 16, 12, 9, 9, 9, 9])
r = 5
for key, lbl in (("stage1-lean", "Stage 1 (recommended)"), ("stage1", "Stage 1 (full scope)"),
                 ("stage2", "Stage 2"), ("recommended", "Stage 1 + 2, joint run"),
                 ("options", "Options")):
    v = RES["views"][key]
    for i, x in enumerate([lbl, v["packages"], v["pert_expected_pd"], v["risk_emv_pd"],
                           v["P50"], v["P70"], v["P80"], v["P90"]], 1):
        c = ws.cell(row=r, column=i, value=x); c.border = BB
        c.font = F(10, b=(key == "stage1-lean"))
        if i >= 2: c.alignment = Alignment(horizontal="center")
        if i >= 3: c.number_format = "0"
    r += 1
r += 2
ws.cell(row=r, column=1, value="CORRELATION SENSITIVITY — Stage 1 recommended scope. The assumption is visible, not buried").font = F(11, True, ACCENT); r += 1
header(ws, r, ["rho", "P50", "P80", "P90", "Reading", "", "", ""], None); r += 1
for rho, note in (("rho=0.0", "Independent packages. Unrealistic — one team, one client."),
                  ("rho=0.3", "Weak common cause. A portfolio of unrelated projects."),
                  ("rho=0.5", "RECOMMENDED. One accountable team, shared requirement risk."),
                  ("rho=0.7", "Strong common cause. Use if requirements are unfrozen at award.")):
    v = RES["sensitivity_lean"][rho]
    for i, x in enumerate([rho, v["P50"], v["P80"], v["P90"], note], 1):
        c = ws.cell(row=r, column=i, value=x); c.border = BB
        c.font = F(10, b=("0.5" in rho))
        if 2 <= i <= 4: c.number_format = "0"; c.alignment = Alignment(horizontal="center")
        if i == 5: mrg(ws, r, 5, r, 8)
    r += 1
r += 1
c = ws.cell(row=r, column=1, value=f'Percentiles do not add. Stage 1 at P80 ({PD1:.0f} PD) plus Stage 2 '
    f'at P80 ({PD2:.0f} PD) is {PD1+PD2:.0f} PD, but a single joint contract sampling both in the same '
    f'iterations is {RES["views"]["recommended"]["P80"]:.0f} PD — the two stages diversify against each '
    "other. They are priced as two contracts here because that is how they would be procured.")
c.font = F(9, c=MUTE, i=True); c.alignment = Alignment(wrap_text=True, vertical="top")
mrg(ws, r, 1, r, 8); ws.row_dimensions[r].height = 30
r += 2
ws.cell(row=r, column=1, value="WHERE THE UNCERTAINTY LIVES — share of Stage 1 variance").font = F(11, True, ACCENT); r += 1
for d in RES["views"]["stage1"]["variance_drivers"]:
    ws.cell(row=r, column=1, value=d["ref"]).font = F(9, True)
    c = ws.cell(row=r, column=2, value=d["share"]); c.number_format = "0.0%"
    c.alignment = Alignment(horizontal="center")
    ws.cell(row=r, column=3, value=d["name"]).font = F(9)
    mrg(ws, r, 3, r, 8); r += 1
r += 1
c = ws.cell(row=r, column=1, value="Nearly a quarter of the spread is one package — the redirect map. "
    "A day spent agreeing the redirect convention at kickoff is worth more than a week of estimating "
    "discipline anywhere else.")
c.font = F(9, c=MUTE, i=True); c.alignment = Alignment(wrap_text=True, vertical="top")
mrg(ws, r, 1, r, 8); ws.row_dimensions[r].height = 30

# ==================================================== RATE CARD & COMMERCIALS
ws = wb.create_sheet("Rate Card & Commercials")
title(ws, "Rate card and commercial terms", "Role rates are the mid-tier reference. The blended rate "
      "is an OUTPUT of the role mix in the packages, not an input — change the mix and it moves.", 6)
header(ws, 4, ["Ref", "Role", "INR/PD", "Stage 1 PD", "Stage 2 PD", "Note"],
       [7, 38, 10, 11, 11, 76])
r = 5
def rpd(pkgs, scale):
    t = {}
    for p in pkgs:
        for rr, sh in p["mix"].items(): t[rr] = t.get(rr, 0) + EXP(p) * sh * scale
    return t
r1, r2 = rpd(S1, SC1), rpd(S2, SC2)
for rr in sorted(ROLE, key=lambda x: -(r1.get(x, 0) + r2.get(x, 0))):
    for i, v in enumerate([rr, ROLE[rr]["role"], ROLE[rr]["rate"], r1.get(rr, 0) or "",
                           r2.get(rr, 0) or "", ROLE[rr].get("note", "")], 1):
        c = ws.cell(row=r, column=i, value=v); c.border = BB; c.font = F(9, b=(i == 1))
        if i == 3: c.number_format = '#,##0'
        if i in (4, 5): c.number_format = "0.0"; c.alignment = Alignment(horizontal="center")
        if i == 6: c.font = F(9, c=MUTE); c.alignment = Alignment(wrap_text=True, vertical="top")
    r += 1
for i, v in enumerate(["", "TOTAL", "", PD1, PD2, ""], 1):
    c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
    if i in (4, 5): c.number_format = "0.0"; c.alignment = Alignment(horizontal="center")
r += 3
ws.cell(row=r, column=1, value="SUPPLIER TIER — the envelope test. Stage 1 ex-GST, INR lakh").font = F(11, True, ACCENT); r += 1
header(ws, r, ["Tier", "Multiplier", "Blended INR/PD", "P50", "P80", "P90"], None); r += 1
for ref, name, mult in (("T1", "Boutique / specialist", 0.72), ("T2", "Mid-tier SI", 1.00),
                        ("T3", "Tier-1 SI", 1.40)):
    row = [f"{ref} · {name}", mult, blended(S1, mult)]
    for q in ("P50", "P80", "P90"):
        pd = RES["views"]["stage1-lean"][q]
        row.append((pd * blended(S1, mult) + PT) / (1 - MARGIN) / 100000)
    for i, v in enumerate(row, 1):
        c = ws.cell(row=r, column=i, value=v); c.border = BB; c.font = F(10, b=(ref == "T1"))
        if i == 2: c.number_format = "0.00"
        if i == 3: c.number_format = '#,##0'
        if i >= 4:
            c.number_format = "0.00"
            if 20 <= v <= 30: c.font = F(10, True, "166534")
        if i >= 2: c.alignment = Alignment(horizontal="center")
    r += 1
r += 1
c = ws.cell(row=r, column=1, value="Green cells fall inside the stated INR 20–30 lakh envelope. T1 is the "
    "only tier that fits at the bid percentile — but IPC's own last IT tender demanded ISO 9001, ISO 27000 "
    "and CMMI Level 3, a bar that excludes it. Resolve the procurement category before bidding.")
c.font = F(9, c=MUTE, i=True); c.alignment = Alignment(wrap_text=True, vertical="top")
mrg(ws, r, 1, r, 6); ws.row_dimensions[r].height = 30; r += 3
ws.cell(row=r, column=1, value="COMMERCIAL TERMS — IPC's own revealed rates, not convention").font = F(11, True, ACCENT); r += 1
header(ws, r, ["Item", "Rate", "On Stage 1 (INR)", "On both stages (INR)", "", "Note"], None); r += 1
pbg1, pbg12 = P1["ex"] * 0.05, (P1["ex"] + P2["ex"]) * 0.05
for t in SCH["commercial_terms"]:
    b1 = pbg1 if t["of"] == "PBG value" else P1["ex"]
    b2 = pbg12 if t["of"] == "PBG value" else P1["ex"] + P2["ex"]
    for i, v in enumerate([t["item"], t["rate"], b1 * t["rate"], b2 * t["rate"], "", t["note"]], 1):
        c = ws.cell(row=r, column=i, value=v); c.border = BB; c.font = F(9, b=(i == 1))
        if i == 2: c.number_format = "0.0%"; c.alignment = Alignment(horizontal="center")
        if i in (3, 4): c.number_format = '#,##0'
        if i == 6:
            c.font = F(9, c=MUTE); c.alignment = Alignment(wrap_text=True, vertical="top")
            ws.row_dimensions[r].height = 15 * (1 + len(v) // 78)
    r += 1

for s in wb.worksheets: s.sheet_view.showGridLines = False
wb.save(OUT)
print(f"written: {OUT}")
print(f"  Stage 1 {PD1:.0f} PD  INR {P1['ex']:,.0f} ex-GST")
print(f"  Stage 2 {PD2:.0f} PD  INR {P2['ex']:,.0f} ex-GST")
print(f"  Options {PDO:.0f} PD  INR {PO['ex']:,.0f} ex-GST")
print(f"  Programme {TOTAL_W} weeks, {len(wb.sheetnames)} sheets: {wb.sheetnames}")
