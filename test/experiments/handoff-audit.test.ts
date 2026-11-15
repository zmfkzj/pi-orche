import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runAudit } from "../../experiments/handoff-audit/cli.js";
import { CASES, deterministicFlag, evaluatePolicies } from "../../experiments/handoff-audit/cases.js";
import { assignmentOriginal, type Suspect } from "../../experiments/handoff-audit/audit.js";

const exec = promisify(execFile);
/** Private text that must never reach the audit's output. */
const SECRET = "SECRET-7f3a";

let ids = 0;
const line = (value: object) => JSON.stringify(value);
const user = (id: string, parentId: string | null, text: string) => line({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string, calls: { name: string; args: object; id?: string }[] = [], extraTools = 0) =>
  line({ type: "message", id, parentId, message: { role: "assistant", content: [...calls.map(call => ({ type: "toolCall", id: call.id ?? `c${++ids}`, name: call.name, arguments: call.args })), ...Array.from({ length: extraTools }, () => ({ type: "toolCall", id: `x${++ids}`, name: "read", arguments: {} }))] } });
const result = (id: string, parentId: string, toolCallId: string, text = "done", isError = false) =>
  line({ type: "message", id, parentId, message: { role: "toolResult", toolCallId, toolName: "orche_task", isError, content: [{ type: "text", text }] } });
const handoff = (text: string, extra: object = {}) => ({ role: "implement", request: `R1: do it\nOriginal request:\n${text}`, ...extra });

/** A main transcript covering every situation, a branch, a compaction, a relay and a cut-off last line. */
function mainSession(): string {
  return [
    line({ type: "session", version: 3, id: "s-main", cwd: "/w" }),
    user("u1", null, `Improve recall. ${SECRET}-first`),
    assistant("a1", "u1", [{ name: "orche_task", id: "t1", args: handoff(`Improve recall. ${SECRET}-first`) }]),
    result("r1", "a1", "t1"),
    // Follow-up to a live worker after a status question main answered without tools.
    user("u2", "r1", "How long will it take?"),
    assistant("a2", "u2"),
    user("u3", "a2", `Go on. ${SECRET}-second`),
    assistant("a3", "u3", [{ name: "orche_task", id: "t2", args: handoff(`Go on. ${SECRET}-second`, { worker: "W1" }) }]),
    result("r3", "a3", "t2"),
    // A branch from r1: its hand-off sees only its own ancestors (not u2/u3), and paraphrases the user.
    user("b1", "r1", `Try another approach. ${SECRET}-branch`),
    assistant("b2", "b1", [{ name: "orche_task", id: "t3", args: { role: "implement", request: "R1: use the other approach", worker: "W1" } }]),
    result("b3", "b2", "t3"),
    // A gone worker named again: handover.
    line({ type: "custom", customType: "orche-worker", id: "g1", parentId: "r3", data: { id: "W2", reason: "stopped" } }),
    user("u4", "g1", "Continue W2's work."),
    assistant("a4", "u4", [{ name: "orche_task", id: "t4", args: handoff("Continue W2's work.", { worker: "W2" }) }]),
    result("r4", "a4", "t4", "Note: W2 was gone (stopped); W3 continued its work"),
    // A ledger takeover, then an unmet streak and the replacement without worker.
    user("u5", "r4", "Take task T1 over."),
    assistant("a5", "u5", [{ name: "orche_task", id: "t5", args: handoff("Take task T1 over.", { task: "T1" }) }]),
    result("r5", "a5", "t5", "Note: R2 unmet in 2 consecutive assignments of W3; hand only the unmet items to a NEW worker"),
    assistant("a6", "r5", [{ name: "orche_task", id: "t6", args: { role: "implement", request: "R2: the unmet item" } }]),
    result("r6", "a6", "t6"),
    // Main compacts, then the user asks again: the hand-off comes after a compaction.
    line({ type: "compaction", id: "k1", parentId: "r6", summary: "summary", firstKeptEntryId: "r6" }),
    user("u7", "k1", "Ship it."),
    assistant("a7", "u7", [{ name: "orche_task", id: "t7", args: handoff("Ship it.", { worker: "W3" }) }]),
    result("r7", "a7", "t7"),
    // A rejected call (validation error): no worker ran.
    assistant("a8", "r7", [{ name: "orche_task", id: "t8", args: handoff("x", { worker: "W9" }) }]),
    result("r8", "a8", "t8", "Unknown worker W9", true),
    // A message relayed with orche_task_message to the running worker, then a follow-up hand-off.
    user("u9", "r8", `Also log the threshold. ${SECRET}-relay`),
    assistant("a9", "u9", [{ name: "orche_task_message", args: { message: `Also log the threshold. ${SECRET}-relay` } }]),
    user("u10", "a9", "Then finish."),
    assistant("a10", "u10", [{ name: "orche_task", id: "t10", args: handoff("Then finish.", { worker: "W3" }) }]),
    result("r10", "a10", "t10"),
    // An earlier message main acted on with tools and never handed off.
    user("u11", "r10", `Use the staging database. ${SECRET}-unexplained`),
    assistant("a11", "u11", [], 1),
    user("u12", "a11", "Start."),
    assistant("a12", "u12", [{ name: "orche_task", id: "t12", args: handoff("Start.") }]),
    result("r12", "a12", "t12"),
    '{"type":"message","id":"cut',
  ].join("\n");
}

function fixtures(): { sessions: string; records: string } {
  const root = mkdtempSync(join(tmpdir(), "handoff-audit-"));
  const sessions = join(root, "sessions"), records = join(root, "records");
  mkdirSync(join(sessions, "--w--"), { recursive: true });
  writeFileSync(join(sessions, "--w--", "main.jsonl"), `${mainSession()}\n`);
  // An agent_workflow run: generated prompt, excerpted by main.
  writeFileSync(join(sessions, "--w--", "aw.jsonl"), [
    line({ type: "session", version: 3, id: "aw-run-1", cwd: "/w" }),
    user("v1", null, `[harness] generated prompt ${SECRET}-auto with many rules.\nRule one is long enough.\nRule two is long enough.`),
    assistant("v2", "v1", [{ name: "orche_task", id: "w1", args: handoff("[harness] excerpt") }]),
    result("v3", "v2", "w1"),
  ].join("\n"));
  const workers = join(records, "s-main", "workers");
  mkdirSync(workers, { recursive: true });
  const prompt = `## Handover: you (W3) continue the work of worker W2\n\nAssignment: implement. You are the orchestrator.\nR1: do it\nOriginal request:\nKeep precision at least 50%. ${SECRET}-sub\n\n## Context from the requesting session\nmore\n\nOwn the task end to end as its orchestrator`;
  writeFileSync(join(workers, "W3-2026.jsonl"), [
    line({ type: "session", version: 3, id: "w3", cwd: "/w" }),
    user("p1", null, prompt),
    line({ type: "compaction", id: "p0", parentId: "p1", summary: "s", firstKeptEntryId: "p1" }),
    assistant("p2", "p0", [{ name: "orche_spawn", id: "s1", args: { reason: "verification", workers: [{ name: "v", role: "verify", request: "Check recall." }, { name: "v2", role: "verify", request: `Check it. User: Keep precision at least 50%. ${SECRET}-sub` }] } }]),
    line({ type: "message", id: "p3", parentId: "p2", message: { role: "toolResult", toolCallId: "s1", toolName: "orche_spawn", isError: false, content: [{ type: "text", text: "ok" }] } }),
  ].join("\n"));
  // A plan advisor transcript hands nothing off and is skipped.
  writeFileSync(join(workers, "W3.advisor-2026.jsonl"), user("q1", null, "advisor"));
  return { sessions, records };
}

describe("hand-off audit", () => {
  it("classifies main hand-offs by situation along their own branch and counts evidence signals", async () => {
    const suspects: Suspect[] = [];
    const summary = await runAudit({ ...fixtures(), activeMinutes: 0, suspects });
    expect(summary.inputs).toMatchObject({ mainFiles: 2, workerFiles: 1, parseErrors: 1, truncatedTail: 1 });
    const main = summary.main.interactive;
    expect(main).toMatchObject({ calls: 10, rejected: 1, noResult: 0 });
    expect(Object.fromEntries(Object.entries(main.bySituation).map(([key, stats]) => [key, stats.n]))).toEqual({ first: 2, "follow-up": 4, handover: 1, "ledger-takeover": 1, "replacement-after-unmet": 1 });
    // The branch's hand-off paraphrases its own user message; the other branch's messages are not mixed in.
    expect(main.bySituation["follow-up"].latest).toEqual({ verbatim: 3, partial: 0, absent: 1, "no-text": 0 });
    expect(main.bySituation["follow-up"].earlier).toEqual({ total: 2, carried: 0, relayed: 1, answeredWithoutTools: 1, unexplained: 0, noText: 0 });
    expect(main.bySituation.first.earlier).toMatchObject({ total: 1, unexplained: 1 });
    expect(main.bySituation["replacement-after-unmet"].noUserSinceHandoff).toBe(1);
    expect(main.afterMainCompaction.n).toBe(3);
    expect(main.compactedBetween.n).toBe(0);
    expect(summary.main.automated.bySituation.first).toMatchObject({ n: 1, latest: { verbatim: 0, partial: 0, absent: 1, "no-text": 0 } });
    // Locations to review by hand (the relayed message still counts: suspects are candidates, not findings); aw.jsonl sorts first.
    expect(suspects.map(item => [item.origin, item.situation, item.latest, item.earlierAbsent])).toEqual([["automated", "first", "absent", 0], ["interactive", "follow-up", "verbatim", 1], ["interactive", "follow-up", "absent", 0], ["interactive", "follow-up", "verbatim", 1], ["interactive", "first", "verbatim", 1]]);
  });

  it("finds a sub-worker's parent assignment behind a handover briefing and compares its Original request only", async () => {
    const summary = await runAudit({ ...fixtures(), activeMinutes: 0 });
    expect(summary.subWorker).toMatchObject({ workerCompactions: 1, spawnCalls: 1, requests: 2, parentFound: 2, parentWithOriginal: 2 });
    expect(summary.subWorker.byOrigin.interactive.verify).toEqual({ n: 2, ownOriginalSection: 0, carry: { verbatim: 1, partial: 0, absent: 1, "no-text": 0 } });
    expect(assignmentOriginal("Assignment: answer.\nOriginal request:\nhello there\n\nStrictly read-only. Inspect.")).toBe("hello there");
  });

  it("writes aggregates only: no message text in its output, its suspects file or its error output", async () => {
    const paths = fixtures();
    const root = join(paths.sessions, "..");
    const cli = join(process.cwd(), "experiments", "handoff-audit", "cli.ts");
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const { stdout } = await exec(tsx, [cli, "--sessions", paths.sessions, "--records", paths.records, "--suspects", join(root, "suspects.json")]);
    expect(JSON.parse(stdout).main.interactive.calls).toBe(10);
    expect(stdout).not.toContain(SECRET);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(root, "suspects.json"), "utf8")).not.toContain(SECRET);
    const failed = await exec(tsx, [cli, "--sessions", paths.sessions, "--records", paths.records, "--out", join(root, "missing", "out.json")]).then(() => undefined, (error: { stderr: string; stdout: string }) => error);
    expect(failed?.stderr).toContain("handoff-audit failed");
    expect(`${failed?.stderr}${failed?.stdout}`).not.toContain(SECRET);
  }, 30_000);
});

