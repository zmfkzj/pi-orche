import { DEFAULT_LIVENESS_WINDOW_MS, mergeLiveness, type Liveness, type LivenessState, type SessionLiveness } from "../../agent/liveness.js";
import { ExtendableDeadline, describeNotExtended, extensionEvent, type ExtendResult, type NotExtended, type NotExtendedReason, type PhaseDeadline } from "./extension.js";
import type { RunContext } from "./types.js";

/**
 * Liveness of the whole run at `now`: the coordinator session plus every worker of the manager (advisors are not part of it). Works on
 * any context; a coordinator that does not exist yet, or a manager without liveness (a test double), simply contributes nothing.
 * Lives here, not in context.ts, because the diagnostics below need it and context.ts imports this module.
 */
export function runLiveness(ctx: RunContext, now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS): Liveness {
  return mergeLiveness(ctx.coordinatorLiveness?.liveness(now, windowMs), ctx.manager?.liveness?.(now, windowMs));
}
/**
 * The run's {@link ExtendableDeadline}: `ctx.deadline`, or, for a context that was built without one (a hand-made test context), one made
 * from its limits and `startedAt` on first use. Everything that used to compute `startedAt + base cap` asks this.
 */
export function runDeadline(ctx: RunContext): ExtendableDeadline {
  const holder = ctx as { deadline?: ExtendableDeadline };
  return holder.deadline ??= ExtendableDeadline.fromLimits(ctx.limits, { startedAt: ctx.startedAt });
}
/** What a diagnostic says about one session's liveness (see {@link SessionLiveness}). */
export interface LivenessSummary { state: LivenessState; active: boolean; detail: string; lastSignalAt?: number }
const summary = ({ state, active, detail, lastSignalAt }: SessionLiveness): LivenessSummary => ({ state, active, detail, ...(lastSignalAt !== undefined ? { lastSignalAt } : {}) });

/** The run's extension budget at the time of a diagnostic, and (for a timeout) why the expired deadline was not extended. */
export interface ExtensionDiagnostic {
  /** Extensions granted so far / allowed (`limits.maxExtensions`), by `limits.extensionMs` each. */
  used: number;
  max: number;
  extensionMs: number;
  /** The activity window the liveness verdict was read over. */
  windowMs: number;
  /** `idle`: nothing was active within the window; `budget`: all extensions used; `disabled`: extending is off (or the run was already being torn down). */
  notExtended?: { reason: NotExtendedReason; message?: string };
}

export interface TimeoutDiagnostic {
  scope: "overall" | "phase";
  stage: string;
  phase: string;
  elapsedMs: number;
  /** The cap that applied, extensions included (base + the ones granted); `effectiveCapMs` is that bounded by the overall deadline. */
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
  /** Extensions used / allowed and why this deadline was not extended; absent when extending is off and none was granted. */
  extensions?: ExtensionDiagnostic;
}
/** Manual cancellation snapshot, captured before teardown; timeouts retain their existing scope. */
export interface CancellationDiagnostic extends Omit<TimeoutDiagnostic, "scope"> {
  scope: "cancelled";
  timestamp: number;
}
function diagnosticSnapshot(ctx: RunContext, stage: string, cap: number, effective: number, includeIdle = false, notExtended?: NotExtended): Omit<TimeoutDiagnostic, "scope"> {
  const deadline = runDeadline(ctx);
  // A diagnostic never fails because of liveness: a context or manager without it (or one that throws) just has no liveness fields.
  let live: Liveness | undefined;
  try { live = runLiveness(ctx, Date.now(), deadline.activityWindowMs); } catch { live = undefined; }
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
    ...(live?.sessions.length ? { liveness: { windowMs: deadline.activityWindowMs, active: live.active, reasons: live.reasons } } : {}),
    ...(deadline.maxExtensions > 0 || deadline.used > 0 ? {
      extensions: {
        used: deadline.used, max: deadline.maxExtensions, extensionMs: deadline.extensionMs, windowMs: deadline.activityWindowMs,
        ...(notExtended ? { notExtended: { reason: notExtended.reason, ...(notExtended.message ? { message: notExtended.message } : {}) } } : {}),
      },
    } : {}),
  };
}
/** The cap in a cancellation diagnostic is the overall cap as it stood (base + extensions granted), `effective` what was left of it. */
export function cancellationDiagnostic(ctx: RunContext): CancellationDiagnostic {
  const deadline = runDeadline(ctx);
  return {
    scope: "cancelled", timestamp: Date.now(),
    ...diagnosticSnapshot(ctx, ctx.stage ?? "run", deadline.overallCapMs, deadline.overallRemainingMs(Date.now()), true),
  };
}
/** ` (extended 1/10; not extended: no activity in the last 2m)` / ` (extension budget 10/10 used)`; empty when there is nothing to say. */
function extensionNote(extensions: ExtensionDiagnostic | undefined): string {
  const refusal = extensions?.notExtended;
  if (!extensions || !refusal) return "";
  const why = describeNotExtended({ reason: refusal.reason, n: extensions.used, max: extensions.max, windowMs: extensions.windowMs });
  const parts = [extensions.used > 0 && refusal.reason === "idle" ? `extended ${extensions.used}/${extensions.max}` : undefined, why].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}
