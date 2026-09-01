#!/usr/bin/env python3
"""Effort and cost model for the ipc.gov.in → Gov.In CMS / DBIM migration.

Method is deliberately the same as the prior workbook's Confidence sheet, so the
two are comparable: Beta-PERT marginals on every work package, correlated through
a single-factor Gaussian copula, with exogenous risk events sampled INSIDE each
iteration rather than added to a percentile afterwards. A mean added to a
percentile is neither, which is the error that method exists to avoid.

    python3 Estimation/model/simulate.py              # full report
    python3 Estimation/model/simulate.py --json       # machine-readable
    python3 Estimation/model/simulate.py --rho 0.7    # correlation sensitivity
"""
import argparse, json, pathlib
import numpy as np
from scipy.stats import beta as beta_dist, norm

HERE = pathlib.Path(__file__).parent
SEED = 20260901
ITERATIONS = 100_000
LAKH = 100_000


def pert(o, m, p, u, lam=4.0):
    """Beta-PERT inverse-CDF sample from uniforms u. lam=4 is the standard shape."""
    o, m, p = np.asarray(o, float), np.asarray(m, float), np.asarray(p, float)
    rng = np.where(p - o == 0, 1e-9, p - o)
    a = 1 + lam * (m - o) / rng
    b = 1 + lam * (p - m) / rng
    return o + beta_dist.ppf(u, a, b) * rng


def simulate(packages, risks, rho, iterations=ITERATIONS, seed=SEED):
    rs = np.random.default_rng(seed)
    n = len(packages)
    # One common factor: one team, one client, one set of ambiguities.
    z = np.sqrt(rho) * rs.standard_normal((iterations, 1)) + \
        np.sqrt(1 - rho) * rs.standard_normal((iterations, n))
    draws = pert([p["o"] for p in packages], [p["m"] for p in packages],
                 [p["p"] for p in packages], norm.cdf(z))
    total = draws.sum(axis=1)
    for r in risks:
        total = total + (rs.random(iterations) < r["prob"]) * r["impact"]
    return total, draws


def pctiles(t):
    return {f"P{q}": round(float(np.percentile(t, q)), 1) for q in (10, 50, 70, 80, 90, 95)}


def expected(p):
    return (p["o"] + 4 * p["m"] + p["p"]) / 6


def role_split(packages, roles):
    """PD by role, from each package's own mix. Unmixed effort would make the
    blended rate an assumption; this makes it an output."""
    by = {r["ref"]: 0.0 for r in roles}
    for p in packages:
        e = expected(p)
        for ref, share in p["mix"].items():
            by[ref] += e * share
    return by


def money(pd_total, packages, roles, c, passthrough, tier=1.0, margin=None):
    """Cost and price build-up. The blended rate is an OUTPUT of the role mix in
    the packages, not an input assumption — change the mix and the rate moves."""
    margin = c["margin"] if margin is None else margin
    rate = {r["ref"]: r["rate"] * tier for r in roles}
    split = role_split(packages, roles)
    base = sum(split.values())
    blended = sum(split[k] * rate[k] for k in split) / base if base else 0
    effort_cost = pd_total * blended
    cost = effort_cost + passthrough
    price = cost / (1 - margin)
    return {"blended_rate": round(blended), "effort_cost": effort_cost,
            "passthrough": passthrough, "cost": cost, "price_ex_gst": price,
            "price_inc_gst": price * (1 + c["gst"])}


