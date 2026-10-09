import { formatDuration, type Liveness, type SessionLiveness } from "../../agent/liveness.js";
import { defaultRunLimits, describeExtensionSchedule, extensionBudgetMs, extensionLengthMs, type RunLimits } from "../limits.js";

/**
 * Activity-aware deadlines, shared by orche_run (one {@link ExtendableDeadline} per run) and orche_task (one per assignment).
 *
 * A deadline that expires while the work is still *active* (see src/agent/liveness.ts) is pushed out instead of timing out: the
 * n-th extension adds `extensionMs + (n - 1) × extensionStepMs` (linear; a step of 0 is the old fixed extension). One that expires
 * while the work is idle times out exactly as it always did. The budget is `maxExtensions` per ExtendableDeadline and is SHARED by
 * every deadline that hangs off it (the overall deadline and every phase cap), so the wall time of a run is bounded by
 * `base + extensionBudgetMs(schedule)` whatever mix of deadlines used it up. Once the budget is used up the deadlines are hard caps
 * again.
 *
 * Observation is separate from the deadline: {@link waitExtendable} can sample liveness and recorded progress every `observeEveryMs`
 * (default 5 minutes for orche_task), however long the current extension is, so a long extension never means a long blind spot.
 *
 * ### Model
 *
 * - The *overall deadline* is `startedAt + overallMs + the extensions it received`. Everything that used to be computed from
 *   `startedAt + overallMs` (remaining time, effective caps, the cleanup budget, diagnostics) reads it from here.
 * - A *phase cap* (`capMs` counted from the moment the phase starts) is a deadline of its own that is also bounded by the overall
 *   deadline. {@link PhaseDeadline} tracks it; an expiring phase cap is extended by `extensionMs`, and when the extended phase
 *   deadline would then lie beyond the overall deadline the overall deadline is extended by `extensionMs` too: ONE extension of the
 *   budget, never two. An expiring overall deadline (the one that bound the phase) extends the overall deadline only.
 * - Phase caps are shares of the run's budget (derived from the overall cap: a third of it, all of it, half of it), so whenever the
 *   overall deadline moves, every phase cap that is running moves with it. Without that a phase cap that falls just after the overall
 *   deadline (the default: the assignment cap equals the overall cap and starts a little later) would expire right after the overall
 *   extension and spend a second extension for the same stretch of work; and the order in which two timers of the same instant
 *   fire would decide how many extensions are spent.
 * - Extending is a pure decision: {@link ExtendableDeadline.tryExtend} takes a liveness verdict and answers; the owner emits the
 *   event / progress line / record ({@link extensionEvent}, {@link formatExtensionProgress}) and re-arms its timers.
 * - Cancellation by the user is not handled here on purpose: nothing in this module delays it (see {@link waitExtendable}, which
 *   returns the moment its signal aborts, extension window or not).
 *
 * The clock is injectable (`now`): every time read goes through it.
 */

export type ExtensionScope = "overall" | "phase" | "assignment";

/** Why a deadline was not extended. `disabled`: `maxExtensions` (or `extensionMs`) is 0, so nothing is said about it in messages. */
export type NotExtendedReason = "idle" | "budget" | "disabled" | "stalled";

/** One extension that was granted: what goes into events, run.json and the final report. Plain data. */
export interface DeadlineExtension {
  /** Which extension of the shared budget this was (1-based) and the budget. */
  n: number;
  max: number;
  /** The deadline that expired: the overall deadline, a phase cap, or the orche_task assignment wait (the overall deadline of its own). */
  scope: ExtensionScope;
  stage: string;
  /** Length of THIS extension (the n-th of the schedule). */
  extensionMs: number;
  /** When it was granted (epoch ms) and how long the run / assignment had been going. */
  at: number;
  elapsedMs: number;
  /** Epoch-ms deadline of `scope` before and after. */
  previousDeadline: number;
  newDeadline: number;
  /** The overall deadline after this extension, and whether this extension moved it (always for overall/assignment, for a phase only when it crossed it). */
  overallDeadline: number;
  overallExtended: boolean;
  /** The liveness lines that justified it, e.g. `W2 bash running 12m, output 20s ago`. */
  reasons: string[];
  /** What was recorded as progress at the time (checkpoints, plan updates, edits), separate from liveness; absent without a probe. */
  progress?: string;
}

