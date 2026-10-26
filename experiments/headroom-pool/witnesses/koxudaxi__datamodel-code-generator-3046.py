#!/usr/bin/env python3
"""Public witness for koxudaxi/datamodel-code-generator issue "Default values for python dictionaries are incorrectly rendered"
(koxudaxi__datamodel-code-generator-3046).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "To Reproduce" steps, verbatim below in `reproduce()`:
  "1. Save schema provided below as `schema.json`" -- the issue's "Example schema:" block (```json), verbatim -- and
  "2. Generate the code using command `datamodel-codegen --input schema.json --input-file-type jsonschema --output-model-type pydantic_v2.BaseModel --output model.py`"
  (the same arguments as the issue's "Used commandline" block), run from the directory holding ``schema.json``; the generated
  ``model.py`` is read back.
  Adaptations: (1) the ``datamodel-codegen`` command is the console script of the sealed environment, invoked by its path next to
  ``sys.executable`` because the sandbox's PATH does not contain the environment's bin directory (the snapshot's pyproject.toml
  declares ``scripts.datamodel-codegen = "datamodel_code_generator.__main__:main"``); it inherits this process's environment, so
  it imports the project from the same candidate tree as the fidelity check below (a missing console script = untrusted run).
  (2) The directory is a fresh temporary directory (step 1 only says to save the file as ``schema.json``).
- Reported symptom on the pre-fix code (issue): "Currently the following models are generated as following:" ... the block line
  "default_factory=lambda: ItemModel.model_validate({}), title='Dict With Defaults'" under
  "dict_with_defaults: dict[str, ItemModel] | None = Field(", and
  "dict_with_defaults has incorrect default_factory, because it tries to validate the default as an instance of value class instead of a dictionary."
- Expected behaviour (issue), one check per quote:
  * expected-line: "Expected line:" followed by the block
    "dict_with_defaults: dict[str, ItemModel] | None = Field(" / "default_factory=dict, title='Dict With Defaults'" / ")"
    -- the command succeeds (exit 0, ``model.py`` written) and the ``dict_with_defaults`` field of the generated
    ``class ParentModel`` is that statement. The comparison is between Python syntax trees (the issue's expected line, verbatim
    in EXPECTED_LINE, parsed as Python against the generated statement), so line wrapping, quote style and the order of the
    keyword arguments of ``Field(...)`` do not matter; the annotation, the called name and every argument with its value do.
- Author: W9.7 wit-g (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
import traceback

WITNESS = "koxudaxi__datamodel-code-generator-3046"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["datamodel_code_generator"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail): the
# project's runtime dependencies (pyproject.toml ``dependencies``).
DEPENDENCIES: list[str] = ["argcomplete", "black", "genson", "inflect", "isort", "jinja2", "pydantic", "yaml"]

# The issue's example schema (its ```json block, verbatim).
SCHEMA_JSON = '''
{
  "$defs": {
    "ItemModel": {
      "properties": {
        "name": {
          "title": "Name",
          "type": "string"
        },
        "description": {
          "title": "Description",
          "type": "string"
        }
      },
      "required": [
        "name",
        "description"
      ],
      "title": "ItemModel",
      "type": "object"
    }
  },
  "properties": {
    "dict_with_defaults": {
      "additionalProperties": {
        "$ref": "#/$defs/ItemModel"
      },
      "default": {},
      "title": "Dict With Defaults",
      "type": "object"
    }
  },
  "title": "ParentModel",
  "type": "object"
}

'''

# The issue's command line ("Used commandline"), verbatim arguments.
COMMAND_ARGS = ["--input", "schema.json", "--input-file-type", "jsonschema", "--output-model-type", "pydantic_v2.BaseModel", "--output", "model.py"]

# The issue's "Expected line:" block, verbatim.
EXPECTED_LINE = '''dict_with_defaults: dict[str, ItemModel] | None = Field(
        default_factory=dict, title='Dict With Defaults'
    )
'''


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
    work = tempfile.mkdtemp(prefix="dcg-3046-")
    with open(os.path.join(work, "schema.json"), "w", encoding="utf-8") as handle:
        handle.write(SCHEMA_JSON)
    proc = subprocess.run([console_script(), *COMMAND_ARGS], cwd=work, capture_output=True, text=True, timeout=150, env=os.environ.copy())
    model_path = os.path.join(work, "model.py")
    model = None
    if os.path.exists(model_path):
        with open(model_path, encoding="utf-8") as handle:
            model = handle.read()
    return {"exit": proc.returncode, "stderr": proc.stderr[-1500:], "model": model}


def field_shape(statement):
    """(annotation, called name, positional args, {keyword: value}) of an annotated assignment ``name: T = Call(...)``."""
    value = statement.value
    if not isinstance(value, ast.Call):
        return {"annotation": ast.dump(statement.annotation), "value": ast.dump(value) if value is not None else None}
    return {
        "annotation": ast.dump(statement.annotation),
        "call": ast.dump(value.func),
        "args": [ast.dump(arg) for arg in value.args],
        "keywords": sorted((keyword.arg or "**", ast.dump(keyword.value)) for keyword in value.keywords),
    }


def generated_statement(model, class_name, field_name):
    """The source text and syntax tree of ``field_name`` in ``class class_name`` of the generated module (or None)."""
    tree = ast.parse(model)
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for item in node.body:
                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name) and item.target.id == field_name:
                    return ast.get_source_segment(model, item), item
    return None, None


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
        observed, error = None, None
        try:
            observed = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        expected_statement = ast.parse(EXPECTED_LINE).body[0]
        expected = field_shape(expected_statement)
        source, shape, parse_error = None, None, None
        if observed is not None and observed["model"] is not None:
            try:
                source, statement = generated_statement(observed["model"], "ParentModel", "dict_with_defaults")
                shape = field_shape(statement) if statement is not None else None
            except Exception as exc:  # noqa: BLE001  (generated code that does not parse is a failure)
                parse_error = error_text(exc)
        passed = error is None and parse_error is None and observed is not None and observed["exit"] == 0 and shape == expected
        case = {"id": "expected-line", "passed": passed, "expected": EXPECTED_LINE.strip(), "observed": source}
        if observed is not None:
            case.update({"exit": observed["exit"], "model": observed["model"]})
            if observed["exit"] != 0 or observed["model"] is None:
                case["stderr"] = observed["stderr"]
        if not passed and shape is not None:
            case["observedShape"], case["expectedShape"] = shape, expected
        if error or parse_error:
            case["error"] = error or parse_error
        cases.append(case)
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
