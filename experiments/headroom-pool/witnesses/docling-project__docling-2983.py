#!/usr/bin/env python3
"""Public witness for docling-project/docling issue "AsciiDoc image macro crashes when alt text contains commas"
(docling-project__docling-2983).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's only code block ("### Steps to reproduce"), verbatim below in `reproduce()` (same .adoc content, same
  ``DocumentConverter(allowed_formats=[InputFormat.ASCIIDOC])``, same ``convert_all(source=[tmp_path], raises_on_error=False)``, same
  two prints). Adaptations: (1) the block's top-level statements are the body of `reproduce()` (indentation only); (2) the two values
  the block prints (``result[0].status`` and ``result[0].errors``) are also returned so that the checks can read them. The temporary
  .adoc file is created by the issue's own ``tempfile.NamedTemporaryFile(..., delete=False)`` in the sandbox's writable TMPDIR.
- Reported symptom on the pre-fix code (issue): "AsciiDocBackend._parse_picture() crashes with ValueError: not enough values to
  unpack when the image alt text contains commas." and "This crashes the entire pipeline with RuntimeError: Pipeline SimplePipeline
  failed, even with raises_on_error=False the document is marked as FAILURE", with the block's annotated output
  "print(result[0].status)  # ConversionStatus.FAILURE" and "print(result[0].errors)  # "not enough values to unpack (expected 2, got 1)"".
- Expected behaviour (issue), one check per quote. The issue's title names the defect, "AsciiDoc image macro crashes when alt text
  contains commas"; the expectation is the absence of that crash on the issue's own input, observed on the two values the issue
  prints (no other value, e.g. the picture's attributes, is stated by the issue, so none is checked):
  * not-failure: "even with raises_on_error=False the document is marked as FAILURE" / "print(result[0].status)  #
    ConversionStatus.FAILURE" -- ``result[0].status`` must not be ``ConversionStatus.FAILURE``.
  * no-error: "AsciiDocBackend._parse_picture() crashes with ValueError: not enough values to unpack when the image alt text
    contains commas." / "print(result[0].errors)  # "not enough values to unpack (expected 2, got 1)"" -- ``result[0].errors``
    must be empty (the conversion of the issue's document records no error).
- Author: W9.4 wit-d (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "docling-project__docling-2983"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["docling"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["docling_core", "pydantic"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    from docling.document_converter import DocumentConverter
    from docling.datamodel.base_models import InputFormat
    from pathlib import Path
    import tempfile

    # Minimal .adoc file with commas in alt text
    content = """= Test Document

image::images/screenshot.png[A screenshot showing a dialog box, containing text fields, buttons, and validation errors, width=604, height=422]
  """

    with tempfile.NamedTemporaryFile(suffix=".adoc", mode="w", delete=False) as f:
        f.write(content)
        tmp_path = Path(f.name)

    converter = DocumentConverter(allowed_formats=[InputFormat.ASCIIDOC])
    result = list(converter.convert_all(source=[tmp_path], raises_on_error=False))
    print(result[0].status)  # ConversionStatus.FAILURE
    print(result[0].errors)  # "not enough values to unpack (expected 2, got 1)"
    return {"status": result[0].status, "errors": list(result[0].errors)}


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
        extra = {"error": error} if error else {}
        if observed is not None:
            from docling.datamodel.base_models import ConversionStatus

            status, errors = observed["status"], observed["errors"]
            cases.append({"id": "not-failure", "passed": status != ConversionStatus.FAILURE,
                          "expected": "result[0].status is not ConversionStatus.FAILURE", "observed": str(status)})
            cases.append({"id": "no-error", "passed": len(errors) == 0,
                          "expected": "result[0].errors == []", "observed": [str(item) for item in errors]})
        else:
            cases.append({"id": "not-failure", "passed": False, "expected": "result[0].status is not ConversionStatus.FAILURE", "observed": None, **extra})
            cases.append({"id": "no-error", "passed": False, "expected": "result[0].errors == []", "observed": None, **extra})
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
