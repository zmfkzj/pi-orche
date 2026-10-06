/**
 * `orche_spawn`: the orchestrator's one way to split work (docs/orchestrator.md 2–3). It starts up to MAX_SUB_WORKERS sub-workers in
 * fresh sessions at the same time and returns when all of them have reported.
 *
 * File conflicts are prevented in layers: writers must own files and their ownership may not overlap (planSpawn, with the backlog
 * validator's `file_overlap`); every write of a sub-worker is checked against its own files and its siblings' (sub-worker.ts, the
 * ownership guard); the tool is `executionMode: "sequential"`, so no other tool call of the orchestrator runs meanwhile; and a
 * workspace snapshot before and after the call reports changes outside every worker's files (bash writes, other sessions).
 * Depth is 1: the tool is registered only in orchestrator sessions, never in a sub-worker's, and a sub-worker's guard refuses it.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { normalizeOwnedPath, validateBacklog, type TaskItem } from "../orchestration/backlog.js";
import { ownsPath, WRITING_KINDS } from "../orchestration/ownership.js";
import type { SubWorkerModelSource, SubWorkerThinkingSource } from "../orchestration/routing.js";
import type { WorkspaceChange } from "../orchestration/workspace.js";
import { MAX_SUB_WORKERS } from "./instructions.js";

export const SPAWN_TOOL = "orche_spawn";
export const SPAWN_REASONS = ["parallelism", "isolation", "verification"] as const;
export type SpawnReason = (typeof SPAWN_REASONS)[number];
export const SUB_WORKER_ROLES = ["implement", "answer", "verify", "game-asset", "video"] as const;
export type SubWorkerRole = (typeof SUB_WORKER_ROLES)[number];
/** The guard's answer when a sub-worker tries to spawn (it never has the tool; this is the second line). */
export const DEPTH_LIMIT_MESSAGE = "Blocked: sub-workers cannot spawn workers (orche_spawn depth is 1). Do the work yourself or report what is missing.";

