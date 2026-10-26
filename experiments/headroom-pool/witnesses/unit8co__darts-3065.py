#!/usr/bin/env python3
"""Public witness for unit8co/darts issue "[BUG] IndexError when transforming static covariates with OneHotEncoder and
parameter drop set" (unit8co__darts-3065).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "To Reproduce" code block, verbatim below in `reproduce()` (same inputs, same calls, same
  public API: ``TimeSeries.from_values``, ``StaticCovariatesTransformer(transformer_cat=OneHotEncoder(drop=drop))``,
  ``fit_transform``). Adaptations: (1) the block runs inside a function and returns ``series_transformed``; (2) the
  expected output features are taken from the underlying transformer itself: a fresh scikit-learn
  ``OneHotEncoder(drop=drop)`` fitted on the issue's own ``static_covs`` (the third-party transformer the issue names;
  nothing of darts is used for the expectation).
- Reported symptom on the pre-fix code (issue): "the `StaticCovariatesTransformer` is not aware of the dropped column. This
  results in an IndexError when calling `StaticCovariatesTransformer.transform()`." /
  "IndexError: index 2 is out of bounds for axis 1 with size 2"
- Expected behaviour (issue), one check per quote:
  * feature-count: "The `StaticCovariatesTransformer` class should be aware of the number of ouptut features produced by
    the underlying tansformer." -- ``transformer.fit_transform(series)`` returns, and the static covariates of
    ``series_transformed`` have exactly as many columns as ``OneHotEncoder(drop="first")`` fitted on ``static_covs``
    produces output features (``len(encoder.get_feature_names_out())``, 2 for the categories "a", "c", "b").
  * encoded-values: the same expectation together with the class's documented role for ``transformer_cat``
    (darts/dataprocessing/transformers/static_covariates_transformer.py, ``StaticCovariatesTransformer.__init__``
    docstring: "transformer_cat / The encoder to transform categorical static covariate columns with.") -- the
    transformed static covariates of components comp1, comp2, comp3 are the encoder's output for their categories "a",
    "c", "b": the set of transformed columns equals the set of the encoder's output feature columns (column names and
    column order are not judged; the issue states neither).
- Author: W9.6 wit-f (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "unit8co__darts-3065"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["darts"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "pandas", "sklearn", "scipy", "joblib", "narwhals"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import numpy as np
    import pandas as pd
    from darts import TimeSeries
    from darts.dataprocessing.transformers import StaticCovariatesTransformer
    from sklearn.preprocessing import OneHotEncoder
    covs = ["a", "c", "b"] 
    drop = "first"
    static_covs = pd.DataFrame(data={"cat": covs})
    series = TimeSeries.from_values(
        values=np.random.random((10, 3)),
        columns=["comp1", "comp2", "comp3"],
        static_covariates=static_covs,
    )
    transformer = StaticCovariatesTransformer(transformer_cat=OneHotEncoder(drop=drop))
    series_transformed = transformer.fit_transform(series)
    return series_transformed


def expected_features():
    """Adaptation (2): the underlying transformer's own output for the issue's static covariates (scikit-learn only)."""
    import pandas as pd
    from sklearn.preprocessing import OneHotEncoder

    covs = ["a", "c", "b"]
    static_covs = pd.DataFrame(data={"cat": covs})
    encoder = OneHotEncoder(drop="first").fit(static_covs)
    out = encoder.transform(static_covs)
    dense = out.toarray() if hasattr(out, "toarray") else out
    names = [str(name) for name in encoder.get_feature_names_out()]
    # one column vector per output feature, rows in the order of the issue's components comp1, comp2, comp3
    columns = {names[j]: [float(dense[i][j]) for i in range(len(covs))] for j in range(len(names))}
    return names, columns


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
        try:
            names, columns = expected_features()
        except Exception as exc:  # noqa: BLE001  (scikit-learn itself fails: the run cannot be trusted)
            problems.append(f"the expected encoder output could not be computed with scikit-learn: {error_text(exc)}")
    if not problems and not cases:
        error, static, vectors, vector_error = None, None, None, None
        try:
            series_transformed = reproduce()
            sc = series_transformed.static_covariates
            static = {
                "columns": [str(c) for c in sc.columns],
                "rows": {str(i): [str(v) for v in row] for i, row in zip(sc.index, sc.values.tolist())},
            }
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        if static is not None:
            try:
                ordered = sc.reindex(["comp1", "comp2", "comp3"])
                vectors = sorted([float(v) for v in ordered.iloc[:, j].tolist()] for j in range(ordered.shape[1]))
            except Exception as exc:  # noqa: BLE001  (non-numeric or missing transformed values)
                vector_error = error_text(exc)
        extra = {"error": error} if error else {}
        cases.append({
            "id": "feature-count",
            "passed": error is None and static is not None and len(static["columns"]) == len(names),
            "expected": {"n_output_features": len(names), "encoder_features": names},
            "observed": {"n_columns": len(static["columns"]) if static else None, "columns": static["columns"] if static else None},
            **extra,
        })
        want = sorted(columns.values())
        cases.append({
            "id": "encoded-values",
            "passed": error is None and vector_error is None and vectors == want,
            "expected": {"feature_columns_comp1_comp2_comp3": want},
            "observed": {"columns_comp1_comp2_comp3": vectors, "rows": static["rows"] if static else None},
            **({"error": error or vector_error} if (error or vector_error) else {}),
        })
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
