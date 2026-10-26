#!/usr/bin/env python3
"""Public witness for PyPSA/PyPSA issue "`NetworkCollection` does not allow for `groupby=["name",...]` in statistics"
(pypsa__pypsa-1653).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's code block, verbatim: ``nc.statistics.opex(groupby=["name"])``.
  Adaptations:
  (1) ``nc`` is not defined by the issue. It is the collection the snapshot's documentation calls ``nc``: the user guide
      (docs/user-guide/collection.md, "Let's take two example networks and put them into a collection:" ...
      ">>> nc = pypsa.NetworkCollection([n, n_shuffled_load])", with n = ``pypsa.examples.ac_dc_meshed()`` optimised and
      "n_shuffled_load # Same network as n but with shuffled load time series"), built exactly as the snapshot's doctest
      namespace for the docs builds it (test/test_docs.py lines 41-61, ``doctest_globals["nc"]``), copied verbatim into
      `build_nc()`; the one change there is that the load shuffle ``pd.Series(flat_values).sample(frac=1)`` gets
      ``random_state=rng`` with that file's own ``rng = np.random.default_rng(42)`` (line 29), for a reproducible run.
  (2) ``pypsa.examples.ac_dc_meshed()`` loads ``examples/networks/ac-dc-meshed/ac-dc-meshed.nc`` relative to the working
      directory and downloads it otherwise (pypsa/examples.py ``_retrieve_if_not_local``); test/test_docs.py runs from the
      repository root. The run has no network, so the witness works in a fresh temporary directory holding a symlink
      ``examples`` -> the candidate tree's bundled ``examples`` directory (a missing bundle makes the run untrusted).
  (3) The description's own form ``groupby="name"`` is applied to the reproduction's ``opex`` call as a second check.
- Reported symptom on the pre-fix code (issue): "nc.statistics.opex(groupby=["name"])" /
  "# ValueError: 'name' is both an index level and a column label, which is ambiguous." and "`NetworkCollection.statistics`
  does not allow to compare based on a component name `groupby="name"`."
- Expected behaviour (issue), one check per quote:
  * opex-groupby-name-list: "Grouping by component name." (Expected Behavior) and "`Network.statistics` does allow for
    this." -- ``nc.statistics.opex(groupby=["name"])`` returns, for every network of the collection (its index level, here
    'network'), the same grouping by component name as that network's ``Network.statistics.opex(groupby=["name"])``. The
    per-network form is the collection's documented behaviour (docs/user-guide/collection.md: "All statistics expressions
    can be accessed in the same way as for a single network." and "with the results being aggregated or concatenated
    across all networks in the collection."). Compared: the index level names other than the collection level, the
    component names and the values (relative 1e-9; an absent entry counts as 0, so the drop-zero option is not judged).
  * opex-groupby-name-str: "`NetworkCollection.statistics` does not allow to compare based on a component name
    `groupby="name"`. `Network.statistics` does allow for this." -- the same comparison for ``groupby="name"``.
- Author: W9.6 wit-f (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, the bundled example network is missing, or the package was not
imported from the candidate). The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import traceback

WITNESS = "pypsa__pypsa-1653"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["pypsa"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "pandas", "xarray", "netCDF4", "linopy", "highspy"]
EXAMPLE = os.path.join("examples", "networks", "ac-dc-meshed", "ac-dc-meshed.nc")


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def build_nc():
    """Adaptation (1): the documentation's ``nc``, test/test_docs.py lines 29 and 41-61 verbatim (seeded shuffle)."""
    import numpy as np
    import pandas as pd

    import pypsa

    rng = np.random.default_rng(42)

    # Warning: Keep in sync with settings in doc/conf.py
    n = pypsa.examples.ac_dc_meshed()
    n.optimize(include_objective_constant=True)

    # Create another network with shuffled load time series for collection comparisons
    n_shuffled_load = pypsa.examples.ac_dc_meshed()
    df = n.loads_t.p_set
    flat_values = df.values.ravel()
    shuffled_series = pd.Series(flat_values).sample(frac=1, random_state=rng).values
    df_shuffled = pd.DataFrame(
        shuffled_series.reshape(df.shape), index=df.index, columns=df.columns
    )
    n_shuffled_load.loads_t.p_set = df_shuffled
    n_shuffled_load.name = "AC-DC-Meshed-Shuffled-Load"
    n_shuffled_load.optimize(include_objective_constant=True)

    # Remove solver model to allow copying
    n.model.solver_model = None
    n_shuffled_load.model.solver_model = None

    # Create a network collection
    nc = pypsa.NetworkCollection([n.copy(), n_shuffled_load.copy()])
    return nc


