import { abortable, cancellationDiagnostic, cleanupWait, timeoutError } from "./run/deadline.js";
import { remaining } from "./run/context.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../agent/agent-manager.js";
import { loadProviderExtensions } from "../pi/provider-extensions.js";
import { AdvisorEngine } from "../advisor/engine.js";
import { createPhaseState } from "./phases.js";
import { resolveTeam } from "./team.js";
import { orchestrationResultSchemas } from "./result-schemas.js";
import { apply, emit, forwardManagerEvent } from "./run/context.js";
import { classifyRequest, createCoordinator } from "./run/decisions.js";
import { finalWorkspace, openWorkspaceAudit } from "./run/audit.js";
import { runAnswer } from "./run/answer.js";
import { exploreUntilAccepted, collectProposals, planAndSpawnExplorers } from "./run/diagnose.js";
import { mergeExecuteAndVerify, spawnChangeWorkers } from "./run/change.js";
import { type RunContext, type RunOptions, type RunReport } from "./run/types.js";
import type { WorkspaceChange } from "./workspace.js";
import { resolveRunLimits } from "./limits.js";
import { CREATED_FILE_ADVICE } from "./artifacts.js";

export { defaultRunLimits, type OwnershipViolation, type RunLimits, type RunOptions, type RunReport } from "./run/types.js";
export { explorationPlanProblem } from "./run/decisions.js";

/**
 * Entry point: one orchestrated run. The phase flows live in ./run/ (answer, diagnose, change),
 * coordinator decisions in ./run/decisions.ts and the workspace audit in ./run/audit.ts.
 */
