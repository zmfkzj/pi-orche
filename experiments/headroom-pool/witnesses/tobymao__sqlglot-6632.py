#!/usr/bin/env python3
"""Public witness for tobymao/sqlglot issue "Fails to parse subquery followed by a join (snowflake)" (tobymao__sqlglot-6632).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's first code block, verbatim below in `reproduce()`:
  ``sqlglot.parse("UPDATE test SET t = 1 FROM (select id from test2) t2 JOIN test3 t3 on t2.id = t3.id;", read="snowflake")``.
  Adaptations: ``import sqlglot`` (the call names the module; the issue's interactive session omits the import). The issue's
  second code block (the same statement without the brackets) is the issue's workaround, shown parsing on the pre-fix code; it is
  not an expectation for the bracketed statement and is not run.
- Reported symptom on the pre-fix code (issue): "sqlglot.errors.ParseError: Invalid expression / Unexpected token. Line 1, Col: 57."
- Expected behaviour (issue), one check per quote:
  * parses: "This is a valid query on Snowflake." (title: "Fails to parse subquery followed by a join (snowflake)") -- the call
    returns without an error and yields one UPDATE statement, the shape of the issue's correct parse of the statement written
    without the brackets (second block: "The query parses correctly:" / "[Update(").
  * target-and-set: the parsed UPDATE keeps the statement's target and SET clause, the nodes of the issue's correct parse:
    "this=Table(" / "this=Identifier(this=test, quoted=False))" and "expressions=[" / "EQ(" / "this=Column(" /
    "this=Identifier(this=t, quoted=False))," / "expression=Literal(this=1, is_string=False))]".
  * subquery-t2: the parse keeps the bracketed subquery ``(select id from test2)`` with its alias ``t2``
    (title: "subquery followed by a join"; the statement's ``FROM (select id from test2) t2``).
  * join-t3: the parse keeps the join that follows the subquery, the node of the issue's correct parse:
    "Join(" / "this=Table(" / "this=Identifier(this=test3, quoted=False)," / "alias=TableAlias(" /
    "this=Identifier(this=t3, quoted=False)))," / "on=EQ(" over ``t2.id`` and ``t3.id`` (the statement's ``on t2.id = t3.id``).
    Where the parser attaches the subquery and the join in the tree is not checked (the issue states no tree for the bracketed
    statement).
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

WITNESS = "tobymao__sqlglot-6632"
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
    import sqlglot

    return sqlglot.parse("UPDATE test SET t = 1 FROM (select id from test2) t2 JOIN test3 t3 on t2.id = t3.id;", read="snowflake")


def describe(statements):
    """The facts the checks need, read from the parsed statements with sqlglot's public expression API."""
    from sqlglot import exp

    facts = {"statements": [type(statement).__name__ for statement in statements], "repr": repr(statements)[:1500]}
    update = statements[0] if len(statements) == 1 and isinstance(statements[0], exp.Update) else None
    facts["one_update"] = update is not None
    if update is None:
        return facts
    target = update.this
    facts["target"] = {"type": type(target).__name__, "name": getattr(target, "name", None), "alias": getattr(target, "alias", None)}
    facts["set"] = [{"type": type(item).__name__, "sql": item.sql()} for item in update.expressions]
    facts["subqueries"] = [{"alias": node.alias, "this": type(node.this).__name__, "sql": node.this.sql() if node.this is not None else None} for node in update.find_all(exp.Subquery)]
    facts["joins"] = [
        {
            "this": type(node.this).__name__,
            "name": getattr(node.this, "name", None),
            "alias": getattr(node.this, "alias", None),
            "on": node.args["on"].sql() if node.args.get("on") is not None else None,
        }
        for node in update.find_all(exp.Join)
    ]
    return facts


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
        facts, error = {}, None
        try:
            facts = describe(reproduce())
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        extra = {"error": error} if error else {}
        cases.append({"id": "parses", "passed": error is None and facts.get("one_update") is True, "expected": "no error; one Update statement", "observed": {k: facts.get(k) for k in ("statements", "repr")}, **extra})
        target, assignments = facts.get("target") or {}, facts.get("set")
        cases.append({"id": "target-and-set", "passed": error is None and target.get("type") == "Table" and target.get("name") == "test" and not target.get("alias") and assignments == [{"type": "EQ", "sql": "t = 1"}], "expected": {"target": "Table test", "set": ["EQ t = 1"]}, "observed": {"target": target, "set": assignments}, **extra})
        subqueries = facts.get("subqueries") or []
        cases.append({"id": "subquery-t2", "passed": error is None and any(item["alias"] == "t2" and item["this"] == "Select" and item["sql"] == "SELECT id FROM test2" for item in subqueries), "expected": "a subquery `select id from test2` aliased t2", "observed": subqueries, **extra})
        joins = facts.get("joins") or []
        cases.append({"id": "join-t3", "passed": error is None and any(item["this"] == "Table" and item["name"] == "test3" and item["alias"] == "t3" and item["on"] == "t2.id = t3.id" for item in joins), "expected": "Join(Table test3 alias t3, on t2.id = t3.id)", "observed": joins, **extra})
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
