#!/usr/bin/env python3
"""Public witness for schemathesis/schemathesis issue "[BUG]" -- "Tries to use invalid examples on the `requestBody` when having
`allOf` schema with a required field inside." (schemathesis__schemathesis-3334).

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's command ``schemathesis run allof.yaml --url http://localhost:8080 --mode positive`` (first code block),
  run on the issue's schema (second code block, saved verbatim as ``allof.yaml``) against the issue's application (third code
  block) listening on port 8080. Adaptations, each determined by the issue text:
  * ``uvx schemathesis`` -> the sealed environment's ``schemathesis`` console script (the candidate's CLI, same arguments).
  * The issue's Express application (Node.js is not part of the environment) runs as an equivalent Python standard-library HTTP
    server inside the witness, on the issue's ``const port = 8080`` (the sandbox's own loopback): ``POST /resource`` answers
    ``400`` with ``{"error":"name is required"}`` when the JSON body is missing or has no ``name``
    (``if (!req.body || !('name' in req.body))``), otherwise ``204`` with an empty body; other routes answer Express's
    ``404 Cannot <METHOD> <path>``. Like Node's HTTP server it answers ``400`` to a NULL byte in a header, matching the issue's
    output "Supports NULL byte in headers:    ✘". The server records every request it receives (the observation below).
- Reported symptom on the pre-fix code (issue): "Tries to use invalid examples on the `requestBody` when having `allOf` schema with
  a required field inside." and, in the issue's run output, "❌  Examples (in 0.14s)" with the failing request
  "curl -X POST -H 'Content-Type: application/json' -d '{"choice": "option2"}' http://localhost:8080/resource" -- a body built
  from the ``choice`` example (``example: option2``) without the required ``name``.
- Expected behaviour (issue), one check per quote:
  * choice-example-not-used: "I would expect it to only use the example of `#/components/schemas/resource` but instead it tried
    using the one coming from `choice`." -- no request of the run carries the body of the issue's failing request,
    ``{"choice": "option2"}``.
  * resource-example-used: "I would expect it to only use the example of `#/components/schemas/resource`" -- the run sends the
    ``resource`` example ``{"name": "example-name", "choice": "option2"}`` (``example: name: example-name, choice: option2``).
- Author: W9.12 witb-5 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import json
import os
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WITNESS = "schemathesis__schemathesis-3334"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["schemathesis"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["hypothesis", "hypothesis_jsonschema", "requests", "click", "yaml", "jsonschema"]

# The issue's schema, verbatim ("Please include a minimal API schema causing this issue:").
ALLOF_YAML = '''openapi: "3.0.3"
info:
  version: 1.0.0
  title: Resources
paths:
  /resource:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/resource"
      responses:
        "204":
          description: Done
components:
  schemas:
    resource:
      type: object
      allOf:
        - $ref: "#/components/schemas/base_resource"
      properties:
        choice:
          $ref: "#/components/schemas/choice"
      example:
        name: example-name
        choice: option2

    base_resource:
      type: object
      required:
        - name
      properties:
        name:
          type: string
          minLength: 1
      example:
        name: example-name

    choice:
      type: string
      enum:
        - option1
        - option2
        - option3
      example: option2

'''
# The issue's command: uvx schemathesis run allof.yaml --url http://localhost:8080 --mode positive
PORT = 8080
CLI_ARGS = ["run", "allof.yaml", "--url", "http://localhost:8080", "--mode", "positive"]
# The body of the issue's failing request (curl ... -d '{"choice": "option2"}') and the example of the `resource` schema.
CHOICE_EXAMPLE_BODY = {"choice": "option2"}
RESOURCE_EXAMPLE = {"name": "example-name", "choice": "option2"}

RECEIVED: list[dict] = []


class IssueApp(BaseHTTPRequestHandler):
    """The issue's Express application: app.use(express.json()); app.post('/resource', ...); app.listen(8080)."""

    def log_message(self, *args):  # quiet
        pass

    def respond(self, status, body=b"", content_type=None):
        self.send_response(status)
        if status != 204:  # Express drops the body and the content headers of a 204
            if content_type:
                self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status != 204 and body and self.command != "HEAD":
            self.wfile.write(body)

    def handle_any(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        RECEIVED.append({"method": self.command, "path": self.path, "content_type": self.headers.get("Content-Type"), "body": raw.decode("utf-8", "replace")})
        if any("\x00" in value for value in self.headers.values()):  # Node's HTTP parser rejects a NULL byte in a header
            self.respond(400, b"Bad Request", "text/plain")
            return
        path = self.path.split("?", 1)[0]
        if self.command == "POST" and path == "/resource":
            body = {}  # express.json(): req.body defaults to {} when there is nothing to parse
            content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if content_type == "application/json" and raw.strip():
                text = raw.decode("utf-8", "replace").strip()
                try:
                    if text[:1] not in ("{", "["):  # express.json() is strict: only objects and arrays
                        raise ValueError("strict")
                    body = json.loads(text)
                except ValueError:
                    self.respond(400, b"<!DOCTYPE html><html><body><pre>SyntaxError</pre></body></html>", "text/html; charset=utf-8")
                    return
            if not isinstance(body, dict) or "name" not in body:
                self.respond(400, json.dumps({"error": "name is required"}, separators=(",", ":")).encode(), "application/json; charset=utf-8")
                return
            self.respond(204)
            return
        page = f"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot {self.command} {path}</pre>\n</body>\n</html>\n"
        self.respond(404, page.encode(), "text/html; charset=utf-8")

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = do_TRACE = handle_any


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # Bind without HTTPServer's reverse name lookup (no resolver in the sandbox).
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", self.server_address[1]


class DualStackServer(LocalServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def start_app():
    """app.listen(8080): both loopback families when available (like Node), else IPv4."""
    try:
        server = DualStackServer(("::", PORT), IssueApp)
    except OSError:
        server = LocalServer(("127.0.0.1", PORT), IssueApp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def app_reachable():
    """Environment self-check: the witness's own HTTP client reaches the application at the issue's URL."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(f"http://localhost:{PORT}/", timeout=20)
    except urllib.error.HTTPError as exc:
        return exc.code == 404
    except Exception:  # noqa: BLE001
        return False
    return False


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def json_bodies():
    bodies = []
    for request in RECEIVED:
        if request["method"] == "POST" and request["path"].split("?", 1)[0] == "/resource":
            try:
                bodies.append(json.loads(request["body"]))
            except ValueError:
                continue
    return bodies


def reproduce(server):
    """The issue's reproduction, verbatim. Returns the observed values the checks need."""
    work = tempfile.mkdtemp(prefix="schemathesis-3334-")
    with open(os.path.join(work, "allof.yaml"), "w") as handle:
        handle.write(ALLOF_YAML)
    cli = os.path.join(os.path.dirname(sys.executable), "schemathesis")
    probe = subprocess.run([sys.executable, "-c", "import schemathesis; print(schemathesis.__file__)"], cwd=work, capture_output=True, text=True, timeout=30, env=os.environ.copy())
    proc = subprocess.run([sys.executable, cli, *CLI_ARGS], cwd=work, capture_output=True, text=True, timeout=140, env=os.environ.copy())
    bodies = json_bodies()
    return {
        "choice_example_body_sent": sum(1 for body in bodies if body == CHOICE_EXAMPLE_BODY),
        "resource_example_sent": sum(1 for body in bodies if body == RESOURCE_EXAMPLE),
        "requests_received": len(RECEIVED),
        "cli_exit": proc.returncode,
        "cli_output_tail": proc.stdout[-2500:],
        "cli_stderr_tail": proc.stderr[-1000:],
        "subprocess_schemathesis": probe.stdout.strip() or probe.stderr[-500:],
    }


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
    cli = os.path.join(os.path.dirname(sys.executable), "schemathesis")
    if not problems and not os.path.exists(cli):
        problems.append(f"the environment has no schemathesis console script at {cli}")
    server = None
    if not problems and not cases:
        try:
            server = start_app()
        except Exception as exc:  # noqa: BLE001  (the issue's application could not listen on port 8080: environment)
            problems.append(f"the issue's application could not listen on port {PORT}: {type(exc).__name__}: {exc}")
        if server is not None and not app_reachable():
            problems.append(f"the issue's application is not reachable at http://localhost:{PORT}/ inside the sandbox")
        RECEIVED.clear()  # the self-check request is not part of the reproduction
    if not problems and not cases:
        observed, error = None, None
        try:
            observed = reproduce(server)
        except Exception as exc:  # noqa: BLE001
            error = error_text(exc)
        if observed is not None:
            fidelity["subprocess schemathesis"] = observed["subprocess_schemathesis"]
            if root is not None and not inside(observed["subprocess_schemathesis"], root):
                problems.append(f"the CLI's interpreter did not import schemathesis from the candidate ({observed['subprocess_schemathesis']})")
        if not problems:
            cases.append({"id": "choice-example-not-used",
                          "passed": error is None and observed["choice_example_body_sent"] == 0,
                          "expected": {"requests with body " + json.dumps(CHOICE_EXAMPLE_BODY): 0}, "observed": observed, **({"error": error} if error else {})})
            cases.append({"id": "resource-example-used",
                          "passed": error is None and observed["resource_example_sent"] >= 1,
                          "expected": {"requests with body " + json.dumps(RESOURCE_EXAMPLE): ">= 1"},
                          "observed": {k: observed[k] for k in ("resource_example_sent", "choice_example_body_sent", "requests_received", "cli_exit")} if observed else None,
                          **({"error": error} if error else {})})
    if server is not None:
        server.shutdown()
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
