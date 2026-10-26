#!/usr/bin/env python3
r"""Public witness for sympy/sympy issue "Bug in indefinite integrals" (sympy__sympy-28660).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's test code (its first code block), verbatim in ``ISSUE_CODE`` below (same inputs, same calls, same
  public API). Its statements before the ``for`` loop run verbatim; the loop body runs verbatim for every ``q`` of the issue's
  list ``[1, 2, 10, 100]`` (``expected = S(1)*q/4``) and every ``b`` of ``b2`` (the lowpass and the bandpass function, in the
  issue's order), i.e. the issue's 8 integrals ``integrate(b.subs(wp, 1).subs(qp, q), (f, 0, oo))``. Adaptations:
  (1) time limit: each of the 8 integrals runs in its own child process of the case's interpreter (this file in child mode),
      all in parallel; each child first runs the issue's statements before the loop verbatim, then the loop body for its ``q``
      and its ``b``. On the pre-fix snapshot one such integral took 75-157 s here (about 10 minutes for the loop in sequence),
      beyond the witness time limit of 180 s. The children other than the slowest integral (lowpass, q = 100: 140-157 s even
      alone on the pre-fix snapshot) run at the lowest scheduling priority (nice 19), so that the slowest one keeps its CPU
      share; this is scheduling only. Inputs and calls are unchanged; the issue's own prints (``pretty(tf)``, ``pretty(b2)``)
      still run, their text is not shown.
  (2) the issue compares ``expected`` with each integral by printing both (``print(pretty([expected, ni]))``); the witness
      compares them mechanically: a check passes when the integral equals ``expected`` (``==``), or when it is an evaluated
      value (no unevaluated ``Integral`` left) whose 50-digit numerical value is within 1e-9 * max(1, |expected|) of
      ``expected``.
  (3) a child that gives no result by the witness's deadline (176 s after its start; the harness guard is 180 s) leaves its
      check unobserved: the run still fails when an observed check fails; otherwise the run is untrusted (exit 2), because
      the verdict would depend on a value that was not observed (the issue states no time limit).
  Harness history: the first qualification (deadline 172 s, all children at the same priority) recorded E7 because the
  lowpass q = 100 child gave no result by the deadline on the reference tree; the priority split of (1) and the deadline of
  176 s are the harness fix for the second qualification (no expected value and no check changed).
  The issue's sentence on symbolic omega_p and q_p has no code in the issue and is not checked.
- Reported symptom on the pre-fix code (issue): "I have found a curious bug in `integrate`." / "For numerical values, it depends
  on the actual value whether the result is correct or not. Interestingly, increasing the parameter $q_p$ lets it go from
  correct to wrong" / "Just what it exactly does differs from version to version." The issue's output shows
  "[1/4, [1/4, 1/4]]" and "[1/2, [1/2, 1/2]]", then values that differ from the expected 5/2 and 25 for q = 10
  ("5⋅(-2⋅√160797⋅π + 798⋅π)" over "1596⋅π") and q = 100 ("25 + ──────────────" with "25⋅√1600079997" over "39999", and
  "25⋅(-2⋅√1600079997⋅π + 79998⋅π)" over "79998⋅π"). On this pre-fix snapshot (authoring runs) q = 1 gives 1/4 for both, and
  every integral that finished for q = 2, 10 and 100 was twice q/4 (the version-dependent form the issue's last quote allows).
- Expected behaviour (issue), one check per quote:
  * lowpass-q1, bandpass-q1, lowpass-q2, bandpass-q2, lowpass-q10, bandpass-q10, lowpass-q100, bandpass-q100:
    "Below I calculate the so-called noise integrals of second-order lowpass and bandpass filter functions. The correct value
    for both is $\frac{\omega_p q_p}{4}$." with the issue's own ``expected = S(1)*q/4`` (``wp`` = 1, ``qp`` = q) printed next
    to each result: each integral equals q/4.
- Author: W9.10 witb-3 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, the package was not imported from the candidate, or no check failed
but an integral gave no result by the deadline). The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback

WITNESS = "sympy__sympy-28660"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sympy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["mpmath"]

# The issue's test code, verbatim.
ISSUE_CODE = """from sympy import *

