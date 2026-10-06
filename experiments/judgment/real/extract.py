#!/usr/bin/env python3
"""Real-session split-judgment items (docs/orchestrator.md 10): extract, filter, label and sample user requests.

Usage: python3 experiments/judgment/real/extract.py [--sessions results/sessions] [--out results/judgment-real] [--seed 20261006]

Input: recorded main sessions (results/sessions/{omp,pi}/<project>/<session>.jsonl; gitignored). Output (gitignored, contains
request text): <out>/candidates.jsonl (every user request with its record evidence and filter verdict), <out>/dataset.json
(the sample with labels), <out>/projects.json (project -> anonymous id). Prints only counts, so its output may be committed.

Everything here is deterministic. Labels follow the v2 criteria (docs/orchestrator.md 8.2) and use only what the session
recorded AFTER the request (the work that was actually done); the judgment input (request + context before it) never sees it.
"""
import argparse
import collections
import datetime as dt
import json
import os
import random
import re
import sys

TOOLS_EDIT = {"edit", "write", "ast_rewrite", "ast_edit", "apply_patch", "notebook_edit"}
TOOLS_READ = {"read", "grep", "glob", "find", "ls", "analyze_files"}
TOOLS_GUI = {"computer", "screenshot"}  # omp `launch` supervises processes; it is not GUI
TOOLS_MEDIA = {"generate_image", "generate_video", "edit_image"}
SUBAGENT_TOOLS = {"task", "orche_task", "orche_run"}
IDLE_CAP_S = 300          # a gap longer than this inside a segment counts as 5 minutes of work (the rest is idle)
PART_MIN_S = 600          # v2: a parallel part takes one worker roughly ten minutes or more
SMALL_TOTAL_S = 600       # a request finished in less active time than one part cannot hold two parts

NON_REQUEST = [
    (re.compile(r"^\s*(### Session update|\[pi-orche|Assignment:|<system|<task-notification|\[System|Propose conventional)", re.I), "generated"),
]
DEICTIC = re.compile(r"(이거|그거|저거|이것|그것|위에|위의|아까|방금|계속|다시|재시도|이어서|진행|마저|그대로|ㅇㅇ|응|좋아|\bthis\b|\bthat\b|\bagain\b|\bcontinue\b|\bretry\b|\bresume\b|\bgo on\b|\bok\b)", re.I)
EXPLICIT_REVIEW = re.compile(r"((독립적?인?|제3자|교차|다른\s*(에이전트|사람|모델|워커|리뷰어)(가|에게|로)?)\s*(검증|검토|리뷰)|independent(ly)?\s+(review|verif)|second opinion|cross-?check|peer review)", re.I)
RISK = re.compile(r"(보안|인증|권한|비밀번호|토큰|결제|과금|송금|운영\s*(서버|db|데이터)|프로덕션|마이그레이션|데이터\s*(이전|삭제)|삭제|배포|security|auth|password|credential|secret|payment|billing|money|production|prod\b|migrat|deploy|drop\s+table|rm\s+-rf|delete)", re.I)
PROBLEM = re.compile(r"(안\s*(돼|됨|되|된다)|에러|오류|버그|틀렸|잘못|깨졌|실패|되돌|롤백|revert|rollback|broken|broke|doesn'?t work|not working|wrong|error|fail|bug|crash)", re.I)
SHARED_NAME = re.compile(r"(^|/)(package\.json|package-lock\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.(py|cfg)|tsconfig[^/]*\.json|Cargo\.toml|go\.mod|Makefile|CMakeLists\.txt|README[^/]*|CHANGELOG[^/]*|index\.[a-z]+|__init__\.py|types?\.[a-z]+|schema[^/]*|config[^/]*|settings[^/]*|constants?\.[a-z]+|init\.[a-z]+\.?[a-z]*)$", re.I)
SOURCE_ROOTS = {"src", "lib", "libs", "packages", "apps", "app", "client", "server", "shared", "modules", "components", "services", "scripts", "tools", "configs", "plugins", "extensions", "World", "Shared", "Client", "Server"}
TEST_DOC = re.compile(r"(^|/)(tests?|__tests__|spec|specs|docs?|examples?)(/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|^test_", re.I)


