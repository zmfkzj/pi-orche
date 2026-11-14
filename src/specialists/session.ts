/**
 * One-shot sessions of the single workflow: a fresh session with a narrow tool set, one prompt and one structured report, always
 * disposed. The orchestrator's sub-workers (src/orchestrator/sub-worker.ts) run through here; the persistent orche_task worker does
 * not. Generalizes `runAdvisorSession` (src/advisor/session.ts): any report schema, an invalid report is sent back to the model to
 * repair instead of ending the call, and usage is returned for the caller's record.
 */
import type { LengthRecoveryOptions } from "../pi/length-recovery.js";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { formatSchemaErrors } from "../orchestration/schema-errors.js";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSession, type SessionOptions, type ToolGuard } from "../pi/session-factory.js";
import { configureSummaryBudget, type SummaryBudgetProfile } from "../pi/summary-budget.js";
import type { AstRewriteFileGuard } from "../tools/ast.js";
import { abortable } from "../orchestration/run/deadline.js";
import type { ModelRoute } from "../orchestration/routing.js";
import { LivenessTracker } from "../agent/liveness.js";
import { requestCheckpointNotice, type RunLimits } from "../orchestration/limits.js";
import { ExtendableDeadline, waitExtendable, withNotExtended, type DeadlineExtension, type NotExtended, type WaitObservation } from "../orchestration/run/extension.js";

