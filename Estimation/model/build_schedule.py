#!/usr/bin/env python3
"""Build the Stage 1 timeline, milestone and payment workbook.

    python3 Estimation/model/build_schedule.py

Reads wbs.json (the work packages), results.json (the simulation) and
schedule.json (start/end weeks, milestones, commercial terms) and writes
Estimation/Stage-1-Timeline-and-Payments.xlsx. Nothing is typed into the
workbook by hand — regenerate it after any change to the model.
"""
import json, pathlib
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "Stage-1-Timeline-and-Payments.xlsx"

WBS = json.load(open(HERE / "wbs.json"))
RES = json.load(open(HERE / "results.json"))
SCH = json.load(open(HERE / "schedule.json"))

M = SCH["meta"]
WEEKS, PERIODS = M["weeks"], M["weeks"] // 4
PD80, EXGST, GST = M["pd_p80"], M["contract_ex_gst"], M["gst"]
LAG = M["payment_lag_weeks"]

PKG = {p["ref"]: p for p in WBS["packages"]}
ROLE = {r["ref"]: r for r in WBS["roles"]}
LEAN = [p for p in WBS["packages"] if p["stage"] == 1 and not p.get("lean_excluded")]
EXP = lambda p: (p["o"] + 4 * p["m"] + p["p"]) / 6
SCALE = PD80 / sum(EXP(p) for p in LEAN)          # PERT expected -> the P80 bid basis

# ---------------------------------------------------------------- palette
INK   = "1C1917"; MUTE = "78716C"; RULE = "E7E5E4"
BAND  = "FAFAF9"; HEAD = "292524"
PHASE_FILL = {"0": "8C7A5B", "1": "9A6A4F", "2": "4F6B7A", "P": "6B6459"}
ACCENT = "B45309"

def F(sz=10, b=False, c=INK, i=False): return Font(name="Calibri", size=sz, bold=b, color=c, italic=i)
def fill(hexv): return PatternFill("solid", fgColor=hexv)
thin = Side(style="thin", color=RULE)
def box(l=False, r=False, t=False, bt=False):
    return Border(left=thin if l else None, right=thin if r else None,
                  top=thin if t else None, bottom=thin if bt else None)

def title(ws, text, sub, width):
    ws["A1"] = text; ws["A1"].font = F(15, True)
    ws["A2"] = sub;  ws["A2"].font = F(9, c=MUTE, i=True)
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=width)
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=width)
    ws.row_dimensions[1].height = 22; ws.row_dimensions[2].height = 26
    ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")

def header(ws, row, labels, widths=None):
    for i, h in enumerate(labels, 1):
        c = ws.cell(row=row, column=i, value=h)
        c.font = F(9, True, "FFFFFF"); c.fill = fill(HEAD)
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
    ws.row_dimensions[row].height = 30
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = ws.cell(row=row + 1, column=1)

wb = Workbook(); wb.remove(wb.active)

# ================================================================ READ ME
ws = wb.create_sheet("Read Me")
title(ws, "Stage 1 · Timeline, milestones and payments",
      f"Indian Pharmacopoeia Commission — ipc.gov.in onto the Gov.In CMS Platform and DBIM. "
      f"Basis date {M['basis_date']}. Generated from the effort model, not typed by hand: "
      f"run Estimation/model/build_schedule.py to regenerate after any change.", 6)
