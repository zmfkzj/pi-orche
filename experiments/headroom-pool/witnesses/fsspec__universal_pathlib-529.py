#!/usr/bin/env python3
"""Public witness for fsspec/universal_pathlib issue "`.parents` returns an empty path as the last element"
(fsspec__universal_pathlib-529).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's only code block, verbatim below in `reproduce()` (``from upath import UPath``,
  ``filepath = UPath("s3://lamindb-ci/test-data/Species.csv")``, ``filepath.parents`` and ``list(filepath.parents)``).
  Adaptations: (1) the block is an interactive session: its ``>>`` lines and ``# on ...`` comments are the outputs it shows, not
  code, so the two evaluated expressions are printed (``repr``) and returned for the checks instead of being echoed by a REPL;
  (2) the statements are the body of `reproduce()`. Only path arithmetic is involved (no filesystem call, so no S3 service or
  network is touched).
- Reported symptom on the pre-fix code (issue): "`.parents` returns an empty path as the last element", shown as
  "filepath.parents" / "# on 0.3.7" / ">>(S3Path('lamindb-ci/test-data', protocol='s3'), S3Path('lamindb-ci/', protocol='s3'),
  S3Path('', protocol='s3'))" and "This looks like a bug to me."
- Expected behaviour (issue), one check per quote:
  * no-empty-last: the title "`.parents` returns an empty path as the last element" (the empty path being
    "S3Path('', protocol='s3')") -- the last element of ``filepath.parents`` is not an empty path (its ``path`` is not "").
  * parents-as-0.2.6: "list(filepath.parents) # on 0.2.6" / ">> [S3Path('s3://lamindb-ci/test-data'), S3Path('s3://lamindb-ci/')]"
    -- ``list(filepath.parents)`` is two ``S3Path`` objects whose URLs (``str``) are "s3://lamindb-ci/test-data" and
    "s3://lamindb-ci/", in this order. The repr format itself changed between the two versions the issue shows
    (``S3Path('s3://...')`` on 0.2.6, ``S3Path('...', protocol='s3')`` on 0.3.7), so the class name and the URL each element
    shows are compared, not the repr text.
- Author: W9.4 wit-d (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "fsspec__universal_pathlib-529"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["upath"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["fsspec", "pathlib_abc"]

EXPECTED_0_2_6 = [("S3Path", "s3://lamindb-ci/test-data"), ("S3Path", "s3://lamindb-ci/")]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from upath import UPath
    filepath = UPath("s3://lamindb-ci/test-data/Species.csv")
    parents = filepath.parents
    print(repr(parents))  # on 0.3.7 the issue shows: (S3Path('lamindb-ci/test-data', protocol='s3'), S3Path('lamindb-ci/', protocol='s3'), S3Path('', protocol='s3'))
    listed = list(filepath.parents)
    print(repr(listed))  # on 0.2.6 the issue shows: [S3Path('s3://lamindb-ci/test-data'), S3Path('s3://lamindb-ci/')]
    return {"parents": parents, "listed": listed}


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
        if observed is None:
            cases.append({"id": "no-empty-last", "passed": False, "expected": "last element of filepath.parents is not an empty path", "error": error})
            cases.append({"id": "parents-as-0.2.6", "passed": False, "expected": EXPECTED_0_2_6, "error": error})
        else:
            try:
                elements = list(observed["parents"])
                last = elements[-1] if elements else None
                last_path = None if last is None else last.path
                cases.append({"id": "no-empty-last", "passed": last is not None and last_path != "",
                              "expected": "last element of filepath.parents is not an empty path (path != '')",
                              "observed": {"repr": repr(observed["parents"]), "last": repr(last), "last_path": last_path}})
            except Exception as exc:  # noqa: BLE001
                cases.append({"id": "no-empty-last", "passed": False, "expected": "last element of filepath.parents is not an empty path", "error": error_text(exc)})
            try:
                listed = [(type(item).__name__, str(item)) for item in observed["listed"]]
                cases.append({"id": "parents-as-0.2.6", "passed": listed == EXPECTED_0_2_6,
                              "expected": EXPECTED_0_2_6, "observed": {"list": listed, "repr": repr(observed["listed"])}})
            except Exception as exc:  # noqa: BLE001
                cases.append({"id": "parents-as-0.2.6", "passed": False, "expected": EXPECTED_0_2_6, "error": error_text(exc)})
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
