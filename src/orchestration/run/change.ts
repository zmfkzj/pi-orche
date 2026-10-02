import { expiry, runDeadline } from "./deadline.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResultPayload } from "../../agent/agent-handle.js";
import { READ_ONLY_TOOL_NAMES, WORKER_TOOL_NAMES } from "../../tools/index.js";
import { dedupeProposals, isBacklogDone, readyTasks, updateTaskStatus, type BacklogProposal } from "../backlog.js";
import { coveringTasks } from "../ownership.js";
import { resolveRoute } from "../routing.js";
import { implementationPrompt, verificationPrompt, workerInstructions } from "../prompts.js";
import { apply, bounded, bufferMainNote, emit, spawnWorker, waitOutcomes } from "./context.js";
import { decide } from "./decisions.js";
import { auditWorkspace } from "./audit.js";
import type { RunContext } from "./types.js";

/** Backlog execution shared by `change` and `diagnose_fix`: dispatch, replan, verify and fix rounds. */
export async function spawnChangeWorkers(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  for (const id of ctx.workerIds) {
    await spawnWorker(ctx, {
      id, role: "implementer", cwd: ctx.options.cwd, baseSystemPrompt: ctx.options.baseSystemPrompt, tools: [...WORKER_TOOL_NAMES],
      route: resolveRoute(ctx.options.routes, "implementer"), modelRuntime: runtime,
      instructions: `${workerInstructions}\nYour id is ${id}. User request: ${ctx.options.problem}\nReply in the user's language (${ctx.state.language}).`,
    });
  }
}
/**
 * Dispatch ready tasks to idle owners until the backlog is done or nothing more can run, and
 * return the reasons of tasks that ended blocked (empty when every task is done).
 */
