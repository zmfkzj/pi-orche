#!/usr/bin/env python3
"""Public witness for scikit-rf/scikit-rf issue "Printing a DistributedCircuit fails" (scikit-rf__scikit-rf-1336).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "To Reproduce" script (``bug.py``), verbatim below in `reproduce()` (same imports, same inputs
  ``Frequency(100, 101, 3, 'MHz')`` and ``DistributedCircuit(frequency=freq, C=100e-12, L=62.5e-9, R=[1, 2, 3], G=0)``, same call
  ``print(x)``, same public API boundary).
  Adaptations: the issue runs the script as ``$ python bug.py``; here its body runs in-process (so the import of ``skrf`` from
  the candidate is verified) with ``print``'s standard output captured, and an exception escaping the script counts as the
  "error thrown".
- Reported symptom on the pre-fix code (issue): "When an array is used the print fails." with the traceback ending in
  "TypeError: unsupported format string passed to list.__format__"
- Expected behaviour (issue), one check per quote:
  * print-succeeds: "The print() should succeed. No error thrown." (and "Printing the result obtained from DistributedCircuit()
    should be possible.") -- ``print(x)`` returns without an exception and writes the object's text (non-empty output).
  Not checked: the issue's note "And please fix the output format. .2f is not very sensible for printing small quantities like L
  or C." names no concrete format (a wording/style request, no mechanically checkable expectation).
- Author: W9.15 witb-8 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "scikit-rf__scikit-rf-1336"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["skrf"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "scipy", "pandas", "typing_extensions"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import contextlib
    import io

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):  # adaptation: capture what ``print(x)`` writes
        # --- bug.py (verbatim) ---
        from skrf import Frequency
        from skrf.media import DistributedCircuit

        freq = Frequency(100, 101, 3, 'MHz')
        x = DistributedCircuit(frequency=freq, C=100e-12, L=62.5e-9, R=[1, 2, 3], G=0)
        print(x)
        # --- end of bug.py ---
    return captured.getvalue()


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
        passed = error is None and isinstance(observed, str) and observed.strip() != ""
        cases.append({"id": "print-succeeds", "passed": passed, "expected": "print(x) succeeds, no error thrown (non-empty printed text)", "observed": observed, **({"error": error} if error else {})})
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
