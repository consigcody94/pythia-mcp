#!/usr/bin/env python3
"""Reproducible inventory and exploratory fits of Pythia/Lilith public inputs.

No event-level data or discovery calibration is implied. Archived alternatives
are evaluated separately, never multiplied into a single likelihood.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import warnings
import xml.etree.ElementTree as ET

import numpy as np
from scipy.optimize import minimize, brentq
from scipy.stats import chi2
import scipy

REPO = Path(__file__).resolve().parents[1]
ENGINE = REPO / "lilith"
DATA = ENGINE / "data"
sys.path.insert(0, str(ENGINE))
import lilith
from lilith.internal.readexpinput import ReadExpInput
from lilith.internal.computelikelihood import compute_likelihood


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, allow_nan=False) + "\n")


def csvfile(path, rows):
    if not rows:
        return
    with path.open("w", newline="") as stream:
        fields = list(dict.fromkeys(k for row in rows for k in row))
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in row.items()})


def xml_input(parameters):
    cv = parameters.get("CV", 1.)
    cf = parameters.get("CF", 1.)
    cu = parameters.get("CU", cf)
    cd = parameters.get("CD", cf)
    values = {"WW": cv, "ZZ": cv, "tt": cu, "cc": cu,
              "bb": cd, "tautau": cd, "mumu": cd}
    if "Cg" in parameters:
        values["gg"] = parameters["Cg"]
    if "Cgamma" in parameters:
        values["gammagamma"] = parameters["Cgamma"]
    body = "".join(f'<C to="{key}">{value:.14g}</C>' for key, value in values.items())
    return ('<lilithinput><reducedcouplings><mass>125.09</mass>' + body +
            f'<extraBR><BR to="invisible">{parameters.get("BRinv", 0.):.14g}</BR>' +
            '<BR to="undetected">0</BR></extraBR><precision>BEST-QCD</precision>' +
            '</reducedcouplings></lilithinput>')


class Evaluator:
    def __init__(self, measurements):
        if not measurements:
            raise ValueError("Cannot fit an empty dataset")
        self.calculator = lilith.Lilith(verbose=False, timer=False)
        self.calculator.exp_mu = measurements
        self.calculator.compute_exp_ndf()
        self.count = 0

    def evaluate(self, parameters):
        self.calculator.computelikelihood(userinput=xml_input(parameters))
        value = float(self.calculator.l)
        self.count += 1
        if not np.isfinite(value):
            raise ValueError("Non-finite likelihood")
        return value

    def contributions(self, parameters):
        self.evaluate(parameters)
        return [float(result["l"]) for result in self.calculator.results]


def read_list(path):
    return [line.split("#")[0].strip() for line in path.read_text().splitlines()
            if line.split("#")[0].strip()]


def fit(evaluator, names, bounds, starts=None):
    starts = starts or [[0. if n == "BRinv" else 1. for n in names]]
    def objective(x):
        try:
            return evaluator.evaluate(dict(zip(names, x)))
        except (ValueError, ArithmeticError, np.linalg.LinAlgError):
            return 1e12
    trials = [minimize(objective, start, method="Nelder-Mead", bounds=bounds,
                       options={"xatol": 1e-6, "fatol": 1e-7, "maxiter": 1800}) for start in starts]
    valid = [r for r in trials if r.success and np.isfinite(r.fun) and r.fun < 1e11]
    if not valid:
        raise RuntimeError(f"All fits failed for {names}: {[r.message for r in trials]}")
    best = min(valid, key=lambda r: r.fun)
    sm = evaluator.evaluate({})
    delta = max(0., sm - float(best.fun))
    interior = all(low + 1e-4 < x < high - 1e-4 for x, (low, high) in zip(best.x, bounds))
    # Wilks is diagnostic only; boundary fits have no assigned chi-square p.
    return {"parameters": dict(zip(names, map(float, best.x))), "minus2logL": float(best.fun),
            "sm_minus2logL": sm, "improvement": delta, "parameter_count": len(names),
            "wilks_p_approx": float(chi2.sf(delta, len(names))) if interior else None,
            "boundary": not interior, "delta_aic_vs_sm": 2 * len(names) - delta,
            "converged": True, "start_count": len(starts),
            "bounds": dict(zip(names, bounds))}


def audit_roots(roots, output):
    predictor = Evaluator([{"dim": 1}])
    # Generate SM signal strengths through the same reduced-coupling machinery.
    predictor.calculator.readuserinput(xml_input({}))
    predictor.calculator.computecouplings()
    predictor.calculator.computemufromreducedcouplings()
    sm_mu = predictor.calculator.user_mu_tot
    records, parsed, cache = [], {}, {}
    for label, root in roots.items():
        files = sorted(root.rglob("*.xml"))
        for path in files:
            if ".git" in path.parts:
                continue
            content = path.read_bytes()
            sha = hashlib.sha256(content).hexdigest()
            row = {"repository": label, "path": str(path.relative_to(root)), "sha256": sha,
                   "bytes": len(content)}
            if sha in cache:
                details, measurements = cache[sha]
            else:
                details, measurements = {}, None
                try:
                    xml = ET.fromstring(content)
                    details["root"] = xml.tag
                    if xml.tag != "expmu":
                        details["status"] = "non_experimental_xml"
                    else:
                        details.update({"experiment": xml.findtext("experiment"),
                            "source": xml.findtext("source"), "dim": int(xml.get("dim", 0)),
                            "type": xml.get("type"),
                            "decays": sorted(set([xml.get("decay")] if xml.get("decay") else []) |
                                             {e.get("decay") for e in xml.findall("eff") if e.get("decay")}),
                            "validation_tbd": "validated: tbd" in content.decode(errors="replace").lower(),
                            "missing_correlations_note": "correlations missing" in content.decode(errors="replace").lower()})
                        reader = ReadExpInput()
                        with warnings.catch_warnings(record=True) as caught:
                            warnings.simplefilter("always")
                            reader.read_file(str(path))
                            measurements = reader.mu
                            contributions, value = compute_likelihood(measurements, sm_mu, "reducedcouplings")
                        value = float(value)
                        if not np.isfinite(value):
                            raise ValueError("Non-finite SM likelihood")
                        details.update({"status": "evaluated", "sm_minus2logL": value,
                                        "warnings": [str(w.message) for w in caught]})
                        minimum_eigenvalue = None
                        for measurement in measurements:
                            if "corr_m" in measurement["param"]:
                                eigenvalue = float(np.linalg.eigvalsh(measurement["param"]["corr_m"]).min())
                                minimum_eigenvalue = eigenvalue if minimum_eigenvalue is None else min(eigenvalue, minimum_eigenvalue)
                        details["min_correlation_eigenvalue"] = minimum_eigenvalue
                        if minimum_eigenvalue is not None and minimum_eigenvalue <= 0:
                            details["status"] = "invalid_correlation"
                            measurements = None
                        can_screen = (details["status"] == "evaluated" and details["type"] in ("n", "vn", "vn1", "p")
                                      and "invisible" not in details["decays"] and value >= 0)
                        details["screen_p_approx"] = float(chi2.sf(value, details["dim"])) if can_screen else None
                except Exception as error:
                    details.update({"status": "error", "error": f"{type(error).__name__}: {error}"})
                    measurements = None
                cache[sha] = (details, measurements)
            row.update(details)
            records.append(row)
            if measurements:
                parsed[str(path.resolve())] = measurements
        print(f"audited {label}: {len(files)} XML files", flush=True)
    eligible = {r["sha256"]: r for r in records if r.get("screen_p_approx") is not None}
    ordered = sorted(eligible.values(), key=lambda r: r["screen_p_approx"])
    adjusted, previous = {}, 0.
    for rank, row in enumerate(ordered):
        previous = max(previous, min(1., (len(ordered) - rank) * row["screen_p_approx"]))
        adjusted[row["sha256"]] = previous
    for row in records:
        row["screen_holm_p_approx"] = adjusted.get(row["sha256"])
    csvfile(output / "xml-inventory.csv", records)
    dump(output / "xml-inventory.json", records)
    return records, parsed


def manifest_sets(upstream):
    historical = read_list(upstream / "Lilith-2/data/latest.list")
    atlas = ["ATLAS/Run2/140fb-1/CONF-2021-053_combined_vn_dim18.xml"]
    cms = ["CMS/Run2/140fb-1/HIG-19-015_ggH-VBF-WH-ZH-ttH-tH_gammagamma_vn_dim6.xml",
           "CMS/Run2/140fb-1/HIG-19-001_ggH-VBF-VH-ttH_vn_dim4.xml",
           "CMS/Run2/140fb-1/HIG-19-010_VBF-ggH_tautau_vn68_fig14b.xml"]
    return {
        "official_reference": historical,
        "official_run2": [p for p in historical if "/Run2/" in p],
        "run1": [p for p in historical if "/Run1/" in p],
        "pythia_previous_overlap_diagnostic": read_list(DATA / "latest.list"),
        "atlas_fullrun2_development": atlas,
        "cms_fullrun2_partial": cms,
        "fullrun2_partial_exploratory": atlas + cms,
    }


def smodels_snapshot(root, output):
    rows = []
    for path in sorted((root / "protomodels").rglob("pmodel.py")):
        try:
            value = ast.literal_eval(path.read_text())
            rows.append({"path": str(path.relative_to(root)),
                         "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                         "masses_GeV": value.get("masses"), "timestamp": value.get("timestamp"),
                         "reported_K": value.get("K"), "reported_Z": value.get("Z"),
                         "interpretation": "Archived fitted model; reported score is not new evidence"})
        except (ValueError, SyntaxError) as error:
            rows.append({"path": str(path.relative_to(root)), "error": str(error)})
    dump(output / "smodels-archived-models.json", rows)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstreams", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--grid-size", type=int, default=61)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    roots = {"pythia": ENGINE, "Lilith-2": args.upstreams / "Lilith-2",
             "Lilith-2-fullRun2": args.upstreams / "Lilith-2-fullRun2",
             "Lilith-Run2database": args.upstreams / "Lilith-Run2database"}
    inventory, parsed = audit_roots(roots, output)
    source_metadata = {}
    for name, root in {**roots, "smodels.github.io": args.upstreams / "smodels.github.io"}.items():
        source_metadata[name] = {"path": str(root), "commit": subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()}
    manifests = manifest_sets(args.upstreams)
    fits, contribution_rows, grid_rows = {}, [], []
    for name, paths in manifests.items():
        if len(paths) != len(set(paths)):
            raise ValueError(f"Duplicate input in {name}")
        measurements = []
        for path in paths:
            key = str((DATA / path).resolve())
            if key not in parsed:
                raise ValueError(f"Invalid or absent input: {name}: {path}")
            measurements.extend(parsed[key])
        # Explicit absolute lists are accepted by Pythia/Lilith and preserve inputs.
        (output / f"{name}.list").write_text("\n".join(str(DATA / p) for p in paths) + "\n")
        evaluator = Evaluator(measurements)
        fits[name] = {"files": paths, "measurement_dimensions": evaluator.calculator.exp_ndf,
                      "independence": "known supersession overlap" if "overlap" in name else
                          "block independence assumed; unprovided cross-block systematics not modeled",
                      "models": {}}
        for label, params, bounds, starts in [
            ("CV_CF", ["CV", "CF"], [(0.4, 1.8), (0.3, 2.2)], [[1,1], [.8,1.2], [1.2,.8]]),
            ("Cg_Cgamma", ["Cg", "Cgamma"], [(.3,2.),(.3,2.)], [[1,1],[.8,1.2],[1.2,.8]]),
            ("CV_CU_CD", ["CV", "CU", "CD"], [(.4,1.8),(.3,2.2),(.3,2.2)], [[1,1,1],[1.1,.8,1.2]])]:
            result = fit(evaluator, params, bounds, starts)
            fits[name]["models"][label] = result
        sm_contrib = evaluator.contributions({})
        bf_contrib = evaluator.contributions(fits[name]["models"]["CV_CF"]["parameters"])
        for path, measurement, sm, bf in zip(paths, measurements, sm_contrib, bf_contrib):
            contribution_rows.append({"manifest": name, "path": path, "source": measurement["source"],
                "dim": measurement["dim"], "sm_minus2logL": sm, "bestfit_minus2logL": bf, "improvement": sm-bf})
        # Fixed-SM-coupling invisible profile: no Wilks significance at the boundary.
        invisible = fit(evaluator, ["BRinv"], [(0., .6)], [[.001], [.1]])
        profile = []
        for value in np.linspace(0, .4, 161):
            profile.append({"BRinv": float(value), "delta": evaluator.evaluate({"BRinv":value}) - invisible["minus2logL"]})
        def crossing(threshold):
            low = invisible["parameters"]["BRinv"]
            fn = lambda x: evaluator.evaluate({"BRinv": x}) - invisible["minus2logL"] - threshold
            if fn(.6) < 0:
                return None
            return float(brentq(fn, low, .6))
        invisible["upper_delta2_71"] = crossing(2.71)
        invisible["upper_delta3_84"] = crossing(3.84)
        invisible["interpretation"] = "Fixed SM couplings; asymptotic profile thresholds, not CLs or calibrated coverage"
        fits[name]["models"]["BRinv_fixed_SM"] = invisible
        csvfile(output / f"{name}-invisible.csv", profile)
        print(json.dumps({"manifest": name, "dims": evaluator.calculator.exp_ndf,
                          "CV_CF": fits[name]["models"]["CV_CF"], "evaluations": evaluator.count}), flush=True)
        if name in ("official_reference", "fullrun2_partial_exploratory"):
            minimum = fits[name]["models"]["CV_CF"]["minus2logL"]
            rows = [{"CV": float(cv), "CF": float(cf),
                     "delta": evaluator.evaluate({"CV": cv, "CF": cf}) - minimum}
                    for cv in np.linspace(.82,1.22,args.grid_size)
                    for cf in np.linspace(.72,1.42,args.grid_size)]
            csvfile(output / f"{name}-coupling-grid.csv", rows)
            grid_rows.extend({"manifest":name, **row} for row in rows)
            # Refit after dropping each block to diagnose dependence on individual analyses.
            leave_one_out = []
            for i, path in enumerate(paths):
                ev = Evaluator(measurements[:i] + measurements[i+1:])
                result = fit(ev, ["CV","CF"], [(.4,1.8),(.3,2.2)],
                             [list(fits[name]["models"]["CV_CF"]["parameters"].values())])
                leave_one_out.append({"omitted": path, **result})
            fits[name]["leave_one_out_CV_CF"] = leave_one_out
    csvfile(output / "fit-contributions.csv", contribution_rows)
    csvfile(output / "coupling-grids.csv", grid_rows)
    dump(output / "fits.json", fits)
    archived = smodels_snapshot(args.upstreams / "smodels.github.io", output)
    unique = {r["sha256"]: r for r in inventory}
    summary = {"sources": source_metadata, "xml_files": len(inventory), "unique_xml_sha256": len(unique),
               "status_counts": dict(Counter(r["status"] for r in inventory)),
               "unique_status_counts": dict(Counter(r["status"] for r in unique.values())),
               "per_repository": {name:dict(Counter(r["status"] for r in inventory if r["repository"]==name)) for name in roots},
               "smodels_archived_models": len(archived), "runtime_seconds": time.perf_counter()-started,
               "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
               "statistical_scope": "exploratory scans; no discovery or global significance calibration",
               "fit_evaluations_note": "deterministic multi-start fits, positive coupling branch; no all-model trials calibration"}
    dump(output / "summary.json", summary)
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
