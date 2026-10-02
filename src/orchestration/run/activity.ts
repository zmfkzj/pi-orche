import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolExecutionEvent } from "../../agent/agent-handle.js";
import { READ_ONLY_TOOL_NAMES } from "../../tools/index.js";
import type { WorkspaceChange } from "../workspace.js";

/**
 * Which workspace changes can this run's workers have made? A shared working tree also changes
 * under concurrent pi sessions, editors and commits made elsewhere, so a snapshot diff alone cannot
 * say who wrote a file. This tracker adds the one fact the diff lacks: when a write-capable tool of
 * this run was executing.
 *
 * Model. Tool executions come from the sessions' `tool_execution_start/end` events (through
 * `SpawnOptions.onToolExecution`). A tool is write-capable unless it is one of
 * READ_ONLY_TOOL_NAMES, so bash, edit, write, ast_rewrite, generate_image and any future tool count.
 * The run alternates between *quiet* periods (no write-capable tool executing) and *active* ones.
 * A snapshot is taken at every quiet/active edge and the files that differ between consecutive
 * snapshots are recorded as `quietTouched` or `activeTouched`:
 *  - changed only in quiet windows: no tool of this run can have written them → external;
 *  - changed in an active window: possibly ours, possibly not → ambiguous, treated as the run's;
 *  - written by a successful edit/write call: always the run's (`isWritten`);
 *  - changed in an active window in which a non-edit/write tool (bash, ast_rewrite, generate_image, …)
 *    was in flight: such a tool can write any file, so the writer of a file outside the worker's
 *    ownership is unknowable when another process may also write (`touchedDuringShell`). The audit
 *    decides what to do with it (see auditWorkspace: external when concurrent sessions were detected).
 *
 * Cost and correctness trade-off.
 *  - quiet→active: the snapshot must complete BEFORE the tool runs, otherwise the tool's own output
 *    could land in the "quiet" snapshot and be mistaken for an external change (the unsafe
 *    direction). It is therefore awaited inside the write guard (`enter`). It adds one
 *    `git add --all` on the private index (stat cache reuse: cost grows with the number of files,
 *    not with the size of the change) to a tool call that already waits for a model round trip.
 *  - active→quiet: nobody waits for it, so it is queued. If an external write lands before it runs
 *    it is attributed to the active window, which is the safe (ambiguous) direction.
 *  - Overlapping tools of several workers form one active window: one snapshot pair per burst, not
 *    per call. Read-only tools, report_result and send_message never snapshot.
 *  - Blocking time is capped at max(5s, 10% of the elapsed run). Past the cap (or after a snapshot
 *    failure) boundaries are skipped and the windows merge into active ones: exactly the
 *    pre-existing "attribute everything to the run" behaviour, only less precise.
 *  - Limits: a background process that a bash call leaves running keeps writing after its tool
 *    ended, and such writes look external. A file touched by both a worker and someone else in
 *    active windows stays the run's. Tools that never reach the guard are still tracked from events.
 *
 * All snapshot work runs on one promise chain, so windows never overlap and the flags below are only
 * written from chain jobs. The tracker only needs snapshot/diff functions, not WorkspaceAudit.
 *
 * Users: orche_run (auditWorkspace, one tracker per run) and orche_task workers (src/extension/workers.ts, one
 * tracker per write-role assignment: `isWritten` and the active windows are the worker's changes, changes seen only
 * in quiet windows are reported as other workspace changes). With a submodule-aware WorkspaceAudit the snapshot ids
 * are opaque strings and `diff` paths such as `sub/file` flow through unchanged.
 */

/** Orche's own coordination tools never touch files: they must not open active windows. */
const COORDINATION_TOOLS: ReadonlySet<string> = new Set(["report_result", "send_message"]);
/** Tools whose successful `path` argument is a file the run certainly wrote. */
const PATH_WRITERS: ReadonlySet<string> = new Set(["edit", "write"]);

/** True for any tool outside the read-only set (bash, edit, write, ast_rewrite, generate_image, …). */
export function isWriteCapable(toolName: string): boolean {
  return !READ_ONLY_TOOL_NAMES.includes(toolName) && !COORDINATION_TOOLS.has(toolName);
}

