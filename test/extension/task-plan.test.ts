import { describe, expect, it } from "vitest";
import { createTaskPlanTool, MAX_TASK_PLAN_BYTES, orderTaskPlan, renderTaskPlan, type TaskPlan } from "../../src/tools/task-plan.js";

const node = (id: string, dependsOn: string[] = [], status: TaskPlan["nodes"][number]["status"] = "pending") => ({ id, title: `Work ${id}`, dependsOn, covers: ["R1"], status });
describe("task_plan replacement DAG", () => {
  it.each([
    ["unique ids", [node("a"), node("a")], /Duplicate/],
    ["unknown dependencies", [node("a", ["missing"])], /unknown missing/],
    ["cycles", [node("a", ["b"]), node("b", ["a"])], /Cycle/],
    ["done with unfinished dependencies", [node("a"), node("b", ["a"], "done")], /cannot be done/],
    ["invalid status", [{ ...node("a"), status: "finished" }], /status/],
    ["empty plan", [], /greater or equal to 1/],
    ["too many nodes", Array.from({ length: 61 }, (_, i) => node(`n${i}`)), /less or equal to 60/],
    ["title over the input limit", [{ ...node("a"), title: "x".repeat(2001) }], /2000/],
    ["covers that are not bare requirement ids", [{ ...node("a"), covers: ["R3-revised"] }], /Invalid covers ids: "R3-revised" \(node a; did you mean R3\?\)/],
    ["long note", [{ ...node("a"), note: "x".repeat(501) }], /500/],
    ["two running nodes", [node("a", [], "running"), node("b", [], "running")], /At most one node/],
    ["oversized extra field", [{ ...node("a"), arbitrary: "x".repeat(100_000) }], /Unexpected property/],
  ])("rejects %s with actionable errors", (_name, nodes, error) => {
    expect(() => orderTaskPlan({ nodes } as TaskPlan)).toThrow(error);
  });
  it("renders in topological order with next ready and allows skipped dependencies", () => {
    const plan = { nodes: [node("c", ["b"]), node("b", ["a"]), node("a", [], "skipped")] };
    expect(orderTaskPlan(plan).map(n => n.id)).toEqual(["a", "b", "c"]);
    expect(renderTaskPlan(plan)).toBe("a [skipped] Work a (R1)\nb [pending] Work b (R1) <- a\nc [pending] Work c (R1) <- b\nNext ready: b — Work b");
    expect(() => orderTaskPlan({ nodes: [node("a", [], "skipped"), node("b", ["a"], "done")] })).not.toThrow();
  });
  it("each accepted call replaces the plan and invalid calls leave it unchanged", async () => {
    let latest: TaskPlan | undefined;
    const tool = createTaskPlanTool(plan => { latest = plan; });
    await tool.execute("1", { nodes: [node("a")] }, undefined as never, undefined as never, undefined as never);
    await tool.execute("2", { nodes: [node("b")] }, undefined as never, undefined as never, undefined as never);
    expect(latest?.nodes.map(n => n.id)).toEqual(["b"]);
    const rejected = await tool.execute("3", { nodes: [node("c", ["unknown"])] }, undefined as never, undefined as never, undefined as never);
    expect(rejected.isError).toBe(true);
    expect(latest?.nodes.map(n => n.id)).toEqual(["b"]);
  });
});