/** The deadline was extended. `fresh: false`: nothing new was granted (the deadline had already been moved by another timer, or is not due yet): re-arm to `newDeadline`, emit nothing. */
export type Extended =
  | { extended: true; fresh: true; n: number; max: number; newDeadline: number; reasons: string[]; extension: DeadlineExtension }
  | { extended: true; fresh: false; n: number; max: number; newDeadline: number; reasons: string[]; extension?: undefined };

/** The deadline expires for real. `message` says why in one line (undefined for `disabled`): see {@link describeNotExtended}. */
export interface NotExtended {
  extended: false;
  reason: NotExtendedReason;
  /** Extensions used / allowed at the time. */
  n: number;
  max: number;
  windowMs: number;
  /** `stalled` only: how many consecutive observations found no activity, and how far apart they were. */
  checks?: number;
  everyMs?: number;
  message: string | undefined;
}

export type ExtendResult = Extended | NotExtended;

export interface ExtensionPolicy {
  /** The first extension added to an expired deadline when the work is active. */
  extensionMs: number;
  /** Added to each further extension (0: fixed). */
  extensionStepMs: number;
  /** Per ExtendableDeadline, shared by all of its deadlines; 0 disables extending. */
  maxExtensions: number;
  /** How recent the activity must be (liveness window). */
  activityWindowMs: number;
}

export interface ExtendableDeadlineOptions extends Partial<ExtensionPolicy> {
  /** Defaults to `now()`. */
  startedAt?: number;
  /** The BASE overall cap (ms from `startedAt`). */
  overallMs: number;
  /** Test seam: the clock for everything here. Defaults to Date.now. */
  now?: () => number;
}

export interface ExtendRequest {
  scope: ExtensionScope;
  stage: string;
  /** The verdict at the time of the expiry (use `ctx.liveness(now, windowMs)` / {@link asLiveness}). */
  liveness: Liveness;
  /** The recorded progress at the time, for the extension record (never a reason to grant or refuse). */
  progress?: string;
  /** scope `phase`: the phase's own current deadline (epoch ms). It is extended by `extensionMs`, and the overall deadline with it when that now lies beyond it. Defaults to the overall deadline. */
  phaseDeadline?: number;
  /**
   * The deadline the caller saw expire. Without it the clock decides: nothing is due before the deadline of `scope`, so a timer that
   * fires early, or one that lost the race to another timer of the same deadline, gets `fresh: false`. With it (overall/assignment) the
   * request is stale only when the overall deadline was moved past it since: use it when the clock cannot be trusted to have advanced
   * (a fake `wait`).
   */
  expired?: number;
}

const finiteNonNegative = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

export class ExtendableDeadline {
  readonly startedAt: number;
  /** The base overall cap, without any extension. */
  readonly baseOverallMs: number;
  /** The first extension; extension n is {@link extensionLengthMs}(n) = `extensionMs + (n - 1) × extensionStepMs`. */
  readonly extensionMs: number;
  /** Added per further extension (0: every extension is `extensionMs`). */
  readonly extensionStepMs: number;
  readonly maxExtensions: number;
  readonly activityWindowMs: number;
  private readonly clock: () => number;
  private overall: number;
  /** Total the overall deadline has moved by (phase caps that are running move by the same amount, see {@link PhaseDeadline}). */
  private shift = 0;
  private readonly log: DeadlineExtension[] = [];
  /** @internal Read by {@link PhaseDeadline}: how far the overall deadline has moved in total. */
  get shiftMs(): number { return this.shift; }

