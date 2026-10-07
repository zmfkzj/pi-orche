import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { schemaErrors } from "../orchestration/schema-errors.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const MAX_TASK_PLAN_BYTES = 64 * 1024;
/** Titles are stored and rendered at most this long; longer input is accepted and shortened with an ellipsis. */
export const MAX_TITLE_CHARS = 200;
/** Schema limit for incoming titles: generous, so a verbose title never fails the whole call. */
export const MAX_INPUT_TITLE_CHARS = 2000;
const MAX_NODES = 60;
const REQUIREMENT_ID = /^R[1-9][0-9]*$/;
const nodeId = Type.String({ minLength: 1, maxLength: 100 });
export const taskPlanParameters = Type.Object({
  nodes: Type.Array(Type.Object({
    id: nodeId,
    title: Type.String({ minLength: 1, maxLength: MAX_INPUT_TITLE_CHARS, description: `Short title; longer than ${MAX_TITLE_CHARS} characters is shortened` }),
    dependsOn: Type.Array(nodeId, { maxItems: MAX_NODES, uniqueItems: true }),
    // The R-id format is checked by the tool (one error listing every bad value and the valid ids), not by a bare pattern.
    covers: Type.Array(Type.String({ minLength: 1, maxLength: 100, description: "Bare requirement id, e.g. R3" }), { maxItems: MAX_NODES, uniqueItems: true }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_NODES }),
}, { additionalProperties: false });
export type TaskPlan = Static<typeof taskPlanParameters>;

function checkSchema(plan: TaskPlan): void {
  if (!Value.Check(taskPlanParameters, plan)) {
    throw new Error(`Invalid task_plan: ${schemaErrors(taskPlanParameters, plan, 1)[0] ?? "invalid plan"}`);
  }
}

/** One error for every covers value that is not a bare requirement id, with the valid ids when known. */
function checkCoversFormat(nodes: TaskPlan["nodes"], validIds: readonly string[]): void {
  const bad = nodes.flatMap(node => node.covers.filter(value => !REQUIREMENT_ID.test(value)).map(value => ({ node: node.id, value })));
  if (!bad.length) return;
  const suggest = (value: string) => /R[1-9][0-9]*/.exec(value)?.[0];
  const listed = bad.map(({ node, value }) => {
    const id = suggest(value);
    return `${JSON.stringify(value)} (node ${node}${id && id !== value ? `; did you mean ${id}?` : ""})`;
  });
  const example = bad.map(({ value }) => suggest(value)).find(id => id !== undefined) ?? validIds[0] ?? "R3";
  throw new Error(`Invalid covers ids: ${listed.join(", ")}. covers takes requirement ids only — use the bare id, e.g. ${example}; put qualifiers like "revised" or "partial" in the title or note. ${validIds.length ? `Valid ids for this assignment: ${validIds.join(", ")}.` : "Requirement ids look like R1, R2, ..."}`);
}

const shorten = (title: string) => title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;

/** Copy of a schema-valid plan whose titles fit {@link MAX_TITLE_CHARS}; `shortened` lists the node ids whose title was cut. */
export function normalizeTaskPlan(plan: TaskPlan): { plan: TaskPlan; shortened: string[] } {
  checkSchema(plan);
  const shortened = plan.nodes.filter(node => node.title.length > MAX_TITLE_CHARS).map(node => node.id);
  if (!shortened.length) return { plan, shortened };
  return { plan: { ...plan, nodes: plan.nodes.map(node => node.title.length > MAX_TITLE_CHARS ? { ...node, title: shorten(node.title) } : node) }, shortened };
}

/** Validate the whole replacement before publishing anything. Stable dependency-first order. */
export function orderTaskPlan(plan: TaskPlan): TaskPlan["nodes"] {
  checkSchema(plan);
  checkCoversFormat(plan.nodes, []);
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
  return [...ordered.map(node => `${node.id} [${node.status}] ${shorten(node.title)} (${node.covers.join(", ") || "no requirements"})${node.dependsOn.length ? ` <- ${node.dependsOn.join(", ")}` : ""}${node.note ? ` — ${node.note}` : ""}`), `Next ready: ${next ? `${next.id} — ${shorten(next.title)}` : "none"}`].join("\n");
}

export function createTaskPlanTool(onPlan: (plan: TaskPlan) => void, requiredIds: readonly string[] | (() => readonly string[]) = []): ToolDefinition {
  return {
    name: "task_plan", label: "Task plan", description: `Replace the current Task DAG. Cover every requirement id (bare ids like R3 in covers), execute nodes sequentially in dependency order and update statuses as work progresses. Keep titles short (over ${MAX_TITLE_CHARS} characters they are shortened); details go in note.`,
    parameters: taskPlanParameters,
    execute: async (_id, args) => {
      try {
        const ids = typeof requiredIds === "function" ? requiredIds() : requiredIds;
        const { plan: incoming, shortened } = normalizeTaskPlan(args as TaskPlan); // Schema first: never clone or publish a malformed plan.
        checkCoversFormat(incoming.nodes, ids);
        const rendered = renderTaskPlan(incoming); // Validate before cloning or publishing a potentially huge plan.
        const covered = new Set(incoming.nodes.flatMap(node => node.covers));
        const unknown = ids.length ? [...covered].filter(id => !ids.includes(id)) : [];
        if (unknown.length) throw new Error(`Unknown covers ids: ${unknown.join(", ")}; use only this assignment's requirement ids (${ids.join(", ")}).`);
        const uncovered = ids.filter(id => !covered.has(id));
        const text = rendered
          + (uncovered.length ? `\nWarning: uncovered request ids: ${uncovered.join(", ")}; add nodes covering them.` : "")
          + (shortened.length ? `\nNote: title${shortened.length > 1 ? "s" : ""} of ${shortened.join(", ")} exceeded ${MAX_TITLE_CHARS} characters and ${shortened.length > 1 ? "were" : "was"} shortened with "…"; keep titles short and put details in note.` : "");
        const plan = structuredClone(incoming);
        onPlan(plan);
        return { content: [{ type: "text", text }], details: { plan } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
      }
    },
  };
}
