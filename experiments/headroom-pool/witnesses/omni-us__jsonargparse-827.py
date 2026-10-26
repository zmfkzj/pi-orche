#!/usr/bin/env python3
"""Public witness for omni-us/jsonargparse issue "The `choices` parameter of `add_argument()` is not functioning correctly."
(omni-us__jsonargparse-827).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's first code block, verbatim, saved as ``argparse_test.py`` and run as the issue runs it
  (``python argparse_test.py --mode 1``). The issue's second code block (the same program on the standard library's
  ``argparse``) is run the same way as the reference the issue names. Adaptations: none.
- Reported symptom on the pre-fix code (issue): "argparse_test.py: error: argument --mode: invalid choice: '1' (choose from 0, 1)"
- Expected behaviour (issue), one check per quote:
  * mode-1: "> python argparse_test.py --mode 1" / "1" (expected output) and "Aligned with `argparse`."
  * mode-0, default, invalid-2: "Aligned with `argparse`." -- the other valid choice, no argument (the default) and an invalid
    choice must behave as the issue's argparse program does (same printed value and success for valid input; failure for an
    invalid choice).
- Author: W9 (claude-opus-5-5, task manager); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails. Exit 2: the run cannot be trusted. The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import traceback

WITNESS = "omni-us__jsonargparse-827"
CANDIDATE_MODULES = ["jsonargparse"]
DEPENDENCIES: list[str] = []

ISSUE_PROGRAM = '''from jsonargparse import ArgumentParser

parser = ArgumentParser()
parser.add_argument("--mode", type=int, default=1, choices=[0, 1])
cfg = parser.parse_args()

print(cfg.mode)
'''

ARGPARSE_PROGRAM = '''import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--mode", type=int, default=1, choices=[0, 1])
cfg = parser.parse_args()

print(cfg.mode)
'''


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def run(program_dir, name, args):
    proc = subprocess.run([sys.executable, name, *args], cwd=program_dir, capture_output=True, text=True, timeout=60, env=os.environ.copy())
    return {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr[-800:]}


def main() -> int:
    problems, fidelity, cases = [], {}, []
    root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    for name in CANDIDATE_MODULES:
        try:
            module = __import__(name)
        except Exception as exc:  # noqa: BLE001
            cases.append({"id": f"import-{name}", "passed": False, "error": error_text(exc)})
            continue
        fidelity[name] = os.path.realpath(getattr(module, "__file__", "") or "")
        if root is not None and not inside(module.__file__, root):
            problems.append(f"{name} was not imported from the candidate ({fidelity[name]})")
    if not problems and not cases:
        work = tempfile.mkdtemp(prefix="jsonargparse-827-")
        with open(os.path.join(work, "argparse_test.py"), "w") as handle:
            handle.write(ISSUE_PROGRAM)
        with open(os.path.join(work, "stdlib_argparse_test.py"), "w") as handle:
            handle.write(ARGPARSE_PROGRAM)
        for case_id, args in [("mode-1", ["--mode", "1"]), ("mode-0", ["--mode", "0"]), ("default", []), ("invalid-2", ["--mode", "2"])]:
            try:
                observed = run(work, "argparse_test.py", args)
                expected = run(work, "stdlib_argparse_test.py", args)
            except Exception as exc:  # noqa: BLE001
                cases.append({"id": case_id, "passed": False, "error": error_text(exc)})
                continue
            if expected["exit"] == 0:
                passed = observed["exit"] == 0 and observed["stdout"].strip() == expected["stdout"].strip()
            else:
                passed = observed["exit"] != 0
            cases.append({"id": case_id, "passed": passed, "args": args, "expected": {"exit": expected["exit"], "stdout": expected["stdout"].strip()}, "observed": observed})
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
