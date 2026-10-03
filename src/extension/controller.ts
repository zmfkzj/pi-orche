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
import { describeProgress, extendDeadline, initialDeadline, type DeadlineInfo, type RunTiming } from "./progress.js";
import { resolveRunLimits } from "../orchestration/limits.js";
import { describeWorkspaceChanges, inspectSubmodules, type SubmoduleState } from "../orchestration/workspace.js";
import type { RouteConfig } from "../orchestration/routing.js";
import { createRunRecord, pruneRecordsOnce, resolveRecords, type ResolvedRecords, type RunRecord } from "./records.js";
import { formatExtensionSummary } from "../orchestration/run/extension.js";
import type { FailedHandover, RunHandoverWorker } from "../orchestration/run/types.js";

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
  /**
   * Receives the latest progress lines (newest last) whenever one is added, with the run's {@link RunTiming} (when it started, the deadline as it
   * stands) so that a UI can show the elapsed time and the cap next to them.
   */
  onProgress?: (lines: readonly string[], timing?: RunTiming) => void;
  /**
   * Called once when execution starts, before any progress line exists: when it started and the initial deadline, with the lines to show (the
   * concurrent-session warning, if any). With a warning the first {@link OrcheRunArgs.onProgress} call carries the timing instead.
   */
  onTiming?: (timing: RunTiming, lines: readonly string[]) => void;
  /** Extension-only recovery; omitted when orche_task is unavailable. */
  onFailedHandover?: (handover: FailedHandover, assignmentRequests: number, signal: AbortSignal) => readonly RunHandoverWorker[] | Promise<readonly RunHandoverWorker[]>;
  handoverSkipped?: string;
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
  /**
   * When the run started and ended (epoch ms) and the deadline as it stood at the end (cap, extensions used / allowed); UI-only, like the same keys
   * of every partial update (see {@link RunTiming}). Absent in results recorded before they existed.
   */
  startedAt?: number;
  finishedAt?: number;
  deadline?: DeadlineInfo;
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
  /** Timeout extensions the run was granted (a deadline that expired while the run was still working, pushed out), in order; absent when none. */
  extensions?: RunReport["extensions"];
  cancellation?: RunReport["cancellation"];
  cleanup?: RunReport["cleanup"];
  handover?: RunReport["handover"];
  remainingIssues?: RunReport["remainingIssues"];
  handoverSkipped?: string;
  /** Other pi sessions that were active on the repository when the run started (the run was flagged with `concurrentActivity`). */
  concurrentSessions?: ConcurrentActivitySummary;
  /** The record directory of this run (`<agent dir>/orche/records/<session>/<timestamp>_run-<id>`): manifest, events and sub-session transcripts. Absent when records are off or could not be written. */
  record?: string;
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
  /** What {@link inspectSubmodules} found for a failed run's changed paths, so that the recovery advice is submodule-aware. */
  submodules?: readonly SubmoduleState[];
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
  /**
   * Minimum time between two detections of one run or task, the one at its start included (default {@link CONCURRENT_RECHECK_MS}, 30 s):
   * audit points and the end of a task re-detect, but within this time they are answered from the last result. A test seam.
   */
  concurrentRecheckMs?: number;
}
const PROGRESS_LINES = 8;
const ACTIVITY_INTERVAL_MS = 5000;
/** Default cache lifetime of a concurrent-session detection: re-checks at audit points stay cheap. */
export const CONCURRENT_RECHECK_MS = 30_000;

/** Where a run keeps its records: the root, so that no scan of pi's sessions ever takes the records for sessions. */
export const recordsIgnorePaths = (resolved: ResolvedRecords): string[] => (resolved.enabled ? [resolved.root] : []);

/** Model and thinking level per configured role (`default` is what every role without its own entry uses), for `run.json`. */
export function routesSummary(routes: RouteConfig): Record<string, { model: string; thinking?: string }> {
  const summary: Record<string, { model: string; thinking?: string }> = {};
  const describe = (route: { model: string; thinking?: string }) => ({ model: route.model, ...(route.thinking ? { thinking: route.thinking } : {}) });
  if (routes.default) summary.default = describe(routes.default);
  for (const [role, route] of Object.entries(routes.routes)) summary[role] = describe(route);
  return summary;
}

