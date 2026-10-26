#!/usr/bin/env python3
"""Public witness for keras-team/keras issue "Missing block_size validation in space_to_depth and depth_to_space leading to
DivisionByZero" (keras-team__keras-22138).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Reproduction Script" (first code block), verbatim below in `reproduce()` (TensorFlow backend selected
  before ``import keras``, the same ``x = np.random.rand(1, 4, 4, 12).astype("float32")``, the same
  ``keras.ops.nn.space_to_depth(x, block_size=0)`` inside the same ``try/except Exception as e: print(f"Caught: {e}")``).
  Adaptations:
  (1) the script's statements are the body of `reproduce()`; the caught exception is also kept (``caught = e``) so that its type
      can be checked, and ``x`` is returned for the cases below;
  (2) the script's first two statements (``os.environ["KERAS_BACKEND"] = "tensorflow"`` before the first ``import keras``) are also
      executed at the top of this file, because the witness imports keras once before `reproduce()` to verify that it comes from
      the candidate; the run is untrusted if the backend is not "tensorflow";
  (3) the same call, with the script's ``x``, for the other operation and for a negative value, determined by "The recently added
      `space_to_depth` and `depth_to_space` operations in `keras.ops.nn` do **not** validate the `block_size` argument." and
      "Providing `block_size=0` or a negative value results in:" (the negative value used is -1);
  (4) the same two operations with ``block_size=0`` on a symbolic input of the script's shape (``keras.Input(shape=(4, 4, 12),
      batch_size=1)``), determined by "In some cases, Python-level `ZeroDivisionError` during shape inference" and the title's
      "leading to DivisionByZero";
  (5) the same two operations with ``block_size=0`` and the script's input under the JAX backend (the script with
      ``"tensorflow"`` replaced by ``"jax"``, run with ``sys.executable`` in a fresh interpreter because the backend is fixed at
      import), determined by "Inconsistent behavior across backends (TF / JAX / Torch)" (Torch is not installed in the sealed
      environment, so it is not run).
- Reported symptom on the pre-fix code (issue): "# but currently the backend raises the exception." and, under "Actual Behavior
  (TensorFlow backend)", "InvalidArgumentError: Value for attr 'block_size' of 0 must be at least minimum 2"; also "Backend-specific
  errors (TensorFlow raises a low-level op error)", "In some cases, Python-level `ZeroDivisionError` during shape inference" and
  "Inconsistent behavior across backends (TF / JAX / Torch)".
- Expected behaviour (issue), one check per quote. The issue gives the exception type but two different message texts ("ValueError:
  block_size must be >= 2. Received: block_size=0" under "Expected Behavior" and "`block_size` must be at least 2. Received:
  block_size={block_size}" under "Suggested Fix"), so only the type is checked:
  * tf-space_to_depth-0 (the reproduction): "# This should raise a Keras-level ValueError," and "Keras should validate this at the API
    level (in `nn.py`) and raise a consistent `ValueError` before reaching the backend:" / "ValueError: block_size must be >= 2.
    Received: block_size=0" -- the caught exception is a ``ValueError``.
  * tf-depth_to_space-0, tf-space_to_depth-negative, tf-depth_to_space-negative: "Keras should raise a consistent, frontend-level
    `ValueError` before dispatching to backends" (for "`space_to_depth` and `depth_to_space`" and "`block_size=0` or a negative
    value") -- a ``ValueError`` is raised.
  * symbolic-space_to_depth-0, symbolic-depth_to_space-0: the same quote, for "Python-level `ZeroDivisionError` during shape
    inference" -- a ``ValueError`` is raised.
  * jax-space_to_depth-0, jax-depth_to_space-0: the same quote ("consistent", "before dispatching to backends"), for "Inconsistent
    behavior across backends (TF / JAX / Torch)" -- a ``ValueError`` is raised under the JAX backend too.
- Author: W9.4 wit-d (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import os

# Adaptation (2): the issue's script selects the backend before its first `import keras`; the witness's first keras import is the
# fidelity import in main(), so the same statement runs here first.
os.environ["KERAS_BACKEND"] = "tensorflow"

import json  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import traceback  # noqa: E402

WITNESS = "keras-team__keras-22138"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["keras"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["numpy", "tensorflow", "jax"]

# Adaptation (5): the issue's script with the JAX backend, both operations with block_size=0; it reports what it caught.
JAX_PROGRAM = '''import os
os.environ["KERAS_BACKEND"] = "jax"
import json
import keras
import numpy as np

# Input shape: (batch, height, width, channels)
x = np.random.rand(1, 4, 4, 12).astype("float32")

report = {"backend": keras.backend.backend(), "keras_file": keras.__file__, "caught": {}}
for name, call in (("space_to_depth", lambda: keras.ops.nn.space_to_depth(x, block_size=0)),
                   ("depth_to_space", lambda: keras.ops.nn.depth_to_space(x, block_size=0))):
    try:
        out = call()
        report["caught"][name] = None
    except Exception as e:
        print(f"Caught: {e}")
        report["caught"][name] = {"type": f"{type(e).__module__}.{type(e).__name__}", "is_value_error": isinstance(e, ValueError), "message": str(e)[:400]}
print("JAX_REPORT " + json.dumps(report))
'''


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def describe(exc):
    if exc is None:
        return None
    return {"type": f"{type(exc).__module__}.{type(exc).__name__}", "message": str(exc)[:400]}


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import os
    os.environ["KERAS_BACKEND"] = "tensorflow"
    import keras
    import numpy as np

    # Input shape: (batch, height, width, channels)
    x = np.random.rand(1, 4, 4, 12).astype("float32")

    # This should raise a Keras-level ValueError,
    # but currently the backend raises the exception.
    caught = None
    try:
        out = keras.ops.nn.space_to_depth(x, block_size=0)
    except Exception as e:
        print(f"Caught: {e}")
        caught = e
    return x, caught


def attempt(call):
    """The script's try/except pattern for the other cases: returns the exception raised (None when the call returns)."""
    try:
        call()
    except Exception as e:  # noqa: BLE001
        print(f"Caught: {e}")
        return e
    return None


