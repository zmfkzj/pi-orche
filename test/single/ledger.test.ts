import { describe, expect, it } from "vitest";
import {
  createLedger, isLedgerEvent, latestLedgers, LEDGER_ENTRY_TYPE, LEDGER_LIMITS, originalRequestOf, planProgress, recordCheck, recordFailure, recordHandoff, recordPlan, recordRecheck, recordResult,
  renderLedgerForWorker, renderLedgerSummary, renderResumeBriefing, renderTimeoutResume, replayLedgerEvents, startLedger, SUMMARY_TASKS, WORKER_ORIGINAL_CHARS,
  type LedgerEvent, type TaskLedger,
} from "../../src/single/ledger.js";

const handoff = (requirements: string, original = "인사말을 고쳐줘.") => `Intent/Purpose: greeting\n${requirements}\nConstraints and non-goals: none.\nOriginal request\n${original}`;
const primary = { worker: "W1", model: "p/m", sessionFile: "/records/workers/W1.jsonl" };
const entry = (data: unknown) => ({ type: "custom", customType: LEDGER_ENTRY_TYPE, data });
/** Live state without the runtime-only `live` flag, for comparison with a replay. */
const persisted = (ledger: TaskLedger) => { const copy = structuredClone(ledger); if (copy.primary) copy.primary.live = true; return copy; };

