import { abortable } from "./deadline.js";
import { classifyNewFile } from "../artifacts.js";
import { coveringTasks } from "./root-ownership.js";
import { WorkspaceAudit, type ExternalWorkspaceChange, type WorkspaceChange } from "../workspace.js";
import { WorkspaceActivity, type ActivityScope } from "./activity.js";
import { emit } from "./context.js";
import type { ConcurrentActivity, RunContext, RunReport } from "./types.js";

/** Git-snapshot workspace audit of a run: baseline, per-phase violations and the final change list. */

/** Why a change is not attributed to this run (shown to the user and carried in the report). */
export const COMMITTED_ELSEWHERE = "committed outside this run";
export const CHANGED_WHILE_QUIET = "changed while no worker tool was running";
export const NOT_TRACEABLE = "not traceable to a worker tool call";
/**
 * A worker bash call (or another non-edit/write tool) was running, the file is outside the worker's
 * ownership, no edit/write call wrote it, and other pi sessions are active on the repository: the
 * writer cannot be told apart. Reported as external instead of an ownership violation.
 */
export const CONCURRENT_SESSION_AMBIGUOUS = "concurrent session active; ambiguous";

interface Attribution {
  run: WorkspaceChange[];
  external: ExternalWorkspaceChange[];
  /**
   * Paths of `run` changed while a non-edit/write tool was in flight and not written by an edit/write
   * call: still the run's (conservative), but their writer is unknowable. See {@link auditWorkspace}.
   */
  shellAmbiguous: Set<string>;
}

/**
 * Other pi sessions seen by a re-detection at an audit point (`RunOptions.detectConcurrentActivity`), per run. Kept beside the
 * context so that the run's own state needs no field for a feature only some callers enable.
 */
interface ConcurrentWatch {
  /** `RunOptions.concurrentActivity.count` when the run started. */
  initial: number;
  /** The latest re-detection that found sessions. Sticky: a later empty answer (the sessions went quiet) does not unflag the run. */
  latest?: ConcurrentActivity;
  warned: boolean;
}
const watches = new WeakMap<RunContext, ConcurrentWatch>();
const startingHeads = new WeakMap<RunContext, NonNullable<Awaited<ReturnType<WorkspaceAudit["headSnapshot"]>>>>();