export async function runOrchestrated(options: RunOptions): Promise<RunReport> {
  const startedAt = Date.now();
  const limits = resolveRunLimits(options.routes.limits, options.limits);
  const team = resolveTeam(options.routes.workers);
  const ctx: RunContext = {
    options, limits, startedAt,
    team,
    auditSettings: { ...options.routes.audit, ...options.audit },
    state: createPhaseState(limits.maxFixRounds, team.maxWorkers),
    manager: new AgentManager(options.modelRuntime, { resultSchemas: orchestrationResultSchemas, requestBudget: limits.assignmentRequests }),
    decisionValue: undefined,
    decisionSet: false,
    activeTasks: new Map(),
    violations: [],
    unsubscribers: [],
    mainNotes: [],
    bufferedNoteIds: new Set(),
    workerIds: [],
    workerAnswers: new Map(),
    cancelled: false,
  };
  ctx.unsubscribers.push(ctx.manager.subscribe(event => forwardManagerEvent(ctx, event)));
  // Completed worker results by agent and kind (latest wins). The run flows only hand them to the
  // coordinator after every worker of a phase finished; a failure before that must not lose them.
  const workerResults = new Map<string, WorkerResult>();
  ctx.unsubscribers.push(ctx.manager.subscribe(event => {
    if (event.type !== "assignment_outcome" || event.outcome.status !== "completed" || !event.outcome.result?.summary.trim()) return;
    const { agentId, kind, result } = event.outcome;
    const key = `${agentId}:${kind}`;
    workerResults.delete(key);
    workerResults.set(key, { agentId, kind, summary: result.summary });
  }));
  emit(ctx, { type: "run_started", timestamp: startedAt, mode: "orchestrated", problem: options.problem });
  emit(ctx, { type: "phase_changed", timestamp: startedAt, from: "INIT", to: "EXPLORE" });
  const controller = new AbortController();
  ctx.signal = controller.signal;
  ctx.stage = "startup/runtime";
  ctx.cancel = reason => {
    if (controller.signal.aborted) return;
    ctx.cancelled = true;
    ctx.manager.close(reason);
    controller.abort(reason);
  };
  const onAbort = () => {
    if (controller.signal.aborted) return;
    ctx.cancellation = cancellationDiagnostic(ctx);
    ctx.cancel!(new Error("cancelled"));
  };
  const overallTimer = setTimeout(() => {
    if (!controller.signal.aborted) ctx.cancel!(timeoutError(ctx, ctx.stage ?? "run", limits.overallMs, limits.overallMs, "overall"));
  }, remaining(ctx, limits.overallMs));
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
  let executing = true;
  let failure: string | undefined;
  const pending: string[] = [];
  const cleanupBudget = () => ctx.signal?.aborted ? 0 : remaining(ctx, limits.overallMs);
  let workspace: RunReport["workspace"];
  let providerDisposed = false;
  const disposeProvider = (host: Awaited<NonNullable<RunContext["providerHost"]>>) => { if (!providerDisposed) { providerDisposed = true; host.dispose(); } };
  const execute = async () => {
    if (ctx.cancelled) return;
    if (remaining(ctx, limits.overallMs) === 0) { ctx.cancel!(timeoutError(ctx, ctx.stage!, limits.overallMs, 0, "overall")); return; }
    const runtime = options.modelRuntime ?? await (options.createRuntime?.() ?? ModelRuntime.create());
    if (ctx.cancelled) return;
    if (options.routes.providerExtensions?.length) {
      ctx.providerHost = loadProviderExtensions(runtime, options.routes.providerExtensions, { cwd: options.cwd, signal: ctx.signal });
      ctx.stage = "startup/providers";
      void ctx.providerHost.then(host => { if (ctx.cancelled) disposeProvider(host); }).catch(() => undefined);
      await ctx.providerHost;
    }
    if (ctx.cancelled) return;
    if (options.routes.advisors?.length) {
      const engine = new AdvisorEngine(options.routes.advisors, {
        cwd: options.cwd, problem: options.problem, runtime, routes: options.routes, manager: ctx.manager,
        coordinator: () => ctx.coordinator, emit: event => emit(ctx, event),
        signal: ctx.signal,
      });
      if (engine.active) {
        ctx.advisors = engine;
        engine.start();
      }
    }
    if (ctx.cancelled) return;
    ctx.stage = "startup/workspace";
    if (options.workspaceAudit !== false) await openWorkspaceAudit(ctx);
    if (ctx.cancelled) return;
    ctx.stage = "startup/coordinator";
    await createCoordinator(ctx, runtime);
    await classifyRequest(ctx);
    if (ctx.state.taskClass === "answer") {
      await runAnswer(ctx, runtime);
    } else if (ctx.state.taskClass === "change") {
      await spawnChangeWorkers(ctx, runtime);
      await mergeExecuteAndVerify(ctx, runtime);
    } else if (ctx.state.taskClass === "diagnose_fix") {
      await planAndSpawnExplorers(ctx, runtime);
      await exploreUntilAccepted(ctx);
      const proposals = await collectProposals(ctx);
      await mergeExecuteAndVerify(ctx, runtime, proposals);
    }
  };
  try {
    await abortable(execute().finally(() => { executing = false; }), ctx.signal);
    if (ctx.cancelled) throw new Error("cancelled");
  } catch (error) {
    failure = ctx.signal?.aborted ? String(ctx.signal.reason instanceof Error ? ctx.signal.reason.message : ctx.signal.reason) : ctx.state.failure ?? String(error);
    if (ctx.state.phase !== "FAILED" && ctx.state.phase !== "DONE") {
      apply(ctx, { type: "fail", reason: failure });
    }
  } finally {
    ctx.cancelled = true;
    ctx.manager.close();
    ctx.stage = "cleanup/sessions";
    const coordinatorAbort = ctx.coordinator?.abort();
    ctx.coordinator?.dispose();
    const waits = [
      ctx.manager.disposeWithin(cleanupBudget()).then(result => { pending.push(...result.pendingWorkerIds.map(id => `worker:${id}`)); }),
      ...(coordinatorAbort ? [cleanupWait(coordinatorAbort, cleanupBudget()).then(ok => { if (!ok) pending.push("coordinator"); })] : []),
      ...(ctx.advisors ? [ctx.advisors.disposeWithin(cleanupBudget()).then(ok => { if (!ok) pending.push("advisors"); })] : []),
      ...(ctx.providerHost ? [cleanupWait(ctx.providerHost.then(disposeProvider), cleanupBudget()).then(ok => { if (!ok) pending.push("providers"); })] : []),
    ];
    await Promise.all(waits);
    ctx.stage = "cleanup/final-workspace";
    try {
      if (ctx.signal?.aborted) { if (ctx.audit) pending.push("final-workspace"); }
      else workspace = await abortable(finalWorkspace(ctx), ctx.signal);
    } catch { pending.push("final-workspace"); }
    if (ctx.audit) {
      if (!(await cleanupWait(ctx.audit.close(), cleanupBudget()))) pending.push("workspace-index");
      if (ctx.signal?.aborted && !pending.includes("final-workspace")) pending.push("final-workspace");
    }
    if (executing) pending.push("execution/SDK creation");
    if (ctx.signal?.aborted && !failure) failure = ctx.signal.reason instanceof Error ? ctx.signal.reason.message : String(ctx.signal.reason);
    clearTimeout(overallTimer);
    options.signal?.removeEventListener("abort", onAbort);
    for (const unsubscribe of ctx.unsubscribers) unsubscribe();
  }
  const status = !failure && ctx.state.phase === "DONE" && !ctx.violations.length ? "done" : "failed";
  const violated = [...new Set(ctx.violations.map(violation => violation.file))];
  const created = [...new Set(ctx.violations.filter(violation => violation.created).map(violation => violation.file))];
  const baseSummary = ctx.cancellation ? "cancelled" : ctx.violations.length
    ? `Decomposition failure: ${ctx.violations.length} ownership violation${ctx.violations.length === 1 ? "" : "s"} (${violated.slice(0, 5).join(", ")}${violated.length > 5 ? ", …" : ""})${created.length ? `; ${created.slice(0, 5).map(file => `created unowned source file ${file}`).join("; ")}${created.length > 5 ? "; …" : ""}. ${CREATED_FILE_ADVICE}` : ""}`
    : failure ?? ctx.state.summary ?? ctx.state.failure ?? "Run failed";
  // Changes made by other processes are reported, never restored, and never decide the status. A
  // cancelled run keeps the exact summary "cancelled" (the controller recognises it by that text).
  const external = workspace?.external ?? [];
  const summary = external.length && !ctx.cancellation ? `${baseSummary}\n\n${externalChangesWarning(external)}` : baseSummary;
  // A failed run (violation, timeout, error) may still have produced its analysis: keep it next to
  // the failure summary instead of replacing it, so minutes of work are not thrown away.
  const preserved = status === "failed" ? producedResult(ctx, [...workerResults.values()]) : undefined;
  const finishedAt = Date.now();
  emit(ctx, { type: "run_finished", timestamp: finishedAt, status, summary });
  ctx.reported = true;
  return {
    status, summary, rootCause: ctx.state.rootCause?.cause, tasks: ctx.state.tasks,
    startedAt, finishedAt, ownershipViolations: ctx.violations,
    ...(workspace ? { workspace } : {}),
    ...(ctx.timeouts?.length ? { timeouts: ctx.timeouts } : {}),
    ...(ctx.cancellation ? { cancellation: ctx.cancellation } : {}),
    cleanup: { incomplete: pending.length > 0, pending },
    taskClass: ctx.state.taskClass ?? "unclassified",
    answer: status === "done" ? ctx.state.answer ?? summary : preserved ?? summary,
    ...(preserved ? { answerFromFailedRun: true } : {}),
  };
}

