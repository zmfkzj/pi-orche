import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createSession } from "../../pi/session-factory.js";
import { reportAgent, targetOf } from "../../agent/records.js";
import { READ_ONLY_TOOL_NAMES } from "../../tools/index.js";
import { parseCoordinatorDecision, decisionSchemaForPhase, transition, type CoordinatorDecision, type Phase } from "../phases.js";
import { validateBacklog } from "../backlog.js";
import { resolveRoute } from "../routing.js";
import { MAX_WORKERS_LIMIT } from "../team.js";
import { apply, bounded, emit, remaining, roster } from "./context.js";
import type { RunContext } from "./types.js";

/** The coordinator session and its structured, validated and bounded-repair decisions. */
export const explorationPlanSchema = Type.Object({
  explorers: Type.Array(Type.Object({ role: Type.String(), angle: Type.String({ minLength: 1 }) }), { minItems: 1, maxItems: MAX_WORKERS_LIMIT }),
});
export async function decide(ctx: RunContext, context: unknown, expectedType?: CoordinatorDecision["type"]): Promise<CoordinatorDecision> {
  await ctx.advisors?.settle(remaining(ctx, ctx.limits.decisionMs));
  const decision = await decideOnce(ctx, context, expectedType);
  const injected = await ctx.advisors?.onDecision(decision, ctx.state.phase, remaining(ctx, ctx.limits.decisionMs));
  if (!injected) return decision;
  emit(ctx, { type: "coordinator_reconsidering", timestamp: Date.now(), phase: ctx.state.phase });
  const reconsideration = `Advisors reviewed your previous decision ${JSON.stringify(decision)} and sent NOTES (see mainNotes). Reconsider it exactly once: resubmit it unchanged if the advice is wrong or already addressed, otherwise submit a revised decision. Advisors are advisory only; you decide.\n`;
  return decideOnce(ctx, context, expectedType, reconsideration);
}
async function decideOnce(ctx: RunContext, context: unknown, expectedType?: CoordinatorDecision["type"], reconsideration = ""): Promise<CoordinatorDecision> {
  let feedback = reconsideration;
  let reconsidered = !!reconsideration;
  for (let attempt = 0; attempt <= ctx.limits.decisionRepairs; attempt++) {
    if (ctx.cancelled) throw new Error("cancelled");
    ctx.decisionSet = false;
    ctx.decisionValue = undefined;
    const unreadNotes = ctx.mainNotes.splice(0).map(({ from, content, signal }) => ({ from, content, signal }));
    const decisionContext = unreadNotes.length ? { context, mainNotes: unreadNotes } : context;
    // The coordinator session keeps its transcript, so an identical schema is not resent: fix rounds
    // and repairs then add only their new context to the conversation.
    const schema = JSON.stringify(decisionSchemaForPhase(ctx.state.phase, ctx.state.taskClass, ctx.state.maxWorkers));
    const schemaText = schema === ctx.lastSchema ? "Schema: unchanged from the previous decision prompt." : `Schema: ${schema}`;
    ctx.lastSchema = schema;
    const prompt = `Decision phase ${ctx.state.phase}. Reply in the user's language (${ctx.state.language ?? "detect from request"}; Korean requests require Korean answers). Call coordinator_decision alone with arguments {"decision":<object matching schema>}. ${schemaText}\nContext: ${JSON.stringify(decisionContext)}\n${feedback}`;
    if (unreadNotes.some(note => note.from.startsWith("advisor:")) && !reconsideration) {
      reconsidered = true;
      emit(ctx, { type: "coordinator_reconsidering", timestamp: Date.now(), phase: ctx.state.phase });
    }
    emit(ctx, { type: "coordinator_deciding", timestamp: Date.now(), phase: ctx.state.phase });
    await bounded(ctx, ctx.coordinator!.prompt(prompt), ctx.limits.decisionMs, "Coordinator decision");
    if (ctx.cancelled) throw new Error("cancelled");
    try {
      if (!ctx.decisionSet) throw new Error("No decision tool called");
      const decision = parseCoordinatorDecision(ctx.decisionValue, ctx.state.phase, ctx.state.taskClass, ctx.state.maxWorkers);
      if (expectedType && decision.type !== expectedType && decision.type !== "fail") {
        throw new Error(`Expected ${expectedType}, received ${decision.type}`);
      }
      const candidate = transition(ctx.state, decision, roster(ctx));
      if (!candidate.ok) throw new Error(JSON.stringify(candidate.error));
      if (decision.type === "assign") {
        if (!decision.tasks.length || decision.tasks.some(task => task.status !== "pending" || !task.files.length)) {
          throw new Error("Backlog needs nonempty pending tasks and owned files");
        }
        const issues = validateBacklog(decision.tasks, ctx.workerIds);
        if (issues.length) throw new Error(JSON.stringify(issues));
      }
      if (decision.type === "root_cause_accepted" && !ctx.workerIds.includes(decision.sourceAgentId)) {
        throw new Error("Unknown claimant");
      }
      emit(ctx, { type: "coordinator_decision", timestamp: Date.now(), phase: ctx.state.phase, decisionType: decision.type, reconsidered });
      return decision;
    } catch (error) {
      feedback = `Repair invalid decision: ${String(error)}. Remaining repairs: ${ctx.limits.decisionRepairs - attempt}`;
    }
  }
  throw new Error("Coordinator decision invalid after bounded repairs");
}
export async function createCoordinator(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  if (ctx.cancelled || ctx.signal?.aborted) throw new Error("cancelled");
  const phases: Phase[] = ["EXPLORE", "CONVERGE", "BACKLOG", "EXECUTE", "VERIFY"];
  const decisionSchemas = phases.map(phase => decisionSchemaForPhase(phase, undefined, ctx.state.maxWorkers));
  const decisionTool: ToolDefinition = {
    name: "coordinator_decision",
    label: "Coordinator decision",
    description: "Submit exactly one structured phase decision, alone. Only the current phase's decisions are accepted.",
    parameters: Type.Object({ decision: Type.Unsafe({ anyOf: decisionSchemas }) }),
    execute: async (_id, args) => {
      if (ctx.cancelled) throw new Error("Run cancelled; decision rejected");
      if (!ctx.decisionSet && args && typeof args === "object" && "decision" in args) {
        ctx.decisionValue = args.decision;
        ctx.decisionSet = true;
      }
      return { content: [{ type: "text", text: "Decision captured" }], details: {}, terminate: true };
    },
  };
  const planTool: ToolDefinition = {
    name: "plan_exploration",
    label: "Plan exploration",
    description: "Plan the requested number of distinct investigation angles using the supplied explorer route roles.",
    parameters: explorationPlanSchema,
    execute: async (_id, args) => {
      if (ctx.cancelled) throw new Error("Run cancelled; plan rejected");
      if (!ctx.decisionSet) {
        ctx.decisionValue = args;
        ctx.decisionSet = true;
      }
      return { content: [{ type: "text", text: "Plan captured" }], details: {}, terminate: true };
    },
  };
  const route = resolveRoute(ctx.options.routes, "coordinator");
  // Opt-in records: the caller's hook decides whether (and where) this session is persisted.
  const target = targetOf(ctx.options.records, { id: "coordinator", role: "coordinator", kind: "coordinator" });
  const startedAt = Date.now();
  ctx.coordinator = await createSession({
    onContextWindow: info => emit(ctx, { type: "context_window", timestamp: Date.now(), actor: "coordinator", ...info }),
    baseSystemPrompt: ctx.options.baseSystemPrompt,
    cwd: ctx.options.cwd,
    route,
    ...target,
    modelRuntime: runtime,
    tools: [...READ_ONLY_TOOL_NAMES, "coordinator_decision", "plan_exploration"],
    customTools: [decisionTool, planTool],
    instructions: "You are the coordinator. Read-only. First classify the request; do not mistake explanation, review or no-modification requests for code changes. Decisions must use structured tools alone. Reply in the user's language; Korean requests require Korean answers (한국어). Accept only evidenced causes. Merge minimal tasks, disjoint ownership, explicit dependencies and the SAME worker owners. Require actual verification for changes; answers must be grounded in read-only worker evidence. Never access hidden grading data.",
  });
  const record: NonNullable<RunContext["coordinatorRecord"]> = {
    startedAt, requests: 0, models: {}, model: route.model, ...(route.thinking ? { thinking: route.thinking } : {}),
    ...(ctx.coordinator.sessionFile ? { sessionFile: ctx.coordinator.sessionFile } : {}),
  };
  ctx.coordinatorRecord = record;
  if (ctx.cancelled) {
    ctx.coordinator.dispose();
    ctx.coordinator = undefined;
    throw new Error("cancelled");
  }
  let requests = 0;
  ctx.unsubscribers.push(ctx.coordinator.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const usage = event.message.usage;
    const answered = `${event.message.provider}/${event.message.model}`;
    record.requests++;
    record.models[answered] = (record.models[answered] ?? 0) + 1;
    emit(ctx, {
      type: "coordinator_usage", timestamp: Date.now(),
      model: `${event.message.provider}/${event.message.model}`,
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    });
    emit(ctx, { type: "coordinator_activity", timestamp: Date.now(), phase: ctx.state.phase, requestCount: ++requests });
  }));
}
/**
 * Hand the coordinator's manifest entry to `options.records.onAgent`, once, when the run is over (status `completed`, `failed` or
 * `cancelled`). Nothing to report when no coordinator session was ever created.
 */
