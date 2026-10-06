import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseRouteConfig, RouteConfigError, type RouteConfig } from "../orchestration/routing.js";
import { DEFAULT_WINDOW_MS } from "./concurrent-sessions.js";
import { DEFAULT_CONTEXT_WARNING, type ContextWarningSettings } from "./context-warning.js";

export const CONFIG_FILE = "orche.config.json";

export interface SessionModel {
  /** `provider/modelId` of the interactive session's current model. */
  model?: string;
  thinking?: ThinkingLevel;
}
export type ConfigSource =
  | { kind: "project"; path: string }
  | { kind: "user"; path: string }
  | { kind: "session"; model: string; thinking?: ThinkingLevel };
export interface DiscoveredConfig {
  routes: RouteConfig;
  /** `concurrentSessions` of the selected file with defaults applied (enabled, 10 minutes). */
  concurrentSessions: ConcurrentSessionsSettings;
  /** `records` of the selected file with defaults applied (enabled, 30 days retention, default directory). */
  records: RecordsSettings;
  /** Request-only earlier-output projection for reused task workers, with defaults applied. */
  taskContext: TaskContextSettings;
  /** Main-session context advisory in direct mode, with defaults applied. */
  contextWarning?: ContextWarningSettings;
  /** Single-workflow options (task ledger, orchestrator spawning), with defaults applied. */
  single: SingleSettings;
  /** Settings of the selected file that were ignored (removed `single` keys); absent without a file. */
  warnings?: string[];
  source: ConfigSource;
  /** Config files that exist but were not used, with the reason. */
  ignored: string[];
}

/** `concurrentSessions` in orche.config.json: warn about other pi sessions active on the same repository. */
export interface ConcurrentSessionsConfig {
  /** Default true. */
  enabled?: boolean;
  /** A session counts as active when its file was written within this many minutes. Default 10. */
  windowMinutes?: number;
}
export interface ConcurrentSessionsSettings {
  enabled: boolean;
  windowMinutes: number;
}
export const DEFAULT_CONCURRENT_SESSIONS: Readonly<ConcurrentSessionsSettings> = { enabled: true, windowMinutes: DEFAULT_WINDOW_MS / 60_000 };
export const MAX_CONCURRENT_WINDOW_MINUTES = 24 * 60;

export function parseConcurrentSessionsConfig(value: unknown): ConcurrentSessionsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.concurrentSessions: expected object");
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some(key => key !== "enabled" && key !== "windowMinutes")) throw new RouteConfigError("config.concurrentSessions: unknown field");
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new RouteConfigError("config.concurrentSessions.enabled: expected boolean");
  const minutes = settings.windowMinutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_CONCURRENT_WINDOW_MINUTES))
    throw new RouteConfigError(`config.concurrentSessions.windowMinutes: expected a number greater than 0 and at most ${MAX_CONCURRENT_WINDOW_MINUTES}`);
  return {
    ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
    ...(minutes !== undefined ? { windowMinutes: minutes as number } : {}),
  };
}

export function resolveConcurrentSessions(config?: ConcurrentSessionsConfig): ConcurrentSessionsSettings {
  return {
    enabled: config?.enabled ?? DEFAULT_CONCURRENT_SESSIONS.enabled,
    windowMinutes: config?.windowMinutes ?? DEFAULT_CONCURRENT_SESSIONS.windowMinutes,
  };
}

/**
 * `records` in orche.config.json: keep the transcripts of orche's sub-sessions (coordinator, workers, verifiers, advisors, `orche_task`
 * workers) and a manifest per run under `<agent dir>/orche/records/`. Outside pi's own sessions directory and never inside the workspace.
 */
