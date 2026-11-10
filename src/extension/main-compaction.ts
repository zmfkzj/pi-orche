/**
 * Ratio-based automatic compaction of the MAIN Pi session (`mainCompaction` in orche.config.json; docs/compaction.md).
 *
 * Pi decides automatic compaction with an absolute token reserve (`compaction.reserveTokens` / `compaction.modelOverrides`,
 * integers only): `contextTokens > contextWindow - reserveTokens`. This module adds a model-independent ceiling for the main
 * session: once Pi's own estimate of the context (`ctx.getContextUsage()`, the same estimator Pi's threshold check uses, against
 * the context window of the model Pi resolves for limits) is above `usageRatio` of the CURRENT model's window, main compacts
 * through Pi's ordinary compaction (`ctx.compact()`: the same summary, `keepRecentTokens`, `session_before_compact` /
 * `session_compact` hooks of every extension). Nothing is hard-coded per model: a model registered today and a model switch
 * use their own `contextWindow` from Pi's model registry.
 *
 * When it compacts:
 * - after a main run settled (not aborted) and Pi is idle, and after a model switch while idle;
 * - between the tool turns of a running response (`midRun`): Pi offers extensions no compaction inside a run, and
 *   `ctx.compact()` aborts the run first, so the run is interrupted after its tool results are stored, compacted, and continued
 *   with a hidden note (`orche-main-compaction`). Skipped (the run goes on; the next boundary checks again) while the user has
 *   queued messages, while orche holds a one-shot request or held-back input, outside interactive/RPC mode, or when Pi's own
 *   threshold compacts before the next request anyway.
 *
 * Precedence: the ratio is a ceiling, Pi's integer threshold stays as it is. A reserve that leaves less than `1 - usageRatio`
 * of a window free (e.g. a large `modelOverrides` entry) still compacts earlier; manual `/compact` and overflow recovery are
 * unchanged; `compaction.enabled: false` in Pi's settings turns this off too. Only the main session loads this module: worker
 * sessions are created with `noExtensions` and keep their own policy (src/pi/compaction-policy.ts, 50%).
 *
 * Bounded: one attempt in flight; none while any compaction runs; a failed or cancelled attempt is not retried before the next
 * user input, a model switch or a session start; when the first measured usage after our compaction is still above the
 * threshold, the ratio stops triggering until usage is back below it (no compaction loop).
 *
 * Delivery: orche's own turn-starting messages (background task results, queued-task notices) go through `deliver`. Pi starts
 * such a turn even while it compacts outside a run, so they are held from the moment this module requests a compaction (and
 * during another manual compaction) and sent once afterwards, behind the continuation note; after Esc they are shown without a
 * turn. Other extensions' messages are not under orche's control (docs/compaction.md).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface MainCompactionSettings {
  /** Default true. False: only Pi's own compaction settings decide, unchanged. */
  enabled: boolean;
  /** Fraction of the current model's context window main may use; above it main compacts (default 0.8: 80% used, 20% left). */
  usageRatio: number;
  /** Also compact between the tool turns of a running response (interrupts and continues it). Default true. */
  midRun: boolean;
}
export const DEFAULT_MAIN_COMPACTION: Readonly<MainCompactionSettings> = { enabled: true, usageRatio: 0.8, midRun: true };
/** Allowed `usageRatio` values (inclusive). */
export const MAIN_USAGE_RATIO_RANGE = { min: 0.1, max: 0.95 } as const;
/** `customType` of the hidden note that continues a response interrupted for compaction. */
export const MAIN_COMPACTION_RESUME_TYPE = "orche-main-compaction";
/** Pi's built-in `compaction.reserveTokens` (docs/compaction.md "Settings"). */
export const PI_DEFAULT_RESERVE_TOKENS = 16384;

/**
 * `mainCompaction` in orche.config.json: `false` (off), `true` (defaults), a ratio (`0.8`), or
 * `{ "enabled"?: boolean, "usageRatio"?: number, "midRun"?: boolean }`.
 */