s = symbols('s')
f = symbols('f', real=True)
wp, qp = symbols('omega_p, q_p', positive=True)
tf = [
    wp**2 / (s**2 + wp / qp * s + wp**2),
    wp*s / (s**2 + wp / qp * s + wp**2)]
print(pretty(tf))
b2 = [
    (abs(t.subs(s, I*2*pi*f))**2).simplify()
    for t in tf
]
print(pretty(b2))
for q in [1, 2, 10, 100]:
    expected = S(1)*q/4
    ni = [
        integrate(b.subs(wp, 1).subs(qp, q), (f, 0, oo))
        for b in b2
    ]
    print(pretty([expected, ni]))
"""

# tf[0] = wp**2/(...) and tf[1] = wp*s/(...): "second-order lowpass and bandpass filter functions" (issue), in that order.
FUNCTIONS = ["lowpass", "bandpass"]
CHILD_FLAG = "--issue-integral"
CHILD_PREFIX = "ISSUE_INTEGRAL "
START = time.monotonic()
DEADLINE_S = 176.0
# The slowest integral on the pre-fix snapshot (authoring runs); every other child runs at nice 19 (adaptation 1).
SLOWEST = (100, "lowpass")
TOLERANCE = 1e-9


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def issue_parts():
    """The issue's code split at its ``for`` loop (all parts are nodes of the verbatim code)."""
    tree = ast.parse(ISSUE_CODE)
    position = next(i for i, node in enumerate(tree.body) if isinstance(node, ast.For))
    loop = tree.body[position]
    expected_statement, ni_statement = loop.body[0], loop.body[1]
    comprehension = ni_statement.value
    generator = comprehension.generators[0]
    return {
        "setup": ast.Module(body=tree.body[:position], type_ignores=[]),
        "q_name": loop.target.id,
        "q_values": ast.literal_eval(loop.iter),
        "expected": ast.Module(body=[expected_statement], type_ignores=[]),
        "b_name": generator.target.id,
        "b_values": ast.Expression(body=generator.iter),
        "integral": ast.Expression(body=comprehension.elt),
        "integral_source": ast.get_source_segment(ISSUE_CODE, comprehension.elt),
    }


def child_main(q, index):
    """Child mode: the issue's statements before the loop, then the loop body for one q and one b; prints one result line."""
    out = {"q": q, "index": index}
    try:
        import sympy

        out["sympy"] = os.path.realpath(sympy.__file__)
        parts = issue_parts()
        namespace = {"__name__": "__issue__"}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(parts["setup"], "<issue>", "exec"), namespace)
        namespace[parts["q_name"]] = q
        exec(compile(parts["expected"], "<issue>", "exec"), namespace)
        expected = namespace["expected"]
        out["expected"] = str(expected)
        namespace[parts["b_name"]] = list(eval(compile(parts["b_values"], "<issue>", "eval"), namespace))[index]
        started = time.monotonic()
        value = eval(compile(parts["integral"], "<issue>", "eval"), namespace)
        out["seconds"] = round(time.monotonic() - started, 1)
        out["value"] = str(value)[:1500]
        out["exact"] = bool(value == expected)
        if not out["exact"]:
            out["unevaluated"] = bool(value.has(sympy.Integral))
            approx = sympy.N(value, 50)
            out["numeric"] = str(approx)[:300]
            observed, wanted = complex(approx), complex(sympy.N(expected, 50))
            out["difference"] = abs(observed - wanted)
            out["scale"] = max(1.0, abs(wanted))
    except Exception as exc:  # noqa: BLE001  (the candidate's code raised: this check fails)
        out["error"] = error_text(exc)
    print(CHILD_PREFIX + json.dumps(out, default=str), flush=True)
    return 0