  constructor(options: ExtendableDeadlineOptions) {
    // A lambda, not `Date.now` itself: a clock replaced later (fake timers) is still the one that is read.
    this.clock = options.now ?? (() => Date.now());
    this.startedAt = options.startedAt ?? this.clock();
    this.baseOverallMs = finiteNonNegative(options.overallMs, defaultRunLimits.overallMs);
    this.extensionMs = finiteNonNegative(options.extensionMs, defaultRunLimits.extensionMs);
    // Same rule as resolveRunLimits: an explicit extensionMs without a step is the old fixed extension.
    this.extensionStepMs = finiteNonNegative(options.extensionStepMs, options.extensionMs !== undefined ? 0 : defaultRunLimits.extensionStepMs);
    this.maxExtensions = typeof options.maxExtensions === "number" && Number.isSafeInteger(options.maxExtensions) && options.maxExtensions >= 0 ? options.maxExtensions : defaultRunLimits.maxExtensions;
    this.activityWindowMs = finiteNonNegative(options.activityWindowMs, defaultRunLimits.activityWindowMs);
    this.overall = this.startedAt + this.baseOverallMs;
  }

  /**
   * For a run: `limits.overallMs` is the base. For an orche_task assignment pass `baseMs: limits.assignmentMs`: that wait is the
   * overall deadline of its own.
   */
  static fromLimits(limits: Pick<RunLimits, "overallMs" | "extensionMs" | "maxExtensions" | "activityWindowMs"> & Partial<Pick<RunLimits, "extensionStepMs">>, options: { startedAt?: number; baseMs?: number; now?: () => number } = {}): ExtendableDeadline {
    return new ExtendableDeadline({
      overallMs: options.baseMs ?? limits.overallMs, extensionMs: limits.extensionMs, extensionStepMs: limits.extensionStepMs ?? 0, maxExtensions: limits.maxExtensions, activityWindowMs: limits.activityWindowMs,
      ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}), ...(options.now ? { now: options.now } : {}),
    });
  }

  now(): number { return this.clock(); }
  /** Whether extending can happen at all (`maxExtensions` and `extensionMs` are both above zero). */
  get enabled(): boolean { return this.maxExtensions > 0 && this.extensionMs > 0; }
  /** Length of extension `n` (1-based) of this deadline's schedule. */
  extensionLengthMs(n: number): number { return extensionLengthMs(this, n); }
  /** The length the next extension would have (the schedule's next round), whether or not it will be granted. */
  get nextExtensionMs(): number { return this.extensionLengthMs(this.used + 1); }
  /** The current overall deadline (epoch ms): `startedAt + overallMs +` its extensions. */
  get overallDeadline(): number { return this.overall; }
  /** The overall cap as it stands (ms from `startedAt`): the base plus the extensions it received. */
  get overallCapMs(): number { return this.overall - this.startedAt; }
  /** The most the run can last: the base plus the whole budget (defaults: 30 min + 550 min = 9 h 40 min). */
  get hardLimitMs(): number { return this.baseOverallMs + extensionBudgetMs(this); }
  /** Extensions granted so far / left in the shared budget. */
  get used(): number { return this.log.length; }
  get left(): number { return Math.max(0, this.maxExtensions - this.log.length); }
  get exhausted(): boolean { return this.log.length >= this.maxExtensions; }
  /** Every extension granted, in order (plain data; the array is a copy). */
  get extensions(): DeadlineExtension[] { return this.log.map(extension => ({ ...extension, reasons: [...extension.reasons] })); }

  elapsedMs(now: number = this.now()): number { return now - this.startedAt; }
  /** Time left to the overall deadline (never negative). */
  overallRemainingMs(now: number = this.now()): number { return Math.max(0, this.overall - now); }
  /** Drop-in for the old `remaining(ctx, cap)`: `cap` ms from now, bounded by the CURRENT overall deadline. */
  remaining(capMs: number, now: number = this.now()): number { return Math.max(0, Math.min(capMs, this.overall - now)); }

  /** A phase cap of `capMs` that starts at `from` (default: now). */
  phase(capMs: number, stage: string, from: number = this.now()): PhaseDeadline { return new PhaseDeadline(this, capMs, stage, from); }

  /**
   * An expired deadline: extend it or say why not. Order of the answers: not due / already moved (`fresh: false`, nothing used) >
   * disabled > budget used up > no activity ({@link NotExtended}) > extended. Never throws. Cancellation is the caller's business and
   * wins before this is asked.
   */
  tryExtend(request: ExtendRequest): ExtendResult {
    const now = this.now();
    const phase = request.scope === "phase";
    const target = phase ? request.phaseDeadline ?? this.overall : this.overall;
    const stale = request.expired !== undefined ? !phase && request.expired < this.overall : now < target;
    if (stale) return { extended: true, fresh: false, n: this.used, max: this.maxExtensions, newDeadline: target, reasons: [] };
    const refuse = (reason: NotExtendedReason): NotExtended => {
      const result: NotExtended = { extended: false, reason, n: this.used, max: this.maxExtensions, windowMs: this.activityWindowMs, message: undefined };
      result.message = describeNotExtended(result);
      return result;
    };
    if (!this.enabled) return refuse("disabled");
    if (this.exhausted) return refuse("budget");
    if (!request.liveness.active) return refuse("idle");
    const amount = this.nextExtensionMs;
    const newDeadline = target + amount;
    // A phase cap that now reaches past the overall deadline takes the overall deadline with it: one extension, not two.
    const overallExtended = !phase || newDeadline > this.overall;
    if (overallExtended) { this.overall += amount; this.shift += amount; }
    const extension: DeadlineExtension = {
      n: this.used + 1, max: this.maxExtensions, scope: request.scope, stage: request.stage, extensionMs: amount,
      at: now, elapsedMs: now - this.startedAt, previousDeadline: target, newDeadline, overallDeadline: this.overall, overallExtended,
      reasons: [...request.liveness.reasons], ...(request.progress ? { progress: request.progress } : {}),
    };
    this.log.push(extension);
    return { extended: true, fresh: true, n: extension.n, max: extension.max, newDeadline, reasons: [...extension.reasons], extension };
  }

  /** The lines for the final report (see {@link formatExtensionSummary}); empty when nothing was extended and there is no refusal to explain. */
  summary(notExtended?: NotExtended): string[] {
    return formatExtensionSummary(this.log, { maxExtensions: this.maxExtensions, extensionMs: this.extensionMs, extensionStepMs: this.extensionStepMs, ...(notExtended ? { notExtended } : {}) });
  }
}

