#!/usr/bin/env python3
"""Build the two priced offer workbooks, each scoped to a stated final cost.

    python3 Estimation/model/build_variants.py

Scope is solved back from the ceiling, not the other way round: the rates and
the method are fixed, the scope is cut until it fits, and the margin that falls
out is reported rather than hidden. If the margin were absurd the offer would
not be viable, and the workbook would say so.
"""
import copy, json, pathlib, importlib.util
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, Reference
from openpyxl.chart.series import DataPoint

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("sim", HERE / "simulate.py")
sim = importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)

WBS = json.load(open(HERE / "wbs.json"))
SCH = json.load(open(HERE / "schedule.json"))
VAR = json.load(open(HERE / "variants.json"))
RES = json.load(open(HERE / "results.json"))
GST = WBS["commercials"]["gst"]
FX = VAR["meta"]["fx"]["usd_inr"]
LIC = VAR["meta"]["licence"]
ROLE = {r["ref"]: r for r in WBS["roles"]}
EXP = lambda p: (p["o"] + 4 * p["m"] + p["p"]) / 6
LEAN = [p for p in WBS["packages"] if p["stage"] == 1 and not p.get("lean_excluded")]
RISKS1 = [r for r in WBS["risks"] if r["stage"] == 1 and r["ref"] != "E13"]
S1SCH = {s["ref"]: s for s in SCH["schedule"]}
BASE_W = SCH["meta"]["stage1_weeks"]

INK, MUTE, RULE, BAND, HEAD, ACCENT = "1C1917", "78716C", "E7E5E4", "FAFAF9", "292524", "B45309"
PH = {"0": "8C7A5B", "1": "9A6A4F", "2": "4F6B7A", "P": "6B6459"}
ROLE_COL = {"ME": "4F6B7A", "BA": "8C7A5B", "EL": "9A6A4F", "SA": "5B6E4F",
            "SE": "7A5B6B", "QA": "4F5F7A", "CO": "6B6459", "AX": "A88B4A"}
def F(sz=10, b=False, c=INK, i=False): return Font(name="Calibri", size=sz, bold=b, color=c, italic=i)
def fill(h): return PatternFill("solid", fgColor=h)
BB = Border(bottom=Side(style="thin", color=RULE))
def mrg(ws, r1, c1, r2, c2): ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)


def resolve(v):
    """Apply the variant's drops and resizes, then simulate and solve for margin."""
    pk = []
    for p in copy.deepcopy(LEAN):
        if p["ref"] in v["drop"]: continue
        if p["ref"] in v["resize"]:
            p["_was"] = (p["o"], p["m"], p["p"])
            p["o"], p["m"], p["p"] = v["resize"][p["ref"]]
        pk.append(p)
    tot, draws = sim.simulate(pk, RISKS1, 0.5)
    pct = {f"P{q}": float(sim.np.percentile(tot, q)) for q in (50, 70, 80, 90)}
    split = sim.role_split(pk, WBS["roles"]); base = sum(split.values())
    bl = sum(split[k] * ROLE[k]["rate"] * 0.72 for k in split) / base
    licence = LIC["usd_per_month"] * v["licence_months"] * FX
    pt = v["tooling_inr"] + licence
    cost = pct["P80"] * bl + pt
    ex = v["target_inc_gst"] / (1 + GST)
    wk = v["weeks"]
    sched = {}
    for p in pk:
        s = S1SCH[p["ref"]]
        a = max(1, round(s["start"] * wk / BASE_W))
        b = min(wk, max(a, round(s["end"] * wk / BASE_W)))
        sched[p["ref"]] = {"start": a, "end": b}
    var = draws.var(axis=0)
    drivers = [{"ref": pk[i]["ref"], "name": pk[i]["name"], "share": float(var[i] / var.sum())}
               for i in sim.np.argsort(var)[::-1][:5]]
    return {"pkgs": pk, "pct": pct, "pd": pct["P80"], "blended": bl, "licence": licence,
            "pt": pt, "cost": cost, "ex": ex, "inc": v["target_inc_gst"],
            "margin": 1 - cost / ex, "sched": sched, "split": split, "weeks": wk,
            "drivers": drivers}