describe("hand-off evidence policies on synthetic cases", () => {
  it("shows what deterministic signals catch and miss; semantic detection and fixing were not run", () => {
    const flags = Object.fromEntries(CASES.map(item => [item.id, deterministicFlag(item)]));
    // Flagged correctly: a dropped constraint, a lost earlier message, a verifier without the user's words.
    expect(flags).toMatchObject({ "omitted-constraint": true, "earlier-constraint-lost": true, "verifier-without-original": true });
    // Flagged wrongly: a faithful translation and a user-approved retraction (restoring it would be the harmful fix).
    expect(flags).toMatchObject({ "valid-paraphrase": true, "approved-retraction": true });
    // Not flagged, rightly: concise follow-ups and main's own continuation; wrongly: a distorted R-line under a verbatim quote.
    expect(flags).toMatchObject({ "concise-follow-up": false, "follow-up-no-new-text": false, "handover-concise": false, "distorted-r-line": false });
    expect(evaluatePolicies()).toEqual([
      { policy: "current", status: "run", truePositive: 0, falsePositive: 0, falseNegative: 5, trueNegative: 6, flaggedUnverifiable: 0, unverifiable: 3 },
      { policy: "deterministic", status: "run", truePositive: 4, falsePositive: 2, falseNegative: 1, trueNegative: 4, flaggedUnverifiable: 1, unverifiable: 3 },
      { policy: "semantic-detection", status: "not-run", note: expect.stringContaining("no model experiment") },
      { policy: "detection+fix", status: "not-run", note: expect.stringContaining("not implemented") },
    ]);
  });
});
