#!/usr/bin/env python3
"""Public witness for idaholab/MontePy issue "Commas not allowed in mesh tally arguments" (idaholab__MontePy-850).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "To Reproduce" block, verbatim below in `reproduce()` (same inputs, same calls:
  ``problem = montepy.MCNP_Problem("")``, ``problem.parse("fmesh1:n vec=0 0 0")``, ``problem.parse("fmesh1:n vec=0, 0, 0")``,
  same public API boundary ``MCNP_Problem.parse``). Each input pair runs on a fresh ``MCNP_Problem("")``, first without commas
  (the form the issue shows working) and then with commas, in the issue's order.
  Adaptations:
  * The block is an interactive session; its ``>>>`` prompts and displayed results are dropped and ``import montepy`` (the
    package the block calls, ``montepy.MCNP_Problem``) is added.
  * vec-commas-unspaced uses the input of the issue's "Error Message" block, ``problem.parse("fmesh1:n vec=0,0,0")``.
  * axs-commas and origin-commas: the issue says "This also breaks with _axs_ and _origin_." without giving those inputs; they
    are the issue's ``vec`` inputs with the keyword replaced by ``axs`` / ``origin`` (same values ``0 0 0`` / ``0, 0, 0``), the
    keywords the issue names ("namely _origin_, _axs_, and _vec_").
- Reported symptom on the pre-fix code (issue): "MontePy cannot parse the input with the commas." and
  ">>> problem.parse("fmesh1:n vec=0, 0, 0")" / "montepy.exceptions.ParsingError:", with the message
  "There was an error parsing ","." / "sly: Syntax error at line 1, token=,"
- Expected behaviour (issue), one check per quote:
  * vec-commas: "These values may be given with or without commas." -- ``problem.parse("fmesh1:n vec=0, 0, 0")`` succeeds and
    gives the same result as the form without commas, which the issue shows as ">>> problem.parse("fmesh1:n vec=0 0 0")" /
    "DATA INPUT: fmesh1:n " (compared by the displayed value, i.e. ``repr`` of the returned object with surrounding whitespace
    ignored, on the same candidate).
  * vec-commas-unspaced: the same quote, for the "Error Message" block's input ``fmesh1:n vec=0,0,0``.
  * axs-commas, origin-commas: the same quote together with "This also breaks with _axs_ and _origin_." and "The _FMESHn_ card
    takes several keywords whose values are a 3-tuple of numbers; namely _origin_, _axs_, and _vec_".
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

WITNESS = "idaholab__MontePy-850"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["montepy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["sly", "numpy"]

# (check id, input without commas, input with commas)
INPUTS = [
    ("vec-commas", "fmesh1:n vec=0 0 0", "fmesh1:n vec=0, 0, 0"),
    ("vec-commas-unspaced", "fmesh1:n vec=0 0 0", "fmesh1:n vec=0,0,0"),
    ("axs-commas", "fmesh1:n axs=0 0 0", "fmesh1:n axs=0, 0, 0"),
    ("origin-commas", "fmesh1:n origin=0 0 0", "fmesh1:n origin=0, 0, 0"),
]
# What the issue displays for the form without commas (informational; the check compares both forms on the candidate).
ISSUE_SHOWN_WITHOUT_COMMAS = "DATA INPUT: fmesh1:n "


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def exception_chain(exc):
    """Messages of the chained exceptions, first attempt first (``MCNP_Problem.parse`` tries data input, surface, then cell)."""
    chain, seen = [], set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        chain.append(f"{type(exc).__name__}: {str(exc).strip()[:400]}")
        exc = exc.__cause__ or exc.__context__
    return list(reversed(chain))


def parse_one(problem, text):
    try:
        obj = problem.parse(text)
    except Exception as exc:  # noqa: BLE001  (an exception raised by the candidate's code is a failure)
        return {"input": text, "chain": exception_chain(exc), "error": error_text(exc)}
    return {"input": text, "repr": repr(obj), "type": f"{type(obj).__module__}.{type(obj).__qualname__}"}


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import montepy  # adaptation: the issue's interactive session calls ``montepy.MCNP_Problem``

    observed = {}
    for case_id, without_commas, with_commas in INPUTS:
        problem = montepy.MCNP_Problem("")
        first = parse_one(problem, without_commas)  # >>> problem.parse("fmesh1:n vec=0 0 0")  ->  DATA INPUT: fmesh1:n
        second = parse_one(problem, with_commas)  # >>> problem.parse("fmesh1:n vec=0, 0, 0")  ->  ParsingError (the bug)
        observed[case_id] = {"without_commas": first, "with_commas": second}
    return observed


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
        for case_id, without_commas, with_commas in INPUTS:
            if error is not None:
                cases.append({"id": case_id, "passed": False, "error": error})
                continue
            pair = observed[case_id]
            first, second = pair["without_commas"], pair["with_commas"]
            # Same displayed result (repr, surrounding whitespace ignored) as the form without commas; no exception in either.
            passed = "error" not in first and "error" not in second and second["repr"].strip() == first["repr"].strip()
            cases.append({
                "id": case_id,
                "passed": passed,
                "expected": {"input": with_commas, "same result as": without_commas, "issue shows for the form without commas": ISSUE_SHOWN_WITHOUT_COMMAS},
                "observed": pair,
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
