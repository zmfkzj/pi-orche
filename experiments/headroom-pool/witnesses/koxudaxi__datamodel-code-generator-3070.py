#!/usr/bin/env python3
"""Public witness for koxudaxi/datamodel-code-generator issue "OpenAPI integer discriminator is generated as string type"
(koxudaxi__datamodel-code-generator-3070).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Example schema:" block (```json), verbatim, saved as ``example.json`` and the issue's
  "Used commandline" ``datamodel-codegen --input example.json --input-file-type openapi --output model.py`` (verbatim arguments)
  run from that directory; the generated ``model.py`` (the issue's "Output:") is read back and imported, and the generated
  ``Base`` model validates instances of the issue's schema.
  Adaptations: (1) the ``datamodel-codegen`` command is the console script of the sealed environment, invoked by its path next to
  ``sys.executable`` because the sandbox's PATH does not contain the environment's bin directory (the snapshot's pyproject.toml
  declares ``scripts.datamodel-codegen = "datamodel_code_generator.__main__:main"``); it inherits this process's environment, so
  it imports the project from the same candidate tree as the fidelity check below (a missing console script = untrusted run).
  (2) The schema's file name ``example.json`` is the one the command line reads (``--input example.json``); the directory is a
  fresh temporary directory. (3) The generated ``model.py`` is imported from that directory under a private module name; the
  instances validated by runtime-validation are the two subtypes of the issue's schema: ``{"kind": 1}`` (``Foo``: ``"kind"``
  ``"type": "integer"``, ``"enum": [1]``; mapping ``"1": "#/components/schemas/Foo"``) and ``{"kind": 2}`` (``Bar``, likewise).
- Reported symptom on the pre-fix code (issue): "generated models treat the discriminator field as a string." -- "Output:"
  "class Foo(BaseModel):" / "kind: Literal['1']" and "class Bar(BaseModel):" / "kind: Literal['2']" -- and "As a result, the
  generated type for the discriminator does not match the OpenAPI schema type and can break runtime validation and type checking."
- Expected behaviour (issue), one check per quote:
  * foo-kind-integer, bar-kind-integer: "The discriminator field type should follow the schema type (integer), for example using
    integer literal values for each subtype (such as 1 and 2), instead of string-based discriminator typing." -- the type of the
    generated ``kind`` field of ``Foo`` and of ``Bar`` (as the generated models resolve it) admits integers only: a ``Literal``
    whose values are all integers, or an integer type; not a string literal.
  * runtime-validation: the same quote together with the symptom it fixes, "does not match the OpenAPI schema type and can break
    runtime validation" -- the generated ``Base`` validates the schema-conforming ``{"kind": 1}`` as a ``Foo`` whose ``kind``
    equals the integer 1, and ``{"kind": 2}`` as a ``Bar`` whose ``kind`` equals the integer 2.
- Author: W9.7 wit-g (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import traceback
import typing

WITNESS = "koxudaxi__datamodel-code-generator-3070"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["datamodel_code_generator"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail): the
# project's runtime dependencies (pyproject.toml ``dependencies``); pydantic also runs the generated models.
DEPENDENCIES: list[str] = ["argcomplete", "black", "genson", "inflect", "isort", "jinja2", "pydantic", "yaml"]

# The issue's "Example schema:" block, verbatim.
EXAMPLE_JSON = '''{
  "openapi": "3.0.3",
  "info": {
    "title": "Minimal Integer Discriminator",
    "version": "1.0.0"
  },
  "paths": {},
  "components": {
    "schemas": {
      "Base": {
        "oneOf": [
          { "$ref": "#/components/schemas/Foo" },
          { "$ref": "#/components/schemas/Bar" }
        ],
        "discriminator": {
          "propertyName": "kind",
          "mapping": {
            "1": "#/components/schemas/Foo",
            "2": "#/components/schemas/Bar"
          }
        }
      },
      "Foo": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "integer",
            "enum": [1]
          }
        },
        "required": ["kind"]
      },
      "Bar": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "integer",
            "enum": [2]
          }
        },
        "required": ["kind"]
      }
    }
  }
}
'''

# The issue's "Used commandline", verbatim.
COMMAND = "datamodel-codegen --input example.json --input-file-type openapi --output model.py"


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def console_script():
    return os.path.join(os.path.dirname(sys.executable), "datamodel-codegen")


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    work = tempfile.mkdtemp(prefix="dcg-3070-")
    with open(os.path.join(work, "example.json"), "w", encoding="utf-8") as handle:
        handle.write(EXAMPLE_JSON)
    program, *args = COMMAND.split()
    proc = subprocess.run([console_script(), *args], cwd=work, capture_output=True, text=True, timeout=150, env=os.environ.copy())
    path = os.path.join(work, "model.py")
    source = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
    return {"program": program, "exit": proc.returncode, "stderr": proc.stderr[-1500:], "source": source, "path": path}


def load_generated(path):
    spec = importlib.util.spec_from_file_location("witness_generated_model_3070", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def integer_only(annotation):
    """True when the annotation admits integers only: a Literal of integers, or an integer type (bool excluded)."""
    if typing.get_origin(annotation) is typing.Literal:
        values = typing.get_args(annotation)
        return bool(values) and all(isinstance(value, int) and not isinstance(value, bool) for value in values)
    return isinstance(annotation, type) and issubclass(annotation, int) and not issubclass(annotation, bool)


def validate(base, data):
    try:
        result = base.model_validate(data)
    except Exception as exc:  # noqa: BLE001  (a validation error of the generated model is the symptom, recorded as observed)
        return {"input": data, "error": f"{type(exc).__name__}: {str(exc)[:600]}"}
    root = getattr(result, "root", result)
    kind = getattr(root, "kind", None)
    return {"input": data, "class": type(root).__name__, "kind": repr(kind), "kindIsInt": isinstance(kind, int) and not isinstance(kind, bool), "kindValue": kind}


def main() -> int:
    problems, fidelity, cases = [], {}, []
    for name in DEPENDENCIES:
        try:
            __import__(name)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"dependency {name} not importable: {type(exc).__name__}: {exc}")
    if not os.path.exists(console_script()):
        problems.append(f"console script {console_script()} missing from the sealed environment")
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
        observed, error, generated = None, None, None
        try:
            observed = reproduce()
            if observed["exit"] == 0 and observed["source"] is not None:
                generated = load_generated(observed["path"])
        except Exception as exc:  # noqa: BLE001  (the command, or the generated module, failing is a failure)
            error = error_text(exc)
        context = {}
        if observed is not None:
            context = {"exit": observed["exit"], "model": observed["source"]}
            if observed["exit"] != 0 or observed["source"] is None:
                context["stderr"] = observed["stderr"]
        if error:
            context["error"] = error
        for case_id, class_name in (("foo-kind-integer", "Foo"), ("bar-kind-integer", "Bar")):
            annotation, problem = None, None
            if generated is not None:
                try:
                    annotation = getattr(generated, class_name).model_fields["kind"].annotation
                except Exception as exc:  # noqa: BLE001
                    problem = error_text(exc)
            passed = generated is not None and problem is None and integer_only(annotation)
            cases.append({"id": case_id, "passed": passed, "expected": f"{class_name}.kind admits integers only (e.g. an integer Literal)", "observed": repr(annotation), **({"error": problem} if problem else {}), **context})
            context = {"exit": context.get("exit")} if context else {}
        results, problem = [], None
        if generated is not None:
            try:
                results = [validate(generated.Base, {"kind": 1}), validate(generated.Base, {"kind": 2})]
            except Exception as exc:  # noqa: BLE001
                problem = error_text(exc)
        expected = [("Foo", 1), ("Bar", 2)]
        passed = generated is not None and problem is None and len(results) == 2 and all(
            result.get("class") == name and result.get("kindIsInt") and result.get("kindValue") == value for result, (name, value) in zip(results, expected)
        )
        cases.append({"id": "runtime-validation", "passed": passed, "expected": [{"input": {"kind": value}, "class": name, "kind": value} for name, value in expected], "observed": results, **({"error": problem or error} if (problem or error) else {})})
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
