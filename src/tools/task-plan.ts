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
/** Limits of a node checkpoint: a short conclusion, not a transcript (60 checkpointed nodes still fit {@link MAX_TASK_PLAN_BYTES}). */
export const CHECKPOINT_LIMITS = { result: 300, evidenceItems: 4, evidenceChars: 160, open: 200 } as const;
/**
 * What a finished node leaves for the rest of the assignment (docs/thinking-policy.md): its conclusion, the evidence (file:line,
 * command and outcome), whether its verification passed, and open doubts. Never the model's private reasoning.
 */
export const checkpointSchema = Type.Object({
  result: Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.result, description: "Conclusion of the node in one or two sentences" }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: CHECKPOINT_LIMITS.evidenceChars }), { maxItems: CHECKPOINT_LIMITS.evidenceItems, description: "file:line references, commands or tests and their outcomes" }),
  verification: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_applicable")], { description: "passed: its check ran and passed; failed: it ran and failed; not_applicable: nothing to run (e.g. reading code)" }),
  open: Type.Optional(Type.String({ maxLength: CHECKPOINT_LIMITS.open, description: "Open questions or doubts; omit when none" })),
}, { additionalProperties: false });
export type Checkpoint = Static<typeof checkpointSchema>;
export const taskPlanParameters = Type.Object({
  nodes: Type.Array(Type.Object({
    id: nodeId,
    title: Type.String({ minLength: 1, maxLength: MAX_INPUT_TITLE_CHARS, description: `Short title; longer than ${MAX_TITLE_CHARS} characters is shortened` }),
    dependsOn: Type.Array(nodeId, { maxItems: MAX_NODES, uniqueItems: true }),
    // The R-id format is checked by the tool (one error listing every bad value and the valid ids), not by a bare pattern.
    covers: Type.Array(Type.String({ minLength: 1, maxLength: 100, description: "Bare requirement id, e.g. R3" }), { maxItems: MAX_NODES, uniqueItems: true }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("skipped")]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
    phase: Type.Optional(Type.Union([Type.Literal("step"), Type.Literal("integrate")], { description: "step (default): one piece of the work; integrate: comparing every requirement with the actual changes and checks, final verification" })),
    hard: Type.Optional(Type.Boolean({ description: "true: this step needs full effort (design decision, root cause of an unclear failure, concurrency/security, ambiguous requirement, hard-to-reverse change)" })),
    checkpoint: Type.Optional(checkpointSchema),
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

const renderCheckpoint = (checkpoint: Checkpoint): string =>
  `\n    checkpoint (${checkpoint.verification}): ${checkpoint.result}${checkpoint.evidence.length ? ` [${checkpoint.evidence.join("; ")}]` : ""}${checkpoint.open ? ` open: ${checkpoint.open}` : ""}`;

export function renderTaskPlan(plan: TaskPlan): string {
  const ordered = orderTaskPlan(plan);
  const finished = new Set(ordered.filter(node => ["done", "skipped"].includes(node.status)).map(node => node.id));
  const next = ordered.find(node => node.status === "pending" && node.dependsOn.every(id => finished.has(id)));
  const tags = (node: TaskPlan["nodes"][number]) => `${node.phase === "integrate" ? " {integrate}" : ""}${node.hard ? " {hard}" : ""}`;
  return [...ordered.map(node => `${node.id} [${node.status}]${tags(node)} ${shorten(node.title)} (${node.covers.join(", ") || "no requirements"})${node.dependsOn.length ? ` <- ${node.dependsOn.join(", ")}` : ""}${node.note ? ` — ${node.note}` : ""}${node.checkpoint ? renderCheckpoint(node.checkpoint) : ""}`), `Next ready: ${next ? `${next.id} — ${shorten(next.title)}` : "none"}`].join("\n");
}

/**
 * A replacement plan keeps what its nodes already had when it omits it: the phase, the hard flag and, while a node's status is
 * unchanged (a done node stays done), its checkpoint. A reopened node loses its old checkpoint: it no longer stands.
 */
export function carryOver(previous: TaskPlan | undefined, plan: TaskPlan): TaskPlan {
  if (!previous) return plan;
  const before = new Map(previous.nodes.map(node => [node.id, node]));
  return {
    ...plan,
    nodes: plan.nodes.map(node => {
      const old = before.get(node.id);
      if (!old) return node;
      return {
        ...node,
        ...(node.phase === undefined && old.phase !== undefined ? { phase: old.phase } : {}),
        ...(node.hard === undefined && old.hard !== undefined ? { hard: old.hard } : {}),
        ...(node.checkpoint === undefined && old.checkpoint && node.status === old.status ? { checkpoint: old.checkpoint } : {}),
      };
    }),
  };
}

export const CHECKPOINT_FORMAT = 'checkpoint {result: one or two sentences, evidence: ["file:line", "command -> outcome"], verification: "passed" | "failed" | "not_applicable", open?: "doubts"}, never your private reasoning';

/**
 * Checkpoint rules. Always: a node whose verification failed is not done. With `required` (thinkingPolicy checkpoints), a node newly
 * marked done needs a checkpoint with evidence, and an integration node needs verification "passed".
 */
export function checkCheckpoints(previous: TaskPlan | undefined, plan: TaskPlan, required: boolean): void {
  const wasDone = new Set((previous?.nodes ?? []).filter(node => node.status === "done").map(node => node.id));
  const errors: string[] = [];
  for (const node of plan.nodes) {
    const checkpoint = node.checkpoint;
    if (node.status === "done" && checkpoint?.verification === "failed") {
      errors.push(`${node.id} is done but its checkpoint says verification failed: keep it running to rework it, or mark it blocked`);
      continue;
    }
    if (!required || node.status !== "done" || wasDone.has(node.id)) continue;
    if (!checkpoint) errors.push(`${node.id} is marked done without a checkpoint`);
    else if (!checkpoint.evidence.length) errors.push(`${node.id}'s checkpoint has no evidence`);
    else if (node.phase === "integrate" && checkpoint.verification !== "passed") errors.push(`integration node ${node.id} is done only with verification "passed" after comparing every requirement with the actual changes and checks`);
  }
  if (errors.length) throw new Error(`Invalid checkpoints: ${errors.join("; ")}. Use ${CHECKPOINT_FORMAT}.`);
}

export interface TaskPlanToolOptions {
  /** The current plan of the assignment (carry-over and checkpoint rules). */
  previous?: () => TaskPlan | undefined;
  /** Whether a node newly marked done needs a checkpoint (thinkingPolicy checkpoints). */
  checkpointsRequired?: () => boolean;
  /** Called with the error of a rejected call (the plan stays as it was). */
  onInvalid?: (error: string) => void;
}

/**
 * `onPlan` gets every accepted plan (after carry-over) and may return lines for the tool result (e.g. the thinking level the next
 * request runs at).
 */
export function createTaskPlanTool(onPlan: (plan: TaskPlan) => void | readonly string[], requiredIds: readonly string[] | (() => readonly string[]) = [], options: TaskPlanToolOptions = {}): ToolDefinition {
  return {
    name: "task_plan", label: "Task plan", description: `Replace the current Task DAG. Cover every requirement id (bare ids like R3 in covers), execute nodes sequentially in dependency order and update statuses as work progresses. Keep titles short (over ${MAX_TITLE_CHARS} characters they are shortened); details go in note. Optional per node: phase "integrate" for requirement comparison and final verification, hard:true for a step that needs full effort, and a checkpoint when the node is finished (${CHECKPOINT_FORMAT}). Omitted phase, hard and checkpoints of unchanged nodes are kept from the previous plan.`,
    parameters: taskPlanParameters,
    execute: async (_id, args) => {
      try {
        const ids = typeof requiredIds === "function" ? requiredIds() : requiredIds;
        const { plan: normalized, shortened } = normalizeTaskPlan(args as TaskPlan); // Schema first: never clone or publish a malformed plan.
        checkCoversFormat(normalized.nodes, ids);
        const previous = options.previous?.();
        const incoming = carryOver(previous, normalized);
        const rendered = renderTaskPlan(incoming); // Validate before cloning or publishing a potentially huge plan.
        checkCheckpoints(previous, incoming, options.checkpointsRequired?.() ?? false);
        const covered = new Set(incoming.nodes.flatMap(node => node.covers));
        const unknown = ids.length ? [...covered].filter(id => !ids.includes(id)) : [];
        if (unknown.length) throw new Error(`Unknown covers ids: ${unknown.join(", ")}; use only this assignment's requirement ids (${ids.join(", ")}).`);
        const uncovered = ids.filter(id => !covered.has(id));
        const plan = structuredClone(incoming);
        const notes = onPlan(plan) ?? [];
        const text = rendered
          + (uncovered.length ? `\nWarning: uncovered request ids: ${uncovered.join(", ")}; add nodes covering them.` : "")
          + (shortened.length ? `\nNote: title${shortened.length > 1 ? "s" : ""} of ${shortened.join(", ")} exceeded ${MAX_TITLE_CHARS} characters and ${shortened.length > 1 ? "were" : "was"} shortened with "…"; keep titles short and put details in note.` : "")
          + notes.map(line => `\n${line}`).join("");
        return { content: [{ type: "text", text }], details: { plan } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { options.onInvalid?.(message); } catch { /* observers cannot change the result */ }
        return { content: [{ type: "text", text: message }], details: {}, isError: true };
      }
    },
  };
}
