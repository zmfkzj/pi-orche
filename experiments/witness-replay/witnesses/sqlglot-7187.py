#!/usr/bin/env python3
"""Retained public reproducer for the sqlglot issue "DuckDB dialect parse error: `window function IGNORE NULLS`".

Where every input comes from (nothing else is used):
- The issue's fully reproducible snippet (verbatim SQL, ``parse_one(sql, dialect='duckdb')``), which raised
  ``Expecting ). Line 5, Col: 44.``; the issue links DuckDB's documentation of ``IGNORE NULLS`` in window functions.
- sqlglot's purpose (transpiling SQL without changing its meaning): DuckDB SQL that sqlglot parses and generates back
  must return what the original SQL returns in DuckDB itself.
- An earlier diagnostic made before any fix: ``LAST_VALUE(value ORDER BY idx IGNORE NULLS)`` (and the RESPECT variant)
  failed with ``ParseError: Expecting )``; the installed DuckDB natively accepts ORDER BY followed by IGNORE/RESPECT NULLS.

The case parses with ``read='duckdb'``, generates with ``dialect='duckdb'`` and runs the original and the generated SQL in
the environment's real DuckDB. Exit 0: the case behaves as expected. Exit 1: it does not. Exit 2: the run
cannot be trusted. The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "sqlglot-7187"
ISSUE_SQL = '''with 
ids as ( select * as idx from generate_series( 1, 4 ) ),
data as ( select *, ( case when idx != 3 then idx * 1.0 else null end ) as value from ids )
select value, 
       last_value( value order by idx ignore nulls ) over ( order by idx rows between unbounded preceding and 0 following ) last_value
from data'''


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def main() -> int:
    candidate_root, dep_root = os.environ.get("WITNESS_CANDIDATE_ROOT"), os.environ.get("WITNESS_DEP_ROOT")
    import duckdb
    import sqlglot

    problems, fidelity = [], {"sqlglot": os.path.realpath(sqlglot.__file__ or ""), "duckdb": os.path.realpath(duckdb.__file__ or "")}
    if candidate_root is not None and not inside(sqlglot.__file__, candidate_root):
        problems.append("sqlglot was not imported from the candidate")
    if dep_root is not None and not inside(duckdb.__file__, dep_root):
        problems.append("duckdb was not imported from the original environment")
    cases = []
    for case_id, sql in [("issue-snippet", ISSUE_SQL)]:
        observed = {}
        passed = False
        try:
            native = duckdb.connect().execute(sql).fetchall()
            observed["native"] = repr(native)
            generated = sqlglot.parse_one(sql, read="duckdb").sql(dialect="duckdb")
            observed["generated"] = generated
            roundtrip = duckdb.connect().execute(generated).fetchall()
            observed["roundtrip"] = repr(roundtrip)
            passed = roundtrip == native
        except Exception as error:  # noqa: BLE001
            observed["error"] = f"{type(error).__name__}: {str(error)[:400]}"
            observed["traceback"] = traceback.format_exc(limit=4)[-1200:]
        cases.append({"id": case_id, "passed": passed, "expected": "parses; generated DuckDB SQL returns the native rows", "observed": observed})
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: {json.dumps(observed, default=str)[:600]}")
    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
