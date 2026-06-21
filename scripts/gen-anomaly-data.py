#!/usr/bin/env python3
"""Per-channel tension (pull) scan over the Lilith experimental database.

For every directly-Gaussian signal-strength measurement we extract mu and its
asymmetric uncertainty, then compute the pull = (mu - 1) / sigma, where sigma is
the uncertainty on the side facing the Standard Model (mu=1). Covers 1D type="n"
files and each axis of the modern multi-dimensional type="vn" measurements
(per-bin best fits; cross-bin correlations are noted but not used for the
marginal pull, which is standard for a tension plot).

Output: docs/anomaly.json   (consumed by docs/anomaly.html)
"""
import os, re, json, math

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, "..", "lilith", "data"))
OUT = os.path.abspath(os.path.join(HERE, "..", "docs", "anomaly.json"))

def walk(d):
    for root, _, files in os.walk(d):
        for f in files:
            if f.endswith(".xml"):
                yield os.path.join(root, f)

def tag(xml, name):
    m = re.search(r"<%s\b[^>]*>(.*?)</%s>" % (name, name), xml, re.S)
    return m.group(1).strip() if m else None

def attr(s, name):
    m = re.search(r'\b%s\s*=\s*"([^"]*)"' % name, s)
    return m.group(1) if m else None

def fnum(s):
    try:
        return float(str(s).strip().lstrip("+"))
    except (TypeError, ValueError):
        return None

measurements = []
for path in walk(DATA):
    rel = os.path.relpath(path, DATA).replace("\\", "/")
    seg = rel.split("/")
    exp = seg[0]
    run = next((s for s in seg if s.startswith("Run")), "Tevatron" if exp == "Tevatron" else "-")
    xml = open(path, encoding="utf-8").read()
    om = re.search(r"<expmu\b[^>]*>", xml)
    if not om:
        continue
    otag = om.group(0)
    typ = attr(otag, "type")
    dim = int(attr(otag, "dim") or 0)
    source = tag(xml, "source") or "?"
    sqrts = tag(xml, "sqrts")
    effs = re.findall(r"<eff\b[^>]*>.*?</eff>|<eff\b[^>]*/>", xml)

    def eff_for(axis):
        for e in effs:
            if attr(e, "axis") == axis:
                return attr(e, "prod"), attr(e, "decay")
        return None, None

    rows = []  # (mu, lo, hi, prod, decay)
    if typ == "n" and dim == 1:
        mu = fnum(tag(xml, "bestfit"))
        param = tag(xml, "param") or ""
        lo = hi = None
        for u in re.findall(r"<uncertainty\b[^>]*>.*?</uncertainty>", param):
            side = attr(u, "side"); val = fnum(re.sub(r"<[^>]*>", "", u))
            if side == "left": lo = val
            elif side == "right": hi = val
        prod = "+".join(sorted({attr(e, "prod") for e in effs if attr(e, "prod")}))
        decay = attr(otag, "decay") or "+".join(sorted({attr(e, "decay") for e in effs if attr(e, "decay")}))
        if mu is not None and lo is not None and hi is not None:
            rows.append((mu, lo, hi, prod, decay))
    elif typ in ("vn", "vn1"):
        bf = tag(xml, "bestfit") or ""
        param = tag(xml, "param") or ""
        for axis in ["d%d" % i for i in range(1, dim + 1)]:
            mu = fnum(tag(bf, axis))
            lo = hi = None
            for u in re.findall(r'<uncertainty\b[^>]*axis="%s"[^>]*>.*?</uncertainty>' % axis, param):
                side = attr(u, "side"); val = fnum(re.sub(r"<[^>]*>", "", u))
                if side == "left": lo = val
                elif side == "right": hi = val
            prod, decay = eff_for(axis)
            if mu is not None and lo is not None and hi is not None:
                rows.append((mu, lo, hi, prod or "?", decay or attr(otag, "decay") or "?"))

    for mu, lo, hi, prod, decay in rows:
        sigma = abs(lo) if mu >= 1 else abs(hi)
        if not sigma:
            continue
        pull = (mu - 1.0) / sigma
        measurements.append({
            "exp": exp, "run": run, "source": source, "sqrts": sqrts,
            "prod": prod, "decay": decay, "type": typ,
            "mu": round(mu, 4), "lo": round(lo, 4), "hi": round(hi, 4),
            "pull": round(pull, 3),
        })

measurements.sort(key=lambda m: m["pull"])
pulls = [m["pull"] for m in measurements]
n = len(pulls)
beyond2 = [m for m in measurements if abs(m["pull"]) >= 2]
beyond3 = [m for m in measurements if abs(m["pull"]) >= 3]
mean = sum(pulls) / n
rms = math.sqrt(sum(p * p for p in pulls) / n)
# Expected number beyond 2 sigma for n independent Gaussians (one-sided each tail ~2.3%)
exp_beyond2 = round(n * 0.0455, 1)

out = {
    "n": n,
    "mean_pull": round(mean, 3),
    "rms_pull": round(rms, 3),
    "n_beyond_2sigma": len(beyond2),
    "expected_beyond_2sigma": exp_beyond2,
    "n_beyond_3sigma": len(beyond3),
    "top_tensions": sorted(measurements, key=lambda m: -abs(m["pull"]))[:8],
    "measurements": measurements,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(f"channels={n}  mean pull={mean:+.3f}  rms={rms:.3f}")
print(f">2 sigma: {len(beyond2)} (expected ~{exp_beyond2})   >3 sigma: {len(beyond3)}")
print("top tensions:")
for m in out["top_tensions"]:
    print(f"  {m['pull']:+.2f}  {m['exp']:6} {m['prod']:>10}->{m['decay']:<11} mu={m['mu']:+.2f} (-{abs(m['lo']):.2f}/+{m['hi']:.2f})  {m['source']}")