export function reportCoordinator(ctx: RunContext, status: "completed" | "failed" | "cancelled", error?: string): void {
  const record = ctx.coordinatorRecord;
  if (!record || record.reported || !ctx.options.records?.onAgent) return;
  record.reported = true;
  reportAgent(ctx.options.records, {
    id: "coordinator", role: "coordinator", kind: "coordinator", model: record.model,
    ...(record.thinking ? { thinking: record.thinking } : {}),
    requests: record.requests, models: { ...record.models }, durationMs: Math.max(0, Date.now() - record.startedAt),
    startedAt: record.startedAt, status,
    ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
    ...(error ? { error } : {}),
  });
}
export async function classifyRequest(ctx: RunContext): Promise<void> {
  const decision = await decide(ctx, {
    problem: ctx.options.problem,
    requirement: `FIRST decision: classify. taskClass=answer for analysis, explanation, review, root-cause reports or any explicit do-not-modify request; change for a clear feature/refactor/migration/tests/docs/performance/robustness/trivial edit; diagnose_fix only for an unexplained defect requiring investigation before fixing. ${workerCountGuidance(ctx.state.maxWorkers)} language must identify the user's response language (Korean request → ko). Include a short reason. Do not investigate or implement before classification.`,
  }, "classify");
  apply(ctx, decision);
  if (decision.type !== "classify") return;
  ctx.workerIds = Array.from({ length: decision.workerCount }, (_, index) => `A${index + 1}`);
  emit(ctx, {
    type: "request_classified", timestamp: Date.now(),
    taskClass: decision.taskClass, workerCount: decision.workerCount,
    language: decision.language, reason: decision.reason,
  });
}
/** Proportionality rule for workerCount; more workers only for independent substantial work. */
export function workerCountGuidance(maxWorkers: number): string {
  if (maxWorkers === 1) return "workerCount MUST be 1.";
  return `Choose workerCount 1–${maxWorkers} proportionately: trivial one-line edits and focused questions MUST use 1; use 2–${maxWorkers} only for genuinely independent substantial work, one worker per independent unit with its own files.`;
}
/** Why a plan_exploration payload is unusable, or undefined when it is valid. */
export function explorationPlanProblem(called: boolean, plan: unknown, roles: readonly string[]): string | undefined {
  if (!called) return "plan_exploration was not called";
  if (!Value.Check(explorationPlanSchema, plan)) {
    return [...Value.Errors(explorationPlanSchema, plan)].slice(0, 5).map(error => `${error.path || "/"}: ${error.message}`).join("; ") || "invalid shape";
  }
  if (plan.explorers.length !== roles.length) return `expected ${roles.length} explorers, received ${plan.explorers.length}`;
  const wrongRole = plan.explorers.findIndex((item, index) => item.role !== roles[index]);
  if (wrongRole >= 0) return `explorer ${wrongRole} must have role ${roles[wrongRole]}`;
  if (plan.explorers.some(item => !item.angle.trim())) return "every angle must be nonempty";
  if (new Set(plan.explorers.map(item => item.angle.trim())).size !== plan.explorers.length) return "angles must be distinct";
  return undefined;
}
