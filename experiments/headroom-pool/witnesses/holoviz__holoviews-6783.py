#!/usr/bin/env python3
"""Public witness for holoviz/holoviews issue "Interpolation breaks with pandas nullable dtypes" (holoviz__holoviews-6783).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's second code block ("Complete, minimal, self-contained example code that reproduces the issue"),
  verbatim below in `reproduce()` (same inputs, same calls, same dependency boundary).
  Adaptations:
  1. The block's last line is a notebook cell's displayed value; the witness binds it to ``curve`` (no other change).
  2. Display: the notebook displays that value; the issue's traceback shows the display reaching the backend renderer in
     ``holoviews/ipython/display_hooks.py:69, in render(obj, **kwargs)`` / "---> 69 return renderer.components(obj, **kwargs)".
     IPython/Jupyter are not part of the sealed environment, so the witness makes that renderer call itself:
     ``hv.renderer('bokeh').components(curve)`` (``hv.renderer``: "Helper utility to access the active renderer for a given
     extension.", holoviews/util/__init__.py of the snapshot).
  3. The rendered figure: ``hv.render(curve, backend='bokeh')``, the public function that "Renders the HoloViews object to the
     corresponding object in the specified backend, e.g. a Matplotlib or Bokeh figure." (holoviews/util/__init__.py of the
     snapshot); it runs the same ``BokehRenderer.get_plot`` step as the traceback ("holoviews/plotting/bokeh/renderer.py:70, in
     BokehRenderer.get_plot").
- Reported symptom on the pre-fix code (issue): "Code raises an exception" / "TypeError: Cannot interpret 'UInt64Dtype()' as a data type"
- Expected behaviour (issue), one check per quote:
  * display-accepts-input: "Code raises an exception, but it should accept the input and work." -- displaying the issue's
    ``hv.Curve(df, kdims=['a'], vdims=['b']).opts(interpolation='steps-post')`` (adaptation 2) completes without an exception
    and returns a non-empty display bundle.
  * render-draws-input: "it should accept the input and work." -- the rendered Bokeh figure (adaptation 3) draws the issue's
    input ``df=pd.DataFrame(dict(a=[1,2,3], b=[3,4,5]), dtype='UInt64')``: a glyph whose x values are the values of ``a``
    (1, 2, 3) and whose y values are the values of ``b`` (3, 4, 5). Only the sets of plotted values are compared (a step
    interpolation repeats points), as numbers (not by dtype).
- Author: W9.1 wit-a (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
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

WITNESS = "holoviz__holoviews-6783"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["holoviews"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "pandas", "param", "bokeh", "panel"]

# The issue's input values (``dict(a=[1,2,3], b=[3,4,5])``).
EXPECTED_X = [1, 2, 3]
EXPECTED_Y = [3, 4, 5]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def glyph_values(figure):
    """x/y values drawn by each glyph renderer of a Bokeh figure (field names resolved through the glyph's data source)."""
    from bokeh.models import GlyphRenderer

    drawn = []
    for renderer in getattr(figure, "renderers", []):
        if not isinstance(renderer, GlyphRenderer):
            continue
        glyph, data = renderer.glyph, renderer.data_source.data
        entry = {"glyph": type(glyph).__name__}
        for axis in ("x", "y"):
            spec = getattr(glyph, axis, None)
            if isinstance(spec, dict):
                spec = spec.get("field", spec.get("value"))
            values = data.get(spec) if isinstance(spec, str) else spec
            entry[axis] = None if values is None else [float(value) for value in values]
        drawn.append(entry)
    return drawn


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import holoviews as hv
    hv.extension('bokeh')
    import pandas as pd

    df=pd.DataFrame(dict(a=[1,2,3], b=[3,4,5]), dtype='UInt64')

    curve = hv.Curve(df, kdims=['a'], vdims=['b']).opts(interpolation='steps-post')  # adaptation 1

    observed = {}
    try:  # adaptation 2: the display hook's renderer call
        bundle = hv.renderer('bokeh').components(curve)
        data = bundle[0] if isinstance(bundle, tuple) and bundle else bundle
        observed["display"] = {"type": type(bundle).__name__, "mimetypes": sorted(data) if isinstance(data, dict) else None}
    except Exception as exc:  # noqa: BLE001
        observed["display"] = {"error": error_text(exc)}
    try:  # adaptation 3: the rendered Bokeh figure
        import bokeh.model

        figure = hv.render(curve, backend='bokeh')
        observed["render"] = {"type": f"{type(figure).__module__}.{type(figure).__name__}", "bokeh_model": isinstance(figure, bokeh.model.Model), "glyphs": glyph_values(figure)}
    except Exception as exc:  # noqa: BLE001
        observed["render"] = {"error": error_text(exc)}
    return observed


def draws_input(render):
    if not render or render.get("error") or not render.get("bokeh_model"):
        return False
    return any(glyph.get("x") is not None and glyph.get("y") is not None and set(glyph["x"]) == {float(v) for v in EXPECTED_X} and set(glyph["y"]) == {float(v) for v in EXPECTED_Y} for glyph in render.get("glyphs", []))


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
        display = (observed or {}).get("display") or {}
        render = (observed or {}).get("render") or {}
        cases.append({"id": "display-accepts-input", "passed": error is None and not display.get("error") and bool(display.get("mimetypes")),
                      "expected": "the display step returns a non-empty bundle without an exception", "observed": display, **({"error": error} if error else {})})
        cases.append({"id": "render-draws-input", "passed": error is None and draws_input(render),
                      "expected": {"bokeh_model": True, "x_values": EXPECTED_X, "y_values": EXPECTED_Y}, "observed": render, **({"error": error} if error else {})})
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
