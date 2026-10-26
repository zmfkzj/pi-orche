#!/usr/bin/env python3
"""Public witness for getmoto/moto issue "SSM `put_parameter` response missing `Tier` field" (getmoto__moto-9590).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Steps to Reproduce" code block, verbatim below in `reproduce()` (same inputs, same calls, same
  dependency boundary: boto3's `ssm.put_parameter` under moto's `mock_aws`). Adaptations: the code block runs inside
  `reproduce()`; the `response` it receives and the lines it prints are recorded for the checks (the prints still go to
  stdout); no call or input is changed.
- Reported symptom on the pre-fix code (issue): "The `Tier` field is missing from the response." with the issue's output
  "Response keys: ['Version', 'ResponseMetadata']" / "Has Tier: False"
- Expected behaviour (issue), one check per quote; under "## Expected Behavior" the issue says "`put_parameter` should return:"
  followed by a code block whose lines are "'Version': 123," and "'Tier': 'Standard'|'Advanced'|'Intelligent-Tiering'":
  * has-tier: "The `Tier` field is missing from the response." -- the response returned by the issue's `put_parameter`
    call contains `Tier`, and the issue's own print shows it ("Has Tier:" prints True).
  * tier-value: "'Tier': 'Standard'|'Advanced'|'Intelligent-Tiering'" -- the returned `Tier` is one of these three values.
  * version: "'Version': 123" -- the response still carries the parameter's `Version` (an integer; the issue's actual
    output shows "'Version': 1").
- Author: W9.13 witb-6 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden
  tests and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback

WITNESS = "getmoto__moto-9590"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["moto"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["boto3", "botocore", "responses", "werkzeug", "xmltodict", "cryptography", "dateutil", "jinja2", "requests"]
TIERS = ("Standard", "Advanced", "Intelligent-Tiering")


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


class Tee(io.StringIO):
    """Keeps what the reproduction prints and still shows it on the real stdout."""

    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def write(self, text):
        self.stream.write(text)
        return super().write(text)


def reproduce(observed):
    """The issue's reproduction, verbatim. Records the response the checks need in `observed`."""
    from moto import mock_aws
    import boto3

    @mock_aws
    def test_put_parameter_tier():
        ssm = boto3.client('ssm', region_name='us-east-1')

        response = ssm.put_parameter(
            Name='/test/param',
            Value='test-value',
            Type='SecureString',
            Tier='Intelligent-Tiering'
        )
        observed["response"] = response

        print('Response keys:', list(response.keys()))
        print('Has Tier:', 'Tier' in response)

    test_put_parameter_tier()
    return observed


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
        observed, error = {}, None
        printed = Tee(sys.stdout)
        try:
            with contextlib.redirect_stdout(printed):
                reproduce(observed)
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        response = observed.get("response")
        response = dict(response) if isinstance(response, dict) else response
        shown = {key: value for key, value in response.items() if key != "ResponseMetadata"} if isinstance(response, dict) else response
        lines = printed.getvalue().splitlines()
        extra = {"error": error} if error else {}
        has_tier = isinstance(response, dict) and "Tier" in response
        cases.append({"id": "has-tier", "passed": error is None and has_tier and "Has Tier: True" in lines,
                      "expected": {"Tier in response": True, "printed": "Has Tier: True"},
                      "observed": {"response": shown, "printed": lines}, **extra})
        tier = response.get("Tier") if isinstance(response, dict) else None
        cases.append({"id": "tier-value", "passed": error is None and has_tier and tier in TIERS,
                      "expected": {"Tier": list(TIERS)}, "observed": {"Tier": tier if has_tier else "(missing)"}, **extra})
        version = response.get("Version") if isinstance(response, dict) else None
        cases.append({"id": "version", "passed": error is None and isinstance(version, int) and not isinstance(version, bool),
                      "expected": {"Version": "an integer"}, "observed": {"Version": version}, **extra})
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
