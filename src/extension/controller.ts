import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runOrchestrated, type RunReport } from "../orchestration/coordinator.js";
import type { RunEvent } from "../orchestration/events.js";
import { describeSource, discoverOrcheConfig, NoRouteError, type ConfigSource } from "./config.js";
import { describeProgress } from "./progress.js";
import { describeWorkspaceChanges } from "../orchestration/workspace.js";

export class OrcheBusyError extends Error {
  override readonly name = "OrcheBusyError";
  constructor(kind: "run" | "task" = "run") {
    super(`An orche ${kind} is already active in this session; wait for it to finish or cancel it (/orche cancel).`);
  }
}

export interface OrcheRunArgs {
  request: string;
  /** Background from the requesting conversation; appended to the problem statement the orchestrator sees. */
  context?: string;
  cwd: string;
  /** The Pi session's current model (`ctx.model`) and thinking level. */
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
  projectTrusted: boolean;
  /** Tool/command cancellation. */
  signal?: AbortSignal;
  /** Receives the latest progress lines (newest last) whenever one is added. */
  onProgress?: (lines: readonly string[]) => void;
}
export interface OrcheRunDetails {
  status: RunReport["status"];
  taskClass: RunReport["taskClass"];
  durationMs: number;
  config: string;
  ignoredConfigs: readonly string[];
  tasks: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  advisorRequests: number;
  /** Model requests per actor (`coordinator`, worker ids such as `A1`/`V1`, `advisor:<name>`): provider/model → count. */
  models: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Effective context window per actor, with the model and whether it was raised above the advertised window. */
  contextWindows: Readonly<Record<string, { model: string; contextWindow: number; advertisedContextWindow: number; extended: boolean }>>;
  /** The run ended because it was cancelled (by `/orche cancel`, the tool's abort signal or shutdown). */
  cancelled: boolean;
  progress: readonly string[];
  timeouts?: RunReport["timeouts"];
  cancellation?: RunReport["cancellation"];
  cleanup?: RunReport["cleanup"];
}
export interface OrcheOutcome {
  report: RunReport;
  /** Final user-facing text: the answer on success, the failure summary otherwise. */
  text: string;
  details: OrcheRunDetails;
  /** The cancellation came from `/orche cancel`. */
  cancelledByUser: boolean;
  source: ConfigSource;
}
export interface OrcheControllerOptions {
  /** Defaults to Pi's agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
  agentDir?: string;
  /** Defaults to `ModelRuntime.create()`: Pi's file-backed credentials. */
  createRuntime?: () => Promise<ModelRuntime>;
  /** Test seam for the run itself. */
  run?: typeof runOrchestrated;
}
const PROGRESS_LINES = 8;
const ACTIVITY_INTERVAL_MS = 5000;

/**
 * One orche activity (task or multi run) at a time per Pi session. The runtime is shared lazily,
 * through Pi's public, file-backed `ModelRuntime`.
 */
export class OrcheController {
  private active: { kind: "run" | "task"; abort: AbortController; cancelledByUser: boolean; done: Promise<unknown> } | undefined;
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(private readonly options: OrcheControllerOptions = {}) {}

  get busy(): boolean {
    return this.active !== undefined;
  }
  /** Cancel the active run on the user's behalf, if any. Returns whether there was one. */
  cancel(): boolean {
    if (!this.active) return false;
    this.active.cancelledByUser = true;
    this.active.abort.abort();
    return true;
  }
  /** Resolves once the active run returns; inspect report.cleanup for uncooperative pending work. */
  async whenIdle(): Promise<void> {
    await this.active?.done.catch(() => undefined);
  }

  modelRuntime(): Promise<ModelRuntime> {
    const created = (this.runtime ??= (this.options.createRuntime ?? (() => ModelRuntime.create()))());
    created.catch(() => {
      if (this.runtime === created) this.runtime = undefined;
    });
    return created;
  }

  get taskActive(): boolean { return this.active?.kind === "task"; }

