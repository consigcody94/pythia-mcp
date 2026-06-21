#!/usr/bin/env python3
"""Live fit of the Higgs INVISIBLE branching ratio -- how much of the Higgs can
be decaying into something we cannot see (dark matter / the "unseen").

This is the genuine new-physics frontier in Higgs data: an invisible (or
undetected) decay adds width, suppressing every visible signal strength. We
profile the couplings (C_V, C_F) at each value of BR(invisible) using the real
Lilith engine, then read off the 95% CL upper limit. Thematically apt for a tool
named Lilith (the demon of the night); physically, a real search.

Drives Lilith in-process with the same Windows path shim as lilith_live.py.
Output: docs/invisible.json
"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
LILITH_DIR = os.path.abspath(os.path.join(HERE, "..", "lilith"))
DOCS = os.path.abspath(os.path.join(HERE, "..", "docs"))
sys.path.insert(0, LILITH_DIR)
os.chdir(LILITH_DIR)

import numpy as np
from scipy.optimize import minimize
from scipy.stats import chi2 as chi2dist
import lilith
import lilith.internal.brsm as brsm
import lilith.internal.reducedcouplingslo as rclo
import lilith.internal.reducedcouplingsnnlo as rcnnlo
for m in (brsm, rclo, rcnnlo):
    m.wdir = os.path.join(os.path.dirname(os.path.abspath(m.__file__)), "Grids") + os.sep

lc = lilith.Lilith(False, False)
lc.readexpinput("data/latest.list")
NDF = lc.exp_ndf

def xml(CV, CF, BRinv):
    return (
        '<?xml version="1.0"?>\n<lilithinput>\n<reducedcouplings>\n  <mass>125.09</mass>\n'
        f'  <C to="tt">{CF}</C>\n  <C to="bb">{CF}</C>\n  <C to="cc">{CF}</C>\n'
        f'  <C to="tautau">{CF}</C>\n  <C to="mumu">{CF}</C>\n'
        f'  <C to="ZZ">{CV}</C>\n  <C to="WW">{CV}</C>\n'
        f'  <extraBR><BR to="invisible">{BRinv}</BR><BR to="undetected">0.0</BR></extraBR>\n'
        '  <precision>BEST-QCD</precision>\n</reducedcouplings>\n</lilithinput>'
    )

def m2logL(CV, CF, BRinv):
    lc.readuserinput(xml(CV, CF, BRinv))
    lc.computelikelihood()
    return float(lc.l)

def profiled(BRinv):
    """-2lnL minimized over (C_V, C_F) at fixed BR(invisible)."""
    r = minimize(lambda x: m2logL(float(x[0]), float(x[1]), BRinv), [1.0, 1.0],
                 method="Nelder-Mead", options={"xatol": 2e-3, "fatol": 1e-3})
    return float(r.fun), float(r.x[0]), float(r.x[1])

BRgrid = np.linspace(0.0, 0.60, 31)
curve = []
gmin = (1e18, 0.0)
for br in BRgrid:
    val, cv, cf = profiled(float(br))
    curve.append({"br": round(float(br), 4), "m2logL": round(val, 3), "CV": round(cv, 3), "CF": round(cf, 3)})
    if val < gmin[0]:
        gmin = (val, float(br))

minL, bf_br = gmin
# Delta(-2lnL) relative to the profiled minimum
for c in curve:
    c["delta"] = round(c["m2logL"] - minL, 3)

# 95% CL one-sided upper limit: physical boundary at BR>=0, threshold Delta = 2.71
def upper_limit(threshold):
    prev = curve[0]
    for c in curve[1:]:
        if c["br"] >= bf_br and c["delta"] >= threshold:
            # linear interpolate between prev and c
            d0, d1 = prev["delta"], c["delta"]
            if d1 == d0:
                return c["br"]
            frac = (threshold - d0) / (d1 - d0)
            return round(prev["br"] + frac * (c["br"] - prev["br"]), 4)
        prev = c
    return None

ul95 = upper_limit(2.71)   # one-sided 95%
ul90 = upper_limit(1.64)   # one-sided 90%

out = {
    "ndf": NDF,
    "bestfit_BRinv": round(bf_br, 4),
    "bestfit_m2logL": round(minL, 3),
    "UL95": ul95,
    "UL90": ul90,
    "curve": curve,
}
os.makedirs(DOCS, exist_ok=True)
with open(os.path.join(DOCS, "invisible.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))

print(f"best-fit BR(invisible) = {bf_br:.3f}  (-2lnL = {minL:.3f})")
print(f"95% CL upper limit: BR(invisible) < {ul95}")
print(f"90% CL upper limit: BR(invisible) < {ul90}")
print("Interpretation: at most ~{:.0f}% of Higgs bosons can be vanishing into the unseen.".format((ul95 or 0)*100))
