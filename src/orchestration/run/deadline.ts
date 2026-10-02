import { DEFAULT_LIVENESS_WINDOW_MS, mergeLiveness, type Liveness, type LivenessState, type SessionLiveness } from "../../agent/liveness.js";
import type { RunContext } from "./types.js";

/**
 * Liveness of the whole run at `now`: the coordinator session plus every worker of the manager (advisors are not part of it). Works on
 * any context; a coordinator that does not exist yet, or a manager without liveness (a test double), simply contributes nothing.
 * Lives here, not in context.ts, because the diagnostics below need it and context.ts imports this module.
 */
export function runLiveness(ctx: RunContext, now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS): Liveness {
  return mergeLiveness(ctx.coordinatorLiveness?.liveness(now, windowMs), ctx.manager?.liveness?.(now, windowMs));
}
/** What a diagnostic says about one session's liveness (see {@link SessionLiveness}). */
export interface LivenessSummary { state: LivenessState; active: boolean; detail: string; lastSignalAt?: number }
const summary = ({ state, active, detail, lastSignalAt }: SessionLiveness): LivenessSummary => ({ state, active, detail, ...(lastSignalAt !== undefined ? { lastSignalAt } : {}) });

export interface TimeoutDiagnostic {
  scope: "overall" | "phase";
  stage: string;
  phase: string;
  elapsedMs: number;
  configuredCapMs: number;
  effectiveCapMs: number;
  workers: Array<{ id: string; status?: string; assignmentId?: string; kind?: string; taskId?: string; requestCount?: number; lastActivityAt?: number; lastToolName?: string; lastToolAt?: number; liveness?: LivenessSummary }>;
  /** The coordinator session's liveness at the time of the snapshot; absent when it did not exist yet. */
  coordinator?: LivenessSummary;
  /**
   * What the run was doing when the snapshot was taken: `active` when any session counted as working within `windowMs`, and why
   * (`reasons`, e.g. `W2 bash running 14m, output 20s ago`). Absent when liveness could not be read. Informational only.
   */
  liveness?: { windowMs: number; active: boolean; reasons: string[] };
}
/** Manual cancellation snapshot, captured before teardown; timeouts retain their existing scope. */
export interface CancellationDiagnostic extends Omit<TimeoutDiagnostic, "scope"> {
  scope: "cancelled";
  timestamp: number;
}
function diagnosticSnapshot(ctx: RunContext, stage: string, cap: number, effective: number, includeIdle = false): Omit<TimeoutDiagnostic, "scope"> {
  // A diagnostic never fails because of liveness: a context or manager without it (or one that throws) just has no liveness fields.
  let live: Liveness | undefined;
  try { live = runLiveness(ctx, Date.now(), DEFAULT_LIVENESS_WINDOW_MS); } catch { live = undefined; }
  const session = (id: string) => live?.sessions.find(item => item.id === id);
  const coordinator = session("coordinator");
  return {
    stage, phase: ctx.state.phase, elapsedMs: Date.now() - ctx.startedAt,
    configuredCapMs: cap, effectiveCapMs: effective,
    workers: ctx.manager.list().filter(w => w.currentAssignment || (includeIdle && w.status !== "disposed")).map(w => ({
      id: w.id, status: w.status, assignmentId: w.currentAssignment?.id, kind: w.currentAssignment?.kind,
      taskId: ctx.activeTasks.get(w.id)?.id, requestCount: w.requestCount,
      lastActivityAt: w.lastActivityAt, lastToolName: w.lastToolName, lastToolAt: w.lastToolAt,
      ...(session(w.id) ? { liveness: summary(session(w.id)!) } : {}),
    })),
    ...(coordinator ? { coordinator: summary(coordinator) } : {}),
    ...(live?.sessions.length ? { liveness: { windowMs: DEFAULT_LIVENESS_WINDOW_MS, active: live.active, reasons: live.reasons } } : {}),
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