/** One-line warning for files changed by somebody else during the run. Never a failure. */
export function externalChangesWarning(external: readonly WorkspaceChange[]): string {
  const files = external.map(change => change.path);
  return `Warning: ${files.length} file${files.length === 1 ? "" : "s"} changed outside this run; not restored: ${files.slice(0, 5).join(", ")}${files.length > 5 ? `, … (+${files.length - 5} more)` : ""}`;
}

interface WorkerResult { agentId: string; kind: string; summary: string }

/**
 * What a run produced before it failed: the coordinator's approved answer when there is one, else
 * the completed worker results (for the answer class the analysts' answers themselves). Undefined
 * when nothing usable exists, in which case the report carries the failure summary alone.
 */
function producedResult(ctx: RunContext, results: readonly WorkerResult[]): string | undefined {
  if (ctx.state.answer?.trim()) return ctx.state.answer;
  if (!results.length) return undefined;
  if (ctx.state.taskClass === "answer") {
    const answers = results.filter(result => result.kind === "answer");
    if (answers.length === 1) return answers[0]!.summary;
    if (answers.length > 1) return answers.map(result => `## ${result.agentId}\n${result.summary}`).join("\n\n");
  }
  return results.map(result => `## ${result.agentId} (${result.kind})\n${result.summary}`).join("\n\n");
}