def parse_ts(value):
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
    if isinstance(value, str):
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text", "") for part in content or [] if isinstance(part, dict) and part.get("type") == "text")


def edited_paths(name, args):
    """Paths an edit/write call changed (omp patch headers `[path#…]`, pi `path`)."""
    if not isinstance(args, dict):
        return []
    paths = []
    if isinstance(args.get("path"), str):
        paths.append(args["path"])
    patch = args.get("input")
    if isinstance(patch, str):
        paths += re.findall(r"^\[([^\]#\n]+)#", patch, re.M)
        paths += re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", patch, re.M)
    return [p.strip() for p in paths if p.strip()]


def read_paths(args):
    if not isinstance(args, dict):
        return []
    found = []
    for key in ("path", "file", "paths", "files"):
        value = args.get(key)
        if isinstance(value, str):
            found.append(value)
        elif isinstance(value, list):
            found += [v for v in value if isinstance(v, str)]
    return found


def relative(path, cwd):
    path = re.sub(r"[#:].*$", "", path)
    if cwd and path.startswith(cwd.rstrip("/") + "/"):
        return path[len(cwd.rstrip("/")) + 1:]
    return path


def cluster_of(rel):
    """The module a file belongs to: first directory, or the first two under a common source root."""
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or rel.startswith("/") or rel.startswith(".."):
        return "(outside)"
    if len(parts) == 1:
        return "(root)"
    if parts[0] in SOURCE_ROOTS and len(parts) > 2:
        return "/".join(parts[:2])
    return parts[0]


def load_entries(path):
    entries = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def session_requests(path, fmt, project):
    entries = load_entries(path)
    cwd = next((e.get("cwd") for e in entries if e.get("type") == "session" and e.get("cwd")), "")
    events = []  # (ts, kind, payload)
    for entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        ts = parse_ts(entry.get("timestamp")) or parse_ts(message.get("timestamp"))
        role = message.get("role")
        if role == "user":
            events.append((ts, "user", {"text": text_of(message.get("content")), "synthetic": bool(message.get("synthetic"))}))
        elif role == "assistant":
            calls = [part for part in message.get("content") or [] if isinstance(part, dict) and part.get("type") == "toolCall"]
            events.append((ts, "assistant", {"calls": calls}))
        elif role == "toolResult":
            events.append((ts, "result", {}))
    user_index = [i for i, event in enumerate(events) if event[1] == "user"]
    requests = []
    prior_requests = []
    prior_files = []
    for position, start in enumerate(user_index):
        end = user_index[position + 1] if position + 1 < len(user_index) else len(events)
        ts0, _, user = events[start]
        segment = events[start:end]
        later_users = [events[i][2]["text"] for i in user_index[position + 1:position + 3] if not events[i][2]["synthetic"]]
        # work evidence
        tool_counts = collections.Counter()
        edits = []        # (ts, rel path)
        touches = []      # (ts, rel path) reads + edits
        bash_cmds = []
        subagent_tasks = 0
        active = 0.0
        cluster_time = collections.Counter()
        last_ts = ts0
        for ts, kind, payload in segment[1:]:
            gap = (ts - last_ts).total_seconds() if ts and last_ts else 0
            gap = max(0.0, min(gap, IDLE_CAP_S))
            active += gap
            if kind == "assistant":
                for call in payload["calls"]:
                    name = call.get("name", "")
                    args = call.get("arguments") or {}
                    tool_counts[name] += 1
                    files = []
                    if name in TOOLS_EDIT:
                        for p in edited_paths(name, args):
                            rel = relative(p, cwd)
                            edits.append((ts, rel))
                            files.append(rel)
                    elif name in TOOLS_READ:
                        files += [relative(p, cwd) for p in read_paths(args)]
                    elif name == "bash" and isinstance(args, dict):
                        bash_cmds.append(str(args.get("command", ""))[:300])
                    if name == "task" and isinstance(args, dict) and isinstance(args.get("tasks"), list):
                        subagent_tasks += len(args["tasks"])
                    elif name in ("orche_task", "orche_run"):
                        subagent_tasks += 1
                    for rel in files:
                        touches.append((ts, rel))
                    if files:
                        share = gap / len(files) if files else 0
                        for rel in files:
                            cluster_time[cluster_of(rel)] += share
            if ts:
                last_ts = ts
        wall = (segment[-1][0] - ts0).total_seconds() if segment[-1][0] and ts0 else 0
        edited = sorted({rel for _, rel in edits})
        clusters = collections.Counter(cluster_of(rel) for _, rel in edits if not TEST_DOC.search(rel))
        requests.append({
            "session": os.path.basename(path), "format": fmt, "project": project, "cwd": cwd,
            "timestamp": ts0.isoformat() if ts0 else None, "index": position,
            "text": user["text"], "synthetic": user["synthetic"],
            "context": {"priorRequests": prior_requests[-2:], "priorFiles": prior_files[-12:]},
            "evidence": {
                "wallS": round(wall), "activeS": round(active), "toolCalls": sum(tool_counts.values()),
                "tools": dict(tool_counts.most_common(12)), "editCalls": len(edits), "editedFiles": edited[:60],
                "editedFileCount": len(edited), "clusters": dict(clusters), "clusterActiveS": {k: round(v) for k, v in cluster_time.items()},
                "editSwitches": sum(1 for a, b in zip(edits, edits[1:]) if cluster_of(a[1]) != cluster_of(b[1])),
                "subagentTasks": subagent_tasks, "worktree": any("git worktree add" in c for c in bash_cmds),
                "gui": sum(tool_counts[t] for t in TOOLS_GUI), "media": sum(tool_counts[t] for t in TOOLS_MEDIA),
                "laterProblem": any(PROBLEM.search(t or "") for t in later_users),
            },
        })
        if not user["synthetic"]:
            prior_requests.append(user["text"][:400])
        prior_files += [rel for rel in edited if rel not in prior_files]
    return requests


