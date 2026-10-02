import { classifyNewFile } from "../artifacts.js";
import { coveringTasks } from "../ownership.js";
import { WorkspaceAudit, type ExternalWorkspaceChange, type WorkspaceChange } from "../workspace.js";
import { WorkspaceActivity, type ActivityScope } from "./activity.js";
import { emit } from "./context.js";
import type { RunContext, RunReport } from "./types.js";

/** Git-snapshot workspace audit of a run: baseline, per-phase violations and the final change list. */

/** Why a change is not attributed to this run (shown to the user and carried in the report). */
export const COMMITTED_ELSEWHERE = "committed outside this run";
export const CHANGED_WHILE_QUIET = "changed while no worker tool was running";
export const NOT_TRACEABLE = "not traceable to a worker tool call";

interface Attribution { run: WorkspaceChange[]; external: ExternalWorkspaceChange[] }

/**
 * Files in `changes` that someone else committed during the run: HEAD moved since the baseline,
 * the file's current content equals its content in the new HEAD, and it differs from the baseline.
 * Workers are told never to commit, so a commit that moved HEAD was made elsewhere. Reads refs and
 * trees only (private index): the user's index, HEAD and stash are untouched.
 */
async function committedElsewhere(ctx: RunContext, tree: string, changes: readonly WorkspaceChange[]): Promise<Set<string>> {
  const found = new Set<string>();
  const { audit, baseline } = ctx;
  // Without a recorded starting HEAD (unreadable at start) "moved" is unknowable: never guess.
  if (!audit || !baseline?.headRead || !changes.length) return found;
  const head = await audit.head();
  if (!head || head === baseline.head) return found;
  const differsFromHead = new Set((await audit.diff(await audit.treeOf(head), tree)).map(change => change.path));
  const differsFromBaseline = new Set((await audit.diff(baseline.tree, tree)).map(change => change.path));
  for (const change of changes) if (!differsFromHead.has(change.path) && differsFromBaseline.has(change.path)) found.add(change.path);
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
  const result: Attribution = { run: [], external: [] };
  for (const change of changes) {
    const path = change.path;
    const reason = activity?.isWritten(path, scope) ? undefined
      : committed.has(path) ? COMMITTED_ELSEWHERE
      : activity?.touchedOnlyQuiet(path, scope) ? CHANGED_WHILE_QUIET
      : readOnly && activity && !activity.touchedActive(path, scope) ? NOT_TRACEABLE
      : undefined;
    if (reason) result.external.push({ ...change, reason }); else result.run.push(change);
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
 */
export async function auditWorkspace(ctx: RunContext, actors: readonly string[], allowed: (file: string) => boolean, options: { readOnly?: boolean } = {}): Promise<void> {
  if (!ctx.audit || !ctx.auditTree) return;
  ctx.stage = `workspace/checkpoint/${ctx.state.phase}`;
  try {
    // The tracker closes the open quiet/active window with this snapshot, so the phase diff is
    // fully covered by classified windows.
    const tree = ctx.activity ? await ctx.activity.checkpoint() : await ctx.audit.snapshot();
    const changes = await ctx.audit.diff(ctx.auditTree, tree);
    if (ctx.cancelled) return;
    ctx.auditTree = tree;
    const agentId = actors.join(",");
    const { run, external } = await attribute(ctx, tree, changes, "phase", options.readOnly ?? false);
    ctx.activity?.startPhase();
    reportExternal(ctx, external, agentId);
    for (const change of run) {
      if (allowed(change.path)) continue;
      // Only new generated output is exempt; existing artifacts retain normal write semantics.
      if (change.status === "added" && classifyNewFile(change.path, ctx.auditSettings?.artifacts) === "artifact") {
        emit(ctx, { type: "workspace_unowned_file", timestamp: Date.now(), agentId, file: change.path });
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
    const audit = await WorkspaceAudit.open(ctx.options.cwd, ctx.signal);
    if (!audit) return;
    if (ctx.cancelled) { void audit.close().catch(() => undefined); return; }
    ctx.audit = audit;
    // HEAD is read before the snapshot: a commit made in between is then detected as "HEAD moved"
    // (its files equal the new HEAD but already equal the baseline, so nothing is misattributed).
    // An unreadable HEAD only disables the committed-elsewhere rule; it never fails the audit,
    // except for cancellation, which must still propagate.
    let head: string | undefined;
    let headRead = false;
    try { head = await audit.head(); headRead = true; } catch { ctx.signal?.throwIfAborted(); }
    const tree = await audit.snapshot();
    const commit = await audit.checkpoint(tree);
    if (ctx.cancelled) return;
    ctx.auditTree = tree;
    ctx.baseline = { tree, commit, headRead, ...(head ? { head } : {}) };
    ctx.activity = new WorkspaceActivity({
      cwd: ctx.options.cwd, tree, startedAt: ctx.startedAt,
      snapshot: () => audit.snapshot(),
      diff: (from, to) => audit.diff(from, to),
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
 * somebody else's work, so it must not be restored automatically.
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
    const changes = await ctx.audit.diff(ctx.baseline.tree, tree);
    const { run, external } = await attribute(ctx, tree, changes, "run", ctx.state.taskClass === "answer");
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
