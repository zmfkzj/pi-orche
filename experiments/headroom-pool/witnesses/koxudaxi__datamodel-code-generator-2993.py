#!/usr/bin/env python3
"""Public witness for koxudaxi/datamodel-code-generator issue "$ref doesn't work with extra fields"
(koxudaxi__datamodel-code-generator-2993).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Example schema:" block (```json), verbatim, saved as ``schema.json`` and the issue's
  "Used commandline" (verbatim in ISSUE_COMMAND below)
  "$ uvx --from datamodel-code-generator datamodel-codegen --input schema.json --input-file-type jsonschema --output models.py --output-model-type pydantic_v2.BaseModel --use-annotated --formatters ruff-format ruff-check"
  run from that directory; the generated ``models.py`` is read back and imported.
  Adaptations: (1) the issue runs the command as "$ uvx --from datamodel-code-generator datamodel-codegen ...", i.e. the
  ``datamodel-codegen`` command of the published datamodel-code-generator package fetched by uvx; offline, the same command is
  the console script of the sealed environment built from the candidate (pyproject.toml: ``scripts.datamodel-codegen =
  "datamodel_code_generator.__main__:main"``), invoked by its path next to ``sys.executable`` (the sandbox's PATH does not
  contain the environment's bin directory). It inherits this process's environment, so it imports the project from the same
  candidate tree as the fidelity check below; ``ruff`` (``--formatters ruff-format ruff-check``) is the sealed environment's
  (a missing console script or ruff binary = untrusted run). (2) The schema's file name ``schema.json`` is the one the command
  reads (``--input schema.json``); the directory is a fresh temporary directory. (3) The generated ``models.py`` is imported
  under a private module name. (4) The issue states the ``ipv6-addr`` pattern but no example value; the pattern check of
  ipv6-gw-ref-or-pattern uses two probe values chosen by the witness author, ``fe80::1`` and ``not-an-ipv6-address``, and the
  witness first confirms with pydantic alone (no project code) that the issue's ``ipv6-addr`` pattern accepts the first and
  rejects the second (otherwise the run is untrusted).
- Reported symptom on the pre-fix code (issue): "$ref doesn't work when used with other fields." --
  "`ipv6-gw`, on the other hand, got converted into" the block
  "ipv6_gw: Annotated[" / "str | None," / "Field(" / "alias="ipv6-gw"," /
  "description="IPv6 gateway address that will be set on a bridge used for the management network. Will be set to the first available IP address by default","
  / ")," / "] = None" (a plain ``str`` without the ``ipv6-addr`` pattern).
- Expected behaviour (issue), one check per quote:
  * ipv6-gw-ref-or-pattern: "when it should've generated `Ipv6Addr | None` or at least preserve the pattern." -- the command
    succeeds (exit 0) and the generated ``ipv6_gw`` field either (A) has the type ``Ipv6Addr | None`` (the field's type as the
    generated model resolves it equals ``Optional[Ipv6Addr]``, ``Ipv6Addr`` being the class the generated module defines), or
    (B) preserves the ``ipv6-addr`` pattern of the issue's schema: the generated model accepts ``{"ipv6-gw": "fe80::1"}`` and
    rejects ``{"ipv6-gw": "not-an-ipv6-address"}``.
- Author: W9.7 wit-g (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import ast
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import traceback
import typing

WITNESS = "koxudaxi__datamodel-code-generator-2993"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["datamodel_code_generator"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail): the
# project's runtime dependencies (pyproject.toml ``dependencies``) and ruff (the command's ``--formatters ruff-format ruff-check``).
DEPENDENCIES: list[str] = ["argcomplete", "black", "genson", "inflect", "isort", "jinja2", "pydantic", "yaml", "ruff"]

# The issue's "Example schema:" block, verbatim (raw string: the JSON's backslashes are kept as written).
SCHEMA_JSON = r'''
{
  "definitions": {
    "ipv4-addr": {
      "description": "IPv4 address",
      "markdownDescription": "IPv4 address",
      "type": "string",
      "pattern": "^(([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])(%[\\p{N}\\p{L}]+)?$"
    },
    "ipv6-addr": {
      "description": "IPv6 address",
      "markdownDescription": "IPv6 address",
      "type": "string",
      "pattern": "^((:|[0-9a-fA-F]{0,4}):)([0-9a-fA-F]{0,4}:){0,5}((([0-9a-fA-F]{0,4}:)?(:|[0-9a-fA-F]{0,4}))|(((25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])))(%[\\p{N}\\p{L}]+)?$"
    }
  },
  "type": "object",
  "properties": {
    "ipv4-gw": {
      "$ref": "#/definitions/ipv4-addr"
    },
    "ipv6-gw": {
      "description": "IPv6 gateway address that will be set on a bridge used for the management network. Will be set to the first available IP address by default",
      "markdownDescription": "IPv6 gateway address that will be set on a bridge used for the management network. Will be set to the first available IP address by default",
      "$ref": "#/definitions/ipv6-addr"
    }
  },
  "additionalProperties": false
}

'''

# The issue's "Used commandline", verbatim; the leading "uvx --from datamodel-code-generator" is adaptation (1).
ISSUE_COMMAND = "uvx --from datamodel-code-generator datamodel-codegen --input schema.json --input-file-type jsonschema --output models.py --output-model-type pydantic_v2.BaseModel --use-annotated --formatters ruff-format ruff-check"
COMMAND = ISSUE_COMMAND.split(" ", 3)[3]

# Probe values for the pattern alternative (adaptation 4).
MATCHING, NOT_MATCHING = "fe80::1", "not-an-ipv6-address"


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def bin_path(name):
    return os.path.join(os.path.dirname(sys.executable), name)


def ipv6_pattern():
    return json.loads(SCHEMA_JSON)["definitions"]["ipv6-addr"]["pattern"]


def probes_behave():
    """The issue's ipv6-addr pattern, applied by pydantic alone, accepts MATCHING and rejects NOT_MATCHING."""
    from pydantic import Field, TypeAdapter, ValidationError

    adapter = TypeAdapter(typing.Annotated[str, Field(pattern=ipv6_pattern())])
    adapter.validate_python(MATCHING)
    try:
        adapter.validate_python(NOT_MATCHING)
    except ValidationError:
        return True
    return False


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    work = tempfile.mkdtemp(prefix="dcg-2993-")
    with open(os.path.join(work, "schema.json"), "w", encoding="utf-8") as handle:
        handle.write(SCHEMA_JSON)
    program, *args = COMMAND.split()
    proc = subprocess.run([bin_path(program), *args], cwd=work, capture_output=True, text=True, timeout=150, env=os.environ.copy())
    path = os.path.join(work, "models.py")
    source = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
    return {"exit": proc.returncode, "stderr": proc.stderr[-1500:], "source": source, "path": path}


