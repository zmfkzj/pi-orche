#!/usr/bin/env python3
"""Public witness for stanfordnlp/dspy issue "[Bug] Incomplete Streaming When LLM Omits Completion Marker"
(stanfordnlp__dspy-8890).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Steps to reproduce" code block, verbatim below in `reproduce()` (same imports, same
  ``dspy.configure(...)``, same ``MOCKED_TEXT``, same ``mock_stream_random_chunks`` / ``completion_side_effect`` mock of
  ``litellm.acompletion``, same ``dspy.context(...)``, ``dspy.Predict("query -> answer")``, ``dspy.streamify(...)`` with
  ``dspy.streaming.StreamListener(signature_field_name="answer")`` and the same query; no network: the LM call is the issue's
  mock).
  Adaptations:
  * The block's ``async for`` runs at top level (an async REPL). It is wrapped in ``async def`` and run with ``asyncio.run``, as
    the snapshot's public docs prescribe (docs/docs/tutorials/streaming/index.md:38-47, and :64 "Since `dspy.streamify` returns an
    async generator, you must use it within an async context.").
  * The loop also keeps the final ``dspy.Prediction`` the stream yields (docs/docs/tutorials/streaming/index.md:87-92,
    ``elif isinstance(chunk, dspy.Prediction)``), because the issue compares the streamed chunks with "The final Prediction
    object"; the issue's ``print(chunk_mock)`` of every ``StreamResponse`` is kept and the chunks are recorded.
  * The issue's chunk sizes are random (``random.randint(1, 10)``). For a reproducible verdict the reproduction runs once per
    fixed seed (``random.seed(s)`` for s in SEEDS) before streaming; the issue's generator is unchanged. Every seed shows the
    reported symptom on the pre-fix snapshot.
- Reported symptom on the pre-fix code (issue): "1. The last ~10 tokens of the response are never yielded to the user (lost in
  buffer)", "2. No chunk is marked with `is_last_chunk=True`", "3. The final Prediction object contains the complete response,
  but the streamed chunks are incomplete" and "This causes the last tokens of the answer to never be streamed and be lost (or only
  accessible in the full prediction)."
- Expected behaviour (issue), one check per quote:
  * answer-streamed-completely: "if no completed marker is found, we can still recover all chunks" with "The final Prediction
    object contains the complete response, but the streamed chunks are incomplete" -- for every seed, the concatenated
    ``StreamResponse.chunk`` values of the ``answer`` field equal the complete response: the final Prediction's ``answer`` and
    the answer text of the issue's MOCKED_TEXT, "This is a test response with many tokens to ensure buffering works correctly."
    (surrounding whitespace ignored on both sides).
  * last-chunk-marked: "No chunk is marked with `is_last_chunk=True`" / "no chunk gets `is_last_chunk=True`" (reported as the
    bug) -- for every seed, the last streamed ``answer`` chunk has ``is_last_chunk=True``.
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

WITNESS = "stanfordnlp__dspy-8890"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["dspy"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["litellm", "litellm.types.utils"]

SEEDS = [0, 1, 2, 3, 4]
# The answer section of the issue's MOCKED_TEXT (verbatim): the complete response.
ANSWER = "This is a test response with many tokens to ensure buffering works correctly."


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import asyncio  # adaptation: run the issue's top-level ``async for`` (docs/docs/tutorials/streaming/index.md:38-47)

    import dspy
    import json
    from unittest import mock
    from litellm.types.utils import Delta, ModelResponseStream, StreamingChoices
    import random

    dspy.configure(
        lm=dspy.LM("gemini/gemini-flash-lite-latest", max_tokens=30000, cache=False),
        adapter=dspy.adapters.ChatAdapter()
    )

    # The complete mocked response - Rust code with #[derive] attribute
    MOCKED_TEXT = """[[ ## reasoning ## ]]
This is a reasoning trace with many tokens to ensure buffering works correctly.
[[ ## answer ## ]]
This is a test response with many tokens to ensure buffering works correctly.
"""

    async def mock_stream_random_chunks(*args, **kwargs):
        """Stream MOCKED_TEXT in random chunk sizes"""
        i = 0
        while i < len(MOCKED_TEXT):
            # Random chunk size between 1 and 10 characters
            chunk_size = random.randint(1, 10)
            chunk = MOCKED_TEXT[i:i+chunk_size]
            yield ModelResponseStream(
                model="gemini-flash-lite-latest",
                choices=[StreamingChoices(delta=Delta(content=chunk))]
            )
            i += chunk_size

    async def completion_side_effect(*args, **kwargs):
        return mock_stream_random_chunks()

    async def run_issue_block(record):  # adaptation: the issue's block, inside an async function
        with mock.patch("litellm.acompletion", side_effect=completion_side_effect):
            with dspy.context(lm=dspy.LM("gemini/gemini-flash-lite-latest", cache=False), adapter=dspy.ChatAdapter()):
                rust_program_mock = dspy.Predict("query -> answer")
                stream_rust_mock = dspy.streamify(
                    rust_program_mock,
                    stream_listeners=[dspy.streaming.StreamListener(signature_field_name="answer")]
                )

                print("Streaming chunks:")
                print("-" * 80)
                async for chunk_mock in stream_rust_mock(query="Write a Rust derive macro for Debug trait"):
                    if isinstance(chunk_mock, dspy.streaming.StreamResponse):
                        print(chunk_mock)
                        record["chunks"].append(chunk_mock)  # adaptation: keep the streamed chunks
                    elif isinstance(chunk_mock, dspy.Prediction):  # adaptation: keep the final Prediction (docs :91-92)
                        record["prediction"] = chunk_mock

    observed = {}
    for seed in SEEDS:
        random.seed(seed)  # adaptation: reproducible random chunking
        record = {"chunks": [], "prediction": None}
        try:
            asyncio.run(run_issue_block(record))
            error = None
        except Exception as exc:  # noqa: BLE001  (an exception raised by the candidate's code is a failure)
            error = error_text(exc)
        prediction = record["prediction"]
        answer_chunks = [c for c in record["chunks"] if getattr(c, "signature_field_name", None) == "answer"]
        observed[seed] = {
            "error": error,
            "chunks": [{"chunk": c.chunk, "is_last_chunk": getattr(c, "is_last_chunk", None)} for c in answer_chunks],
            "streamed": "".join(str(c.chunk) for c in answer_chunks),
            "prediction_answer": None if prediction is None else getattr(prediction, "answer", None),
        }
    return observed


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
        if error is not None:
            cases.append({"id": "answer-streamed-completely", "passed": False, "error": error})
            cases.append({"id": "last-chunk-marked", "passed": False, "error": error})
        else:
            complete, marked = {}, {}
            for seed, run in observed.items():
                prediction_answer = run["prediction_answer"]
                complete[seed] = (
                    run["error"] is None
                    and isinstance(prediction_answer, str)
                    and prediction_answer.strip() == ANSWER
                    and run["streamed"].strip() == ANSWER
                )
                marked[seed] = run["error"] is None and bool(run["chunks"]) and run["chunks"][-1]["is_last_chunk"] is True
            cases.append({
                "id": "answer-streamed-completely",
                "passed": all(complete.values()),
                "expected": {"streamed (stripped)": ANSWER, "equal to": "the final Prediction's answer (stripped)", "seeds": SEEDS},
                "observed": {str(seed): {"passed": complete[seed], "streamed": run["streamed"], "prediction_answer": run["prediction_answer"], **({"error": run["error"]} if run["error"] else {})} for seed, run in observed.items()},
            })
            cases.append({
                "id": "last-chunk-marked",
                "passed": all(marked.values()),
                "expected": {"last answer chunk": "is_last_chunk=True", "seeds": SEEDS},
                "observed": {str(seed): {"passed": marked[seed], "is_last_chunk": [c["is_last_chunk"] for c in run["chunks"]], **({"error": run["error"]} if run["error"] else {})} for seed, run in observed.items()},
            })
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
