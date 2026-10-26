#!/usr/bin/env python3
"""Public witness for tobymao/sqlglot issue "[Snowflake] EPOCH_MILLISECONDS being changed to EPOCH_SECONDS * 1000 on roundtrip"
(tobymao__sqlglot-6573).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Fully reproducible code snippet", verbatim below in `reproduce()` (same inputs, same calls, same
  dependency boundary): ``from sqlglot import parse_one`` and
  ``parse_one("select date_part(epoch_milliseconds, current_timestamp()) as a", dialect="snowflake").sql(dialect="snowflake")``.
  Adaptations:
  1. The snippet is an interactive session. The ``>>>`` prompts are dropped, and the string the session echoes is the value the
     call returns.
  2. Conditional expected output. The issue gives its expected output only "if converting to EXTRACT is correct", so the exact
     string is required only when the output converts to EXTRACT (contains ``EXTRACT(``). An output that does not convert to
     EXTRACT is judged only by the issue's unconditional statements (checks no-epoch-seconds-times-1000 and epoch-milliseconds-kept).
  3. Spelling of the time part. Within the output, the part ``EPOCH_MILLISECONDS`` is compared case-insensitively and with or
     without the final ``S``. The issue writes the part in lower case in its input and in upper case in its expected output. The
     snapshot's own date-part table maps ``"EPOCH_MILLISECONDS"`` to ``"EPOCH_MILLISECOND"`` (sqlglot/dialects/dialect.py:860, in
     ``DATE_PART_MAPPING`` at :782). Everything else in the expected string is compared exactly.
- Reported symptom on the pre-fix code (issue): "SQLGlot currently converts `EPOCH_MILLISECONDS` to `EPOCH_SECONDS * 1000` which
  results in a loss of precision." / output "'SELECT EXTRACT(epoch_second FROM CAST(CURRENT_TIMESTAMP() AS TIMESTAMP)) * 1000 AS a'"
- Expected behaviour (issue), one check per quote:
  * no-epoch-seconds-times-1000: "EPOCH_MILLISECONDS being changed to EPOCH_SECONDS * 1000 on roundtrip" (title) / "SQLGlot
    currently converts `EPOCH_MILLISECONDS` to `EPOCH_SECONDS * 1000` which results in a loss of precision." The output contains
    neither an epoch-second part (``epoch_second`` or ``epoch_seconds``, any case) nor a multiplication by 1000.
  * epoch-milliseconds-kept: "EPOCH_MILLISECONDS being changed to EPOCH_SECONDS * 1000 on roundtrip" (title) / "`EPOCH_MILLISECONDS`
    is valid time part". The roundtrip output still extracts the ``EPOCH_MILLISECONDS`` part (adaptation 3).
  * extract-output: "The expected output (if converting to EXTRACT is correct):" /
    "'SELECT EXTRACT(EPOCH_MILLISECONDS FROM CAST(CURRENT_TIMESTAMP() AS TIMESTAMP)) AS a'" (adaptations 2 and 3).
- Author: W9.8 witb-1 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import re
import sys
import traceback

WITNESS = "tobymao__sqlglot-6573"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sqlglot"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = []

# The issue's expected output (if converting to EXTRACT is correct), verbatim.
EXPECTED_EXTRACT = "SELECT EXTRACT(EPOCH_MILLISECONDS FROM CAST(CURRENT_TIMESTAMP() AS TIMESTAMP)) AS a"
# Adaptation 3: the EPOCH_MILLISECONDS part in any case, with or without the final S.
EPOCH_MILLISECONDS = re.compile(r"\bEPOCH_MILLISECONDS?\b", re.IGNORECASE)
# The reported conversion: an epoch-second part and a multiplication by 1000.
EPOCH_SECONDS = re.compile(r"\bEPOCH_SECONDS?\b", re.IGNORECASE)
TIMES_1000 = re.compile(r"\*\s*1000\b")


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim (adaptation 1). Returns the observed values the checks need."""
    from sqlglot import parse_one
    return parse_one("select date_part(epoch_milliseconds, current_timestamp()) as a", dialect="snowflake").sql(dialect="snowflake")


def spelled(sql):
    """Adaptation 3: one spelling for the EPOCH_MILLISECONDS part."""
    return EPOCH_MILLISECONDS.sub("EPOCH_MILLISECONDS", sql)


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
        failed = {"error": error} if error else {}
        text = observed if isinstance(observed, str) else None

        lossy = None if text is None else {"epochSecondPart": EPOCH_SECONDS.findall(text), "times1000": TIMES_1000.findall(text)}
        passed = text is not None and not lossy["epochSecondPart"] and not lossy["times1000"]
        cases.append({"id": "no-epoch-seconds-times-1000", "passed": passed, "expected": "no epoch_second(s) part and no '* 1000'", "observed": {"sql": observed, "found": lossy}, **failed})

        kept = None if text is None else EPOCH_MILLISECONDS.findall(text)
        cases.append({"id": "epoch-milliseconds-kept", "passed": bool(kept), "expected": "the EPOCH_MILLISECONDS part (any case, with or without the final S)", "observed": {"sql": observed, "found": kept}, **failed})

        applicable = text is not None and "EXTRACT(" in text.upper()
        if text is None:
            passed = False
        elif applicable:
            passed = spelled(text) == spelled(EXPECTED_EXTRACT)
        else:
            passed = True  # adaptation 2: the issue states no exact output for a form other than EXTRACT
        cases.append({"id": "extract-output", "passed": passed, "expected": {"if converted to EXTRACT": EXPECTED_EXTRACT}, "observed": {"sql": observed, "convertsToExtract": applicable}, **failed})
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