/**
 * One phase cap (`capMs` from `startedAt`) of an {@link ExtendableDeadline}: its own deadline, bounded by the overall one. The
 * old `effective = remaining(ctx, cap)`, `deadline = now + effective` pairs become `phase.effectiveDeadline` / `phase.remainingMs()`,
 * and an expired timer asks {@link PhaseDeadline.extend} instead of timing out at once.
 *
 * The phase's deadline is its own cap plus its own extensions plus every move of the overall deadline since the phase started: a phase
 * that extends itself past the overall deadline takes the overall deadline along (and absorbs that move, it is one extension), and an
 * overall extension carries every running phase along (see the module comment).
 */
export class PhaseDeadline {
  private current: number;
  /** The owner's total overall move already contained in `current`. */
  private seen: number;
  constructor(private readonly owner: ExtendableDeadline, readonly capMs: number, readonly stage: string, readonly startedAt: number) {
    this.current = startedAt + capMs;
    this.seen = owner.shiftMs;
  }

  /** The phase's own deadline, including the extensions it received and the moves of the overall deadline since it started. */
  get deadline(): number { return this.current + (this.owner.shiftMs - this.seen); }
  /** What actually bounds the phase now: the earlier of its own and the overall deadline. */
  get effectiveDeadline(): number { return Math.min(this.deadline, this.owner.overallDeadline); }
  /** Which of the two bounds it: `overall` when the overall deadline is earlier (the old `effective < cap`), else `phase`. */
  get scope(): "overall" | "phase" { return this.owner.overallDeadline < this.deadline ? "overall" : "phase"; }
  /** The phase's configured cap as it stands (base + the extensions it carries) and the effective one (bounded by overall), in ms from `startedAt`. */
  get currentCapMs(): number { return this.deadline - this.startedAt; }
  get effectiveCapMs(): number { return this.effectiveDeadline - this.startedAt; }
  /** Time left until {@link effectiveDeadline} (never negative): arm the timer with this. */
  remainingMs(now: number = this.owner.now()): number { return Math.max(0, this.effectiveDeadline - now); }

