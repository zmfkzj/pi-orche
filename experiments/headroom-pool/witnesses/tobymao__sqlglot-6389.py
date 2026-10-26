#!/usr/bin/env python3
"""Public witness for tobymao/sqlglot issue "MySQL Named Primary Key fails to parse" (tobymao__sqlglot-6389).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Repro" code block, verbatim below in `reproduce()` (same inputs, same calls, same dependency
  boundary): ``sqlglot.parse_one(query, read="mysql")`` on the issue's ``create table test (...)`` statement with
  ``primary key `test_pk` (id)``. The issue indents ``id int,`` with a tab and the other lines with four spaces. The tab is
  written as the escape ``\\t``, which gives the same string.
  Adaptations:
  1. Reference for "ignored". The issue says MySQL "will ignore that name and call it PRIMARY" and expects "Primary Key name
     should be ignored". The reference is the issue's statement without the name (``primary key (id)``, everything else
     unchanged). It parses on the pre-fix snapshot to ``sqlglot.exp.Create``. "Ignored" is checked on the public output: the
     parsed statement, generated back as MySQL, must equal the reference's generated MySQL. The check is on the output, not on
     the tree's internal shape.
  2. Only ``sqlglot`` is checked for import fidelity. ``pdoc`` (the documentation package at the repository root, also listed by
     the environment's import check) is not used by the reproduction.
- Reported symptom on the pre-fix code (issue): "sqlglot fails with a parse error in this case, even if mysql dialect is
  specified" / Actual: "sqlglot.errors.ParseError: Expecting ). Line 6, Col: 25."
- Expected behaviour (issue), one check per quote:
  * parses: "SQL should parse successfully." The issue's call returns without an exception, and the result is a CREATE statement
    (``sqlglot.exp.Create``, the node of the reference statement), not a fallback ``Command``.
  * pk-name-ignored: "Primary Key name should be ignored." with "(it will ignore that name and call it PRIMARY but it should
    parse)". The parsed statement generates the same MySQL as the statement without the name (adaptation 1). That output keeps
    ``PRIMARY KEY (id)`` and drops ``test_pk``.
- Author: W9.8 witb-1 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "tobymao__sqlglot-6389"
# Top-level modules of the project under test: they must be imported from the candidate tree (adaptation 2).
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
    query = """
create table test
(
\tid int,
    value varchar(5),
    primary key `test_pk` (id)
);
"""
    return sqlglot.parse_one(query, read="mysql")


def reference():
    """Adaptation 1: the issue's program with the primary key's name removed (everything else unchanged)."""
    import sqlglot
    query = """
create table test
(
\tid int,
    value varchar(5),
    primary key (id)
);
"""
    return sqlglot.parse_one(query, read="mysql")


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
        import sqlglot

        parsed, error = None, None
        try:
            parsed = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        kind = None if parsed is None else f"{type(parsed).__module__}.{type(parsed).__qualname__}"
        is_create = error is None and isinstance(parsed, sqlglot.exp.Create)
        cases.append({"id": "parses", "passed": is_create, "expected": "parses without an exception to sqlglot.expressions.Create (not a Command)", "observed": {"type": kind, "tree": repr(parsed)[:800] if parsed is not None else None}, **({"error": error} if error else {})})

        errors, observed_sql, reference_sql = ({"error": error} if error else {}), None, None
        try:
            reference_sql = reference().sql(dialect="mysql")
        except Exception as exc:  # noqa: BLE001
            errors["referenceError"] = error_text(exc)
        if parsed is not None:
            try:
                observed_sql = parsed.sql(dialect="mysql")
            except Exception as exc:  # noqa: BLE001
                errors["sqlError"] = error_text(exc)
        same = is_create and not errors and observed_sql is not None and reference_sql is not None and observed_sql == reference_sql
        cases.append({"id": "pk-name-ignored", "passed": same, "expected": {"sql (the statement without the primary key name)": reference_sql}, "observed": {"type": kind, "sql": observed_sql}, **errors})
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
