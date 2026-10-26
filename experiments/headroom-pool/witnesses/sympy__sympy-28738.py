#!/usr/bin/env python3
"""Public witness for sympy/sympy issue "Summation of matrices with null range returns Zero instead of ZeroMatrix"
(sympy__sympy-28738).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's two IPython code blocks, inputs In [3] to In [10] verbatim in ``SESSION`` below (same inputs, same
  calls, same public API), run in order in one fresh namespace; the value of every expression input is kept as IPython displays
  it in its ``Out[n]``. Adaptations:
  (1) the session's inputs before In [3] are not shown; the names it uses without importing them (``MatrixSymbol``, ``Sum``,
      ``ZeroMatrix``) are SymPy's public top-level names, so the session starts with ``from sympy import *`` (determined by
      the names the issue's own inputs use);
  (2) the inputs are run with exec/eval inside a function (``from sympy import *`` is only allowed at module level); an
      exception raised by one input is recorded as that input's result, so each check fails on its own.
- Reported symptom on the pre-fix code (issue): "Summation of matrices with null range returns Zero instead of ZeroMatrix";
  "In [7]: expr.doit()" / "Out[7]: 0"; "In [8]: type(expr.doit())" / "Out[8]: sympy.core.numbers.Zero";
  "In [9]: expr.doit() == ZeroMatrix(3, 3)" / "Out[9]: False"; "`.simplify()` is also affected:" /
  "In [10]: type(expr.simplify())" / "Out[10]: sympy.core.numbers.Zero".
- Expected behaviour (issue), one check per quote:
  * doit-type: "returns Zero instead of ZeroMatrix" (title), for "In [8]: type(expr.doit())": the type is ``ZeroMatrix``
    (or a subclass of it), not ``sympy.core.numbers.Zero``.
  * doit-equals-zeromatrix: "returns Zero instead of ZeroMatrix" (title), for "In [9]: expr.doit() == ZeroMatrix(3, 3)", whose
    pre-fix "Out[9]: False" the issue reports as wrong: the comparison is true.
  * simplify-type: "`.simplify()` is also affected:" with "returns Zero instead of ZeroMatrix" (title), for
    "In [10]: type(expr.simplify())": the type is ``ZeroMatrix`` (or a subclass of it), not ``sympy.core.numbers.Zero``.
- Author: W9.10 witb-3 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import ast
import json
import os
import sys
import traceback

WITNESS = "sympy__sympy-28738"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sympy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["mpmath"]

# Adaptation (1): the elided start of the session.
SESSION_START = "from sympy import *"
# The issue's IPython inputs, verbatim (prompt, input).
SESSION = [
    ("In [3]", "from sympy.abc import i"),
    ("In [4]", 'M = MatrixSymbol("M", 3, 3)'),
    ("In [5]", "expr = Sum(M, (i, 0, -1))"),
    ("In [6]", "expr"),
    ("In [7]", "expr.doit()"),
    ("In [8]", "type(expr.doit())"),
    ("In [9]", "expr.doit() == ZeroMatrix(3, 3)"),
    ("In [10]", "type(expr.simplify())"),
]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def run_input(source, namespace):
    """One session input: an expression is evaluated and its value returned (as Out[n]); a statement is executed (None)."""
    tree = ast.parse(source)
    if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr):
        return eval(compile(ast.Expression(tree.body[0].value), "<issue>", "eval"), namespace)
    exec(compile(tree, "<issue>", "exec"), namespace)
    return None


def reproduce():
    """The issue's reproduction, verbatim. Returns {prompt: ("value", value) | ("error", text)}."""
    namespace = {"__name__": "__issue__"}
    exec(compile(SESSION_START, "<issue>", "exec"), namespace)
    observed = {}
    for prompt, source in SESSION:
        try:
            observed[prompt] = ("value", run_input(source, namespace))
        except Exception as exc:  # noqa: BLE001  (the candidate's code raised: the checks on this input fail)
            observed[prompt] = ("error", error_text(exc))
    return observed


def is_zero_matrix_type(value, zero_matrix):
    return isinstance(value, type) and issubclass(value, zero_matrix)


def show(value):
    """An unambiguous text of an observed value (SymPy's str printer shows ZeroMatrix and Zero both as 0)."""
    try:
        import sympy

        if isinstance(value, sympy.Basic):
            return sympy.srepr(value)
    except Exception:  # noqa: BLE001
        pass
    return repr(value)


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
        checks = [
            ("doit-type", "In [8]", "type(expr.doit())", "ZeroMatrix (or a subclass)"),
            ("doit-equals-zeromatrix", "In [9]", "expr.doit() == ZeroMatrix(3, 3)", "True"),
            ("simplify-type", "In [10]", "type(expr.simplify())", "ZeroMatrix (or a subclass)"),
        ]
        zero_matrix = None
        if error is None:
            try:
                import sympy

                zero_matrix = sympy.ZeroMatrix
            except Exception as exc:  # noqa: BLE001
                error = error_text(exc)
        for case_id, prompt, source, expected in checks:
            entry = {"id": case_id, "input": f"{prompt}: {source}", "expected": expected}
            if error is not None:
                cases.append({**entry, "passed": False, "error": error})
                continue
            kind, value = observed.get(prompt, ("error", "the input was not run"))
            if kind == "error":
                cases.append({**entry, "passed": False, "error": value})
                continue
            try:
                if case_id == "doit-equals-zeromatrix":
                    passed = bool(value == True)  # noqa: E712  (the issue's Out[9] displays a truth value)
                else:
                    passed = is_zero_matrix_type(value, zero_matrix)
            except Exception as exc:  # noqa: BLE001
                cases.append({**entry, "passed": False, "observed": repr(value), "error": error_text(exc)})
                continue
            extra = {}
            if case_id == "doit-type":
                doit = observed.get("In [7]", ("error", "not run"))
                extra = {"doit": show(doit[1]) if doit[0] == "value" else doit[1]}
            cases.append({**entry, "passed": passed, "observed": repr(value), **extra})
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
