#!/usr/bin/env python3
"""Public witness for pydata/xarray issue "Differing behaviour between `sel` and `drop_sel` for MultiIndexes"
(pydata__xarray-10863).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Minimal Complete Verifiable Example" code block, verbatim below in `reproduce()` (same inputs,
  same calls, same public API: `xr.show_versions()`, `DataArray(...)`, `.stack(z=("x", "y"))`, `.sel(z=("a",0))`,
  `.drop_sel(z=("a",0))`). Adaptations:
  * the leading `# /// script` block (uv inline metadata that installs xarray from git main) is dropped: the issue's own
    header says it only selects the xarray to test ("This script automatically imports the development branch of xarray"),
    and here the xarray under test is the candidate tree on PYTHONPATH;
  * the script body runs in-process inside `reproduce()` instead of `uv run issue.py` ("A run of the MCVE"); the objects the
    script creates (`stacked`, `selected_stack`, `dropped_stack`) are recorded for the checks; no call or input is changed.
- Reported symptom on the pre-fix code (issue): "With `drop_sel` raising and error and `sel` behaving as expected." and the
  issue's log: "dropped_stack = stacked.drop_sel(z=("a",0))" ... "KeyError: np.str_('0')"
- Expected behaviour (issue), one check per quote:
  * drop_sel-returns-dataarray, element-dropped: "The DataArray to be returned with the element matching the index dropped."
    -- `stacked.drop_sel(z=("a",0))` returns a DataArray whose `z` labels and data are those of `stacked` with the one
    element labelled ("a", 0) removed (every other element kept, in the same order, with its value).
- Author: W9.13 witb-6 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden
  tests and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "pydata__xarray-10863"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["xarray"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "pandas"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce(observed):
    """The issue's reproduction, verbatim. Records the objects the checks need in `observed`."""
    import xarray as xr
    xr.show_versions()
    # your reproducer code ...
    import numpy as np

    # Create a DataArray with a Multiindex with mixed types.
    arr = xr.DataArray(
        np.arange(6).reshape(2, 3),
        coords=[("x", ["a", "b"]), ("y", [0, 1, 2])],
    )
    stacked = arr.stack(z=("x", "y"))
    observed["stacked"] = stacked


    # Select a single item using the multiindex
    selected_stack = stacked.sel(z=("a",0))
    observed["selected_stack"] = selected_stack

    # Try and delete an item using the multiindex
    dropped_stack = stacked.drop_sel(z=("a",0))
    observed["dropped_stack"] = dropped_stack
    return observed


def native(value):
    """A numpy scalar as the equal Python scalar (np.str_ -> str, np.int64 -> int), for comparison and JSON output."""
    return value.item() if hasattr(value, "item") and not isinstance(value, (str, int, float)) else value


def elements(array):
    """(z label, value) of every element of a 1-d DataArray along `z`, in order."""
    return [(tuple(native(part) for part in label), native(value)) for label, value in zip(array["z"].values.tolist(), array.values.tolist())]


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
            reproduce(observed)
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        sys.stdout.flush()
        import xarray as xr

        dropped = observed.get("dropped_stack")
        extra = {"error": error} if error else {}
        cases.append({"id": "drop_sel-returns-dataarray", "passed": error is None and isinstance(dropped, xr.DataArray),
                      "expected": "a DataArray", "observed": type(dropped).__name__ if "dropped_stack" in observed else None, **extra})
        expected_elements, observed_elements, detail = None, None, None
        try:
            if "stacked" in observed:
                expected_elements = [item for item in elements(observed["stacked"]) if item[0] != ("a", 0)]
            if isinstance(dropped, xr.DataArray):
                observed_elements = elements(dropped)
        except Exception as exc:  # noqa: BLE001
            detail = error_text(exc)
        passed = (error is None and detail is None and expected_elements is not None and len(expected_elements) == 5
                  and observed_elements == expected_elements)
        cases.append({"id": "element-dropped", "passed": passed, "expected": expected_elements, "observed": observed_elements,
                      **({"error": error or detail} if (error or detail) else {})})
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