export interface SpecialistUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface SpecialistReport<S extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: S;
  /** A semantic check after the schema check; a returned string is sent back to the model as the error to fix. */
  check?: (value: Static<S>) => string | undefined;
  /** Normalizes the arguments after the schema check, before `check` and capture (e.g. `data` sent as a JSON string). */
  normalize?: (value: Static<S>) => Static<S>;
}
export interface SpecialistRun<S extends TSchema> {
  /** Actor id for records and errors, e.g. `framer:T1#2`. */
  actor: string;
  route: ModelRoute;
  runtime: ModelRuntime;
  cwd: string;
  instructions: string;
  prompt: string;
  /** Built-in tool names; the report tool is added. */
  tools: readonly string[];
  customTools?: readonly ToolDefinition[];
  /** Worker capability extensions loaded into this session only (see SessionOptions.extensionFactories); their tools must be in `tools`. */
  extensionFactories?: SessionOptions["extensionFactories"];
  report: SpecialistReport<S>;
  toolGuard?: ToolGuard;
  /** Per-file ownership check of directory ast_rewrite writes (see SessionOptions.writeFileGuard); guarded sessions refuse them without it. */
  writeFileGuard?: AstRewriteFileGuard;
  /** Follow-up prompts when the model ends its turn without the report (default 0: the call fails at once). */
  nudges?: number;
  /** Turns (model responses) before the call fails without a report (the advisor's fixed cap); absent: no turn cap. */
  maxTurns?: number;
  /**
   * Requests at which the session gets one progress checkpoint notice (steered; orche_spawn sub-workers: `limits.assignmentRequests`
   * or an MDSD allocation's `requests`). Never a stop: the notice tells the model to keep working. Absent or 0: none.
   */
  requestCheckpoint?: number;
  /** Fixed time cap (ms) of the call; ignored when `deadline` is given. */
  timeoutMs: number;
  /**
   * One notice before a cap ends the call without a report (the advisor): when only `turnsLeft` turns remain before `maxTurns`, or
   * `atMs` after the start while the fixed `timeoutMs` timer is armed (never in completion wait or with a `deadline`), the session is
   * steered once to report now with what it has. Nothing is sent once a report is captured or being made; the caps stay as they are.
   */
  wrapUp?: SpecialistWrapUp;
  /**
   * An activity-aware deadline instead of the fixed `timeoutMs` (orche_spawn sub-workers): the same ExtendableDeadline and
   * waitExtendable as an orche_task assignment, fed by THIS session's own events only. Absent: the fixed timer (the advisor).
   */
  deadline?: SpecialistDeadline;
  /**
   * Completion wait (`--orche-completion-wait unbounded`, src/orchestration/completion-wait.ts): no wall-clock cap at all. The fixed
   * `timeoutMs` timer is not armed, and a `deadline` only observes (no expiry, extension or stall stop). A turn cap, a budget, a
   * model error and `signal` still end the call.
   */
  unbounded?: boolean;
  /** Cancellation of the caller (an orche_spawn sub-worker: its orchestrator's assignment and tool call); wins over any extension. */
  signal: AbortSignal;
  /** Persist the transcript here (the assignment record's `sessions/`); in memory without it. */
  sessionFile?: string;
  /** Effective main window when the route inherits the main model with extended context. */
  inheritedContextWindow?: number;
  /** Output-limit recovery options of the session (src/pi/length-recovery.ts); its defaults without. */
  lengthRecovery?: LengthRecoveryOptions;
  /** Skills (metadata) the session lists in its prompt; see SessionOptions.skills. */
  skills?: SessionOptions["skills"];
  /** Compaction with restored essentials (orche_spawn sub-workers with `workerCompaction.subWorkers`); absent: compaction stays off. */
  taskCompaction?: SessionOptions["taskCompaction"];
  /** The summary budget profile of this session's compactions (src/pi/summary-budget.ts; absent: standard). */
  summaryBudget?: SummaryBudgetProfile;
  /** Every tool the specialist starts (progress lines). */
  onTool?: (name: string) => void;
  /** Once the session exists: the `provider/id` and thinking level it really runs on (after Pi resolved the route and clamped the level). */
  onSession?: (use: { model: string; thinking?: string }) => void;
  /** Every session event, read-only (liveness of the caller: an orche_spawn sub-worker counts for its orchestrator). A throw is ignored. */
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
  /**
   * A budget of the session (an MDSD search worker): once a cost, output-token or time dimension reaches `wrapUpAt` of its
   * allocation, one steering notice asks for the report; at `hardStopAt` the call is cancelled. Token and cost checks run after each
   * model response (a response in flight is not cut by them, so it can overshoot); the time dimension also has a timer that cancels
   * in flight. Its `requests` is no limit: the caller passes it as the {@link SpecialistRun.requestCheckpoint}.
   */
  budget?: SpecialistBudget;
}
/** The allocation of a budgeted specialist call and its thresholds (fractions/multiples of the allocation). */
export interface SpecialistBudget {
  /** `requests`: the allocation's progress checkpoint (never a wrap-up or stop dimension); the others are enforced. */
  requests: number; minutes: number; costUSD: number; outputTokens: number; wrapUpAt: number; hardStopAt: number;
  /** What the wrap-up notice asks for (after the usage figures); absent: the search worker's text (findings, scopes). */
  notice?: string;
}
/** The wrap-up notice of a capped specialist call (see {@link SpecialistRun.wrapUp}). */
export interface SpecialistWrapUp {
  /** Remaining turns at which the notice goes out (at least 1). */
  turnsLeft: number;
  /** Elapsed time (ms) at which the notice goes out, when the fixed timer is armed. */
  atMs?: number;
  /** What the notice asks for (after the reason); default: the report with what the session has. */
  notice?: string;
}
/** Report responses a budget stop lets through (a report and one retry after an invalid one): part of a worker's worst case. */
export const REPORT_EXEMPTIONS = 2;
/** The deadline settings of an activity-aware specialist call (see {@link SpecialistRun.deadline}). */
export interface SpecialistDeadline {
  /** The resolved limits of the caller: base `assignmentMs`, the extension schedule, the activity window and `observeMs`. */
  limits: Pick<RunLimits, "assignmentMs" | "extensionMs" | "extensionStepMs" | "maxExtensions" | "activityWindowMs" | "observeMs">;
  /** Own timeouts of tools for liveness (e.g. generate_image), over KNOWN_TOOL_TIMEOUTS_MS. */
  toolTimeoutsMs?: Readonly<Record<string, number>>;
  /** Each extension granted. A throw is ignored. */
  onExtended?: (extension: DeadlineExtension) => void;
  /** Each periodic observation (every `limits.observeMs`). A throw is ignored. */
  onObservation?: (observation: WaitObservation) => void;
}

