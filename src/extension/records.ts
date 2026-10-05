import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { appendPrivate, ensurePrivateDir, ensurePrivateFile, writePrivateAtomic } from "../agent/private-files.js";
import { safeFileName, type AgentRecordEntry, type RecordedActor, type SessionRecords, type SessionTarget } from "../agent/records.js";
import { DEFAULT_RECORDS_RETENTION_DAYS, type RecordsSettings } from "./config.js";

/**
 * Run records: what an `orche_run` / `orche_task` leaves behind so that it can be reviewed afterwards — the transcript of every
 * sub-session (coordinator, workers, verifiers, advisors), the model each role used, per-agent request counts, and the cost of
 * failed or cancelled runs.
 *
 * Layout (all directories `0700`, all files `0600`; transcripts can contain secrets from tool output):
 *
 * ```
 * <root>/                                        default <agentDir>/orche/records, or `records.dir`
 *   <parent-session-id | no-session>/
 *     <ISO-timestamp>_<run|task>-<shortid>/      one directory per orche_run / orche_task assignment ("a record")
 *       run.json                                 manifest: written at start (status "running"), rewritten atomically at the end
 *       events.jsonl                             the RunEvent stream of an orche_run, one bounded JSON per line (`liveness` samples: one
 *                                                compact line when a session's state changes, never per heartbeat; see agent/liveness.ts;
 *                                                `deadline_extended`: one line per timeout extension, see orchestration/run/extension.ts)
 *       sessions/<agentId>.jsonl                 pi session JSONL of each sub-session
 *     workers/<workerId>-<spawn-timestamp>.jsonl a persistent orche_task worker's session: one stable file across its assignments
 * ```
 *
 * The root is outside pi's own sessions directory (so `/resume` and the concurrent-session detector never see it) and never inside the
 * workspace. Everything here is best effort: no function in this module throws because of the file system; an unwritable
 * records root means "no records", never a failed run.
 *
 * ### API for the integration (controller / workers)
 *
 * 1. `resolveRecords({ agentDir, cwd, settings })` → `{ enabled: true, root, ... }` or `{ enabled: false, reason }` (disabled by config, or an
 *    unsafe root). Call once per run with `DiscoveredConfig.records`.
 * 2. `pruneRecordsOnce(resolved)` at extension start or the first run of the process (fire and forget).
 * 3. `createRunRecord(resolved, input)` → {@link RunRecord} or `undefined`. Then:
 *    - `record.dir` is the path for the `Record: <dir>` line and `details.record`;
 *    - `record.records` is the {@link SessionRecords} hook for `RunOptions.records` / `AgentManagerOptions.records` (coordinator, workers and
 *      advisors are persisted under `sessions/`, their {@link AgentRecordEntry} collected into `run.json`);
 *    - `record.appendEvent(event)` for every RunEvent (use it as, or inside, `RunOptions.sink`);
 *    - `record.update(patch)` for facts that become known during the run, `record.finish({ status, ... })` once at the end (also on failure/cancel).
 * 4. orche_task: `workerSessionFile(resolved, { parentSessionId, workerId, spawnedAt })` once per worker spawn, pass it as `SpawnOptions.sessionFile`;
 *    every assignment's record then reads the worker's entry from `AgentManager.agentRecord(id)` into `record.addAgent(entry)`.
 * 5. `listRecords(resolved, { parentSessionId, limit })` + `formatRecordList` for `/orche records`.
 * 6. `isRecordsPath(path, root)` for the concurrent-session detector.
 */

export const NO_SESSION = "no-session";
export const RUN_JSON = "run.json";
export const EVENTS_JSONL = "events.jsonl";
export const SESSIONS_DIR = "sessions";
export const WORKERS_DIR = "workers";

/** Per string field of an event. */
export const MAX_EVENT_STRING = 2000;
export const MAX_EVENT_LINE = 16 * 1024;
export const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
/** `request` / `context` / `summary` / `failure` in `run.json`. */
export const MAX_MANIFEST_TEXT = 1_000_000;
/** Records modified within this window are never pruned, whatever the retention says: another pi process may be writing them. */
export const ACTIVE_GRACE_MS = 60 * 60 * 1000;

