import { describe, expect, it } from "vitest";
import { beginReportPhase, beginThinkingPolicy, FIXED_THINKING_POLICY, onTaskPlan, PHASE_THINKING_POLICY, phaseTarget, reportRewriteReason, requireReplan, thinkingPolicySummary } from "../../src/pi/thinking-policy.js";
import { noteRequestLevel, readLevelFor, READ_LEVEL, thinkingStateOf } from "../../src/pi/thinking-state.js";
import { readNodeAllows, readNodeRefusal } from "../../src/pi/read-node-guard.js";
import { createTaskPlanTool, type TaskPlan } from "../../src/tools/task-plan.js";

/** A Pi session double: Pi's clamp (an unsupported level goes to the next supported one above, else below). */
function session(levels: string[], level: string, model?: { provider: string; id: string; api: string }) {
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const clamp = (wanted: string) => {
    if (levels.includes(wanted)) return wanted;
    const index = order.indexOf(wanted);
    for (let i = index; i < order.length; i++) if (levels.includes(order[i]!)) return order[i]!;
    for (let i = index - 1; i >= 0; i--) if (levels.includes(order[i]!)) return order[i]!;
    return levels[0] ?? "off";
  };
  const double = {
    thinkingLevel: clamp(level),
    setThinkingLevel(wanted: never) { double.thinkingLevel = clamp(wanted); },
    getAvailableThinkingLevels: () => [...levels],
    ...(model ? { model } : {}),
  };
  return double;
}
const OPUS_5_5 = ["low", "medium", "high", "xhigh", "max"];
const FLASH_IMAGE = ["minimal", "high"];
const PI_DEFAULT = ["off", "minimal", "low", "medium", "high"];
type Node = TaskPlan["nodes"][number];
const node = (id: string, status: Node["status"], extra: Partial<Node> = {}, dependsOn: string[] = []): Node => ({ id, title: `Work ${id}`, dependsOn, covers: ["R1"], status, ...extra });
const plan = (...nodes: Node[]): TaskPlan => ({ nodes });
const done = (id: string, extra: Partial<Node> = {}) => node(id, "done", { checkpoint: { result: "ok", evidence: ["a.ts:1"], verification: "passed" }, ...extra });
/** One model request at the session's current level (what agent-manager notes when a response starts). */
const request = (s: ReturnType<typeof session>) => noteRequestLevel(s);

describe("read level R: explicit low, never above B, never off", () => {
  it.each([
    ["opus max", OPUS_5_5, "max", "low"],
    ["opus xhigh", OPUS_5_5, "xhigh", "low"],
    ["opus medium", OPUS_5_5, "medium", "low"],
    ["opus low (already low)", OPUS_5_5, "low", "low"],
    ["Pi default high", PI_DEFAULT, "high", "low"],
    ["Pi default minimal (below low: never raised)", PI_DEFAULT, "minimal", "minimal"],
    ["flash image high (minimal and high only)", FLASH_IMAGE, "high", "minimal"],
    ["only high and max (nothing at or below low): B", ["high", "max"], "max", "max"],
    ["off is never R", ["off", "high"], "high", "high"],
  ])("%s", (_name, levels, baseline, expected) => {
    expect(readLevelFor(levels, baseline)).toBe(expected);
  });
  it("is not relative to B: the same R whatever B is above low", () => {
    expect(READ_LEVEL).toBe("low");
    expect(new Set(["medium", "high", "xhigh", "max"].map(level => readLevelFor(OPUS_5_5, level)))).toEqual(new Set(["low"]));
  });
  it("effective aliases: a level a proxy maps above low does not count as low", () => {
    expect(readLevelFor(OPUS_5_5, "max", { low: "medium" })).toBe("max"); // the only candidate runs as medium: no read level
  });
});