/** What the deadline of an activity-aware call did: its base and ceiling, the extensions, the observations, and why it stopped. */
export interface SpecialistDeadlineStats {
  baseMs: number;
  /** The most the call could last: base + the whole extension budget (its parent can still stop it earlier). */
  hardLimitMs: number;
  maxExtensions: number;
  extensions: DeadlineExtension[];
  observations: number;
  lastObservation?: WaitObservation;
  /** Set when the deadline stopped the call: `idle` (no activity at an expiry), `budget` (all extensions used) or `stalled`. */
  notExtended?: Pick<NotExtended, "reason" | "n" | "max" | "windowMs" | "checks" | "everyMs" | "message">;
  /** Completion wait: the call had no deadline (`baseMs`/`hardLimitMs` are the limits it would have had without the flag, not applied). */
  unbounded?: true;
}

export interface SpecialistStats {
  actor: string;
  model: string;
  thinking?: string;
  requests: number;
  durationMs: number;
  startedAt: number;
  usage: SpecialistUsage;
  /** `provider/model` → requests, as answered. */
  models: Record<string, number>;
  sessionFile?: string;
  /** Present for a call with {@link SpecialistRun.deadline}. */
  deadline?: SpecialistDeadlineStats;
  /** Present for a call with {@link SpecialistRun.budget}: when the wrap-up notice went out, what stopped the call, and whether a
   * response was in flight when it stopped (its usage is then unknown: Pi reports usage at the end of a response). */
  budget?: { wrapUp?: string; stoppedBy?: string; inFlightUnknown?: boolean };
  /** The wrap-up notice sent before a cap ({@link SpecialistRun.wrapUp}): why it went out (turns or time left), when one did. */
  wrapUp?: string;
}
export interface SpecialistOutcome<T> { value: T; stats: SpecialistStats }

/** The call ran but produced no valid report (turn cap, timeout, model error, cancellation); `stats` says what it cost. */
export class SpecialistError extends Error {
  override readonly name = "SpecialistError";
  constructor(message: string, readonly stats: SpecialistStats, readonly cancelled: boolean) { super(message); }
}

const errorsOf = (schema: TSchema, value: unknown): string => formatSchemaErrors(schema, value);

function reportTool<S extends TSchema>(report: SpecialistReport<S>, capture: (value: Static<S>) => void): ToolDefinition {
  let accepted = false;
  return {
    name: report.name,
    label: report.label,
    description: report.description,
    parameters: report.parameters,
    execute: async (_id, args) => {
      if (accepted) return { content: [{ type: "text", text: "Report already recorded." }], details: {}, isError: true, terminate: true };
      if (!Value.Check(report.parameters, args)) return { content: [{ type: "text", text: `Invalid ${report.name} arguments: ${errorsOf(report.parameters, args)}. Fix them and call ${report.name} again.` }], details: {}, isError: true };
      const value = report.normalize ? report.normalize(args as Static<S>) : args as Static<S>;
      const problem = report.check?.(value);
      if (problem) return { content: [{ type: "text", text: `${problem} Call ${report.name} again with the fix.` }], details: {}, isError: true };
      accepted = true;
      capture(value);
      return { content: [{ type: "text", text: "Report recorded." }], details: {}, terminate: true };
    },
  };
}