describe("bounded assignment-local task_plan", () => {
  it("accepts length/count limits inclusively and rejects an oversized event or reinjection payload", () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ ...node(`n${i}`), title: "x".repeat(200), note: "y".repeat(500) }));
    expect(orderTaskPlan({ nodes })).toHaveLength(60);
    const oversized = nodes.map(n => ({ ...n, title: "한".repeat(200), note: "한".repeat(500) }));
    expect(Buffer.byteLength(JSON.stringify({ nodes: oversized }))).toBeGreaterThan(MAX_TASK_PLAN_BYTES);
    expect(() => orderTaskPlan({ nodes: oversized })).toThrow(/exceeds 65536 bytes/);
    expect(Buffer.byteLength(renderTaskPlan({ nodes }))).toBeLessThan(MAX_TASK_PLAN_BYTES);
  });
  it("rejects unknown covers, warns about uncovered request ids and reads the current assignment ids", async () => {
    let ids = ["R1", "R2"];
    let latest: TaskPlan | undefined;
    const tool = createTaskPlanTool(plan => { latest = plan; }, () => ids);
    const execute = (covers: string[]) => tool.execute("test", { nodes: [{ ...node("a"), covers }] }, undefined as never, undefined as never, undefined as never);
    const unknown = await execute(["R99"]);
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toEqual([{ type: "text", text: "Unknown covers ids: R99; use only this assignment's requirement ids (R1, R2)." }]);
    expect(latest).toBeUndefined();
    const partial = await execute(["R1"]);
    expect(partial.isError).not.toBe(true);
    expect(partial.content).toEqual([{ type: "text", text: "a [pending] Work a (R1)\nNext ready: a — Work a\nWarning: uncovered request ids: R2; add nodes covering them." }]);
    const emptyCoverage = await execute([]);
    expect(JSON.stringify(emptyCoverage.content)).toContain("uncovered request ids: R1, R2");
    ids = ["R3"];
    expect((await execute(["R1"])).isError).toBe(true);
    expect((await execute(["R3"])).isError).not.toBe(true);
    ids = [];
    expect((await execute(["R99"])).isError).not.toBe(true); // no R-id request: coverage is advisory.
  });
  it("accepts long titles, stores and renders them shortened to 200 characters and says so", async () => {
    let latest: TaskPlan | undefined;
    const tool = createTaskPlanTool(plan => { latest = plan; }, () => ["R1"]);
    const long = "t".repeat(1500);
    const result = await tool.execute("long", { nodes: [{ ...node("a"), title: long }, { ...node("b", ["a"]), title: "x".repeat(201) }, node("c")] }, undefined as never, undefined as never, undefined as never);
    expect(result.isError).not.toBe(true);
    const titles = latest!.nodes.map(n => n.title);
    expect(titles.map(t => t.length)).toEqual([200, 200, 6]);
    expect(titles[0]).toBe(`${"t".repeat(199)}…`);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`a [pending] ${"t".repeat(199)}… (R1)`);
    expect(text).toContain("Note: titles of a, b exceeded 200 characters and were shortened");
    expect(renderTaskPlan(latest!)).not.toContain("t".repeat(200));
    // 60 nodes of 2000-character titles would exceed the byte limit unshortened; the stored plan fits.
    const many = Array.from({ length: 60 }, (_, i) => ({ ...node(`n${i}`), title: "y".repeat(2000) }));
    expect((await tool.execute("many", { nodes: many }, undefined as never, undefined as never, undefined as never)).isError).not.toBe(true);
    expect(latest!.nodes).toHaveLength(60);
  });
  it("rejects malformed covers in one error that lists every bad value, the valid ids and the bare-id hint", async () => {
    let latest: TaskPlan | undefined;
    const tool = createTaskPlanTool(plan => { latest = plan; }, () => ["R1", "R2", "R3"]);
    const result = await tool.execute("bad", { nodes: [{ ...node("a"), covers: ["R3-revised", "R1"] }, { ...node("b"), covers: ["requirement two"] }] }, undefined as never, undefined as never, undefined as never);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Invalid covers ids: \"R3-revised\" (node a; did you mean R3?), \"requirement two\" (node b). covers takes requirement ids only — use the bare id, e.g. R3; put qualifiers like \"revised\" or \"partial\" in the title or note. Valid ids for this assignment: R1, R2, R3." }]);
    expect(latest).toBeUndefined();
  });
});

