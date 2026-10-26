#!/usr/bin/env python3
"""Public witness for basicmachines-co/basic-memory issue (basicmachines-co__basic-memory-484):
"RelationResponse validation fails when from_entity.permalink is null"

Provenance (eligibility E2, E3, E6 of experiments/headroom-pool/protocol.ts):
- Reproduction: the issue's "Reproduction" steps, through the same public API boundary (the v2 HTTP API):
  "1. Import notes from a local environment where permalinks were not enabled"
  "2. Create a relation between an entity with a permalink and one without"
  "3. Try to view the entity with the relation via `/v2/projects/{id}/knowledge/entities/{id}`"
  "4. 500 error occurs"
  Adaptations (the issue gives the steps as prose; each completion and the text that determines it):
  1. Offline API: the issue's cloud deployment ("Internal proxy error", "From production Logfire trace") is replaced by the
     local API app ``basic_memory.api.app:app``, started with its own lifespan (as an ASGI server starts it) and called
     in-process through httpx's ``ASGITransport``, as the project's local client does in its default local mode
     (src/basic_memory/mcp/async_client.py:47-48: "Use ASGI transport for in-process requests to local FastAPI app."). The
     proxy's "500: Internal proxy error" response is the app's own 500 response carrying the same validation error as its
     detail (src/basic_memory/api/app.py:120-131 exception handler: ``HTTPException(status_code=500, detail=str(exc))``).
  2. Step 1: "permalinks were not enabled" is the documented setting ``disable_permalinks`` (src/basic_memory/config.py:158-161:
     "Disable automatic permalink generation in frontmatter. When enabled, new notes won't have permalinks added and sync won't update permalinks."),
     set through its environment variable BASIC_MEMORY_DISABLE_PERMALINKS (env_prefix
     "BASIC_MEMORY_", config.py:298-299). The notes are Markdown files in the default project directory ``~/basic-memory``
     (README.md:167, config.py:73) imported with the API's sync endpoint ``POST /{project}/project/sync`` with
     ``run_in_background=false`` ("Scans the project directory and updates the database with any new or modified files.",
     src/basic_memory/api/routers/project_router.py:124-167).
  3. Step 2: the two notes follow the README's file format (frontmatter "title"/"type"/"permalink: <a uri slug>",
     README.md:220-228; relation line "- relation_type [[WikiLink]] (optional context)", README.md:255-263) and its example
     (README.md:141-163): "Coffee Bean Origins" has a permalink in its frontmatter (the entity with a permalink);
     "Coffee Brewing Methods" has none and carries the relation "- relates_to [[Coffee Bean Origins]]", so the relation goes
     FROM the entity without a permalink, as in the issue (error path "relations.0.from_entity.permalink"; evidence:
     "relation id 205 references entity 42 which has `permalink: null`"). The relation is part of the imported note instead
     of a separate edit; the resulting state (two entities, one relation from the one without a permalink) is the one the
     issue describes.
  4. Step 3: the project id and the entity ids come from the v2 resolve endpoints (``POST /v2/projects/resolve``,
     ``POST /v2/projects/{id}/knowledge/resolve``); then ``GET /v2/projects/{id}/knowledge/entities/{id}`` as in the issue,
     for both entities that have the relation (the issue's evidence views the entity with a permalink:
     "Viewing entity 346 fails because relation id 205 references entity 42").
  5. Run settings only: telemetry off (BASIC_MEMORY_TELEMETRY_ENABLED=false, config.py:225-228; the sandbox has no network)
     and real-time sync off (BASIC_MEMORY_SYNC_CHANGES=false, config.py:136-139; the import is the explicit sync call);
     config, database and project live under the run's fresh $HOME.
- Reported symptom on the pre-fix code (issue): "When viewing entities that have relations to entities with null permalinks, the API returns a 500 error:"
  "500: Internal proxy error: 1 validation error for EntityResponseV2" / "relations.0.from_entity.permalink" /
  "Input should be a valid string [type=string_type, input_value=None, input_type=NoneType]"
- Expected behaviour (issue), one check per quote:
  * view: "RelationResponse validation fails when from_entity.permalink is null" and
    "When viewing entities that have relations to entities with null permalinks, the API returns a 500 error"
    -- viewing each entity with the relation succeeds (HTTP 200 with that entity and the relation listed) while the imported
    note keeps its null permalink ("When `from_entity.permalink` is `None` (which is valid for imported notes without permalinks enabled)").
  * from-id: "1. Make `from_id` optional: `from_id: Optional[Permalink] = Field(...)`" or "2. Or add proper fallback handling when `from_entity.permalink` is None (use entity title or file_path as fallback)"
    -- the relation's ``from_id`` is null, or the title or the file_path of the note without a permalink.
- Author: W9.14 witb-7 (claude-opus-5-5); written from the issue text and the pre-fix snapshot only. The hidden tests and the
  reference fix were not read.
Exit 0: every check passes. Exit 1: a check fails (an exception raised by the candidate's code is a failure). Exit 2: the run
cannot be trusted (a third-party dependency is missing, or the package was not imported from the candidate). The last line is
``WITNESS_RESULT <json>``.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

WITNESS = "basicmachines-co__basic-memory-484"
# Top-level modules of the project under test: they must be imported from the candidate tree.
CANDIDATE_MODULES = ["basic_memory"]
# Third-party modules the reproduction needs from the sealed environment (missing = untrusted run, never pass/fail).
DEPENDENCIES: list[str] = ["httpx", "fastapi"]

WITH_PERMALINK = "Coffee Bean Origins"
WITHOUT_PERMALINK = "Coffee Brewing Methods"
NOTES = {
    # The entity with a permalink (README.md:141-148, 220-228).
    f"{WITH_PERMALINK}.md": "---\ntitle: Coffee Bean Origins\ntype: note\npermalink: coffee-bean-origins\n---\n\n# Coffee Bean Origins\n",
    # The imported note without a permalink, with the relation (README.md:158-160, 255-263).
    f"{WITHOUT_PERMALINK}.md": "---\ntitle: Coffee Brewing Methods\ntype: note\n---\n\n# Coffee Brewing Methods\n\n## Relations\n\n- relates_to [[Coffee Bean Origins]]\n",
}
RELATION_TYPE = "relates_to"
# The issue's two proposals for from_id when from_entity.permalink is None: None ("Make `from_id` optional"), or the
# entity's title or file_path ("use entity title or file_path as fallback").
ALLOWED_FROM_ID = [None, WITHOUT_PERMALINK, f"{WITHOUT_PERMALINK}.md"]


def inside(path, root):
    if not path or not root:
        return False
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def error_text(exc):
    return f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)[-1500:]}"


def body(response):
    try:
        return response.json()
    except Exception:  # noqa: BLE001
        return response.text[:1500]


def expect(response, what):
    if response.status_code != 200:
        raise RuntimeError(f"{what} returned HTTP {response.status_code}: {str(body(response))[:800]}")
    return response.json()


async def session(app, httpx):
    """Steps 1-3 against the running API; returns what the checks need."""
    observed = {}
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://basic-memory.local", timeout=120) as client:
            # Step 1 (and 2): import the notes of the project directory.
            sync = expect(await client.post("/main/project/sync", params={"run_in_background": "false"}), "project sync")
            observed["sync"] = {key: sync.get(key) for key in ("new", "modified", "deleted")} if isinstance(sync, dict) else sync
            project_id = expect(await client.post("/v2/projects/resolve", json={"identifier": "main"}), "project resolve")["project_id"]
            # Step 3: view each entity that has the relation.
            for title in (WITH_PERMALINK, WITHOUT_PERMALINK):
                entity = expect(await client.post(f"/v2/projects/{project_id}/knowledge/resolve", json={"identifier": title}), f"resolve {title!r}")
                view = await client.get(f"/v2/projects/{project_id}/knowledge/entities/{entity['entity_id']}")
                data = body(view)
                record = {"entity_id": entity["entity_id"], "permalink": entity.get("permalink"), "file_path": entity.get("file_path"), "status": view.status_code}
                if view.status_code == 200 and isinstance(data, dict):
                    record["id"] = data.get("id")
                    record["relations"] = [{key: relation.get(key) for key in ("relation_type", "from_id", "to_id", "to_name")} for relation in data.get("relations") or []]
                else:
                    record["body"] = data
                observed[title] = record
    return observed


def reproduce():
    """The issue's reproduction (steps 1-3 with the adaptations above). Returns the observed values the checks need."""
    os.environ["BASIC_MEMORY_DISABLE_PERMALINKS"] = "true"
    os.environ["BASIC_MEMORY_TELEMETRY_ENABLED"] = "false"
    os.environ["BASIC_MEMORY_SYNC_CHANGES"] = "false"
    project_dir = Path(os.environ["HOME"]) / "basic-memory"
    project_dir.mkdir(parents=True, exist_ok=True)
    for name, text in NOTES.items():
        (project_dir / name).write_text(text, encoding="utf-8")
    import httpx

    from basic_memory.api.app import app

    return asyncio.run(session(app, httpx))