describe("read nodes in every thinking policy", () => {
  for (const [name, policy] of [["fixed", FIXED_THINKING_POLICY], ["phase", PHASE_THINKING_POLICY]] as const) {
    it(`${name}: a running read node runs at low; the next node without read is back at B (not S); integration and report at B`, () => {
      const s = session(OPUS_5_5, "max");
      beginThinkingPolicy(s, policy, "max", "implement");
      onTaskPlan(s, plan(node("R0", "running", { read: true }), node("N1", "pending", {}, ["R0"]), node("N2", "pending", { phase: "integrate" }, ["N1"])));
      expect(s.thinkingLevel).toBe("low");
      expect(thinkingStateOf(s).phase).toBe("read");
      onTaskPlan(s, plan(done("R0", { read: true }), node("N1", "running", {}, ["R0"]), node("N2", "pending", { phase: "integrate" }, ["N1"])));
      expect(s.thinkingLevel).toBe(name === "phase" ? "xhigh" : "max"); // phase: the ordinary node at S as before; fixed: B
      onTaskPlan(s, plan(done("R0", { read: true }), done("N1"), node("N2", "running", { phase: "integrate" }, ["N1"])));
      expect(s.thinkingLevel).toBe("max");
    });
    it(`${name}: a read node that is reworked (reopened, or its check failed) runs at B`, () => {
      const s = session(OPUS_5_5, "max");
      beginThinkingPolicy(s, policy, "max", "implement");
      onTaskPlan(s, plan(node("R0", "running", { read: true }), node("N1", "pending", {}, ["R0"])));
      expect(s.thinkingLevel).toBe("low");
      onTaskPlan(s, plan(done("R0", { read: true }), node("N1", "running", {}, ["R0"])));
      onTaskPlan(s, plan(node("R0", "running", { read: true }), node("N1", "pending", {}, ["R0"])));
      expect(s.thinkingLevel).toBe("max");
      const t = session(OPUS_5_5, "max");
      beginThinkingPolicy(t, policy, "max", "implement");
      onTaskPlan(t, plan(node("R0", "running", { read: true, checkpoint: { result: "the file was missing", evidence: ["T1"], verification: "failed" } })));
      expect(t.thinkingLevel).toBe("max");
    });
    it(`${name}: a rejected task_plan or a message from main while reading returns to B until the next accepted plan`, () => {
      const s = session(OPUS_5_5, "max");
      beginThinkingPolicy(s, policy, "max", "implement");
      onTaskPlan(s, plan(node("R0", "running", { read: true })));
      expect(s.thinkingLevel).toBe("low");
      requireReplan(s, "message from main");
      expect(s.thinkingLevel).toBe("max");
      onTaskPlan(s, plan(node("R0", "running", { read: true })));
      expect(s.thinkingLevel).toBe("low");
    });
    it(`${name}: a report written in a read response is sent back and rewritten at B; the report phase pins B (no loop)`, () => {
      const s = session(OPUS_5_5, "max");
      beginThinkingPolicy(s, policy, "max", "implement");
      onTaskPlan(s, plan(node("R0", "running", { read: true })));
      request(s);
      expect(reportRewriteReason(s)).toContain("written at the reduced read effort (low)");
      expect(s.thinkingLevel).toBe("max");
      onTaskPlan(s, plan(node("R0", "running", { read: true }))); // a later plan cannot bring the report back to R
      expect(s.thinkingLevel).toBe("max");
      request(s);
      expect(reportRewriteReason(s)).toBeUndefined();
    });
    it(`${name}: runtime report prompts start the report phase at B`, () => {
      const s = session(OPUS_5_5, "max");
      beginThinkingPolicy(s, policy, "max", "implement");
      onTaskPlan(s, plan(node("R0", "running", { read: true })));
      expect(beginReportPhase(s, "missing result")).toBe("max");
    });
    it(`${name}: the next assignment starts at its own B; read requests are counted in the summary`, () => {
      const s = session(OPUS_5_5, "max");
      beginThinkingPolicy(s, policy, "max", "implement");
      request(s);
      onTaskPlan(s, plan(node("R0", "running", { read: true })));
      request(s); request(s);
      expect(thinkingPolicySummary(s)).toMatchObject({ mode: name, read: "low", requests: { total: 3, read: 2, belowBaseline: 2 } });
      beginThinkingPolicy(s, policy, "high", "implement");
      expect(s.thinkingLevel).toBe("high");
      expect(thinkingPolicySummary(s)).toMatchObject({ requests: { total: 0, read: 0 }, read: "low" });
    });
  }
  it("fixed mode without read nodes changes nothing (regression)", () => {
    const s = session(OPUS_5_5, "max");
    beginThinkingPolicy(s, FIXED_THINKING_POLICY, "max", "implement");
    expect(onTaskPlan(s, plan(node("N1", "running", { hard: true }), node("N2", "pending")))).toEqual([]);
    expect(s.thinkingLevel).toBe("max");
    request(s);
    expect(reportRewriteReason(s)).toBeUndefined();
  });
  it("phaseTarget: hard or integration never reads (task_plan also refuses that combination)", () => {
    const target = (extra: Partial<Node>) => phaseTarget(FIXED_THINKING_POLICY, plan(node("R0", "running", { read: true, ...extra })), { escalated: new Map(), replan: false, current: "baseline" }).phase;
    expect(target({})).toBe("read");
    expect(target({ hard: true })).toBe("baseline");
    expect(target({ phase: "integrate" })).toBe("baseline");
  });
});