const RUN_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(run|task)-[0-9a-f]{8}$/;
const WORKER_FILE = /^[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/;

export type RecordKind = "run" | "task";
export type RecordStatus = "running" | "done" | "failed" | "cancelled";

/** The fields of `run.json` that this module and the integration know. */
export interface RunManifestFields {
  version: 1;
  kind: RecordKind;
  /** The short id in the directory name. */
  id: string;
  status: RecordStatus;
  /** ISO timestamps. */
  start: string;
  end?: string;
  durationMs?: number;
  cwd: string;
  /** The pi session that started it (its id and file); absent when it has none. */
  parentSession?: { id?: string; file?: string };
  /** As given (bounded at {@link MAX_MANIFEST_TEXT} characters). */
  request?: string;
  context?: string;
  /** Where the routes came from (`describeSource`). */
  config?: string;
  /** Model and thinking level per role. */
  routes?: Record<string, { model: string; thinking?: string }>;
  /** orche_task: the worker this assignment ran on. */
  worker?: { id: string; role?: string; sessionFile?: string };
  taskClass?: string;
  summary?: string;
  failure?: string;
  /** One entry per agent: coordinator, workers/verifiers, each advisor call. */
  agents: AgentRecordEntry[];
  /** Workspace changes / external changes / ownership violations of the run. */
  workspace?: unknown;
  cleanup?: unknown;
  /**
   * Timeout extensions granted to the run / task assignment (a deadline that expired while the work was still active, pushed out by
   * `limits.extensionMs`; at most `limits.maxExtensions`), in order: `DeadlineExtension[]` of orchestration/run/extension.ts (n, max,
   * scope, stage, extensionMs, elapsedMs, newDeadline, reasons, ...). Absent when there were none.
   */
  extensions?: unknown;
  /** Names relative to the record directory. */
  files: { events?: string; sessions: string };
}
/** `run.json`. Unknown extra fields are allowed so that the integration can add facts without a change here. */
export type RunManifest = RunManifestFields & { [extra: string]: unknown };

/** What {@link RunRecord.update} may change; the identity fields and the agents list are owned by the record. */
export type RunManifestPatch = Partial<Omit<RunManifestFields, "version" | "kind" | "id" | "start" | "agents" | "files">> & { [extra: string]: unknown };
export type RunManifestFinish = RunManifestPatch & { status: Exclude<RecordStatus, "running"> };

export interface RunRecordInput {
  kind: RecordKind;
  cwd: string;
  /** The calling pi session: groups the records, and is stored in `run.json`. */
  parentSession?: { id?: string; file?: string };
  request?: string;
  context?: string;
  /** Anything else known at the start (`config`, `routes`, `worker`, ...). */
  manifest?: RunManifestPatch;
  /** Create `events.jsonl` up front (default: for runs). */
  events?: boolean;
  /** Test seam. */
  now?: () => number;
}

export type ResolvedRecords =
  | { enabled: true; root: string; retentionDays: number; maxBytes?: number }
  | { enabled: false; reason: string };

/** `<agentDir>/orche/records`. */
export function defaultRecordsRoot(agentDir: string): string {
  return join(agentDir, "orche", "records");
}

/**
 * The records root for a run, or why there is none: disabled by `records.enabled: false`, or the directory is unsafe — inside the
 * workspace (the audit would see the records as workspace changes), around it, the filesystem root or the home directory. A relative
 * `dir` is resolved against the agent dir, never the workspace.
 */
export function resolveRecords(options: { agentDir: string; cwd: string; settings?: RecordsSettings }): ResolvedRecords {
  const settings = options.settings;
  if (settings && !settings.enabled) return { enabled: false, reason: "records are disabled (records.enabled: false)" };
  const configured = settings?.dir;
  const root = configured
    ? resolve(options.agentDir, configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured)
    : defaultRecordsRoot(resolve(options.agentDir));
  const real = canonical(root);
  const workspace = canonical(options.cwd);
  if (contains(workspace, real)) return { enabled: false, reason: `the records directory ${root} is inside the workspace ${options.cwd}; records are disabled` };
  if (contains(real, workspace)) return { enabled: false, reason: `the records directory ${root} contains the workspace ${options.cwd}; records are disabled` };
  if (real === parse(real).root || real === canonical(homedir())) return { enabled: false, reason: `the records directory ${root} is too broad; records are disabled` };
  return {
    enabled: true, root,
    retentionDays: settings?.retentionDays ?? DEFAULT_RECORDS_RETENTION_DAYS,
    ...(settings?.maxBytes !== undefined ? { maxBytes: settings.maxBytes } : {}),
  };
}

/** Whether `path` is the records root or inside it (symlinks resolved). */
export function isRecordsPath(path: string, root: string): boolean {
  return contains(canonical(root), canonical(path));
}

/** Directory name of the records of a pi session. */
export function parentDirName(parentSessionId: string | undefined): string {
  return parentSessionId?.trim() ? safeFileName(parentSessionId.trim()) : NO_SESSION;
}

/** `2026-10-02T06-10-00-000Z`: the ISO timestamp with the characters file systems dislike replaced, sortable as text. */
export function fileTimestamp(time: number | Date): string {
  return new Date(time).toISOString().replace(/[:.]/g, "-");
}

/**
 * The stable session file of a persistent `orche_task` worker: `<root>/<parent>/workers/<workerId>-<spawn timestamp>.jsonl`. Pass it
 * as `SpawnOptions.sessionFile` when the worker is spawned and keep it for the worker's whole life; a worker that is spawned again
 * gets a new timestamp, so a retired worker's transcript is never mixed with its successor's. Pure: the session factory creates the file.
 */
export function workerSessionFile(resolved: ResolvedRecords, input: { parentSessionId?: string; workerId: string; spawnedAt?: number }): string | undefined {
  if (!resolved.enabled) return undefined;
  return join(resolved.root, parentDirName(input.parentSessionId), WORKERS_DIR, `${safeFileName(input.workerId)}-${fileTimestamp(input.spawnedAt ?? Date.now())}.jsonl`);
}

/**
 * One record directory: its `run.json`, `events.jsonl` and `sessions/`. Created by {@link createRunRecord}. No method throws; a failed
 * write is remembered in {@link RunRecord.errors} and later writes are still attempted.
 */
export class RunRecord {
  readonly dir: string;
  readonly runFile: string;
  readonly eventsFile: string;
  readonly sessionsDir: string;
  /** Persistence problems seen so far (first 5), for diagnostics only. */
  readonly errors: string[] = [];
  /** Hook for `RunOptions.records` / `AgentManagerOptions.records`: persists every actor's session under `sessions/` and collects the agents' entries. */
  readonly records: SessionRecords;
  private readonly manifest: RunManifest;
  private readonly startedAt: number;
  private readonly used = new Set<string>();
  private readonly now: () => number;
  private eventBytes = 0;
  private eventsClosed = false;
  private finished = false;

  /** @internal Use {@link createRunRecord}. */
  constructor(dir: string, manifest: RunManifest, startedAt: number, now: () => number) {
    this.dir = dir;
    this.runFile = join(dir, RUN_JSON);
    this.eventsFile = join(dir, EVENTS_JSONL);
    this.sessionsDir = join(dir, SESSIONS_DIR);
    this.manifest = manifest;
    this.startedAt = startedAt;
    this.now = now;
    this.records = {
      sessionTarget: actor => this.sessionTarget(actor),
      onAgent: entry => this.addAgent(entry),
    };
  }

  /** `sessions/<agentId>.jsonl` (a repeated id gets `-2`, `-3`, ...). */
  sessionTarget(actor: Pick<RecordedActor, "id">): SessionTarget {
    const base = safeFileName(actor.id);
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}-${n}`;
    this.used.add(name);
    return { sessionFile: join(this.sessionsDir, `${name}.jsonl`) };
  }

  /** A copy of the manifest as it would be written now. */
  snapshot(): RunManifest {
    return structuredClone(this.manifest);
  }

  /** Insert or replace (by `id`) the manifest entry of an agent and rewrite `run.json`. */
  addAgent(entry: AgentRecordEntry): void {
    const index = this.manifest.agents.findIndex(existing => existing.id === entry.id);
    if (index >= 0) this.manifest.agents[index] = entry; else this.manifest.agents.push(entry);
    this.write();
  }

  /** Merge facts into the manifest and rewrite `run.json`. Ignored after {@link finish}. */
  update(patch: RunManifestPatch): void {
    if (this.finished) return;
    Object.assign(this.manifest, boundTexts(patch));
    this.write();
  }

  /**
   * The final `run.json`: status, end time and duration plus the last facts (`summary` or `failure`, `workspace`, `cleanup`, ...). Call it for
   * success, failure and cancellation alike; only the first call counts.
   */
  finish(result: RunManifestFinish): void {
    if (this.finished) return;
    this.finished = true;
    const end = this.now();
    Object.assign(this.manifest, boundTexts(result), { end: new Date(end).toISOString(), durationMs: Math.max(0, end - this.startedAt) });
    this.write();
  }

  /**
   * Write a JSON file next to `run.json` (`name` must be a plain file name ending in `.json`); returns the name, or undefined when it
   * could not be written. For structured artifacts too large for an event line (a Framer contract, a Verifier report): the event then
   * carries the file name.
   */
  writeJson(name: string, value: unknown, maxBytes = 1024 * 1024): string | undefined {
    if (!/^[\w.-]+\.json$/.test(name) || name.startsWith(".")) return undefined;
    try {
      const text = `${JSON.stringify(value, null, 1)}\n`;
      if (Buffer.byteLength(text) > maxBytes) return undefined;
      writePrivateAtomic(join(this.dir, name), text);
      return name;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  /** Append one RunEvent to `events.jsonl`, bounded: long strings, long arrays, deep nesting and oversized lines are cut, and the file stops growing at {@link MAX_EVENTS_BYTES}. */
  appendEvent(event: unknown): void {
    if (this.eventsClosed) return;
    try {
      const line = eventLine(event);
      if (this.eventBytes + line.length > MAX_EVENTS_BYTES) {
        this.eventsClosed = true;
        appendPrivate(this.eventsFile, `${JSON.stringify({ type: "events_truncated", timestamp: this.now(), reason: `events.jsonl reached ${MAX_EVENTS_BYTES} bytes` })}\n`);
        return;
      }
      appendPrivate(this.eventsFile, line);
      this.eventBytes += line.length;
    } catch (error) {
      this.fail(error);
    }
  }

  private write(): void {
    try {
      writePrivateAtomic(this.runFile, `${JSON.stringify(this.manifest, null, 2)}\n`);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.errors.length < 5) this.errors.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Create a record directory (`<root>/<parent>/<ISO timestamp>_<kind>-<shortid>/` with `sessions/`) and write the initial `run.json`
 * (status `running`). `undefined` when records are disabled, the directory would be inside the workspace, or anything fails.
 */
export function createRunRecord(resolved: ResolvedRecords, input: RunRecordInput): RunRecord | undefined {
  if (!resolved.enabled) return undefined;
  try {
    const now = input.now ?? Date.now;
    const startedAt = now();
    const id = randomBytes(4).toString("hex");
    const dir = join(resolved.root, parentDirName(input.parentSession?.id), `${fileTimestamp(startedAt)}_${input.kind}-${id}`);
    if (contains(canonical(input.cwd), canonical(dir))) return undefined;
    ensurePrivateDir(join(dir, SESSIONS_DIR));
    const withEvents = input.events ?? input.kind === "run";
    if (withEvents) ensurePrivateFile(join(dir, EVENTS_JSONL));
    const session = input.parentSession;
    const manifest: RunManifest = {
      version: 1, kind: input.kind, id, status: "running",
      start: new Date(startedAt).toISOString(), cwd: input.cwd,
      ...(session && (session.id || session.file) ? { parentSession: { ...(session.id ? { id: session.id } : {}), ...(session.file ? { file: session.file } : {}) } } : {}),
      ...(input.request !== undefined ? { request: boundText(input.request) } : {}),
      ...(input.context !== undefined ? { context: boundText(input.context) } : {}),
      ...boundTexts(input.manifest ?? {}),
      agents: [],
      files: { ...(withEvents ? { events: EVENTS_JSONL } : {}), sessions: SESSIONS_DIR },
    };
    const record = new RunRecord(dir, manifest, startedAt, now);
    record.update({});
    return record.errors.length ? undefined : record;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Bounding

function boundText(text: string): string {
  return text.length > MAX_MANIFEST_TEXT ? `${text.slice(0, MAX_MANIFEST_TEXT)}…[+${text.length - MAX_MANIFEST_TEXT} chars]` : text;
}

function boundTexts<T extends object>(patch: T): T {
  const copy = { ...patch } as Record<string, unknown>;
  for (const key of ["request", "context", "summary", "failure"]) {
    const value = copy[key];
    if (typeof value === "string") copy[key] = boundText(value);
  }
  return copy as T;
}

/**
 * A JSON-safe, size-bounded copy of an event: strings longer than {@link MAX_EVENT_STRING} are cut, arrays keep their first 50 items,
 * objects their first 60 keys, nesting stops at depth 8. Exported for tests.
 */
export function boundEvent(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_EVENT_STRING ? `${value.slice(0, MAX_EVENT_STRING)}…[+${value.length - MAX_EVENT_STRING} chars]` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 8) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(item => boundEvent(item, depth + 1) ?? null);
    return value.length > 50 ? [...items, `…[+${value.length - 50} items]`] : items;
  }
  if (value instanceof Error) return { name: value.name, message: boundEvent(value.message) };
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, 60)) {
    const bounded = boundEvent(item, depth + 1);
    if (bounded !== undefined) out[key] = bounded;
  }
  if (entries.length > 60) out["…"] = `+${entries.length - 60} keys`;
  return out;
}

function eventLine(event: unknown): string {
  const bounded = boundEvent(event);
  let line = JSON.stringify(bounded);
  if (line === undefined || line.length > MAX_EVENT_LINE) {
    const shape = bounded && typeof bounded === "object" ? bounded as Record<string, unknown> : {};
    line = JSON.stringify({ type: shape.type ?? "event", ...(shape.timestamp !== undefined ? { timestamp: shape.timestamp } : {}), truncated: true, bytes: line?.length ?? 0 });
  }
  return `${line}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Listing (`/orche records`)

export interface RecordSummary {
  /** ISO start time. */
  time: string;
  kind: RecordKind | "unknown";
  status: string;
  /** First line of the summary / failure / request, at most 120 characters. */
  summary: string;
  /** The record directory. */
  path: string;
}

/**
 * The most recent records of a pi session (default: those without a session), newest first. A record whose `run.json` is missing or
 * unreadable is still listed (status `unknown`), with the time taken from its directory name.
 */
export async function listRecords(resolved: ResolvedRecords, options: { parentSessionId?: string; limit?: number } = {}): Promise<RecordSummary[]> {
  if (!resolved.enabled) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  try {
    const parent = join(resolved.root, parentDirName(options.parentSessionId));
    const names = (await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory() && RUN_DIR.test(entry.name)).map(entry => entry.name).sort().reverse().slice(0, limit);
    const out: RecordSummary[] = [];
    for (const name of names) {
      const path = join(parent, name);
      let manifest: Partial<RunManifest> = {};
      try { manifest = JSON.parse(await readFile(join(path, RUN_JSON), "utf8")) as Partial<RunManifest>; } catch { /* listed as unknown */ }
      const head = (manifest.summary ?? manifest.failure ?? manifest.request ?? "").trim().split("\n")[0]!.trim();
      const kind = manifest.kind ?? (name.includes("_task-") ? "task" : name.includes("_run-") ? "run" : "unknown");
      out.push({
        time: manifest.start ?? timeOfName(name), kind, status: manifest.status ?? "unknown",
        summary: head.length > 120 ? `${head.slice(0, 119)}…` : head, path,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function timeOfName(name: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : "";
}

/** One entry per record: `time  kind  status  summary head` and the path on the next line; a note when there are none. */
export function formatRecordList(records: readonly RecordSummary[]): string {
  if (!records.length) return "No orche records for this session.";
  return records.map(record => `${record.time.replace("T", " ").replace(/\.\d+Z$/, "Z")}  ${record.kind}  ${record.status}${record.summary ? `  ${record.summary}` : ""}\n  ${record.path}`).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Retention

export interface PruneResult {
  /** Record directories and worker session files deleted. */
  removed: number;
  freedBytes: number;
  /** Candidates examined. */
  scanned: number;
  /** A bound (entries, deletions or time) stopped the pass early. */
  truncated: boolean;
}
export interface PruneOptions {
  now?: number;
  /** Examined candidates / deletions per pass; defaults 10000 / 1000. */
  maxEntries?: number;
  maxDeletions?: number;
  /** Time budget, default 3000 ms. */
  budgetMs?: number;
}

interface Candidate { path: string; mtime: number; bytes: number }

/**
 * Delete what is older than `retentionDays` under the records root, then, with `maxBytes`, the oldest remaining records until the root fits.
 * Only names this module creates are ever touched — `<parent>/<timestamp>_<run|task>-<id>/` directories and
 * `<parent>/workers/<id>-<timestamp>.jsonl` files — found by listing the root, never by following symlinks, and each path is checked to
 * lie strictly inside the root before it is removed. Anything modified within the last hour is kept. Bounded in entries, deletions and
 * time, and fail-soft (`undefined` when the root is missing or unreadable).
 */
export async function pruneRecords(resolved: ResolvedRecords, options: PruneOptions = {}): Promise<PruneResult | undefined> {
  if (!resolved.enabled) return undefined;
  const now = options.now ?? Date.now();
  const deadline = Date.now() + (options.budgetMs ?? 3000);
  const maxEntries = options.maxEntries ?? 10_000;
  const maxDeletions = options.maxDeletions ?? 1000;
  const result: PruneResult = { removed: 0, freedBytes: 0, scanned: 0, truncated: false };
  try {
    const root = canonical(resolved.root);
    if (!(await lstat(root)).isDirectory()) return undefined;
    const keepAfter = now - Math.max(resolved.retentionDays * 86_400_000, ACTIVE_GRACE_MS);
    const graceAfter = now - ACTIVE_GRACE_MS;
    const stale: Candidate[] = [];
    const kept: Candidate[] = [];
    const parents = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
    scan: for (const parent of parents) {
      const parentPath = join(root, parent.name);
      let children;
      try { children = await readdir(parentPath, { withFileTypes: true }); } catch { continue; }
      const paths: string[] = [];
      for (const child of children) {
        if (child.isDirectory() && RUN_DIR.test(child.name)) paths.push(join(parentPath, child.name));
        else if (child.isDirectory() && child.name === WORKERS_DIR) {
          try {
            for (const file of await readdir(join(parentPath, WORKERS_DIR), { withFileTypes: true })) if (file.isFile() && WORKER_FILE.test(file.name)) paths.push(join(parentPath, WORKERS_DIR, file.name));
          } catch { /* unreadable workers directory */ }
        }
      }
      for (const path of paths) {
        if (result.scanned >= maxEntries || Date.now() > deadline) { result.truncated = true; break scan; }
        result.scanned++;
        const measured = await measure(path).catch(() => undefined);
        if (measured) (measured.mtime < keepAfter ? stale : kept).push(measured);
      }
    }
    const remove = async (candidate: Candidate): Promise<boolean> => {
      if (result.removed >= maxDeletions || Date.now() > deadline) { result.truncated = true; return false; }
      if (!strictlyInside(root, candidate.path)) return false;
      if ((await lstat(candidate.path)).isSymbolicLink()) return false;
      await rm(candidate.path, { recursive: true, force: true });
      result.removed++;
      result.freedBytes += candidate.bytes;
      return true;
    };
    for (const candidate of stale.sort((a, b) => a.mtime - b.mtime)) {
      try { await remove(candidate); } catch { /* leave it */ }
      if (result.truncated) break;
    }
    if (resolved.maxBytes !== undefined && !result.truncated) {
      let total = kept.reduce((sum, candidate) => sum + candidate.bytes, 0);
      for (const candidate of kept.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= resolved.maxBytes || candidate.mtime >= graceAfter) break;
        try { if (await remove(candidate)) total -= candidate.bytes; } catch { /* leave it */ }
        if (result.truncated) break;
      }
    }
    // Directories the pass left empty (a session without records, an empty workers directory).
    for (const parent of parents) {
      for (const empty of [join(root, parent.name, WORKERS_DIR), join(root, parent.name)]) {
        if (Date.now() > deadline) break;
        try { if (strictlyInside(root, empty)) await rmdir(empty); } catch { /* not empty, or gone */ }
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

const pruned = new Map<string, Promise<PruneResult | undefined>>();

/** {@link pruneRecords} at most once per process and root; later calls get the first call's promise. Never rejects. */
export function pruneRecordsOnce(resolved: ResolvedRecords, options: PruneOptions = {}): Promise<PruneResult | undefined> {
  if (!resolved.enabled) return Promise.resolve(undefined);
  const key = resolve(resolved.root);
  let pending = pruned.get(key);
  if (!pending) {
    pending = pruneRecords(resolved, options).catch(() => undefined);
    pruned.set(key, pending);
  }
  return pending;
}

/** Test seam: forget which roots were already pruned in this process. */
export function resetPruneOnce(): void {
  pruned.clear();
}

/** Newest modification time and total size of a record directory (two levels deep) or a file. */
async function measure(path: string): Promise<Candidate> {
  const info = await lstat(path);
  if (!info.isDirectory()) return { path, mtime: info.mtimeMs, bytes: info.size };
  let mtime = info.mtimeMs;
  let bytes = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) {
          mtime = Math.max(mtime, (await stat(child)).mtimeMs);
          await visit(child, depth + 1);
        }
      } else if (entry.isFile()) {
        const file = await lstat(child);
        mtime = Math.max(mtime, file.mtimeMs);
        bytes += file.size;
      }
    }
  };
  await visit(path, 0);
  return { path, mtime, bytes };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Paths

/** `realpath` of the longest existing prefix of `path`, with the rest appended: stable for paths that do not exist yet. */
function canonical(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try { return join(realpathSync(current), ...[...rest].reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** `child` is `parent` or below it. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function strictlyInside(root: string, path: string): boolean {
  const target = canonical(path);
  return target !== root && contains(root, target);
}