  /** The bounding deadline expired: extend it (the phase's own, or the overall one, whichever bound) or say why not. Applies the result to this phase. */
  extend(liveness: Liveness, stage: string = this.stage): ExtendResult {
    const scope = this.scope;
    const result = this.owner.tryExtend({ scope, stage, liveness, ...(scope === "phase" ? { phaseDeadline: this.deadline } : {}) });
    if (result.extended && result.fresh && scope === "phase") { this.current = result.newDeadline; this.seen = this.owner.shiftMs; }
    return result;
  }
}

/** A single session's verdict (e.g. `WorkerPool.workerLiveness`) or none (an unknown or retired session: idle) as the aggregate shape. */
export function asLiveness(value: Liveness | SessionLiveness | undefined): Liveness {
  if (!value) return { active: false, reasons: [], sessions: [] };
  if ("sessions" in value) return value;
  return { active: value.active, reasons: value.active ? [`${value.id} ${value.detail}`] : [], sessions: [value] };
}

/** `not extended: no activity in the last 2m` | `extension budget 10/10 used` | `stopped during extension 3/10: …` | undefined (extending is disabled: there is nothing to explain). */
export function describeNotExtended(result: RefusalFacts): string | undefined {
  if (result.reason === "idle") return `not extended: no activity in the last ${formatDuration(result.windowMs)}`;
  if (result.reason === "budget") return `extension budget ${result.n}/${result.max} used`;
  if (result.reason === "stalled") return `stopped during extension ${result.n}/${result.max}: no activity in ${result.checks ?? STALL_CHECKS} consecutive checks${result.everyMs ? ` ${formatDuration(result.everyMs)} apart` : ""}`;
  return undefined;
}

/** What a refusal message needs. */
export type RefusalFacts = Pick<NotExtended, "reason" | "n" | "max" | "windowMs"> & Partial<Pick<NotExtended, "checks" | "everyMs">>;

/** `message (reason)`: the timeout text with the reason it was not extended; `message` unchanged when there is nothing to say. */
export function withNotExtended(message: string, notExtended: RefusalFacts | undefined): string {
  const reason = notExtended ? describeNotExtended(notExtended) : undefined;
  return reason ? `${message} (${reason})` : message;
}

/** The progress line: `⏱ timeout extended 1/10 (+10m): W2 bash running 12m, cpu progressing; coordinator streaming`. At most `maxReasons` reasons are shown. */
export function formatExtensionProgress(extension: { n: number; max: number; extensionMs: number; reasons: readonly string[] }, maxReasons = 4): string {
  const shown = extension.reasons.slice(0, Math.max(1, maxReasons));
  const more = extension.reasons.length - shown.length;
  const reasons = shown.length ? `${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}` : "still active";
  return `⏱ timeout extended ${extension.n}/${extension.max} (+${formatDuration(extension.extensionMs)}): ${reasons}`;
}

/** One line per extension for the report: `1/10 at 30m (+10m), overall "implement backlog": W2 bash running 12m, cpu progressing · progress: …`. */
export function formatExtensionLine(extension: DeadlineExtension): string {
  const both = extension.scope === "phase" && extension.overallExtended ? " (overall extended too)" : "";
  return `${extension.n}/${extension.max} at ${formatDuration(extension.elapsedMs)} (+${formatDuration(extension.extensionMs)}), ${extension.scope} "${extension.stage}"${both}: ${extension.reasons.join("; ") || "still active"}${extension.progress ? ` · progress: ${extension.progress}` : ""}`;
}

/**
 * The final report's part about extensions: `Timeout extensions: 2/10 used (+10m, +20m … +1h40m), +30m in total` (`(+30m each)`
 * for a fixed schedule) and one indented line per extension, then why the last deadline was not extended when it expired anyway
 * (`notExtended`). Empty when there is nothing to tell.
 */
export function formatExtensionSummary(extensions: readonly DeadlineExtension[], options: { maxExtensions: number; extensionMs?: number; extensionStepMs?: number; notExtended?: RefusalFacts }): string[] {
  const refusal = options.notExtended ? describeNotExtended(options.notExtended) : undefined;
  if (!extensions.length && !refusal) return [];
  const schedule = options.extensionMs !== undefined ? describeExtensionSchedule({ extensionMs: options.extensionMs, ...(options.extensionStepMs !== undefined ? { extensionStepMs: options.extensionStepMs } : {}), maxExtensions: options.maxExtensions }) : "";
  const granted = extensions.reduce((sum, extension) => sum + extension.extensionMs, 0);
  return [
    `Timeout extensions: ${extensions.length}/${options.maxExtensions} used${schedule ? ` (${schedule})` : ""}${extensions.length ? `, +${formatDuration(granted)} in total` : ""}${refusal ? `; ${refusal}` : ""}`,
    ...extensions.map(extension => `  ${formatExtensionLine(extension)}`),
  ];
}

