#!/usr/bin/env python3
"""Public witness for skrub-data/skrub issue "Error when setting pipeline (with numerical transformer) on datetime in
TableVectorizer" (skrub-data__skrub-1899).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's code block ("Steps/Code to Reproduce"), verbatim below in `reproduce()` (same inputs, same calls,
  same dependency boundary).
  Adaptations:
  1. The block's last line ``tabvec.fit_transform(birthday)`` is a notebook cell's value; the witness binds it to ``output``.
  2. The expected values (see below) are computed after the issue's code, from the issue's own data and transformers: for each
     datetime column of ``birthday`` (in column order), an unfitted clone of the issue's ``encoder``
     (``DatetimeEncoder(resolution='second')``) is fitted on that column through the transformer's single-column API, and an
     unfitted clone of the issue's ``squash`` (``SquashingScaler()``) is fitted on the encoder's output; the per-column results
     are concatenated side by side. Determined by the issue ("output values that has been passed through the DatetimeEncoder
     and SquashingScaler") and the TableVectorizer documentation of the snapshot (skrub/_table_vectorizer.py docstring):
     "Transformations are applied **independently on each column**. A different transformer instance is used for each column
     separately"; "a final post-processing step is applied to all non-categorical columns in the encoder's output to cast them
     to float32" (hence a float32 comparison tolerance); "its ``fit``, ``transform`` and ``fit_transform`` methods expect a
     single column (a pandas or polars Series)" (the issue's own error text about ``DatetimeEncoder``).
- Reported symptom on the pre-fix code (issue): "ValueError: Transformer Pipeline.fit_transform failed on column 'birthday1'.
  See above for the full traceback." caused by "ValueError: ``DatetimeEncoder.fit_transform`` should be passed a single column,
  not a dataframe."
- Expected behaviour (issue), one check per quote:
  * encoded-and-squashed: "I would expect the TableVectorizer to output values that has been passed through the DatetimeEncoder
    and SquashingScaler." -- ``tabvec.fit_transform(birthday)`` returns without an exception, with the same shape as the expected
    values (adaptation 2) and the same values (float32 tolerance: rtol 1e-4, atol 1e-5; NaN equal to NaN). Column names are not
    checked.
- Author: W9.1 wit-a (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "skrub-data__skrub-1899"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["skrub"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "pandas", "sklearn"]

RTOL, ATOL = 1e-4, 1e-5


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import pandas as pd
    from skrub import DatetimeEncoder, SquashingScaler, TableVectorizer
    from sklearn.pipeline import Pipeline

    birthday = pd.DataFrame(pd.to_datetime(
        pd.Series(['2024-04-14', '2024-05-15'], name='birthday')
    ))
    birthday = pd.concat([birthday, birthday], axis=1)
    birthday.columns = ['birthday1', 'birthday2']

    squash = SquashingScaler()
    encoder = DatetimeEncoder(resolution='second')
    datetime_pipe = Pipeline(
        [
            ("datetime", encoder),
            ("squash", squash),
        ]
    )

    tabvec = TableVectorizer(cardinality_threshold=0, high_cardinality="passthrough", datetime=datetime_pipe)

    import numpy as np  # the witness's own imports (after the issue's code)
    from sklearn.base import clone

    observed = {}
    try:
        output = tabvec.fit_transform(birthday)  # adaptation 1
        values = np.asarray(output, dtype=np.float64)
        observed["output"] = {"type": f"{type(output).__module__}.{type(output).__name__}", "shape": list(values.shape), "values": values.tolist(),
                              "columns": [str(name) for name in getattr(output, "columns", [])]}
    except Exception as exc:  # noqa: BLE001
        observed["output"] = {"error": error_text(exc), "cause": None if exc.__cause__ is None else f"{type(exc.__cause__).__name__}: {str(exc.__cause__)[:300]}"}
    try:  # adaptation 2: the values passed through the DatetimeEncoder and the SquashingScaler, column by column
        parts = []
        for name in birthday.columns:
            features = clone(encoder).fit_transform(birthday[name])
            parts.append(np.asarray(clone(squash).fit_transform(features), dtype=np.float64))
        expected = np.hstack(parts).astype(np.float32).astype(np.float64)
        observed["expected"] = {"shape": list(expected.shape), "values": expected.tolist()}
    except Exception as exc:  # noqa: BLE001
        observed["expected"] = {"error": error_text(exc)}
    return observed


def same_values(output, expected):
    import numpy as np

    if output.get("error") or expected.get("error") or output.get("shape") != expected.get("shape"):
        return False
    return bool(np.allclose(np.asarray(output["values"], dtype=np.float64), np.asarray(expected["values"], dtype=np.float64), rtol=RTOL, atol=ATOL, equal_nan=True))


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
        output = (observed or {}).get("output") or {}
        expected = (observed or {}).get("expected") or {}
        cases.append({"id": "encoded-and-squashed", "passed": error is None and same_values(output, expected),
                      "expected": expected, "observed": output, "tolerance": {"rtol": RTOL, "atol": ATOL}, **({"error": error} if error else {})})
    for case in cases:
        print(f"[{'PASS' if case['passed'] else 'FAIL'}] {case['id']}: " + json.dumps({k: v for k, v in case.items() if k not in ('id', 'passed')}, default=str)[:3000])
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    trusted = not problems
    ok = trusted and bool(cases) and all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
