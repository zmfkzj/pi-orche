#!/usr/bin/env python3
"""Held-out public check (evaluation only, never shown to a model) for the tox multiline-factor issue.

The same public rule as the retained reproducer through another documented multi-line setting: tox's configuration
reference says any multi-line setting (``deps``, ``commands``, ``set_env``, ...) can use factor conditions. An
environment named with the architecture that is not the host's selects only its own line; the matching environment and
an environment without an architecture factor select the host architecture's line, as the unmodified code does.
Real ``tox config`` in a throwaway directory, JSON output. Exit 0 / 1 / 2 and the ``WITNESS_RESULT`` line as in the
reproducer.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import sysconfig
import tempfile

WITNESS = "tox-3904-heldout"
NAMED = """[tox]
envlist = py39-{x86_64,arm64}
[testenv:py39-{arm64,x86_64}]
deps =
    x86_64: pkg-for-x86-64
    arm64: pkg-for-arm64
"""
PLAIN = """[testenv]
deps =
    x86_64: pkg-for-x86-64
    arm64: pkg-for-arm64
"""
PKG = {"x86_64": "pkg-for-x86-64", "arm64": "pkg-for-arm64"}


def deps(ini, env):
    with tempfile.TemporaryDirectory(prefix="heldout-tox-") as workdir:
        path = os.path.join(workdir, "tox.ini")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(ini)
        run = subprocess.run([sys.executable, "-m", "tox", "config", "-c", path, "-e", env, "-k", "deps", "--format", "json"],
                             cwd=workdir, capture_output=True, text=True, timeout=120)
    try:
        value = json.loads(run.stdout[run.stdout.index("{"):])["env"][env]["deps"]
        return ([str(item) for item in value] if isinstance(value, list) else value), run.stdout + run.stderr
    except (ValueError, KeyError, TypeError):
        return None, run.stdout + run.stderr


def main() -> int:
    parts = sysconfig.get_platform().rsplit("-", 1)
    host = {"aarch64": "arm64", "amd64": "x86_64"}.get(parts[-1], parts[-1]) if len(parts) > 1 else ""
    if host not in PKG:
        print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": False, "trusted": False, "problems": [f"host {host!r}"]}))
        return 2
    other = "arm64" if host == "x86_64" else "x86_64"
    cases = []
    for case_id, ini, env, expected in [
        ("deps-env-architecture-differs-from-host", NAMED, f"py39-{other}", [PKG[other]]),
        ("deps-env-architecture-matches-host", NAMED, f"py39-{host}", [PKG[host]]),
        ("deps-env-without-architecture-keeps-host-line", PLAIN, "py39", [PKG[host]]),
    ]:
        observed, text = deps(ini, env)
        passed = observed == expected
        cases.append({"id": case_id, "passed": passed, "expected": expected, "observed": observed, **({} if observed is not None else {"output": text[-800:]})})
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: expected {expected}; observed {observed}")
    ok = all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": True, "problems": [], "cases": cases}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
