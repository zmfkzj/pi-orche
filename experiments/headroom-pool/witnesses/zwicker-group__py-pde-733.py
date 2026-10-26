#!/usr/bin/env python3
"""Public witness for zwicker-group/py-pde issue "Fix standard deviation of correlated noise" (zwicker-group__py-pde-733).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's only code block, verbatim below in `reproduce()` (same inputs, same calls, same dependency boundary):
  ``f = make_correlated_noise((10_000,), correlation="cosine")`` followed by ``f().std()``.
  Adaptations:
  1. Import. The issue's block omits it. ``from pde.tools.spectral import make_correlated_noise`` is the function's only public
     location in the pre-fix snapshot: it is defined at pde/tools/spectral.py:102 and listed in that module's autosummary
     (pde/tools/spectral.py:7), and neither ``pde`` nor ``pde.tools`` re-exports it.
  2. Tolerance. The issue says "close to 1" and gives no number. The witness accepts |std - 1| <= 0.2. A single realization of
     10,000 points scatters by a few percent around its ensemble value (the correlations the issue says work stay within about
     0.02 of 1 on the pre-fix snapshot), and the reported deviation is far larger (the cosine value is about 3.3 to 4.2 on the
     pre-fix snapshot). The check does not assume any particular normalization.
  3. Reference. The issue says "This currently works for all correlations, but `cosine`". The same call is therefore also run with
     each other correlation of the snapshot's ``CorrelationType`` (pde/tools/spectral.py:99: "none", "delta", "gaussian",
     "power law"), and each must stay close to 1 under the same tolerance. These calls pass on the pre-fix snapshot, as the issue
     states. The function draws from an unseeded generator, as in the issue (no ``rng`` argument is added).
- Reported symptom on the pre-fix code (issue): "should return a number close to 1, but this does not seem to work. This currently
  works for all correlations, but `cosine`."
- Expected behaviour (issue), one check per quote:
  * cosine-std: "The call to `make_correlated_noise` should return a field with unit variance, i.e.," /
    "f = make_correlated_noise((10_000,), correlation="cosine")" / "f().std()" / "should return a number close to 1"
  * other-correlations-std: "This currently works for all correlations, but `cosine`." (the same call with every other
    correlation also returns a number close to 1)
- Author: W9.8 witb-1 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "zwicker-group__py-pde-733"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["pde"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail):
# the runtime dependencies the snapshot declares (pyproject.toml:31).
DEPENDENCIES: list[str] = ["numpy", "scipy", "numba", "sympy", "matplotlib", "tqdm"]

# Adaptation 2: "close to 1" read as |std - 1| <= TOLERANCE.
TOLERANCE = 0.2
# Adaptation 3: the other correlations of CorrelationType (pde/tools/spectral.py:99), the issue's "all correlations, but `cosine`".
OTHER_CORRELATIONS = ["none", "delta", "gaussian", "power law"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from pde.tools.spectral import make_correlated_noise  # adaptation 1

    f = make_correlated_noise((10_000,), correlation="cosine")
    return float(f().std())


def same_call(correlation):
    """The issue's call with another correlation (adaptation 3, the reference the issue names)."""
    from pde.tools.spectral import make_correlated_noise  # adaptation 1

    f = make_correlated_noise((10_000,), correlation=correlation)
    return float(f().std())


def close_to_one(value):
    return isinstance(value, float) and abs(value - 1.0) <= TOLERANCE


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
        expected = f"a number close to 1 (|std - 1| <= {TOLERANCE})"
        cases.append({"id": "cosine-std", "passed": error is None and close_to_one(observed), "expected": expected, "observed": observed, **({"error": error} if error else {})})
        others, errors = {}, {}
        for correlation in OTHER_CORRELATIONS:
            try:
                others[correlation] = same_call(correlation)
            except Exception as exc:  # noqa: BLE001
                errors[correlation] = error_text(exc)
        passed = not errors and len(others) == len(OTHER_CORRELATIONS) and all(close_to_one(value) for value in others.values())
        cases.append({"id": "other-correlations-std", "passed": passed, "expected": {correlation: expected for correlation in OTHER_CORRELATIONS}, "observed": others, **({"error": errors} if errors else {})})
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
