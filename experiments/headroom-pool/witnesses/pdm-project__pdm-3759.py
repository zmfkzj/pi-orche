#!/usr/bin/env python3
"""Public witness for pdm-project/pdm issue "pdm options table not loaded from target when -p/--project is used"
(pdm-project__pdm-3759).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "To reproduce" section: the two ``pyproject.toml`` blocks (verbatim below in ``PROJECT1_TOML`` and
  ``PROJECT2_TOML``) and the command block ``cd /project2`` / ``pdm install -p /project1``, run through pdm's command line in
  ``reproduce()`` (same inputs, same command, same CLI boundary).
  Adaptations:
  1. ``/project1`` and ``/project2`` are two directories ``project1`` and ``project2`` of a fresh temporary directory (the
     sandbox's root is not writable); ``-p`` gets the absolute path of ``project1`` as in the issue.
  2. ``project1/pyproject.toml`` is the issue's block followed by a minimal ``[project]`` table (``name = "project1"``,
     ``version = "0.1.0"``). Determined by: the issue's ``pdm info`` shows /project1 is an initialised pdm project ("Project
     Root:" / "/project1", "Python Interpreter:" / "/project1/.venv/bin/python (3.14)"); pdm refuses a pyproject.toml without a
     ``[project]`` table for any options ("[ProjectError]: The pyproject.toml has not been initialized yet. You can do this by
     running `pdm init`.", ``check_project_file`` in src/pdm/cli/utils.py; "metadata should be written under `[project]` table",
     docs/reference/pep621.md); the name is the issue's directory name and ``0.1.0`` is ``pdm init``'s default version
     (src/pdm/cli/commands/init.py). No dependencies (the issue names none). ``project2/pyproject.toml`` is the issue's block
     unchanged (only its options table is involved; project2 is not installed).
  3. ``pdm`` is invoked as ``<sealed python> -m pdm`` (src/pdm/__main__.py) so that the candidate's pdm is the one that runs;
     a separate ``-c "import pdm"`` probe with the same cwd and environment confirms where pdm is imported from.
- Reported symptom on the pre-fix code (issue): "pdm install -p /project1  # Will use --no-editable (from project2)" / "the
  `[tool.pdm.options]` configuration was incorrectly loaded from the current working directory instead of from the target
  project specified by `-p`."
- Expected behaviour (issue), one check per quote:
  * uses-target-options: "pdm install -p /project1  # Correctly uses --no-self (from project1)" -- run from ``project2``, the
    install of ``project1`` completes (exit 0) without installing the project itself (``--no-self``: "Don't install the project
    itself.", src/pdm/cli/options.py; options of ``[tool.pdm.options]`` "will be added right after the command name",
    docs/usage/config.md): pdm reports no installation of project1 itself and no project1 distribution is in its environment.
- Author: W9.1 wit-a (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import tempfile
import traceback

WITNESS = "pdm-project__pdm-3759"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["pdm"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["tomlkit", "virtualenv", "findpython", "unearth", "resolvelib", "rich"]

PROJECT1_TOML = '''# /project1/pyproject.toml
[tool.pdm.options]
install = ["--no-self"]
'''

PROJECT2_TOML = '''# /project2/pyproject.toml
[tool.pdm.options]
install = ["--no-editable"]
'''

# Adaptation 2 (see the module docstring).
PROJECT1_COMPLETION = '''
[project]
name = "project1"
version = "0.1.0"
'''

SELF_INSTALL_MARKS = ("Installing the project as", "Install project1 ")


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    work = tempfile.mkdtemp(prefix="pdm-3759-")
    project1, project2 = os.path.join(work, "project1"), os.path.join(work, "project2")
    os.makedirs(project1)
    os.makedirs(project2)
    with open(os.path.join(project1, "pyproject.toml"), "w") as handle:
        handle.write(PROJECT1_TOML + PROJECT1_COMPLETION)
    with open(os.path.join(project2, "pyproject.toml"), "w") as handle:
        handle.write(PROJECT2_TOML)
    env = os.environ.copy()
    probe = subprocess.run([sys.executable, "-c", "import os, pdm; print(os.path.realpath(pdm.__file__))"], cwd=project2, capture_output=True, text=True, timeout=60, env=env)
    # cd /project2
    # pdm install -p /project1
    proc = subprocess.run([sys.executable, "-m", "pdm", "install", "-p", project1], cwd=project2, capture_output=True, text=True, timeout=150, env=env)
    output = proc.stdout + proc.stderr
    self_install = [line.strip() for line in output.splitlines() if any(mark in line for mark in SELF_INSTALL_MARKS)]
    installed = sorted(os.path.relpath(path, project1) for path in glob.glob(os.path.join(project1, ".venv", "lib*", "*", "site-packages", "*project1*")))
    return {"pdm_file": probe.stdout.strip(), "probe_exit": probe.returncode, "exit": proc.returncode, "self_install_lines": self_install, "installed_in_env": installed, "output_tail": output[-2500:]}


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
            fidelity["pdm (command)"] = observed["pdm_file"]
            if root is not None and not inside(observed["pdm_file"], root):
                problems.append(f"the pdm command did not import pdm from the candidate ({observed['pdm_file'] or 'probe exit ' + str(observed['probe_exit'])})")
        if not problems:
            passed = error is None and observed["exit"] == 0 and not observed["self_install_lines"] and not observed["installed_in_env"]
            cases.append({"id": "uses-target-options", "passed": passed,
                          "expected": {"exit": 0, "self_install_lines": [], "installed_in_env": []},
                          "observed": observed, **({"error": error} if error else {})})
    for case in cases:
        print(f"[{'PASS' if case['passed'] else 'FAIL'}] {case['id']}: " + json.dumps({k: v for k, v in case.items() if k not in ('id', 'passed')}, default=str)[:3000])
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    trusted = not problems
    ok = trusted and bool(cases) and all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