export interface RecordsConfig {
  /** Default true. */
  enabled?: boolean;
  /** Records root. Absolute, or starting with `~/`. Default `<agent dir>/orche/records`. A directory inside the run's workspace is refused. */
  dir?: string;
  /** Record directories untouched for longer than this many days are deleted when the first run of a process starts. Default 30. */
  retentionDays?: number;
  /** Optional size cap of the whole records root in bytes: after the age pass the oldest records are deleted until it fits. */
  maxBytes?: number;
}
export interface RecordsSettings {
  enabled: boolean;
  dir?: string;
  retentionDays: number;
  maxBytes?: number;
}
export const DEFAULT_RECORDS_RETENTION_DAYS = 30;
export const MAX_RECORDS_RETENTION_DAYS = 3650;
export const DEFAULT_RECORDS: Readonly<RecordsSettings> = { enabled: true, retentionDays: DEFAULT_RECORDS_RETENTION_DAYS };

export function parseRecordsConfig(value: unknown): RecordsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.records: expected object");
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some(key => key !== "enabled" && key !== "dir" && key !== "retentionDays" && key !== "maxBytes")) throw new RouteConfigError("config.records: unknown field");
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new RouteConfigError("config.records.enabled: expected boolean");
  const { dir, retentionDays, maxBytes } = settings;
  if (dir !== undefined && (typeof dir !== "string" || !dir.trim() || dir !== dir.trim() || dir.includes("\0") || !(isAbsolute(dir) || dir.startsWith("~/") && dir.length > 2)))
    throw new RouteConfigError("config.records.dir: expected a non-empty absolute path (or one starting with ~/)");
  if (retentionDays !== undefined && (typeof retentionDays !== "number" || !Number.isFinite(retentionDays) || retentionDays <= 0 || retentionDays > MAX_RECORDS_RETENTION_DAYS))
    throw new RouteConfigError(`config.records.retentionDays: expected a number greater than 0 and at most ${MAX_RECORDS_RETENTION_DAYS}`);
  if (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0))
    throw new RouteConfigError("config.records.maxBytes: expected a positive integer");
  return {
    ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
    ...(dir !== undefined ? { dir: dir as string } : {}),
    ...(retentionDays !== undefined ? { retentionDays: retentionDays as number } : {}),
    ...(maxBytes !== undefined ? { maxBytes: maxBytes as number } : {}),
  };
}

export function resolveRecordsSettings(config?: RecordsConfig): RecordsSettings {
  return {
    enabled: config?.enabled ?? DEFAULT_RECORDS.enabled,
    ...(config?.dir !== undefined ? { dir: config.dir } : {}),
    retentionDays: config?.retentionDays ?? DEFAULT_RECORDS.retentionDays,
    ...(config?.maxBytes !== undefined ? { maxBytes: config.maxBytes } : {}),
  };
}

/** Shared config validation; projection is task-only and settings are reread at each task call. */
export interface TaskContextSettings {
  /** false stops new clears, never revokes a worker's existing projection. */
  clearBetweenAssignments: boolean;
  minClearTokens: number;
}
export const DEFAULT_TASK_CONTEXT: Readonly<TaskContextSettings> = { clearBetweenAssignments: true, minClearTokens: 10000 };
export function parseTaskContextConfig(value: unknown): TaskContextSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.taskContext: expected object");
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some(key => key !== "clearBetweenAssignments" && key !== "minClearTokens")) throw new RouteConfigError("config.taskContext: unknown field");
  if (settings.clearBetweenAssignments !== undefined && typeof settings.clearBetweenAssignments !== "boolean") throw new RouteConfigError("config.taskContext.clearBetweenAssignments: expected boolean");
  if (settings.minClearTokens !== undefined && (typeof settings.minClearTokens !== "number" || !Number.isSafeInteger(settings.minClearTokens) || settings.minClearTokens < 0)) throw new RouteConfigError("config.taskContext.minClearTokens: expected a nonnegative integer");
  return {
    clearBetweenAssignments: (settings.clearBetweenAssignments as boolean | undefined) ?? DEFAULT_TASK_CONTEXT.clearBetweenAssignments,
    minClearTokens: (settings.minClearTokens as number | undefined) ?? DEFAULT_TASK_CONTEXT.minClearTokens,
  };
}
export function parseContextWarningConfig(value: unknown): ContextWarningSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.contextWarning: expected object");
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some(key => key !== "enabled" && key !== "thresholds")) throw new RouteConfigError("config.contextWarning: unknown field");
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new RouteConfigError("config.contextWarning.enabled: expected boolean");
  const thresholds = settings.thresholds;
  if (thresholds !== undefined) {
    if (!Array.isArray(thresholds) || thresholds.length === 0 || thresholds.length > 5) throw new RouteConfigError("config.contextWarning.thresholds: expected 1-5 percentages");
    for (const [index, threshold] of thresholds.entries()) {
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 100) throw new RouteConfigError(`config.contextWarning.thresholds[${index}]: expected a percentage greater than 0 and below 100`);
      if (index > 0 && threshold <= (thresholds[index - 1] as number)) throw new RouteConfigError("config.contextWarning.thresholds: expected strictly ascending percentages");
    }
  }
  return {
    enabled: (settings.enabled as boolean | undefined) ?? DEFAULT_CONTEXT_WARNING.enabled,
    thresholds: [...((thresholds as number[] | undefined) ?? DEFAULT_CONTEXT_WARNING.thresholds)],
  };
}

