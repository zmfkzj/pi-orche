import { describe, expect, it } from "vitest";
import { renderDecisionWorkLog } from "../../src/pi/decision-memory.js";
import { parseWorkerCompaction } from "../../src/pi/compaction-policy.js";
import { summaryBudgetNote, setSummaryDecisionMemory } from "../../src/pi/summary-budget.js";
import type { EvidenceLedger, ToolRecord } from "../../src/pi/tool-evidence.js";
import type { TaskPlan } from "../../src/tools/task-plan.js";

const make = (ref: string, toolCallId: string, name: string, node: string | undefined, isError: boolean, target: string, timestamp: number): ToolRecord => ({
  ref, toolCallId, name, ...(node ? { node } : {}), isError, target, timestamp,
  request: timestamp, atBaseline: true,
});
const ledger = (calls: ToolRecord[]): EvidenceLedger => ({ calls, checks: calls.length, bookkeeping: 0, tag: false });
const plan = {
  nodes: [
    { id: "finished", title: "Inspect", status: "done", dependsOn: [], covers: ["R1"],
      checkpoint: { result: "Inspected", evidence: ["T1 read -> passed"], verification: "passed" } },
    { id: "open", title: "Implement", status: "running", dependsOn: ["finished"], covers: ["R1"] },
    { id: "next", title: "Verify", status: "pending", dependsOn: ["open"], covers: ["R1"] },
  ],
} as TaskPlan;

describe("decision-linked work log", () => {
  it("keeps successful active-node observations and checkpoint references, not stale completed-node calls", () => {
    const text = renderDecisionWorkLog(ledger([
      make("T1", "cited", "read", "finished", false, "spec.md", 1),
      make("T2", "stale", "read", "finished", false, "obsolete.md", 2),
      make("T3", "current", "read", "open", false, "src/current.ts", 3),
      make("T4", "pending", "read", "next", false, "src/next.ts", 4),
    ]), plan);
    expect(text).toContain("(call cited");
    expect(text).toContain("(call current");
    expect(text).toContain("(call pending");
    expect(text).not.toContain("obsolete.md");
    expect(text).not.toContain("CURRENT unresolved tool errors");
  });

  it("surfaces recent unresolved failures only, never a failed call superseded by success", () => {
    const text = renderDecisionWorkLog(ledger([
      make("T1", "resolved", "bash", "open", true, "npm test", 1),
      make("T2", "recovered", "bash", "open", false, "npm test", 2),
      make("T3", "old_closed", "read", "finished", true, "old.txt", 3),
      make("T4", "still_bad", "read", "open", true, "missing.txt", 4),
    ]), plan);
    expect(text).toContain("CURRENT unresolved tool errors");
    expect(text).toContain("call still_bad");
    expect(text).toContain("call recovered");
    expect(text).not.toContain("call resolved");
    expect(text).not.toContain("old_closed");
  });

  it("does not resurrect a failure outside the bounded error window", () => {
    const calls = [make("T1", "old_fail", "read", "open", true, "x", 1)];
    for (let i = 2; i <= 15; i++) calls.push(make("T" + i, "ok_" + i, "read", "open", false, "f" + i, i));
    const text = renderDecisionWorkLog(ledger(calls), plan);
    expect(text).not.toContain("old_fail");
    expect(text).toContain("ok_15");
  });

  it("falls back to recent success when no plan exists", () => {
    const text = renderDecisionWorkLog(ledger([
      make("T1", "wrong", "read", "old", true, "failed", 1),
      make("T2", "right", "read", undefined, false, "valid", 2),
    ]));
    expect(text).toContain("call right");
    expect(text).not.toContain("call wrong");
    expect(renderDecisionWorkLog(ledger([]), plan)).toBe("");
  });
});

describe("opt-in decision memory policy", () => {
  it("requires extended essentials, validates the option and preserves the default configuration", () => {
    expect(parseWorkerCompaction({ essentials: "extended", decisionMemory: true })).toMatchObject({
      policy: "window-ratio", essentials: "extended", decisionMemory: true,
    });
    expect(parseWorkerCompaction({ essentials: "extended" })).not.toHaveProperty("decisionMemory");
    expect(() => parseWorkerCompaction({ decisionMemory: true })).toThrow(/requires essentials extended/);
    expect(() => parseWorkerCompaction({ essentials: "extended", decisionMemory: "yes" })).toThrow(/decisionMemory/);
  });

  it("adds summary guidance only when enabled; older failures remain observations", () => {
    const enabled = summaryBudgetNote(4096, { decisionMemory: true, profile: "compact" });
    const disabled = summaryBudgetNote(4096, { profile: "compact" });
    expect(enabled).toContain("not standing instructions");
    expect(enabled).toContain("unresolved failures with source call IDs");
    expect(disabled).not.toContain("not standing instructions");
    expect(disabled).toContain("failed attempts with their cause");
    const session = {};
    expect(() => { setSummaryDecisionMemory(session, true); setSummaryDecisionMemory(session, false); }).not.toThrow();
  });
});
