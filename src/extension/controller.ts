import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  concurrentActivityOf, defaultSessionsDirs, detectConcurrentSessions, formatConcurrentWarning, sessionsRootOf,
  type ConcurrentActivitySummary, type ConcurrentSessionsResult, type DetectConcurrentSessionsOptions,
} from "./concurrent-sessions.js";
import { discoverOrcheConfig, type ConcurrentSessionsSettings } from "./config.js";
import type { RunTiming } from "./progress.js";
import type { RouteConfig } from "../orchestration/routing.js";
import { resolveRecords, type ResolvedRecords } from "./records.js";

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
export interface OrcheControllerOptions {
  /** Defaults to Pi's agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
  agentDir?: string;
  /** Defaults to `ModelRuntime.create()`: Pi's file-backed credentials. */
  createRuntime?: () => Promise<ModelRuntime>;
  /** Test seam for concurrent-session detection (default: the real detector). It may be disabled by `concurrentSessions.enabled` in the config. */
  detectConcurrentSessions?: (options: DetectConcurrentSessionsOptions) => Promise<ConcurrentSessionsResult>;
  /**
   * Minimum time between two detections of one run or task, the one at its start included (default {@link CONCURRENT_RECHECK_MS}, 30 s):
   * audit points and the end of a task re-detect, but within this time they are answered from the last result. A test seam.
   */
  concurrentRecheckMs?: number;
}
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
 * One orche activity (an orche_task assignment) at a time per Pi session. The runtime is shared lazily,
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

}

/** `text` followed by the `Record: <dir>` line of a result that has a record (finished, failed or cancelled alike); `text` itself when it has none. */
export function withRecordLine(text: string, record: string | undefined): string {
  return record ? `${text}\n\nRecord: ${record}` : text;
}