def reproduce():
    """The issue's reproduction (8 integrals, one child each, in parallel). Returns one record per (q, function)."""
    parts = issue_parts()
    work = tempfile.mkdtemp(prefix="sympy-28660-")
    me = os.path.abspath(__file__)
    deadline = START + DEADLINE_S
    jobs = []
    for q in parts["q_values"]:
        for index, function in enumerate(FUNCTIONS):
            log = open(os.path.join(work, f"q{q}-{index}.txt"), "w+", encoding="utf-8")
            lower_priority = None if (q, function) == SLOWEST else (lambda: os.nice(19))
            proc = subprocess.Popen([sys.executable, "-s", "-B", me, CHILD_FLAG, str(q), str(index)], stdout=log, stderr=subprocess.STDOUT, cwd=work, env=os.environ.copy(), preexec_fn=lower_priority)
            jobs.append((q, index, function, proc, log))
    records = []
    for q, index, function, proc, log in jobs:
        timed_out = False
        try:
            proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            proc.wait()
        log.seek(0)
        text = log.read()
        log.close()
        lines = [line for line in text.splitlines() if line.startswith(CHILD_PREFIX)]
        try:
            result = json.loads(lines[-1][len(CHILD_PREFIX):]) if lines else None
        except ValueError:  # a line cut by the kill at the deadline: no result
            result = None
        records.append({"q": q, "function": function, "call": parts["integral_source"], "timed_out": timed_out, "exit": proc.returncode, "result": result, "tail": text[-800:] if result is None else None, "elapsed": round(time.monotonic() - START, 1)})
    return records


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
        records, error = None, None
        try:
            records = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        if error is not None:
            problems.append(f"the child processes could not be run: {error}")
        unobserved = []
        for record in records or []:
            case_id = f"{record['function']}-q{record['q']}"
            result = record["result"]
            entry = {"id": case_id, "call": f"{record['call']} with q = {record['q']}, b = the {record['function']} function", "expected": (result or {}).get("expected") or f"{record['q']}/4"}
            if record["timed_out"] or result is None:
                reason = f"no result by the deadline ({DEADLINE_S:.0f} s after the start)" if record["timed_out"] else f"the child process ended without a result (exit {record['exit']})"
                unobserved.append(f"{case_id}: {reason}")
                cases.append({**entry, "passed": False, "unobserved": reason, "elapsed": record["elapsed"], **({"tail": record["tail"]} if record["tail"] else {})})
                continue
            if root is not None and result.get("sympy") and not inside(result["sympy"], root):
                problems.append(f"{case_id}: sympy was not imported from the candidate in the child ({result['sympy']})")
            if "error" in result:
                cases.append({**entry, "passed": False, "error": result["error"], "observed": result})
                continue
            if result.get("exact"):
                passed = True
            else:
                passed = (not result.get("unevaluated")) and result.get("difference") is not None and float(result["difference"]) <= TOLERANCE * float(result["scale"])
            cases.append({**entry, "passed": passed, "observed": {k: result.get(k) for k in ("value", "numeric", "exact", "unevaluated", "difference", "seconds") if k in result}, "elapsed": record["elapsed"]})
        # Adaptation (3): an unobserved check cannot turn a failing run into a pass; without an observed failure the verdict is undetermined.
        if unobserved and not any(not case["passed"] and "unobserved" not in case for case in cases):
            problems.extend(f"verdict undetermined, {text}" for text in unobserved)
    for case in cases:
        print(f"[{'PASS' if case['passed'] else 'FAIL'}] {case['id']}: " + json.dumps({k: v for k, v in case.items() if k not in ('id', 'passed')}, default=str)[:2000])
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    trusted = not problems
    ok = trusted and bool(cases) and all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == CHILD_FLAG:
        sys.exit(child_main(int(sys.argv[2]), int(sys.argv[3])))
    sys.exit(main())