def build(v, m):
    wb = Workbook(); wb.remove(wb.active)
    NP = (v["weeks"] + 3) // 4

    def title(ws, t, sub, width):
        ws["A1"] = t; ws["A1"].font = F(15, True)
        ws["A2"] = sub; ws["A2"].font = F(9, c=MUTE, i=True)
        mrg(ws, 1, 1, 1, width); mrg(ws, 2, 1, 2, width)
        ws.row_dimensions[1].height = 22; ws.row_dimensions[2].height = 28
        ws["A2"].alignment = Alignment(wrap_text=True, vertical="top")

    def header(ws, row, labels, widths=None):
        for i, h in enumerate(labels, 1):
            c = ws.cell(row=row, column=i, value=h)
            c.font = F(9, True, "FFFFFF"); c.fill = fill(HEAD)
            c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        ws.row_dimensions[row].height = 30
        if widths:
            for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = ws.cell(row=row + 1, column=1)

    def kv(ws, r, k, val, head=False, wrap=108):
        a = ws.cell(row=r, column=1, value=k); b = ws.cell(row=r, column=2, value=val)
        if head: a.font = F(10, True, ACCENT); a.fill = fill(BAND); b.fill = fill(BAND)
        else: a.font = F(10, True); b.font = F(10)
        b.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 15 * max(1, -(-len(str(val)) // wrap))
        return r + 1

    # ------------------------------------------------------------ THE OFFER
    ws = wb.create_sheet("The Offer")
    title(ws, f'{v["label"]} · {v["headline"]}',
          f'ipc.gov.in onto the Gov.In CMS Platform and DBIM. Stage 1 scoped to a final cost of '
          f'INR {v["target_inc_gst"]:,.0f} inclusive of GST. Basis date {SCH["meta"]["basis_date"]}. '
          "Generated from the effort model — regenerate rather than edit cells.", 4)
    ws.column_dimensions["A"].width = 32; ws.column_dimensions["B"].width = 104
    r = 4
    r = kv(ws, r, "THE PRICE", "", True)
    r = kv(ws, r, "Final cost", f'INR {m["inc"]:,.0f} inclusive of GST at {GST:.0%}')
    r = kv(ws, r, "Contract value", f'INR {m["ex"]:,.0f} excluding GST')
    r = kv(ws, r, "Effort", f'{m["pd"]:.0f} person-days at P80, {v["weeks"]} weeks, '
           f'{len(m["pkgs"])} work packages')
    r = kv(ws, r, "Supplier margin", f'{m["margin"]:.1%} — reported, not hidden. Scope was cut until it '
           "fit the ceiling; the margin is what fell out. Below about 10% this stops being a viable "
           "engagement and the ceiling should move instead of the scope.")
    r += 1
    r = kv(ws, r, "WHAT IT BUYS", "", True)
    r = kv(ws, r, "Included", v["buys"])
    r = kv(ws, r, "NOT included", v["not_buys"])
    r = kv(ws, r, "Not in either offer", "The migration itself. Stage 2 is a separate procurement and "
           f'is indicatively INR {RES["views"]["stage2"]["P80"]:.0f} person-days — around INR 27.8 lakh '
           "ex-GST — but that figure must be re-derived from this engagement's register before anyone "
           "commits to it.")
    r += 1
    r = kv(ws, r, "TOOLING", "", True)
    r = kv(ws, r, LIC["name"],
           f'{LIC["seats"]} seat x {v["licence_months"]} months x USD {LIC["usd_per_month"]}/month '
           f'at INR {FX}/USD = INR {m["licence"]:,.0f}. Carried in the cost base and priced into the '
           "contract value above.")
    r = kv(ws, r, "Price basis", LIC["source"])
    r = kv(ws, r, "Tax treatment", LIC["gst_note"])
    r = kv(ws, r, "FX basis", VAR["meta"]["fx"]["basis"])
    r = kv(ws, r, "What it is for", "The analytical core of this engagement — reconciling four inventory "
           "sources, fingerprinting templates across the estate, and deciding redirect dispositions — is "
           "exactly the work an assistant accelerates. No productivity multiplier has been applied to the "
           "unit rates, because there is no evidence base for a specific one. The licence is carried as a "
           "cost the supplier bears, not as a discount to IPC.")
    r += 1
    r = kv(ws, r, "HOW TO READ IT", "", True)
    for k, val in [("Scope", "Every package, and every package cut or resized to make the ceiling, shown side by side with the full Stage 1 scope."),
                   ("Timeline", f"Gantt by week across {v['weeks']} weeks. ◆ marks a milestone."),
                   ("Milestones & Payments", "Each paid against an exit criterion that can be failed."),
                   ("Cash Flow", "Cost against cash on a four-week payment lag. The peak negative position is working capital."),
                   ("Resource Plan", "Person-days and FTE by role and four-week period."),
                   ("Charts", "Live Gantt and resource-loading charts, driven by the data block to their right."),
                   ("Commercials", "Price build-up, rate card, and EMD, PBG and LD at IPC's own revealed rates.")]:
        r = kv(ws, r, k, val)
    r += 1
    r = kv(ws, r, "SETTLE BEFORE SIGNING", "", True)
    r = kv(ws, r, "Supplier tier", "This price assumes a boutique or specialist supplier. IPC's own last "
           "IT tender (GEM/2026/B/7781379, 13-07-2026) demanded ISO 9001, ISO 27000 and CMMI Level 3 — a "
           "bar that excludes that tier. At mid-tier rates this scope is roughly 40% more. Resolve the "
           "procurement category before bidding, not at evaluation.")
    r = kv(ws, r, "Client effort", "40–70 person-days of IPC subject-matter time for triage sign-off, "
           "tracked and never billed. 60–80% of a content audit is client-side and cannot be bought.")

    # ----------------------------------------------------------------- SCOPE
    ws = wb.create_sheet("Scope")
    title(ws, "Scope — what fits the ceiling and what does not",
          "Design to cost, shown honestly: the full Stage 1 scope alongside what this offer carries. "
          "Anything cut here reappears in Stage 2, usually dearer.", 7)
    header(ws, 4, ["Ref", "Phase", "Work package", "Full O/M/P", "This offer O/M/P",
                   "Expected PD", "Status"], [7, 24, 50, 14, 16, 11, 30])
    full = {p["ref"]: p for p in LEAN}
    here = {p["ref"]: p for p in m["pkgs"]}
    r = 5
    for ref in sorted(full, key=lambda x: (full[x]["phase"], x)):
        fp = full[ref]; hp = here.get(ref)
        fo = f'{fp["o"]}/{fp["m"]}/{fp["p"]}'
        if hp is None:
            ho, exp, st, col = "—", "", "CUT — moves to Stage 2", "9A3412"
        elif "_was" in hp:
            ho, exp, st, col = f'{hp["o"]}/{hp["m"]}/{hp["p"]}', EXP(hp), "Reduced depth", "B45309"
        else:
            ho, exp, st, col = fo, EXP(hp), "Full", "166534"
        for i, val in enumerate([ref, fp["phase"], fp["name"], fo, ho, exp, st], 1):
            c = ws.cell(row=r, column=i, value=val); c.border = BB
            c.font = F(9, b=(i == 1), c=(MUTE if hp is None else INK))
            if i == 6: c.number_format = "0.0"
            if i in (4, 5, 6): c.alignment = Alignment(horizontal="center")
            if i == 7: c.font = F(9, True, col)
        r += 1
    for i, val in enumerate(["", "", "TOTAL", f'{sum(EXP(p) for p in LEAN):.1f} PD expected',
                             f'{sum(EXP(p) for p in m["pkgs"]):.1f} PD expected',
                             sum(EXP(p) for p in m["pkgs"]), f'{m["pd"]:.0f} PD at P80'], 1):
        c = ws.cell(row=r, column=i, value=val); c.font = F(10, True); c.fill = fill(BAND)
        if i == 6: c.number_format = "0.0"

    # -------------------------------------------------------------- TIMELINE
    ws = wb.create_sheet("Timeline")
    W = v["weeks"]
    title(ws, "Timeline", f'{W} weeks. Bars are scheduled weeks; ◆ marks a milestone. '
          "Phase 2 runs alongside Phase 1 rather than after it — the 302-to-404 behaviour is a usable "
          "existence oracle, so the inventory is not blocked on the 404 fix.", 6 + W)
    header(ws, 4, ["Ref", "Work package", "Phase", "PD", "Start", "End"] +
           [f"W{w}" for w in range(1, W + 1)], [7, 48, 24, 8, 6, 6] + [3.4] * W)
    msw = {x["week"]: x["ref"] for x in v["milestones"]}
    for w in range(1, W + 1):
        c = ws.cell(row=4, column=6 + w)
        if w in msw: c.value = msw[w]; c.fill = fill(ACCENT); c.font = F(8, True, "FFFFFF")
    scale = m["pd"] / sum(EXP(p) for p in m["pkgs"])
    r = 5
    for pk in sorted(m["pkgs"], key=lambda x: (x["phase"], x["ref"])):
        s = m["sched"][pk["ref"]]
        for i, val in enumerate([pk["ref"], pk["name"], pk["phase"], round(EXP(pk) * scale, 1),
                                 s["start"], s["end"]], 1):
            c = ws.cell(row=r, column=i, value=val); c.font = F(9, b=(i == 1)); c.border = BB
            if i == 4: c.number_format = "0.0"
            if i >= 4: c.alignment = Alignment(horizontal="center")
        for w in range(1, W + 1):
            c = ws.cell(row=r, column=6 + w); c.border = BB
            if s["start"] <= w <= s["end"]: c.fill = fill(PH[pk["phase"][0]])
        r += 1

    # -------------------------------------------------- MILESTONES & PAYMENTS
    ws = wb.create_sheet("Milestones & Payments")
    title(ws, "Milestones and payment schedule",
          f'Contract value INR {m["ex"]:,.0f} ex-GST, INR {m["inc"]:,.0f} inclusive. Every milestone is '
          "paid against a checkable exit criterion, not a date.", 7)
    header(ws, 4, ["Ref", "Week", "Milestone", "Share", "Ex-GST (INR)", "Payable inc-GST (INR)",
                   "Cumulative ex-GST (INR)"], [7, 7, 42, 8, 17, 20, 21])
    r = 5; cum = 0
    for x in v["milestones"]:
        val = m["ex"] * x["share"]; cum += val
        for i, y in enumerate([x["ref"], x["week"], x["name"], x["share"], val,
                               val * (1 + GST), cum], 1):
            c = ws.cell(row=r, column=i, value=y); c.font = F(10, b=(i == 1)); c.border = BB
            if i == 4: c.number_format = "0%"
            if i in (2, 4): c.alignment = Alignment(horizontal="center")
            if i >= 5: c.number_format = '#,##0'
        r += 1
    for i, y in enumerate(["", "", "TOTAL", 1.0, m["ex"], m["inc"], ""], 1):
        c = ws.cell(row=r, column=i, value=y); c.font = F(10, True); c.fill = fill(BAND)
        if i == 4: c.number_format = "0%"
        if i >= 5: c.number_format = '#,##0'
    r += 3
    ws.cell(row=r, column=1, value="EXIT CRITERIA — what must be true before each invoice is raised").font = F(11, True, ACCENT)
    r += 2
    for x in v["milestones"]:
        c = ws.cell(row=r, column=1, value=f'{x["ref"]} · Week {x["week"]} · {x["name"]}')
        c.font = F(10, True); c.fill = fill(BAND); mrg(ws, r, 1, r, 7); r += 1
        for lbl, txt in (("Exit criterion", x["exit"]), ("Evidence", x["evidence"])):
            ws.cell(row=r, column=1, value=lbl).font = F(9, True, MUTE)
            c = ws.cell(row=r, column=2, value=txt); c.font = F(9)
            c.alignment = Alignment(wrap_text=True, vertical="top")
            mrg(ws, r, 2, r, 7); ws.row_dimensions[r].height = 14 * (1 + len(txt) // 110); r += 1
        r += 1

    # ------------------------------------------------------------- CASH FLOW
    ws = wb.create_sheet("Cash Flow")
    title(ws, "Cash flow", "Cost is incurred as effort is spent; cash arrives four weeks after a "
          "milestone is certified. The licence is paid monthly from week 1 whatever the billing "
          "schedule does.", 8)
    header(ws, 4, ["Period", "Weeks", "PD spent", "Cost incurred (INR)", "Billed inc-GST (INR)",
                   "Cash received (INR)", "Cumulative cost (INR)", "Net position (INR)"],
           [9, 11, 10, 18, 18, 18, 19, 18])
    weekly = [0.0] * (W + 9); wcost = [0.0] * (W + 9)
    for pk in m["pkgs"]:
        s = m["sched"][pk["ref"]]; n = s["end"] - s["start"] + 1; per = EXP(pk) * scale / n
        for w in range(s["start"], s["end"] + 1):
            weekly[w] += per; wcost[w] += per * m["blended"]
    wcost[1] += v["tooling_inr"]
    for mo in range(v["licence_months"]):                       # licence, monthly
        wk = min(W, mo * 4 + 1); wcost[wk] += LIC["usd_per_month"] * FX
    bill = {x["week"]: m["ex"] * x["share"] for x in v["milestones"]}
    recv = {w + 4: y for w, y in bill.items()}
    r = 5; cc = cr = 0.0; peak = 0.0
    for p in range(1, (W + 4) // 4 + 1):
        w0, w1 = (p - 1) * 4 + 1, p * 4
        pd = sum(weekly[w0:w1 + 1]); cost = sum(wcost[w0:w1 + 1])
        b = sum(y for w, y in bill.items() if w0 <= w <= w1) * (1 + GST)
        rc = sum(y for w, y in recv.items() if w0 <= w <= w1) * (1 + GST)
        cc += cost; cr += rc; peak = min(peak, cr - cc)
        for i, y in enumerate([f"P{p}", f"W{w0}–W{w1}", round(pd, 1), cost, b, rc, cc, cr - cc], 1):
            c = ws.cell(row=r, column=i, value=y); c.border = BB
            c.font = F(10, c=("9A3412" if i == 8 and (cr - cc) < 0 else INK))
            if i == 3: c.number_format = "0.0"
            if i >= 4: c.number_format = '#,##0'
            if i <= 2: c.alignment = Alignment(horizontal="center")
        r += 1
    r += 1
    for lbl, val, note in [
        ("Blended rate", m["blended"], "INR/PD — an output of the role mix, not an input"),
        ("Licence in the cost base", m["licence"], f'{LIC["name"]}, {v["licence_months"]} months'),
        ("Peak negative position", peak, "Working capital, not margin"),
        ("Peak as share of contract", peak / m["ex"], "Ask for a mobilisation advance if uncomfortable"),
    ]:
        ws.cell(row=r, column=1, value=lbl).font = F(10, True)
        c = ws.cell(row=r, column=4, value=val); c.font = F(10, True, "9A3412" if val < 0 else INK)
        c.number_format = '0.0%' if abs(val) < 1 else '#,##0'
        ws.cell(row=r, column=5, value=note).font = F(9, c=MUTE, i=True); r += 1

    # --------------------------------------------------------- RESOURCE PLAN
    ws = wb.create_sheet("Resource Plan")
    title(ws, "Resource plan", "Person-days by role and four-week period, derived from each package's "
          "own role mix. One period = 20 working days.", 4 + NP)
    header(ws, 4, ["Ref", "Role", "INR/PD", "Total PD"] + [f"P{p}" for p in range(1, NP + 1)],
           [7, 38, 9, 10] + [8] * NP)
    rp = {rr: [0.0] * (NP + 2) for rr in ROLE}
    for pk in m["pkgs"]:
        s = m["sched"][pk["ref"]]; n = s["end"] - s["start"] + 1; per = EXP(pk) * scale / n
        for w in range(s["start"], s["end"] + 1):
            pi = min(NP, (w - 1) // 4 + 1)
            for rr, sh in pk["mix"].items(): rp[rr][pi] += per * sh
    order = [rr for rr in sorted(ROLE, key=lambda x: -sum(rp[x])) if sum(rp[rr]) > 0.05]
    r = 5
    for rr in order:
        for i, y in enumerate([rr, ROLE[rr]["role"], ROLE[rr]["rate"] * 0.72, sum(rp[rr])] +
                              [rp[rr][p] or "" for p in range(1, NP + 1)], 1):
            c = ws.cell(row=r, column=i, value=y); c.font = F(9, b=(i == 1)); c.border = BB
            if i == 3: c.number_format = '#,##0'
            if i >= 4: c.number_format = "0.0"
        r += 1
    tots = [sum(rp[rr][p] for rr in ROLE) for p in range(1, NP + 1)]
    for i, y in enumerate(["", "TOTAL PD", "", sum(tots)] + tots, 1):
        c = ws.cell(row=r, column=i, value=y); c.font = F(10, True); c.fill = fill(BAND)
        if i >= 4: c.number_format = "0.0"
    r += 1
    for i, y in enumerate(["", "FTE", "", ""] + [t / 20 for t in tots], 1):
        c = ws.cell(row=r, column=i, value=y); c.font = F(10, True); c.fill = fill(BAND)
        if i >= 5: c.number_format = "0.00"

    # ---------------------------------------------------------------- CHARTS
    ws = wb.create_sheet("Charts")
    title(ws, "Charts", "Live Excel charts driven by the data block in column T. A Gantt here is a "
          "stacked bar whose first series is invisible and carries the start week.", 8)
    DC = 20
    rows = [(f'{p["ref"]} {p["name"][:42]}', m["sched"][p["ref"]]["start"],
             m["sched"][p["ref"]]["end"] - m["sched"][p["ref"]]["start"] + 1, PH[p["phase"][0]])
            for p in sorted(m["pkgs"], key=lambda x: (m["sched"][x["ref"]]["start"], x["ref"]))]
    r0 = 4
    for i, h in enumerate(["Item", "Start-1", "Duration"]):
        c = ws.cell(row=r0, column=DC + i, value=h); c.font = F(9, True, "FFFFFF"); c.fill = fill(HEAD)
    for i, (lbl, st, du, _c) in enumerate(rows, 1):
        ws.cell(row=r0 + i, column=DC, value=lbl).font = F(9)
        ws.cell(row=r0 + i, column=DC + 1, value=st - 1).font = F(9)
        ws.cell(row=r0 + i, column=DC + 2, value=du).font = F(9)
    ch = BarChart(); ch.type = "bar"; ch.grouping = "stacked"; ch.overlap = 100
    ch.title = f'Gantt — {len(rows)} work packages, {W} weeks'; ch.height = 17; ch.width = 28
    ch.add_data(Reference(ws, min_col=DC + 1, max_col=DC + 2, min_row=r0, max_row=r0 + len(rows)),
                titles_from_data=True)
    ch.set_categories(Reference(ws, min_col=DC, min_row=r0 + 1, max_row=r0 + len(rows)))
    ch.series[0].graphicalProperties.noFill = True
    ch.series[0].graphicalProperties.line.noFill = True
    for i, (_l, _s, _d, col) in enumerate(rows):
        dp = DataPoint(idx=i); dp.graphicalProperties.solidFill = col
        dp.graphicalProperties.line.solidFill = col
        ch.series[1].data_points.append(dp)
    ch.x_axis.scaling.orientation = "maxMin"
    ch.y_axis.scaling.min = 0; ch.y_axis.scaling.max = W
    ch.y_axis.title = "Week"; ch.y_axis.delete = False; ch.x_axis.delete = False; ch.legend = None
    ws.add_chart(ch, "A5")
    rr0 = r0 + len(rows) + 3
    ws.cell(row=rr0, column=DC, value="Role").font = F(9, True, "FFFFFF")
    ws.cell(row=rr0, column=DC).fill = fill(HEAD)
    for pi in range(1, NP + 1):
        c = ws.cell(row=rr0, column=DC + pi, value=f"P{pi}")
        c.font = F(9, True, "FFFFFF"); c.fill = fill(HEAD)
    for i, rr in enumerate(order, 1):
        ws.cell(row=rr0 + i, column=DC, value=ROLE[rr]["role"]).font = F(9)
        for pi in range(1, NP + 1):
            ws.cell(row=rr0 + i, column=DC + pi, value=round(rp[rr][pi], 2)).font = F(9)
    rc = BarChart(); rc.type = "col"; rc.grouping = "stacked"; rc.overlap = 100
    rc.title = f"Resource loading — person-days by role, {NP} four-week periods (÷20 for FTE)"
    rc.height = 11; rc.width = 28
    rc.add_data(Reference(ws, min_col=DC, max_col=DC + NP, min_row=rr0 + 1, max_row=rr0 + len(order)),
                titles_from_data=True, from_rows=True)
    rc.set_categories(Reference(ws, min_col=DC + 1, max_col=DC + NP, min_row=rr0))
    for i, rr in enumerate(order):
        rc.series[i].graphicalProperties.solidFill = ROLE_COL.get(rr, "9CA3AF")
        rc.series[i].graphicalProperties.line.solidFill = "FFFFFF"
    rc.y_axis.title = "Person-days"; rc.x_axis.title = "Four-week period"
    rc.y_axis.delete = False; rc.x_axis.delete = False
    ws.add_chart(rc, "A41")
    ws.column_dimensions["A"].width = 14
    ws.column_dimensions[get_column_letter(DC)].width = 40
    for cc in range(DC + 1, DC + NP + 2): ws.column_dimensions[get_column_letter(cc)].width = 9

    # ----------------------------------------------------------- COMMERCIALS
    ws = wb.create_sheet("Commercials")
    title(ws, "Commercials", "Price built up from the bottom, so every rupee is traceable. Rates are "
          "boutique tier; commercial terms are IPC's own revealed rates from GEM/2026/B/7781379.", 5)
    ws.column_dimensions["A"].width = 36
    for cl, w in (("B", 18), ("C", 16), ("D", 16), ("E", 72)): ws.column_dimensions[cl].width = w
    r = 4
    ws.cell(row=r, column=1, value="PRICE BUILD-UP").font = F(11, True, ACCENT); r += 1
    for lbl, val, note in [
        ("Effort at P80", m["pd"], f'person-days, {len(m["pkgs"])} packages'),
        ("Blended rate", m["blended"], "INR/PD, boutique tier, output of the role mix"),
        ("Effort cost", m["pd"] * m["blended"], ""),
        (f'{LIC["name"]} licence', m["licence"],
         f'{v["licence_months"]} months x USD {LIC["usd_per_month"]} at INR {FX}/USD'),
        ("Tooling and data", v["tooling_inr"], "Crawl and validation tooling, commercial traffic data"),
        ("Total cost", m["cost"], ""),
        ("Margin", m["margin"], "Solved so the contract lands exactly on the ceiling"),
        ("Contract value ex-GST", m["ex"], ""),
        (f'GST at {GST:.0%}', m["ex"] * GST, "Verify whether IPC can claim input credit"),
        ("FINAL COST INC-GST", m["inc"], "The stated ceiling"),
    ]:
        c1 = ws.cell(row=r, column=1, value=lbl)
        c2 = ws.cell(row=r, column=3, value=val)
        c1.font = F(11 if "FINAL" in lbl else 10, True, ACCENT if "FINAL" in lbl else INK)
        c2.font = F(11 if "FINAL" in lbl else 10, True, ACCENT if "FINAL" in lbl else INK)
        c2.number_format = '0.0%' if lbl == "Margin" else ('#,##0.0' if lbl == "Effort at P80" else '#,##0')
        ws.cell(row=r, column=5, value=note).font = F(9, c=MUTE, i=True)
        c1.border = BB; c2.border = BB; r += 1
    r += 2
    ws.cell(row=r, column=1, value="RATE CARD — boutique tier").font = F(11, True, ACCENT); r += 1
    header(ws, r, ["Ref", "Role", "INR/PD", "PD", "Note"], None); r += 1
    for rr in order:
        for i, y in enumerate([rr, ROLE[rr]["role"], ROLE[rr]["rate"] * 0.72, sum(rp[rr]),
                               ROLE[rr].get("note", "")], 1):
            c = ws.cell(row=r, column=i, value=y); c.border = BB; c.font = F(9, b=(i == 1))
            if i == 3: c.number_format = '#,##0'
            if i == 4: c.number_format = "0.0"
            if i == 5: c.font = F(9, c=MUTE); c.alignment = Alignment(wrap_text=True, vertical="top")
        r += 1
    r += 2
    ws.cell(row=r, column=1, value="COMMERCIAL TERMS").font = F(11, True, ACCENT); r += 1
    header(ws, r, ["Item", "Rate", "Value (INR)", "", "Note"], None); r += 1
    pbg = m["ex"] * 0.05
    for t in SCH["commercial_terms"]:
        base = pbg if t["of"] == "PBG value" else m["ex"]
        for i, y in enumerate([t["item"], t["rate"], base * t["rate"], "", t["note"]], 1):
            c = ws.cell(row=r, column=i, value=y); c.border = BB; c.font = F(9, b=(i == 1))
            if i == 2: c.number_format = "0.0%"; c.alignment = Alignment(horizontal="center")
            if i == 3: c.number_format = '#,##0'
            if i == 5:
                c.font = F(9, c=MUTE); c.alignment = Alignment(wrap_text=True, vertical="top")
                ws.row_dimensions[r].height = 15 * (1 + len(y) // 74)
        r += 1

    for s in wb.worksheets: s.sheet_view.showGridLines = False
    lakh = v["target_inc_gst"] // 100000
    out = HERE.parent / f'IPC-Stage-1-Offer-{v["label"].split()[-1]}-{lakh}-lakh.xlsx'
    wb.save(out)
    return out


for v in VAR["variants"]:
    m = resolve(v)
    out = build(v, m)
    print(f'{v["label"]:<8} {v["headline"]:<30} {m["pd"]:>6.1f} PD  {v["weeks"]}w  '
          f'blend {m["blended"]:>7,.0f}  licence {m["licence"]:>8,.0f}  '
          f'margin {m["margin"]:>6.1%}  ex {m["ex"]:>10,.0f}  inc {m["inc"]:>10,.0f}')
    print(f'         -> {out.name}')