def clean(text):
    text = re.sub(r"<attachment>[\s\S]*?</attachment>", " ", text)
    text = re.sub(r"\[Image #\d+[^\]]*\]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def filter_reason(request, seen):
    text = request["text"] or ""
    stripped = clean(text)
    if request["synthetic"]:
        return "generated"
    for pattern, reason in NON_REQUEST:
        if pattern.search(text):
            return reason
    if len(stripped) < 15:
        return "trivial"
    if re.fullmatch(r"['\"]?([/~@.][^\s]*|https?://\S+)['\"]?", stripped):
        return "context-dependent"  # a bare path or URL answers an earlier question
    ev = request["evidence"]
    if ev["toolCalls"] < 3 or ev["activeS"] < 60:
        return "trivial"
    if re.match(r"^\s*(Traceback|Error|[A-Za-z]+Error:|at\s+\S+\s+\()", stripped) or (len(stripped) < 60 and DEICTIC.search(stripped)):
        return "context-dependent"
    key = re.sub(r"[^0-9a-z가-힣]+", "", stripped.lower())[:120]
    if key in seen:
        return "duplicate"
    seen.add(key)
    return None


def label(request):
    """v2 label from the recorded work, with the evidence it rests on."""
    text = clean(request["text"])
    ev = request["evidence"]
    edits = ev["editedFiles"]
    explicit = bool(EXPLICIT_REVIEW.search(text))
    risky = bool(RISK.search(text)) or any(RISK.search(f) for f in edits)
    qualifying = sorted(c for c, s in ev["clusterActiveS"].items() if s >= PART_MIN_S and ev["clusters"].get(c, 0) >= 2 and c not in ("(root)", "(outside)"))
    near = sorted(c for c, s in ev["clusterActiveS"].items() if PART_MIN_S / 2 <= s < PART_MIN_S and ev["clusters"].get(c, 0) >= 2 and c not in ("(root)", "(outside)"))
    shared_edits = [f for f in edits if SHARED_NAME.search(f)]
    labels, reasons = [], []
    # Parallelism: two or more modules, each with ten minutes or more of attributed work, little shared editing, few switches.
    if len(qualifying) >= 2:
        coupled = len(shared_edits) > 2 or ev["editSwitches"] > 3 * len(qualifying)
        if coupled:
            return "uncertain", [], f"{len(qualifying)} modules with >=10 min each ({', '.join(qualifying)}) but coupling signals: {len(shared_edits)} shared-file edits, {ev['editSwitches']} module switches"
        labels.append("parallelism")
        reasons.append(f"{len(qualifying)} modules with >=10 min of attributed work each ({', '.join(f'{c} {ev['clusterActiveS'][c]}s' for c in qualifying)}), {len(shared_edits)} shared-file edits, {ev['editSwitches']} module switches")
    elif len(qualifying) + len(near) >= 2 and ev["activeS"] >= 2 * PART_MIN_S:
        return "uncertain", [], f"parts near the ten-minute line: >=10 min {qualifying}, 5-10 min {near}; active {ev['activeS']}s"
    # Isolation: a part needed another environment or tool set (a separate checkout, image/video production).
    if (ev["worktree"] or ev["media"]) and ev["editCalls"]:
        labels.append("isolation")
        reasons.append(f"separate checkout={ev['worktree']}, media calls={ev['media']} next to {ev['editCalls']} code edits")
    elif ev["media"] and not ev["editCalls"]:
        return "uncertain", [], f"only media work ({ev['media']} calls), no code edits: a specialist route, not a split"
    elif ev["gui"]:
        return "uncertain", [], f"GUI work ({ev['gui']} computer-use calls): main's gui worker option, which the v2 criteria do not cover"
    # Independent verification: an explicit request, or a risky change whose problems surfaced later.
    if explicit:
        labels.append("verification")
        reasons.append("the request explicitly asks for an independent review or check")
    elif risky and ev["laterProblem"] and ev["editCalls"]:
        labels.append("verification")
        reasons.append("risky change (security/data/deploy/money wording) and the next user messages report a problem")
    if labels:
        units = [[c] for c in qualifying] if "parallelism" in labels else None
        return "+".join(labels), units, "; ".join(reasons)
    why = []
    if ev["activeS"] < SMALL_TOTAL_S:
        why.append(f"small: {ev['activeS']}s active")
    if len(qualifying) <= 1:
        why.append(f"at most one module with >=10 min ({qualifying or 'none'})")
    if risky and not ev["laterProblem"]:
        why.append("risky wording but no problem surfaced")
    if ev["laterProblem"] and not risky:
        why.append("a later problem, but an ordinary change (the orchestrator's own checks apply)")
    return "none", None, "; ".join(why) or "no criterion held in the record"


def none_type(request):
    """Kinds of 'none' for an even sample: small, one module, several modules (coupled or each under ten minutes)."""
    ev = request["evidence"]
    if ev["activeS"] < SMALL_TOTAL_S:
        return "small"
    modules = [c for c, n in ev["clusters"].items() if n >= 2 and c not in ("(root)", "(outside)")]
    return "several-modules" if len(modules) >= 2 else "one-module"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions", default="results/sessions")
    parser.add_argument("--out", default="results/judgment-real")
    parser.add_argument("--seed", type=int, default=20261006)
    parser.add_argument("--target", type=int, default=90)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    projects = sorted({f"{fmt}/{name}" for fmt in ("omp", "pi") if os.path.isdir(os.path.join(args.sessions, fmt)) for name in os.listdir(os.path.join(args.sessions, fmt))})
    anon = {name: f"P{index + 1:02d}" for index, name in enumerate(projects)}
    all_requests = []
    for name in projects:
        fmt, project = name.split("/", 1)
        directory = os.path.join(args.sessions, fmt, project)
        for file in sorted(os.listdir(directory)):
            if file.endswith(".jsonl"):
                all_requests += session_requests(os.path.join(directory, file), fmt, anon[name])
    all_requests.sort(key=lambda r: (r["timestamp"] or "", r["project"], r["session"], r["index"]))
    seen = set()
    stats = collections.Counter()
    pool = []
    with open(os.path.join(args.out, "candidates.jsonl"), "w", encoding="utf-8") as out:
        for number, request in enumerate(all_requests):
            request["id"] = f"r{number:04d}"
            reason = filter_reason(request, seen)
            request["filtered"] = reason
            stats[reason or "eligible"] += 1
            if not reason:
                request["label"], request["units"], request["labelEvidence"] = label(request)
                pool.append(request)
            out.write(json.dumps(request, ensure_ascii=False) + "\n")
    # Sample: every non-none certain label (up to 20 per label), up to 15 uncertain, then none spread over projects and time.
    rng = random.Random(args.seed)
    by_label = collections.defaultdict(list)
    for request in pool:
        by_label[request["label"]].append(request)
    chosen = []
    for name in sorted(by_label):
        if name in ("none", "uncertain"):
            continue
        group = by_label[name][:]
        rng.shuffle(group)
        chosen += group[:20]
    uncertain = by_label["uncertain"][:]
    rng.shuffle(uncertain)
    chosen += uncertain[:15]
    remaining = max(0, args.target - len(chosen))
    kinds = ["several-modules", "one-module", "small"]
    for request in by_label["none"]:
        request["noneType"] = none_type(request)
    for position, kind in enumerate(kinds):
        quota = remaining // len(kinds) + (1 if position < remaining % len(kinds) else 0)
        per_project = collections.defaultdict(list)
        for request in by_label["none"]:
            if request["noneType"] == kind:
                per_project[request["project"]].append(request)
        for group in per_project.values():
            rng.shuffle(group)  # within a project: random over time
        order = sorted(per_project, key=lambda p: (-len(per_project[p]), p))
        picked = []
        while len(picked) < quota and any(per_project[p] for p in order):
            for project in order:  # round-robin over projects
                if per_project[project] and len(picked) < quota:
                    picked.append(per_project[project].pop())
        chosen += picked
    chosen.sort(key=lambda r: r["id"])
    dataset = [{"id": r["id"], "project": r["project"], "timestamp": r["timestamp"], "label": r["label"], "noneType": r.get("noneType"), "units": r["units"],
                "labelEvidence": r["labelEvidence"], "evidence": r["evidence"], "text": r["text"], "context": r["context"]} for r in chosen]
    with open(os.path.join(args.out, "dataset.json"), "w", encoding="utf-8") as out:
        json.dump({"seed": args.seed, "target": args.target, "items": dataset}, out, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "projects.json"), "w", encoding="utf-8") as out:
        json.dump(anon, out, ensure_ascii=False, indent=1)
    pool_labels = collections.Counter(r["label"] for r in pool)
    sample_labels = collections.Counter(r["label"] for r in chosen)
    months = collections.Counter((r["timestamp"] or "?")[:7] for r in chosen)
    # Sensitivity (not a label): pooled requests with two or more modules of >=5 min attributed work each.
    five = sum(1 for r in pool if sum(1 for c, s in r["evidence"]["clusterActiveS"].items() if s >= PART_MIN_S / 2 and r["evidence"]["clusters"].get(c, 0) >= 2 and c not in ("(root)", "(outside)")) >= 2)
    summary = {"sessionsProjects": len(projects), "requests": len(all_requests), "filter": dict(stats), "poolLabels": dict(pool_labels),
               "poolNoneTypes": dict(collections.Counter(none_type(r) for r in by_label["none"])), "poolTwoModulesOf5min": five,
               "sampleNoneTypes": dict(collections.Counter(r.get("noneType") for r in chosen if r["label"] == "none")),
               "sample": len(chosen), "sampleLabels": dict(sample_labels), "sampleProjects": len({r["project"] for r in chosen}),
               "sampleMonths": dict(sorted(months.items())), "uncertainShare": round(sample_labels.get("uncertain", 0) / max(1, len(chosen)), 3)}
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as out:
        json.dump(summary, out, indent=1)
    json.dump(summary, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
