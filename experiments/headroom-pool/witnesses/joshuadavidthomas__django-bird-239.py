#!/usr/bin/env python3
"""Public witness for joshuadavidthomas/django-bird issue "Isolated components (using `only`) do not receive props correctly"
(joshuadavidthomas__django-bird-239).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's three code blocks, verbatim below: the view (``render(request, "index.html", {"a_string_var":
  "Hello World"})``), the component ``bird/basic_component.html`` (``{% bird:prop text %}`` / ``<p>Text: {{ props.text }}</p>``)
  and the page template with its four ``{% bird basic_component ... / %}`` tags.
  Adaptations:
  (1) the component block's first line "# bird/basic_component.html" is the file's name, not template text (README.md: "Create a
      new directory named `bird` in your project's main templates directory"); the two templates are written to
      ``<tmp>/templates/bird/basic_component.html`` and ``<tmp>/templates/index.html``;
  (2) the Django settings the issue leaves out are the snapshot's documented setup: README.md "2. Add the app to your Django
      project's `INSTALLED_APPS`" (``"django_bird"``, next to the default ``"django.contrib.staticfiles"`` its
      STATICFILES_FINDERS belong to) and docs/configuration.md "The complete setup in your settings file should look like this"
      (TEMPLATES with ``"DIRS": [BASE_DIR / "templates"]`` and ``"builtins": ["django_bird.templatetags.django_bird"]``, and the
      STATICFILES_FINDERS list), applied with ``settings.configure`` and ``django.setup()``;
  (3) the issue does not show its URLconf, so the view is called directly with a ``django.test.RequestFactory().get("/")``
      request, and the HTML is the response's content;
  (4) the issue lists the rendered HTML without the blank lines between components, so the ``<p>Text: ...</p>`` elements are
      compared in order.
- Reported symptom on the pre-fix code (issue): "Results in the following HTML:" ... "<p>Text: a_string_var</p>" (the fourth
  line) and "The final isolated component only receives the stringified name of the variable passed to the prop, not the value
  of the variable."
- Expected behaviour (issue), one check per quote:
  * only-dynamic-prop: "it seems that isolated components specified with `only` don't receive props correctly when the values of
    the props come from the parent context", "The final isolated component only receives the stringified name of the variable
    passed to the prop, not the value of the variable." and the documentation the issue quotes (also docs/params.md "Context
    Isolation" in the snapshot): "Props, slots, and other component-specific context still work normally" -- the fourth tag
    (``text=a_string_var only``) renders the value the view passes, ``{"a_string_var": "Hello World"}``: "<p>Text: Hello
    World</p>".
  * other-tags: "Results in the following HTML:" "<p>Text: Hello World</p>" (first three lines, which the issue does not report
    as wrong) -- the three other tags keep rendering "<p>Text: Hello World</p>".
  The other quoted documentation bullets ("The component cannot access variables from the parent context", "Default values in
  the component template will be used when parent context variables are not available") are not exercised by the issue's
  templates, so they are not checked.
- Author: W9.4 wit-d (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import traceback
from pathlib import Path

WITNESS = "joshuadavidthomas__django-bird-239"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["django_bird"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["django", "pluggy"]

# The issue's component (its first line, "# bird/basic_component.html", names the file).
COMPONENT = """{% bird:prop text %}
<p>Text: {{ props.text }}</p>
"""

# The issue's page template.
INDEX = """{% bird basic_component text="Hello World" / %}
{% bird basic_component text="Hello World" only / %}
{% bird basic_component text=a_string_var / %}
{% bird basic_component text=a_string_var only / %}
"""


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def configure():
    """Adaptations (1) and (2): the templates on disk and the documented settings (README.md, docs/configuration.md)."""
    base_dir = Path(tempfile.mkdtemp(prefix="django-bird-239-"))
    (base_dir / "templates" / "bird").mkdir(parents=True)
    (base_dir / "templates" / "bird" / "basic_component.html").write_text(COMPONENT)
    (base_dir / "templates" / "index.html").write_text(INDEX)
    from django.conf import settings

    settings.configure(
        INSTALLED_APPS=["django.contrib.staticfiles", "django_bird"],
        TEMPLATES=[
            {
                "BACKEND": "django.template.backends.django.DjangoTemplates",
                "DIRS": [
                    base_dir / "templates",
                ],
                "OPTIONS": {
                    "builtins": [
                        "django_bird.templatetags.django_bird",
                    ],
                },
            }
        ],
        STATICFILES_FINDERS=[
            "django.contrib.staticfiles.finders.FileSystemFinder",
            "django.contrib.staticfiles.finders.AppDirectoriesFinder",
            "django_bird.staticfiles.BirdAssetFinder",
        ],
    )
    import django

    django.setup()


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    configure()
    from django.shortcuts import render
    from django.test import RequestFactory

    def view(request):
        return render(request, "index.html", {"a_string_var": "Hello World"})

    response = view(RequestFactory().get("/"))  # adaptation (3)
    html = response.content.decode()
    print(html)
    return {"html": html, "paragraphs": re.findall(r"<p>Text: .*?</p>", html, re.S)}  # adaptation (4)


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
        expected_line = "<p>Text: Hello World</p>"
        if observed is None:
            cases.append({"id": "only-dynamic-prop", "passed": False, "expected": expected_line, "error": error})
            cases.append({"id": "other-tags", "passed": False, "expected": [expected_line] * 3, "error": error})
        else:
            paragraphs = observed["paragraphs"]
            fourth = paragraphs[3] if len(paragraphs) == 4 else None
            cases.append({"id": "only-dynamic-prop", "passed": len(paragraphs) == 4 and fourth == expected_line,
                          "expected": {"tag": "{% bird basic_component text=a_string_var only / %}", "html": expected_line},
                          "observed": {"fourth": fourth, "paragraphs": paragraphs, "html": observed["html"]}})
            cases.append({"id": "other-tags", "passed": len(paragraphs) == 4 and paragraphs[:3] == [expected_line] * 3,
                          "expected": [expected_line] * 3, "observed": paragraphs[:3] if len(paragraphs) == 4 else paragraphs})
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
