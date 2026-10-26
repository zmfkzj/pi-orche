#!/usr/bin/env python3
"""Audit-only probe (never shown to a model) for the narwhals issue "PySpark: dt.offset_by transformation on literal values
fails with UNSUPPORTED_EXPR_FOR_WINDOW error" - the candidate witness that did NOT qualify (results/witness-replay/AUDIT.md).

The issue's reproduction needs PySpark, which the task environment does not have (no pyspark, no network). Two stand-ins:
- spark-like: narwhals' Spark-like backend through SQLFrame (the PySpark API on DuckDB), the issue's code otherwise verbatim:
  ``nw.col("date").dt.offset_by("-1d")`` works, ``nw.lit(sample_date).dt.offset_by("-1d")`` must also work.
- duckdb-native: the same two expressions on a native DuckDB relation. The issue does not mention DuckDB, and in this
  environment (duckdb 2.0.0, the issue reports 1.4.4) the COLUMN offset already fails on the unmodified code, so this
  stand-in demands an unreported, environment-specific fix.
Pass/fail per backend; exit 0 only when everything passes. The last line is ``WITNESS_RESULT <json>``.

Superseded for qualification by the native replay (audit-only/nw-3478-pyspark.py, audit-native.ts): SQLFrame is not the
issue's PySpark boundary; these stand-in results are kept as recorded (results/witness-replay/audit/audit.json).
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys


def main() -> int:
    import narwhals as nw

    sample = dt.date(2026, 1, 31)
    cases = []

    def attempt(case_id, fn, expect):
        try:
            value = fn()
            passed = value == expect
            cases.append({"id": case_id, "passed": passed, "observed": repr(value)})
        except Exception as error:  # noqa: BLE001
            cases.append({"id": case_id, "passed": False, "observed": f"{type(error).__name__}: {str(error).splitlines()[0][:200]}"})
        print(f"[{'PASS' if cases[-1]['passed'] else 'FAIL'}] {case_id}: {cases[-1]['observed']}")

    from sqlframe.duckdb import DuckDBSession
    from sqlframe.duckdb import types as T

    spark = DuckDBSession()
    frame = nw.from_native(spark.createDataFrame(data=[(sample,)], schema=T.StructType([T.StructField("date", T.DateType())])))
    shifted = dt.datetime(2026, 1, 30, 0, 0)
    attempt("spark-like-column-offset", lambda: frame.with_columns(nw.col("date").dt.offset_by("-1d")).collect().to_dict(as_series=False), {"date": [shifted]})
    attempt("spark-like-literal-offset", lambda: frame.with_columns(nw.lit(sample).dt.offset_by("-1d")).collect().to_dict(as_series=False), {"date": [sample], "literal": [shifted]})
    import duckdb

    native = nw.from_native(duckdb.sql("SELECT DATE '2026-01-31' AS date"))
    attempt("duckdb-native-column-offset", lambda: native.with_columns(nw.col("date").dt.offset_by("-1d")).collect().to_dict(as_series=False), {"date": [shifted]})
    attempt("duckdb-native-literal-offset", lambda: native.with_columns(nw.lit(sample).dt.offset_by("-1d")).collect().to_dict(as_series=False), {"date": [sample], "literal": [shifted]})
    ok = all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": "nw-3478-audit", "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": True, "problems": [], "cases": cases}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