async function executeBacklog(ctx: RunContext): Promise<string[]> {
  const kind = ctx.state.fixRounds ? "fix" : "implement";
  const blockedReasons: string[] = [];
  const stage = `${kind} backlog`;
  ctx.stage = stage;
  // One phase deadline for the whole backlog: the owner settle below and the outcome waits share it (and its extensions).
  const phase = runDeadline(ctx).phase(ctx.limits.assignmentMs, stage);
  while (!isBacklogDone(ctx.state.tasks)) {
    for (const task of readyTasks(ctx.state.tasks)) {
      if (ctx.manager.get(task.owner!).status !== "idle") continue;
      ctx.activeTasks.set(task.owner!, task);
      ctx.state = { ...ctx.state, tasks: updateTaskStatus(ctx.state.tasks, task.id, "running") };
      ctx.manager.assign(task.owner!, kind, implementationPrompt(task, ctx.state.tasks, kind === "fix"));
      emit(ctx, { type: "task_dispatched", timestamp: Date.now(), taskId: task.id, agentId: task.owner! });
    }
    if (!ctx.state.tasks.some(task => task.status === "running")) {
      if (ctx.state.tasks.some(task => task.status === "blocked")) return blockedReasons;
      // A ready task whose owner is still settling an interruption waits for it instead of failing.
      const busy = [...new Set(readyTasks(ctx.state.tasks).map(task => task.owner!))].filter(owner => ctx.manager.get(owner).status !== "idle");
      if (busy.length) {
        await bounded(ctx, Promise.all(busy.map(owner => ctx.manager.settle(owner))), phase, "Owner settle");
        const stillBusy = busy.filter(owner => ctx.manager.get(owner).status !== "idle");
        if (!stillBusy.length) continue;
        throw new Error(`Backlog blocked: owners not idle: ${stillBusy.join(", ")}`);
      }
      throw new Error("Backlog blocked: no task can run");
    }
    const event = await ctx.manager.wait("any", phase.remainingMs());
    if (event.type === "timeout") {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (ctx.cancelled) throw new Error("cancelled"); // a closed manager answers at once: never spin on it
      const error = expiry(ctx, stage, phase);
      if (!error) continue; // extended (the run is still active), or not due yet: wait again until the new deadline
      ctx.cancel?.(error);
      throw error;
    }
    if (event.type === "message") {
      bufferMainNote(ctx, event.message);
      continue;
    }
    if (event.type !== "outcome" || event.outcome.kind !== kind) continue;
    const task = ctx.activeTasks.get(event.outcome.agentId);
    if (!task) continue;
    ctx.activeTasks.delete(event.outcome.agentId);
    const data = event.outcome.result?.data;
    const explicitlyBlocked = data && typeof data === "object" && "status" in data && data.status === "blocked";
    const status = event.outcome.status === "completed" && !explicitlyBlocked ? "done" : "blocked";
    if (status === "blocked") {
      const reason = data && typeof data === "object" && "reason" in data && typeof data.reason === "string"
        ? data.reason
        : event.outcome.result?.summary ?? event.outcome.error ?? event.outcome.status;
      blockedReasons.push(`${task.id} (${event.outcome.agentId}): ${reason}`);
    }
    ctx.state = { ...ctx.state, tasks: updateTaskStatus(ctx.state.tasks, task.id, status) };
    emit(ctx, { type: "task_finished", timestamp: Date.now(), taskId: task.id, agentId: event.outcome.agentId, status });
  }
  return blockedReasons;
}
async function verifyRound(ctx: RunContext): Promise<ResultPayload | undefined> {
  apply(ctx, { type: "verify" });
  ctx.manager.assign("V1", "verify", verificationPrompt(ctx.options.problem, ctx.state.tasks, ctx.options.routes.verifyCommands));
  const [verification] = await waitOutcomes(ctx, "verify", new Set(["V1"]));
  // The verifier is read-only: anything it changed (beyond ignored build output) is a violation.
  await auditWorkspace(ctx, ["V1"], () => false);
  const verificationData = verification!.result?.data;
  const passed = Boolean(verificationData && typeof verificationData === "object" && "passed" in verificationData && verificationData.passed === true);
  const summary = verification!.result?.summary ?? "Verification missing result";
  emit(ctx, { type: "verification", timestamp: Date.now(), passed, round: ctx.state.fixRounds, summary });
  const decision = await decide(ctx, {
    verification: verification!.result,
    requirement: passed ? "Complete only if evidence supports success. Your complete.summary is the final user-facing answer: concisely describe what changed and how it was verified, with relevant caveats, in the user's language." : "Verification failed: use verification_failed or fail, never complete.",
  });
  if (!passed && decision.type === "complete") throw new Error("Coordinator approved failed verification");
  apply(ctx, decision);
  return verification!.result;
}
export async function mergeExecuteAndVerify(ctx: RunContext, runtime: ModelRuntime, proposals: BacklogProposal[] = []): Promise<void> {
  let mergeContext: unknown = {
    problem: ctx.options.problem, proposals: dedupeProposals(proposals), rootCause: ctx.state.rootCause, owners: ctx.workerIds,
    requirement: "Merge into nonempty pending tasks; reuse the selected owners, disjoint files, dependsOn IDs. Proposal items list dependsOn as titles of their sibling items: translate them into the IDs of your merged tasks. Ownership files must be concrete repository-relative paths or recursive directory prefixes ending / (directory/** is also accepted and canonicalized). No other ownership globs. Include every file area the requested change must touch. Plan the minimal requested changes with appropriate regression coverage; reuse existing tests when sufficient. Documentation only if the user's problem asks for it. Do not investigate root causes for clear change requests.",
  };
  await spawnWorker(ctx, {
    id: "V1", role: "verifier", cwd: ctx.options.cwd,
    route: resolveRoute(ctx.options.routes, "verifier"), modelRuntime: runtime,
    instructions: `${workerInstructions}\nReply in the user's language (${ctx.state.language}).`, tools: [...READ_ONLY_TOOL_NAMES, "bash"], baseSystemPrompt: ctx.options.baseSystemPrompt,
  });
  while (ctx.state.phase !== "DONE" && ctx.state.phase !== "FAILED") {
    const merged = await decide(ctx, mergeContext);
    apply(ctx, merged);
    if (merged.type !== "assign") throw new Error(ctx.state.failure ?? "Expected backlog assignment");
    emit(ctx, { type: "backlog_created", timestamp: Date.now(), tasks: ctx.state.tasks });
    const blocked = await executeBacklog(ctx);
    const owners = [...new Set(ctx.state.tasks.map(task => task.owner!))];
    await auditWorkspace(ctx, owners, file => coveringTasks(ctx.state.tasks, file).length > 0);
    if (blocked.length) {
      const reasons = blocked.join("; ");
      if (ctx.state.fixRounds >= ctx.state.maxFixRounds) throw new Error(`Backlog blocked: ${reasons}`);
      const decision = await decide(ctx, {
        blocked, tasks: ctx.state.tasks,
        requirement: "Some backlog tasks were reported blocked (reasons above). Use replan with a short reason to plan revised tasks in the next decision (this uses one fix round), or fail when the request cannot be completed. Never verify an unfinished backlog.",
      });
      apply(ctx, decision.type === "fail" ? { ...decision, reason: `${decision.reason} (blocked: ${reasons})` } : decision);
      if (ctx.state.phase !== "BACKLOG") break;
      mergeContext = {
        problem: ctx.options.problem, blocked, previousTasks: ctx.state.tasks, owners: ctx.workerIds,
        requirement: "Create a revised backlog that resolves the blocked tasks: pending tasks with disjoint ownership for the original owners; adjust ownership, dependencies or scope as the blocked reasons require. Keep completed work; do not redo it.",
      };
      continue;
    }
    const verification = await verifyRound(ctx);
    mergeContext = {
      verification, previousTasks: ctx.state.tasks, owners: ctx.workerIds,
      requirement: "Create minimal fix tasks assigned to the original owning workers. Pending status and disjoint ownership. Preserve unaffected implementation.",
    };
  }
}

