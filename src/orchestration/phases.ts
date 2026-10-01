import { isBacklogDone, readyTasks, validateBacklog, normalizeOwnedPath, type BacklogIssue, type TaskItem } from "./backlog.js";

export type Phase = "EXPLORE" | "CONVERGE" | "BACKLOG" | "EXECUTE" | "VERIFY" | "DONE" | "FAILED";
export type TaskClass = "answer" | "change" | "diagnose_fix";
export interface Explorer {
  readonly agentId: string;
  readonly status: "idle" | "running";
  /** Completed read-only response available for an answer_from_worker decision. */
  readonly answer?: string;
}
export interface RootCause { readonly cause: string; readonly sourceAgentId: string; readonly evidence: readonly string[] }
export interface PhaseState {
  readonly phase: Phase;
  readonly fixRounds: number;
  readonly maxFixRounds: number;
  /** Upper bound for the classification's workerCount. */
  readonly maxWorkers: number;
  readonly rootCause?: RootCause;
  readonly tasks: readonly TaskItem[];
  readonly summary?: string;
  readonly failure?: string;
  readonly taskClass?: TaskClass;
  readonly workerCount?: number;
  readonly language?: string;
  readonly answer?: string;
}
export type CoordinatorDecision =
  | { type: "classify"; taskClass: TaskClass; workerCount: number; language: string; reason: string }
  | { type: "answer"; answer: string; summary: string }
  | { type: "answer_from_worker"; sourceAgentId: string; summary: string }
  | { type: "continue_exploration" }
  | ({ type: "root_cause_accepted" } & RootCause)
  | { type: "collect_backlog" }
  | { type: "assign"; tasks: readonly TaskItem[] }
  | { type: "verify" }
  | { type: "verification_failed"; reason: string }
  /** Some backlog tasks were reported blocked: return to BACKLOG for a revised plan (counts as a fix round). */
  | { type: "replan"; reason: string }
  | { type: "complete"; summary: string }
  | { type: "fail"; reason: string };
export type CoordinatorEffect =
  | { type: "redirect"; agentId: string; assignment: "backlog_proposal"; rootCause: RootCause }
  | { type: "assign_proposal"; agentId: string; rootCause: RootCause }
  | { type: "stop"; agentId: string }
  | { type: "assign_task"; agentId: string; task: TaskItem }
  | { type: "verify"; tasks: readonly TaskItem[] }
  | { type: "finished"; summary: string }
  | { type: "failed"; reason: string };
export type TransitionError =
  | { type: "illegal_transition"; phase: Phase; decision: CoordinatorDecision["type"] }
  | { type: "invalid_backlog"; issues: readonly BacklogIssue[] }
  | { type: "unfinished_backlog" }
  | { type: "invalid_root_cause"; reason: string }
  | { type: "invalid_classification"; reason: string }
  | { type: "invalid_answer_source"; agentId: string }
  | { type: "invalid_ownership"; reason: string };
export type TransitionResult = { ok: true; state: PhaseState; effects: readonly CoordinatorEffect[] } | { ok: false; error: TransitionError };

const allowed: Record<Phase, readonly CoordinatorDecision["type"][]> = {
  EXPLORE: ["classify", "answer", "answer_from_worker", "continue_exploration", "root_cause_accepted", "fail"],
  CONVERGE: ["collect_backlog", "fail"], BACKLOG: ["assign", "fail"],
  EXECUTE: ["verify", "replan", "fail"], VERIFY: ["verification_failed", "complete", "fail"], DONE: [], FAILED: [],
};