  /** Reserve the same session activity slot used by multi runs. */
  async task<T>(signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new OrcheBusyError(this.active.kind);
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const state = { kind: "task" as const, abort, cancelledByUser: false, done: Promise.resolve() as Promise<unknown> };
    this.active = state;
    const execution = Promise.resolve().then(() => execute(combined));
    state.done = execution;
    try {
      const result = await execution;
      if (combined.aborted) throw new Error(state.cancelledByUser ? "cancelled by user" : "cancelled");
      return result;
    } catch (error) {
      if (combined.aborted) throw new Error(state.cancelledByUser ? "cancelled by user" : "cancelled");
      throw error;
    } finally { if (this.active === state) this.active = undefined; }
  }

  async run(args: OrcheRunArgs): Promise<OrcheOutcome> {
    if (this.active) throw new OrcheBusyError(this.active.kind);
    const abort = new AbortController();
    const signal = args.signal ? AbortSignal.any([args.signal, abort.signal]) : abort.signal;
    const state = { kind: "run" as const, abort, cancelledByUser: false, done: Promise.resolve() as Promise<unknown> };
    this.active = state;
    const execution = this.execute(args, signal);
    state.done = execution;
    try {
      const outcome = await execution;
      return { ...outcome, cancelledByUser: state.cancelledByUser && outcome.details.cancelled };
    } finally {
      this.active = undefined;
    }
  }

  private async execute(args: OrcheRunArgs, signal: AbortSignal): Promise<OrcheOutcome> {
    const sessionModel = args.model ? `${args.model.provider}/${args.model.id}` : undefined;
    const config = await discoverOrcheConfig({
      cwd: args.cwd,
      agentDir: this.options.agentDir ?? getAgentDir(),
      projectTrusted: args.projectTrusted,
      session: { model: sessionModel, thinking: args.thinking },
    });
    const createRuntime = async () => {
      const runtime = await this.modelRuntime();
      signal.throwIfAborted();
      if (config.source.kind === "session" && args.model && !runtime.getModel(args.model.provider, args.model.id)) {
        throw new NoRouteError(
          `The session model ${sessionModel} cannot be resolved by orche's own model runtime (it does not see providers that other Pi extensions register, nor in-memory credentials). Route orche explicitly in ${args.cwd}/.pi/orche.config.json, and list the provider's Pi package in "providerExtensions" if the provider comes from an extension (see docs/pi-package.md).`,
        );
      }
      return runtime;
    };
    const milestones: string[] = [];
    let activity: string | undefined;
    let activityActor: string | undefined;
    const lastActivity = new Map<string, { timestamp: number; tool?: string }>();
    const progressLines = () => [...milestones, ...(activity ? [activity] : [])];
    const totals = { requests: 0, inputTokens: 0, outputTokens: 0, advisorRequests: 0 };
    const models: Record<string, Record<string, number>> = {};
    const contextWindows: Record<string, OrcheRunDetails["contextWindows"][string]> = {};
    const sink = (event: RunEvent) => {
      if (event.type === "context_window") {
        const { type: _type, timestamp: _timestamp, actor, ...info } = event;
        contextWindows[actor] = info;
      }
      if (event.type === "usage" || event.type === "coordinator_usage" || event.type === "advisor_usage") {
        totals.requests++;
        totals.inputTokens += event.input;
        totals.outputTokens += event.output;
        if (event.type === "advisor_usage") totals.advisorRequests++;
        const actor = event.type === "usage" ? event.agentId : event.type === "coordinator_usage" ? "coordinator" : `advisor:${event.name}`;
        const byModel = (models[actor] ??= {});
        byModel[event.model] = (byModel[event.model] ?? 0) + 1;
      }
      const line = describeProgress(event);
      if (!line) return;
      if (event.type === "worker_activity" || event.type === "coordinator_activity") {
        const actor = event.type === "worker_activity" ? event.agentId : "coordinator";
        const tool = event.type === "worker_activity" ? event.lastToolName : undefined;
        const previous = lastActivity.get(actor);
        if (previous && previous.tool === tool && event.timestamp - previous.timestamp < ACTIVITY_INTERVAL_MS) return;
        lastActivity.set(actor, { timestamp: event.timestamp, tool });
        if (activity === line) return;
        activity = line;
        activityActor = actor;
      } else {
        milestones.push(line);
        if (milestones.length > PROGRESS_LINES) milestones.shift();
        // Lifecycle/decision milestones supersede stale activity. Advice does not interrupt
        // active work: keep that activity visible while its NOTE waits for the next decision.
        if (event.type === "phase_changed" || (event.type === "task_finished" && event.agentId === activityActor) || event.type === "run_timeout" || event.type === "coordinator_deciding" || event.type === "coordinator_reconsidering") {
          activity = undefined;
          activityActor = undefined;
        }
      }
      args.onProgress?.(progressLines());
    };
    const report = await (this.options.run ?? runOrchestrated)({
      problem: args.context?.trim() ? `${args.request}\n\n## Context from the requesting session\n${args.context.trim()}` : args.request,
      cwd: args.cwd,
      // Keep explicit config caps on routes; the run resolver merges API overrides before derivation.
      routes: config.routes,
      createRuntime,
      signal,
      sink,
    });
    // An uncooperative provider startup may still mutate its runtime after return. Do not reuse it.
    if (report.cleanup?.pending.some(item => item === "providers" || item === "execution/SDK creation")) this.runtime = undefined;
    const text = report.status === "done" ? report.answer : report.summary;
    return {
      report,
      text,
      source: config.source,
      cancelledByUser: false,
      details: {
        status: report.status,
        taskClass: report.taskClass,
        durationMs: report.finishedAt - report.startedAt,
        config: describeSource(config.source),
        ignoredConfigs: config.ignored,
        tasks: report.tasks.length,
        ...totals,
        models,
        contextWindows,
        cancelled: signal.aborted && report.status === "failed" && report.summary === "cancelled",
        progress: progressLines(),
        ...(report.timeouts ? { timeouts: report.timeouts } : {}),
        ...(report.cancellation ? { cancellation: report.cancellation } : {}),
        ...(report.cleanup ? { cleanup: report.cleanup } : {}),
      },
    };
  }
}

