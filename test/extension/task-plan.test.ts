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
    ["long title", [{ ...node("a"), title: "x".repeat(201) }], /200/],
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
});
