#!/usr/bin/env python3
"""Public witness for sympy/sympy issue "Rust code printing fails to parenthesize correctly when TypeCast is an argument to
Mul, generating wrong code" (sympy__sympy-28467).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's first code block (```python), verbatim below in ``ISSUE_BLOCK`` (same inputs, same calls, same
  public API: ``sympy.printing.rust_code`` and ``ccode`` on the issue's expression, the three ``print`` lines). The issue's
  second python block is an excerpt of the printer's source, not a reproduction, and is not run. Adaptations:
  1. The block is executed as module code (``exec`` of the verbatim text in a fresh namespace) inside ``reproduce()``; its
     printed lines are captured (and still echoed) so that the line the block prints for ``rust_code(exp)`` is compared.
- Reported symptom on the pre-fix code (issue): "the following python code produces invalid rust code" with the printed line
  "rust    (1_f64/3.0)*0.5 + (2*(-0.025167785*lwe_dimension + modulus.ln()/2_i32.ln() + 4.10067100000001).ceil()).exp2()*modulus.powi(-2)".
- Expected behaviour (issue), one check per quote:
  * rust-output: "expected ouput for rust:" / "(1_f64/3.0)*(0.5 + (2*(-0.025167785*lwe_dimension + modulus.ln()/2_i32.ln() +
    4.10067100000001).ceil()).exp2())*modulus.powi(-2)" -- the block's ``print("rust   ", rust_code(exp))`` line is
    ``rust    `` followed by exactly that text.
- Author: W9.11 witb-4 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden
  tests and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback

WITNESS = "sympy__sympy-28467"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sympy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["mpmath"]

# The issue's first code block, verbatim.
ISSUE_BLOCK = '''import sympy
from sympy.printing import rust_code, ccode

# 2**(-2*log(modulus)/log(2) + 4.44) +
# (2**(2*ceiling(-0.025167785*lwe_dimension + log(modulus)/log(2) + 4.10067100000001)) + 0.5)/(3*modulus**2)

modulus = sympy.Symbol("modulus")
lwe_dimension = sympy.Symbol("lwe_dimension")

exp = (
    2
    ** (
        2
        * sympy.ceiling(
            -0.025167785 * lwe_dimension + sympy.log(modulus) / sympy.log(2) + 4.10067100000001
        )
    )
    + 0.5
) / (3 * modulus**2)

print("sympy  ", exp)
print("rust   ", rust_code(exp))
print("C      ", ccode(exp))
'''

# The issue: "expected ouput for rust:"
EXPECTED_RUST = "(1_f64/3.0)*(0.5 + (2*(-0.025167785*lwe_dimension + modulus.ln()/2_i32.ln() + 4.10067100000001).ceil()).exp2())*modulus.powi(-2)"
# The prefix the block's print("rust   ", ...) writes before the code (print's separator adds one space).
RUST_PREFIX = "rust    "


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


class Tee(io.StringIO):
    def write(self, text):
        sys.__stdout__.write(text)
        return super().write(text)


def reproduce():
    """The issue's reproduction, verbatim. Returns the lines it printed."""
    out = Tee()
    namespace = {"__name__": "__main__"}
    with contextlib.redirect_stdout(out):
        exec(compile(ISSUE_BLOCK, "issue_28467.py", "exec"), namespace)
    return {"lines": out.getvalue().splitlines()}


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
        rust_lines = [line for line in (observed or {}).get("lines", []) if line.startswith(RUST_PREFIX)]
        rust = rust_lines[0][len(RUST_PREFIX):] if rust_lines else None
        cases.append({"id": "rust-output", "passed": error is None and rust == EXPECTED_RUST, "expected": EXPECTED_RUST, "observed": rust, "printed": (observed or {}).get("lines"), **({"error": error} if error else {})})
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
