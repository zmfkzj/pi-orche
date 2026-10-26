#!/usr/bin/env python3
"""Audit-only NATIVE replay of the public narwhals issue "PySpark: dt.offset_by transformation on literal values fails with
UNSUPPORTED_EXPR_FOR_WINDOW error" (results/witness-replay/AUDIT.md, "Narwhals: native PySpark correction"). Never shown to a
model.

Source: the issue text only (results/ultra-ho/stage3-r2/validation/runs/narwhals-dev__narwhals-3478/F/r1/prompt.txt:12-39):
the issue's reproduction verbatim, on real PySpark (classic, local mode) - a one-row frame with a ``DateType`` column holding
``datetime.date(2026, 1, 31)``, ``nw.from_native``, then

- ``date_nw.with_columns(nw.col("date").dt.offset_by("-1d")).collect()``   - the issue: "works fine"
- ``date_nw.with_columns(nw.lit(sample_date).dt.offset_by("-1d")).collect()`` - the issue: throws UNSUPPORTED_EXPR_FOR_WINDOW;
  expected "No error is thrown and the Date lit is correctly offset".

"Correctly offset" by "-1d" is read as: the produced value is the calendar date 2026-01-30 - a ``date``, or a ``datetime`` at
midnight of that date in the Spark session's time zone (Spark's timestampadd yields a session-local timestamp for a date input,
which the issue's working column path also returns, and Arrow hands it over as an aware UTC datetime). The observed values and
types are recorded; the column path's value is recorded next to the literal's for comparison only.

Version 2 (results/witness-replay/audit/nw-native.invalid-1/NOTE.md): version 1 compared aware datetimes at midnight UTC (so
even the issue's working column path failed outside UTC) and crashed reading narwhals' version where no distribution metadata
exists; nothing else changed.

Environment, not behaviour (exit 2, trusted false): narwhals not imported from the candidate tree, PySpark/py4j/pyarrow not
imported from the declared native environment, the Spark session or the issue's DataFrame cannot be created, or a plain
``collect()`` of the issue's frame (no offset involved) fails - a dependency or JVM problem then cannot pass or fail the issue.

Sandbox configuration only (not the issue's code): local[1] master, loopback driver, no UI, warehouse in the working directory;
the session is stopped at the end. Exit 0 pass / 1 fail / 2 untrusted; the last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import platform
import sys
import traceback

WITNESS = "nw-3478-pyspark"
EXPECTED = dt.date(2026, 1, 30)


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def first_line(error: BaseException) -> str:
    text = str(error).strip().splitlines()
    return f"{type(error).__module__}.{type(error).__qualname__}: {text[0][:400] if text else ''}"


def calendar_date(value, zone):
    if isinstance(value, dt.datetime):
        if value.tzinfo is not None and zone is not None:
            value = value.astimezone(zone)
        return value.date() if (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0) else None
    if isinstance(value, dt.date):
        return value
    return None


def main() -> int:
    problems: list[str] = []
    env: dict[str, object] = {"python": sys.version.split()[0], "executable": sys.executable, "machine": platform.machine()}
    cases: list[dict[str, object]] = []
    spark = None

    def result(code_hint: int) -> int:
        trusted = not problems
        ok = trusted and bool(cases) and all(case["passed"] for case in cases)
        for problem in problems:
            print(f"[UNTRUSTED] {problem}")
        print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "cases": cases, "env": env}, default=str))
        return 0 if ok else (1 if trusted else 2)

    try:
        import narwhals as nw
        import py4j
        import pyarrow
        import pyspark
        from pyspark.sql import SparkSession
        from pyspark.sql.types import DateType, StructField, StructType
    except Exception as error:  # noqa: BLE001 - a missing dependency is an environment outcome
        problems.append(f"import failed: {first_line(error)}")
        return result(2)
    try:
        narwhals_version = nw.__version__
    except Exception:  # noqa: BLE001 - a source tree without distribution metadata has no version
        narwhals_version = None
    env.update(narwhals=narwhals_version, narwhalsFile=nw.__file__, pyspark=pyspark.__version__, pysparkFile=pyspark.__file__,
               py4j=getattr(py4j, "__version__", None), py4jFile=py4j.__file__, pyarrow=pyarrow.__version__, pyarrowFile=pyarrow.__file__)
    try:
        import numpy, pandas  # noqa: E401 - recorded only (not used by the reproduction)
        env.update(numpy=numpy.__version__, pandas=pandas.__version__)
    except Exception as error:  # noqa: BLE001
        env.update(optional=first_line(error))
    root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    if root is not None and not inside(nw.__file__, root):
        problems.append(f"narwhals was imported from {nw.__file__}, not from the candidate")
    native = os.environ.get("WITNESS_NATIVE_ROOT")
    if native is not None:
        for name, module in (("pyspark", pyspark), ("py4j", py4j)):
            if not inside(module.__file__, native):
                problems.append(f"{name} was imported from {module.__file__}, not from the native environment")
    deps = os.environ.get("WITNESS_DEP_ROOT")
    if deps is not None and not inside(pyarrow.__file__, deps):
        problems.append(f"pyarrow was imported from {pyarrow.__file__}, not from the environment")
    if problems:
        return result(2)

    try:
        spark = (SparkSession.builder.master("local[1]").config("spark.ui.enabled", "false").config("spark.driver.host", "127.0.0.1")
                 .config("spark.driver.bindAddress", "127.0.0.1").config("spark.sql.warehouse.dir", os.path.join(os.getcwd(), "spark-warehouse"))
                 .getOrCreate())
        jvm = spark.sparkContext._jvm
        env.update(sparkVersion=spark.version, javaVersion=jvm.java.lang.System.getProperty("java.version"), javaVendor=jvm.java.lang.System.getProperty("java.vendor"),
                   javaHome=jvm.java.lang.System.getProperty("java.home"), sessionTimeZone=spark.conf.get("spark.sql.session.timeZone"))
        # --- the issue's reproduction (prompt.txt:19-34), verbatim apart from the builder configuration above ---
        sample_date = dt.date(2026, 1, 31)
        date_frame = spark.createDataFrame(data=[(sample_date,)], schema=StructType([StructField(name="date", dataType=DateType())]))
        env.update(nativeFrame=f"{type(date_frame).__module__}.{type(date_frame).__qualname__}", nativeSchema=date_frame.schema.simpleString())
        date_nw = nw.from_native(date_frame)
        env.update(narwhalsFrame=f"{type(date_nw).__module__}.{type(date_nw).__qualname__}")
        plain = date_nw.collect()
        env.update(plainCollect={"columns": list(plain.columns), "row": [repr(v) for v in plain.rows()[0]], "eager": f"{type(plain.to_native()).__module__}.{type(plain.to_native()).__qualname__}"})
    except Exception as error:  # noqa: BLE001 - the JVM, the session or the issue's frame is not available
        problems.append(f"environment: {first_line(error)}")
        env.update(environmentTraceback=traceback.format_exc(limit=6)[-2000:])
        return result(2)

    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo(str(env["sessionTimeZone"]))
    except Exception as error:  # noqa: BLE001 - without the session zone an aware timestamp cannot be read as a date
        problems.append(f"environment: session time zone {env.get('sessionTimeZone')!r} unusable: {first_line(error)}")
        return result(2)

    def case(case_id: str, expression, expectation: str):
        observed: dict[str, object] = {}
        passed = False
        try:
            out = date_nw.with_columns(expression).collect()
            new = [name for name in out.columns if name != "date"]
            column = new[0] if new else "date"
            value = out.rows(named=True)[0][column]
            day = calendar_date(value, zone)
            observed.update(columns=list(out.columns), column=column, value=repr(value), type=type(value).__name__, calendarDate=str(day) if day else None)
            passed = day == EXPECTED
        except Exception as error:  # noqa: BLE001 - the issue's failure mode is an exception
            observed.update(error=first_line(error), traceback=traceback.format_exc(limit=8)[-1500:])
        cases.append({"id": case_id, "passed": passed, "expected": expectation, "observed": observed})
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: expected {expectation}; observed {json.dumps({k: v for k, v in observed.items() if k != 'traceback'}, default=str)}")

    try:
        case("issue-column-offset-works", nw.col("date").dt.offset_by("-1d"), "no exception; date column offset to 2026-01-30 (the issue: works fine)")
        case("issue-literal-offset", nw.lit(sample_date).dt.offset_by("-1d"), "no exception; the Date literal offset to 2026-01-30 (the issue's expected result)")
    finally:
        try:
            spark.stop()
        except Exception:  # noqa: BLE001
            pass
    return result(0)


if __name__ == "__main__":
    sys.exit(main())