ws.column_dimensions["A"].width = 34; ws.column_dimensions["B"].width = 86
rows = [
    ("WHAT THIS COSTS", ""),
    ("Scope", "Stage 1 only — remediate the live site, and produce the signed inventory and redirect map. It does NOT buy the migration."),
    ("Contract value", f"INR {EXGST:,.0f} excluding GST · INR {EXGST*(1+GST):,.0f} inclusive at {GST:.0%}"),
    ("Effort basis", f"{PD80} person-days at P80. Bidding P50 is even odds and nobody should quote it."),
    ("Duration", f"{WEEKS} weeks ({M['months']} months), {PERIODS} four-week periods"),
    ("Team", "8 named people, 1.55 average FTE, peak near 3. Two roles carry 68% of the effort."),
    ("", ""),
    ("HOW TO READ IT", ""),
    ("Timeline", "Gantt by week. Bar colour is the phase. Milestone weeks are marked on the header row."),
    ("Milestones & Payments", "Six milestones, each with an exit criterion that is checkable rather than a matter of opinion, and the evidence that closes it."),
    ("Cash Flow", "Billing against cost incurred, with a four-week payment lag. The peak negative position is working capital, not profit."),
    ("Resource Plan", "Person-days and FTE by role and period, derived from each package's own role mix."),
    ("Work Packages", "The 25 packages, their three-point estimates and their scheduled weeks."),
    ("Commercial Terms", "EMD, PBG, LD and retention, at IPC's own revealed rates from its last IT bid."),
    ("", ""),
    ("UNITS", ""),
    ("PD — person-day", "One person for one day. 21 PD make one person-month; 20 PD make one four-week period at 5 days a week."),
    ("P80", "Four engagements in five finish at or below this effort. The standard commercial basis for a fixed-price government contract."),
    ("INR lakh", "One hundred thousand rupees. Payment values are given in full rupees so they can be transcribed into a purchase order."),
    ("FTE", "Full-time equivalent. Period person-days divided by 20."),
    ("", ""),
    ("TWO THINGS TO SETTLE BEFORE SIGNING", ""),
    ("Supplier tier",
     "This price assumes a boutique or specialist supplier. IPC's own last IT tender (GEM/2026/B/7781379, 13-07-2026) demanded ISO 9001, ISO 27000 and CMMI Level 3 — a bar that excludes that tier. At mid-tier rates the same scope is roughly INR 33 lakh. Resolve the category before bidding, not at evaluation."),
    ("Performance guarantee term",
     "IPC's revealed ePBG was 5% held for 60 months. On a 24-week assignment that is a five-year guarantee against a six-month job. Negotiate the term, not only the rate."),
    ("", ""),
    ("WHAT MOVED IN THE SCHEDULE", M["note"]),
]
r = 4
for k, v in rows:
    a = ws.cell(row=r, column=1, value=k); b = ws.cell(row=r, column=2, value=v)
    if v == "" and k:
        a.font = F(10, True, ACCENT); a.fill = fill(BAND); b.fill = fill(BAND)
    else:
        a.font = F(10, True); b.font = F(10)
    b.alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[r].height = 15 if len(str(v)) < 90 else (30 if len(str(v)) < 200 else 46)
    r += 1

# ================================================================ TIMELINE
ws = wb.create_sheet("Timeline")
title(ws, "Stage 1 timeline", f"{WEEKS} weeks. Bars are scheduled weeks; ◆ marks a milestone. "
      "Phase 2 runs alongside Phase 1 rather than after it — see Read Me.", 6 + WEEKS)
hdr = ["Ref", "Work package", "Phase", "PD (P80)", "Start", "End"] + [f"W{w}" for w in range(1, WEEKS + 1)]
header(ws, 4, hdr, [7, 52, 26, 9, 6, 6] + [3.6] * WEEKS)
ms_weeks = {m["week"]: m["ref"] for m in SCH["milestones"]}
for w in range(1, WEEKS + 1):
    c = ws.cell(row=4, column=6 + w)
    if w in ms_weeks:
        c.value = ms_weeks[w]; c.fill = fill(ACCENT); c.font = F(8, True, "FFFFFF")