def fte(packages, roles, pd_total, months, days_per_month=21):
    """Resource levels and counts. PD by role is scaled from the PERT expected
    split to the chosen percentile, then divided by the elapsed window."""
    split = role_split(packages, roles)
    base = sum(split.values())
    rows = []
    for r in roles:
        pd = split[r["ref"]] / base * pd_total if base else 0
        if pd <= 0:
            continue
        avg = pd / (months * days_per_month)
        rows.append({"ref": r["ref"], "role": r["role"], "rate": r["rate"],
                     "pd": round(pd, 1), "avg_fte": round(avg, 2),
                     "heads": max(1, round(avg + 0.49)),
                     "shape": ("continuous" if avg >= 0.5 else
                               "part-time, continuous" if avg >= 0.2 else "called in")})
    return sorted(rows, key=lambda x: -x["pd"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rho", type=float, default=0.5)
    ap.add_argument("--wbs", default=str(HERE / "wbs.json"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    model = json.load(open(args.wbs))
    ALL, RISKS, ROLES, C = model["packages"], model["risks"], model["roles"], model["commercials"]
    pt = C["stage1_passthrough_inr"]

    views = {
        "stage1": ([p for p in ALL if p["stage"] == 1], [r for r in RISKS if r["stage"] == 1]),
        "stage2": ([p for p in ALL if p["stage"] == 2], [r for r in RISKS if r["stage"] == 2]),
        "stage1+2": ([p for p in ALL if p["stage"] in (1, 2)], RISKS),
        "options": ([p for p in ALL if p["stage"] == 3], []),
        # Lean variant: Stage 1 with the packages a supplier should not be paid
        # for handed back to IPC and NIC. The lever that moves the envelope
        # without pretending the work got smaller.
        "stage1-lean": ([p for p in ALL if p["stage"] == 1 and not p.get("lean_excluded")],
                        [r for r in RISKS if r["stage"] == 1 and r["ref"] != "E13"]),
        # The recommended scope end to end: lean Stage 1 plus Stage 2, sampled in
        # the same iterations. Not the sum of the two — a joint run shares the
        # common factor, so the combined P80 is not P80(a) + P80(b).
        "recommended": ([p for p in ALL if (p["stage"] == 2) or
                         (p["stage"] == 1 and not p.get("lean_excluded"))],
                        [r for r in RISKS if r["ref"] != "E13"]),
    }

    out = {"seed": SEED, "iterations": ITERATIONS, "rho": args.rho, "views": {}}
    for name, (pkgs, rks) in views.items():
        total, draws = simulate(pkgs, rks, args.rho)
        v = {"packages": len(pkgs), "risks": len(rks),
             "pert_expected_pd": round(sum(expected(p) for p in pkgs), 1),
             "risk_emv_pd": round(sum(r["prob"] * r["impact"] for r in rks), 1),
             **pctiles(total),
             "by_role_pd": {k: round(x, 1) for k, x in role_split(pkgs, ROLES).items() if x > 0},
             "by_phase_pd": {}}
        for p in pkgs:
            v["by_phase_pd"][p["phase"]] = round(v["by_phase_pd"].get(p["phase"], 0) + expected(p), 1)
        var = draws.var(axis=0)
        v["variance_drivers"] = [{"ref": pkgs[i]["ref"], "name": pkgs[i]["name"],
                                  "share": round(float(var[i] / var.sum()), 3)}
                                 for i in np.argsort(var)[::-1][:6]]
        out["views"][name] = v

    s1p, s1r = views["stage1"]
    s12p, _ = views["stage1+2"]

    # The envelope test. The same work costs different amounts from different
    # suppliers, so the tier is a real lever and not a fudge factor.
    out["tiers"] = [
        {"ref": "T1", "tier": "Boutique / specialist", "mult": 0.72},
        {"ref": "T2", "tier": "Mid-tier SI", "mult": 1.00},
        {"ref": "T3", "tier": "Tier-1 SI", "mult": 1.40},
    ]
    out["envelope"] = {"low_inr": 20 * LAKH, "high_inr": 30 * LAKH, "basis": "contract value excluding GST"}
    out["stage1_matrix"] = []
    for t in out["tiers"]:
        for margin in (0.15, 0.20, 0.25):
            for q in ("P50", "P80", "P90"):
                m = money(out["views"]["stage1"][q], s1p, ROLES, C,
                          pt["base"], tier=t["mult"], margin=margin)
                m.update({"tier": t["ref"], "margin": margin, "percentile": q,
                          "pd": out["views"]["stage1"][q],
                          "in_envelope": 20 * LAKH <= m["price_ex_gst"] <= 30 * LAKH})
                out["stage1_matrix"].append(m)

    out["stage1_money"] = {q: {b: money(out["views"]["stage1"][q], s1p, ROLES, C, v,
                                        tier=0.72, margin=0.20)
                               for b, v in (("low", pt["low"]), ("base", pt["base"]),
                                            ("high", pt["high"]))}
                           for q in ("P50", "P80", "P90")}

    out["stage1+2_money"] = {t["ref"]: money(out["views"]["stage1+2"]["P80"], s12p, ROLES, C,
                                             pt["base"] * 2, tier=t["mult"], margin=0.20)
                             for t in out["tiers"]}

    lp, _ = views["stage1-lean"]
    out["lean_matrix"] = []
    for margin in (0.15, 0.20):
        for q in ("P50", "P80", "P90"):
            m = money(out["views"]["stage1-lean"][q], lp, ROLES, C, pt["base"], tier=0.72, margin=margin)
            m.update({"margin": margin, "percentile": q, "pd": out["views"]["stage1-lean"][q],
                      "in_envelope_ex_gst": 20 * LAKH <= m["price_ex_gst"] <= 30 * LAKH,
                      "in_envelope_inc_gst": 20 * LAKH <= m["price_inc_gst"] <= 30 * LAKH})
            out["lean_matrix"].append(m)

    out["stage1_resources"] = fte(lp, ROLES, out["views"]["stage1-lean"]["P80"], months=5.5)
    out["stage2_resources"] = fte(views["stage2"][0], ROLES, out["views"]["stage2"]["P80"], months=9.0)

    out["sensitivity_stage1"] = {}
    out["sensitivity_lean"] = {}
    lr = views["stage1-lean"][1]
    for rho in (0.0, 0.3, 0.5, 0.7):
        tt, _ = simulate(s1p, s1r, rho)
        out["sensitivity_stage1"][f"rho={rho}"] = pctiles(tt)
        tl, _ = simulate(lp, lr, rho)
        out["sensitivity_lean"][f"rho={rho}"] = pctiles(tl)

    if args.json:
        print(json.dumps(out, indent=1)); return

    print(f'{ITERATIONS:,} iterations · seed {SEED} · rho {args.rho}\n')
    for name in ("stage1", "stage1-lean", "stage2", "recommended", "stage1+2", "options"):
        v = out["views"][name]
        print(f'{name.upper():<10} {v["packages"]:>2} packages  '
              f'PERT {v["pert_expected_pd"]:>6.1f} PD + risk EMV {v["risk_emv_pd"]:>5.1f} PD')
        print(f'{"":<10} P50 {v["P50"]:>6.0f}   P70 {v["P70"]:>6.0f}   P80 {v["P80"]:>6.0f}'
              f'   P90 {v["P90"]:>6.0f}   P95 {v["P95"]:>6.0f}')
        for ph, pd in v["by_phase_pd"].items():
            print(f'{"":<12}{ph:<44} {pd:>6.1f} PD')
        print()

    print('ENVELOPE TEST — Stage 1 contract value excluding GST, INR lakh')
    print(f'  {"tier":<4} {"margin":>6} {"pctl":>5} {"PD":>5} {"blended":>8} '
          f'{"cost":>7} {"ex-GST":>7} {"inc-GST":>8}   in 20-30?')
    for m in out["stage1_matrix"]:
        flag = "  <-- YES" if m["in_envelope"] else ""
        print(f'  {m["tier"]:<4} {m["margin"]:>6.0%} {m["percentile"]:>5} {m["pd"]:>5.0f} '
              f'{m["blended_rate"]:>8,} {m["cost"]/LAKH:>7.2f} {m["price_ex_gst"]/LAKH:>7.2f} '
              f'{m["price_inc_gst"]/LAKH:>8.2f}{flag}')

    print('\nSTAGE 1 RECOMMENDED — boutique tier, 20% margin (INR lakh)')
    for q in ("P50", "P80", "P90"):
        m = out["stage1_money"][q]["base"]
        print(f'  {q}  {out["views"]["stage1"][q]:>6.0f} PD @ {m["blended_rate"]:,}/PD   '
              f'cost {m["cost"]/LAKH:>6.2f}   ex-GST {m["price_ex_gst"]/LAKH:>6.2f}   '
              f'inc-GST {m["price_inc_gst"]/LAKH:>6.2f}')

    print('\nLEAN VARIANT — Stage 1 with 1.5, 0.3, 0.7 and 1.3 handed to IPC/NIC (T1, INR lakh)')
    for m in out["lean_matrix"]:
        f = []
        if m["in_envelope_ex_gst"]: f.append("ex-GST")
        if m["in_envelope_inc_gst"]: f.append("inc-GST")
        print(f'  {m["margin"]:>4.0%} {m["percentile"]:>4} {m["pd"]:>6.0f} PD   cost {m["cost"]/LAKH:>6.2f}   '
              f'ex-GST {m["price_ex_gst"]/LAKH:>6.2f}   inc-GST {m["price_inc_gst"]/LAKH:>6.2f}   '
              f'{"in envelope: " + ", ".join(f) if f else ""}')

    print('\nSTAGE 1+2 at P80 (INR lakh, 20% margin)')
    for t in out["tiers"]:
        m = out["stage1+2_money"][t["ref"]]
        print(f'  {t["ref"]} {t["tier"]:<24} ex-GST {m["price_ex_gst"]/LAKH:>7.2f}   '
              f'inc-GST {m["price_inc_gst"]/LAKH:>7.2f}')

    for label, key, months in (("STAGE 1 LEAN", "stage1_resources", 5.5), ("STAGE 2", "stage2_resources", 9.0)):
        print(f'\n{label} — resource levels and counts over {months} months elapsed')
        print(f'  {"":<3} {"role":<42} {"INR/PD":>7} {"PD":>6} {"avg FTE":>8} {"heads":>6}  shape')
        tot_pd = tot_fte = 0
        for r in out[key]:
            tot_pd += r["pd"]; tot_fte += r["avg_fte"]
            print(f'  {r["ref"]:<3} {r["role"]:<42} {r["rate"]:>7,} {r["pd"]:>6.1f} '
                  f'{r["avg_fte"]:>8.2f} {r["heads"]:>6}  {r["shape"]}')
        print(f'  {"":<3} {"TOTAL":<42} {"":>7} {tot_pd:>6.1f} {tot_fte:>8.2f} '
              f'{sum(r["heads"] for r in out[key]):>6}  named people')

    print('\nSTAGE 1 — correlation sensitivity (P50 / P80 / P90)')
    for rho, v in out["sensitivity_stage1"].items():
        print(f'  {rho:<9} {v["P50"]:>6.0f} {v["P80"]:>6.0f} {v["P90"]:>6.0f}')

    print('\nSTAGE 1 — variance drivers')
    for d in out["views"]["stage1"]["variance_drivers"]:
        print(f'  {d["share"]*100:>5.1f}%  {d["ref"]:<5} {d["name"][:56]}')


if __name__ == "__main__":
    main()
