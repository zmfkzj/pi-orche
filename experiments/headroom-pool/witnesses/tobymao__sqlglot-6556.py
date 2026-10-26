#!/usr/bin/env python3
"""Public witness for tobymao/sqlglot issue "args with value of None are not ignored when perform semantic comparison"
(tobymao__sqlglot-6556).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's code block, verbatim below in `reproduce()` (same queries, schema, dialect and calls; the list
  ``delta`` of the non-``Keep`` edits is what the issue inspects). Adaptations: none (``sqlglot.diff.Update`` is imported after
  the issue's code only to count the edits of the type the issue names).
- Reported symptom on the pre-fix code (issue): "When compare with `diff` module, some expressions have args with value of None,
  so even this has not impact on semantic output, it still output `Update` objects." and "In the above example, there is one
  `Update`, the differences between source and target is: source does not have `db` and `catalog` keys, target has these keys,
  but both values are None."
- Expected behaviour (issue), one check per quote:
  * no-update: "so even this has not impact on semantic output, it still output `Update` objects" -- args whose value is None
    have no semantic impact, so ``delta`` holds no ``Update`` object.
  * empty-delta: "In the above example, there is one `Update`, the differences between source and target is: source does not
    have `db` and `catalog` keys, target has these keys, but both values are None." with "Maybe values with None can be
    ignored?" -- the issue's one edit comes only from None-valued args, so with them ignored ``delta`` is empty.
- Author: W9.9 witb-2 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "tobymao__sqlglot-6556"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sqlglot"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = []


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from sqlglot import parse_one
    from sqlglot.optimizer import optimize
    from sqlglot.diff import diff, Keep

    query1 = "SELECT a FROM b"
    query2 = "SELECT b.a FROM b"

    meta = {"b": {"a": "STRING"}}

    ast1 = parse_one(query1, dialect="bigquery")
    ast2 = parse_one(query2, dialect="bigquery")

    delta = [d for d in diff(optimize(ast1, schema=meta, dialect="bigquery"), optimize(ast2, schema=meta, dialect="bigquery")) if not isinstance(d, Keep)]

    from sqlglot.diff import Update  # observation only: the edit type the issue names

    return {
        "edit_types": [type(d).__name__ for d in delta],
        "updates": sum(1 for d in delta if isinstance(d, Update)),
        "delta": [repr(d)[:600] for d in delta],
        "update_arg_keys": [{"source": sorted(d.source.args), "target": sorted(d.target.args)} for d in delta if isinstance(d, Update)],
    }


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
        observed = observed or {}
        cases.append({"id": "no-update", "passed": error is None and observed.get("updates") == 0, "expected": "no Update object in delta", "observed": observed, **extra})
        cases.append({"id": "empty-delta", "passed": error is None and observed.get("edit_types") == [], "expected": "delta == []", "observed": observed.get("edit_types"), **extra})
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