/** Canonicalize recursive directory notation before both overlap validation and write auditing. */
function normalizeTaskOwnership(tasks: readonly TaskItem[]): TaskItem[] {
  return tasks.map(task => ({
    ...task,
    files: task.files.map(file => {
      const path = normalizeOwnedPath(file.replaceAll("\\", "/").replace(/\/\*\*(?:\/\*)?$/, "/"));
      if (!path || /[*?]/.test(path)) {
        throw new Error(`Unsupported ownership path ${JSON.stringify(file)}; use concrete files, directory prefixes ending /, or directory/**`);
      }
      return path;
    }),
    ...(task.dependsOn ? { dependsOn: [...task.dependsOn] } : {}),
  }));
}
export function createPhaseState(maxFixRounds = 2, maxWorkers = 3): PhaseState {
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0) throw new Error("maxFixRounds must be a nonnegative integer");
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) throw new Error("maxWorkers must be a positive integer");
  return { phase: "EXPLORE", fixRounds: 0, maxFixRounds, maxWorkers, tasks: [] };
}
/** Default: reuse every explorer, including the source; explicitly exclude unneeded workers to stop them. */
export function planConvergence(explorers: readonly Explorer[], rootCause: RootCause, neededAgentIds: readonly string[] = explorers.map(worker => worker.agentId)): readonly CoordinatorEffect[] {
  const needed = new Set(neededAgentIds);
  return explorers.map(worker => !needed.has(worker.agentId)
    ? { type: "stop", agentId: worker.agentId }
    : worker.status === "running"
      ? { type: "redirect", agentId: worker.agentId, assignment: "backlog_proposal", rootCause }
      : { type: "assign_proposal", agentId: worker.agentId, rootCause });
}
/**
 * Pure decision step: caller executes effects, never this module.
 * `explorers` is the current worker roster (also the allowed ownership set).
 * Record implementation RESULTs by replacing state.tasks with updateTaskStatus;
 * dispatch newly readyTasks after dependencies complete, marking dispatched tasks running.
 * Failed verification returns to BACKLOG for a fresh canonical fix assignment.
 * maxFixRounds counts repair attempts, not the initial verification attempt.
 */
export function transition(state: PhaseState, decision: CoordinatorDecision, explorers: readonly Explorer[] = []): TransitionResult {
  if (!allowed[state.phase].includes(decision.type)) return { ok: false, error: { type: "illegal_transition", phase: state.phase, decision: decision.type } };
  if ((decision.type === "classify" && state.taskClass) ||
      ((decision.type === "answer" || decision.type === "answer_from_worker") && state.taskClass !== "answer") ||
      (state.taskClass === "answer" && decision.type !== "answer" && decision.type !== "answer_from_worker" && decision.type !== "fail")) {
    return { ok: false, error: { type: "illegal_transition", phase: state.phase, decision: decision.type } };
  }
  const success = (next: Partial<PhaseState>, effects: readonly CoordinatorEffect[] = []): TransitionResult => ({ ok: true, state: { ...state, ...next }, effects });
  switch (decision.type) {
    case "classify": {
      if (!["answer", "change", "diagnose_fix"].includes(decision.taskClass) ||
          !Number.isInteger(decision.workerCount) || decision.workerCount < 1 || decision.workerCount > state.maxWorkers ||
          !decision.language.trim() || !decision.reason.trim()) {
        return { ok: false, error: { type: "invalid_classification", reason: `A valid task class, 1-${state.maxWorkers} workers, language and reason are required` } };
      }
      return success({
        phase: decision.taskClass === "change" ? "BACKLOG" : "EXPLORE",
        taskClass: decision.taskClass, workerCount: decision.workerCount, language: decision.language,
      });
    }
    case "answer":
      return success({ phase: "DONE", answer: decision.answer, summary: decision.summary }, [{ type: "finished", summary: decision.summary }]);
    case "answer_from_worker": {
      const answer = explorers.find(worker => worker.agentId === decision.sourceAgentId)?.answer;
      if (!answer?.trim()) return { ok: false, error: { type: "invalid_answer_source", agentId: decision.sourceAgentId } };
      return success({ phase: "DONE", answer, summary: decision.summary }, [{ type: "finished", summary: decision.summary }]);
    }
    case "continue_exploration": return success({});
    case "root_cause_accepted": {
      if (!decision.cause.trim() || !decision.sourceAgentId.trim() || !decision.evidence.length || decision.evidence.some(item => !item.trim()))
        return { ok: false, error: { type: "invalid_root_cause", reason: "A cause, source agent, and nonempty evidence are required" } };
      const rootCause: RootCause = { cause: decision.cause, sourceAgentId: decision.sourceAgentId, evidence: [...decision.evidence] };
      return success({ phase: "CONVERGE", rootCause }, planConvergence(explorers, rootCause));
    }
    case "collect_backlog": return success({ phase: "BACKLOG" });
    case "assign": {
      let tasks: TaskItem[];
      try {
        tasks = normalizeTaskOwnership(decision.tasks);
      } catch (error) {
        return { ok: false, error: { type: "invalid_ownership", reason: String(error) } };
      }
      const issues = validateBacklog(tasks, explorers.map(worker => worker.agentId));
      if (issues.length) return { ok: false, error: { type: "invalid_backlog", issues } };
      return success({ phase: "EXECUTE", tasks }, readyTasks(tasks).map(task => ({ type: "assign_task", agentId: task.owner!, task })));
    }
    case "verify":
      if (!isBacklogDone(state.tasks)) return { ok: false, error: { type: "unfinished_backlog" } };
      return success({ phase: "VERIFY" }, [{ type: "verify", tasks: state.tasks }]);
    case "verification_failed":
    case "replan":
      if (state.fixRounds >= state.maxFixRounds) return success({ phase: "FAILED", failure: decision.reason }, [{ type: "failed", reason: decision.reason }]);
      return success({ phase: "BACKLOG", fixRounds: state.fixRounds + 1 });
    case "complete": return success({ phase: "DONE", summary: decision.summary, answer: decision.summary }, [{ type: "finished", summary: decision.summary }]);
    case "fail": return success({ phase: "FAILED", failure: decision.reason }, [{ type: "failed", reason: decision.reason }]);
  }
}