/** Text shown to the user and the main model for a finished run. */
export function formatOutcome(outcome: OrcheOutcome): string {
  const { details, report } = outcome;
  const seconds = Math.round(details.durationMs / 1000);
  const head = details.cancelled
    ? `orche CANCELLED${outcome.cancelledByUser ? " by user" : ""} (${seconds}s; ${details.config})`
    : report.status === "done"
      ? `orche finished (${details.taskClass}, ${seconds}s, ${details.requests} model requests; ${details.config})`
      : `orche FAILED (${details.taskClass}, ${seconds}s; ${details.config})`;
  const changes = report.workspace?.changes ?? [];
  const workspace = !changes.length ? ""
    : report.status === "done"
      ? `\n\nChanged files: ${changes.map(change => change.path).join(", ")}`
      : `\n\n${describeWorkspaceChanges(report.workspace!.baseline, changes)}`;
  const cleanup = report.cleanup?.incomplete ? `\n\nCleanup incomplete; pending: ${report.cleanup.pending.join(", ")}. Uncooperative in-process SDK/tool work cannot be forcibly stopped.` : "";
  const diagnostic = report.cancellation;
  const cancellation = !diagnostic ? "" : `\n\nCancelled at ${diagnostic.phase} after ${Math.round(diagnostic.elapsedMs / 1000)}s; active: ${diagnostic.workers.map(worker => {
    if (!worker.assignmentId) return `${worker.id} ${worker.status ?? "idle"}`;
    const tool = worker.lastToolName ? `, last tool ${worker.lastToolName}${worker.lastToolAt !== undefined ? ` ${Math.max(0, Math.round((diagnostic.timestamp - worker.lastToolAt) / 1000))}s ago` : ""}` : "";
    return `${worker.id} ${worker.kind} (${worker.requestCount ?? 0} requests${tool})`;
  }).join(", ") || "none"}`;
  return `${head}\n\n${outcome.text}${cancellation}${workspace}${cleanup}`;
}
