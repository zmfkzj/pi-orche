#!/usr/bin/env python3
"""Public witness for jsonpickle/jsonpickle issue "defaultdict loses keys named "default_factory"" (jsonpickle__jsonpickle-588).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Reproduction" code block, verbatim below in `reproduction_block()` (the same defaultdict, keys and
  values, `jsonpickle.encode` then `jsonpickle.decode`, its print statements included), and test cases 1 and 2 of the issue's
  "Additional Test Cases" code block, verbatim in `additional_case_1()` / `additional_case_2()`. Same public API boundary.
  Adaptations:
  1. The "Additional Test Cases" block builds each defaultdict and states "# After encode/decode: d["default_factory"] is
     lost" without spelling out the round trip; it is completed with the Reproduction block's own two lines
     (`encoded = jsonpickle.encode(d)` / `decoded = jsonpickle.decode(encoded)`) and that block's imports. Its "Test case 3"
     has no code ("# Similar issues could potentially occur with other special attributes") and is not run.
  2. Each block returns its objects (original, encoded, decoded) to the checks instead of only printing them.
- Reported symptom on the pre-fix code (issue): "jsonpickle silently loses this key-value pair during the encode/decode cycle",
  "# Output: Decoded: {'other_key': 100}" and "# Output: Key 'default_factory' lost: True".
- Expected behaviour (issue), one check per quote:
  * reproduction-items: "The `defaultdict` should be fully restored after encode/decode, preserving all key-value pairs
    including those with key name "default_factory"." -- the decoded items equal the original ones, which the issue prints as
    "# Output: Original: {'default_factory': 42, 'other_key': 100}" (so the block's last print reads "lost: False").
  * reproduction-defaultdict: "The `defaultdict` should be fully restored after encode/decode" -- the decoded object is a
    `collections.defaultdict` whose default_factory is the original's (`defaultdict(int)`).
  * additional-case-1 ("# Test case 1: Different value types"), additional-case-2 ("# Test case 2: Nested structures"): the
    same expectation quote for the issue's other two inputs, of which it says "# After encode/decode: d["default_factory"] is
    lost": a `collections.defaultdict` with the original default_factory (`list`, `int`) and exactly the items the block assigns.
- Author: W9.3 wit-c (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import collections
import json
import os
import sys
import traceback

WITNESS = "jsonpickle__jsonpickle-588"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["jsonpickle"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = []


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduction_block():
    """The issue's "Reproduction" code block, verbatim (adaptation 2: returns its objects)."""
    from collections import defaultdict
    import jsonpickle

    # Create a defaultdict with a key named "default_factory"
    d = defaultdict(int)
    d["default_factory"] = 42
    d["other_key"] = 100

    print(f"Original: {dict(d)}")
    # Output: Original: {'default_factory': 42, 'other_key': 100}

    # Encode and decode
    encoded = jsonpickle.encode(d)
    decoded = jsonpickle.decode(encoded)

    print(f"Decoded: {dict(decoded)}")
    # Output: Decoded: {'other_key': 100}

    print(f"Key 'default_factory' lost: {'default_factory' not in decoded}")
    # Output: Key 'default_factory' lost: True
    return d, encoded, decoded


def additional_case_1():
    """The issue's "Additional Test Cases" block, test case 1, verbatim (adaptations 1 and 2)."""
    from collections import defaultdict  # adaptation 1 (the Reproduction block's imports)
    import jsonpickle  # adaptation 1

    # Test case 1: Different value types
    d = defaultdict(list)
    d["default_factory"] = "I am a string value"
    d["x"] = [1, 2, 3]
    # After encode/decode: d["default_factory"] is lost
    encoded = jsonpickle.encode(d)  # adaptation 1 (the Reproduction block's round trip)
    decoded = jsonpickle.decode(encoded)  # adaptation 1
    return d, encoded, decoded


def additional_case_2():
    """The issue's "Additional Test Cases" block, test case 2, verbatim (adaptations 1 and 2)."""
    from collections import defaultdict  # adaptation 1 (the Reproduction block's imports)
    import jsonpickle  # adaptation 1

    # Test case 2: Nested structures
    d = defaultdict(int)
    d["default_factory"] = {"nested": "data"}
    d["normal_key"] = 456
    # After encode/decode: d["default_factory"] is lost
    encoded = jsonpickle.encode(d)  # adaptation 1 (the Reproduction block's round trip)
    decoded = jsonpickle.decode(encoded)  # adaptation 1
    return d, encoded, decoded


def describe(decoded):
    """Observed shape of a decoded object (type, default_factory, items), JSON-friendly."""
    out = {"type": f"{type(decoded).__module__}.{type(decoded).__qualname__}"}
    factory = getattr(decoded, "default_factory", "<no default_factory attribute>")
    out["default_factory"] = getattr(factory, "__qualname__", None) or repr(factory)
    try:
        out["items"] = repr(dict(decoded))
    except Exception as exc:  # noqa: BLE001
        out["items"] = f"<dict() failed: {type(exc).__name__}: {exc}>"
    return out


def restored_defaultdict(decoded, factory):
    """True when `decoded` is a collections.defaultdict with this default_factory."""
    return type(decoded) is collections.defaultdict and decoded.default_factory is factory


# (check id, block, kind, expected default_factory, expected items as assigned in the issue's code)
CHECKS = [
    ("reproduction-items", reproduction_block, "items", None, {"default_factory": 42, "other_key": 100}),
    ("reproduction-defaultdict", reproduction_block, "defaultdict", int, None),
    ("additional-case-1", additional_case_1, "full", list, {"default_factory": "I am a string value", "x": [1, 2, 3]}),
    ("additional-case-2", additional_case_2, "full", int, {"default_factory": {"nested": "data"}, "normal_key": 456}),
]


def judge(kind, decoded, factory, items):
    """(passed, expected) of one check on a decoded object."""
    if kind == "items":  # the decoded key-value pairs are the original ones
        return dict(decoded) == items, {"items": repr(items), "lost": False}
    if kind == "defaultdict":  # restored as a defaultdict with the original default_factory
        return restored_defaultdict(decoded, factory), {"type": "collections.defaultdict", "default_factory": factory.__qualname__}
    # fully restored: type, default_factory and items
    return (restored_defaultdict(decoded, factory) and dict(decoded) == items,
            {"type": "collections.defaultdict", "default_factory": factory.__qualname__, "items": repr(items)})


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
        outcomes = {}
        for block in dict.fromkeys(check[1] for check in CHECKS):  # each block runs once, in order
            try:
                outcomes[block] = (block(), None)
            except Exception as exc:  # noqa: BLE001
                outcomes[block] = (None, error_text(exc))
        for case_id, block, kind, factory, items in CHECKS:
            result, error = outcomes[block]
            if error is None:
                try:
                    _original, encoded, decoded = result
                    passed, expected = judge(kind, decoded, factory, items)
                    observed = describe(decoded)
                    observed["lost"] = "default_factory" not in decoded
                    cases.append({"id": case_id, "passed": bool(passed), "expected": expected, "observed": observed, "encoded": encoded})
                    continue
                except Exception as exc:  # noqa: BLE001
                    error = error_text(exc)
            cases.append({"id": case_id, "passed": False, "error": error})
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