/** Keep gitlink moves visible to attribution, ownership checks and recovery, without treating them as files in the audit API. */
async function workspaceChanges(audit: WorkspaceAudit, from: string, to: string): Promise<WorkspaceChange[]> {
  const { changes, gitlinks } = await audit.compare(from, to);
  return [...changes, ...gitlinks.map(link => ({
    path: link.path, status: !link.from ? "added" as const : !link.to ? "deleted" as const : "modified" as const,
  }))].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Concurrent pi sessions were detected: when the run started (`concurrentActivity`), or later, at an audit point
 * (`detectConcurrentActivity`, see {@link refreshConcurrentSessions}). Once true it stays true for the run.
 */
export function concurrentSessionsFlagged(ctx: RunContext): boolean {
  return (ctx.options.concurrentActivity?.count ?? 0) > 0 || (watches.get(ctx)?.latest?.count ?? 0) > 0;
}

/**
 * Re-detect other pi sessions at a workspace audit point, so a session that started after the run did is taken into account.
 * The callback owns the caching and the cost; here it only has to be fail-soft: a rejection, a malformed answer, a cancelled run
 * or `undefined` all mean "nothing new" and never reach the audit. The first time the count exceeds the one known at the start, one
 * `concurrent_sessions_detected` event (the progress warning) is emitted.
 */
async function refreshConcurrentSessions(ctx: RunContext): Promise<void> {
  const detect = ctx.options.detectConcurrentActivity;
  // `ctx.cancelled` is also set while a finished run is torn down (finalWorkspace still looks): only the signal says "cancelled".
  if (!detect || ctx.signal?.aborted) return;
  let found: ConcurrentActivity | undefined;
  try { found = await abortable(Promise.resolve().then(detect), ctx.signal); }
  catch { return; }
  if (!found || typeof found.count !== "number" || !(found.count > 0)) return;
  const watch = watches.get(ctx) ?? { initial: ctx.options.concurrentActivity?.count ?? 0, warned: false };
  watches.set(ctx, watch);
  watch.latest = found;
  if (watch.warned || found.count <= watch.initial) return;
  watch.warned = true;
  emit(ctx, { type: "concurrent_sessions_detected", timestamp: Date.now(), phase: ctx.state.phase, count: found.count, detail: String(found.detail ?? "") });
}

/**
 * Files in `changes` that someone else committed during the run: their repository's HEAD moved
 * since the baseline, their current content equals that HEAD, and it differs from the baseline.
 * Workers are told never to commit, so matching file content is external. A submodule HEAD move
 * is different: it changes the owning repository's gitlink and still needs activity/ownership checks.
 * Reads refs and trees only: the user's index, HEAD and stash are untouched.
 */
async function committedElsewhere(ctx: RunContext, tree: string, changes: readonly WorkspaceChange[]): Promise<Set<string>> {
  const found = new Set<string>();
  const { audit, baseline } = ctx;
  // Without a recorded starting HEAD (unreadable at start) "moved" is unknowable: never guess.
  const initial = startingHeads.get(ctx);
  if (!audit || !baseline?.headRead || !initial || !changes.length) return found;
  const current = await audit.headSnapshot();
  if (!current) return found;
  const differsFromHead = new Set((await audit.diff(current.tree, tree)).map(change => change.path));
  const compared = await audit.compare(baseline.tree, tree);
  const differsFromBaseline = new Set(compared.changes.map(change => change.path));
  for (const change of changes) {
    const repo = [...new Set([...initial.heads.keys(), ...current.heads.keys()])].filter(path => !path || change.path === path || change.path.startsWith(`${path}/`))
      .sort((a, b) => b.length - a.length)[0]!;
    if (!initial.heads.has(repo) || !current.heads.has(repo) || current.heads.get(repo) === initial.heads.get(repo)) continue;
    if (repo && change.path === repo) continue; // gitlinks remain subject to activity-based ownership attribution
    if (!differsFromHead.has(change.path) && differsFromBaseline.has(change.path)) found.add(change.path);
  }
  return found;
}

/**
 * Split a net diff into the run's own changes and external ones, first matching rule wins:
 *  1. written by a worker's successful edit/write call: the run's;
 *  2. committed elsewhere (see {@link committedElsewhere}): external;
 *  3. changed only in quiet windows, i.e. while no write-capable tool of this run was running: external;
 *  4. anything else is ambiguous. It stays the run's (current safety) for change/diagnose_fix, but
 *     `readOnly` runs (answer class: workers hold read-only tools) have no way to write, so a change
 *     not traceable to a worker tool call is external there.
 */
async function attribute(ctx: RunContext, tree: string, changes: readonly WorkspaceChange[], scope: ActivityScope, readOnly: boolean): Promise<Attribution> {
  const activity = ctx.activity;
  const committed = await committedElsewhere(ctx, tree, changes);
  const result: Attribution = { run: [], external: [], shellAmbiguous: new Set() };
  for (const change of changes) {
    const path = change.path;
    const reason = activity?.isWritten(path, scope) ? undefined
      : committed.has(path) ? COMMITTED_ELSEWHERE
      : activity?.touchedOnlyQuiet(path, scope) ? CHANGED_WHILE_QUIET
      : readOnly && activity && !activity.touchedActive(path, scope) ? NOT_TRACEABLE
      : undefined;
    if (reason) { result.external.push({ ...change, reason }); continue; }
    result.run.push(change);
    if (activity && !activity.isWritten(path, scope) && activity.touchedDuringShell(path, scope)) result.shellAmbiguous.add(path);
  }
  return result;
}

/** Remember external changes in the context and announce each file once, never as a violation. */
function reportExternal(ctx: RunContext, external: readonly ExternalWorkspaceChange[], agentId?: string): void {
  const known = (ctx.externalChanges ??= new Map());
  for (const change of external) {
    if (known.has(change.path)) continue;
    known.set(change.path, change);
    emit(ctx, { type: "workspace_external_change", timestamp: Date.now(), ...(agentId ? { agentId } : {}), file: change.path, reason: change.reason });
  }
}

/**
 * Diff the workspace against the previous audit snapshot and attribute each change (see
 * {@link attribute}). Every modification or deletion of an existing run-attributed file that
 * `allowed` rejects becomes a violation attributed to `actors`, the workers active since that
 * snapshot; new unowned source files also violate, generated artifacts warn. This catches what the
 * tool guard cannot see: writes through bash and scripts. External changes (another session, the
 * user, a commit elsewhere) are never violations: they are reported through
 * `workspace_external_change`; `agentId` on that event lists the audited workers, who are NOT blamed.
 * `readOnly` marks phases whose workers cannot write at all (answer analysts).
 *
 * Concurrent sessions. A file the run's bash (or another non-edit/write tool) may have written, that
 * `allowed` rejects and no edit/write call wrote, is normally a violation. When the run is flagged
 * ({@link concurrentSessionsFlagged}: other pi sessions were detected active at start, or re-detected at this or an earlier
 * audit point through `RunOptions.detectConcurrentActivity`) its writer is
 * unknowable, so it is external with {@link CONCURRENT_SESSION_AMBIGUOUS}, never a violation. Edit/write
 * calls outside ownership remain violations, flagged or not.
 */
export async function auditWorkspace(ctx: RunContext, actors: readonly string[], allowed: (file: string) => boolean, options: { readOnly?: boolean } = {}): Promise<void> {
  if (!ctx.audit || !ctx.auditTree) return;
  ctx.stage = `workspace/checkpoint/${ctx.state.phase}`;
  try {
    // The tracker closes the open quiet/active window with this snapshot, so the phase diff is
    // fully covered by classified windows.
    const tree = ctx.activity ? await ctx.activity.checkpoint() : await ctx.audit.snapshot();
    const changes = await workspaceChanges(ctx.audit, ctx.auditTree, tree);
    if (ctx.cancelled) return;
    // The window just closed may hold writes of a session that started after the run did: look again (the caller caches).
    await refreshConcurrentSessions(ctx);
    if (ctx.cancelled) return;
    ctx.auditTree = tree;
    const agentId = actors.join(",");
    const { run, external, shellAmbiguous } = await attribute(ctx, tree, changes, "phase", options.readOnly ?? false);
    // The phase facts live in the tracker: they were read above, before the new phase clears them.
    ctx.activity?.startPhase();
    reportExternal(ctx, external, agentId);
    const flagged = !options.readOnly && concurrentSessionsFlagged(ctx);
    const concurrent: ExternalWorkspaceChange[] = [];
    for (const change of run) {
      if (allowed(change.path)) continue;
      // Only new generated output is exempt; existing artifacts retain normal write semantics.
      if (change.status === "added" && classifyNewFile(change.path, ctx.auditSettings?.artifacts) === "artifact") {
        emit(ctx, { type: "workspace_unowned_file", timestamp: Date.now(), agentId, file: change.path });
        continue;
      }
      if (flagged && shellAmbiguous.has(change.path)) {
        concurrent.push({ ...change, reason: CONCURRENT_SESSION_AMBIGUOUS });
        continue;
      }
      const created = change.status === "added" ? { created: true as const } : {};
      ctx.violations.push({ agentId, file: change.path, via: "workspace", ...created });
      emit(ctx, {
        type: "ownership_violation", timestamp: Date.now(), agentId, file: change.path, via: "workspace",
        ...created,
        ownerTaskIds: coveringTasks(ctx.state.tasks, change.path).map(task => task.id),
      });
    }
    // After the loop: a file reported here is announced once, even if a later phase meets it again.
    reportExternal(ctx, concurrent, agentId);
  } catch (error) {
    disableAudit(ctx, error);
  }
}
export function disableAudit(ctx: RunContext, error: unknown): void {
  void ctx.audit?.close().catch(() => undefined);
  ctx.audit = undefined;
  ctx.activity = undefined;
  emit(ctx, { type: "workspace_audit_unavailable", timestamp: Date.now(), reason: error instanceof Error ? error.message : String(error) });
}
/** Snapshot the pre-run workspace and keep it restorable; outside git the audit stays off. */
export async function openWorkspaceAudit(ctx: RunContext): Promise<void> {
  try {
    const audit = await WorkspaceAudit.open(ctx.options.cwd, ctx.signal, { submodules: true });
    if (!audit) return;
    if (ctx.cancelled) { void audit.close().catch(() => undefined); return; }
    ctx.audit = audit;
    // HEAD is read before the snapshot: a commit made in between is then detected as "HEAD moved"
    // (its files equal the new HEAD but already equal the baseline, so nothing is misattributed).
    // An unreadable HEAD only disables the committed-elsewhere rule; it never fails the audit,
    // except for cancellation, which must still propagate.
    let head: string | undefined;
    let headRead = false;
    try {
      const heads = await audit.headSnapshot();
      if (heads) { startingHeads.set(ctx, heads); head = heads.heads.get(""); }
      headRead = true;
    } catch { ctx.signal?.throwIfAborted(); }
    const tree = await audit.snapshot();
    const commit = await audit.checkpoint(tree);
    if (ctx.cancelled) return;
    ctx.auditTree = tree;
    ctx.baseline = { tree, commit, headRead, ...(head ? { head } : {}) };
    ctx.activity = new WorkspaceActivity({
      cwd: ctx.options.cwd, tree, startedAt: ctx.startedAt,
      snapshot: () => audit.snapshot(),
      diff: (from, to) => workspaceChanges(audit, from, to),
      cancelled: () => ctx.cancelled,
    });
    emit(ctx, { type: "workspace_baseline", timestamp: Date.now(), commit });
  } catch (error) {
    disableAudit(ctx, error);
  }
}
/**
 * Final change list: `changes` are the run-attributed ones only; `external` (omitted when empty)
 * lists what was changed outside the run, with the reason. A file the run changed after an
 * earlier external change appears in both lists: it is the run's change, but it also carries
 * somebody else's work, so it must not be restored automatically. The exception is a file the audit
 * could not attribute (concurrent session active; ambiguous): unless an edit/write call of the run
 * wrote it, it is listed as external only, like the other changes made outside the run.
 */
export async function finalWorkspace(ctx: RunContext): Promise<RunReport["workspace"]> {
  if (!ctx.audit) return undefined;
  if (!ctx.baseline) {
    await ctx.audit.close().catch(() => undefined);
    return undefined;
  }
  try {
    // Queued boundary snapshots finish first, then the last window is closed and classified.
    await ctx.activity?.drain();
    const tree = ctx.activity ? await ctx.activity.checkpoint() : await ctx.audit.snapshot();
    const changes = await workspaceChanges(ctx.audit, ctx.baseline.tree, tree);
    // Last look for other sessions, so the report (and its warning) knows about sessions that appeared at the very end.
    await refreshConcurrentSessions(ctx);
    const attributed = await attribute(ctx, tree, changes, "run", ctx.state.taskClass === "answer");
    const { external } = attributed;
    const run = attributed.run.filter(change =>
      ctx.externalChanges?.get(change.path)?.reason !== CONCURRENT_SESSION_AMBIGUOUS || ctx.activity?.isWritten(change.path, "run"));
    const listed = new Set(external.map(change => change.path));
    for (const change of changes) {
      const earlier = ctx.externalChanges?.get(change.path);
      if (earlier && !listed.has(change.path)) { external.push({ ...change, reason: earlier.reason }); listed.add(change.path); }
    }
    external.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    reportExternal(ctx, external);
    await ctx.audit.close().catch(() => undefined);
    return { baseline: ctx.baseline.commit, changes: run, ...(external.length ? { external } : {}) };
  } catch (error) {
    disableAudit(ctx, error);
    return undefined;
  }
}