export class RunTimeout extends Error {
  constructor(readonly diagnostic: TimeoutDiagnostic) {
    super(`${diagnostic.scope} timeout at ${diagnostic.stage} (${diagnostic.phase}): elapsed ${diagnostic.elapsedMs}ms, cap ${diagnostic.configuredCapMs}ms, effective ${diagnostic.effectiveCapMs}ms${extensionNote(diagnostic.extensions)}`);
  }
}
/**
 * Records a timeout (the run's `timeouts` list and a `run_timeout` event) and returns it to throw. `cap` / `effective` are the
 * CURRENT caps (extensions included, see {@link PhaseDeadline.currentCapMs}); `notExtended` says why the deadline was not extended and
 * ends up in the message and the diagnostic. Most callers want {@link expiry}, which also asks for an extension first.
 */
export function timeoutError(ctx: RunContext, stage: string, cap: number, effective: number, scope: "overall" | "phase", notExtended?: NotExtended): RunTimeout {
  const diagnostic: TimeoutDiagnostic = { scope, ...diagnosticSnapshot(ctx, stage, cap, effective, false, notExtended) };
  ctx.timeouts ??= [];
  ctx.timeouts.push(diagnostic);
  ctx.options.sink?.({ type: "run_timeout", timestamp: Date.now(), diagnostic });
  return new RunTimeout(diagnostic);
}
/** The verdict deadlines ask: the run's liveness over the activity window. Never throws (a broken reader means "not active"). */
function readLiveness(ctx: RunContext, now: number, windowMs: number): Liveness {
  try { return (ctx.liveness ?? ((at?: number, window?: number) => runLiveness(ctx, at, window)))(now, windowMs); }
  catch { return { active: false, reasons: [], sessions: [] }; }
}
/**
 * A deadline of the run expired at `stage`: the overall deadline when `phase` is omitted, else that phase cap (or the overall deadline when
 * it is the one binding the phase). If the run is still actively working and the shared budget allows, the deadline is extended (a
 * `deadline_extended` event goes to the sink) and this returns `undefined`: the caller re-arms its timer from the deadline. A timer that
 * fired early, or lost the race to another timer of the same deadline, also returns `undefined` and costs nothing. Otherwise the
 * deadline is a hard one: the recorded {@link RunTimeout} is returned, with why it was not extended, for the caller to cancel with and
 * throw. Cancellation and teardown are hard caps: nothing is extended once the run is cancelled or being cleaned up.
 */
export function expiry(ctx: RunContext, stage: string, phase?: PhaseDeadline): RunTimeout | undefined {
  const deadline = runDeadline(ctx);
  let result: ExtendResult;
  if (ctx.cancelled || ctx.signal?.aborted) {
    result = { extended: false, reason: "disabled", n: deadline.used, max: deadline.maxExtensions, windowMs: deadline.activityWindowMs, message: undefined };
  } else {
    const liveness = readLiveness(ctx, deadline.now(), deadline.activityWindowMs);
    result = phase ? phase.extend(liveness, stage) : deadline.tryExtend({ scope: "overall", stage, liveness });
  }
  if (result.extended) {
    if (result.fresh && !ctx.reported) ctx.options.sink?.(extensionEvent(result.extension));
    return undefined;
  }
  return phase
    ? timeoutError(ctx, stage, phase.currentCapMs, phase.effectiveCapMs, phase.scope, result)
    : timeoutError(ctx, stage, deadline.overallCapMs, deadline.overallCapMs, "overall", result);
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
