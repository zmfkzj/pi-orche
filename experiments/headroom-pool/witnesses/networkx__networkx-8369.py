#!/usr/bin/env python3
"""Public witness for networkx/networkx issue (networkx__networkx-8369):
"Providing more than one argument to Digraph subclass leads to exception in __new__"

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Steps to Reproduce" code block, verbatim below in ``ISSUE_CODE`` (same subclass, same inputs,
  same calls), executed as a module; its test function ``test_child_graph()`` is then called. Adaptations:
  1. ``test_child_graph()`` is called directly instead of being collected by pytest (the issue's output is a pytest report;
     pytest calls a test function with no arguments, which is what the witness does).
  2. The test function returns nothing, so to report the observed values the witness repeats the test's own first statement
     ``g1 = ChildGraph(1, 2, 'a')`` and compares ``g1.arg1``/``g1.arg2``/``g1.arg3`` with the values the test asserts.
  3. Check ``kwargs``: the expected behaviour names "args and kwargs as defined by the subclass `__init__` method"; the issue's
     test passes positional arguments only, so the witness also passes the issue's same values to the parameters the issue's
     subclass ``__init__`` defines, positionally and by keyword: ``ChildGraph(1, arg2=2, arg3='a')``.
- Reported symptom on the pre-fix code (issue), for "g1 = ChildGraph(1, 2, 'a')":
  "E       TypeError: DiGraph.__new__() takes from 1 to 2 positional arguments but 4 were given"
- Expected behaviour (issue): "When subclassing Digraph, subclass's `__init__` should accept args and kwargs as defined by the subclass `__init__` method."
  One check per quote:
  * test-child-graph (args): the issue's test "g1 = ChildGraph(1, 2, 'a')" with "assert g1.arg1 == 1", "assert g1.arg2 == 2",
    "assert g1.arg3 == 'a'" -- the test returns, and the observed attributes equal the asserted values.
  * kwargs: "args and kwargs as defined by the subclass `__init__` method" -- ``ChildGraph(1, arg2=2, arg3='a')`` gives the
    same asserted values (arg1 == 1, arg2 == 2, arg3 == 'a').
- Author: W9.14 witb-7 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "networkx__networkx-8369"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["networkx"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = []

# The issue's "Steps to Reproduce" code block, verbatim (including the trailing space after the import).
ISSUE_CODE = '''import networkx as nx 

class ChildGraph(nx.DiGraph):
    def __init__(self, arg1, arg2 = 4, arg3 = 'b'):
        super().__init__()
        self.arg1 = arg1
        self.arg2 = arg2
        self.arg3 = arg3

def test_child_graph():
    g1 = ChildGraph(1, 2, 'a')

    assert g1.arg1 == 1
    assert g1.arg2 == 2
    assert g1.arg3 == 'a'
'''

# The values the issue's test asserts: "assert g1.arg1 == 1", "assert g1.arg2 == 2", "assert g1.arg3 == 'a'".
EXPECTED = {"arg1": 1, "arg2": 2, "arg3": "a"}


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def attributes(graph):
    return {name: getattr(graph, name, "<missing>") for name in EXPECTED}


def step(observed, key, action):
    """Run one call of the reproduction; record its value or the exception it raised."""
    try:
        observed[key] = action()
    except Exception as exc:  # noqa: BLE001  (an exception raised by the candidate's code is a failure)
        observed[key + "-error"] = error_text(exc)


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    namespace = {"__name__": "issue_reproduction"}
    exec(compile(ISSUE_CODE, "issue_reproduction.py", "exec"), namespace)  # noqa: S102  (the issue's code block)
    child_graph, test_child_graph = namespace["ChildGraph"], namespace["test_child_graph"]
    observed = {}
    step(observed, "test_child_graph", lambda: (test_child_graph(), "returned")[1])
    step(observed, "positional", lambda: attributes(child_graph(1, 2, 'a')))
    step(observed, "kwargs", lambda: attributes(child_graph(1, arg2=2, arg3='a')))
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
        if error is not None:
            for case_id in ("test-child-graph", "kwargs"):
                cases.append({"id": case_id, "passed": False, "expected": EXPECTED, "error": error})
        else:
            test_error = observed.get("test_child_graph-error") or observed.get("positional-error")
            case = {
                "id": "test-child-graph",
                "passed": observed.get("test_child_graph") == "returned" and observed.get("positional") == EXPECTED,
                "call": "test_child_graph(); ChildGraph(1, 2, 'a')",
                "expected": {"test_child_graph()": "returned", **EXPECTED},
                "observed": {"test_child_graph()": observed.get("test_child_graph"), **(observed.get("positional") or {})},
            }
            if test_error:
                case["error"] = test_error
            cases.append(case)
            case = {"id": "kwargs", "passed": observed.get("kwargs") == EXPECTED, "call": "ChildGraph(1, arg2=2, arg3='a')", "expected": EXPECTED, "observed": observed.get("kwargs")}
            if "kwargs-error" in observed:
                case["error"] = observed["kwargs-error"]
            cases.append(case)
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