export function parseMainCompactionConfig(value: unknown): MainCompactionSettings {
  const ratio = (raw: unknown, key: string): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < MAIN_USAGE_RATIO_RANGE.min || raw > MAIN_USAGE_RATIO_RANGE.max) {
      throw new Error(`config.${key}: expected a fraction of the context window from ${MAIN_USAGE_RATIO_RANGE.min} to ${MAIN_USAGE_RATIO_RANGE.max} (0.8 = compact above 80% used)`);
    }
    return raw;
  };
  if (value === false) return { ...DEFAULT_MAIN_COMPACTION, enabled: false };
  if (value === true) return { ...DEFAULT_MAIN_COMPACTION };
  if (typeof value === "number") return { ...DEFAULT_MAIN_COMPACTION, usageRatio: ratio(value, "mainCompaction") };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.mainCompaction: expected false, true, a ratio or an object");
  const settings = value as Record<string, unknown>;
  const unknown = Object.keys(settings).filter(key => key !== "enabled" && key !== "usageRatio" && key !== "midRun");
  if (unknown.length) throw new Error(`config.mainCompaction: unknown field ${unknown.join(", ")}`);
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error("config.mainCompaction.enabled: expected boolean");
  if (settings.midRun !== undefined && typeof settings.midRun !== "boolean") throw new Error("config.mainCompaction.midRun: expected boolean");
  return {
    enabled: (settings.enabled as boolean | undefined) ?? DEFAULT_MAIN_COMPACTION.enabled,
    usageRatio: settings.usageRatio === undefined ? DEFAULT_MAIN_COMPACTION.usageRatio : ratio(settings.usageRatio, "mainCompaction.usageRatio"),
    midRun: (settings.midRun as boolean | undefined) ?? DEFAULT_MAIN_COMPACTION.midRun,
  };
}

/** Tokens main may hold: `floor(contextWindow * usageRatio)`; undefined without a usable window. Compaction needs MORE than this. */
export function ratioThreshold(contextWindow: number | undefined, usageRatio: number): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.floor(contextWindow * usageRatio);
}

/**
 * The reserve Pi itself applies to `model`, resolved as Pi does (docs/compaction.md "Per-model overrides"):
 * `compaction.modelOverrides["provider/id"].reserveTokens`, else `compaction.reserveTokens`, else 16384.
 */
export function piReserveTokens(settings: unknown, model: { provider: string; id: string } | undefined): number {
  const compaction = (settings as { compaction?: { reserveTokens?: unknown; modelOverrides?: Record<string, { reserveTokens?: unknown } | undefined> } } | undefined)?.compaction;
  const valid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const override = model ? valid(compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens) : undefined;
  return override ?? valid(compaction?.reserveTokens) ?? PI_DEFAULT_RESERVE_TOKENS;
}

export interface UsageLike { tokens: number | null; contextWindow: number }
export type MainCompactionCheck =
  | { compact: true; tokens: number; contextWindow: number; threshold: number; percent: number }
  | { compact: false; reason: "disabled" | "pi_disabled" | "no_window" | "no_usage" | "below" | "native" | "ineffective" | "blocked" };

/**
 * Whether main should compact now. `nativeReserve` (mid-run only): Pi's own threshold already compacts before the next request
 * when the usage is above `contextWindow - nativeReserve`, so this module leaves that turn to Pi.
 */
export function checkMainCompaction(input: {
  settings: MainCompactionSettings;
  piEnabled: boolean;
  usage: UsageLike | undefined;
  nativeReserve?: number;
  ineffective?: boolean;
  blocked?: boolean;
}): MainCompactionCheck {
  if (!input.settings.enabled) return { compact: false, reason: "disabled" };
  if (!input.piEnabled) return { compact: false, reason: "pi_disabled" };
  const threshold = ratioThreshold(input.usage?.contextWindow, input.settings.usageRatio);
  if (threshold === undefined || !input.usage) return { compact: false, reason: "no_window" };
  const tokens = input.usage.tokens;
  if (tokens === null || !Number.isFinite(tokens)) return { compact: false, reason: "no_usage" };
  if (tokens <= threshold) return { compact: false, reason: "below" };
  if (input.blocked) return { compact: false, reason: "blocked" };
  if (input.ineffective) return { compact: false, reason: "ineffective" };
  if (input.nativeReserve !== undefined && tokens > input.usage.contextWindow - input.nativeReserve) return { compact: false, reason: "native" };
  return { compact: true, tokens, contextWindow: input.usage.contextWindow, threshold, percent: tokens / input.usage.contextWindow * 100 };
}

