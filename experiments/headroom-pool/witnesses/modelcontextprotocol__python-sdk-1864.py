#!/usr/bin/env python3
"""Public witness for modelcontextprotocol/python-sdk issue "URL Parameters Not Decoded in Dynamic Resources"
(modelcontextprotocol__python-sdk-1864).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Example Code" block, verbatim below as ``ISSUE_BLOCK`` (the resource template
  ``products://search/{product_identifier}`` and its handler that prints the parameter it receives), read through the MCP
  protocol (``resources/read``) with the issue's own encoded identifier from its "before" log line. Adaptations:
  1. Indentation: in the issue the ``def`` and its body are indented by 4 spaces under the decorator (an IndentationError as
     written); the lines after the decorator are dedented (``textwrap.dedent``), nothing else is changed.
  2. The server object ``mcp`` the block decorates with is created as the snapshot's README.md "Resources" example does
     (README.md lines 292-294: ``from mcp.server.fastmcp import FastMCP`` / ``mcp = FastMCP(name="Resource Example")``).
  3. The client: the issue does not show it; the resource is read over the in-memory MCP transport the snapshot documents for
     exercising a server (docs/testing.md: ``create_connected_server_and_client_session(app, raise_exceptions=True)``),
     with the public client call ``ClientSession.read_resource(uri)`` (the ``resources/read`` request).
  4. The URI: the template with the identifier exactly as the handler received it in the issue's "before" log:
     ``products://search/stick%20correcteur%20teint%C3%A9%20anti-imperfections%20rechargeable%20au%20zinc``.
  5. The handler's ``print`` is observed: the block runs in a namespace whose ``print`` records each printed line and still
     writes it to stdout; the read is bounded by 60 s.
- Reported symptom on the pre-fix code (issue): "Dynamic URL resource parameters in MCP protocol are not automatically
  URL-decoded, causing encoded characters (like %20 for spaces and %C3%A9 for accented characters) to be passed as-is to
  resource handlers instead of their decoded equivalents." with the "before" log "Found 0 products matching
  'stick%20correcteur%20teint%C3%A9%20anti-imperfections%20rechargeable%20au%20zinc'".
- Expected behaviour (issue), one check per quote:
  * handler-receives-decoded: "to be passed as-is to resource handlers instead of their decoded equivalents" and the
    "after explicit decode" log "Found 10 products matching 'stick correcteur teinté anti-imperfections rechargeable au
    zinc'" -- the handler receives (and prints) ``stick correcteur teinté anti-imperfections rechargeable au zinc``.
- Author: W9.2 (cliproxyapi/claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and
  the reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import sys
import textwrap
import traceback

WITNESS = "modelcontextprotocol__python-sdk-1864"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["mcp"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["anyio", "httpx", "httpx_sse", "pydantic", "pydantic_settings", "starlette", "sse_starlette", "python_multipart", "uvicorn", "jsonschema", "jwt", "typing_extensions", "typing_inspection"]

# The issue's "Example Code" block, verbatim (including its indentation).
ISSUE_BLOCK = '''@mcp.resource("products://search/{product_identifier}")
    def find_similar_products(product_identifier: str):
        """
        Find similar products based on a given product identifier.
        :param product_identifier: The identifier of the product (product name or code).
        :return: Similar products or an error message if none are found.
        """
        print(product_identifier)
        """
         -- walkaround: explicit decoding
        from urllib.parse import unquote
        print(unquote(product_identifier))
        """
'''

# The identifier as the handler received it in the issue's "before" log line, and its "after explicit decode" value.
ENCODED_IDENTIFIER = "stick%20correcteur%20teint%C3%A9%20anti-imperfections%20rechargeable%20au%20zinc"
EXPECTED_IDENTIFIER = "stick correcteur teinté anti-imperfections rechargeable au zinc"
URI = "products://search/" + ENCODED_IDENTIFIER


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def runnable_block():
    """Adaptation 1: the lines after the decorator dedented; nothing else changes."""
    first, rest = ISSUE_BLOCK.split("\n", 1)
    return first + "\n" + textwrap.dedent(rest)


def reproduce():
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    import builtins

    import anyio

    from mcp.server.fastmcp import FastMCP  # README.md "Resources" example (adaptation 2)
    from mcp.shared.memory import create_connected_server_and_client_session  # docs/testing.md (adaptation 3)

    mcp = FastMCP(name="Resource Example")
    printed: list[str] = []

    def recording_print(*args, **kwargs):  # adaptation 5: what the handler prints is recorded (and still printed)
        printed.append(" ".join(str(arg) for arg in args))
        builtins.print(*args, **kwargs)

    namespace = {"__name__": "issue_example", "mcp": mcp, "print": recording_print}
    exec(compile(runnable_block(), "issue_example.py", "exec"), namespace)

    async def read():
        with anyio.fail_after(60):
            async with create_connected_server_and_client_session(mcp, raise_exceptions=True) as client_session:
                return await client_session.read_resource(URI)

    result = anyio.run(read)
    return {"uri": URI, "handler_printed": printed, "contents": [getattr(item, "text", None) for item in result.contents]}


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
        received = observed["handler_printed"] if observed else None
        cases.append({
            "id": "handler-receives-decoded",
            "passed": error is None and bool(received) and all(value == EXPECTED_IDENTIFIER for value in received),
            "expected": EXPECTED_IDENTIFIER,
            "observed": observed,
            **({"error": error} if error else {}),
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
