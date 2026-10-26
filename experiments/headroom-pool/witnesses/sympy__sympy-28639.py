#!/usr/bin/env python3
"""Public witness for sympy/sympy issue "`AbelianGroup.random()` crashes on trivial group (`AbelianGroup(1)`)"
(sympy__sympy-28639).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's first code block (```python), verbatim below in ``reproduce()`` (same input ``AbelianGroup(1)``,
  same call ``G.random()``, same public API ``sympy.combinatorics.named_groups.AbelianGroup``). Adaptations:
  1. The block's lines are the body of ``reproduce()`` (indentation only); the value of its last expression statement
     ``G.random()`` is kept as ``result`` and returned together with ``G`` so that the check can inspect it.
  2. "The identity element" is compared with the group's own ``identity`` property, which the pre-fix snapshot documents as
     "Return the identity element of the permutation group." (sympy/combinatorics/perm_groups.py:1372-1378).
- Reported symptom on the pre-fix code (issue): "Calling `random()` on a trivial Abelian group raises `ValueError`." with the
  traceback's last line "ValueError: String must not be empty".
- Expected behaviour (issue), one check per quote:
  * random-identity: "`AbelianGroup(1)` (a valid API input) should yield the identity element rather than crashing." -- the
    call returns (no exception) a value equal to ``G.identity``.
- Author: W9.11 witb-4 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden
  tests and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "sympy__sympy-28639"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sympy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["mpmath"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from sympy.combinatorics.named_groups import AbelianGroup

    G = AbelianGroup(1)
    result = G.random()  # adaptation 1: the block's `G.random()`, its value kept
    return {"G": G, "result": result}


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
        passed, expected, seen = False, "G.identity (the identity element of AbelianGroup(1))", None
        if error is None:
            try:
                identity = observed["G"].identity
                result = observed["result"]
                expected = {"repr": repr(identity), "size": getattr(identity, "size", None)}
                seen = {"repr": repr(result), "type": type(result).__name__, "size": getattr(result, "size", None), "is_Identity": getattr(result, "is_Identity", None)}
                passed = bool(result == identity)
            except Exception as exc:  # noqa: BLE001
                error = error_text(exc)
        cases.append({"id": "random-identity", "passed": error is None and passed, "expected": expected, "observed": seen, **({"error": error} if error else {})})
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