export interface MainCompactionHooks {
  settings(): MainCompactionSettings;
  /** Whether main's running response may be interrupted (orche: no one-shot request and no held-back input). */
  canInterrupt(): boolean;
  /** Runs `fn` later (default: a timer of `delayMs`, 0 ms when omitted), after Pi's own handlers of the current event. */
  schedule?: (fn: () => void, delayMs?: number) => void;
}
type Api = Pick<ExtensionAPI, "on" | "sendMessage" | "getSettings">;
type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
/** Options of a turn-starting message (`deliver`). */
export interface TurnMessageOptions { triggerTurn: true; deliverAs?: "steer" | "followUp" }
/** How often a release waits for Pi to finish a compaction it did not start for this module (its state clears after the hooks). */
const RELEASE_POLL_MS = 25;
interface Attempt {
  generation: number;
  /** The response was interrupted for this compaction: continue it afterwards. */
  resume: boolean;
  /** Leaf entry when the attempt started: an aborted/error response after it shows the run was really cut off. */
  marker: string | null | undefined;
  /** Pi has not yet started this compaction (its `session_before_compact` is still to come). */
  awaitingStart: boolean;
  /** Another compaction finished after this attempt was requested and before it started: nothing is left to do. */
  superseded: boolean;
  /** This module cancelled the attempt (superseded). */
  cancelledByUs: boolean;
  /** Pi reported the attempt cancelled (Esc, or another extension's cancel) or failed. */
  outcome?: "done" | "cancelled" | "failed";
  /** The user sent input while it ran: their message, not our note, continues the session. */
  inputSeen: boolean;
}

const k = (tokens: number) => `${Math.round(tokens / 100) / 10}k`;

export class MainCompaction {
  private generation = 0;
  private attempt: Attempt | undefined;
  /** A compaction (any reason, any initiator) is between `session_before_compact` and its end. */
  private compacting = false;
  /** Measure the first usage after our compaction (loop guard). */
  private measure = false;
  /** Our last compaction left usage above the threshold: no ratio trigger until usage is below it again. */
  private ineffective = false;
  /** A failed or cancelled attempt: no new one before user input, a model switch or a session start. */
  private blocked = false;
  /** The next `agent_settled` reports the abort this module caused (orche then keeps its non-abort semantics). */
  private internalAbort = false;
  /** An interrupted run waiting for its continuation note (input arriving now still takes precedence). */
  private pendingResume: Attempt | undefined;
  /** A manual compaction this module did not start (the user's `/compact`, another extension's `ctx.compact()`) is running. */
  private foreign = false;
  /** A release after a compaction is scheduled: new messages keep queueing behind the held ones (their order). */
  private releasing = false;
  /** orche's turn-starting messages that arrived while main compacted outside a run (`deliver`), in arrival order. */
  private held: { message: Message; options: TurnMessageOptions }[] = [];
  private api: Api | undefined;
  private readonly schedule: (fn: () => void, delayMs?: number) => void;

  constructor(private readonly hooks: MainCompactionHooks) {
    this.schedule = hooks.schedule ?? ((fn, delayMs) => { setTimeout(fn, delayMs ?? 0).unref?.(); });
  }

  /**
   * Sends one of orche's turn-starting messages (a background task result, a queued-task notice). While main compacts outside a
   * run (this module's automatic compaction from the moment it is requested, or another manual compaction from its
   * `session_before_compact`) Pi would start that turn beside the summary, so the message is held and sent once afterwards, in
   * order, behind the continuation note of an interrupted response. After a compaction the user cancelled (Esc) it is shown
   * without starting a turn, as orche does with held-back results after an abort; at a session shutdown it is kept in that
   * session the same way. Messages of other extensions do not pass here.
   */
  deliver(message: Message, options: TurnMessageOptions): void {
    if (this.attempt || this.foreign || this.releasing) { this.held.push({ message, options }); return; }
    this.api?.sendMessage(message, options);
  }

  /** `event.aborted` of `agent_settled` without the abort this module caused for a mid-run compaction (consumed once). */
  effectiveAborted(aborted: boolean): boolean {
    const internal = this.internalAbort;
    this.internalAbort = false;
    return aborted && !internal;
  }