/** One bounded specialist call: fresh session, one valid report, always disposed. */
export async function runSpecialistSession<S extends TSchema>(run: SpecialistRun<S>): Promise<SpecialistOutcome<Static<S>>> {
  const startedAt = Date.now();
  const stats: SpecialistStats = { actor: run.actor, model: run.route.model, ...(run.route.thinking ? { thinking: run.route.thinking } : {}), requests: 0, durationMs: 0, startedAt, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, models: {} };
  const finish = () => { stats.durationMs = Date.now() - startedAt; return stats; };
  if (run.signal.aborted) throw new SpecialistError(`${run.actor}: cancelled`, finish(), true);
  const controller = new AbortController();
  const onAbort = () => controller.abort(run.signal.reason ?? new Error("cancelled"));
  run.signal.addEventListener("abort", onAbort, { once: true });
  const timer = run.deadline || run.unbounded ? undefined : setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(run.timeoutMs / 1000)}s`)), Math.max(0, run.timeoutMs));
  // The activity-aware deadline: this session's own liveness only (another sub-worker's activity never extends it).
  const tracker = run.deadline ? new LivenessTracker({ id: run.actor, role: "specialist", ...(run.deadline.toolTimeoutsMs ? { toolTimeoutsMs: run.deadline.toolTimeoutsMs } : {}) }) : undefined;
  const watchdog = run.deadline && tracker ? startWatchdog(run.deadline, tracker, startedAt, run.signal, stats, reason => controller.abort(new Error(reason)), !!run.unbounded) : undefined;
  const captured: { value?: Static<S> } = {};
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let turns = 0;
  let modelError: string | undefined;
  /** The budget's time check (MDSD search workers): cancels in flight once the time dimension reaches the stop. */
  let budgetTimer: ReturnType<typeof setInterval> | undefined;
  /** The wrap-up notice's timer (SpecialistRun.wrapUp.atMs): cleared on every exit. */
  let wrapTimer: ReturnType<typeof setTimeout> | undefined;
  // A model request in flight (from turn start to its assistant message end), and a response that ended aborted: for both the
  // provider's usage is unknown (marked on a budgeted call's stats when it ends by a cancellation, never counted as zero).
  let inFlight = false, cutResponse = false;
  const budget = run.budget;
  try {
    const creation = createSession({
      cwd: run.cwd, route: run.route, modelRuntime: run.runtime,
      tools: [...run.tools, run.report.name],
      customTools: [...(run.customTools ?? []), reportTool(run.report, value => { if (!controller.signal.aborted) captured.value ??= value; })],
      instructions: run.instructions,
      ...(run.toolGuard ? { toolGuard: run.toolGuard } : {}),
      ...(run.writeFileGuard ? { writeFileGuard: run.writeFileGuard } : {}),
      ...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
      ...(run.inheritedContextWindow ? { inheritedContextWindow: run.inheritedContextWindow } : {}),
      ...(run.lengthRecovery ? { lengthRecovery: run.lengthRecovery } : {}),
      ...(run.skills?.length ? { skills: run.skills } : {}),
      ...(run.extensionFactories?.length ? { extensionFactories: run.extensionFactories } : {}),
      ...(run.taskCompaction ? { taskCompaction: run.taskCompaction } : {}),
    }).then(created => {
      if (controller.signal.aborted) { created.dispose(); throw controller.signal.reason; }
      return created;
    });
    session = await abortable(creation, controller.signal);
    if (session.sessionFile) stats.sessionFile = session.sessionFile;
    if (run.summaryBudget) configureSummaryBudget(session, undefined, run.summaryBudget);
    // The model and level the session really runs on: Pi clamps the route's thinking to the model (a non-reasoning model runs off).
    if (session.model) stats.model = `${session.model.provider}/${session.model.id}`;
    if (session.thinkingLevel) stats.thinking = session.thinkingLevel;
    run.onSession?.({ model: stats.model, ...(stats.thinking ? { thinking: stats.thinking } : {}) });
    const active = session;
    const stop = () => { void active.abort().catch(() => undefined); };
    controller.signal.addEventListener("abort", stop, { once: true });
    // The budget (MDSD search workers): one wrap-up notice, then an explicit cancellation, by cost, output tokens or time (never by
    // the request count; see SpecialistRun.budget). `reporting`: the model's last response calls the report tool; the stop lets up to
    // REPORT_EXEMPTIONS such attempts (an invalid report gets its error and one more try) finish instead of discarding the findings,
    // and no notice interrupts them.
    let wrapped = false, stopped = false, reporting = false, exempted = 0;
    const enforce = () => {
      if (!budget || stopped || captured.value !== undefined || controller.signal.aborted) return;
      const minutes = (Date.now() - startedAt) / 60_000;
      const dimensions: [string, number, string][] = [
        ["cost", stats.usage.cost / budget.costUSD, `$${stats.usage.cost.toFixed(2)}/$${budget.costUSD}`],
        ["output tokens", stats.usage.output / budget.outputTokens, `${stats.usage.output}/${budget.outputTokens} output tokens`],
        ["time", minutes / budget.minutes, `${minutes.toFixed(1)}/${budget.minutes} min`],
      ];
      const worst = dimensions.reduce((a, b) => (b[1] > a[1] ? b : a));
      if (worst[1] >= budget.hardStopAt) {
        if (reporting && exempted < REPORT_EXEMPTIONS) { exempted++; return; }
        stopped = true;
        stats.budget = { ...stats.budget, stoppedBy: `${worst[0]} at ${worst[2]} (${budget.hardStopAt}x the allocation)`, ...(inFlight ? { inFlightUnknown: true } : {}) };
        controller.abort(new Error(`budget: ${stats.budget.stoppedBy}`));
      } else if (!wrapped && !reporting && worst[1] >= budget.wrapUpAt) {
        wrapped = true;
        stats.budget = { ...stats.budget, wrapUp: worst[2] };
        void active.steer(`Budget notice: this session used ${worst[2]} of its allocation. ${budget.notice ?? `Stop exploring now and call ${run.report.name} alone with what you have: your findings so far (each with evidence, counter-evidence and uncertainty), explored_scope, and everything you did not get to in unexplored_scope.`} Past ${Math.round(budget.hardStopAt * 100)}% of an allocation the session is stopped and what it has not reported is lost.`).catch(() => undefined);
      }
    };
    if (budget) budgetTimer = setInterval(enforce, 5_000);
    // The wrap-up notice (SpecialistRun.wrapUp): one steer before the turn cap or the fixed timer ends the call without a report.
    // Never while a report is being made or after one was captured; the caps themselves are unchanged.
    let noticed = false;
    const maxTurns = run.maxTurns;
    const wrapUpNotice = (why: string) => {
      const wrapUp = run.wrapUp;
      if (!wrapUp || noticed || reporting || captured.value !== undefined || controller.signal.aborted) return;
      noticed = true;
      stats.wrapUp = why;
      void active.steer(`${why} ${wrapUp.notice ?? `Stop now and call ${run.report.name} alone with what you have; partial results are fine.`} Without a report the session ends and nothing of it is used.`).catch(() => undefined);
    };
    const atMs = run.wrapUp?.atMs;
    if (atMs !== undefined && timer !== undefined && atMs < run.timeoutMs) {
      wrapTimer = setTimeout(() => wrapUpNotice(`Time notice: ${Math.round(atMs / run.timeoutMs * 100)}% of this session's time limit (${Math.round(run.timeoutMs / 1000)}s) is used.`), Math.max(0, atMs - (Date.now() - startedAt)));
    }
    unsubscribe = session.subscribe(event => {
      tracker?.observe(event as unknown as { type: string; [key: string]: unknown });
      if (run.onEvent) { try { run.onEvent(event as unknown as { type: string; [key: string]: unknown }); } catch { /* an observer cannot alter the session */ } }
      if (event.type === "tool_execution_start") run.onTool?.(event.toolName);
      if (event.type === "turn_end" && maxTurns !== undefined) {
        turns++;
        const left = maxTurns - turns;
        if (left <= 0 && captured.value === undefined) controller.abort(new Error(`no ${run.report.name} within ${maxTurns} turns`));
        else if (run.wrapUp && left > 0 && left <= Math.max(1, run.wrapUp.turnsLeft)) wrapUpNotice(`Turn notice: ${left} response${left === 1 ? "" : "s"} left before this session ends without a report.`);
      }
      // A model request is in flight from the start of a turn until its assistant message ends (tools run after that).
      if (event.type === "turn_start" || (event.type === "message_start" && event.message.role === "assistant")) { inFlight = true; reporting = false; }
      if (event.type === "message_end" && event.message.role === "assistant") {
        inFlight = false;
        const { usage } = event.message;
        const answered = `${event.message.provider}/${event.message.model}`;
        stats.requests++;
        stats.models[answered] = (stats.models[answered] ?? 0) + 1;
        stats.usage.input += usage.input; stats.usage.output += usage.output; stats.usage.cacheRead += usage.cacheRead; stats.usage.cacheWrite += usage.cacheWrite;
        stats.usage.cost += usage.cost?.total ?? 0;
        modelError = event.message.stopReason === "error" ? (event.message.errorMessage ?? "model error") : undefined;
        if (event.message.stopReason === "aborted") cutResponse = true;
        reporting = event.message.content.some(part => part.type === "toolCall" && part.name === run.report.name);
        enforce();
        // The one request checkpoint: a progress notice that keeps the session going (not after a real limit's wrap-up or a report).
        if (run.requestCheckpoint && stats.requests === run.requestCheckpoint && !wrapped && !reporting && captured.value === undefined && !controller.signal.aborted)
          void active.steer(requestCheckpointNotice(stats.requests, "this session", run.report.name)).catch(() => undefined);
      }
    });
    try {
      await abortable(session.prompt(run.prompt), controller.signal);
      // A model that ends its turn without the report gets the bounded follow-ups (never after a model error or the turn cap).
      for (let nudge = 0; nudge < (run.nudges ?? 0) && captured.value === undefined && !modelError && !controller.signal.aborted; nudge++)
        await abortable(session.prompt(`You ended without calling ${run.report.name}. Call ${run.report.name} alone now with your result; partial results are fine.`), controller.signal);
    } finally { controller.signal.removeEventListener("abort", stop); }
    if (captured.value === undefined) throw new Error(modelError ?? `ended without calling ${run.report.name}`);
    return { value: captured.value, stats: finish() };
  } catch (error) {
    if (error instanceof SpecialistError) throw error;
    // A budgeted call that ended by any cancellation (budget, caller, deadline, turn cap) with a response in flight or cut short:
    // that response's usage is unknown (Pi reports usage when a response ends), so it is marked rather than counted as zero.
    if (budget && (inFlight || cutResponse)) stats.budget = { ...stats.budget, inFlightUnknown: true };
    const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message : error instanceof Error ? error.message : String(error);
    throw new SpecialistError(`${run.actor}: ${reason}`, finish(), run.signal.aborted);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (budgetTimer !== undefined) clearInterval(budgetTimer);
    if (wrapTimer !== undefined) clearTimeout(wrapTimer);
    // The deadline's timers (wait and observer) end with the call, whatever ended it.
    await watchdog?.stop();
    run.signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    session?.dispose();
  }
}

