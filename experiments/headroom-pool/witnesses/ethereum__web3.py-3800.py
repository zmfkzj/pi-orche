#!/usr/bin/env python3
"""Public witness for ethereum/web3.py issue "HTTPProvider ignores provided session when used with gevent/threading - creates new
sessions per thread" (ethereum__web3.py-3800).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's first code block ("Steps to Reproduce"; the same program is repeated under "Code that produced the
  error"), verbatim below in ``ISSUE_PROGRAM`` (same inputs, same calls, same dependency boundary: it calls
  ``provider._request_session_manager.cache_and_return_session("http://localhost:8545")`` itself, makes no HTTP request and needs
  no node). ``reproduce()`` runs it as a script's module code in the main thread.
  Adaptations:
  1. The program's printed lines are captured (stdout) instead of read from a terminal, and the futures the program creates
     (``futures``) are inspected afterwards so that an exception raised in a worker thread is reported (it counts as a failure).
  2. The issue's second block ("With gevent (more impactful)") is not run: gevent is not installed in the sealed environment, and
     that block does not call web3 (it only shows that "Each greenlet gets a unique `threading.get_ident()`"); the threading block
     is the issue's reproduction ("Code that produced the error").
- Reported symptom on the pre-fix code (issue): "# All print False - each thread creates a NEW session!" / "Thread
  139907353547200: Session is shared? False" / "The provided session is only used by the thread/greenlet that created the
  `HTTPProvider`. All other threads/greenlets create new `requests.Session` instances."
- Expected behaviour (issue), one check per quote:
  * main-thread-shared: "make_request()  # True - uses the cached session" -- the line printed by the main thread's call is
    "Session is shared? True".
  * worker-threads-shared: "When a session is explicitly provided to `HTTPProvider`, it should be used for **all** requests
    regardless of which thread/greenlet makes them." -- each of the three calls submitted to the ThreadPoolExecutor prints
    "Session is shared? True" (three lines, no exception).
- Author: W9.1 wit-a (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import threading
import traceback

WITNESS = "ethereum__web3.py-3800"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["web3"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["requests"]

ISSUE_PROGRAM = '''import threading
import requests
from web3 import Web3, HTTPProvider
from web3._utils.http_session_manager import HTTPSessionManager

# Create a shared session
shared_session = requests.Session()

# Create HTTPProvider with explicit session
provider = HTTPProvider("http://localhost:8545", session=shared_session)
w3 = Web3(provider)

# Simulate requests from different threads/greenlets
def make_request():
    # This internally calls HTTPSessionManager.cache_and_return_session()
    # WITHOUT passing the session parameter
    manager = provider._request_session_manager
    session = manager.cache_and_return_session("http://localhost:8545")
    print(f"Thread {threading.get_ident()}: Session is shared? {session is shared_session}")

# Run from main thread
make_request()  # True - uses the cached session

# Run from different threads
import concurrent.futures
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    futures = [executor.submit(make_request) for _ in range(3)]
    concurrent.futures.wait(futures)
# All print False - each thread creates a NEW session!
'''

LINE = re.compile(r"^Thread (\d+): Session is shared\? (True|False)$")


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    namespace = {"__name__": "__main__", "__file__": "repro.py"}
    buffer = io.StringIO()
    main_ident = threading.get_ident()
    error = None
    with contextlib.redirect_stdout(buffer):
        try:
            exec(compile(ISSUE_PROGRAM, "repro.py", "exec"), namespace)  # noqa: S102 (the issue's program, verbatim)
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
    worker_errors = []
    for future in namespace.get("futures", []) or []:
        exc = future.exception()
        if exc is not None:
            worker_errors.append("".join(traceback.format_exception(type(exc), exc, exc.__traceback__, limit=6))[-1500:])
    lines = buffer.getvalue().splitlines()
    parsed = [(int(m.group(1)), m.group(2)) for m in (LINE.match(line) for line in lines) if m]
    return {
        "stdout": lines,
        "main": [shared for ident, shared in parsed if ident == main_ident],
        "workers": [shared for ident, shared in parsed if ident != main_ident],
        "program_error": error,
        "worker_errors": worker_errors,
    }


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
        if observed and observed.get("program_error"):
            error = observed["program_error"]
        main_lines = (observed or {}).get("main", [])
        worker_lines = (observed or {}).get("workers", [])
        worker_errors = (observed or {}).get("worker_errors", [])
        stdout = (observed or {}).get("stdout")
        cases.append({"id": "main-thread-shared", "passed": error is None and main_lines == ["True"],
                      "expected": ["True"], "observed": {"main": main_lines, "stdout": stdout}, **({"error": error} if error else {})})
        cases.append({"id": "worker-threads-shared", "passed": error is None and not worker_errors and worker_lines == ["True", "True", "True"],
                      "expected": ["True", "True", "True"], "observed": {"workers": worker_lines, "stdout": stdout, "worker_errors": worker_errors}, **({"error": error} if error else {})})
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