def load_generated(path):
    spec = importlib.util.spec_from_file_location("witness_generated_models_2993", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def field_owner(source, field):
    """Name and source text of the generated class declaring ``field`` (or None)."""
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name) and item.target.id == field:
                    return node.name, ast.get_source_segment(source, item)
    return None, None


def accepts(model, value):
    try:
        model.model_validate({"ipv6-gw": value})
    except Exception as exc:  # noqa: BLE001  (a rejection is an observation here)
        return False, f"{type(exc).__name__}: {str(exc)[:300]}"
    return True, None


def main() -> int:
    problems, fidelity, cases = [], {}, []
    for name in DEPENDENCIES:
        try:
            __import__(name)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"dependency {name} not importable: {type(exc).__name__}: {exc}")
    for name in ("datamodel-codegen", "ruff"):
        if not os.path.exists(bin_path(name)):
            problems.append(f"{bin_path(name)} missing from the sealed environment")
    if not problems:
        try:
            if not probes_behave():
                problems.append(f"probe {NOT_MATCHING!r} is not rejected by the issue's ipv6-addr pattern")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"probe {MATCHING!r} is not accepted by the issue's ipv6-addr pattern: {type(exc).__name__}: {str(exc)[:300]}")
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
        observed, error, case = None, None, {"id": "ipv6-gw-ref-or-pattern", "passed": False, "expected": "ipv6_gw: Ipv6Addr | None, or the ipv6-addr pattern preserved"}
        try:
            observed = reproduce()
            case.update({"exit": observed["exit"], "model": observed["source"]})
            if observed["exit"] != 0 or not observed["source"]:
                case["stderr"] = observed["stderr"]
            else:
                owner, statement = field_owner(observed["source"], "ipv6_gw")
                case["observed"] = statement
                generated = load_generated(observed["path"])
                model = getattr(generated, owner) if owner else None
                annotation = model.model_fields["ipv6_gw"].annotation if model is not None else None
                ipv6_addr = getattr(generated, "Ipv6Addr", None)
                ref_type = ipv6_addr is not None and annotation == typing.Optional[ipv6_addr]
                accepts_match, match_error = accepts(model, MATCHING) if model is not None else (False, "no class declares ipv6_gw")
                accepts_other, _ = accepts(model, NOT_MATCHING) if model is not None else (True, None)
                pattern_kept = accepts_match and not accepts_other
                case.update({
                    "observedType": repr(annotation),
                    "A_typeIsIpv6AddrOrNone": ref_type,
                    "B_patternPreserved": pattern_kept,
                    "B_detail": {f"accepts {MATCHING!r}": accepts_match, f"accepts {NOT_MATCHING!r}": accepts_other, **({"matchError": match_error} if match_error else {})},
                })
                case["passed"] = observed["exit"] == 0 and (ref_type or pattern_kept)
        except Exception as exc:  # noqa: BLE001  (the command, or the generated module, failing is a failure)
            error = error_text(exc)
        if error:
            case.update({"passed": False, "error": error})
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