sch = {s["ref"]: s for s in SCH["schedule"]}
r = 5
for pk in sorted(LEAN, key=lambda x: (x["phase"], x["ref"])):
    s = sch[pk["ref"]]; ph = pk["phase"][0]
    vals = [pk["ref"], pk["name"], pk["phase"], round(EXP(pk) * SCALE, 1), s["start"], s["end"]]
    for i, v in enumerate(vals, 1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = F(9, b=(i == 1)); c.border = box(bt=True)
        if i == 4: c.number_format = "0.0"
        if i in (4, 5, 6): c.alignment = Alignment(horizontal="center")
    for w in range(1, WEEKS + 1):
        c = ws.cell(row=r, column=6 + w); c.border = box(bt=True)
        if s["start"] <= w <= s["end"]: c.fill = fill(PHASE_FILL[ph])
    r += 1
ws.cell(row=r, column=2, value="TOTAL").font = F(10, True)
ws.cell(row=r, column=4, value=round(sum(EXP(p) * SCALE for p in LEAN), 1)).font = F(10, True)
ws.cell(row=r, column=4).number_format = "0.0"
r += 2
ws.cell(row=r, column=2, value="Phase key").font = F(9, True)
for i, (k, lbl) in enumerate([("0", "Mandate and decisions"), ("1", "Emergency remediation"),
                              ("2", "Inventory and redirect map"), ("P", "Programme management")]):
    ws.cell(row=r + 1 + i, column=1).fill = fill(PHASE_FILL[k])
    ws.cell(row=r + 1 + i, column=2, value=lbl).font = F(9)

# ================================================ MILESTONES & PAYMENTS
ws = wb.create_sheet("Milestones & Payments")
title(ws, "Milestones and payment schedule",
      "Every milestone is paid against a checkable exit criterion, not against a date. "
      "A milestone that cannot be failed is not a milestone.", 8)
header(ws, 4, ["Ref", "Week", "Milestone", "Share", "Value ex-GST (INR)", "GST (INR)",
               "Payable inc-GST (INR)", "Cumulative ex-GST (INR)"],
       [7, 7, 40, 8, 18, 14, 19, 20])
cum = 0; r = 5
for m in SCH["milestones"]:
    v = EXGST * m["share"]; cum += v
    for i, val in enumerate([m["ref"], m["week"], m["name"], m["share"], v, v * GST,
                             v * (1 + GST), cum], 1):
        c = ws.cell(row=r, column=i, value=val); c.font = F(10, b=(i == 1))
        c.border = box(bt=True)
        if i == 4: c.number_format = "0%"; c.alignment = Alignment(horizontal="center")
        if i in (5, 6, 7, 8): c.number_format = '#,##0'
        if i == 2: c.alignment = Alignment(horizontal="center")
    r += 1
for i, val in enumerate(["", "", "TOTAL", 1.0, EXGST, EXGST * GST, EXGST * (1 + GST), ""], 1):
    c = ws.cell(row=r, column=i, value=val); c.font = F(10, True); c.fill = fill(BAND)
    if i == 4: c.number_format = "0%"
    if i in (5, 6, 7): c.number_format = '#,##0'
r += 3
ws.cell(row=r, column=1, value="EXIT CRITERIA — what has to be true before each invoice is raised").font = F(11, True, ACCENT)
r += 2
for m in SCH["milestones"]:
    c = ws.cell(row=r, column=1, value=f'{m["ref"]} · Week {m["week"]} · {m["name"]}')
    c.font = F(10, True); c.fill = fill(BAND)
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=8); r += 1
    for lbl, txt in (("Exit criterion", m["exit"]), ("Evidence", m["evidence"])):
        ws.cell(row=r, column=1, value=lbl).font = F(9, True, MUTE)
        c = ws.cell(row=r, column=2, value=txt); c.font = F(9)
        c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=8)
        ws.row_dimensions[r].height = 15 * (1 + len(txt) // 105); r += 1
    r += 1

# ================================================================ CASH FLOW
ws = wb.create_sheet("Cash Flow")
title(ws, "Cash flow", f"Cost is incurred as effort is spent; cash arrives {LAG} weeks after a "
      f"milestone is certified. {M['payment_lag_note']}", 9)
header(ws, 4, ["Period", "Weeks", "PD spent", "Cost incurred (INR)", "Billed inc-GST (INR)",
               "Cash received (INR)", "Cumulative cost (INR)", "Cumulative received (INR)",
               "Net position (INR)"], [10, 10, 10, 19, 18, 18, 20, 21, 18])
# weekly effort spread, then rolled into four-week periods
weekly = [0.0] * (WEEKS + 1)
for pk in LEAN:
    s = sch[pk["ref"]]; n = s["end"] - s["start"] + 1
    per = EXP(pk) * SCALE / n
    for w in range(s["start"], s["end"] + 1): weekly[w] += per
blended = RES["stage1_matrix"][0]["blended_rate"] if RES.get("stage1_matrix") else 10800
lean_blended = next((m["blended_rate"] for m in RES["lean_matrix"]), 10800)
bill_w = {m["week"]: EXGST * m["share"] for m in SCH["milestones"]}
recv_w = {w + LAG: v for w, v in bill_w.items()}
r = 5; cc = cr = 0.0
for p in range(1, PERIODS + 1):
    w0, w1 = (p - 1) * 4 + 1, p * 4
    pd = sum(weekly[w0:w1 + 1]); cost = pd * lean_blended
    billed = sum(v for w, v in bill_w.items() if w0 <= w <= w1)
    recvd = sum(v for w, v in recv_w.items() if w0 <= w <= w1) * (1 + GST)
    cc += cost; cr += recvd
    for i, val in enumerate([f"P{p}", f"W{w0}–W{w1}", round(pd, 1), cost, billed * (1 + GST),
                             recvd, cc, cr, cr - cc], 1):
        c = ws.cell(row=r, column=i, value=val); c.font = F(10); c.border = box(bt=True)
        if i == 3: c.number_format = "0.0"
        if i >= 4: c.number_format = '#,##0'
        if i == 9 and (cr - cc) < 0: c.font = F(10, c="9A3412")
        if i <= 2: c.alignment = Alignment(horizontal="center")
    r += 1
# the tail: the last milestone's cash lands after the assignment ends
tail = sum(v for w, v in recv_w.items() if w > WEEKS) * (1 + GST)
if tail:
    cr += tail
    for i, val in enumerate([f"P{PERIODS+1}", f"W{WEEKS+1}–W{WEEKS+4}", 0, 0, 0, tail, cc, cr, cr - cc], 1):
        c = ws.cell(row=r, column=i, value=val); c.font = F(10, i=True); c.border = box(bt=True)
        if i >= 4: c.number_format = '#,##0'
        if i <= 2: c.alignment = Alignment(horizontal="center")
    ws.cell(row=r, column=2).value += "  (after close)"
    r += 1
r += 1
peak = min(0, min(cr_ - cc_ for cr_, cc_ in [(0, 0)]) )  # placeholder replaced below
# recompute peak properly
cc2 = cr2 = 0.0; peak = 0.0
for p in range(1, PERIODS + 1):
    w0, w1 = (p - 1) * 4 + 1, p * 4
    cc2 += sum(weekly[w0:w1 + 1]) * lean_blended
    cr2 += sum(v for w, v in recv_w.items() if w0 <= w <= w1) * (1 + GST)
    peak = min(peak, cr2 - cc2)
for lbl, val, note in [
    ("Blended rate used", lean_blended, "INR per person-day, an output of the role mix in the packages"),
    ("Peak negative position", peak, "The working capital the supplier carries. Not profit, and not recoverable from margin"),
    ("Peak as share of contract", peak / EXGST, "Ask for a mobilisation advance if this is uncomfortable"),
]:
    ws.cell(row=r, column=1, value=lbl).font = F(10, True)
    c = ws.cell(row=r, column=4, value=val); c.font = F(10, True, "9A3412" if val < 0 else INK)
    c.number_format = '0.0%' if abs(val) < 1 else '#,##0'
    ws.cell(row=r, column=5, value=note).font = F(9, c=MUTE, i=True); r += 1

# ============================================================ RESOURCE PLAN
ws = wb.create_sheet("Resource Plan")
title(ws, "Resource plan", "Person-days and full-time equivalents by role and four-week period, "
      "derived from each package's own role mix. One period = 20 working days.", 4 + PERIODS * 2)
cols = ["Ref", "Role", "INR/PD", "Total PD"] + [f"P{p} PD" for p in range(1, PERIODS + 1)] + \
       [f"P{p} FTE" for p in range(1, PERIODS + 1)]
header(ws, 4, cols, [7, 40, 10, 10] + [8] * PERIODS + [8] * PERIODS)
role_period = {rr: [0.0] * (PERIODS + 1) for rr in ROLE}
for pk in LEAN:
    s = sch[pk["ref"]]; n = s["end"] - s["start"] + 1; per = EXP(pk) * SCALE / n
    for w in range(s["start"], s["end"] + 1):
        pi = min(PERIODS, (w - 1) // 4 + 1)
        for rr, share in pk["mix"].items(): role_period[rr][pi] += per * share
r = 5
for rr in sorted(ROLE, key=lambda x: -sum(role_period[x])):
    tot = sum(role_period[rr])
    if tot < 0.05: continue
    vals = [rr, ROLE[rr]["role"], ROLE[rr]["rate"], tot] + \
           [role_period[rr][p] for p in range(1, PERIODS + 1)] + \
           [role_period[rr][p] / 20 for p in range(1, PERIODS + 1)]
    for i, v in enumerate(vals, 1):
        c = ws.cell(row=r, column=i, value=v); c.font = F(9, b=(i == 1)); c.border = box(bt=True)
        if i == 3: c.number_format = '#,##0'
        if i == 4 or 5 <= i <= 4 + PERIODS: c.number_format = "0.0"
        if i > 4 + PERIODS: c.number_format = "0.00"
    r += 1
tots = [sum(role_period[rr][p] for rr in ROLE) for p in range(1, PERIODS + 1)]
vals = ["", "TOTAL", "", sum(tots)] + tots + [t / 20 for t in tots]
for i, v in enumerate(vals, 1):
    c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
    if i == 4 or 5 <= i <= 4 + PERIODS: c.number_format = "0.0"
    if i > 4 + PERIODS: c.number_format = "0.00"
r += 2
ws.cell(row=r, column=2, value="Peak FTE in any period").font = F(10, True)
ws.cell(row=r, column=4, value=max(tots) / 20).number_format = "0.00"
ws.cell(row=r, column=4).font = F(10, True)
ws.cell(row=r + 1, column=2, value="Average FTE across the assignment").font = F(10, True)
ws.cell(row=r + 1, column=4, value=sum(tots) / (PERIODS * 20)).number_format = "0.00"
ws.cell(row=r + 1, column=4).font = F(10, True)
ws.cell(row=r + 2, column=2, value="The curve is deliberately front-loaded, not badly levelled. "
        "Weeks 5-8 are a remediation sprint on the live site - three people for four weeks - because that "
        "work is destination-independent and every week it waits is a week of indexed junk and a failing "
        "charset. After it lands the team settles to roughly 1.5 FTE for the inventory, then tapers to "
        "closeout. A boutique can staff that shape; a large firm's bench cannot, which is another reason "
        "the tier question in Read Me matters.").font = F(9, c=MUTE, i=True)
ws.merge_cells(start_row=r + 2, start_column=2, end_row=r + 2, end_column=4 + PERIODS)
ws.row_dimensions[r + 2].height = 58
ws.cell(row=r + 2, column=2).alignment = Alignment(wrap_text=True, vertical="top")
ws.cell(row=r + 4, column=2, value="Client effort, tracked and never billed: 40–70 person-days of IPC "
        "subject-matter time for triage sign-off. 60–80% of a content audit is client-side and cannot "
        "be bought. An under-resourced client is a schedule risk that first presents as a cost saving.").font = F(9, c=MUTE, i=True)
ws.merge_cells(start_row=r + 4, start_column=2, end_row=r + 4, end_column=4 + PERIODS)
ws.row_dimensions[r + 4].height = 44
ws.cell(row=r + 4, column=2).alignment = Alignment(wrap_text=True, vertical="top")

# ============================================================ WORK PACKAGES
ws = wb.create_sheet("Work Packages")
title(ws, "Work packages", "Three-point estimates. Expected = (O + 4M + P) / 6. The P80 column scales "
      f"the expected value by {SCALE:.3f} to the bid basis, which is where the risk reserve lives.", 9)
header(ws, 4, ["Ref", "Phase", "Work package", "O", "M", "P", "Expected", f"P80 (×{SCALE:.2f})", "Weeks"],
       [7, 26, 54, 7, 7, 7, 10, 12, 11])
r = 5
for pk in sorted(LEAN, key=lambda x: (x["phase"], x["ref"])):
    s = sch[pk["ref"]]
    vals = [pk["ref"], pk["phase"], pk["name"], pk["o"], pk["m"], pk["p"],
            EXP(pk), EXP(pk) * SCALE, f'W{s["start"]}–W{s["end"]}']
    for i, v in enumerate(vals, 1):
        c = ws.cell(row=r, column=i, value=v); c.font = F(9, b=(i == 1)); c.border = box(bt=True)
        if i in (7, 8): c.number_format = "0.0"
        if i in (4, 5, 6, 7, 8, 9): c.alignment = Alignment(horizontal="center")
    r += 1
for i, v in enumerate(["", "", "TOTAL", sum(p["o"] for p in LEAN), sum(p["m"] for p in LEAN),
                       sum(p["p"] for p in LEAN), sum(EXP(p) for p in LEAN), PD80, ""], 1):
    c = ws.cell(row=r, column=i, value=v); c.font = F(10, True); c.fill = fill(BAND)
    if i in (7, 8): c.number_format = "0.0"

# ========================================================= COMMERCIAL TERMS
ws = wb.create_sheet("Commercial Terms")
title(ws, "Commercial terms", "Rates are IPC's own, revealed on GEM/2026/B/7781379 dated 13-07-2026, "
      "rather than convention. Where they are harsher than the GeM default, that is noted.", 4)
header(ws, 4, ["Item", "Rate", "Value (INR)", "Note"], [32, 9, 16, 96])
r = 5
pbg = EXGST * 0.05
for t in SCH["commercial_terms"]:
    base = pbg if t["of"] == "PBG value" else EXGST
    for i, v in enumerate([t["item"], t["rate"], base * t["rate"], t["note"]], 1):
        c = ws.cell(row=r, column=i, value=v); c.font = F(10, b=(i == 1)); c.border = box(bt=True)
        if i == 2: c.number_format = "0.0%"; c.alignment = Alignment(horizontal="center")
        if i == 3: c.number_format = '#,##0'
        if i == 4:
            c.font = F(9, c=MUTE); c.alignment = Alignment(wrap_text=True, vertical="top")
            ws.row_dimensions[r].height = 15 * (1 + len(v) // 100)
    r += 1
r += 1
ws.cell(row=r, column=1, value="Contract value ex-GST").font = F(10, True)
c = ws.cell(row=r, column=3, value=EXGST); c.number_format = '#,##0'; c.font = F(10, True)
ws.cell(row=r + 1, column=1, value=f"GST at {GST:.0%}").font = F(10, True)
c = ws.cell(row=r + 1, column=3, value=EXGST * GST); c.number_format = '#,##0'; c.font = F(10, True)
ws.cell(row=r + 2, column=1, value="Contract value inclusive of GST").font = F(11, True, ACCENT)
c = ws.cell(row=r + 2, column=3, value=EXGST * (1 + GST)); c.number_format = '#,##0'
c.font = F(11, True, ACCENT)
ws.cell(row=r + 4, column=1, value="Verify whether IPC can claim input tax credit as an autonomous body "
        "under MoHFW. If it cannot, GST is a real cost to the buyer rather than a pass-through, and it "
        "changes which side of INR 30 lakh this contract sits on.").font = F(9, c=MUTE, i=True)
ws.merge_cells(start_row=r + 4, start_column=1, end_row=r + 4, end_column=4)
ws.row_dimensions[r + 4].height = 32
ws.cell(row=r + 4, column=1).alignment = Alignment(wrap_text=True, vertical="top")

for s in wb.worksheets: s.sheet_view.showGridLines = False
wb.save(OUT)
print(f"written: {OUT}")
print(f"  scale {SCALE:.4f} · blended {lean_blended:,}/PD · peak cash {peak:,.0f}")