export interface WorkspaceActivityOptions {
  /** Run cwd: written paths are resolved against it and reported relative to it. */
  cwd: string;
  /** Snapshot tree of the workspace when tracking starts (the baseline). */
  tree: string;
  snapshot(): Promise<string>;
  diff(from: string, to: string): Promise<readonly WorkspaceChange[]>;
  /** Boundary snapshots are skipped once the run is cancelled. */
  cancelled?(): boolean;
  /** Clock and run start for the blocking-time cap; default Date.now. */
  now?(): number;
  startedAt?: number;
  /** Blocking snapshot time always allowed (default 5000 ms). */
  minBudgetMs?: number;
  /** Share of the elapsed run time allowed beyond that (default 0.1). */
  budgetShare?: number;
}

/** `run`: since tracking started; `phase`: since the last {@link WorkspaceActivity.startPhase}. */
export type ActivityScope = "run" | "phase";
interface Sets { run: Set<string>; phase: Set<string> }
const sets = (): Sets => ({ run: new Set(), phase: new Set() });
interface Execution { agentId: string; toolName: string; path?: string; gated: boolean }

export class WorkspaceActivity {
  private readonly executions = new Map<string, Execution>();
  private readonly writtenPaths = sets();
  private readonly quietTouched = sets();
  private readonly activeTouched = sets();
  private readonly shellTouched = sets();
  private tree: string;
  /** The open window (since `tree`) saw a write-capable tool execute. */
  private windowActive = false;
  /** The open active window saw a non-edit/write write-capable tool (bash, …) execute. */
  private windowShell = false;
  private chain: Promise<unknown> = Promise.resolve();
  private spentMs = 0;
  private broken = false;
  private boundaries = 0;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(private readonly options: WorkspaceActivityOptions) {
    this.tree = options.tree;
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  /** Snapshot tree at the end of the last closed window. */
  get windowTree(): string { return this.tree; }
  /** Boundary snapshots taken so far (diagnostics and tests). */
  get boundarySnapshots(): number { return this.boundaries; }
  /** Write-capable tool executions currently in flight, per worker. */
  inFlight(): readonly { agentId: string; toolName: string }[] {
    return [...this.executions.values()].map(({ agentId, toolName }) => ({ agentId, toolName }));
  }

  /** Feed one worker's tool execution event. Synchronous: it never awaits the session. */
  record(agentId: string, event: ToolExecutionEvent): void {
    if (event.phase === "settled") {
      // The session has no tool in flight any more: heals a missed end event.
      let removed = false;
      for (const [key, execution] of this.executions) if (execution.agentId === agentId) { this.executions.delete(key); removed = true; }
      if (removed) this.afterEnd();
      return;
    }
    if (!event.toolCallId || !event.toolName) return;
    const key = `${agentId}:${event.toolCallId}`;
    if (event.phase === "start") {
      if (!isWriteCapable(event.toolName)) return;
      const path = PATH_WRITERS.has(event.toolName) ? this.repoRelative((event.args as { path?: unknown } | undefined)?.path) : undefined;
      this.executions.set(key, { agentId, toolName: event.toolName, ...(path ? { path } : {}), gated: false });
      return;
    }
    const execution = this.executions.get(key);
    if (!execution) return;
    this.executions.delete(key);
    // Only a call that really ran counts: a blocked or failed edit wrote nothing.
    if (!event.isError && execution.path) { this.writtenPaths.run.add(execution.path); this.writtenPaths.phase.add(execution.path); }
    this.afterEnd();
  }

  /**
   * Called from the write guard before a tool runs. Resolves once the tool may start: for a
   * write-capable tool entering a quiet window, after the snapshot that closes that window.
   */
  async enter(agentId: string, toolName: string): Promise<void> {
    if (!isWriteCapable(toolName)) return;
    await this.run(async () => {
      for (const execution of this.executions.values()) {
        if (!execution.gated && execution.agentId === agentId && execution.toolName === toolName) { execution.gated = true; break; }
      }
      const shell = !PATH_WRITERS.has(toolName);
      if (this.windowActive) { if (shell) this.windowShell = true; return; } // joins the running burst: no snapshot
      if (this.canSnapshot()) {
        try { await this.close(true); } catch { this.broken = true; }
      }
      // Without a boundary the preceding quiet period merges into this active window.
      this.windowActive = true;
      if (shell) this.windowShell = true;
    });
  }

  /**
   * Close the open window and return the snapshot tree (for phase audits and the final audit).
   * Not capped and not skipped on cancellation; errors propagate to the caller.
   */
  checkpoint(): Promise<string> {
    return this.run(async () => (await this.close(false))!);
  }

  /** Start a new audit phase: phase-scoped sets are cleared, run-scoped ones are kept. */
  startPhase(): void {
    for (const group of [this.writtenPaths, this.quietTouched, this.activeTouched, this.shellTouched]) group.phase.clear();
  }

  /** Wait for all queued snapshot work (including jobs queued meanwhile). */
  async drain(): Promise<void> {
    let seen: Promise<unknown>;
    do { seen = this.chain; await seen; } while (seen !== this.chain);
  }

  /** Written by a successful edit/write call of this run: always the run's. */
  isWritten(path: string, scope: ActivityScope = "run"): boolean { return this.writtenPaths[scope].has(path); }
  /** Changed in at least one active window (a write-capable tool was executing). */
  touchedActive(path: string, scope: ActivityScope = "run"): boolean { return this.activeTouched[scope].has(path); }
  /**
   * Changed in an active window in which a non-edit/write tool (bash, ast_rewrite, …) was in flight:
   * that tool may have written the file, but so may anyone else. Edit/write calls only ever write
   * their own `path`, so a window holding nothing but those never counts.
   */
  touchedDuringShell(path: string, scope: ActivityScope = "run"): boolean { return this.shellTouched[scope].has(path); }
  /** Changed in quiet windows only: no tool of this run can have written it. */
  touchedOnlyQuiet(path: string, scope: ActivityScope = "run"): boolean {
    return this.quietTouched[scope].has(path) && !this.activeTouched[scope].has(path) && !this.writtenPaths[scope].has(path);
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** A gated execution exists; with `shellOnly`, one of a tool other than edit/write. */
  private hasGated(shellOnly = false): boolean {
    for (const execution of this.executions.values()) if (execution.gated && (!shellOnly || !PATH_WRITERS.has(execution.toolName))) return true;
    return false;
  }

  /** Blocking-time cap: max(5s, 10% of the elapsed run) of boundary snapshots. */
  private canSnapshot(): boolean {
    if (this.broken || this.options.cancelled?.()) return false;
    const allowed = Math.max(this.options.minBudgetMs ?? 5000, (this.now() - this.startedAt) * (this.options.budgetShare ?? 0.1));
    return this.spentMs < allowed;
  }

  private afterEnd(): void {
    if (this.executions.size > 0 || this.broken) return;
    // Nobody waits for this snapshot; a late one only widens the active window (safe direction).
    void this.run(async () => {
      if (!this.windowActive || this.hasGated() || !this.canSnapshot()) return;
      try { await this.close(true); } catch { this.broken = true; }
    });
  }

  /** Snapshot now, record what changed since the previous snapshot under the window's kind, reopen. */
  private async close(boundary: boolean): Promise<string | undefined> {
    const kind = this.windowActive ? this.activeTouched : this.quietTouched;
    const started = this.now();
    let tree: string;
    let changes: readonly WorkspaceChange[];
    try {
      tree = await this.options.snapshot();
      changes = await this.options.diff(this.tree, tree);
    } finally {
      if (boundary) { this.spentMs += this.now() - started; this.boundaries++; }
    }
    if (boundary && this.options.cancelled?.()) return undefined;
    const shell = this.windowActive && this.windowShell;
    for (const change of changes) {
      kind.run.add(change.path); kind.phase.add(change.path);
      if (shell) { this.shellTouched.run.add(change.path); this.shellTouched.phase.add(change.path); }
    }
    this.tree = tree;
    this.windowActive = this.hasGated();
    this.windowShell = this.hasGated(true);
    return tree;
  }

  private repoRelative(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw) return undefined;
    const path = relative(this.options.cwd, resolve(this.options.cwd, raw));
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
    return sep === "/" ? path : path.split(sep).join("/");
  }
}
