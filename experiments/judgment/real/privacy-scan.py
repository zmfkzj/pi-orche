#!/usr/bin/env python3
"""Scan the staged diff for real-session material before a commit (docs/orchestrator.md 10).

Usage: python3 experiments/judgment/real/privacy-scan.py [--candidates results/judgment-real/candidates.jsonl]
         [--projects results/judgment-real/projects.json] [--repo .]
Checks every added line of `git diff --cached` for: other-machine home paths, project directory names of the recorded
sessions (read from the gitignored projects.json, so this script names none), and any 24-character run of a recorded request
text (whitespace-normalized). Prints counts and the offending file:line positions only; exit 1 when anything matched.
"""
import argparse
import json
import re
import subprocess
import sys

GENERIC = {"code", "users", "vision", "downloads", "documents", "private", "volumes", "data", "arthur", "main", "scripts", "models",
           "record", "test", "tests", "datasets", "abs", "ssh", "tmp", "omp", "pi", "orche", "advisor", "plugins", "oh-my-omp-plugins",
           "model", "candidates", "router"}  # common words that also occur in directory names
OTHER_HOME = re.compile("/" + "Users/(?!arthur/)|/" + "Volumes/")  # built from pieces so this file does not match itself
WINDOW = 24


def norm(text):
    return re.sub(r"\s+", " ", text).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", default="results/judgment-real/candidates.jsonl")
    parser.add_argument("--projects", default="results/judgment-real/projects.json")
    parser.add_argument("--repo", default=".")
    args = parser.parse_args()
    projects = json.load(open(args.projects, encoding="utf-8"))
    names = set()
    for key in projects:
        for token in re.split(r"[-/_ .]+", key.split("/", 1)[1]):
            if len(token) >= 4 and token.lower() not in GENERIC and not token.isdigit():
                names.add(token.lower())
    windows = set()
    for line in open(args.candidates, encoding="utf-8"):
        text = norm(json.loads(line)["text"])
        for start in range(0, max(0, len(text) - WINDOW) + 1, 4):
            chunk = text[start:start + WINDOW]
            if len(chunk) == WINDOW and len(set(chunk)) > 8:
                windows.add(chunk)
    diff = subprocess.run(["git", "-C", args.repo, "diff", "--cached", "-U0", "--no-color"], capture_output=True, text=True, check=True).stdout
    hits = {"home-path": [], "project-name": [], "request-text": []}
    file, line_no = "?", 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            file = raw[6:] if raw.startswith("+++ b/") else raw[4:]
            continue
        match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", raw)
        if match:
            line_no = int(match.group(1)) - 1
            continue
        if not raw.startswith("+") or raw.startswith("+++"):
            continue
        line_no += 1
        added = raw[1:]
        where = f"{file}:{line_no}"
        if OTHER_HOME.search(added):
            hits["home-path"].append(where)
        lowered = added.lower()
        found = [name for name in names if re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", lowered)]
        if found:
            hits["project-name"].append(f"{where} ({len(found)} token(s))")
        text = norm(added)
        if any(text[i:i + WINDOW] in windows for i in range(0, max(0, len(text) - WINDOW) + 1)):
            hits["request-text"].append(where)
    print(json.dumps({"projectTokens": len(names), "requestWindows": len(windows), "addedLinesScanned": sum(1 for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")),
                      "hits": {k: len(v) for k, v in hits.items()}, "positions": {k: v[:40] for k, v in hits.items() if v}}, indent=1))
    sys.exit(1 if any(hits.values()) else 0)


if __name__ == "__main__":
    main()
