#!/usr/bin/env python3
"""Retained public reproducer for the huggingface_hub issue "tqdm_class progress tracking silently broken in non-TTY
environments (disable=None auto-detection)".

Where every input comes from (nothing else is used):
- The issue's Reproduction: a subclass of ``tqdm.auto.tqdm`` that only overrides ``update()`` (it does NOT strip any
  keyword argument), passed as ``tqdm_class``, in a non-TTY context.
- The issue's Root cause: the class is instantiated by ``_get_progress_bar_context()`` in
  ``huggingface_hub/utils/tqdm.py``; ``hf_hub_download`` reaches it through ``http_get``, which passes
  ``name="huggingface_hub.http_get"`` and the logger's effective level (WARNING in the common case named by the issue).
- The issue's Workaround section: the environment variable ``TQDM_POSITION=-1``.
- An earlier diagnostic made before any fix was written: ``_get_progress_bar_context(..., tqdm_class=tqdm.auto.tqdm)``
  on the unmodified code (no error but a frozen counter by default; with ``TQDM_POSITION=-1`` it raised
  ``TqdmKeyError: Unknown argument(s): {'name': ...}``).

Expected behaviour (the issue's): the supplied class is the progress bar, no exception is raised, and ``update()``
advances ``n`` ("MyProgress.update() is called but self.n stays at 0" is the reported bug).

Run from the project root with the project's ``python``: ``python <this file>``.
Exit 0: every case behaves as expected. Exit 1: at least one case does not. Exit 2: the run cannot be trusted (the
package or tqdm was not imported from where the harness says, or the helper is not real code of the package).
The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import importlib
import io
import json
import logging
import os
import sys
import traceback

WITNESS = "hf-4056"
TOTAL = 5
CASES = [
    ("non-tty-default", {}),
    ("non-tty-tqdm-position-minus-1", {"TQDM_POSITION": "-1"}),
]
CONTROLLED = ("HF_HUB_DISABLE_PROGRESS_BARS", "TQDM_DISABLE", "TQDM_POSITION", "TQDM_MININTERVAL")


def inside(path: str | None, root: str | None) -> bool:
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def main() -> int:
    # The issue's common case: no progress-bar environment overrides (HF_HUB_DISABLE_PROGRESS_BARS is read at import).
    for name in CONTROLLED:
        os.environ.pop(name, None)
    candidate_root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    dep_root = os.environ.get("WITNESS_DEP_ROOT")
    fidelity: dict[str, object] = {}
    problems: list[str] = []

    import tqdm as tqdm_package
    from tqdm.auto import tqdm

    module = importlib.import_module("huggingface_hub.utils.tqdm")
    helper = getattr(module, "_get_progress_bar_context", None)
    code = getattr(helper, "__code__", None)
    fidelity["module"] = os.path.realpath(module.__file__ or "")
    fidelity["helper"] = os.path.realpath(code.co_filename) if code else None
    fidelity["tqdm"] = os.path.realpath(tqdm_package.__file__ or "")
    if code is None:
        problems.append("_get_progress_bar_context is not a plain function of the package")
    if candidate_root is not None:
        fidelity["candidateRoot"] = os.path.realpath(candidate_root)
        if not inside(module.__file__, candidate_root):
            problems.append("huggingface_hub.utils.tqdm was not imported from the candidate")
        if code is not None and not inside(code.co_filename, candidate_root):
            problems.append("_get_progress_bar_context is not defined in the candidate's code")
    if dep_root is not None:
        fidelity["dependencyRoot"] = os.path.realpath(dep_root)
        if not inside(tqdm_package.__file__, dep_root):
            problems.append("tqdm was not imported from the original environment")
    if not issubclass(tqdm, tqdm_package.std.tqdm):
        problems.append("tqdm.auto.tqdm is not the real tqdm class")

    calls: list[tuple[float, object]] = []

    class MyProgress(tqdm):  # the issue's reproduction class, verbatim apart from recording instead of only printing
        def update(self, n=1):
            super().update(n)
            calls.append((self.n, self.total))
            print(f"Progress: {self.n}/{self.total}")

    cases = []
    for case_id, env in CASES:
        for name in CONTROLLED:
            os.environ.pop(name, None)
        os.environ.update(env)
        calls.clear()
        real_stderr = sys.stderr
        sys.stderr = io.StringIO()  # non-TTY, as in a web server, a background thread or Docker
        observed: dict[str, object] = {"env": env}
        passed = False
        try:
            context = helper(desc="witness.bin", log_level=logging.WARNING, total=TOTAL, initial=0,
                             name="huggingface_hub.http_get", tqdm_class=MyProgress)
            with context as bar:
                bar.update(TOTAL)
                observed.update(barClass=type(bar).__name__, n=getattr(bar, "n", None),
                                disable=getattr(bar, "disable", None), updateCalls=[c[0] for c in calls])
            passed = isinstance(bar, MyProgress) and bar.n == TOTAL and bool(calls) and calls[-1][0] == TOTAL
        except Exception as error:  # noqa: BLE001 - the reproducer reports any failure
            observed["error"] = f"{type(error).__name__}: {error}"
            observed["traceback"] = traceback.format_exc(limit=6)[-1500:]
        finally:
            sys.stderr = real_stderr
            for name in CONTROLLED:
                os.environ.pop(name, None)
        expected = f"a MyProgress bar, no exception, n == {TOTAL} after update({TOTAL})"
        cases.append({"id": case_id, "passed": passed, "expected": expected, "observed": observed})
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: expected {expected}; observed {json.dumps(observed, default=str)}")

    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems,
                                          "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