describe("task ledger", () => {
  it("extracts the verbatim original request after the hand-off header, including header variants", () => {
    expect(originalRequestOf(handoff("R1: x"))).toBe("인사말을 고쳐줘.");
    expect(originalRequestOf("R1: x\n## Original user request (verbatim):\nline one\nline two")).toBe("line one\nline two");
    expect(originalRequestOf("**Original request**: fix it")).toBe("fix it");
    expect(originalRequestOf("R1: no original section")).toBeUndefined();
  });

  it("records hand-offs per assignment, keeps distinct originals and carries the status of a requirement restated unchanged", () => {
    const ledger = createLedger("T1", "/repo", 1);
    expect(recordHandoff(ledger, { request: handoff("R1: greeting is correct\nR2: tests pass"), primary, at: 2 }).assignment).toBe(1);
    expect(ledger.primary).toEqual({ ...primary, live: true });
    recordResult(ledger, { role: "implement", worker: "W1", status: "done", summary: "Fixed.\nDetails", checklist: [
      { id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "node --test" },
      { id: "R2", status: "partial", evidence: "one test missing" },
      { id: "R9", status: "met", evidence: "not a requirement of this assignment" },
    ], ambiguities: [{ id: "R1", readings: ["Hello", "Hi"], chosen: "Hello" }, { id: "R1", readings: ["Hello", "Hi"], chosen: "Hello" }], record: "/records/a1", at: 3 });
    recordHandoff(ledger, { request: handoff("R1: greeting is correct\nR2: tests pass for both locales"), primary: { worker: "W2" }, at: 4 });
    expect(ledger.assignments).toBe(2);
    expect(ledger.primary).toEqual({ worker: "W2", live: true });
    expect(ledger.originalRequests).toEqual([{ assignment: 1, text: "인사말을 고쳐줘." }]);
    expect(ledger.requirements.filter(item => item.assignment === 2)).toEqual([
      { assignment: 2, id: "R1", text: "greeting is correct", status: "met", evidence: "greeting.txt:1", verifiedBy: "node --test" },
      { assignment: 2, id: "R2", text: "tests pass for both locales", status: "open" },
    ]);
    expect(ledger.decisions).toEqual([{ assignment: 1, id: "R1", readings: ["Hello", "Hi"], chosen: "Hello", by: "worker" }]);
    expect(ledger.history).toEqual([{ assignment: 1, at: 3, role: "implement", worker: "W1", status: "done", summary: "Fixed.", record: "/records/a1" }]);
    recordHandoff(ledger, { request: handoff("R1: other", "다른 요청"), primary, at: 5 });
    expect(ledger.originalRequests.map(item => item.text)).toEqual(["인사말을 고쳐줘.", "다른 요청"]);
  });

  it("records failures in the history and bounds requirements, decisions, history and originals", () => {
    const ledger = createLedger("T1", "/repo");
    for (let index = 0; index < 70; index++) {
      recordHandoff(ledger, { request: handoff(`R1: requirement ${index}`, `request ${index}`), primary });
      recordFailure(ledger, { role: "implement", worker: "W1", status: "timeout", reason: `timed out ${index}` });
      recordResult(ledger, { role: "implement", worker: "W1", status: "done", summary: "ok", ambiguities: [{ id: "R1", readings: ["a", "b"], chosen: `a${index}` }] });
    }
    expect(ledger.requirements.length).toBeLessThanOrEqual(LEDGER_LIMITS.requirements);
    expect(ledger.requirements.at(-1)).toMatchObject({ assignment: 70, text: "requirement 69" });
    expect(ledger.decisions).toHaveLength(LEDGER_LIMITS.decisions);
    expect(ledger.history).toHaveLength(LEDGER_LIMITS.history);
    expect(ledger.history.some(item => item.status === "timeout" && item.summary === "timed out 69")).toBe(true);
    expect(ledger.originalRequests).toHaveLength(LEDGER_LIMITS.originals);
    expect(ledger.originalRequests[0]!.text).toBe("request 0");
    expect(ledger.originalRequests.at(-1)!.text).toBe("request 69");
  });

  it("persists small events whose replay rebuilds exactly the live state", () => {
    const events: LedgerEvent[] = [];
    const { ledger, event } = startLedger("T4", "/repo", 1);
    events.push(event);
    for (let index = 0; index < 70; index++) {
      events.push(recordHandoff(ledger, { request: handoff(`R1: requirement ${index}\nR2: tests ${index}`, `request ${index} ${"z".repeat(500)}`), primary: { worker: `W${1 + (index % 3)}` }, at: 10 + index }));
      if (index % 5 === 0) events.push(recordFailure(ledger, { role: "implement", worker: "W1", status: "failed", reason: `failure ${index}`, at: 10 + index }));
      events.push(recordResult(ledger, { role: "implement", worker: "W1", status: "done", summary: `round ${index}`, at: 10 + index,
        checklist: [{ id: "R1", status: "met", evidence: "e", verifiedBy: "npm test" }, { id: "R2", status: index % 2 ? "partial" : "met", evidence: "e" }],
        ambiguities: [{ id: "R2", readings: ["x", "y"], chosen: `x${index}` }] }));
    }
    expect(events.every(isLedgerEvent)).toBe(true);
    // JSON round trip, as session entries are stored.
    const stored = events.map(item => JSON.parse(JSON.stringify(item)) as LedgerEvent);
    expect(replayLedgerEvents(stored).get("T4")).toEqual(persisted(ledger));
    // Every event carries only its own change: no event grows with the task, and the log stays far below a snapshot per change.
    const sizes = stored.map(item => JSON.stringify(item).length);
    expect(Math.max(...sizes)).toBeLessThan(2_000);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(stored.length * JSON.stringify(ledger).length / 10);
    // Events never alias the ledger: later changes do not rewrite an event already handed out.
    const handed = recordHandoff(ledger, { request: handoff("R1: last"), primary });
    recordResult(ledger, { role: "implement", worker: "W1", status: "done", summary: "x", checklist: [{ id: "R1", status: "met", evidence: "e" }] });
    expect(handed.requirements[0]!.status).toBe("open");
  });

  it("renders the worker projection with the latest assignment first-class and drops old history to fit", () => {
    const ledger = createLedger("T7", "/repo");
    recordHandoff(ledger, { request: handoff("R1: first round"), primary });
    recordResult(ledger, { role: "implement", worker: "W2", status: "done", summary: "round one", checklist: [{ id: "R1", status: "met", evidence: "e", verifiedBy: "npm test" }], ambiguities: [{ id: "R1", readings: ["A", "B"], chosen: "A" }] });
    recordHandoff(ledger, { request: handoff("R1: second round"), primary });
    const text = renderLedgerForWorker(ledger);
    expect(text).toContain("Task ledger T7: state across 2 assignment(s)");
    expect(text).toContain("Requirements of assignment a2 (the latest when rendered), last reported status:\n- R1 [open] second round");
    expect(text).toContain("Requirements of earlier assignments (historical):\n- a1 R1 [met] first round");
    expect(text).toContain('- a1 R1: chose "A" over "B"');
    expect(text).toContain("- a1 implement done (W2): round one");
    for (let index = 0; index < 40; index++) recordFailure(ledger, { role: "implement", worker: "W2", status: "failed", reason: `failure ${index} ${"x".repeat(200)}` });
    const small = renderLedgerForWorker(ledger, 1200);
    expect(small.length).toBeLessThanOrEqual(1200);
    expect(small).toContain("- R1 [open] second round");
    expect(small).toContain("older ledger lines omitted");
    expect(small).not.toContain("failure 0 ");
  });

  it("keeps the latest requirements when a task carries long original requests of several user requests", () => {
    const ledger = createLedger("T2", "/repo");
    for (let index = 1; index <= 5; index++) {
      recordHandoff(ledger, { request: handoff(`R1: task ${index} done\nR2: task ${index} tested`, `request ${index} ${"y".repeat(3_000)}`), primary });
      recordResult(ledger, { role: "implement", worker: "W1", status: "done", summary: `round ${index}`, checklist: [{ id: "R1", status: "met", evidence: "e", verifiedBy: "npm test" }, { id: "R2", status: "partial", evidence: "e" }] });
    }
    const text = renderLedgerForWorker(ledger);
    expect(text.length).toBeLessThanOrEqual(LEDGER_LIMITS.workerChars);
    expect(text).toContain("Requirements of assignment a5 (the latest when rendered), last reported status:\n- R1 [met; verified by: npm test] task 5 done\n- R2 [partial] task 5 tested");
    expect(text).toContain("Earlier original request(s) from the user (2 more not shown):");
    expect(text).toContain("[a1] request 1 ");
    expect(text).toContain("[a4] request 4 ");
    expect(text).not.toContain("[a5] request 5");
    expect(text).not.toContain("y".repeat(WORKER_ORIGINAL_CHARS));
    const tight = renderLedgerForWorker(ledger, 900);
    expect(tight.length).toBeLessThanOrEqual(900);
    expect(tight).toContain("- R2 [partial] task 5 tested");
  });

  it("summarizes tasks for the main session, newest first, with how to continue them", () => {
    const ledgers: TaskLedger[] = [];
    for (let index = 1; index <= SUMMARY_TASKS + 1; index++) {
      const ledger = createLedger(`T${index}`, "/repo", index);
      recordHandoff(ledger, { request: handoff("R1: done item\nR2: open item"), primary: { worker: `W${index}` }, at: index });
      recordResult(ledger, { role: "implement", worker: `W${index}`, status: "done", summary: `summary ${index}`, checklist: [{ id: "R1", status: "met", evidence: "e" }, { id: "R2", status: "unmet", evidence: "e" }], at: index });
      ledger.primary!.live = index !== SUMMARY_TASKS + 1;
      ledgers.push(ledger);
    }
    const summary = renderLedgerSummary(ledgers)!;
    const lines = summary.split("\n");
    expect(lines[0]).toContain('Pass task "T…" to orche_task for a follow-up of that task, also with a new worker; omit it for a different task');
    expect(lines[1]).toContain(`T${SUMMARY_TASKS + 1} · W${SUMMARY_TASKS + 1} (gone) · 1 assignment(s) · current a1: 1 met, 1 unmet · not met: R2 unmet: open item`);
    expect(summary).toContain("(1 older task ledger(s) not shown)");
    expect(summary).not.toContain("T1 ·");
    expect(renderLedgerSummary([])).toBeUndefined();
  });

  it("briefs a worker that takes a task over, from a gone or a live previous worker", () => {
    const ledger = createLedger("T3", "/repo");
    recordHandoff(ledger, { request: handoff("R1: keep going"), primary });
    const gone = renderResumeBriefing(ledger, { worker: "W4", sessionFile: "/records/workers/W4.jsonl", live: false });
    expect(gone).toContain("## Continuing task T3");
    expect(gone).toContain("Task T3 was worked on by W4; W4 is no longer live (its session ended: a reload, idle expiry or pool eviction).");
    expect(gone).toContain("/records/workers/W4.jsonl");
    expect(gone).toContain("- R1 [open] keep going");
    expect(renderResumeBriefing(ledger, { worker: "W4", live: true })).toContain("W4 handed it over to you.");
  });

  it("restores ledgers from event entries and old snapshot entries, skipping malformed and orphan events", () => {
    const events: LedgerEvent[] = [];
    const first = startLedger("T1", "/repo", 1);
    events.push(first.event, recordHandoff(first.ledger, { request: handoff("R1: a"), primary, at: 2 }));
    events.push(recordResult(first.ledger, { role: "implement", worker: "W1", status: "done", summary: "ok", checklist: [{ id: "R1", status: "met", evidence: "e" }], at: 3 }));
    const snapshot = createLedger("T2", "/repo", 1);
    recordHandoff(snapshot, { request: handoff("R1: b"), primary: { worker: "W2" } });
    const restored = latestLedgers([
      entry(events[0]), entry(events[1]),
      { type: "custom", customType: "orche-mode", data: { mode: "single" } },
      entry({ v: 1, event: "result", taskId: "T1", at: 4, assignment: 1, statuses: [{ id: "R1", status: "bogus", evidence: "e" }], decisions: [], history: {} }),
      entry({ ...events[2], taskId: "T9" }),
      { type: "message" },
      entry(snapshot),
      entry(events[2]),
    ]);
    expect(restored.map(ledger => [ledger.taskId, ledger.assignments, ledger.requirements[0]?.status])).toEqual([["T1", 1, "met"], ["T2", 1, "open"]]);
    expect(restored[0]).toEqual(persisted(first.ledger));
    expect(restored[1]).not.toBe(snapshot);
  });
});

