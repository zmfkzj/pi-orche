/**
 * Model-free checks of the decision-memory A/B harness (experiments/decision-memory-ab): the generated tasks are objectively gradable
 * (the unsolved workspace fails, the reference solution passes every hidden test, lint and the visible suite), and the transcript
 * analysis extracts compactions, restored work logs and post-compaction behaviour. The A/B results themselves come from real model
 * runs (README.md); nothing here calls a model.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate, grade, TASKS, writeFiles } from "../../experiments/decision-memory-ab/project.js";
import { analyzeTranscript } from "../../experiments/decision-memory-ab/analyze.js";
import { ARM_CONFIG, schedule } from "../../experiments/decision-memory-ab/protocol.js";
import { pairedStats } from "../../experiments/decision-memory-ab/summarize.js";
import { parseWorkerCompaction } from "../../src/pi/compaction-policy.js";
import { parseThinkingPolicyConfig } from "../../src/extension/config.js";

const root = mkdtempSync(join(tmpdir(), "dm-ab-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.each(TASKS)("task %s", task => {
  it("the unsolved workspace fails its acceptance criteria", () => {
    const dir = join(root, `${task}-start`);
    writeFiles(dir, generate(task));
    const result = grade(task, dir, join(root, `${task}-start-hidden`));
    expect(result.success).toBe(false);
    expect(result.visibleOk).toBe(false);
    expect(result.hiddenPassed).toBeLessThan(result.hiddenTotal);
    expect(result.protectedUnchanged).toBe(true);
    if (task === "feature") expect(result.lintOk).toBe(false);
  }, 60_000);

  it("the reference solution passes every hidden test, the visible suite and lint", () => {
    const dir = join(root, `${task}-solved`);
    writeFiles(dir, generate(task, { solved: true }));
    const result = grade(task, dir, join(root, `${task}-solved-hidden`));
    expect(result.hiddenFailed).toEqual([]);
    expect(result).toMatchObject({ success: true, visibleOk: true, protectedUnchanged: true, score: 1 });
    expect(result.visiblePassed).toBeGreaterThan(250);
  }, 60_000);

  it("detects a changed test file", () => {
    const dir = join(root, `${task}-tampered`);
    writeFiles(dir, generate(task, { solved: true }));
    writeFileSync(join(dir, "test/money.test.js"), "");
    expect(grade(task, dir, join(root, `${task}-tampered-hidden`))).toMatchObject({ success: false, protectedUnchanged: false, changedProtected: ["test/money.test.js"] });
  }, 60_000);
});

describe("transcript analysis", () => {
  it("finds the compaction, the restored work log and post-compaction re-reads", async () => {
    const file = join(root, "W1-x.jsonl");
    const call = (id: string, name: string, args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: { total: 0.01 } } } });
    const result = (id: string, name: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: "ok" }] } });
    const lines = [
      { type: "message", message: { role: "user", content: "Assignment: fix" } },
      call("p1", "task_plan", { nodes: [{ id: "fix", title: "fix", status: "running", dependsOn: [], covers: ["R1"] }] }), result("p1", "task_plan"),
      call("c1", "read", { path: "docs/SPEC.md" }), result("c1", "read"),
      call("c2", "bash", { command: "npm test" }), result("c2", "bash", true),
      { type: "compaction", summary: "## Goal\nfix", tokensBefore: 70000, usage: { input: 60000, output: 2000, cost: { total: 0.3 } } },
      { type: "custom_message", customType: "orche:task-essentials", content: "Assignment in progress at compaction time:\nWork log of this assignment (orche's record):\nFailed calls (do not repeat):\n- FAILED bash npm test (call c2; T2)" },
      call("c3", "read", { path: "docs/SPEC.md" }), result("c3", "read"),
      call("c4", "bash", { command: "npm test" }), result("c4", "bash"),
    ];
    writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n"));
    const analysis = await analyzeTranscript(file);
    expect(analysis.compactions).toHaveLength(1);
    expect(analysis.compactions[0]).toMatchObject({ tokensBefore: 70000, workLogKind: "basic", unresolvedAtCut: 1, unresolvedShown: 1, unresolvedChecksAtCut: 1, unresolvedChecksShown: 1, unresolvedLaterResolved: 1, callsBeforeCut: 2, readsBeforeCut: 1, rereadsAfter: 1, requestsAfter: 2 });
    expect(analysis.usage).toMatchObject({ requests: 5, input: 50, output: 25, cacheRead: 500, cacheWrite: 100 });
    expect(analysis.summaryUsage).toMatchObject({ input: 60000, output: 2000 });
    expect(analysis.costEstimate).toBeCloseTo(0.35);
    expect(analysis.compactions[0]!.unresolvedDetail).toEqual([{ tool: "bash", target: "npm test", check: true, shown: true }]);
    expect(analysis.taskPlanCalls).toBe(1);
  });
});

describe("protocol", () => {
  it("the arms differ only in decisionMemory, with extended essentials in both", () => {
    for (const linkage of ["off", "warn"] as const) {
      const off = ARM_CONFIG("off", linkage), on = ARM_CONFIG("on", linkage);
      expect({ ...on, workerCompaction: { ...on.workerCompaction, decisionMemory: false } }).toEqual(off);
      expect(parseWorkerCompaction(on.workerCompaction)).toMatchObject({ essentials: "extended", decisionMemory: true, policy: "absolute", triggerTokens: 28000 });
      expect(parseWorkerCompaction(off.workerCompaction).decisionMemory).toBeUndefined();
      expect(parseThinkingPolicyConfig(on.thinkingPolicy).evidence).toBe(linkage);
    }
  });

  it("schedules every (task, repeat) pair once per arm, in a seeded order", () => {
    const cells = schedule(["bugfix", "feature"], 5, 31114);
    expect(cells).toHaveLength(20);
    expect(new Set(cells.map(cell => `${cell.task}/${cell.arm}/${cell.repeat}`)).size).toBe(20);
    expect(schedule(["bugfix", "feature"], 5, 31114)).toEqual(cells);
    expect(cells.filter(cell => cell.order % 2 === 1).map(cell => cell.arm)).toContain("on");
  });

  it("paired statistics: exact Wilcoxon and bootstrap on known values", () => {
    expect(pairedStats([-1, -2, -3, -4, -5])).toMatchObject({ n: 5, mean: -3, onLower: 5, onHigher: 0, wilcoxonP: 0.063 });
    expect(pairedStats([1, -1])).toMatchObject({ wilcoxonP: 1 });
    expect(pairedStats([0, 0])).toMatchObject({ wilcoxonP: null, bootstrap95: [0, 0] });
  });
});