/**
 * The deadline of an activity-aware call: `waitExtendable` until the call ends, extending while this session is active, and
 * `expire(reason)` when it is not (idle at an expiry, budget used up, or stalled during an extension). The caller's `signal` ends
 * the wait at once (the call is cancelled by it anyway). `stop()` ends the wait and its observer and resolves once both are gone.
 */
function startWatchdog(settings: SpecialistDeadline, tracker: LivenessTracker, startedAt: number, signal: AbortSignal, stats: SpecialistStats, expire: (reason: string) => void, unbounded = false): { stop(): Promise<void> } {
  const { limits } = settings;
  const deadline = ExtendableDeadline.fromLimits({ ...limits, overallMs: limits.assignmentMs }, { startedAt });
  const record: SpecialistDeadlineStats = { baseMs: deadline.baseOverallMs, hardLimitMs: deadline.hardLimitMs, maxExtensions: deadline.maxExtensions, extensions: [], observations: 0, ...(unbounded ? { unbounded: true as const } : {}) };
  stats.deadline = record;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  type Wait = { type: "timeout" } | { type: "done" };
  const wait = (ms: number) => new Promise<Wait>(resolve => {
    const timer = setTimeout(() => resolve({ type: "timeout" }), ms);
    void finished.then(() => { clearTimeout(timer); resolve({ type: "done" }); });
  });
  const running = waitExtendable<Wait>({
    deadline, wait, signal, stage: tracker.id, scope: "assignment", unbounded,
    liveness: (now, windowMs) => tracker.session(now, windowMs),
    observeEveryMs: limits.observeMs,
    onExtended: extension => { record.extensions.push(extension); try { settings.onExtended?.(extension); } catch { /* an observer cannot alter the deadline */ } },
    onObservation: observation => { record.observations++; record.lastObservation = observation; try { settings.onObservation?.(observation); } catch { /* an observer cannot alter the deadline */ } },
  }).then(result => {
    if (result.type !== "timeout") return;
    const why = result.notExtended;
    record.notExtended = { reason: why.reason, n: why.n, max: why.max, windowMs: why.windowMs, message: why.message, ...(why.checks !== undefined ? { checks: why.checks } : {}), ...(why.everyMs !== undefined ? { everyMs: why.everyMs } : {}) };
    // A stall ends an extension early: the time it really ran, not the cap it was extended to.
    const ranMs = why.reason === "stalled" ? deadline.elapsedMs() : deadline.overallCapMs;
    expire(withNotExtended(`timed out after ${Math.round(ranMs / 1000)}s`, why));
  }, () => undefined);
  return { stop: async () => { finish(); await running; } };
}
