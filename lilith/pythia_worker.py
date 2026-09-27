#!/usr/bin/env python3
"""Persistent Lilith worker used by Pythia's MCP control plane.

The original command-line interface is intentionally preserved. This worker
adds a JSON-lines boundary so Pythia can reuse the parsed experimental
database and Python imports across likelihood calls and scans.
"""

import json
import os
import sys
import time

import lilith


_database_cache = {}


def _database_key(exp_input):
    return os.path.abspath(exp_input)


def _load_database(exp_input):
    key = _database_key(exp_input)
    if key not in _database_cache:
        calculator = lilith.Lilith(verbose=False, timer=False)
        calculator.readexpinput(exp_input)
        _database_cache[key] = (calculator.exp_mu, calculator.exp_ndf, calculator.dbversion)
    return _database_cache[key]


def _calculator(exp_input):
    exp_mu, exp_ndf, dbversion = _load_database(exp_input)
    calculator = lilith.Lilith(verbose=False, timer=False)
    calculator.exp_mu = exp_mu
    calculator.exp_ndf = exp_ndf
    calculator.dbversion = dbversion
    return calculator


def _handle(request):
    started = time.perf_counter()
    input_xml = request.get("inputXml")
    if not isinstance(input_xml, str) or not input_xml:
        raise ValueError("inputXml must be a non-empty string")

    exp_input = request.get("expInput", "data/latest.list")
    if not isinstance(exp_input, str) or not exp_input:
        raise ValueError("expInput must be a non-empty string")

    cached_database = _database_key(exp_input) in _database_cache
    calculator = _calculator(exp_input)
    calculator.readuserinput(input_xml)
    if calculator.couplings:
        calculator.computecouplings()
        calculator.computemufromreducedcouplings()
    calculator.computelikelihood()
    return {
        "likelihood": float(calculator.l),
        "ndf": int(calculator.exp_ndf),
        "dbVersion": calculator.dbversion,
        "durationMs": round((time.perf_counter() - started) * 1000, 3),
        "cachedDatabase": cached_database,
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            response = {"id": request_id, "ok": True, "result": _handle(request)}
        except Exception as error:  # the MCP layer receives a structured error
            response = {"id": request_id, "ok": False, "error": str(error)}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
