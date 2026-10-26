#!/usr/bin/env python3
"""Public witness for tobymao/sqlglot issue "MySQL Assignment Operator causing parse to flag unsupported syntax in SET statement"
(tobymao__sqlglot-6385).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Repro" code block, verbatim below in `reproduce()` (same inputs, same calls, same dependency
  boundary): ``sqlglot.parse_one(query, read="mysql")`` where ``query`` is the issue's triple-quoted string (a newline,
  ``SET @x := 5;``, a newline).
  Adaptations:
  1. Observation of the reported message. The issue's "Actual" is a message that sqlglot logs (``logger.warning`` on the
     ``sqlglot`` logger, sqlglot/parser.py:1829 of the pre-fix snapshot). The witness records every logging record and every
     Python warning emitted during the issue's call, through a handler on the root logger and ``warnings.catch_warnings``.
  2. Reference. The issue says the "alternative syntax of using = rather than := in SET" is handled correctly. The same program
     with ``=`` in place of ``:=`` (``SET @x = 5;``) is run as the reference the issue names. In the pre-fix snapshot it parses to
     ``sqlglot.exp.Set``, which is therefore the "SET statement" node.
  3. Content of the SET statement. "Parsed as valid SET statement" is read as: the parsed statement, generated back as MySQL, is
     the reference statement, reading ``:=`` as ``=`` and ignoring whitespace. The issue presents both as the same assignment, so
     either operator may be printed.
- Reported symptom on the pre-fix code (issue): "Use of the MySQL assignment operator := in a SET statement causes sqlglot to flag
  unsupported syntax and fallback to parsing as a command." / Actual: "'SET @x := 5' contains unsupported syntax. Falling back to
  parsing as a 'Command'."
- Expected behaviour (issue), one check per quote:
  * set-statement: "SQL should be parsed as valid SET statement." The result is a ``sqlglot.exp.Set``, the node of the issue's
    ``=`` reference, and not a ``Command``.
  * no-unsupported-warning: "causes sqlglot to flag unsupported syntax and fallback to parsing as a command" / "contains
    unsupported syntax. Falling back to parsing as a 'Command'." (Actual). The issue's call emits no such message.
  * same-assignment-as-equals: "SQL should be parsed as valid SET statement." with "as does the alternative syntax of using =
    rather than := in SET". The SET statement carries the same assignment as the ``=`` form (adaptation 3).
- Author: W9.8 witb-1 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import traceback
import warnings

WITNESS = "tobymao__sqlglot-6385"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["sqlglot"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = []

# The reported message (issue, "Actual"), in its two parts.
SYMPTOM_PARTS = ["contains unsupported syntax", "Falling back to parsing as a 'Command'"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


class Messages(logging.Handler):
    """Adaptation 1: collects every logging record and every Python warning emitted inside the block."""

    def __init__(self):
        super().__init__(level=logging.NOTSET)
        self.messages: list[str] = []

    def emit(self, record):
        self.messages.append(f"log {record.name} {record.levelname}: {record.getMessage()}")

    def __enter__(self):
        self._warnings = warnings.catch_warnings(record=True)
        self._caught = self._warnings.__enter__()
        warnings.simplefilter("always")
        logging.getLogger().addHandler(self)
        return self

    def __exit__(self, *exc_info):
        logging.getLogger().removeHandler(self)
        self.messages.extend(f"warning {item.category.__name__}: {item.message}" for item in self._caught)
        self._warnings.__exit__(*exc_info)
        return False


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    with Messages() as messages:
        import sqlglot
        query = """
SET @x := 5;
"""
        parsed = sqlglot.parse_one(query, read="mysql")
    return parsed, messages.messages


def equals_form():
    """Adaptation 2: the issue's program with the alternative syntax ``=`` (the reference the issue names)."""
    import sqlglot
    query = """
SET @x = 5;
"""
    return sqlglot.parse_one(query, read="mysql")


def normalized(sql):
    """Adaptation 3: ``:=`` read as ``=``, whitespace ignored."""
    return re.sub(r"\s+", "", sql.replace(":=", "="))


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
        import sqlglot

        parsed, messages, error = None, [], None
        try:
            parsed, messages = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        failed = {"error": error} if error else {}
        kind = None if parsed is None else f"{type(parsed).__module__}.{type(parsed).__qualname__}"
        is_set = error is None and isinstance(parsed, sqlglot.exp.Set)
        cases.append({"id": "set-statement", "passed": is_set, "expected": "sqlglot.expressions.Set (a SET statement, not a Command)", "observed": {"type": kind, "tree": repr(parsed)[:600]}, **failed})

        flagged = [message for message in messages if any(part in message for part in SYMPTOM_PARTS)]
        cases.append({"id": "no-unsupported-warning", "passed": error is None and not flagged, "expected": "no message containing " + " or ".join(repr(part) for part in SYMPTOM_PARTS), "observed": messages[:10], **failed})

        observed_sql, reference_sql, errors = None, None, dict(failed)
        try:
            reference_sql = equals_form().sql(dialect="mysql")
        except Exception as exc:  # noqa: BLE001
            errors["referenceError"] = error_text(exc)
        if parsed is not None:
            try:
                observed_sql = parsed.sql(dialect="mysql")
            except Exception as exc:  # noqa: BLE001
                errors["sqlError"] = error_text(exc)
        same = is_set and not errors and observed_sql is not None and reference_sql is not None and normalized(observed_sql) == normalized(reference_sql)
        cases.append({"id": "same-assignment-as-equals", "passed": same, "expected": {"type": "sqlglot.expressions.Set", "sql (':=' read as '=', whitespace ignored)": reference_sql}, "observed": {"type": kind, "sql": observed_sql}, **errors})
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