describe("the read-node tool boundary", () => {
  it("allows only reading tools while a read node runs; edits, commands, checks and spawns are refused with what to do", () => {
    const s = session(OPUS_5_5, "max");
    beginThinkingPolicy(s, FIXED_THINKING_POLICY, "max", "implement");
    expect(readNodeRefusal(s, "edit")).toBeUndefined();
    onTaskPlan(s, plan(node("R0", "running", { read: true })));
    for (const tool of ["read", "grep", "find", "ls", "ast_search", "browser_fetch", "task_plan", "report_result", "codegraph_explore", "mcp__codegraph__codegraph_explore"]) expect(readNodeRefusal(s, tool), tool).toBeUndefined();
    for (const tool of ["edit", "write", "bash", "ast_rewrite", "diagnostics", "orche_spawn", "generate_image"]) expect(readNodeRefusal(s, tool), tool).toContain("Blocked: a read node is running at low effort");
    expect(readNodeAllows("codegraph_search")).toBe(true);
  });
  it("the rest of a response that ran at R stays read-only, also after task_plan left the read node", () => {
    const s = session(OPUS_5_5, "max");
    beginThinkingPolicy(s, FIXED_THINKING_POLICY, "max", "implement");
    onTaskPlan(s, plan(node("R0", "running", { read: true }), node("N1", "pending", {}, ["R0"])));
    request(s); // this response runs at low
    onTaskPlan(s, plan(done("R0", { read: true }), node("N1", "running", {}, ["R0"])));
    expect(s.thinkingLevel).toBe("max");
    expect(readNodeRefusal(s, "edit")).toContain("this response ran at the read effort (low)");
    request(s); // the next response runs at B
    expect(readNodeRefusal(s, "edit")).toBeUndefined();
  });
  it("task_plan refuses read:true together with hard or phase integrate, and keeps an omitted read flag", async () => {
    let accepted: TaskPlan | undefined;
    const tool = createTaskPlanTool(next => { accepted = next; }, [], { previous: () => accepted });
    const run = (nodes: Node[]) => tool.execute("id", { nodes } as never, undefined as never, undefined as never, undefined as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    const refused = await run([node("R0", "running", { read: true, hard: true })]);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Invalid read nodes: R0 is marked read:true and also hard");
    expect((await run([node("R0", "running", { read: true, phase: "integrate" })])).content[0]!.text).toContain("also phase integrate");
    const ok = await run([node("R0", "running", { read: true }), node("N1", "pending", {}, ["R0"])]);
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toContain("R0 [running] {read}");
    await run([node("R0", "done", { checkpoint: { result: "read", evidence: ["a.ts:1"], verification: "not_applicable" } }), node("N1", "running", {}, ["R0"])]);
    expect(accepted!.nodes[0]!.read).toBe(true);
  });
});

describe("advertised capabilities (callers such as the agent_workflow harness gate on them)", () => {
  it("package.json piOrche.capabilities names task_plan.readNodes and oneshot.summaryBudget; the task_plan schema has read", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { taskPlanParameters } = await import("../../src/tools/task-plan.js");
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "../../package.json"), "utf8")) as { piOrche?: { capabilities?: string[] } };
    expect(pkg.piOrche?.capabilities).toEqual(expect.arrayContaining(["task_plan.readNodes", "oneshot.summaryBudget"]));
    expect(pkg.piOrche?.capabilities).not.toContain("oneshot.thinkingPolicy");
    expect(JSON.stringify(taskPlanParameters)).toContain('"read"');
  });
});
