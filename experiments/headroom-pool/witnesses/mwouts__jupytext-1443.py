#!/usr/bin/env python3
"""Public witness for mwouts/jupytext issue "misunderstanding / bug? with `find_jupytext_configuration_file()`"
(mwouts__jupytext-1443).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's source tree (its first code block) and its three calls (its second code block, an IPython session),
  verbatim below in `reproduce()`, in the issue's order. Adaptations:
  1. The tree is created under a fresh temporary directory that stands for the filesystem root: `/Users/JohnDoe/project/...`
     becomes `<tmp>/Users/JohnDoe/project/...` (the run cannot write to `/`). The issue gives no file contents, so the three files
     are created empty: the lookup is by file name (docs/config.md:66-67 of the snapshot, the page the issue cites: "The name for
     the configuration file can be any of `jupytext.config.JUPYTEXT_CONFIG_FILES`, i.e. `.jupytext` (in TOML), `jupytext.toml`,
     ..."), and an empty configuration file is a documented use (docs/config.md:78: "you can create an empty `.jupytext`
     configuration file in that directory").
  2. The issue's block omits the import; it is the one of the documentation section the issue cites
     (docs/config.md:72-75, "If you want to know, for a given directory, which configuration file is used by Jupytext, run this
     in a Python shell: from jupytext.config import find_jupytext_configuration_file / find_jupytext_configuration_file('.')").
  3. IPython's `%cd <dir>` (change the working directory) is ``os.chdir(<dir>)``; the first call runs from the run's initial
     (empty) working directory, which the issue does not name.
  4. "the path to `jupytext.toml`" is checked as a path that names the project's ``jupytext.toml`` from the working directory of
     the call (``os.path.samefile``); the issue states which file the forms must return, not how the path is spelled.
- Reported symptom on the pre-fix code (issue): "the first form to - I assume, correctly - return the path to `jupytext.toml`" and
  "but the other 2 return None".
- Expected behaviour (issue), one check per quote:
  * absolute-path: "the first form to - I assume, correctly - return the path to `jupytext.toml`"
    (``find_jupytext_configuration_file('/Users/JohnDoe/project/notebooks/teacher')``).
  * cd-teacher-dot, cd-project-relative: "my understanding that all these things should be equivalent" -- the second form
    (``%cd /Users/JohnDoe/project/notebooks/teacher`` then ``find_jupytext_configuration_file('.')``) and the third form
    (``%cd /Users/JohnDoe/project/`` then ``find_jupytext_configuration_file('notebooks/teacher')``) return the path to
    `jupytext.toml`, as the first form does.
- Author: W9.9 witb-2 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback

WITNESS = "mwouts__jupytext-1443"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["jupytext"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = []


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def names_config(result, config_file):
    """True when `result` (as returned, read from the current working directory) names `config_file`."""
    try:
        return result is not None and os.path.isfile(result) and os.path.samefile(result, config_file)
    except Exception:  # noqa: BLE001  (a value that is not a path does not name the file)
        return False


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from jupytext.config import find_jupytext_configuration_file  # docs/config.md:74 (adaptation 2)

    # The issue's source tree (adaptation 1: under a temporary root instead of `/`).
    root = tempfile.mkdtemp(prefix="jupytext-1443-")
    project = os.path.join(root, "Users", "JohnDoe", "project")
    os.makedirs(os.path.join(project, "notebooks", "teacher"))
    for relative in ["jupytext.toml", "notebooks/foo-nb.md", "notebooks/teacher/bar-nb.md"]:
        with open(os.path.join(project, *relative.split("/")), "w"):
            pass
    config_file = os.path.join(project, "jupytext.toml")
    teacher = os.path.join(project, "notebooks", "teacher")

    observed = {}
    start = os.getcwd()
    try:
        # find_jupytext_configuration_file('/Users/JohnDoe/project/notebooks/teacher')
        result = find_jupytext_configuration_file(teacher)
        observed["absolute-path"] = {"call": f"find_jupytext_configuration_file({teacher!r})", "cwd": os.getcwd(), "returned": result, "names_jupytext_toml": names_config(result, config_file)}

        # %cd /Users/JohnDoe/project/notebooks/teacher
        os.chdir(teacher)
        # find_jupytext_configuration_file('.')
        result = find_jupytext_configuration_file(".")
        observed["cd-teacher-dot"] = {"call": "find_jupytext_configuration_file('.')", "cwd": os.getcwd(), "returned": result, "names_jupytext_toml": names_config(result, config_file)}

        # %cd /Users/JohnDoe/project/
        os.chdir(project + os.sep)
        # find_jupytext_configuration_file('notebooks/teacher')
        result = find_jupytext_configuration_file("notebooks/teacher")
        observed["cd-project-relative"] = {"call": "find_jupytext_configuration_file('notebooks/teacher')", "cwd": os.getcwd(), "returned": result, "names_jupytext_toml": names_config(result, config_file)}
    finally:
        os.chdir(start)
    return {"config_file": config_file, "calls": observed}


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
        for case_id in ["absolute-path", "cd-teacher-dot", "cd-project-relative"]:
            call = (observed or {}).get("calls", {}).get(case_id)
            passed = error is None and call is not None and call["names_jupytext_toml"] is True
            cases.append({"id": case_id, "passed": passed, "expected": f"the path to `jupytext.toml` ({(observed or {}).get('config_file')})", "observed": call, **({"error": error} if error else {})})
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
