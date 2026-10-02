import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { externalChangesWarning, runOrchestrated, type RunReport } from "../orchestration/coordinator.js";
import type { RunEvent } from "../orchestration/events.js";
import {
  concurrentActivityOf, defaultSessionsDirs, detectConcurrentSessions, formatConcurrentWarning, sessionsRootOf,
  type ConcurrentActivitySummary, type ConcurrentSessionsResult, type DetectConcurrentSessionsOptions,
} from "./concurrent-sessions.js";
import { describeSource, discoverOrcheConfig, NoRouteError, type ConcurrentSessionsSettings, type ConfigSource } from "./config.js";
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
  /**
   * The calling Pi session (`ctx.sessionManager`): its file and id are never reported as another session, and its
   * directory locates the session store scanned for other sessions.
   */
  currentSession?: { file?: string; id?: string; dir?: string };
}
/** Other pi sessions found active on the repository when an activity started. */
export interface ConcurrentNotice {
  count: number;
  /** One-line warning for tool results and progress. */
  warning: string;
  /** `RunOptions.concurrentActivity`. */
  activity: ConcurrentActivitySummary;
}
/**
 * Prefix an error's message with the concurrent-session warning so a thrown result carries it too. The error object is kept
 * (class, cause) when its message is writable; otherwise (DOMException) it is wrapped.
 */
export function withConcurrentWarning(error: unknown, warning: string): unknown {
  if (!(error instanceof Error)) return new Error(`${warning}\n\n${String(error)}`);
  const message = `${warning}\n\n${error.message}`;
  try {
    error.message = message;
    if (error.message === message) return error;
  } catch { /* read-only message */ }
  return new Error(message, { cause: error });
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
  /** Other pi sessions that were active on the repository when the run started (the run was flagged with `concurrentActivity`). */
  concurrentSessions?: ConcurrentActivitySummary;
}
export interface OrcheOutcome {
  report: RunReport;
  /**
   * Final user-facing text: the answer on success, the failure summary otherwise. A failed run's
   * preserved answer (`report.answer` with `answerFromFailedRun`) is shown by {@link formatOutcome}.
   */
  text: string;
  details: OrcheRunDetails;
  /** The cancellation came from `/orche cancel`. */
  cancelledByUser: boolean;
  source: ConfigSource;
  /** Warning line for other pi sessions active at the start; {@link formatOutcome} puts it first. */
  concurrentWarning?: string;
}
export interface OrcheControllerOptions {
  /** Defaults to Pi's agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
  agentDir?: string;
  /** Defaults to `ModelRuntime.create()`: Pi's file-backed credentials. */
  createRuntime?: () => Promise<ModelRuntime>;
  /** Test seam for the run itself. */
  run?: typeof runOrchestrated;
  /** Test seam for concurrent-session detection (default: the real detector). It may be disabled by `concurrentSessions.enabled` in the config. */
  detectConcurrentSessions?: (options: DetectConcurrentSessionsOptions) => Promise<ConcurrentSessionsResult>;
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

