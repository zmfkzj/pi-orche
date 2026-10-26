#!/usr/bin/env python3
"""Retained public reproducer for the stravalib issue "Sleeping rate limiter should adhere to smallest available number of
requests left".

Where every input comes from (nothing else is used):
- The issue: the SleepingRateLimiter can break the 15-minute limit when many daily requests are left at the end of the
  day; "The sleep interval should be based on the minimum number of requests left per time period, regardless the
  priority setting."
- The task's interface text for ``_get_wait_time(rates, seconds_until_short_limit, seconds_until_long_limit)``: "takes
  the maximum of both limit-based wait times for 'low' priority, and also considers the long-term limit for 'medium'
  priority when at least half the daily quota is used."
- The unmodified code's per-limit wait times (seconds until the limit resets / requests left in that period), its
  'high' priority (no wait) and its exhausted-limit handling (wait until the exhausted period resets).
The numbers below are chosen here (clear of any threshold boundary). Exit 0: every case behaves as expected. Exit 1: at
least one case does not. Exit 2: the run cannot be trusted. The last line is ``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback

WITNESS = "stravalib-709"


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def main() -> int:
    candidate_root = os.environ.get("WITNESS_CANDIDATE_ROOT")
    from stravalib.util import limiter

    problems, fidelity = [], {"limiter": os.path.realpath(limiter.__file__ or "")}
    if candidate_root is not None and not inside(limiter.__file__, candidate_root):
        problems.append("stravalib.util.limiter was not imported from the candidate")
    R = limiter.RequestRate
    # (id, priority, rates, seconds_until_short, seconds_until_long, expected)
    spec = [
        ("low-short-period-tighter", "low", R(short_usage=90, long_usage=500, short_limit=100, long_limit=1000), 450, 1800, 45.0),
        ("low-long-period-tighter", "low", R(short_usage=10, long_usage=990, short_limit=100, long_limit=1000), 450, 36000, 3600.0),
        ("medium-over-half-daily-long-tighter", "medium", R(short_usage=50, long_usage=600, short_limit=100, long_limit=1000), 450, 40000, 100.0),
        ("medium-under-half-daily-short-only", "medium", R(short_usage=50, long_usage=100, short_limit=100, long_limit=1000), 450, 40000, 9.0),
        ("high-no-wait", "high", R(short_usage=90, long_usage=900, short_limit=100, long_limit=1000), 450, 36000, 0.0),
        ("short-exhausted-waits-for-short-reset", "low", R(short_usage=100, long_usage=500, short_limit=100, long_limit=1000), 450, 36000, 450.0),
        ("long-exhausted-waits-for-long-reset", "medium", R(short_usage=10, long_usage=1000, short_limit=100, long_limit=1000), 450, 36000, 36000.0),
    ]
    cases = []
    for case_id, priority, rates, short_s, long_s, expected in spec:
        observed = None
        error = None
        try:
            observed = limiter.SleepingRateLimitRule(priority=priority)._get_wait_time(rates, short_s, long_s)
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=3)[-600:]}"
        passed = error is None and isinstance(observed, (int, float)) and math.isclose(float(observed), expected, rel_tol=1e-9, abs_tol=1e-9)
        cases.append({"id": case_id, "passed": passed, "priority": priority, "rates": rates._asdict(), "secondsUntilShort": short_s,
                      "secondsUntilLong": long_s, "expected": expected, "observed": observed, **({"error": error} if error else {})})
        print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: expected {expected}; observed {observed if error is None else error.splitlines()[0]}")
    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    for problem in problems:
        print(f"[UNTRUSTED] {problem}")
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "fidelity": fidelity, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