  register(pi: Api): void {
    this.api = pi;
    const reset = () => {
      this.generation++;
      this.attempt = undefined;
      this.pendingResume = undefined;
      this.compacting = false;
      this.foreign = false;
      this.releasing = false;
      this.measure = false;
      this.ineffective = false;
      this.blocked = false;
      this.internalAbort = false;
    };
    pi.on("session_start", () => { reset(); this.held = []; });
    pi.on("session_shutdown", () => {
      // Held messages stay in the session they belong to, without a turn; nothing carries over to the next session.
      for (const item of this.held.splice(0)) {
        try { pi.sendMessage(item.message, { triggerTurn: false }); } catch { /* the session is gone already */ }
      }
      reset();
    });
    pi.on("input", () => {
      this.blocked = false;
      for (const attempt of [this.attempt, this.pendingResume]) if (attempt) attempt.inputSeen = true;
      return undefined;
    });
    pi.on("model_select", (_event, ctx) => {
      this.ineffective = false;
      this.blocked = false;
      this.scheduleIdleCheck(pi, ctx);
    });
    pi.on("session_before_compact", event => {
      const attempt = this.attempt;
      if (attempt?.awaitingStart && event.reason === "manual") {
        attempt.awaitingStart = false;
        // Pi's own threshold (or another trigger) compacted after we asked: a second summary would only shrink a fresh context.
        if (attempt.superseded) { attempt.cancelledByUs = true; return { cancel: true }; }
      } else if (event.reason === "manual") {
        // Not ours: Pi runs a manual compaction outside a run too. (Its threshold and overflow compactions run inside a run, where
        // Pi queues a turn-starting message behind the run instead.)
        this.foreign = true;
      }
      this.compacting = true;
      return undefined;
    });
    // Pi clears its compaction state only after these hooks: a release waits until Pi is idle or a run is going on.
    pi.on("session_compact", (_event, ctx) => {
      this.compacting = false;
      const attempt = this.attempt;
      if (attempt?.awaitingStart) attempt.superseded = true;
      if (this.foreign) { this.foreign = false; this.release(ctx, { cancelled: false, waitIdle: true }); }
    });
    pi.on("session_compact_failed", (event, ctx) => {
      this.compacting = false;
      const attempt = this.attempt;
      if (attempt && !attempt.awaitingStart && !attempt.cancelledByUs) attempt.outcome = event.aborted ? "cancelled" : "failed";
      if (this.foreign) { this.foreign = false; this.release(ctx, { cancelled: event.aborted, waitIdle: true }); }
    });
    pi.on("agent_start", () => { this.internalAbort = false; });
    pi.on("turn_end", (event, ctx) => {
      this.measureUsage(ctx);
      const settings = this.hooks.settings();
      if (!settings.midRun || event.outcome !== "completed" || !event.toolResults.length) return undefined;
      if (this.attempt || this.compacting || this.releasing || !interactive(ctx)) return undefined;
      try {
        if (ctx.signal?.aborted || ctx.hasPendingMessages() || !this.hooks.canInterrupt()) return undefined;
      } catch { return undefined; }
      const check = this.check(pi, ctx, settings, true);
      if (check.compact) this.trigger(pi, ctx, check, true);
      return undefined;
    });
    pi.on("agent_settled", (event, ctx) => {
      if (event.aborted) return;
      this.scheduleIdleCheck(pi, ctx);
    });
  }