def value_error_case(case_id, exc, **context):
    return {"id": case_id, "passed": isinstance(exc, ValueError), "expected": "ValueError raised", "observed": describe(exc) or "no exception (the call returned)", **context}


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
        import keras

        if keras.backend.backend() != "tensorflow":
            problems.append(f"the issue's TensorFlow backend was not selected (backend {keras.backend.backend()!r})")
    if not problems and not cases:
        import keras

        x, caught, error = None, None, None
        try:
            x, caught = reproduce()
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        if error is not None:
            cases.append({"id": "tf-space_to_depth-0", "passed": False, "expected": "ValueError raised", "error": error})
        else:
            # The reproduction itself (TensorFlow backend, eager NumPy input, space_to_depth, block_size=0).
            cases.append(value_error_case("tf-space_to_depth-0", caught, backend="tensorflow", call="keras.ops.nn.space_to_depth(x, block_size=0)"))
            # Adaptation (3): the other operation, and a negative value, same input and backend.
            cases.append(value_error_case("tf-depth_to_space-0", attempt(lambda: keras.ops.nn.depth_to_space(x, block_size=0)), backend="tensorflow", call="keras.ops.nn.depth_to_space(x, block_size=0)"))
            cases.append(value_error_case("tf-space_to_depth-negative", attempt(lambda: keras.ops.nn.space_to_depth(x, block_size=-1)), backend="tensorflow", call="keras.ops.nn.space_to_depth(x, block_size=-1)"))
            cases.append(value_error_case("tf-depth_to_space-negative", attempt(lambda: keras.ops.nn.depth_to_space(x, block_size=-1)), backend="tensorflow", call="keras.ops.nn.depth_to_space(x, block_size=-1)"))
            # Adaptation (4): shape inference on a symbolic input of the script's shape.
            try:
                symbolic = keras.Input(shape=(4, 4, 12), batch_size=1)
            except Exception as exc:  # noqa: BLE001
                symbolic, symbolic_error = None, error_text(exc)
            if symbolic is None:
                for op in ("space_to_depth", "depth_to_space"):
                    cases.append({"id": f"symbolic-{op}-0", "passed": False, "expected": "ValueError raised", "error": symbolic_error})
            else:
                cases.append(value_error_case("symbolic-space_to_depth-0", attempt(lambda: keras.ops.nn.space_to_depth(symbolic, block_size=0)), backend="tensorflow", call="keras.ops.nn.space_to_depth(keras.Input(shape=(4, 4, 12), batch_size=1), block_size=0)"))
                cases.append(value_error_case("symbolic-depth_to_space-0", attempt(lambda: keras.ops.nn.depth_to_space(symbolic, block_size=0)), backend="tensorflow", call="keras.ops.nn.depth_to_space(keras.Input(shape=(4, 4, 12), batch_size=1), block_size=0)"))
        # Adaptation (5): the JAX backend in a fresh interpreter.
        work = tempfile.mkdtemp(prefix="keras-22138-")
        with open(os.path.join(work, "jax_block_size.py"), "w") as handle:
            handle.write(JAX_PROGRAM)
        try:
            proc = subprocess.run([sys.executable, "jax_block_size.py"], cwd=work, capture_output=True, text=True, timeout=120, env=os.environ.copy())
            lines = [line for line in proc.stdout.splitlines() if line.startswith("JAX_REPORT ")]
            report = json.loads(lines[-1][len("JAX_REPORT "):]) if lines else None
            jax_error = None if report else f"exit {proc.returncode}; no JAX_REPORT line; stderr: {proc.stderr[-1500:]}"
        except Exception as exc:  # noqa: BLE001
            report, jax_error = None, error_text(exc)
        if report is not None and report.get("backend") != "jax":
            problems.append(f"the JAX run did not use the JAX backend (backend {report.get('backend')!r})")
        if report is not None and root is not None and not inside(report.get("keras_file"), root):
            problems.append(f"keras was not imported from the candidate in the JAX run ({report.get('keras_file')!r})")
        for op in ("space_to_depth", "depth_to_space"):
            if report is None:
                cases.append({"id": f"jax-{op}-0", "passed": False, "expected": "ValueError raised", "error": jax_error})
            else:
                observed = report["caught"].get(op)
                cases.append({"id": f"jax-{op}-0", "passed": bool(observed and observed.get("is_value_error")), "expected": "ValueError raised", "observed": observed or "no exception (the call returned)", "backend": "jax", "call": f"keras.ops.nn.{op}(x, block_size=0)"})
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
