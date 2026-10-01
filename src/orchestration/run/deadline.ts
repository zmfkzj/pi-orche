import type { RunContext } from "./types.js";

export interface TimeoutDiagnostic {
  scope: "overall" | "phase";
  stage: string;
  phase: string;
  elapsedMs: number;
  configuredCapMs: number;
  effectiveCapMs: number;
  workers: Array<{ id: string; status?: string; assignmentId?: string; kind?: string; taskId?: string; requestCount?: number; lastActivityAt?: number; lastToolName?: string; lastToolAt?: number }>;
}
/** Manual cancellation snapshot, captured before teardown; timeouts retain their existing scope. */
export interface CancellationDiagnostic extends Omit<TimeoutDiagnostic, "scope"> {
  scope: "cancelled";
  timestamp: number;
}
function diagnosticSnapshot(ctx: RunContext, stage: string, cap: number, effective: number, includeIdle = false): Omit<TimeoutDiagnostic, "scope"> {
  return {
    stage, phase: ctx.state.phase, elapsedMs: Date.now() - ctx.startedAt,
    configuredCapMs: cap, effectiveCapMs: effective,
    workers: ctx.manager.list().filter(w => w.currentAssignment || (includeIdle && w.status !== "disposed")).map(w => ({
      id: w.id, status: w.status, assignmentId: w.currentAssignment?.id, kind: w.currentAssignment?.kind,
      taskId: ctx.activeTasks.get(w.id)?.id, requestCount: w.requestCount,
      lastActivityAt: w.lastActivityAt, lastToolName: w.lastToolName, lastToolAt: w.lastToolAt,
    })),
  };
}
export function cancellationDiagnostic(ctx: RunContext): CancellationDiagnostic {
  return {
    scope: "cancelled", timestamp: Date.now(),
    ...diagnosticSnapshot(ctx, ctx.stage ?? "run", ctx.limits.overallMs, Math.max(0, ctx.limits.overallMs - (Date.now() - ctx.startedAt)), true),
  };
}
export class RunTimeout extends Error {
  constructor(readonly diagnostic: TimeoutDiagnostic) {
    super(`${diagnostic.scope} timeout at ${diagnostic.stage} (${diagnostic.phase}): elapsed ${diagnostic.elapsedMs}ms, cap ${diagnostic.configuredCapMs}ms, effective ${diagnostic.effectiveCapMs}ms`);
  }
}
export function timeoutError(ctx: RunContext, stage: string, cap: number, effective: number, scope: "overall" | "phase"): RunTimeout {
  const diagnostic: TimeoutDiagnostic = { scope, ...diagnosticSnapshot(ctx, stage, cap, effective) };
  ctx.timeouts ??= [];
  ctx.timeouts.push(diagnostic);
  ctx.options.sink?.({ type: "run_timeout", timestamp: Date.now(), diagnostic });
  return new RunTimeout(diagnostic);
}
/** A losing promise is observed; SDK creation cannot itself be forcibly interrupted. */
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("cancelled"));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
/** Cleanup never receives an extra grace period. Pending work is reported, not hidden. */
export async function cleanupWait(operation: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation.then(() => true, () => false), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); })]);
  } finally { clearTimeout(timer); }
}