  /**
   * Look for other pi sessions active on the run's repository, once, at the start of a run or task. Never throws and never
   * blocks for long: disabled by config, an aborted signal, an empty result and any failure all mean "no notice".
   */
  async detectConcurrent(args: Pick<OrcheRunArgs, "cwd" | "currentSession">, settings: ConcurrentSessionsSettings, signal?: AbortSignal): Promise<ConcurrentNotice | undefined> {
    if (!settings.enabled || signal?.aborted) return undefined;
    try {
      const detect = this.options.detectConcurrentSessions ?? detectConcurrentSessions;
      const stores = [
        ...(args.currentSession?.dir ? [sessionsRootOf(args.currentSession.dir)] : []),
        ...(this.options.agentDir ? [join(this.options.agentDir, "sessions")] : defaultSessionsDirs()),
      ];
      const { sessions } = await detect({
        cwd: args.cwd,
        sessionsDir: stores,
        windowMs: settings.windowMinutes * 60_000,
        ...(args.currentSession?.file ? { currentSessionFile: args.currentSession.file } : {}),
        ...(args.currentSession?.id ? { currentSessionId: args.currentSession.id } : {}),
      });
      if (!Array.isArray(sessions) || !sessions.length) return undefined;
      const now = Date.now();
      return { count: sessions.length, warning: formatConcurrentWarning(sessions, now), activity: concurrentActivityOf(sessions, now) };
    } catch {
      return undefined;
    }
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
    // Once, at the start: other pi sessions on this repository make ambiguous changes ambiguous, not violations.
    const concurrent = await this.detectConcurrent(args, config.concurrentSessions, signal);
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
    // The warning stays first while milestones scroll; activity (the status line) stays last.
    const progressLines = () => [...(concurrent ? [concurrent.warning] : []), ...milestones, ...(activity ? [activity] : [])];
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
    if (concurrent) args.onProgress?.(progressLines());
    let report: RunReport;
    try {
      report = await (this.options.run ?? runOrchestrated)({
        problem: args.context?.trim() ? `${args.request}\n\n## Context from the requesting session\n${args.context.trim()}` : args.request,
        cwd: args.cwd,
        // Keep explicit config caps on routes; the run resolver merges API overrides before derivation.
        routes: config.routes,
        createRuntime,
        signal,
        sink,
        ...(concurrent ? { concurrentActivity: concurrent.activity } : {}),
      });
    } catch (error) {
      throw concurrent ? withConcurrentWarning(error, concurrent.warning) : error;
    }
    // An uncooperative provider startup may still mutate its runtime after return. Do not reuse it.
    if (report.cleanup?.pending.some(item => item === "providers" || item === "execution/SDK creation")) this.runtime = undefined;
    const text = report.status === "done" ? report.answer : report.summary;
    return {
      report,
      text,
      source: config.source,
      cancelledByUser: false,
      ...(concurrent ? { concurrentWarning: concurrent.warning } : {}),
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
        ...(concurrent ? { concurrentSessions: concurrent.activity } : {}),
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
  const external = report.workspace?.external ?? [];
  // Run-attributed files get restore advice; files changed by somebody else are listed apart, as
  // not-to-restore. A finished run only names them (its text is the answer, not the summary).
  const finished = report.status === "done";
  const workspace = [
    finished && changes.length ? `Changed files: ${changes.map(change => change.path).join(", ")}` : "",
    finished && external.length ? externalChangesWarning(external) : "",
    finished ? "" : describeWorkspaceChanges(report.workspace?.baseline ?? "", changes, external),
  ].filter(Boolean).map(part => `\n\n${part}`).join("");
  // A failed run keeps what it produced; show it under its own marker, never as a verified result.
  const preserved = !finished && report.answerFromFailedRun && report.answer.trim()
    ? `\n\nResult from failed run (may be incomplete):\n${report.answer}`
    : "";
  const cleanup = report.cleanup?.incomplete ? `\n\nCleanup incomplete; pending: ${report.cleanup.pending.join(", ")}. Uncooperative in-process SDK/tool work cannot be forcibly stopped.` : "";
  const diagnostic = report.cancellation;
  const cancellation = !diagnostic ? "" : `\n\nCancelled at ${diagnostic.phase} after ${Math.round(diagnostic.elapsedMs / 1000)}s; active: ${diagnostic.workers.map(worker => {
    if (!worker.assignmentId) return `${worker.id} ${worker.status ?? "idle"}`;
    const tool = worker.lastToolName ? `, last tool ${worker.lastToolName}${worker.lastToolAt !== undefined ? ` ${Math.max(0, Math.round((diagnostic.timestamp - worker.lastToolAt) / 1000))}s ago` : ""}` : "";
    return `${worker.id} ${worker.kind} (${worker.requestCount ?? 0} requests${tool})`;
  }).join(", ") || "none"}`;
  // Other pi sessions seen at the start come first, for finished, failed and cancelled runs alike.
  const concurrent = outcome.concurrentWarning ? `${outcome.concurrentWarning}\n\n` : "";
  return `${concurrent}${head}\n\n${outcome.text}${preserved}${cancellation}${workspace}${cleanup}`;
}