describe("task ledger: v2 pipeline events", () => {
  const reading = { id: "A1", quote: "once per claim", readings: ["every claim", "failed claims only"], chosen: "every claim", askUser: true };
  it("keeps the Framer's readings, the risk check and the findings, and replays them", () => {
    const { ledger, event: created } = startLedger("T1", "/repo", 1);
    const events: LedgerEvent[] = [created];
    events.push(recordHandoff(ledger, { request: handoff("R1: [edge] fail then succeed\n  Acceptance: attempts 2"), primary, at: 2, decisions: [reading] }));
    events.push(recordCheck(ledger, { score: 7, threshold: 5, decision: "verify", reason: "threshold", verdict: "fail", at: 3 }, [
      { id: "F1", severity: "blocking", requirement: "R1", claim: "attempts stays 1", status: "open", probe: "node .orche/scratch/T1/a.probe.mjs" },
      { id: "F2", severity: "minor", claim: "naming", status: "minor" },
    ]));
    events.push(recordResult(ledger, { role: "implement", worker: "W1", status: "done", summary: "first", checklist: [{ id: "R1", status: "met", evidence: "x", verifiedBy: "node --test" }], at: 4 }));
    expect(renderLedgerForWorker(ledger)).toContain('Verifier findings of assignment a1 not fixed when rendered:\n- F1 blocking R1 [open] attempts stays 1 (re-run: node .orche/scratch/T1/a.probe.mjs)\n- F2 minor [minor] naming');
    events.push(recordRecheck(ledger, [{ id: "F1", status: "fixed", detail: "probe exits 0" }], 5));
    expect(ledger.decisions).toEqual([{ assignment: 1, id: "A1", quote: "once per claim", readings: ["every claim", "failed claims only"], chosen: "every claim", by: "framer", askUser: true }]);
    expect(ledger.findings?.map(item => [item.id, item.status, item.detail])).toEqual([["F1", "fixed", "probe exits 0"], ["F2", "minor", undefined]]);
    expect(renderLedgerForWorker(ledger)).toContain('- a1 A1 "once per claim": Framer recommended "every claim" over "failed claims only" (needs the user\'s decision)');
    expect(renderLedgerForWorker(ledger)).not.toContain("F1 blocking");
    expect(renderLedgerSummary([ledger])).toContain('readings: A1="every claim" (ask the user) · risk 7/5: verified fail');
    for (const event of events) expect(isLedgerEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
    expect(replayLedgerEvents(JSON.parse(JSON.stringify(events)) as LedgerEvent[]).get("T1")).toEqual(persisted(ledger));
    expect(latestLedgers(events.map(entry))[0]).toEqual(persisted(ledger));
  });

  it("rejects malformed check, recheck and reading events", () => {
    const base = { v: 1, taskId: "T1", at: 1, assignment: 1 };
    const check = { assignment: 1, at: 1, score: 1, threshold: 5, decision: "skip", reason: "below threshold" };
    expect(isLedgerEvent({ ...base, event: "check", check, findings: [] })).toBe(true);
    expect(isLedgerEvent({ ...base, event: "check", check: { ...check, decision: "maybe" }, findings: [] })).toBe(false);
    expect(isLedgerEvent({ ...base, event: "check", check, findings: [{ assignment: 1, id: "F1", severity: "fatal", claim: "x", status: "open" }] })).toBe(false);
    expect(isLedgerEvent({ ...base, event: "recheck", statuses: [{ id: "F1", status: "gone" }] })).toBe(false);
    const handoffEvent = { ...base, event: "handoff", requirements: [], primary: { worker: "W1" } };
    expect(isLedgerEvent({ ...handoffEvent, decisions: [{ assignment: 1, readings: ["a", "b"], chosen: "a", by: "framer" }] })).toBe(true);
    expect(isLedgerEvent({ ...handoffEvent, decisions: [{ assignment: 1, readings: ["a", "b"], chosen: "a", by: "oracle" }] })).toBe(false);
  });
});

describe("task ledger: the persisted Task DAG (resume checkpoint)", () => {
  const nodes = [
    { id: "impl", title: "Implement", status: "done", covers: ["R1"], dependsOn: [], note: "done when tests pass", checkpoint: { result: "parser rewritten", evidence: ["T3 npm test -> 12 pass"], verification: "passed" } },
    { id: "docs", title: "Document", status: "pending", covers: ["R2"], dependsOn: ["impl"] },
    { id: "final", title: "Integrate", status: "running", covers: ["R1", "R2"], dependsOn: ["docs"], phase: "integrate" },
  ];
  const started = () => {
    const { ledger } = startLedger("T1", "/repo", 1);
    recordHandoff(ledger, { request: handoff("R1: parser\nR2: docs"), primary, at: 2 });
    return ledger;
  };

  it("records a compact copy (statuses, coverage, checkpoints; no notes or dependencies) that replays from session entries", () => {
    const ledger = started();
    const event = recordPlan(ledger, { worker: "W1", plan: { nodes }, at: 3 });
    expect(event).toMatchObject({ event: "plan", assignment: 1, worker: "W1" });
    expect(ledger.plan).toEqual({ assignment: 1, worker: "W1", at: 3, nodes: [
      { id: "impl", title: "Implement", status: "done", covers: ["R1"], checkpoint: { result: "parser rewritten", verification: "passed", evidence: ["T3 npm test -> 12 pass"] } },
      { id: "docs", title: "Document", status: "pending", covers: ["R2"] },
      { id: "final", title: "Integrate", status: "running", covers: ["R1", "R2"], phase: "integrate" },
    ] });
    expect(JSON.stringify(event)).not.toContain("done when tests pass");
    expect(isLedgerEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
    const [restored] = latestLedgers([entry({ v: 1, event: "create", taskId: "T1", cwd: "/repo", at: 1 }), ...[recordHandoff(createLedger("T1", "/repo", 1), { request: handoff("R1: parser\nR2: docs"), primary, at: 2 }), event].map(entry)]);
    expect(restored?.plan).toEqual(ledger.plan);
    // Malformed plan events are skipped like any other untrusted entry.
    expect(isLedgerEvent({ ...event, nodes: [{ id: "x" }] })).toBe(false);
    expect(isLedgerEvent({ ...event, worker: 1 })).toBe(false);
    expect(planProgress(ledger.plan!)).toMatchObject({ done: 1, total: 3 });
  });

  it("renders it for the worker that continues, keeps it out of the compaction copy of the same assignment, and drops evidence when too large", () => {
    const ledger = started();
    recordPlan(ledger, { worker: "W1", plan: { nodes }, at: Date.UTC(2026, 9, 9, 10, 0) });
    const rendered = renderLedgerForWorker(ledger);
    expect(rendered).toContain("Last recorded Task DAG of task (assignment a1, worker W1, 2026-10-09 10:00:00Z): 1/3 nodes done.");
    expect(rendered).toContain("Not done:\n- pending docs: Document (R2)\n- running final {integrate}: Integrate (R1, R2)");
    expect(rendered).toContain("- done impl [passed]: Implement (R1) — parser rewritten [T3 npm test -> 12 pass]");
    expect(renderLedgerForWorker(ledger, undefined, { skipPlanOf: 1 })).not.toContain("Last recorded Task DAG");
    expect(renderResumeBriefing(ledger, { worker: "W1", live: false })).toContain("Resume from the last recorded Task DAG in the ledger below");
    // A timeout of W1: only W1 gets the timeout resume block.
    recordFailure(ledger, { role: "implement", worker: "W1", status: "timeout", reason: "Worker W1 timed out after 34800000ms (extension budget 10/10 used)" });
    expect(renderTimeoutResume(ledger, "W1")).toContain("## Resuming task T1 after a timeout");
    expect(renderTimeoutResume(ledger, "W1")).toContain("1/3 nodes done");
    expect(renderTimeoutResume(ledger, "W2")).toBe("");
    expect(renderResumeBriefing(ledger, { worker: "W1", live: true })).toContain("Its last assignment a1 was stopped by the time limit, not by an unmet result.");
    expect(renderLedgerSummary([ledger])).toContain("Task DAG a1 (W1): 1/3 done");
    // A huge plan: evidence is left out of the event, statuses and results stay.
    const big = Array.from({ length: 60 }, (_, index) => ({ id: `n${index}`, title: "t".repeat(160), status: "done", covers: ["R1"], checkpoint: { result: "r".repeat(300), evidence: Array(4).fill("e".repeat(160)), verification: "passed" } }));
    const event = recordPlan(ledger, { worker: "W1", plan: { nodes: big } });
    expect(event.nodes).toHaveLength(60);
    expect(event.nodes.every(node => node.checkpoint && !node.checkpoint.evidence && node.checkpoint.result.length === 300)).toBe(true);
    expect(renderLedgerForWorker(ledger).length).toBeLessThanOrEqual(LEDGER_LIMITS.workerChars);
  });
});