export interface DeadlineExtendedEvent { type: "deadline_extended"; timestamp: number; scope: ExtensionScope; stage: string; extension: number; maxExtensions: number; extensionMs: number; newDeadline: number; overallDeadline?: number; reasons: readonly string[]; progress?: string }

/** The `deadline_extended` run event of an extension. */
export function extensionEvent(extension: DeadlineExtension): DeadlineExtendedEvent {
  return {
    type: "deadline_extended", timestamp: extension.at, scope: extension.scope, stage: extension.stage, extension: extension.n,
    maxExtensions: extension.max, extensionMs: extension.extensionMs, newDeadline: extension.newDeadline, overallDeadline: extension.overallDeadline,
    reasons: [...extension.reasons], ...(extension.progress ? { progress: extension.progress } : {}),
  };
}

/** Consecutive inactive observations during an extension that end it early (with 5-minute observations: 10 minutes without a sign of life). */
export const STALL_CHECKS = 2;

/**
 * What the owner has RECORDED as progress, as opposed to liveness ("something is running"): `evidence` is a count that grows with
 * every Task DAG update, checkpoint or file edit; `lastEvidenceAt`/`last` say when and what the latest was. `activity` lists what
 * happened that is NOT progress evidence by itself (tool calls, compactions). Progress is reported, never used to stop: a long
 * build or render records nothing while it runs.
 */
export interface ProgressSample {
  evidence: number;
  lastEvidenceAt?: number;
  last?: string;
  activity?: string;
}

/** One observation of a running wait: liveness (alive) and recorded progress, kept apart. */
export interface WaitObservation {
  /** 1-based sequence number within this wait. */
  n: number;
  at: number;
  elapsedMs: number;
  /** Liveness: the work is running (model output, tool in flight, heartbeat, request in flight within its bound). */
  alive: boolean;
  reasons: string[];
  /** Recorded progress since the previous observation: `evidence` (new), `none` (nothing new), `unknown` (no probe). */
  progress: "evidence" | "none" | "unknown";
  /** Human-readable progress statement, e.g. `3 new since last check (last: node impl done, 40s ago)` or `none recorded for 25m (…)`. */
  progressDetail: string;
  /** The deadline runs on an extension (the base window has passed). */
  inExtension: boolean;
  /** Consecutive inactive observations so far (only while `inExtension` do they count towards a stall). */
  inactiveStreak: number;
  extensionsUsed: number;
  /** The current overall deadline (epoch ms). */
  deadline: number;
}

/** `⏱ check 4 at 1h05m: alive (W3 bash running 12m, …) · progress: none recorded for 25m (…)`. */
export function formatObservation(observation: WaitObservation, maxReasons = 2): string {
  const reasons = observation.reasons.slice(0, Math.max(1, maxReasons));
  const more = observation.reasons.length - reasons.length;
  const live = observation.alive ? `alive (${reasons.join("; ") || "active"}${more > 0 ? `; +${more} more` : ""})` : `NOT alive${observation.inExtension ? ` (${observation.inactiveStreak} consecutive)` : ""}`;
  return `⏱ check ${observation.n} at ${formatDuration(observation.elapsedMs)}: ${live} · progress: ${observation.progressDetail}`;
}

