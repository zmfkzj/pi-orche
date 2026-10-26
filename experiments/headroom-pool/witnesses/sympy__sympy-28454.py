#!/usr/bin/env python3
"""Public witness for sympy/sympy issue "Dividing a zero matrix with 0 should return a nan matrix" (sympy__sympy-28454).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's code block, verbatim in ``ISSUE_PROGRAM`` below, saved as a script and run with the case's
  interpreter (``python issue_28454.py``); its printed output is what the issue reports. The issue's comparison expression
  ``sympify(0) / sympify(0) == nan`` is evaluated after the same ``from sympy import *``. Adaptations: none for the program;
  the comparison expression (inline code in the issue's text) is evaluated in a fresh namespace after the program's own
  import line, and its value is kept.
- Reported symptom on the pre-fix code (issue): "prints `Matrix([[0]])`."
- Expected behaviour (issue), one check per quote:
  * prints-nan-matrix: "Dividing a zero matrix with 0 should return a nan matrix" (title) and "The correct output would be
    `Matrix([[nan]])`." -- the program runs successfully and prints exactly ``Matrix([[nan]])``.
  * scalar-comparison: "For comparison, `sympify(0) / sympify(0) == nan`" -- the expression evaluates to true.
- Author: W9.10 witb-3 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import traceback

WITNESS = "sympy__sympy-28454"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sympy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["mpmath"]

# The issue's code block, verbatim.
ISSUE_PROGRAM = """from sympy import *
print(Matrix([0]) / 0)
"""
# The issue's comparison (inline code), verbatim.
COMPARISON = "sympify(0) / sympify(0) == nan"
EXPECTED_OUTPUT = "Matrix([[nan]])"

# Run in the program's process: report where sympy was imported from (fidelity of the subprocess).
PROBE = "import sympy, sys; sys.stderr.write('SYMPY_FILE=' + sympy.__file__ + chr(10))"


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the program's run and the comparison's value."""
    work = tempfile.mkdtemp(prefix="sympy-28454-")
    with open(os.path.join(work, "issue_28454.py"), "w", encoding="utf-8") as handle:
        handle.write(ISSUE_PROGRAM)
    proc = subprocess.run([sys.executable, "issue_28454.py"], cwd=work, capture_output=True, text=True, timeout=120, env=os.environ.copy())
    probe = subprocess.run([sys.executable, "-c", PROBE], cwd=work, capture_output=True, text=True, timeout=120, env=os.environ.copy())
    sympy_file = next((line[len("SYMPY_FILE="):] for line in probe.stderr.splitlines() if line.startswith("SYMPY_FILE=")), None)
    program = {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr[-1500:], "sympy_file": sympy_file}
    namespace = {"__name__": "__issue__"}
    exec(compile(ISSUE_PROGRAM.splitlines()[0], "<issue>", "exec"), namespace)  # the program's own import line
    try:
        comparison = ("value", eval(compile(COMPARISON, "<issue>", "eval"), namespace))
    except Exception as exc:  # noqa: BLE001  (the candidate's code raised: that check fails)
        comparison = ("error", error_text(exc))
    return {"program": program, "comparison": comparison}


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
        if error is not None:
            cases.append({"id": "prints-nan-matrix", "passed": False, "expected": EXPECTED_OUTPUT, "error": error})
            cases.append({"id": "scalar-comparison", "passed": False, "expected": True, "error": error})
        else:
            program = observed["program"]
            fidelity["program"] = program["sympy_file"]
            if root is not None and not inside(program["sympy_file"], root):
                problems.append(f"sympy was not imported from the candidate in the program's process ({program['sympy_file']})")
            printed = program["stdout"].strip()
            cases.append({"id": "prints-nan-matrix", "passed": program["exit"] == 0 and printed == EXPECTED_OUTPUT, "expected": {"exit": 0, "stdout": EXPECTED_OUTPUT}, "observed": {"exit": program["exit"], "stdout": printed, "stderr": program["stderr"]}})
            kind, value = observed["comparison"]
            if kind == "error":
                cases.append({"id": "scalar-comparison", "passed": False, "expression": COMPARISON, "expected": True, "error": value})
            else:
                passed = value is True or type(value).__name__ == "BooleanTrue"  # a Python or SymPy true
                cases.append({"id": "scalar-comparison", "passed": passed, "expression": COMPARISON, "expected": True, "observed": repr(value)})
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