const stringSchema = { type: "string", minLength: 1 };
const stringsSchema = { type: "array", items: stringSchema };
const taskSchema = { type: "object", additionalProperties: false, required: ["id", "description", "files", "status"], properties: {
  id: stringSchema, description: stringSchema, owner: stringSchema, dependsOn: stringsSchema, files: stringsSchema,
  status: { enum: ["pending", "running", "done", "blocked"] },
} };
const fields: Record<CoordinatorDecision["type"], Record<string, unknown>> = {
  continue_exploration: {}, collect_backlog: {}, verify: {},
  classify: { taskClass: { enum: ["answer", "change", "diagnose_fix"] }, workerCount: { type: "integer", minimum: 1, maximum: 3 }, language: stringSchema, reason: stringSchema },
  answer: { answer: stringSchema, summary: stringSchema },
  answer_from_worker: { sourceAgentId: stringSchema, summary: stringSchema },
  root_cause_accepted: { cause: stringSchema, sourceAgentId: stringSchema, evidence: { ...stringsSchema, minItems: 1 } },
  assign: { tasks: { type: "array", items: taskSchema } },
  verification_failed: { reason: stringSchema }, replan: { reason: stringSchema }, complete: { summary: stringSchema }, fail: { reason: stringSchema },
};
function fieldsFor(type: CoordinatorDecision["type"], maxWorkers: number): Record<string, unknown> {
  return type === "classify" ? { ...fields.classify, workerCount: { type: "integer", minimum: 1, maximum: maxWorkers } } : fields[type];
}
/** JSON Schema for the coordinator's single structured-decision tool at this phase. */
export function decisionSchemaForPhase(phase: Phase, taskClass?: TaskClass, maxWorkers = 3): Record<string, unknown> {
  const decisions = phase === "EXPLORE" && taskClass === "answer" ? ["answer", "answer_from_worker", "fail"] as const
    : phase === "EXPLORE" && taskClass ? ["continue_exploration", "root_cause_accepted", "fail"] as const
    : allowed[phase];
  if (!decisions.length) return { not: {} };
  return { oneOf: decisions.map(type => ({ type: "object", additionalProperties: false,
    required: ["type", ...Object.keys(fields[type])], properties: { type: { const: type }, ...fieldsFor(type, maxWorkers) },
  })) };
}
/** Runtime validation mirrors the tool schema; never trust a model's text or casts. */
export function parseCoordinatorDecision(value: unknown, phase: Phase, taskClass?: TaskClass, maxWorkers = 3): CoordinatorDecision {
  const matches = (input: unknown, schema: Record<string, unknown>): boolean => {
    if ("const" in schema) return input === schema.const;
    if (Array.isArray(schema.enum)) return schema.enum.includes(input);
    if (schema.type === "string") return typeof input === "string" && input.trim().length > 0;
    if (schema.type === "integer") return typeof input === "number" && Number.isInteger(input) &&
      input >= (schema.minimum as number) && input <= (schema.maximum as number);
    if (schema.type === "array") return Array.isArray(input) && input.length >= ((schema.minItems as number | undefined) ?? 0) && input.every(item => matches(item, schema.items as Record<string, unknown>));
    if (schema.type === "object") {
      if (!input || typeof input !== "object" || Array.isArray(input)) return false;
      const object = input as Record<string, unknown>;
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      return (schema.required as string[]).every(key => Object.hasOwn(object, key)) && Object.entries(object).every(([key, item]) => Object.hasOwn(properties, key) && matches(item, properties[key]!));
    }
    return false;
  };
  const schemas = decisionSchemaForPhase(phase, taskClass, maxWorkers).oneOf as Record<string, unknown>[] | undefined;
  if (!schemas?.some(schema => matches(value, schema))) throw new Error(`Invalid structured decision for ${phase}`);
  const decision = value as CoordinatorDecision;
  return decision.type === "assign" ? { ...decision, tasks: normalizeTaskOwnership(decision.tasks) } : decision;
}
