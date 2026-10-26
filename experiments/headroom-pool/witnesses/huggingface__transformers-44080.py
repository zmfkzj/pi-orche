#!/usr/bin/env python3
"""Public witness for huggingface/transformers issue "`ModelOutput` keys aren't correctly assigned if key was previously None"
(huggingface__transformers-44080).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's only code block (section "Reproduction"), verbatim below in `reproduce()` (same inputs, same calls:
  ``BaseModelOutputWithPooling(...)`` from ``transformers.modeling_outputs`` built with ``torch.randn``, the attribute assignments
  ``... .pooler_output = torch.arange(4)``, ``print(...)``, ``.keys()``, ``.pooler_output`` and ``["pooler_output"]``). CPU only, as
  in the issue ("Using GPU in script?: no").
  Adaptations: (1) the issue's triple-quoted output transcripts (no-op string literals that show what the issue's run printed) and
  its "✅"/"❌" annotation comments are not repeated; (2) the value of each printed expression is also kept for the checks; (3) the last
  statement, ``print(no_pooler_outputs["pooler_output"])``, which the issue reports to raise ("# KeyError: 'pooler_output' ❌"),
  runs inside try/except so that its exception is recorded as the observation of check item-after-set; (4) the printed key views
  the issue shows as "dict_keys([...])" are compared as key lists (``list(x.keys())``): ``ModelOutput`` subclasses ``OrderedDict``
  in the pre-fix snapshot (src/transformers/utils/generic.py), whose key view prints as ``odict_keys([...])`` here.
- Reported symptom on the pre-fix code (issue): after ``no_pooler_outputs.pooler_output = torch.arange(4)``,
  ``print(no_pooler_outputs.keys())`` prints "dict_keys(['last_hidden_state'])" -- "# ❌ The dict_keys doesn't have `pooler_output`
  in its keys" -- and ``print(no_pooler_outputs["pooler_output"])`` gives "# KeyError: 'pooler_output' ❌ because pooler_output is
  not in self.keys()".
- Expected behaviour (issue), one check per quote:
  * keys-after-set: "If I 1) initialize a `ModelClass` subclass with some parameter set to None, and then 2) set that parameter to
    some non-None value, then I would expect that 3a) the parameter is added to `.keys()`" -- ``"pooler_output"`` is in
    ``no_pooler_outputs.keys()`` after the assignment.
  * item-after-set: "and 3b) I can access it with `outputs[parameter]`." -- ``no_pooler_outputs["pooler_output"]`` returns the
    assigned value, which the issue prints for the attribute as "tensor([0, 1, 2, 3])".
  * with-pooler-keys (marked "✅" in the issue): ``print(outputs.keys())`` of the first object prints
    "dict_keys(['last_hidden_state', 'pooler_output'])".
  * override-existing (marked "✅"): after ``outputs.pooler_output = torch.arange(4)`` the issue prints
    "pooler_output=tensor([0, 1, 2, 3]), hidden_states=None, attentions=None)" and "dict_keys(['last_hidden_state', 'pooler_output'])".
  * no-pooler-keys (marked "✅"): ``print(no_pooler_outputs.keys())`` before the assignment prints "dict_keys(['last_hidden_state'])".
  * attribute-after-set (marked "✅"): ``print(no_pooler_outputs.pooler_output)`` prints "# tensor([0, 1, 2, 3]) ✅".
- Author: W9.5 wit-e (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "huggingface__transformers-44080"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["transformers"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["torch"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import torch
    from transformers.modeling_outputs import BaseModelOutputWithPooling

    seen = {}
    # An example BaseModelOutputWithPooling with last_hidden_state and pooler_output:
    outputs = BaseModelOutputWithPooling(
        last_hidden_state=torch.randn(1, 2, 4),
        pooler_output=torch.randn(1, 4),
        hidden_states=None,
        attentions=None,
    )
    print(outputs)
    print(outputs.keys())
    seen["with_pooler_keys"] = list(outputs.keys())

    # We can override the pooler output with a new tensor:
    outputs.pooler_output = torch.arange(4)
    print(outputs)
    print(outputs.keys())
    seen["override_str"] = str(outputs)
    seen["override_keys"] = list(outputs.keys())

    # An example BaseModelOutputWithPooling without pooler_output:
    no_pooler_outputs = BaseModelOutputWithPooling(
        last_hidden_state=torch.randn(1, 2, 4),
        pooler_output=None,
        hidden_states=None,
        attentions=None,
    )
    print(no_pooler_outputs)
    print(no_pooler_outputs.keys())
    seen["no_pooler_keys"] = list(no_pooler_outputs.keys())

    # Now let's try and override the pooler output on the no_pooler_outputs:
    no_pooler_outputs.pooler_output = torch.arange(4)
    print(no_pooler_outputs)
    print(no_pooler_outputs.keys())
    seen["after_set_keys"] = list(no_pooler_outputs.keys())
    print(no_pooler_outputs.pooler_output)
    seen["after_set_attribute"] = str(no_pooler_outputs.pooler_output)
    try:
        item = no_pooler_outputs["pooler_output"]
        print(item)
        seen["after_set_item"] = str(item)
    except Exception as exc:  # noqa: BLE001  (the issue reports this access to raise; recorded for check item-after-set)
        seen["after_set_item_error"] = error_text(exc)
    return seen


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
        seen = observed or {}
        extra = {"error": error} if error else {}

        expected = ["last_hidden_state", "pooler_output"]
        cases.append({"id": "with-pooler-keys", "passed": error is None and seen.get("with_pooler_keys") == expected,
                      "expected": expected, "observed": seen.get("with_pooler_keys"), **extra})

        expected_text = "pooler_output=tensor([0, 1, 2, 3]), hidden_states=None, attentions=None)"
        override_ok = error is None and expected_text in (seen.get("override_str") or "") and seen.get("override_keys") == expected
        cases.append({"id": "override-existing", "passed": override_ok,
                      "expected": {"printed": expected_text, "keys": expected},
                      "observed": {"printed": (seen.get("override_str") or "")[-200:], "keys": seen.get("override_keys")}, **extra})

        cases.append({"id": "no-pooler-keys", "passed": error is None and seen.get("no_pooler_keys") == ["last_hidden_state"],
                      "expected": ["last_hidden_state"], "observed": seen.get("no_pooler_keys"), **extra})

        cases.append({"id": "attribute-after-set", "passed": error is None and seen.get("after_set_attribute") == "tensor([0, 1, 2, 3])",
                      "expected": "tensor([0, 1, 2, 3])", "observed": seen.get("after_set_attribute"), **extra})

        keys_after = seen.get("after_set_keys")
        cases.append({"id": "keys-after-set", "passed": error is None and isinstance(keys_after, list) and "pooler_output" in keys_after,
                      "expected": "'pooler_output' in no_pooler_outputs.keys()", "observed": keys_after, **extra})

        item_error = seen.get("after_set_item_error")
        item_ok = error is None and item_error is None and seen.get("after_set_item") == "tensor([0, 1, 2, 3])"
        cases.append({"id": "item-after-set", "passed": item_ok, "expected": "tensor([0, 1, 2, 3])",
                      "observed": seen.get("after_set_item"), **({"error": item_error} if item_error else extra)})
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