/**
 * Concurrent-session detection over the life of one run or task: the detection made at its start, plus re-checks. The result is
 * sticky (`latest()` keeps the last non-empty answer: sessions that went quiet were still there), a re-check inside
 * {@link OrcheControllerOptions.concurrentRecheckMs} of the previous detection is answered from it, and nothing here throws.
 */
export interface ConcurrentTracker {
  /** The detection at the start. */
  readonly initial: ConcurrentNotice | undefined;
  /** The notice to report now: the last detection that found sessions. */
  latest(): ConcurrentNotice | undefined;
  /** Detect again unless the last detection is recent; resolves with {@link ConcurrentTracker.latest}. */
  recheck(): Promise<ConcurrentNotice | undefined>;
}

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

  async modelRuntime(signal?: AbortSignal): Promise<ModelRuntime> {
    signal?.throwIfAborted();
    const created = (this.runtime ??= (this.options.createRuntime ?? (() => ModelRuntime.create()))());
    created.catch(() => {
      if (this.runtime === created) this.runtime = undefined;
    });
    if (!signal) return created;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        // An uncooperative startup must not poison the next task's cached runtime.
        if (this.runtime === created) this.runtime = undefined;
        reject(signal.reason ?? new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([created, cancelled]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  /**
   * Look for other pi sessions active on the run's repository. Never throws and never blocks for long: disabled by config, an
   * aborted signal, an empty result and any failure all mean "no notice". `ignorePaths` (the records root) are never scanned.
   */
  async detectConcurrent(args: Pick<OrcheRunArgs, "cwd" | "currentSession">, settings: ConcurrentSessionsSettings, signal?: AbortSignal, ignorePaths: readonly string[] = []): Promise<ConcurrentNotice | undefined> {
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
        ...(ignorePaths.length ? { ignorePaths } : {}),
      });
      if (!Array.isArray(sessions) || !sessions.length) return undefined;
      const now = Date.now();
      return { count: sessions.length, warning: formatConcurrentWarning(sessions, now), activity: concurrentActivityOf(sessions, now) };
    } catch {
      return undefined;
    }
  }

  /**
   * {@link detectConcurrent} at the start of a run or task, as a {@link ConcurrentTracker} that can look again later (at each workspace
   * audit point of a run, at the end of a task) so that a session that started meanwhile is not missed. Re-checks are served from the
   * last detection for {@link OrcheControllerOptions.concurrentRecheckMs}; concurrent calls share one detection.
   */
  async trackConcurrent(args: Pick<OrcheRunArgs, "cwd" | "currentSession">, settings: ConcurrentSessionsSettings, signal: AbortSignal | undefined, ignorePaths: readonly string[] = []): Promise<ConcurrentTracker> {
    const initial = await this.detectConcurrent(args, settings, signal, ignorePaths);
    const interval = Math.max(0, this.options.concurrentRecheckMs ?? CONCURRENT_RECHECK_MS);
    let latest = initial;
    let checkedAt = Date.now();
    let pending: Promise<ConcurrentNotice | undefined> | undefined;
    return {
      initial,
      latest: () => latest,
      recheck: () => {
        if (pending) return pending;
        if (!settings.enabled || signal?.aborted || Date.now() - checkedAt < interval) return Promise.resolve(latest);
        const check = this.detectConcurrent(args, settings, signal, ignorePaths)
          .then(fresh => { if (fresh) latest = fresh; return latest; })
          .finally(() => { checkedAt = Date.now(); pending = undefined; });
        pending = check;
        return check;
      },
    };
  }

  /** The records root that applies to `cwd` (for `/orche records`): the discovered config's `records` settings, defaults when there is no usable config. */
  async recordsFor(args: { cwd: string; projectTrusted: boolean; model?: { provider: string; id: string }; thinking?: ThinkingLevel }): Promise<ResolvedRecords> {
    const agentDir = this.options.agentDir ?? getAgentDir();
    const config = await discoverOrcheConfig({
      cwd: args.cwd, agentDir, projectTrusted: args.projectTrusted,
      session: { model: args.model ? `${args.model.provider}/${args.model.id}` : undefined, thinking: args.thinking },
    }).catch(() => undefined);
    return resolveRecords({ agentDir, cwd: args.cwd, ...(config ? { settings: config.records } : {}) });
  }

  get taskActive(): boolean { return this.active?.kind === "task"; }
  /** The active run or task was cancelled through {@link cancel} (`/orche cancel`), not by an abort signal. */
  get cancelledByUser(): boolean { return this.active?.cancelledByUser ?? false; }

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
    /** When this call started doing work: the origin of the elapsed time the UI shows (`details.startedAt`). */
    const startedAt = Date.now();
    const sessionModel = args.model ? `${args.model.provider}/${args.model.id}` : undefined;
    const agentDir = this.options.agentDir ?? getAgentDir();
    const config = await discoverOrcheConfig({
      cwd: args.cwd,
      agentDir,
      projectTrusted: args.projectTrusted,
      session: { model: sessionModel, thinking: args.thinking },
    });
    // The deadline the UI shows next to the elapsed time: the run's own (runOrchestrated resolves the same limits from `routes.limits`), moved by each
    // `deadline_extended` event below. UI-only: a run whose limits cannot be shown is still a run.
    let deadline: DeadlineInfo | undefined;
    try {
      const limits = resolveRunLimits(config.routes.limits);
      deadline = initialDeadline(limits.overallMs, limits, startedAt);
    } catch { /* no deadline display */ }
    /** The clock the run's deadline counts from: the `run_started` event's, until it arrives this call's start. */
    let deadlineOrigin = startedAt;
    const timing = (): RunTiming => ({ startedAt, ...(deadline ? { deadline } : {}) });
    // Records: the manifest, the event stream and every sub-session's transcript, under <agent dir>/orche/records and never in the
    // workspace (see records.ts). Best effort: a run without a record is still a run.
    const resolved = resolveRecords({ agentDir, cwd: args.cwd, settings: config.records });
    void pruneRecordsOnce(resolved);
    const record: RunRecord | undefined = createRunRecord(resolved, {
      kind: "run", cwd: args.cwd,
      parentSession: { ...(args.currentSession?.id ? { id: args.currentSession.id } : {}), ...(args.currentSession?.file ? { file: args.currentSession.file } : {}) },
      request: args.request, ...(args.context !== undefined ? { context: args.context } : {}),
      manifest: { config: describeSource(config.source), routes: routesSummary(config.routes), ...(config.ignored.length ? { ignoredConfigs: config.ignored } : {}) },
    });
    // At the start, and again at each workspace audit point of the run (RunOptions.detectConcurrentActivity): other pi sessions on
    // this repository make ambiguous changes ambiguous, not violations.
    const tracker = await this.trackConcurrent(args, config.concurrentSessions, signal, recordsIgnorePaths(resolved));
    const concurrent = tracker.initial;
    if (concurrent) record?.update({ concurrentSessions: concurrent.activity });
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
    /** The warning for sessions that appeared during the run (`concurrent_sessions_detected`). */
    let appeared: string | undefined;
    const lastActivity = new Map<string, { timestamp: number; tool?: string }>();
    // The warnings stay first while milestones scroll; activity (the status line) stays last.
    const progressLines = () => [...(concurrent ? [concurrent.warning] : []), ...(appeared ? [appeared] : []), ...milestones, ...(activity ? [activity] : [])];
    const totals = { requests: 0, inputTokens: 0, outputTokens: 0, advisorRequests: 0 };
    const models: Record<string, Record<string, number>> = {};
    const contextWindows: Record<string, OrcheRunDetails["contextWindows"][string]> = {};
    const sink = (event: RunEvent) => {
      record?.appendEvent(event);
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
      if (event.type === "run_started") {
        deadlineOrigin = event.timestamp;
        if (deadline && deadline.extensionsUsed === 0) deadline = { ...deadline, deadlineAt: deadlineOrigin + deadline.capMs };
      } else if (event.type === "deadline_extended" && deadline) {
        deadline = extendDeadline(deadline, { n: event.extension, max: event.maxExtensions, extensionMs: event.extensionMs, scope: event.scope, overallDeadline: event.overallDeadline }, deadlineOrigin);
      }
      const line = describeProgress(event);
      if (!line) return;
      if (event.type === "concurrent_sessions_detected") {
        appeared = line;
        args.onProgress?.(progressLines(), timing());
        return;
      }
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
        if (event.type === "phase_changed" || (event.type === "task_finished" && event.agentId === activityActor) || event.type === "run_timeout" || event.type === "deadline_extended" || event.type === "coordinator_deciding" || event.type === "coordinator_reconsidering") {
          activity = undefined;
          activityActor = undefined;
        }
      }
      args.onProgress?.(progressLines(), timing());
    };
    // The first update: with a concurrent-session warning it is the progress update that carries the timing, else a timing-only one.
    if (concurrent) args.onProgress?.(progressLines(), timing()); else args.onTiming?.(timing(), progressLines());
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
        ...(config.concurrentSessions.enabled ? { detectConcurrentActivity: async () => (await tracker.recheck())?.activity } : {}),
        ...(record ? { records: record.records } : {}),
        ...(args.onFailedHandover ? { onFailedHandover: (handover: FailedHandover) => args.onFailedHandover!(handover, resolveRunLimits(config.routes.limits).assignmentRequests, signal) } : {}),
      });
    } catch (error) {
      record?.finish({ status: signal.aborted ? "cancelled" : "failed", failure: error instanceof Error ? error.message : String(error) });
      const latest = tracker.latest();
      throw latest ? withConcurrentWarning(error, latest.warning) : error;
    }
    // An uncooperative provider startup may still mutate its runtime after return. Do not reuse it.
    if (report.cleanup?.pending.some(item => item === "providers" || item === "execution/SDK creation")) this.runtime = undefined;
    const text = report.status === "done" ? report.answer : report.summary;
    const cancelled = signal.aborted && report.status === "failed" && report.summary === "cancelled";
    const latest = tracker.latest();
    // Recovery advice for a failed run must know which changed paths are submodules (a gitlink, or a file inside one). Not given the
    // run's signal: after a cancel the lookup is still wanted, and it is bounded on its own.
    const changed = report.status === "done" || !report.workspace ? [] : [...report.workspace.changes, ...(report.workspace.external ?? [])].map(change => change.path);
    const submodules = changed.length ? await inspectSubmodules(args.cwd, report.workspace!.baseline, changed) : [];
    record?.finish({
      status: cancelled ? "cancelled" : report.status === "done" ? "done" : "failed",
      taskClass: report.taskClass,
      summary: report.summary,
      ...(report.status === "done" ? {} : { failure: report.summary }),
      ...(cancelled && this.active?.cancelledByUser ? { cancelledByUser: true } : {}),
      workspace: {
        ...(report.workspace ? { baseline: report.workspace.baseline, changes: report.workspace.changes, external: report.workspace.external ?? [] } : { audit: "unavailable" }),
        violations: report.ownershipViolations ?? [],
      },
      ...(report.cleanup ? { cleanup: report.cleanup } : {}),
      ...(report.timeouts ? { timeouts: report.timeouts } : {}),
      ...(report.extensions ? { extensions: report.extensions } : {}),
      ...(report.cancellation ? { cancellation: report.cancellation } : {}),
      usage: { ...totals, models, contextWindows },
      ...(report.handover ? { handover: report.handover } : {}),
      ...(report.remainingIssues ? { remainingIssues: report.remainingIssues } : {}),
      ...(latest ? { concurrentSessions: latest.activity } : {}),
    });
    // The extensions the report lists are authoritative for the final deadline (a run that emitted no events still shows what it was granted).
    const lastExtension = report.extensions?.at(-1);
    if (deadline && lastExtension && lastExtension.n > deadline.extensionsUsed) deadline = extendDeadline(deadline, lastExtension, deadlineOrigin);
    const finishedAt = Date.now();
    return {
      report,
      text,
      source: config.source,
      cancelledByUser: false,
      ...(latest ? { concurrentWarning: latest.warning } : {}),
      ...(submodules.length ? { submodules } : {}),
      details: {
        status: report.status,
        taskClass: report.taskClass,
        durationMs: report.finishedAt - report.startedAt,
        startedAt, finishedAt, ...(deadline ? { deadline } : {}),
        config: describeSource(config.source),
        ignoredConfigs: config.ignored,
        tasks: report.tasks.length,
        ...totals,
        models,
        contextWindows,
        cancelled,
        progress: progressLines(),
        ...(report.timeouts ? { timeouts: report.timeouts } : {}),
        ...(report.extensions ? { extensions: report.extensions } : {}),
        ...(report.cancellation ? { cancellation: report.cancellation } : {}),
        ...(report.cleanup ? { cleanup: report.cleanup } : {}),
        ...(report.handover ? { handover: report.handover } : {}),
        ...(report.remainingIssues ? { remainingIssues: report.remainingIssues } : {}),
        ...(!cancelled && report.status === "failed" && args.handoverSkipped ? { handoverSkipped: args.handoverSkipped } : {}),
        ...(latest ? { concurrentSessions: latest.activity } : {}),
        ...(record ? { record: record.dir } : {}),
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
    finished ? "" : describeWorkspaceChanges(report.workspace?.baseline ?? "", changes, external, outcome.submodules),
  ].filter(Boolean).map(part => `\n\n${part}`).join("");
  // A failed run keeps what it produced; show it under its own marker, never as a verified result.
  const preserved = !finished && report.answerFromFailedRun && report.answer.trim()
    ? `\n\nResult from failed run (may be incomplete):\n${report.answer}`
    : "";
  const handover = finished || details.cancelled ? "" : report.handover
    ? `\n\nHandover (orche_task worker ids):\n${report.handover.workers.map(worker => `${worker.id} (${worker.role}) — last task: ${worker.lastTask ? `${worker.lastTask.id}: ${worker.lastTask.description.replace(/\s+/g, " ").slice(0, 200)}` : "none"}`).join("\n") || "No live workers available."}\nRemaining issues: ${report.handover.issues.join("; ") || report.summary}`
    : details.handoverSkipped
      ? `\n\nHandover skipped: ${details.handoverSkipped}.\nRemaining issues: ${(report.remainingIssues ?? [report.summary]).join("; ")}`
      : "";
  const cleanup = report.cleanup?.incomplete ? `\n\nCleanup incomplete; pending: ${report.cleanup.pending.join(", ")}. Uncooperative in-process SDK/tool work cannot be forcibly stopped.` : "";
  const diagnostic = report.cancellation;
  const cancellation = !diagnostic ? "" : `\n\nCancelled at ${diagnostic.phase} after ${Math.round(diagnostic.elapsedMs / 1000)}s; active: ${diagnostic.workers.map(worker => {
    if (!worker.assignmentId) return `${worker.id} ${worker.status ?? "idle"}`;
    const tool = worker.lastToolName ? `, last tool ${worker.lastToolName}${worker.lastToolAt !== undefined ? ` ${Math.max(0, Math.round((diagnostic.timestamp - worker.lastToolAt) / 1000))}s ago` : ""}` : "";
    return `${worker.id} ${worker.kind} (${worker.requestCount ?? 0} requests${tool})`;
  }).join(", ") || "none"}`;
  // The extensions the run used (and what each justified), for finished, failed and cancelled runs alike; nothing when it never needed one.
  const granted = report.extensions ?? [];
  const extensions = granted.length ? `\n\n${formatExtensionSummary(granted, { maxExtensions: granted[0]!.max, extensionMs: granted[0]!.extensionMs }).join("\n")}` : "";
  // Other pi sessions seen at the start come first, for finished, failed and cancelled runs alike.
  const concurrent = outcome.concurrentWarning ? `${outcome.concurrentWarning}\n\n` : "";
  // Other pi sessions seen during the run come first; where the transcripts and the manifest are (records.ts) comes last.
  return withRecordLine(`${concurrent}${head}\n\n${outcome.text}${handover}${preserved}${cancellation}${extensions}${workspace}${cleanup}`, details.record);
}

/** `text` followed by the `Record: <dir>` line of a result that has a record (finished, failed or cancelled alike); `text` itself when it has none. */
export function withRecordLine(text: string, record: string | undefined): string {
  return record ? `${text}\n\nRecord: ${record}` : text;
}
