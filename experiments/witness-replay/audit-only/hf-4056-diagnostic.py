#!/usr/bin/env python3
"""Audit-only replay of the ARCHIVED pre-final diagnostic of huggingface_hub-4056 (results/witness-replay/AUDIT.md).

Provenance (model-visible before any candidate was written; nothing else is used):
results/ultra-ho/stage3-r2/validation/runs/huggingface__huggingface_hub-4056/H2/r2/records/
uho-huggingface-huggingface-hub-4056-H2-r2/workers/W1.2-2026-10-24T14-00-43-482Z.jsonl:54-56, verbatim:
    Probe on the unmodified code (stderr patched to io.StringIO, TQDM_POSITION unset, then '-1'):
      from tqdm.auto import tqdm as base
      with module._get_progress_bar_context(desc='compatibility', log_level=logging.WARNING, total=5, tqdm_class=base) as bar:
          bar.update(5)
    Output:
      raw tqdm class position= None n= 0
      raw tqdm class position= -1 error= TqdmKeyError "Unknown argument(s): {'name': None}"

Expectation (the public issue's, not the diagnostic's): an explicitly supplied ``tqdm_class`` is the progress bar, it is
not silently disabled ("Passing a custom class means 'I want to track progress my way' -- it shouldn't be silently
disabled"), so ``update(5)`` advances ``n`` to 5, and no exception is raised.

Not a model-facing reproducer of the pilot: it records whether the archived diagnostic, re-executed unchanged, still
discriminates the saved artifacts. Same output protocol as the retained reproducers (exit 0/1/2, last line
``WITNESS_RESULT <json>``).
"""
from __future__ import annotations

import importlib
import io
import json
import logging
import os
import sys
import traceback

WITNESS = "hf-4056-diagnostic"
CONTROLLED = ("HF_HUB_DISABLE_PROGRESS_BARS", "TQDM_DISABLE", "TQDM_POSITION", "TQDM_MININTERVAL")
CASES = [("diagnostic-position-unset", {}), ("diagnostic-position-minus-1", {"TQDM_POSITION": "-1"})]


def inside(path: str | None, root: str | None) -> bool:
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def main() -> int:
    for name in CONTROLLED:
        os.environ.pop(name, None)
    problems: list[str] = []
    import tqdm as tqdm_package
    from tqdm.auto import tqdm as base

    module = importlib.import_module("huggingface_hub.utils.tqdm")
    helper = getattr(module, "_get_progress_bar_context", None)
    root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    if root is not None and not inside(module.__file__, root):
        problems.append("huggingface_hub.utils.tqdm was not imported from the candidate")
    if os.environ.get("WITNESS_DEP_ROOT") is not None and not inside(tqdm_package.__file__, os.environ["WITNESS_DEP_ROOT"]):
        problems.append("tqdm was not imported from the original environment")
    if getattr(helper, "__code__", None) is None:
        problems.append("_get_progress_bar_context is not a plain function of the package")
    cases = []
    for case_id, env in CASES:
        for name in CONTROLLED:
            os.environ.pop(name, None)
        os.environ.update(env)
        real_stderr = sys.stderr
        sys.stderr = io.StringIO()
        observed: dict[str, object] = {"env": env}
        passed = False
        try:
            with helper(desc="compatibility", log_level=logging.WARNING, total=5, tqdm_class=base) as bar:
                bar.update(5)
                observed.update(barClass=type(bar).__name__, n=bar.n, disable=getattr(bar, "disable", None))
            passed = type(bar) is base and bar.n == 5
        except Exception as error:  # noqa: BLE001 - the replay reports any failure
            observed["error"] = f"{type(error).__name__}: {error}"
            observed["traceback"] = traceback.format_exc(limit=4)[-1200:]
        finally:
            sys.stderr = real_stderr
            for name in CONTROLLED:
                os.environ.pop(name, None)
        cases.append({"id": case_id, "passed": passed, "expected": "a tqdm.auto.tqdm bar, no exception, n == 5", "observed": observed})
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: expected a tqdm.auto.tqdm bar, no exception, n == 5; observed {json.dumps(observed, default=str)}")
    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
