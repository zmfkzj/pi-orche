#!/usr/bin/env python3
"""Public witness for oemof/tespy issue "When working with `Ref` for temperature starting values for enthalpy should be
updated" (oemof__tespy-921).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's only code block, verbatim below in `reproduce()` (same inputs, same calls, same public API:
  ``Network``, ``Connection``, ``Ref``, ``Source``, ``Sink``, ``HeatExchanger``, two ``nw.solve("design")`` calls).
  Adaptations: (1) the block runs inside a function; (2) read-only observation lines are added after each
  ``nw.solve("design")``: the network's ``converged`` attribute, which the snapshot documents as the way to check a solve
  (src/tespy/networks/network.py, ``Network.solve`` docstring: "It is possible to check programatically, if a network was
  solved successfully with the `.converged` attribute."), the diagnostic ``status`` attribute, and ``c3.T.val`` /
  ``c4.T.val`` (the issue's own block reads ``c4.T.val``). Nothing of the issue's code is changed or reordered.
- Reported symptom on the pre-fix code (issue): "Right now, the starting values for enthalpy are not changed, if a `Ref`
  is set for a temperature and the referenced temperature is change. This can lead to linear dependencies, e.g. in context
  of heat exchangers:" (on the pre-fix snapshot the second ``nw.solve("design")`` stops with "Found singularity in Jacobian
  matrix, calculation aborted!", status 3, ``converged`` False).
- Expected behaviour (issue), one check per quote:
  * second-solve-converges: "When working with `Ref` for temperature starting values for enthalpy should be updated" (the
    issue's title), against the reported "This can lead to linear dependencies" -- after ``c3.set_attr(T=c4.T.val)`` the
    issue's second ``nw.solve("design")`` must not stop on the linear dependency: ``nw.converged`` is True after it.
  * ref-temperature-holds: the stated result of that solve is the issue's own specification ``c4.set_attr(T=Ref(c3, 1, 5))``
    together with ``c3.set_attr(T=c4.T.val)``. Public doc of ``Ref`` at the base commit (src/tespy/connections/connection.py,
    class ``Ref`` docstring): ".. math:: \\dot{m} = \\dot{m}_\\mathrm{ref} \\cdot \\mathrm{factor} + \\mathrm{delta}", with
    "factor : float / Factor to multiply specified property with." and "delta : float / Delta to add after multiplication."
    Hence after the second solve ``c4.T.val == c3.T.val * 1 + 5`` (factor 1 and delta 5 from the issue), within 1e-3 K (the
    solver's convergence bound ``ERR ** 0.5``: src/tespy/tools/global_vars.py ``ERR = 1e-6``, src/tespy/networks/network.py).
- Author: W9.6 wit-f (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback

WITNESS = "oemof__tespy-921"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["tespy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["CoolProp", "numpy", "pandas", "scipy", "pint", "tabulate"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def observe(nw, c3, c4):
    """Read-only observation after a solve (documented `converged`, diagnostic `status`, the temperatures)."""
    return {"converged": nw.converged, "status": getattr(nw, "status", None), "c3.T": c3.T.val, "c4.T": c4.T.val}


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    observed = {}
    from tespy.connections import Ref, Connection
    from tespy.networks import Network
    from tespy.components import Sink, Source, HeatExchanger


    nw = Network()
    nw.units.set_defaults(
        temperature="°C",
        pressure="bar"
    )

    so1 = Source("source1")
    si1 = Sink("sink1")
    so2 = Source("source2")
    si2 = Sink("sink2")

    hex = HeatExchanger("hex")

    c1 = Connection(so1, "out1", hex, "in1", label="c1")
    c2 = Connection(hex, "out1", si1, "in1", label="c2")
    c3 = Connection(so2, "out1", hex, "in2", label="c3")
    c4 = Connection(hex, "out2", si2, "in1", label="c4")

    nw.add_conns(c1, c2, c3, c4)

    c1.set_attr(fluid={"water": 1}, td_dew=10, T=70, m=1)
    c2.set_attr(x=0.5)

    c3.set_attr(fluid={"air": 1}, T=40, p=1)
    c4.set_attr(T=Ref(c3, 1, 5))

    hex.set_attr(dp1=0, dp2=0)

    nw.solve("design")
    observed["first"] = observe(nw, c3, c4)  # observation only (adaptation 2)
    c3.set_attr(T=c4.T.val)
    nw.solve("design")
    observed["second"] = observe(nw, c3, c4)  # observation only (adaptation 2)
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
        extra = {"error": error} if error else {}
        second = (observed or {}).get("second") or {}
        first = (observed or {}).get("first")
        cases.append({
            "id": "second-solve-converges",
            "passed": error is None and second.get("converged") is True,
            "expected": {"converged": True},
            "observed": {"second": second or None, "first": first},
            **extra,
        })
        try:
            expected_t4 = float(second["c3.T"]) * 1 + 5
            ref_ok = error is None and second.get("converged") is True and math.isclose(float(second["c4.T"]), expected_t4, rel_tol=0.0, abs_tol=1e-3)
        except Exception:  # noqa: BLE001  (no observation: the reproduction raised)
            expected_t4, ref_ok = None, False
        cases.append({
            "id": "ref-temperature-holds",
            "passed": ref_ok,
            "expected": {"c4.T": expected_t4, "rule": "c4.T == c3.T * 1 + 5 after the second solve"},
            "observed": {"c3.T": second.get("c3.T"), "c4.T": second.get("c4.T"), "converged": second.get("converged")},
            **extra,
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
