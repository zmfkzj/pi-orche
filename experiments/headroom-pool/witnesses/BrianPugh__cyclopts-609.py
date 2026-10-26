#!/usr/bin/env python3
"""Public witness for BrianPugh/cyclopts issue "`--help` parsed by `cyclopts` on `*args` command" (BrianPugh__cyclopts-609).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's code block, verbatim, saved as ``app.py`` and run as the issue runs it
  (``python app.py exec -- foo --help``) with the sealed environment's interpreter.
  Adaptations: none (the file name ``app.py`` and the command line are the issue's own: "e.g. `python app.py exec -- foo --help`").
- Reported symptom on the pre-fix code (issue): "I can't seem to get` --help` into the argv. I expected using `--` to "turn off"
  Cyclopts' parsing (e.g. `python app.py exec -- foo --help`), but that didn't work."
- Expected behaviour (issue), one check per quote:
  * help-in-argv: "I can't seem to get` --help` into the argv." -- the program's ``print(argv)`` shows a tuple that contains
    ``'--help'``.
  * double-dash-turns-off-parsing: "I expected using `--` to "turn off" Cyclopts' parsing (e.g. `python app.py exec -- foo --help`)"
    -- the command ``exec`` runs (exit 0) with ``argv`` equal to the tokens after ``--`` in order, ``('foo', '--help')``, and that
    tuple is the program's whole output (no help page). The snapshot's public docs state the same rule:
    docs/source/rules.rst:255 "To unambiguously pass in values positionally, provide them after a bare ``--``:" with the example
    at docs/source/rules.rst:259-261, where ``--some-flag`` after ``--`` is passed through positionally.
- Author: W9.12 witb-5 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
import traceback

WITNESS = "BrianPugh__cyclopts-609"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["cyclopts"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["attrs", "rich", "docstring_parser", "rich_rst"]

# The issue's code block, verbatim.
ISSUE_PROGRAM = '''from cyclopts import App

APP = App()

@APP.command
async def exec(*argv: str):
    print(argv)

if __name__ == "__main__":
    APP()
'''
# The issue's command line: python app.py exec -- foo --help
ISSUE_ARGS = ["exec", "--", "foo", "--help"]
# The tokens after "--" in the issue's command line, which `print(argv)` shows as a tuple.
EXPECTED_ARGV = ("foo", "--help")


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def run(program_dir, args):
    proc = subprocess.run([sys.executable, "app.py", *args], cwd=program_dir, capture_output=True, text=True, timeout=120, env=os.environ.copy())
    return {"exit": proc.returncode, "stdout": proc.stdout[-3000:], "stderr": proc.stderr[-1500:]}


def printed_argv(stdout):
    """The tuple printed by the program's `print(argv)` (its whole output), or None when the output is something else."""
    try:
        value = ast.literal_eval(stdout.strip())
    except Exception:  # noqa: BLE001  (e.g. a help page)
        return None
    return value if isinstance(value, tuple) else None


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    work = tempfile.mkdtemp(prefix="cyclopts-609-")
    with open(os.path.join(work, "app.py"), "w") as handle:
        handle.write(ISSUE_PROGRAM)
    # Where the program's own interpreter imports cyclopts from (same interpreter, environment and directory as the run).
    probe = subprocess.run([sys.executable, "-c", "import cyclopts; print(cyclopts.__file__)"], cwd=work, capture_output=True, text=True, timeout=120, env=os.environ.copy())
    observed = run(work, ISSUE_ARGS)
    observed["argv"] = printed_argv(observed["stdout"])
    return {"run": observed, "subprocess_cyclopts": probe.stdout.strip() or probe.stderr[-500:]}


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
        if observed is not None:
            fidelity["subprocess cyclopts"] = observed["subprocess_cyclopts"]
            if root is not None and not inside(observed["subprocess_cyclopts"], root):
                problems.append(f"the program's interpreter did not import cyclopts from the candidate ({observed['subprocess_cyclopts']})")
        if not problems:
            result = observed["run"] if observed else None
            argv = result["argv"] if result else None
            cases.append({"id": "help-in-argv", "passed": error is None and argv is not None and "--help" in argv,
                          "expected": "'--help' in the printed argv", "observed": result, **({"error": error} if error else {})})
            cases.append({"id": "double-dash-turns-off-parsing",
                          "passed": error is None and result is not None and result["exit"] == 0 and argv == EXPECTED_ARGV,
                          "expected": {"exit": 0, "stdout": repr(EXPECTED_ARGV)}, "observed": result, **({"error": error} if error else {})})
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
