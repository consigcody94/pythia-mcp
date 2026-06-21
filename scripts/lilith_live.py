#!/usr/bin/env python3
"""Live Lilith global fit: scan reduced couplings (C_V, C_F) over the real
experimental database and emit the -2 log L landscape for the dashboard.

Drives the vendored Lilith-2 Python API IN-PROCESS (one exp-input load, many
fast likelihood evals). Works around Lilith's POSIX-only path handling by
patching the three Grids `wdir` module globals at runtime -- the vendored
library files are never modified.

Usage: python scripts/lilith_live.py [N]      (N = grid points per axis, default 46)
"""
import sys, os, json

HERE = os.path.dirname(os.path.abspath(__file__))
LILITH_DIR = os.path.abspath(os.path.join(HERE, "..", "lilith"))
DOCS = os.path.abspath(os.path.join(HERE, "..", "docs"))
sys.path.insert(0, LILITH_DIR)
os.chdir(LILITH_DIR)  # so the relative data/latest.list + grid paths resolve

import numpy as np
import lilith
import lilith.internal.brsm as brsm
import lilith.internal.reducedcouplingslo as rclo
import lilith.internal.reducedcouplingsnnlo as rcnnlo

def fix_wdir(mod):
    mod.wdir = os.path.join(os.path.dirname(os.path.abspath(mod.__file__)), "Grids") + os.sep
for m in (brsm, rclo, rcnnlo):
    fix_wdir(m)

N = int(sys.argv[1]) if len(sys.argv) > 1 else 46

lc = lilith.Lilith(False, False)
lc.readexpinput("data/latest.list")
NDF = lc.exp_ndf
NFILES = len(lc.exp_mu)

def redC_xml(CV, CF):
    return (
        '<?xml version="1.0"?>\n<lilithinput>\n<reducedcouplings>\n'
        '  <mass>125.09</mass>\n'
        f'  <C to="tt">{CF}</C>\n  <C to="bb">{CF}</C>\n  <C to="cc">{CF}</C>\n'
        f'  <C to="tautau">{CF}</C>\n  <C to="mumu">{CF}</C>\n'
        f'  <C to="ZZ">{CV}</C>\n  <C to="WW">{CV}</C>\n'
        '  <extraBR><BR to="invisible">0.0</BR><BR to="undetected">0.0</BR></extraBR>\n'
        '  <precision>BEST-QCD</precision>\n</reducedcouplings>\n</lilithinput>'
    )

def m2logL(CV, CF):
    lc.readuserinput(redC_xml(CV, CF))
    lc.computelikelihood()
    return float(lc.l)

from scipy.optimize import minimize
from scipy.stats import chi2 as chi2dist, norm as normdist

sm = m2logL(1.0, 1.0)

# True best-fit via Nelder-Mead (the -2lnL surface is smooth interpolation).
res = minimize(lambda x: m2logL(float(x[0]), float(x[1])), [1.0, 1.0],
               method="Nelder-Mead", options={"xatol": 1e-3, "fatol": 1e-4})
bf_cv, bf_cf = float(res.x[0]), float(res.x[1])
bf_m2 = float(res.fun)
# guard: best fit can't be worse than SM
if sm < bf_m2:
    bf_cv, bf_cf, bf_m2 = 1.0, 1.0, sm

dchi2 = sm - bf_m2                              # data's preference for non-SM (2 dof)
p_sm_gof = float(chi2dist.sf(sm, NDF))         # SM goodness-of-fit p-value
p_sm_vs_bf = float(chi2dist.sf(dchi2, 2))      # is SM disfavoured vs best-fit? (2 dof)
# Gaussian-equivalent significance from the 2-dof p-value (NOT sqrt(dchi2), which
# is only valid for 1 dof). Two-sided convention.
nsigma = float(normdist.isf(p_sm_vs_bf / 2.0)) if p_sm_vs_bf > 0 else 0.0

# Likelihood landscape for the contour plot (Delta chi2 = -2lnL - bf_m2)
CVs = np.linspace(0.80, 1.25, N)
CFs = np.linspace(0.70, 1.35, N)
grid = []
for cf in CFs:
    row = [round(m2logL(float(cv), float(cf)) - bf_m2, 3) for cv in CVs]
    grid.append(row)

out = {
    "ndf": NDF,
    "nfiles": NFILES,
    "sm": {"CV": 1.0, "CF": 1.0, "m2logL": round(sm, 3), "chi2_over_ndf": round(sm / NDF, 3),
           "gof_pvalue": round(p_sm_gof, 4)},
    "bestfit": {"CV": round(bf_cv, 4), "CF": round(bf_cf, 4), "m2logL": round(bf_m2, 3)},
    "deltaChi2_SM_vs_bestfit": round(dchi2, 3),
    "sm_vs_bestfit_pvalue": round(p_sm_vs_bf, 4),
    "approx_significance_sigma": round(nsigma, 2),
    "CVaxis": [round(float(x), 4) for x in CVs],
    "CFaxis": [round(float(x), 4) for x in CFs],
    "deltaGrid": grid,  # grid[i][j] = (-2lnL - bf) at (CF=CFs[i], CV=CVs[j])
}
os.makedirs(DOCS, exist_ok=True)
with open(os.path.join(DOCS, "lilith_scan.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))

print(f"files={NFILES} ndf={NDF}")
print(f"SM -2lnL = {sm:.3f}  (chi2/ndf = {sm/NDF:.3f}, GoF p-value = {p_sm_gof:.3f})")
print(f"best-fit CV={bf_cv:.4f} CF={bf_cf:.4f}  -2lnL={bf_m2:.3f}")
print(f"Delta chi2 (SM vs best-fit) = {dchi2:.3f} -> p={p_sm_vs_bf:.3f}, ~{nsigma:.2f} sigma scale")