/** The progress statement of `sample` against the previous evidence count: what goes into observations and extension records. */
export function describeProgress(sample: ProgressSample | undefined, previous: number | undefined, now: number): { state: WaitObservation["progress"]; detail: string } {
  if (!sample) return { state: "unknown", detail: "no probe" };
  const fresh = previous === undefined ? sample.evidence : sample.evidence - previous;
  const last = sample.last ? `last: ${sample.last}${sample.lastEvidenceAt !== undefined ? `, ${formatDuration(now - sample.lastEvidenceAt)} ago` : ""}` : undefined;
  const activity = sample.activity ? `; ${sample.activity}` : "";
  if (fresh > 0) return { state: "evidence", detail: `${fresh} new${previous === undefined ? " so far" : " since last check"}${last ? ` (${last})` : ""}${activity}` };
  const quiet = sample.lastEvidenceAt !== undefined ? `none recorded for ${formatDuration(now - sample.lastEvidenceAt)}` : "none recorded yet";
  return { state: "none", detail: `${quiet}${last ? ` (${last})` : ""}${activity}; not a stop reason` };
}

export interface ExtendableWaitOptions<R extends { type: string }> {
  /** The deadline of this wait: one per orche_task assignment (`ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs })`). */
  deadline: ExtendableDeadline;
  /** Waits for the next result and resolves `{ type: "timeout" }` once `ms` elapsed, like `AgentManager.wait(id, ms)`: `ms => manager.wait(id, ms)`. */
  wait: (ms: number) => Promise<R>;
  /** The verdict at `now` over `windowMs`: an aggregate, one session (`workerLiveness`), or undefined (gone: idle). Read-only. */
  liveness: (now: number, windowMs: number) => Liveness | SessionLiveness | undefined;
  /** User cancellation: returns `{ type: "aborted" }` at once, whatever the wait is doing. */
  signal?: AbortSignal;
  stage: string;
  /** Default "assignment". */
  scope?: ExtensionScope;
  /** Called for each extension granted (progress line, records). A throw is ignored. */
  onExtended?: (extension: DeadlineExtension) => void;
  /**
   * Observation period (ms): while the wait runs, liveness and `progress` are sampled this often, whatever the length of the current
   * extension, and each sample goes to `onObservation`. 0 or absent: no observer (the verdict is read only when a deadline expires).
   */
  observeEveryMs?: number;
  /** Recorded progress evidence (checkpoints, plan updates, edits): sampled by the observer and at every expiry. Never a stop reason. */
  progress?: () => ProgressSample;
  /** Each observation (status line, records). A throw is ignored. */
  onObservation?: (observation: WaitObservation) => void;
  /**
   * Consecutive observations without activity (liveness inactive) that end the wait as `stalled`; only counted while the deadline
   * runs on an extension (the base window keeps its old behaviour). Default {@link STALL_CHECKS}; 0 never ends it early.
   */
  stallChecks?: number;
}

/** A result of the wait, or `timeout` (with the reason it was not extended), or `aborted` (the signal fired). */
export type ExtendableWaitResult<R extends { type: string }> =
  | Exclude<R, { type: "timeout" }>
  | { type: "timeout"; notExtended: NotExtended }
  | { type: "aborted" };

const ABORTED = Symbol("aborted");

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

const STALL = Symbol("stall");
interface Stall { type: typeof STALL; notExtended: NotExtended }
const isStall = (value: unknown): value is Stall => typeof value === "object" && value !== null && (value as { type?: unknown }).type === STALL;

/**
 * Waits like `wait(deadline - now)`, but when the deadline passes with the work still active it extends it and keeps waiting, up to
 * the budget of `deadline`; idle, or out of budget, it returns `{ type: "timeout", notExtended }` and the caller stops the work and
 * fails exactly as it did on a plain timeout. The `signal` wins at every point (before a wait, during it, between an expiry and the
 * liveness read, in an extension window): the result is `{ type: "aborted" }` at once. The abandoned `wait` is not cancelled (it has
 * no handle): it only resolves later, and the caller is tearing the worker down anyway.
 *
 * With `observeEveryMs` an observer timer, separate from the wait, samples liveness and recorded progress at that fixed period for
 * the whole wait (the wait itself is never split, so the trusted-timeout contract below holds). The observer only reports, with one
 * exception: while the deadline runs on an extension, `stallChecks` consecutive observations WITHOUT liveness end the wait as
 * `stalled` (the same verdict that refuses an extension at an expiry, so a long extension cannot hide a dead worker for 100
 * minutes). Missing progress evidence never ends it. The timer is cleared whenever the wait returns.
 *
 * The wait is trusted: a `timeout` result means the time passed, whatever the injected clock says, so a fake `wait` need not move it.
 */
