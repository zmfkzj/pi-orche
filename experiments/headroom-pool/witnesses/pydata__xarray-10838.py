#!/usr/bin/env python3
"""Public witness for pydata/xarray issue "Saving and reloading DataArray from NetCDF breaks comparison of NaN attributes"
(pydata__xarray-10838).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Minimal Complete Verifiable Example" code block, verbatim below in `reproduce()` (same inputs,
  same calls, same public API: `xr.show_versions()`, `xr.DataArray(...)`, `xr.concat(..., combine_attrs="drop_conflicts")`,
  `DataArray.to_netcdf("ds_A.nc")` / `xr.load_dataarray("ds_A.nc")` with the default engine, files in the working directory).
  Adaptations: the code block runs inside `reproduce()`; the two `merged_array.attrs` it prints are also recorded for the
  checks (the prints still go to stdout); no call or input is changed.
- Reported symptom on the pre-fix code (issue): "the fill values were being dropped rather than combined" and the issue's log
  "Loaded from NetCDF array attributes:" / "{'field': 'CTH'}"
- Expected behaviour (issue), one check per quote:
  * in-memory: the issue's log "In memory array attributes:" / "{'fill_value': nan, 'field': 'CTH'}" -- the behaviour the
    issue compares against ("if the arrays had been in memory the whole time"): the in-memory merge keeps `fill_value` (NaN)
    and `field` ('CTH') and drops the conflicting `sensor`.
  * netcdf-roundtrip: "I was not expecting passing through netCDF to change the comparison behavior of NaNs, and would hope
    that it would behave similarly to if the arrays had been in memory the whole time." -- after the netCDF round trip the
    merged attributes are again {'fill_value': nan, 'field': 'CTH'}: the same keys, `field` == 'CTH' and `fill_value` a
    scalar NaN (its numpy scalar type after loading is not checked).
- Author: W9.13 witb-6 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden
  tests and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback

WITNESS = "pydata__xarray-10838"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["xarray"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "pandas", "netCDF4"]
# The issue's in-memory result, "{'fill_value': nan, 'field': 'CTH'}" (NaN marked by the string "nan" here).
EXPECTED_ATTRS = {"fill_value": "nan", "field": "CTH"}


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce(observed):
    """The issue's reproduction, verbatim. Records the merged attributes the checks need in `observed`."""
    import numpy as np
    import xarray as xr

    xr.show_versions()

    print("\n----------------\n")

    # Set up dummy arrays to concatenate, with matching nan attribute
    array_A = xr.DataArray(
        np.zeros((5,)),
        dims="x",
        attrs={"fill_value": np.nan, "sensor": "G18", "field": "CTH"},
    )
    array_B = xr.DataArray(
        np.ones((5,)),
        dims="x",
        attrs={"fill_value": np.nan, "sensor": "G16", "field": "CTH"},
    )

    # Concatenate arrays using "drop_conflicts" to handle attributes
    merged_array = xr.concat(
        [array_A, array_B],
        dim="y",
        combine_attrs="drop_conflicts",
    )

    # Print merged array attributes
    print("In memory array attributes:")
    print(merged_array.attrs)
    observed["in_memory"] = dict(merged_array.attrs)

    # Now save arrays to netcdf and reload
    array_A.to_netcdf("ds_A.nc")
    array_A = xr.load_dataarray("ds_A.nc")

    array_B.to_netcdf("ds_B.nc")
    array_B = xr.load_dataarray("ds_B.nc")

    # Again concatenate arrays in the same way
    merged_array = xr.concat(
        [array_A, array_B],
        dim="y",
        combine_attrs="drop_conflicts",
    )

    # Print merged array attributes
    print("Loaded from NetCDF array attributes:")
    print(merged_array.attrs)
    observed["netcdf"] = dict(merged_array.attrs)
    return observed


def is_scalar_nan(value):
    import numpy as np

    try:
        return np.ndim(value) == 0 and not isinstance(value, (str, bytes, bool)) and math.isnan(float(value))
    except (TypeError, ValueError):
        return False


def matches_expected(attrs):
    """True when `attrs` is {'fill_value': nan, 'field': 'CTH'}: the same keys, field 'CTH', fill_value a scalar NaN."""
    return (isinstance(attrs, dict) and set(attrs) == set(EXPECTED_ATTRS) and isinstance(attrs.get("field"), str)
            and attrs.get("field") == "CTH" and is_scalar_nan(attrs.get("fill_value")))


def shown(attrs):
    return {key: repr(value) for key, value in attrs.items()} if isinstance(attrs, dict) else attrs


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
        in_memory, netcdf = observed.get("in_memory"), observed.get("netcdf")
        # The in-memory part of the script ran when its attributes were recorded (a later error belongs to the round trip).
        cases.append({"id": "in-memory", "passed": "in_memory" in observed and matches_expected(in_memory),
                      "expected": EXPECTED_ATTRS, "observed": shown(in_memory),
                      **({"error": error} if error and "in_memory" not in observed else {})})
        cases.append({"id": "netcdf-roundtrip", "passed": error is None and matches_expected(netcdf),
                      "expected": EXPECTED_ATTRS, "observed": shown(netcdf), **({"error": error} if error else {})})
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