def relation_of(record):
    """The relates_to relation listed in a successful view (or None)."""
    for relation in record.get("relations") or []:
        if relation.get("relation_type") == RELATION_TYPE:
            return relation
    return None


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
            for case_id in ("view", "from-id"):
                cases.append({"id": case_id, "passed": False, "error": error})
        else:
            views = {title: observed[title] for title in (WITH_PERMALINK, WITHOUT_PERMALINK)}
            scenario = views[WITH_PERMALINK]["permalink"] == "coffee-bean-origins" and views[WITHOUT_PERMALINK]["permalink"] is None
            view_ok = scenario and all(record["status"] == 200 and record.get("id") == record["entity_id"] and relation_of(record) is not None for record in views.values())
            cases.append({
                "id": "view",
                "passed": view_ok,
                "expected": {title: {"status": 200, "relation": RELATION_TYPE} for title in views} | {"permalinks": {WITH_PERMALINK: "coffee-bean-origins", WITHOUT_PERMALINK: None}},
                "observed": {"sync": observed.get("sync"), **views},
            })
            from_ids = {title: (relation_of(record) or {}).get("from_id", "<no relation listed>") for title, record in views.items()}
            cases.append({
                "id": "from-id",
                "passed": all(record["status"] == 200 and relation_of(record) is not None and from_ids[title] in ALLOWED_FROM_ID for title, record in views.items()),
                "expected": {"from_id one of": ALLOWED_FROM_ID},
                "observed": {title: (from_ids[title] if record["status"] == 200 else f"HTTP {record['status']}") for title, record in views.items()},
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
