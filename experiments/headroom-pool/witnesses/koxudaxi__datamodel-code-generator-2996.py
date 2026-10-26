#!/usr/bin/env python3
"""Public witness for koxudaxi/datamodel-code-generator issue "Relative imports from parallel directories incorrect"
(koxudaxi__datamodel-code-generator-2996).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "The following directory structure:" -- its two ``` blocks, verbatim, saved as
  ``mxlims/schematst/data/ReflectionSetData.json`` ("...mxlims/schematst/data/ ReflectionSetData.json:") and
  ``mxlims/schematst/datatypes/FooStats.json`` ("...mxlims/schematst/datatypes/ FooStats.json:") -- and "Run with the command"
  (verbatim in COMMAND below: ``datamodel-codegen ... --input mxlims/schematst --output mxlims/pydantictst``) from the directory
  holding ``mxlims/``; the issue's "Produced the following files:" ``...mxlims/pydantictst/data/ ReflectionSetData.py`` is read back.
  Adaptations: (1) the ``datamodel-codegen`` command is the console script of the sealed environment, invoked by its path next to
  ``sys.executable`` because the sandbox's PATH does not contain the environment's bin directory (the snapshot's pyproject.toml
  declares ``scripts.datamodel-codegen = "datamodel_code_generator.__main__:main"``); it inherits this process's environment, so
  it imports the project from the same candidate tree as the fidelity check below (a missing console script = untrusted run).
  (2) The "..." parent of ``mxlims/`` is a fresh temporary directory (the issue elides it). (3) The space the issue writes after
  the directory in "data/ ReflectionSetData.json" and "datatypes/ FooStats.json" is read as a path separator (the command's
  ``--input mxlims/schematst`` and the generated header "#   filename:  data/ReflectionSetData.json" name the paths without it).
- Reported symptom on the pre-fix code (issue): "now (version 0.53.0) produces duplicate incorrect imports:" /
  "from ..datatypes import FooStats as FooStats_1" / "from ..datatypes.FooStats.FooStats import FooStats", the same two lines in
  the produced ``data/ReflectionSetData.py``. (This snapshot, run with the issue's files and command, writes
  "from ..datatypes import FooStats" -- the issue's first incorrect import without its alias -- next to the correct import.)
- Expected behaviour (issue), one check per quote:
  * correct-import: "Expected behaviour is the restoration of the correct import syntax:" /
    "`from ..datatypes.FooStats import FooStats`" (also: an earlier version "produced the following correct import:
    `from ..datatypes.FooStats import FooStats`") -- the command succeeds (exit 0) and the generated
    ``data/ReflectionSetData.py`` contains that import statement.
  * no-incorrect-import: "now (version 0.53.0) produces duplicate incorrect imports:" against the expected "restoration of the
    correct import syntax" -- every import the generated ``data/ReflectionSetData.py`` takes from the parallel ``datatypes``
    directory (a ``from ..datatypes...`` import, as both incorrect lines the issue quotes are) is the correct import, i.e. there
    is no duplicate incorrect import beside it.
  Statements are compared as Python syntax trees (formatting-insensitive); the module text is reported in full.
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

WITNESS = "koxudaxi__datamodel-code-generator-2996"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["datamodel_code_generator"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail): the
# project's runtime dependencies (pyproject.toml ``dependencies``).
DEPENDENCIES: list[str] = ["argcomplete", "black", "genson", "inflect", "isort", "jinja2", "pydantic", "yaml"]

# "...mxlims/schematst/data/ ReflectionSetData.json:" (verbatim block).
REFLECTION_SET_DATA_JSON = '''{
    "$schema": "https://json-schema.org/draft-07/schema",
    "title": "ReflectionSetData",
    "type": "object",
    "properties": {
        "fooStatsOverall": {
            "allOf": [
                {
                    "$ref": "../datatypes/FooStats.json"
                }
            ]
        },
        "fooStatsShells": {
            "items": {
                "$ref": "../datatypes/FooStats.json"
            },
            "title": "Foo Stats Shells",
            "type": "array"
        }
    }
}

'''

# "...mxlims/schematst/datatypes/ FooStats.json:" (verbatim block).
FOO_STATS_JSON = '''{
    "$schema": "https://json-schema.org/draft-07/schema",
    "title": "FooStats",
    "type": "object"
}

'''

# "Run with the command" (verbatim).
COMMAND = "datamodel-codegen --input-file-type jsonschema --output-model-type pydantic_v2.BaseModel --base-class mxlims.impl.MxlimsBase.BaseModel --use-schema-description --use-double-quotes --disable-timestamp --use-default --target-python-version 3.10 --snake-case-field --output-datetime-class datetime --use-exact-imports --capitalise-enum-members --use-title-as-name --use-one-literal-as-default --use-non-positive-negative-number-constrained-types --collapse-root-models --input mxlims/schematst --output mxlims/pydantictst"

# "Expected behaviour is the restoration of the correct import syntax:" (verbatim).
CORRECT_IMPORT = "from ..datatypes.FooStats import FooStats"


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def console_script():
    return os.path.join(os.path.dirname(sys.executable), "datamodel-codegen")


def write(base, relative, text):
    path = os.path.join(base, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    work = tempfile.mkdtemp(prefix="dcg-2996-")
    write(work, "mxlims/schematst/data/ReflectionSetData.json", REFLECTION_SET_DATA_JSON)
    write(work, "mxlims/schematst/datatypes/FooStats.json", FOO_STATS_JSON)
    program, *args = COMMAND.split()
    assert program == "datamodel-codegen"
    proc = subprocess.run([console_script(), *args], cwd=work, capture_output=True, text=True, timeout=150, env=os.environ.copy())
    generated = os.path.join(work, "mxlims/pydantictst/data/ReflectionSetData.py")
    module = None
    if os.path.exists(generated):
        with open(generated, encoding="utf-8") as handle:
            module = handle.read()
    files = sorted(os.path.relpath(os.path.join(d, f), work) for d, _, fs in os.walk(os.path.join(work, "mxlims/pydantictst")) for f in fs)
    return {"exit": proc.returncode, "stderr": proc.stderr[-1500:], "module": module, "files": files}


def datatypes_imports(module):
    """Every ``from ..datatypes[...] import ...`` statement of the generated module: (source text, syntax tree dump)."""
    found = []
    for node in ast.walk(ast.parse(module)):
        if isinstance(node, ast.ImportFrom) and node.level == 2 and (node.module == "datatypes" or (node.module or "").startswith("datatypes.")):
            found.append((ast.get_source_segment(module, node), ast.dump(node)))
    return found


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
        observed, error, imports = None, None, None
        try:
            observed = reproduce()
            if observed["module"] is not None:
                imports = datatypes_imports(observed["module"])
        except Exception as exc:  # noqa: BLE001  (includes generated code that does not parse)
            error = error_text(exc)
        correct = ast.dump(ast.parse(CORRECT_IMPORT).body[0])
        ran = error is None and observed is not None and observed["exit"] == 0 and imports is not None
        detail = {"observedDatatypesImports": [source for source, _ in imports] if imports is not None else None}
        if observed is not None:
            detail.update({"exit": observed["exit"], "module": observed["module"], "files": observed["files"]})
            if observed["exit"] != 0 or observed["module"] is None:
                detail["stderr"] = observed["stderr"]
        if error:
            detail["error"] = error
        cases.append({"id": "correct-import", "passed": ran and any(dump == correct for _, dump in imports), "expected": CORRECT_IMPORT, **detail})
        incorrect = [source for source, dump in imports if dump != correct] if imports is not None else None
        cases.append({"id": "no-incorrect-import", "passed": ran and not incorrect, "expected": f"every from ..datatypes import is: {CORRECT_IMPORT}", "incorrectImports": incorrect, **({"error": error} if error else {})})
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
