import { abortable, expiry, runDeadline, runLiveness } from "./deadline.js";
import type { PhaseDeadline } from "./extension.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { ManagerEvent, Outcome } from "../../agent/agent-handle.js";
import type { LivenessEvent } from "../../agent/liveness.js";
import type { NoteMessage } from "../../messaging/message.js";
import { transition, type CoordinatorDecision, type CoordinatorEffect, type Explorer } from "../phases.js";
import type { CoordinatorEvent } from "../events.js";
import { checkWriteRealPath, coveringTasks } from "../ownership.js";
import type { RunContext } from "./types.js";

/** Shared run plumbing: events, time budgets, worker spawning, phase transitions and outcome waits. */
export function emit(ctx: RunContext, event: CoordinatorEvent | LivenessEvent): void {
  if (ctx.reported) return;
  ctx.options.sink?.(event);
}
/** `cap` ms from now, bounded by the run's CURRENT overall deadline (the base cap plus the extensions granted so far). */
export function remaining(ctx: RunContext, cap: number): number {
  return runDeadline(ctx).remaining(cap);
}
/** Spawn guard: a cancelled run must not create new sessions after teardown began. */
export async function spawnWorker(ctx: RunContext, options: Parameters<AgentManager["spawn"]>[0]): Promise<void> {
  if (ctx.cancelled) throw new Error("cancelled");
  ensureLiveness(ctx);
  ctx.stage = `startup/worker/${options.id}`;
  await ctx.manager.spawn({
    ...options,
    signal: ctx.signal,
    onContextWindow: info => emit(ctx, { type: "context_window", timestamp: Date.now(), actor: options.id, ...info }),
    toolGuard: (toolName, input) => guardWrite(ctx, options.id, toolName, input),
    // Resolved against ctx.activity at event time: it exists whenever the workspace audit is on.
    onToolExecution: event => ctx.activity?.record(options.id, event),
  });
  // AgentManager disposes any late creation itself; never await unbounded teardown here.
  if (ctx.cancelled) throw new Error("cancelled");
}
export { runLiveness };
/** Give the context its public `ctx.liveness()`; called when the first session of the run is created. */
export function ensureLiveness(ctx: RunContext): void {
  ctx.liveness ??= (now, windowMs) => runLiveness(ctx, now, windowMs);
}
/**
 * Bounds `operation` by a phase cap: `cap` ms from now (a new {@link PhaseDeadline}), or the given phase, whose deadline is then shared with
 * whoever else waits on it. Both are bounded by the run's overall deadline. When the bounding deadline expires while the run is still
 * actively working the deadline is extended and the timer re-armed (see `expiry`); otherwise the run is cancelled with the timeout.
 * The user's cancellation (the run's signal) always wins at once: a timer that fires on top of it neither extends nor times out.
 */
export async function bounded<T>(ctx: RunContext, operation: Promise<T>, cap: number | PhaseDeadline, label: string): Promise<T> {
  ctx.stage = label;
  const phase = typeof cap === "number" ? runDeadline(ctx).phase(cap, label) : cap;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const arm = () => {
      timer = setTimeout(() => {
        if (ctx.signal?.aborted) { reject(ctx.signal.reason ?? new Error("cancelled")); return; }
        const error = expiry(ctx, label, phase);
        if (!error) { arm(); return; }
        ctx.cancel?.(error);
        reject(error);
      }, phase.remainingMs());
    };
    arm();
  });
  try { return await Promise.race([abortable(operation, ctx.signal), timeout]); }
  finally { clearTimeout(timer); }
}
export function roster(ctx: RunContext): Explorer[] {
  const workers = ctx.manager.list();
  return ctx.workerIds
    .filter(id => workers.some(worker => worker.id === id))
    .map(agentId => ({
      agentId,
      status: ctx.manager.get(agentId).status === "running" ? "running" : "idle",
      answer: ctx.workerAnswers.get(agentId),
    }));
}
export function apply(ctx: RunContext, decision: CoordinatorDecision): readonly CoordinatorEffect[] {
  if (ctx.cancelled && decision.type !== "fail") throw ctx.signal?.reason ?? new Error("cancelled");
  const result = transition(ctx.state, decision, roster(ctx));
  if (!result.ok) throw new Error(`Rejected transition: ${JSON.stringify(result.error)}`);
  const from = ctx.state.phase;
  ctx.state = result.state;
  if (from !== ctx.state.phase) {
    emit(ctx, { type: "phase_changed", timestamp: Date.now(), from, to: ctx.state.phase });
  }
  return result.effects;
}
export function bufferMainNote(ctx: RunContext, note: NoteMessage): void {
  if (ctx.bufferedNoteIds.has(note.id)) return;
  ctx.bufferedNoteIds.add(note.id);
  ctx.mainNotes.push(note);
}
export async function waitOutcomes(ctx: RunContext, kind: string, expected: Set<string>): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const stage = `${kind} outcomes`;
  ctx.stage = stage;
  const phase = runDeadline(ctx).phase(ctx.limits.assignmentMs, stage);
  while (expected.size) {
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
    if (event.type !== "outcome" || event.outcome.kind !== kind || !expected.has(event.outcome.agentId)) continue;
    expected.delete(event.outcome.agentId);
    outcomes.push(event.outcome);
    if (event.outcome.status !== "completed") {
      const reason = event.outcome.error ? ` (${event.outcome.error})` : "";
      throw new Error(`${kind} ${event.outcome.agentId}: ${event.outcome.status}${reason}`);
    }
  }
  return outcomes;
}

