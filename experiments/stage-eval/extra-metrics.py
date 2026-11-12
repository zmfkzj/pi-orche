"""
Model-free per-arm behaviour metrics of a stage-evaluation study (experiments/stage-eval), from the preserved transcripts of the
primary runs (runs/<task>/<arm>/r<n>; kept infra/interrupted attempts are excluded):
- regression_check calls and their verdicts (change #5);
- Bash safety review refusals / no-verdicts seen by the agents (the Jev classifier calls themselves bypass the logging proxy, so
  their usage and cost are NOT in the wire accounting);
- task_plan nodes and how many carry a note naming acceptance criteria or an ambiguity (change #7 compliance);
- assignments reported blocked, and test-integrity violations found by the grader.

    python3 experiments/stage-eval/extra-metrics.py results/stage-eval/main [--exclude-tasks img-console-recording] > out.json
"""
import collections, glob, json, os, re, sys

def main():
    study = sys.argv[1]
    exclude = set()
    if "--exclude-tasks" in sys.argv:
        exclude = set(sys.argv[sys.argv.index("--exclude-tasks") + 1].split(","))
    arms = collections.defaultdict(collections.Counter)
    for run in sorted(glob.glob(os.path.join(study, "runs", "*", "*", "r*"))):
        task, arm, name = run.split(os.sep)[-3:]
        if task in exclude or not re.fullmatch(r"r\d+", name) or not os.path.exists(os.path.join(run, "meta.json")):
            continue
        meta = json.load(open(os.path.join(run, "meta.json")))
        c = arms[arm]
        c["runs"] += 1
        c["integrityViolationRuns"] += 1 if meta.get("integrity", {}).get("violations") else 0
        for record in meta.get("tasks") or []:
            c["assignments"] += 1
            if record.get("status") == "blocked":
                c["assignmentsBlocked"] += 1
        files = glob.glob(os.path.join(run, "sessions", "**", "*.jsonl"), recursive=True) + glob.glob(os.path.join(run, "records", "*", "workers", "*.jsonl"))
        for path in files:
            if "advisor" in os.path.basename(path):
                continue
            calls = {}
            for line in open(path, errors="replace"):
                if '"type":"message"' not in line:
                    continue
                try:
                    message = json.loads(line)["message"]
                except Exception:
                    continue
                if message.get("role") == "assistant":
                    for block in message.get("content") or []:
                        if block.get("type") != "toolCall":
                            continue
                        calls[block.get("id")] = block
                        if block.get("name") == "regression_check":
                            c["regressionChecks"] += 1
                        if block.get("name") == "task_plan":
                            nodes = (block.get("arguments") or {}).get("nodes") or []
                            c["taskPlanCalls"] += 1
                            for node in nodes:
                                note = str(node.get("note") or "")
                                if re.search(r"accept|criteri|수락", note, re.I):
                                    c["planNodeNotesWithAcceptance"] += 1
                                if re.search(r"ambigu|모호|reading|interpret", note, re.I):
                                    c["planNodeNotesWithAmbiguity"] += 1
                elif message.get("role") == "toolResult":
                    text = "".join(block.get("text", "") for block in message.get("content") or [] if block.get("type") == "text")
                    call = calls.get(message.get("toolCallId")) or {}
                    if call.get("name") == "regression_check":
                        verdict = re.match(r"Regression check: (\w+)", text)
                        word = verdict.group(1).lower() if verdict else "error/unavailable"
                        c["regressionVerdict:" + ("clean" if word == "no" else word)] += 1
                    if "Bash safety review (" in text[:200]:
                        c["bashReviewAnsweredNo" if "answered no" in text[:300] else "bashReviewNoVerdict"] += 1
    json.dump({arm: dict(sorted(counter.items())) for arm, counter in sorted(arms.items())}, sys.stdout, indent=2)
    print()

if __name__ == "__main__":
    main()
