#!/usr/bin/env python3
"""Retained public reproducer for the tox issue "Multiline factors broken again in tox>=4.46.0 #3902".

Where every input comes from (nothing else is used):
- The issue's configuration, verbatim apart from the command's ``{base_python} {env_python}`` substitutions (they need a
  Python 3.9 interpreter to resolve and are not involved): a multi-line, factor-conditional ``[tox] arch`` value
  (``x86_64: x86_64`` / ``arm64: arm64``) referenced as ``{[tox]arch}`` in ``commands``.
- The issue's report: in an environment whose name carries the architecture that is NOT the host's (``py39-x86_64`` on
  the reporter's arm64 machine), both lines were selected and the command broke; the matching environment worked, as
  did everything "prior to the ISA change in factor.py".
- The issue's warning: removing the host-ISA addition in factor.py "fixes the issue, but breaks a whole bunch of other
  tests, so I assume the change was there for a reason (presumably an integral part of arch factor differentiation)".
  So the third case keeps what the unmodified code does for an environment WITHOUT an architecture factor (the host
  architecture's line applies, like the documented implicit platform factor), which the issue does not report as broken.
- An earlier diagnostic made before any fix: on an x86_64 host ``py39-arm64`` resolved ``{[tox]arch}`` to
  ``x86_64\\narm64`` (two malformed commands) while ``py39-x86_64`` produced one correct command; an architecture-free
  ``py39`` followed the host architecture.

The host architecture is read the way tox reads it (the last component of ``sysconfig.get_platform()``). Each case runs
the real ``tox config`` command of the project in a throwaway directory and reads its JSON output.
Exit 0: every case behaves as expected. Exit 1: at least one case does not. Exit 2: the run cannot be trusted.
The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import sysconfig
import tempfile

WITNESS = "tox-3904"
ISSUE_INI = """[tox]
envlist = py39-{x86_64,arm64}
arch =
    x86_64: x86_64
    arm64: arm64
[testenv:py39-{arm64,x86_64}]
commands =
    python -c "print('{[tox]arch}')"
"""
PLAIN_INI = """[tox]
arch =
    x86_64: x86_64
    arm64: arm64
[testenv]
commands =
    python -c "print('{[tox]arch}')"
"""


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def expected_command(arch: str) -> str:
    # tox shows the command re-quoted with shlex (as in the issue's log)
    return "python -c 'print('\"'\"'" + arch + "'\"'\"')'"


def tox_config(ini: str, env: str, workdir: str) -> tuple[list[str] | None, str]:
    path = os.path.join(workdir, "tox.ini")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(ini)
    run = subprocess.run([sys.executable, "-m", "tox", "config", "-c", path, "-e", env, "-k", "commands", "--format", "json"],
                         cwd=workdir, capture_output=True, text=True, timeout=120)
    text = (run.stdout or "") + (run.stderr or "")
    try:
        start = run.stdout.index("{")
        data = json.loads(run.stdout[start:])
        commands = data["env"][env]["commands"]
        if isinstance(commands, list):
            return [str(item) for item in commands], text
        return None, text
    except (ValueError, KeyError, TypeError):
        return None, text


def main() -> int:
    candidate_root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    import tox

    problems = []
    fidelity = {"tox": os.path.realpath(tox.__file__ or "")}
    if candidate_root is not None:
        fidelity["candidateRoot"] = os.path.realpath(candidate_root)
        if not inside(tox.__file__, candidate_root):
            problems.append("tox was not imported from the candidate")
    parts = sysconfig.get_platform().rsplit("-", 1)
    if len(parts) < 2 or parts[-1] not in ("x86_64", "arm64", "aarch64", "amd64"):
        problems.append(f"host architecture not usable for this reproducer: {sysconfig.get_platform()}")
        host = "x86_64"
    else:
        host = {"aarch64": "arm64", "amd64": "x86_64"}.get(parts[-1], parts[-1])
    other = "arm64" if host == "x86_64" else "x86_64"
    fidelity["hostArch"] = host
    cases_spec = [
        ("issue-env-architecture-differs-from-host", ISSUE_INI, f"py39-{other}", [expected_command(other)]),
        ("issue-env-architecture-matches-host", ISSUE_INI, f"py39-{host}", [expected_command(host)]),
        ("env-without-architecture-keeps-host-line", PLAIN_INI, "py39", [expected_command(host)]),
    ]
    cases = []
    for case_id, ini, env, expected in cases_spec:
        with tempfile.TemporaryDirectory(prefix="witness-tox-") as workdir:
            observed, text = tox_config(ini, env, workdir)
        passed = observed == expected
        record = {"id": case_id, "env": env, "passed": passed, "expected": expected, "observed": observed}
        if observed is None:
            record["output"] = text[-1500:]
        cases.append(record)
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id} (env {env}): expected commands {expected}; observed {observed}")
    if any("ModuleNotFoundError" in case.get("output", "") for case in cases):
        problems.append("tox could not run")
    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems,
                                          "fidelity": fidelity, "cases": cases}))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
