#!/usr/bin/env python3
"""Public witness for facelessuser/pymdown-extensions issue "inline `$$x$$` math matches 2 times and returns nested mathjax"
(facelessuser__pymdown-extensions-2807).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Minimal Reproduction" code block, verbatim below in `reproduce()` (same input "hello $$x$$", same
  calls ``markdown.Markdown(extensions=[ArithmatexExtension()])`` and ``md.convert(foo)``, same dependency boundary: Python-Markdown
  with the project's Arithmatex extension, default options).
  Adaptations:
  * The block omits its imports. ``import markdown`` is taken from the snapshot's public docs
    (docs/src/markdown/extensions/arithmatex.md:21, "import markdown"); ``from pymdownx.arithmatex import ArithmatexExtension``
    names the class the block calls, which the snapshot defines at pymdownx/arithmatex.py:335 (the issue: "The arithmetex
    modules here").
  * ``print(out)`` is kept; the converted string ``out`` is also returned so the check compares it (surrounding whitespace
    stripped, as the issue shows printed output).
- Reported symptom on the pre-fix code (issue): "The matches occurs 2 times and we end up with a nested mathjax output." and
  "Output is:" "<p>hello <span class="arithmatex"><span class="MathJax_Preview"><span class="arithmatex"><span class="MathJax_Preview">x</span><script type="math/tex">x</script></span></span><script type="math/tex"><span class="arithmatex"><span class="MathJax_Preview">x</span><script type="math/tex">x</script></span></script></span></p>"
- Expected behaviour (issue), one check per quote:
  * convert-output: "It should be:"
    "<p>hello <span class="arithmatex"><span class="MathJax_Preview">x</span><script type="math/tex">x</script></span></p>"
- Author: W9.15 witb-8 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests
  and the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import traceback

WITNESS = "facelessuser__pymdown-extensions-2807"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["pymdownx"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["markdown"]

EXPECTED = '<p>hello <span class="arithmatex"><span class="MathJax_Preview">x</span><script type="math/tex">x</script></span></p>'


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import markdown  # adaptation: import omitted by the issue (docs/src/markdown/extensions/arithmatex.md:21)
    from pymdownx.arithmatex import ArithmatexExtension  # adaptation: import omitted by the issue (pymdownx/arithmatex.py:335)

    foo = "hello $$x$$"
    md = markdown.Markdown(extensions=[ArithmatexExtension()])
    out = md.convert(foo)
    print(out)
    return out


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
        passed = error is None and isinstance(observed, str) and observed.strip() == EXPECTED
        cases.append({"id": "convert-output", "passed": passed, "expected": EXPECTED, "observed": observed, **({"error": error} if error else {})})
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
