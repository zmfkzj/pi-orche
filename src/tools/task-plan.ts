import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const MAX_TASK_PLAN_BYTES = 64 * 1024;
const MAX_NODES = 60;
const nodeId = Type.String({ minLength: 1, maxLength: 100 });
export const taskPlanParameters = Type.Object({
  nodes: Type.Array(Type.Object({
    id: nodeId, title: Type.String({ minLength: 1, maxLength: 200 }),
    dependsOn: Type.Array(nodeId, { maxItems: MAX_NODES, uniqueItems: true }),
    covers: Type.Array(Type.String({ pattern: "^R[1-9][0-9]*$", maxLength: 100 }), { maxItems: MAX_NODES, uniqueItems: true }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_NODES }),
}, { additionalProperties: false });
export type TaskPlan = Static<typeof taskPlanParameters>;

/** Validate the whole replacement before publishing anything. Stable dependency-first order. */
export function orderTaskPlan(plan: TaskPlan): TaskPlan["nodes"] {
  if (!Value.Check(taskPlanParameters, plan)) {
    const error = Value.Errors(taskPlanParameters, plan).First()!;
    throw new Error(`Invalid task_plan: ${error.path}: ${error.message}`);
  }
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > MAX_TASK_PLAN_BYTES) throw new Error(`Task DAG exceeds ${MAX_TASK_PLAN_BYTES} bytes; shorten ids, dependency lists and notes.`);
  if (plan.nodes.filter(node => node.status === "running").length > 1) throw new Error("At most one node may be running; execute the DAG sequentially.");
  const nodes = new Map<string, TaskPlan["nodes"][number]>();
  for (const node of plan.nodes) {
    if (nodes.has(node.id)) throw new Error(`Duplicate node id ${node.id}; use unique ids.`);
    nodes.set(node.id, node);
  }
  const result: TaskPlan["nodes"] = [];
  const active = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error(`Cycle at ${id}; remove a dependency to make the plan acyclic.`);
    if (visited.has(id)) return;
    const node = nodes.get(id)!;
    active.add(id);
    for (const dependency of node.dependsOn) {
      const dep = nodes.get(dependency);
      if (!dep) throw new Error(`Node ${id} depends on unknown ${dependency}; add that node or remove the dependency.`);
      visit(dependency);
      if (node.status === "done" && !["done", "skipped"].includes(dep.status)) throw new Error(`Node ${id} cannot be done while dependency ${dependency} is ${dep.status}; finish/skip the dependency first.`);
    }
    active.delete(id); visited.add(id); result.push(node);
  };
  for (const id of nodes.keys()) visit(id);
  return result;
}

export function renderTaskPlan(plan: TaskPlan): string {
  const ordered = orderTaskPlan(plan);
  const finished = new Set(ordered.filter(node => ["done", "skipped"].includes(node.status)).map(node => node.id));
  const next = ordered.find(node => node.status === "pending" && node.dependsOn.every(id => finished.has(id)));
  return [...ordered.map(node => `${node.id} [${node.status}] ${node.title} (${node.covers.join(", ") || "no requirements"})${node.dependsOn.length ? ` <- ${node.dependsOn.join(", ")}` : ""}${node.note ? ` — ${node.note}` : ""}`), `Next ready: ${next ? `${next.id} — ${next.title}` : "none"}`].join("\n");
}

export function createTaskPlanTool(onPlan: (plan: TaskPlan) => void, requiredIds: readonly string[] | (() => readonly string[]) = []): ToolDefinition {
  return {
    name: "task_plan", label: "Task plan", description: "Replace the current Task DAG. Cover every requirement id, execute nodes sequentially in dependency order and update statuses as work progresses.",
    parameters: taskPlanParameters,
    execute: async (_id, args) => {
      try {
        const incoming = args as TaskPlan;
        const rendered = renderTaskPlan(incoming); // Validate before cloning or publishing a potentially huge plan.
        const ids = typeof requiredIds === "function" ? requiredIds() : requiredIds;
        const covered = new Set(incoming.nodes.flatMap(node => node.covers));
        const unknown = ids.length ? [...covered].filter(id => !ids.includes(id)) : [];
        if (unknown.length) throw new Error(`Unknown covers ids: ${unknown.join(", ")}; use only this assignment's requirement ids (${ids.join(", ")}).`);
        const uncovered = ids.filter(id => !covered.has(id));
        const text = rendered + (uncovered.length ? `\nWarning: uncovered request ids: ${uncovered.join(", ")}; add nodes covering them.` : "");
        const plan = structuredClone(incoming);
        onPlan(plan);
        return { content: [{ type: "text", text }], details: { plan } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
      }
    },
  };
}