/**
 * `single` in orche.config.json: options of the single workflow. `ledger` keeps a per-task ledger outside every LLM context (original
 * requests, requirement statuses, chosen readings, history): workers get it back when they compact, the main session after its own
 * compaction, and a task whose worker is gone (reload, idle expiry, eviction) continues with a new worker briefed from it. Off by
 * default (docs/specialist-orchestration.md, gate G-L).
 *
 * `spawn` (default true, docs/orchestrator.md): the implement/answer worker is an orchestrator that may start sub-workers with
 * `orche_spawn` (parallel parts with disjoint files, an isolated game-asset/video specialist, a fresh independent verifier) and
 * reports its split decision. `false` is the earlier single worker (no orche_spawn, no split decision).
 *
 * The keys of the removed v2 pipeline and workflow policies (`pipeline`, `frame`, `checker`, `nav`, `mainReview`, `investigation`,
 * `creation`) are ignored with a warning, whatever their value, so an old config still loads.
 */
export interface SingleSettings {
  ledger: boolean;
  spawn: boolean;
}
export const DEFAULT_SINGLE: Readonly<SingleSettings> = { ledger: false, spawn: true };
const SINGLE_KEYS = new Set(["ledger", "spawn"]);
/** Keys of the removed single pipeline v2, `mainReview` and workflow policies (docs/orchestrator.md 4): ignored with a warning. */
export const LEGACY_SINGLE_KEYS: ReadonlySet<string> = new Set(["pipeline", "frame", "checker", "nav", "mainReview", "investigation", "creation"]);
export function legacySingleWarning(keys: readonly string[]): string {
  return `config.single.${keys.length === 1 ? keys[0] : `{${keys.join(", ")}}`} ${keys.length === 1 ? "was" : "were"} removed with the single pipeline v2 and workflow policies and ${keys.length === 1 ? "is" : "are"} ignored (see docs/orchestrator.md); delete ${keys.length === 1 ? "it" : "them"} from the config.`;
}
/** Parse `single`; removed keys are ignored and reported in `warnings` (when given). */
export function parseSingleConfig(value: unknown, warnings?: string[]): SingleSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.single: expected object");
  const settings = value as Record<string, unknown>;
  const legacy = Object.keys(settings).filter(key => LEGACY_SINGLE_KEYS.has(key));
  if (Object.keys(settings).some(key => !SINGLE_KEYS.has(key) && !LEGACY_SINGLE_KEYS.has(key))) throw new RouteConfigError("config.single: unknown field");
  if (settings.ledger !== undefined && typeof settings.ledger !== "boolean") throw new RouteConfigError("config.single.ledger: expected boolean");
  if (settings.spawn !== undefined && typeof settings.spawn !== "boolean") throw new RouteConfigError("config.single.spawn: expected boolean");
  if (legacy.length) warnings?.push(legacySingleWarning(legacy));
  return {
    ledger: (settings.ledger as boolean | undefined) ?? DEFAULT_SINGLE.ledger,
    spawn: (settings.spawn as boolean | undefined) ?? DEFAULT_SINGLE.spawn,
  };
}

