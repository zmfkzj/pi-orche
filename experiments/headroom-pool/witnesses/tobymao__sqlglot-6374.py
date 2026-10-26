#!/usr/bin/env python3
"""Public witness for tobymao/sqlglot issue "Table in INSERT INTO can have alias without AS for Oracle" (tobymao__sqlglot-6374).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's code block, verbatim below in `reproduce()`:
  ``s = "insert into t1 t1 (col1) SELECT 1935 AS col1 from duel"`` / ``parse_one(s, dialect="oracle")``. Adaptations:
  1. The value of ``parse_one(s, dialect="oracle")`` is kept for the checks (the issue's snippet discards it).
  2. The issue's comparison statement is built from its text
     "The statement will parse correctly if AS is added for table alias, i.e. `t1 AS t1`":
     ``insert into t1 AS t1 (col1) SELECT 1935 AS col1 from duel``, parsed the same way.
- Reported symptom on the pre-fix code (issue):
  "This code cannot be parsed due to Invalid expression / Unexpected token. Line 1, Col: 17".
- Expected behaviour (issue), one check per quote:
  * parses: "Table in INSERT INTO can have alias without AS for Oracle" (title) -- ``parse_one(s, dialect="oracle")`` returns an
    INSERT statement without an error.
  * alias-without-as: "`AS` is not required for table alias in the `INTO`" -- the INSERT's target table ``t1`` has the table
    alias ``t1``.
  * same-as-with-as: "The statement will parse correctly if AS is added for table alias, i.e. `t1 AS t1`" -- without ``AS`` the
    statement keeps what the parse of the ``t1 AS t1`` statement keeps: the same target table, alias and column identifiers
    (``t1``, ``t1``, ``col1``) and the same SELECT. The node layout of the target (where the column list is attached) is not
    compared: the issue states none.
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

WITNESS = "tobymao__sqlglot-6374"
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


def facts(statement):
    """What the checks compare, read with sqlglot's public expression API (independent of the target's node layout)."""
    from sqlglot import exp

    out = {"type": type(statement).__name__, "repr": repr(statement)[:1200]}
    if not isinstance(statement, exp.Insert):
        return out
    target = statement.this
    tables = list(target.find_all(exp.Table)) if isinstance(target, exp.Expression) else []
    out["target_tables"] = [{"name": table.name, "alias": table.alias} for table in tables]
    out["target_identifiers"] = sorted(node.name for node in target.find_all(exp.Identifier)) if isinstance(target, exp.Expression) else None
    select = statement.expression
    out["select"] = select.sql() if isinstance(select, exp.Expression) else None
    return out


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from sqlglot import parse_one

    observed = {}
    try:
        s = "insert into t1 t1 (col1) SELECT 1935 AS col1 from duel"

        result = parse_one(s, dialect="oracle")  # adaptation 1: the value is kept
        observed["issue"] = facts(result)
    except Exception as exc:  # noqa: BLE001
        observed["issue"] = {"error": error_text(exc)}
    try:
        # adaptation 2: "if AS is added for table alias, i.e. `t1 AS t1`"
        result = parse_one("insert into t1 AS t1 (col1) SELECT 1935 AS col1 from duel", dialect="oracle")
        observed["with_as"] = facts(result)
    except Exception as exc:  # noqa: BLE001
        observed["with_as"] = {"error": error_text(exc)}
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
        observed, error = {}, None
        try:
            observed = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        extra = {"error": error} if error else {}
        issue, with_as = observed.get("issue") or {}, observed.get("with_as") or {}
        parsed = error is None and "error" not in issue and issue.get("type") == "Insert"
        cases.append({"id": "parses", "passed": parsed, "expected": "an Insert, no error", "observed": issue, **extra})
        cases.append({"id": "alias-without-as", "passed": parsed and issue.get("target_tables") == [{"name": "t1", "alias": "t1"}], "expected": [{"name": "t1", "alias": "t1"}], "observed": issue.get("target_tables"), **extra})
        compared = ("target_tables", "target_identifiers", "select")
        same = parsed and "error" not in with_as and with_as.get("type") == "Insert" and all(issue.get(key) == with_as.get(key) for key in compared) and with_as.get("target_identifiers") == ["col1", "t1", "t1"]
        cases.append({"id": "same-as-with-as", "passed": same, "expected": {key: with_as.get(key) for key in compared}, "observed": {key: issue.get(key) for key in compared}, "with_as": with_as, **extra})
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
