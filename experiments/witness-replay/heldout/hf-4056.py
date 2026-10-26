#!/usr/bin/env python3
"""Held-out public check (evaluation only, never shown to a model) for the huggingface_hub tqdm_class issue.

Same public expectation as the retained reproducer, through the download boundary the issue names instead of the helper:
``hf_hub_download`` downloads a regular file with ``http_get``; here ``http_get`` reads 5 bytes from a throwaway HTTP
server on 127.0.0.1 (real httpx, no mocks), with the issue's reproduction class (a ``tqdm.auto.tqdm`` subclass that only
overrides ``update()``) as ``tqdm_class``, stderr not a TTY. Expected: no exception, the bytes are written, the custom
class's ``update()`` sees the progress advance to 5.
Exit 0 / 1 / 2 and the ``WITNESS_RESULT`` line as in the reproducer.
"""
from __future__ import annotations

import http.server
import importlib
import io
import json
import os
import sys
import threading
import traceback

WITNESS = "hf-4056-heldout"
BODY = b"hello"
CONTROLLED = ("HF_HUB_DISABLE_PROGRESS_BARS", "TQDM_DISABLE", "TQDM_POSITION", "TQDM_MININTERVAL", "HTTP_PROXY", "HTTPS_PROXY",
              "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy")
CASES = [("download-non-tty-default", {}), ("download-non-tty-tqdm-position-minus-1", {"TQDM_POSITION": "-1"})]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *args):  # silence
        pass


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def main() -> int:
    for name in CONTROLLED:
        os.environ.pop(name, None)
    os.environ["NO_PROXY"] = "127.0.0.1"
    candidate_root, dep_root = os.environ.get("WITNESS_CANDIDATE_ROOT"), os.environ.get("WITNESS_DEP_ROOT")
    import tqdm as tqdm_package
    from tqdm.auto import tqdm

    file_download = importlib.import_module("huggingface_hub.file_download")
    problems = []
    if candidate_root and not inside(file_download.__file__, candidate_root):
        problems.append("huggingface_hub.file_download was not imported from the candidate")
    if dep_root and not inside(tqdm_package.__file__, dep_root):
        problems.append("tqdm was not imported from the original environment")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/some-file"
    calls = []

    class MyProgress(tqdm):
        def update(self, n=1):
            super().update(n)
            calls.append(self.n)

    cases = []
    try:
        for case_id, env in CASES:
            for name in ("TQDM_POSITION",):
                os.environ.pop(name, None)
            os.environ.update(env)
            calls.clear()
            sink = io.BytesIO()
            observed = {"env": env}
            passed = False
            real_stderr = sys.stderr
            sys.stderr = io.StringIO()
            try:
                file_download.http_get(url, sink, tqdm_class=MyProgress)
                observed.update(written=len(sink.getvalue()), updateCalls=list(calls))
                passed = sink.getvalue() == BODY and bool(calls) and calls[-1] == len(BODY)
            except Exception as error:  # noqa: BLE001
                observed["error"] = f"{type(error).__name__}: {error}"
                observed["traceback"] = traceback.format_exc(limit=6)[-1200:]
            finally:
                sys.stderr = real_stderr
                os.environ.pop("TQDM_POSITION", None)
            cases.append({"id": case_id, "passed": passed, "observed": observed})
            print(f"[{'PASS' if passed else 'FAIL'}] {case_id}: {json.dumps(observed, default=str)}")
    finally:
        server.shutdown()
    trusted = not problems
    ok = trusted and all(case["passed"] for case in cases)
    print("WITNESS_RESULT " + json.dumps({"witness": WITNESS, "nonce": os.environ.get("WITNESS_NONCE"), "passed": ok, "trusted": trusted, "problems": problems, "cases": cases}, default=str))
    return 0 if ok else (1 if trusted else 2)


if __name__ == "__main__":
    sys.exit(main())
