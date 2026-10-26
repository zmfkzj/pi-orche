#!/usr/bin/env python3
"""Public witness for yt-project/unyt issue "`unyt_array.squeeze` result type should match shape" (yt-project__unyt-628).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's only code block, verbatim below in `reproduce()` (same input ``np.array([1]) * u.m``, same call
  ``x.squeeze()``, same public API ``unyt.unyt_quantity``). Adaptations:
  1. ``import numpy as np`` is added: the block calls ``np.array`` without importing it; ``np`` can only denote numpy, the
     array library unyt is built on (snapshot ``pyproject.toml`` ``dependencies = ["numpy>=1.21.3, <3.0", ...]``).
  2. The block's ``assert isinstance(x.squeeze(), u.unyt_quantity)`` is evaluated as check ``squeeze-type`` (the same
     expression, its value recorded with the observed type, shape and units) instead of a bare ``assert``.
- Reported symptom on the pre-fix code (issue): "# expected unyt_quantity, got unyt_array"
- Expected behaviour (issue), one check per quote:
  * squeeze-type: "When `squeeze` returns a scalar the type should be a `unyt_quantity`." and
    "assert isinstance(x.squeeze(), u.unyt_quantity)  # expected unyt_quantity, got unyt_array"
- Author: W9.2 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "yt-project__unyt-628"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["unyt"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "sympy", "packaging"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import numpy as np  # adaptation 1 (the issue's block uses `np` without importing it)
    import unyt as u
    x = np.array([1]) * u.m
    squeezed = x.squeeze()
    return {
        # adaptation 2: the issue's `assert isinstance(x.squeeze(), u.unyt_quantity)`, recorded instead of asserted
        "isinstance_unyt_quantity": isinstance(squeezed, u.unyt_quantity),
        "type": f"{type(squeezed).__module__}.{type(squeezed).__qualname__}",
        "repr": repr(squeezed),
        "shape": list(getattr(squeezed, "shape", ()) or ()),
        "units": str(getattr(squeezed, "units", None)),
    }


def main() -> int:
    problems, fidelity, cases = [], {}, []
    for name in DEPENDENCIES:
        try:
            __import__(name)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"dependency {name} not importable: {type(exc).__name__}: {exc}")
    root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    if not problems:
        for name in CANDIDATE_MODULES:
            try:
                module = __import__(name)
            except Exception as exc:  # noqa: BLE001  (the candidate's own code fails to import: a failure, not untrusted)
                cases.append({"id": f"import-{name}", "passed": False, "error": error_text(exc)})
                continue
            fidelity[name] = os.path.realpath(getattr(module, "__file__", "") or "")
            if root is not None and not inside(module.__file__, root):
                problems.append(f"{name} was not imported from the candidate ({fidelity[name]})")
    if not problems and not cases:
        observed, error = None, None
        try:
            observed = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        cases.append({
            "id": "squeeze-type",
            "passed": error is None and observed["isinstance_unyt_quantity"] is True,
            "expected": "isinstance(x.squeeze(), u.unyt_quantity) is True (a unyt_quantity, not a unyt_array)",
            "observed": observed,
            **({"error": error} if error else {}),
        })
    for case in cases:
        print(f"[{'PASS' if case['passed'] else 'FAIL'}] {case['id']}: " + json.dumps({k: v for k, v in case.items() if k not in ('id', 'passed')}, default=str)[:2000])
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    trusted = not problems
    ok = trusted and bool(cases) and all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