describe("task_plan phases and checkpoints (thinkingPolicy, docs/thinking-policy.md)", () => {
  const checkpoint = { result: "greeting fixed", evidence: ["greeting.txt:1", "cat greeting.txt → hello"], verification: "passed" as const };
  const run = (tool: ReturnType<typeof createTaskPlanTool>, nodes: unknown[]) => tool.execute("t", { nodes }, undefined as never, undefined as never, undefined as never);
  const textOf = (result: Awaited<ReturnType<typeof run>>) => (result.content[0] as { text: string }).text;
  it("requires a checkpoint with evidence for a node newly marked done, and verification passed for integration, only when checkpoints are on", async () => {
    let latest: TaskPlan | undefined;
    let required = true;
    const tool = createTaskPlanTool(plan => { latest = plan; }, [], { previous: () => latest, checkpointsRequired: () => required });
    expect(textOf(await run(tool, [node("a", [], "done")]))).toMatch(/^Invalid checkpoints: a is marked done without a checkpoint\. Use checkpoint \{result/);
    expect(textOf(await run(tool, [{ ...node("a", [], "done"), checkpoint: { ...checkpoint, evidence: [] } }]))).toMatch(/a's checkpoint has no evidence/);
    expect((await run(tool, [{ ...node("a", [], "done"), checkpoint }, { ...node("i", ["a"], "running"), phase: "integrate" }])).isError).not.toBe(true);
    expect(textOf(await run(tool, [{ ...node("a", [], "done") }, { ...node("i", ["a"], "done"), phase: "integrate", checkpoint: { ...checkpoint, verification: "not_applicable" } }]))).toMatch(/integration node i is done only with verification "passed"/);
    // The already-done node a kept its checkpoint although the call omitted it.
    expect(latest!.nodes[0]!.checkpoint).toEqual(checkpoint);
    required = false;
    latest = undefined;
    expect((await run(tool, [node("a", [], "done")])).isError).not.toBe(true);
  });
  it("never accepts a node as done whose checkpoint says its verification failed", async () => {
    const tool = createTaskPlanTool(() => undefined);
    expect(textOf(await run(tool, [{ ...node("a", [], "done"), checkpoint: { ...checkpoint, verification: "failed" } }]))).toMatch(/a is done but its checkpoint says verification failed: keep it running to rework it, or mark it blocked/);
    expect((await run(tool, [{ ...node("a", [], "running"), checkpoint: { ...checkpoint, verification: "failed" } }])).isError).not.toBe(true);
  });
  it("keeps phase, hard and an unchanged node's checkpoint when a replacement omits them; a reopened node loses its checkpoint", async () => {
    let latest: TaskPlan | undefined;
    const tool = createTaskPlanTool(plan => { latest = plan; }, [], { previous: () => latest, checkpointsRequired: () => true });
    await run(tool, [{ ...node("a", [], "done"), checkpoint, hard: true }, { ...node("i", ["a"], "pending"), phase: "integrate" }]);
    await run(tool, [node("a", [], "done"), node("i", ["a"], "running")]);
    expect(latest!.nodes).toMatchObject([{ id: "a", hard: true, checkpoint }, { id: "i", phase: "integrate" }]);
    await run(tool, [node("a", [], "running"), node("i", ["a"], "pending")]);
    expect(latest!.nodes[0]!.checkpoint).toBeUndefined();
    expect(latest!.nodes[0]!.hard).toBe(true);
  });
  it("renders phase tags and checkpoints, appends the policy's lines and reports a rejected call", async () => {
    let rejected = "";
    const tool = createTaskPlanTool(() => ["Thinking: the next requests run at medium"], [], { onInvalid: error => { rejected = error; } });
    const text = textOf(await run(tool, [{ ...node("a", [], "done"), checkpoint: { ...checkpoint, open: "locale?" } }, { ...node("b", ["a"], "running"), hard: true }, { ...node("i", ["b"]), phase: "integrate" }]));
    expect(text).toBe([
      "a [done] Work a (R1)",
      "    checkpoint (passed): greeting fixed [greeting.txt:1; cat greeting.txt → hello] open: locale?",
      "b [running] {hard} Work b (R1) <- a",
      "i [pending] {integrate} Work i (R1) <- b",
      "Next ready: none",
      "Thinking: the next requests run at medium",
    ].join("\n"));
    await run(tool, [node("x", ["missing"])]);
    expect(rejected).toMatch(/unknown missing/);
  });
});
