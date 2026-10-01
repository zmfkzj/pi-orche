import { classifyNewFile } from "../artifacts.js";
import { coveringTasks } from "../ownership.js";
import { WorkspaceAudit } from "../workspace.js";
import { emit } from "./context.js";
import type { RunContext, RunReport } from "./types.js";

/** Git-snapshot workspace audit of a run: baseline, per-phase violations and the final change list. */
/**
 * Diff the workspace against the previous audit snapshot. Every modification or deletion of an
 * existing file that `allowed` rejects becomes a violation attributed to `actors`, the workers
 * active since that snapshot; new unowned source files also violate, generated artifacts warn.
 * This catches what the tool guard cannot see: writes through bash and scripts.
 */
export async function auditWorkspace(ctx: RunContext, actors: readonly string[], allowed: (file: string) => boolean): Promise<void> {
  if (!ctx.audit || !ctx.auditTree) return;
  ctx.stage = `workspace/checkpoint/${ctx.state.phase}`;
  try {
    const tree = await ctx.audit.snapshot();
    const changes = await ctx.audit.diff(ctx.auditTree, tree);
    if (ctx.cancelled) return;
    ctx.auditTree = tree;
    const agentId = actors.join(",");
    for (const change of changes) {
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
  emit(ctx, { type: "workspace_audit_unavailable", timestamp: Date.now(), reason: error instanceof Error ? error.message : String(error) });
}
/** Snapshot the pre-run workspace and keep it restorable; outside git the audit stays off. */
export async function openWorkspaceAudit(ctx: RunContext): Promise<void> {
  try {
    const audit = await WorkspaceAudit.open(ctx.options.cwd, ctx.signal);
    if (!audit) return;
    if (ctx.cancelled) { void audit.close().catch(() => undefined); return; }
    ctx.audit = audit;
    const tree = await audit.snapshot();
    const commit = await audit.checkpoint(tree);
    if (ctx.cancelled) return;
    ctx.auditTree = tree;
    ctx.baseline = { tree, commit };
    emit(ctx, { type: "workspace_baseline", timestamp: Date.now(), commit });
  } catch (error) {
    disableAudit(ctx, error);
  }
}
export async function finalWorkspace(ctx: RunContext): Promise<RunReport["workspace"]> {
  if (!ctx.audit) return undefined;
  if (!ctx.baseline) {
    await ctx.audit.close().catch(() => undefined);
    return undefined;
  }
  try {
    const changes = await ctx.audit.diff(ctx.baseline.tree, await ctx.audit.snapshot());
    await ctx.audit.close().catch(() => undefined);
    return { baseline: ctx.baseline.commit, changes };
  } catch (error) {
    disableAudit(ctx, error);
    return undefined;
  }
}