  /** After Pi's settled actions (queued prompts start first): compact while nothing runs. */
  private scheduleIdleCheck(pi: Api, ctx: ExtensionContext): void {
    const generation = this.generation;
    this.schedule(() => {
      if (generation !== this.generation || this.attempt || this.compacting || this.releasing) return;
      try {
        if (!interactive(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      } catch { return; }
      this.measureUsage(ctx);
      const check = this.check(pi, ctx, this.hooks.settings(), false);
      if (check.compact) this.trigger(pi, ctx, check, false);
    });
  }

  private check(pi: Api, ctx: ExtensionContext, settings: MainCompactionSettings, midRun: boolean): MainCompactionCheck {
    let piSettings: unknown;
    let usage: UsageLike | undefined;
    try {
      piSettings = pi.getSettings();
      usage = ctx.getContextUsage();
    } catch { return { compact: false, reason: "no_usage" }; }
    const piEnabled = (piSettings as { compaction?: { enabled?: unknown } } | undefined)?.compaction?.enabled !== false;
    const check = checkMainCompaction({
      settings, piEnabled, usage, ineffective: this.ineffective, blocked: this.blocked,
      ...(midRun ? { nativeReserve: piReserveTokens(piSettings, ctx.model) } : {}),
    });
    // Usage at or below the threshold re-arms the ratio after an ineffective compaction.
    if (!check.compact && check.reason === "below") this.ineffective = false;
    return check;
  }

  private measureUsage(ctx: ExtensionContext): void {
    if (!this.measure) return;
    let usage: UsageLike | undefined;
    try { usage = ctx.getContextUsage(); } catch { return; }
    if (!usage || usage.tokens === null) return;
    this.measure = false;
    const threshold = ratioThreshold(usage.contextWindow, this.hooks.settings().usageRatio);
    this.ineffective = threshold !== undefined && usage.tokens > threshold;
  }

  private trigger(pi: Api, ctx: ExtensionContext, check: Extract<MainCompactionCheck, { compact: true }>, resume: boolean): void {
    let marker: string | null | undefined;
    try { marker = ctx.sessionManager.getLeafId(); } catch { marker = undefined; }
    const attempt: Attempt = { generation: this.generation, resume, marker, awaitingStart: true, superseded: false, cancelledByUs: false, inputSeen: false };
    // Set before ctx.compact(): its abort runs Pi's handlers (agent_settled) before the compaction starts.
    this.attempt = attempt;
    if (resume) this.internalAbort = true;
    const ratio = Math.round(this.hooks.settings().usageRatio * 100);
    try {
      if (ctx.hasUI) ctx.ui.notify(`orche: main context is at ${Math.round(check.percent)}% of the window (${k(check.tokens)}/${k(check.contextWindow)} tokens), above mainCompaction ${ratio}%: compacting automatically.${resume ? " The running response stops here and continues after the summary." : ""}`, "info");
    } catch { /* the UI may be gone */ }
    // Called after Pi's compact() returned (its state is clear): release what was held, behind the continuation if any.
    const finish = (outcome: "done" | "failed") => {
      if (attempt.generation !== this.generation || this.attempt !== attempt) return;
      this.attempt = undefined;
      const result = attempt.cancelledByUs ? "superseded" : attempt.outcome === "cancelled" ? "cancelled" : outcome === "done" && attempt.outcome !== "failed" ? "done" : "failed";
      if (result === "done") this.measure = true;
      if (result === "cancelled" || result === "failed") this.blocked = true;
      // Never continue a run the user (or an extension) cancelled; an interrupted run continues after a summary, a superseded
      // attempt or a failed summary (Pi's own threshold and overflow recovery still guard the size).
      this.release(ctx, { ...(attempt.resume && result !== "cancelled" ? { resume: attempt } : {}), cancelled: result === "cancelled", waitIdle: false });
    };
    try {
      ctx.compact({ onComplete: () => finish("done"), onError: () => finish("failed") });
    } catch {
      this.attempt = undefined;
      if (resume) this.internalAbort = false;
      this.release(ctx, { cancelled: false, waitIdle: false });
    }
  }

  /**
   * After a compaction: the continuation note of an interrupted response (if any), then the held messages, once. A compaction
   * that started meanwhile releases them at its own end. `waitIdle`: Pi may still be finishing the compaction (another
   * initiator's), so wait until it is idle or a run is going on (Pi then queues the messages behind it).
   */
  private release(ctx: ExtensionContext, options: { resume?: Attempt; cancelled: boolean; waitIdle: boolean }): void {
    const generation = this.generation;
    // A continuation still pending from an earlier release that a newer compaction deferred goes with this one.
    if (options.resume) this.pendingResume = options.resume;
    this.releasing = true;
    const run = () => {
      if (generation !== this.generation) return;
      if (this.attempt || this.foreign) { this.releasing = false; return; }
      if (options.waitIdle) {
        let ready: boolean;
        try { ready = ctx.isIdle() || ctx.signal !== undefined; } catch { this.releasing = false; return; }
        if (!ready) { this.schedule(run, RELEASE_POLL_MS); return; }
      }
      this.releasing = false;
      const resume = this.pendingResume;
      this.pendingResume = undefined;
      if (resume) this.sendResume(ctx, resume);
      for (const item of this.held.splice(0)) {
        try { this.api?.sendMessage(item.message, options.cancelled ? { triggerTurn: false } : item.options); } catch { /* a stale session */ }
      }
    };
    this.schedule(run);
  }

  /** The hidden note that continues a response interrupted for compaction, unless the user's input or another run took over. */
  private sendResume(ctx: ExtensionContext, attempt: Attempt): void {
    if (attempt.generation !== this.generation || attempt.inputSeen) return;
    try {
      if (!interruptedSince(ctx, attempt.marker) || !ctx.isIdle()) return;
      this.api?.sendMessage({
        customType: MAIN_COMPACTION_RESUME_TYPE,
        content: "[orche] Main's context passed the mainCompaction limit, so the conversation was compacted automatically right after your last tool results; the summary above replaces the earlier turns. Continue the user's current task from where it stopped. Do not repeat tool calls whose results you already have.",
        display: false,
      }, { triggerTurn: true });
    } catch { /* a stale session: nothing to continue */ }
  }
}

/** Interactive TUI or RPC: modes where Pi stays alive after a run (print/json exit once their prompts are done). */
function interactive(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

/** Whether the branch has an aborted or failed response after `marker`: the abort really cut off the next request. */
function interruptedSince(ctx: Pick<ExtensionContext, "sessionManager">, marker: string | null | undefined): boolean {
  const branch = ctx.sessionManager.getBranch();
  const from = marker ? branch.findIndex(entry => entry.id === marker) : -1;
  if (marker && from < 0) return false;
  return branch.slice(from + 1).some(entry => {
    const message = (entry as { type?: string; message?: { role?: string; stopReason?: string } }).message;
    return entry.type === "message" && message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
  });
}