export const spawnParameters = Type.Object({
  reason: Type.Union(SPAWN_REASONS.map(reason => Type.Literal(reason)), { description: "Why you split: parallelism (independent parts at the same time), isolation (a game-asset/video specialist or a part that must run apart), verification (fresh independent verifiers, role verify only)." }),
  workers: Type.Array(Type.Object({
    name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$", description: "Short unit name, unique in this call (e.g. csv, cache, verify)." }),
    role: Type.Union(SUB_WORKER_ROLES.map(role => Type.Literal(role)), { description: "implement (writes its own files), answer (read-only investigation), verify (read-only independent verification), game-asset or video (specialists)." }),
    request: Type.String({ minLength: 1, description: "Self-contained request: the sub-worker sees nothing else. Goal, acceptance criteria, constraints, file references and the user's wording where it matters; not your reasoning." }),
    files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned files or directories (dir/ or dir/**) of a writing role; required for implement, game-asset and video; ignored for read-only roles." })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_SUB_WORKERS }),
}, { additionalProperties: false });
export type SpawnParameters = Static<typeof spawnParameters>;

/** Canonical ownership paths: concrete files or directory prefixes (`dir/`, `dir/**`, `dir/**\/*` → `dir/`); globs, absolute and outside paths are errors. */
export function scopePaths(files: readonly string[]): string[] {
  return [...new Set(files.map(file => {
    const path = normalizeOwnedPath(file.replaceAll("\\", "/").replace(/\/\*\*(?:\/\*)?$/, "/"));
    if (!path || /[*?\[\]{}]/.test(path) || isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.split("/")[0] === "..")
      throw new Error(`Unsupported ownership path ${JSON.stringify(file)}; use concrete files, directory prefixes ending /, or directory/**`);
    return path;
  }))];
}

export interface PlannedWorker { id: string; name: string; role: SubWorkerRole; request: string; reason: SpawnReason; files?: string[] }

/**
 * Validate one call and give the workers their ids (only after it is valid, so a refused call uses none). Throws an Error whose
 * message tells the orchestrator what to change.
 */
export function planSpawn(params: SpawnParameters, options: { scope?: readonly string[]; readOnly?: boolean; nextId: () => string }): { workers: PlannedWorker[]; notes: string[] } {
  const { reason, workers } = params;
  const notes: string[] = [];
  if (!workers.length || workers.length > MAX_SUB_WORKERS) throw new Error(`orche_spawn takes 1 to ${MAX_SUB_WORKERS} workers per call.`);
  const names = new Set<string>();
  for (const worker of workers) {
    if (names.has(worker.name)) throw new Error(`Duplicate worker name ${worker.name}; names must be unique in one call.`);
    names.add(worker.name);
  }
  if (reason === "verification" && workers.some(worker => worker.role !== "verify")) throw new Error('reason "verification" takes role verify only: a fresh read-only verifier.');
  if (reason !== "verification" && workers.some(worker => worker.role === "verify")) throw new Error('role verify is an independent verifier: use reason "verification".');
  if (reason === "parallelism" && workers.length < 2) throw new Error('reason "parallelism" needs two or more workers; do a single part yourself.');
  const planned = workers.map(worker => {
    const writes = WRITING_KINDS.has(worker.role);
    if (!writes) {
      if (worker.files?.length) notes.push(`files ignored for read-only ${worker.name}.`);
      return { name: worker.name, role: worker.role, request: worker.request, reason };
    }
    if (options.readOnly) throw new Error(`${worker.name} (${worker.role}) would write files, but this assignment is read-only: spawn answer or verify workers only.`);
    if (!worker.files?.length) throw new Error(`${worker.name} (${worker.role}) must name the files or directories it owns in files.`);
    const files = scopePaths(worker.files);
    if (options.scope) {
      const outside = files.filter(path => !options.scope!.some(owned => ownsPath(owned, path.replace(/\/$/, ""))));
      if (outside.length) throw new Error(`${worker.name} would own ${outside.join(", ")} outside your own write scope (${options.scope.join(", ")}).`);
    }
    return { name: worker.name, role: worker.role, request: worker.request, reason, files };
  });
  const tasks: TaskItem[] = planned.map(worker => ({ id: worker.name, owner: worker.name, description: worker.name, files: worker.files ?? [], status: "pending" }));
  const overlaps = validateBacklog(tasks, planned.map(worker => worker.name)).filter(issue => issue.type === "file_overlap");
  if (overlaps.length) throw new Error(`Owned files overlap: ${overlaps.map(issue => issue.type === "file_overlap" ? `${issue.taskIds[0]} (${issue.files[0]}) and ${issue.taskIds[1]} (${issue.files[1]})` : "").join("; ")}. Give every file to one worker, or do coupled parts in one worker.`);
  return { workers: planned.map(worker => ({ ...worker, id: options.nextId() })), notes };
}

/** What one sub-worker did. `status`: done | blocked (writers, answer) · passed | not passed (verify) · failed | cancelled (no valid report). */
export interface SubWorkerOutcome {
  id: string;
  name: string;
  role: SubWorkerRole;
  reason: SpawnReason;
  status: string;
  summary: string;
  data?: unknown;
  error?: string;
  files?: string[];
  model: string;
  thinking?: string;
  /** Where the model came from (SubWorkerModelSource): `models.worker`'s model or main's named by it, the orchestrator's, or a route. */
  modelSource: SubWorkerModelSource;
  /** Where `thinking` came from (SubWorkerThinkingSource); `thinking` is the level the session ran on, after Pi's clamp. */
  thinkingSource?: SubWorkerThinkingSource;
  requests: number;
  models: Record<string, number>;
  startedAt: number;
  durationMs: number;
  costUSD: number;
  sessionFile?: string;
  /** Workspace paths changed during the call inside this worker's owned files. */
  changes: string[];
}

export type RunSubWorker = (worker: PlannedWorker, siblings: readonly PlannedWorker[], signal: AbortSignal, onTool: (name: string) => void) => Promise<SubWorkerOutcome>;

/** What the orchestrator's assignment provides to one orche_spawn call (src/extension/workers.ts). */
export interface SpawnContext {
  orchestrator: string;
  /** The orchestrator's own write scope (normalized); undefined: the whole workspace. */
  scope?: readonly string[];
  /** A read-only assignment (answer): only read-only sub-workers. */
  readOnly?: boolean;
  /** The orchestrator assignment's own cancellation, next to the tool call's. */
  signal?: AbortSignal;
  nextId(): string;
  runWorker: RunSubWorker;
  /** Workspace snapshot and diff for the after-the-fact conflict check; absent outside a git work tree. */
  snapshot?(): Promise<string>;
  diff?(from: string, to: string): Promise<readonly WorkspaceChange[]>;
  /** Live status lines (the main session's progress). */
  onProgress?(lines: string[]): void;
  /** Every finished call (details, records). */
  onSpawned?(reason: SpawnReason, outcomes: readonly SubWorkerOutcome[], warnings: readonly string[]): void;
}

export interface SpawnDetails { reason: SpawnReason; workers: SubWorkerOutcome[]; warnings: string[]; durationMs: number }

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const dataLine = (data: unknown): string | undefined => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const parts = ["status", "passed", "reason", "issues", "evidence", "outputs"].filter(key => record[key] !== undefined).map(key => `${key}: ${typeof record[key] === "string" ? record[key] : JSON.stringify(record[key])}`);
  return parts.length ? clip(parts.join("; "), 2_000) : undefined;
};

export function formatSpawn(details: SpawnDetails): string {
  const cost = details.workers.reduce((sum, worker) => sum + worker.costUSD, 0);
  const requests = details.workers.reduce((sum, worker) => sum + worker.requests, 0);
  const lines = [`orche_spawn (${details.reason}): ${details.workers.length} sub-worker${details.workers.length === 1 ? "" : "s"}, ${Math.round(details.durationMs / 1000)}s, ${requests} requests${cost ? `, $${cost.toFixed(2)}` : ""}`];
  for (const worker of details.workers) {
    lines.push("", `${worker.id} ${worker.name} (${worker.role}, ${Math.round(worker.durationMs / 1000)}s, ${worker.requests} requests): ${worker.status}${worker.error ? ` — ${clip(worker.error, 300)}` : ""}`);
    if (worker.summary) lines.push(clip(worker.summary, 4_000));
    const data = dataLine(worker.data);
    if (data) lines.push(data);
    if (worker.files) lines.push(`Owned: ${worker.files.join(", ")}; changed: ${worker.changes.length ? worker.changes.join(", ") : "none"}`);
  }
  if (details.warnings.length) lines.push("", ...details.warnings.map(warning => `Warning: ${warning}`));
  lines.push("", "You own the result: review each report, check the changed files, run the project checks yourself, then fix or finish what is missing.");
  return lines.join("\n");
}

/** Run one validated call: all workers at once, then the conflict check. Never rejects for a sub-worker's failure (that is its outcome). */
export async function executeSpawn(context: SpawnContext, params: SpawnParameters, signal: AbortSignal | undefined, onUpdate?: (text: string) => void): Promise<{ text: string; details: SpawnDetails }> {
  const { workers, notes } = planSpawn(params, { ...(context.scope ? { scope: context.scope } : {}), ...(context.readOnly ? { readOnly: true } : {}), nextId: () => context.nextId() });
  const started = Date.now();
  const signals = [signal, context.signal].filter((item): item is AbortSignal => !!item);
  const abort = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
  const before = context.snapshot && context.diff ? await context.snapshot().catch(() => undefined) : undefined;
  const status = new Map(workers.map(worker => [worker.id, "starting"]));
  let lastUpdate = 0;
  const publish = (force = false) => {
    const lines = workers.map(worker => `${context.orchestrator} → ${worker.id} ${worker.name} (${worker.role}): ${status.get(worker.id)}`);
    context.onProgress?.(lines);
    // Partial tool output keeps the orchestrator "active" for its deadline while its sub-workers work (liveness counts tool output).
    if (force || Date.now() - lastUpdate >= 3_000) { lastUpdate = Date.now(); onUpdate?.(lines.join("\n")); }
  };
  publish(true);
  const outcomes = await Promise.all(workers.map(async worker => {
    const outcome = await context.runWorker(worker, workers, abort, name => { status.set(worker.id, `last tool ${name}`); publish(); });
    status.set(worker.id, outcome.status);
    publish(true);
    return outcome;
  }));
  const warnings = notes.map(note => note.replace(/\.$/, ""));
  if (before !== undefined && context.snapshot && context.diff) {
    try {
      const after = await context.snapshot();
      const changes = await context.diff(before, after);
      const unowned: string[] = [];
      for (const change of changes) {
        const owners = outcomes.filter(outcome => outcome.files?.some(owned => ownsPath(owned, change.path)));
        for (const owner of owners) owner.changes.push(change.path);
        if (!owners.length) unowned.push(change.path);
      }
      if (unowned.length) warnings.push(`changed during orche_spawn outside every sub-worker's owned files: ${unowned.slice(0, 30).join(", ")}${unowned.length > 30 ? `, … ${unowned.length - 30} more` : ""} (a shell write of a sub-worker or another session; check them)`);
    } catch { warnings.push("workspace check after orche_spawn failed; check the changed files yourself"); }
  }
  const details: SpawnDetails = { reason: params.reason, workers: outcomes, warnings, durationMs: Date.now() - started };
  context.onSpawned?.(params.reason, outcomes, warnings);
  return { text: formatSpawn(details), details };
}

/**
 * The tool. `context()` resolves the current assignment's SpawnContext at call time (the tool lives as long as the worker's
 * session; the context only during an orchestrator assignment) or says why it is unavailable.
 */
export function createSpawnTool(context: () => SpawnContext | string): ToolDefinition {
  return {
    name: SPAWN_TOOL,
    label: "orche spawn",
    description: `Start up to ${MAX_SUB_WORKERS} sub-workers in fresh sessions at the same time and wait for all of them: independent parallel parts (each writer owns disjoint files), an isolated game-asset/video specialist, or fresh read-only verifiers. Sub-workers see only their request and cannot spawn. Use it only when the orchestration rules of your assignment say the task should be split.`,
    parameters: spawnParameters,
    executionMode: "sequential",
    execute: async (_id, params, signal, onUpdate): Promise<AgentToolResult<SpawnDetails | undefined>> => {
      const current = context();
      if (typeof current === "string") return { content: [{ type: "text", text: current }], details: undefined, isError: true } as AgentToolResult<undefined>;
      const result = await executeSpawn(current, params as SpawnParameters, signal, text => onUpdate?.({ content: [{ type: "text", text }], details: undefined }));
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  } as ToolDefinition;
}