export function forwardManagerEvent(ctx: RunContext, event: ManagerEvent): void {
  ctx.options.sink?.(event);
  if (event.type === "usage" || event.type === "tool_started") {
    const worker = ctx.manager.get(event.agentId);
    const assignment = worker.currentAssignment;
    if (assignment?.id === event.assignmentId) {
      emit(ctx, {
        type: "worker_activity", timestamp: event.timestamp, agentId: event.agentId,
        assignmentId: assignment.id, kind: assignment.kind,
        requestCount: worker.requestCount ?? 0, lastToolName: worker.lastToolName,
      });
    }
  }
  if (event.type === "message_sent" && event.message.type === "note" && event.message.to === "main" && (ctx.state.phase !== "EXPLORE" || event.message.from.startsWith("advisor:"))) {
    bufferMainNote(ctx, event.message);
  }
  if (event.type === "message_sent" && event.message.type === "note" && event.message.to === "main" && event.message.signal?.kind === "root_cause_found" && event.message.signal.cause) {
    emit(ctx, {
      type: "root_cause_claimed", timestamp: event.timestamp,
      agentId: event.message.from, cause: event.message.signal.cause, via: "note",
    });
  }
  if (event.type === "assignment_outcome" && event.outcome.kind === "explore") {
    const data = event.outcome.result?.data;
    if (data && typeof data === "object" && "cause" in data && typeof data.cause === "string" && data.cause.trim()) {
      emit(ctx, {
        type: "root_cause_claimed", timestamp: event.timestamp,
        agentId: event.outcome.agentId, cause: data.cause, via: "result",
      });
    }
  }
}
/**
 * Pre-execution ownership guard for a worker's write tools (edit, write, ast_rewrite): a write
 * outside the worker's owned files, or during a read-only assignment, never runs. The model gets
 * the reason as the tool error; no file changed, so this is reported but is not a violation.
 * A call that passes is a write-capable tool about to run: the activity tracker may need a
 * snapshot first (quiet→active edge), and this guard is awaited before the tool executes.
 */
export function guardWrite(ctx: RunContext, agentId: string, toolName: string, input: Record<string, unknown>): string | undefined | Promise<string | undefined> {
  if (ctx.cancelled || ctx.signal?.aborted) return "Run cancelled: no further tool writes are accepted";
  const assignmentKind = ctx.manager.list().find(worker => worker.id === agentId)?.currentAssignment?.kind;
  return checkWriteRealPath({ toolName, input, cwd: ctx.options.cwd, agentId, assignmentKind, tasks: ctx.state.tasks }).then(blocked => {
    // Cancellation may have arrived while filesystem resolution was pending.
    if (ctx.cancelled || ctx.signal?.aborted) return "Run cancelled: no further tool writes are accepted";
    if (!blocked) {
      return (ctx.activity?.enter(agentId, toolName) ?? Promise.resolve()).then(() =>
        ctx.cancelled || ctx.signal?.aborted ? "Run cancelled: no further tool writes are accepted" : undefined);
    }
    emit(ctx, {
      type: "ownership_blocked", timestamp: Date.now(), agentId, tool: toolName, file: blocked.file,
      ownerTaskIds: coveringTasks(ctx.state.tasks, blocked.file).map(task => task.id),
    });
    return blocked.reason;
  });
}