export async function waitExtendable<R extends { type: string }>(options: ExtendableWaitOptions<R>): Promise<ExtendableWaitResult<R>> {
  const { deadline, signal } = options;
  const scope = options.scope ?? "assignment";
  let lastEvidence: number | undefined;
  const progressNow = (now: number) => {
    let sample: ProgressSample | undefined;
    try { sample = options.progress?.(); } catch { sample = undefined; }
    return { sample, ...describeProgress(sample, lastEvidence, now) };
  };
  const observer = startObserver(options, progressNow, sample => { if (sample) lastEvidence = sample.evidence; });
  try {
    for (;;) {
      if (signal?.aborted) return { type: "aborted" };
      const observed = deadline.overallDeadline;
      const pending = options.wait(Math.max(0, observed - deadline.now()));
      const waited = await raceAbort<R | Stall>(observer ? Promise.race([pending, observer.stalled]) : pending, signal);
      if (waited === ABORTED || signal?.aborted) return { type: "aborted" };
      if (isStall(waited)) return { type: "timeout", notExtended: waited.notExtended };
      if (waited.type !== "timeout") return waited as Exclude<R, { type: "timeout" }>;
      const now = deadline.now();
      const progress = options.progress ? progressNow(now).detail : undefined;
      const result = deadline.tryExtend({ scope, stage: options.stage, liveness: asLiveness(options.liveness(now, deadline.activityWindowMs)), expired: observed, ...(progress ? { progress } : {}) });
      if (!result.extended) return { type: "timeout", notExtended: result };
      if (result.fresh) { try { options.onExtended?.(result.extension); } catch { /* an observer cannot alter the wait */ } }
    }
  } finally {
    observer?.stop();
  }
}

/** The observer timer of {@link waitExtendable}: undefined without `observeEveryMs`. `stalled` resolves only on a stall. */
function startObserver<R extends { type: string }>(
  options: ExtendableWaitOptions<R>,
  progressNow: (now: number) => { sample: ProgressSample | undefined; state: WaitObservation["progress"]; detail: string },
  seen: (sample: ProgressSample | undefined) => void,
): { stalled: Promise<Stall>; stop(): void } | undefined {
  const every = options.observeEveryMs;
  if (typeof every !== "number" || !Number.isFinite(every) || every <= 0) return undefined;
  const { deadline } = options;
  const stallChecks = typeof options.stallChecks === "number" && Number.isSafeInteger(options.stallChecks) && options.stallChecks >= 0 ? options.stallChecks : STALL_CHECKS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let n = 0;
  let inactive = 0;
  let resolveStall: (stall: Stall) => void = () => undefined;
  const stalled = new Promise<Stall>(resolve => { resolveStall = resolve; });
  const tick = () => {
    timer = undefined;
    if (stopped || options.signal?.aborted) return;
    const now = deadline.now();
    let live: Liveness;
    try { live = asLiveness(options.liveness(now, deadline.activityWindowMs)); } catch { live = asLiveness(undefined); }
    const { sample, state, detail } = progressNow(now);
    seen(sample);
    const inExtension = deadline.used > 0;
    inactive = live.active ? 0 : inactive + 1;
    const observation: WaitObservation = {
      n: ++n, at: now, elapsedMs: deadline.elapsedMs(now), alive: live.active, reasons: [...live.reasons], progress: state, progressDetail: detail,
      inExtension, inactiveStreak: inactive, extensionsUsed: deadline.used, deadline: deadline.overallDeadline,
    };
    try { options.onObservation?.(observation); } catch { /* an observer cannot alter the wait */ }
    if (inExtension && stallChecks > 0 && inactive >= stallChecks) {
      const notExtended: NotExtended = { extended: false, reason: "stalled", n: deadline.used, max: deadline.maxExtensions, windowMs: deadline.activityWindowMs, checks: inactive, everyMs: every, message: undefined };
      notExtended.message = describeNotExtended(notExtended);
      stopped = true;
      resolveStall({ type: STALL, notExtended });
      return;
    }
    schedule();
  };
  const schedule = () => {
    timer = setTimeout(tick, every);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule();
  return { stalled, stop: () => { stopped = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; } };
}
