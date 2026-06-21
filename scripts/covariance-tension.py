#!/usr/bin/env python3
"""Covariance-aware tension analysis of the multi-dimensional Higgs measurements.

Marginal pulls (mu-1)/sigma see each channel in isolation -- the "nodes". But the
vn measurements ship a full correlation matrix between channels -- the "paths".
A coherent deviation spread across correlated channels can be more (or less)
significant than any single pull reveals. This script builds the full covariance
C_ij = rho_ij sigma_i sigma_j for every multi-dim measurement, computes the
Mahalanobis chi^2 of the Standard Model, compares it to the naive marginal sum,
and eigen-decomposes the deviation to find the dominant "tension mode" -- the
linear combination of (production x decay) signal strengths the data most strains.

This is rigorous statistics. The Tree-of-Life / Tree-of-Death framing is a lens,
not evidence: the conclusions come entirely from the numbers.
"""
import os, re, math
import numpy as np
from scipy.stats import chi2 as chi2dist, norm as normdist

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lilith", "data"))

def walk(d):
    for root, _, files in os.walk(d):
        for f in files:
            if f.endswith(".xml"):
                yield os.path.join(root, f)

def tag(xml, n):
    m = re.search(r"<%s\b[^>]*>(.*?)</%s>" % (n, n), xml, re.S); return m.group(1).strip() if m else None
def attr(s, n):
    m = re.search(r'\b%s\s*=\s*"([^"]*)"' % n, s); return m.group(1) if m else None
def fnum(s):
    try: return float(str(s).strip().lstrip("+"))
    except: return None

results = []
for path in walk(DATA):
    xml = open(path, encoding="utf-8").read()
    om = re.search(r"<expmu\b[^>]*>", xml)
    if not om: continue
    otag = om.group(0)
    if attr(otag, "type") not in ("vn", "vn1"): continue
    dim = int(attr(otag, "dim") or 0)
    if dim < 2: continue
    src = tag(xml, "source") or "?"
    exp = os.path.relpath(path, DATA).replace("\\", "/").split("/")[0]
    bf = tag(xml, "bestfit") or ""; param = tag(xml, "param") or ""
    effs = re.findall(r"<eff\b[^>]*>.*?</eff>|<eff\b[^>]*/>", xml)
    def chan(ax):
        for e in effs:
            if attr(e, "axis") == ax: return (attr(e, "prod") or "?") + "->" + (attr(e, "decay") or attr(otag, "decay") or "?")
        return ax

    mu, lo, hi, labels, ok = [], [], [], [], True
    for i in range(1, dim + 1):
        ax = "d%d" % i
        m = fnum(tag(bf, ax))
        l = h = None
        for u in re.findall(r'<uncertainty\b[^>]*axis="%s"[^>]*>.*?</uncertainty>' % ax, param):
            v = fnum(re.sub(r"<[^>]*>", "", u))
            if attr(u, "side") == "left": l = v
            elif attr(u, "side") == "right": h = v
        if m is None or l is None or h is None: ok = False; break
        mu.append(m); lo.append(l); hi.append(h); labels.append(chan(ax))
    if not ok or len(mu) != dim: continue

    # correlation matrix from <correlation entry="diXdjY">
    rho = np.eye(dim)
    for c in re.findall(r"<correlation\b[^>]*>.*?</correlation>", param):
        ent = attr(c, "entry"); val = fnum(re.sub(r"<[^>]*>", "", c))
        mm = re.findall(r"d(\d+)", ent or "")
        if val is not None and len(mm) == 2:
            a, b = int(mm[0]) - 1, int(mm[1]) - 1
            if 0 <= a < dim and 0 <= b < dim:
                rho[a, b] = rho[b, a] = val

    mu = np.array(mu); sig = (np.abs(np.array(lo)) + np.array(hi)) / 2.0  # symmetrized
    delta = mu - 1.0
    C = rho * np.outer(sig, sig)
    try:
        Cinv = np.linalg.inv(C)
    except np.linalg.LinAlgError:
        continue
    chi2_full = float(delta @ Cinv @ delta)
    chi2_marg = float(np.sum((delta / sig) ** 2))           # ignores correlations
    p_full = float(chi2dist.sf(chi2_full, dim))
    sig_full = float(normdist.isf(p_full / 2)) if 0 < p_full < 1 else 0.0

    # eigen-decomposition: dominant tension mode = max (delta.v)^2 / lambda
    w, V = np.linalg.eigh(C)
    contrib = [( (delta @ V[:, k])**2 / w[k], k) for k in range(dim) if w[k] > 1e-9]
    contrib.sort(reverse=True)
    top_c, top_k = contrib[0]
    vec = V[:, top_k]
    # describe the mode by its biggest channel weights
    order = np.argsort(-np.abs(vec))
    mode_desc = ", ".join("%+.2f*%s" % (vec[j], labels[j]) for j in order[:3])

    results.append({
        "src": src, "exp": exp, "dim": dim,
        "chi2_full": chi2_full, "chi2_marg": chi2_marg, "p_full": p_full, "sig": sig_full,
        "mode_chi2": top_c, "mode": mode_desc,
        "hidden": chi2_full - chi2_marg,
    })

results.sort(key=lambda r: -r["chi2_full"])
print(f"{'source':<22}{'dim':>4}{'chi2_full':>10}{'chi2_marg':>10}{'p_full':>9}{'sigma':>7}{'hidden':>8}")
for r in results:
    print(f"{r['src'][:21]:<22}{r['dim']:>4}{r['chi2_full']:>10.2f}{r['chi2_marg']:>10.2f}{r['p_full']:>9.3f}{r['sig']:>7.2f}{r['hidden']:>+8.2f}")

# global covariance-aware combination (treating measurements as independent blocks)
tot_chi2 = sum(r["chi2_full"] for r in results)
tot_dim = sum(r["dim"] for r in results)
print(f"\nGLOBAL (sum over {len(results)} multi-dim measurements): chi2 = {tot_chi2:.1f} / {tot_dim} dof")
print(f"  -> chi2/ndf = {tot_chi2/tot_dim:.3f}, p = {chi2dist.sf(tot_chi2, tot_dim):.3f}")

print("\nMost correlation-significant measurement:")
r = results[0]
print(f"  {r['src']} ({r['exp']}, dim {r['dim']}): chi2_full={r['chi2_full']:.2f} (p={r['p_full']:.3f}, {r['sig']:.2f} sigma)")
print(f"  marginal chi2 would have said {r['chi2_marg']:.2f}; correlations shift it {r['hidden']:+.2f}")
print(f"  dominant tension mode: {r['mode']}")

print("\nWhere correlations HIDE tension most (chi2_full << chi2_marg):")
for r in sorted(results, key=lambda r: r["hidden"])[:3]:
    print(f"  {r['src']:<20} full={r['chi2_full']:.2f} vs marg={r['chi2_marg']:.2f}  ({r['hidden']:+.2f})")
print("Where correlations REVEAL hidden tension most (chi2_full >> chi2_marg):")
for r in sorted(results, key=lambda r: -r["hidden"])[:3]:
    print(f"  {r['src']:<20} full={r['chi2_full']:.2f} vs marg={r['chi2_marg']:.2f}  ({r['hidden']:+.2f})")
