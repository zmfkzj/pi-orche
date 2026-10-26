#!/usr/bin/env python3
"""Public witness for agronholm/anyio issue "Pytest resumes after KeyboardInterrupt when using async fixture on asyncio
backend" (agronholm__anyio-1121).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's first code block ("Run the following test:"), verbatim below as ``ISSUE_TEST``, saved as ``demo.py``
  and run with pytest (anyio's pytest plugin, asyncio backend); Ctrl-C is hit after ``first sleep`` is printed, as the issue
  instructs ("Hit Ctrl-C just after `first sleep` is printed"). Adaptations:
  1. File name ``demo.py``: the issue's session output lists the test as "demo.py::test_foo".
  2. Command ``python -m pytest -s -v demo.py``: the issue gives no command line; its session output shows the test's prints
     live on the terminal ("first sleep" before "^C", i.e. output capture disabled, ``-s``) and the node id line
     "demo.py::test_foo" (verbose, ``-v``). The interpreter is the sealed environment's (``sys.executable -s -B``).
  3. "Hit Ctrl-C": pytest runs on a pseudo-terminal (``pty.fork``) and the witness types the Ctrl-C character (``\\x03``) into it,
     so the terminal line discipline sends SIGINT to pytest exactly as a keyboard Ctrl-C does (the issue's output shows the
     terminal echo "^C"). It is typed 1 s after "first sleep" appears, i.e. "just after `first sleep` is printed" and "while
     the test is `await`-ing `anyio.sleep`" (the first ``anyio.sleep(5)``).
  4. Control ``no-async-fixture``: the same test without the async fixture (``myfixture`` removed from ``test_foo``'s
     parameters, nothing else changed), which the issue states is not affected: "This does not occur when no async fixtures
     are in use".
  Each pytest run is bounded (45 s, then killed; a killed run fails its checks).
- Reported symptom on the pre-fix code (issue): "hitting Ctrl-C while the test is `await`-ing `anyio.sleep` does not interrupt
  the test. Instead, the test runs to completion and only then reports the `KeyboardInterrupt` exception." and "observe that the
  first sleep resumes and the second sleep also runs:" (output lines "first sleep", "^Csecond sleep", "done", then the
  KeyboardInterrupt banner quoted below).
- Expected behaviour (issue), one check per quote:
  * test-interrupted: "hitting Ctrl-C while the test is `await`-ing `anyio.sleep` does not interrupt the test. Instead, the test
    runs to completion" and "observe that the first sleep resumes and the second sleep also runs" -- Ctrl-C during the first
    sleep interrupts the test: the test does not resume, so neither "second sleep" nor "done" is printed.
  * keyboardinterrupt-reported: "only then reports the `KeyboardInterrupt` exception" with the issue's output
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! KeyboardInterrupt !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" --
    the interrupted run still ends with pytest's KeyboardInterrupt report.
  * no-async-fixture: "This does not occur when no async fixtures are in use" -- the control test is interrupted (no
    "second sleep", no "done") and pytest reports the KeyboardInterrupt.
- Author: W9.2 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, the package was not imported from the candidate, or no
pseudo-terminal is available). The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import re
import select
import signal
import sys
import tempfile
import time
import traceback

WITNESS = "agronholm__anyio-1121"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["anyio", "anyio.pytest_plugin"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["pytest", "idna"]

ISSUE_TEST = '''import anyio
import pytest


@pytest.fixture
async def myfixture():
    yield


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_foo(anyio_backend: str, myfixture: None):
    print("first sleep")
    await anyio.sleep(5)
    print("second sleep")
    await anyio.sleep(5)
    print("done")
'''

ISSUE_SIGNATURE = "async def test_foo(anyio_backend: str, myfixture: None):"
CONTROL_TEST = ISSUE_TEST.replace(ISSUE_SIGNATURE, "async def test_foo(anyio_backend: str):")

CTRL_C_DELAY_S = 1.0
RUN_LIMIT_S = 45.0
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
BANNER = re.compile(r"!{3,} KeyboardInterrupt !{3,}")


class Untrusted(Exception):
    """The environment cannot run the reproduction (never a pass or a fail)."""


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def printed(lines, marker):
    """Whether the test printed `marker` as a line of its own (after the "^C" echo or the verbose node id)."""
    for line in lines:
        body = line.replace("^C", "").strip()
        if body.startswith("demo.py::test_foo"):
            body = body[len("demo.py::test_foo"):].strip()
        if body == marker:
            return True
    return False


def run_with_ctrl_c(source):
    """Run ``python -m pytest -s -v demo.py`` on a pseudo-terminal; type Ctrl-C 1 s after "first sleep" is printed."""
    work = tempfile.mkdtemp(prefix="anyio-1121-")
    with open(os.path.join(work, "demo.py"), "w") as handle:
        handle.write(source)
    argv = [sys.executable, "-s", "-B", "-m", "pytest", "-s", "-v", "demo.py"]
    try:
        import pty
        pid, fd = pty.fork()
    except (OSError, ImportError) as exc:
        raise Untrusted(f"no pseudo-terminal available: {type(exc).__name__}: {exc}") from exc
    if pid == 0:  # child: pytest on the pseudo-terminal
        try:
            os.chdir(work)
            os.execv(sys.executable, argv)
        finally:
            os._exit(127)
    start = time.monotonic()
    raw, first_sleep_at, ctrl_c_at, killed = b"", None, None, False
    while True:
        now = time.monotonic()
        if now - start > RUN_LIMIT_S:
            killed = True
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            break
        if first_sleep_at is None and b"first sleep" in raw:
            first_sleep_at = now
        if first_sleep_at is not None and ctrl_c_at is None and now - first_sleep_at >= CTRL_C_DELAY_S:
            os.write(fd, b"\x03")  # Ctrl-C typed on the terminal
            ctrl_c_at = now
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:  # EIO: the child closed the terminal (exited)
                break
            if not data:
                break
            raw += data
    _, status = os.waitpid(pid, 0)
    end = time.monotonic()
    try:
        os.close(fd)
    except OSError:
        pass
    text = ANSI.sub("", raw.decode("utf-8", errors="replace")).replace("\r\n", "\n").replace("\r", "\n")
    after = text[text.find("first sleep"):] if "first sleep" in text else ""
    lines = after.split("\n")
    return {
        "argv": ["python", *argv[1:]],
        "first_sleep_printed": first_sleep_at is not None,
        "ctrl_c_sent": ctrl_c_at is not None,
        "ctrl_c_after_s": round(ctrl_c_at - start, 2) if ctrl_c_at is not None else None,
        "ended_after_s": round(end - start, 2),
        "killed_after_limit": killed,
        "exit": os.waitstatus_to_exitcode(status),
        "second_sleep_printed": printed(lines, "second sleep"),
        "done_printed": printed(lines, "done"),
        "keyboardinterrupt_reported": bool(BANNER.search(after)) and ctrl_c_at is not None and not killed,
        "output_tail": text[-1500:],
    }


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    if CONTROL_TEST == ISSUE_TEST:
        raise RuntimeError("control derivation failed")
    return {"issue": run_with_ctrl_c(ISSUE_TEST), "control": run_with_ctrl_c(CONTROL_TEST)}


def interrupted(run):
    return run["first_sleep_printed"] and run["ctrl_c_sent"] and not run["killed_after_limit"] and not run["second_sleep_printed"] and not run["done_printed"]


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
                __import__(name)
                module = sys.modules[name]
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
        except Untrusted as exc:
            problems.append(str(exc))
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        if not problems:
            issue = observed["issue"] if observed else None
            control = observed["control"] if observed else None
            brief = lambda run: {k: v for k, v in run.items() if k != "output_tail"} if run else None  # noqa: E731
            cases.append({
                "id": "test-interrupted",
                "passed": error is None and interrupted(issue),
                "expected": "Ctrl-C during the first `await anyio.sleep(5)` interrupts the test: neither 'second sleep' nor 'done' is printed",
                "observed": brief(issue),
                **({"output_tail": issue["output_tail"]} if issue else {}),
                **({"error": error} if error else {}),
            })
            cases.append({
                "id": "keyboardinterrupt-reported",
                "passed": error is None and issue["keyboardinterrupt_reported"],
                "expected": "pytest reports the KeyboardInterrupt ('!!! KeyboardInterrupt !!!') after the Ctrl-C",
                "observed": {"keyboardinterrupt_reported": issue["keyboardinterrupt_reported"], "exit": issue["exit"]} if issue else None,
                **({"error": error} if error else {}),
            })
            cases.append({
                "id": "no-async-fixture",
                "passed": error is None and interrupted(control) and control["keyboardinterrupt_reported"],
                "expected": "without the async fixture, Ctrl-C interrupts the test (no 'second sleep', no 'done') and pytest reports the KeyboardInterrupt",
                "observed": brief(control),
                **({"output_tail": control["output_tail"]} if control else {}),
                **({"error": error} if error else {}),
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