def per_network_mismatch(nc, result, groupby):
    """None when `result` holds, per network of `nc`, the network's own ``statistics.opex(groupby=...)``; else a reason."""
    import pandas as pd

    if not isinstance(result, pd.Series):
        return f"result is {type(result).__name__}, the single-network result is a Series"
    level = nc.networks.index.name
    if level not in list(result.index.names):
        return f"no collection level {level!r} in the result index {list(result.index.names)}"
    details = {}
    for key, net in nc.networks.items():
        expected = net.statistics.opex(groupby=groupby)
        if expected.empty:
            return f"{key}: the network's own statistics.opex(groupby={groupby!r}) is empty, nothing to compare"
        got = result.xs(key, level=level)
        if sorted(map(str, got.index.names)) != sorted(map(str, expected.index.names)):
            return f"{key}: index levels {list(got.index.names)} != single network {list(expected.index.names)}"
        if got.index.nlevels > 1:
            got = got.reorder_levels(list(expected.index.names))
        got_d = {k: float(v) for k, v in got.items()}
        exp_d = {k: float(v) for k, v in expected.items()}
        bad = {
            str(k): {"collection": got_d.get(k), "network": exp_d.get(k)}
            for k in set(got_d) | set(exp_d)
            if not math.isclose(0.0 if math.isnan(got_d.get(k, 0.0)) else got_d.get(k, 0.0),
                                0.0 if math.isnan(exp_d.get(k, 0.0)) else exp_d.get(k, 0.0), rel_tol=1e-9, abs_tol=1e-9)
        }
        if bad:
            details[str(key)] = bad
    return f"values differ: {details}" if details else None


def reproduce(nc):
    """The issue's reproduction, verbatim, and the description's string form (adaptation 3)."""
    observed = {}
    for case_id, groupby in [("opex-groupby-name-list", ["name"]), ("opex-groupby-name-str", "name")]:
        try:
            if case_id == "opex-groupby-name-list":
                result = nc.statistics.opex(groupby=["name"])
            else:
                result = nc.statistics.opex(groupby="name")
        except Exception as exc:  # noqa: BLE001  (the candidate's code raised: a failure)
            observed[case_id] = {"error": error_text(exc)}
            continue
        try:
            mismatch = per_network_mismatch(nc, result, groupby)
        except Exception as exc:  # noqa: BLE001
            mismatch = f"comparison raised {error_text(exc)}"
        observed[case_id] = {"result": result.to_string()[-1200:] if hasattr(result, "to_string") else repr(result)[-1200:], "mismatch": mismatch}
    return observed


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
        tree = root or os.path.dirname(os.path.dirname(fidelity["pypsa"]))
        examples = os.path.join(tree, "examples")
        if not os.path.isfile(os.path.join(tree, EXAMPLE)):
            problems.append(f"bundled example network {EXAMPLE} missing in {tree}")
    if not problems and not cases:
        work = tempfile.mkdtemp(prefix="pypsa-1653-")
        os.symlink(examples, os.path.join(work, "examples"))  # adaptation (2)
        os.chdir(work)
        observed, error = None, None
        try:
            nc = build_nc()
            observed = reproduce(nc)
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        for case_id, groupby in [("opex-groupby-name-list", ["name"]), ("opex-groupby-name-str", "name")]:
            seen = (observed or {}).get(case_id) or {}
            failure = error or seen.get("error") or seen.get("mismatch")
            cases.append({
                "id": case_id,
                "passed": failure is None and bool(seen),
                "call": f"nc.statistics.opex(groupby={groupby!r})",
                "expected": "per network of nc: the network's own statistics.opex(groupby=...) (grouping by component name)",
                "observed": seen.get("result"),
                **({"error": failure} if failure else {}),
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