/**
 * Load one orche config file: the route settings (validated by `parseRouteConfig`) plus the extension-only
 * `concurrentSessions`, `records`, `taskContext`, `contextWarning` and `single` settings, validated here and removed before the route parser sees the file.
 * `warnings` lists settings that were ignored (removed `single` keys); the file still loads.
 */
export async function loadOrcheConfigFile(path: string): Promise<{ routes: RouteConfig; concurrentSessions: ConcurrentSessionsSettings; records: RecordsSettings; taskContext: TaskContextSettings; contextWarning: ContextWarningSettings; single: SingleSettings; warnings: string[] }> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new RouteConfigError(`Cannot load route config ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  let routeValue = value;
  let concurrent: ConcurrentSessionsConfig | undefined;
  let records: RecordsConfig | undefined;
  let taskContext = { ...DEFAULT_TASK_CONTEXT };
  let contextWarning: ContextWarningSettings = { ...DEFAULT_CONTEXT_WARNING, thresholds: [...DEFAULT_CONTEXT_WARNING.thresholds] };
  let single: SingleSettings = { ...DEFAULT_SINGLE };
  const warnings: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { concurrentSessions, records: recordsValue, taskContext: taskContextValue, contextWarning: contextWarningValue, single: singleValue, ...rest } = value as Record<string, unknown>;
    if (Object.hasOwn(value, "concurrentSessions")) concurrent = parseConcurrentSessionsConfig(concurrentSessions);
    if (Object.hasOwn(value, "records")) records = parseRecordsConfig(recordsValue);
    if (Object.hasOwn(value, "taskContext")) taskContext = parseTaskContextConfig(taskContextValue);
    if (Object.hasOwn(value, "contextWarning")) contextWarning = parseContextWarningConfig(contextWarningValue);
    if (Object.hasOwn(value, "single")) single = parseSingleConfig(singleValue, warnings);
    routeValue = rest;
  }
  return { routes: parseRouteConfig(routeValue), concurrentSessions: resolveConcurrentSessions(concurrent), records: resolveRecordsSettings(records), taskContext, contextWarning, single, warnings: warnings.map(warning => `${warning} (${path})`) };
}
export class NoRouteError extends Error {
  override readonly name = "NoRouteError";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route discovery for an orche run started from a Pi session:
 * 1. `<cwd>/.pi/orche.config.json` (only when Pi trusts the project: it can select models and advisors),
 * 2. `<agentDir>/orche.config.json` (`~/.pi/agent` by default),
 * 3. otherwise every role uses the session's current model and thinking level.
 * A file that exists but is invalid is an error, never a silent fallback.
 */
export async function discoverOrcheConfig(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  session: SessionModel;
}): Promise<DiscoveredConfig> {
  const ignored: string[] = [];
  const projectPath = join(options.cwd, ".pi", CONFIG_FILE);
  if (await exists(projectPath)) {
    if (options.projectTrusted) {
      return { ...(await loadOrcheConfigFile(projectPath)), source: { kind: "project", path: projectPath }, ignored };
    }
    ignored.push(`${projectPath} (project is not trusted by Pi)`);
  }
  const userPath = join(options.agentDir, CONFIG_FILE);
  if (await exists(userPath)) {
    return { ...(await loadOrcheConfigFile(userPath)), source: { kind: "user", path: userPath }, ignored };
  }
  const { model, thinking } = options.session;
  if (!model) {
    throw new NoRouteError(
      `No model is selected in this Pi session and no orche config exists. Select a model or create ${projectPath} (see docs/pi-package.md).`,
    );
  }
  return {
    routes: { routes: {}, default: { model, ...(thinking ? { thinking } : {}) } },
    concurrentSessions: resolveConcurrentSessions(),
    records: resolveRecordsSettings(),
    taskContext: { ...DEFAULT_TASK_CONTEXT },
    single: { ...DEFAULT_SINGLE },
    source: { kind: "session", model, ...(thinking ? { thinking } : {}) },
    ignored,
  };
}

export function describeSource(source: ConfigSource): string {
  return source.kind === "session"
    ? `session model ${source.model}${source.thinking ? `:${source.thinking}` : ""}`
    : `${source.kind} config ${source.path}`;
}
