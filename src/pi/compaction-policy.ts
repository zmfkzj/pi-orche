/**
 * When a worker session compacts (`workerCompaction` in orche.config.json; docs/compaction.md).
 *
 * The stable policy (`window-ratio`, the default and the behaviour before this option existed) compacts a single-workflow worker
 * once its context passes 50% of the model's window and keeps Pi's default 20k recent tokens. `usageRatio` replaces that 50% for
 * the workers it applies to (base value, per role, per model: the same precedence as `triggerTokens`), so each worker kind can
 * compact at its own share of ITS model's window; omitted, nothing changes. `absolute` is an EXPERIMENT for worker sessions only
 * (never the main session): compact once the context passes `triggerTokens` (per role or per model when configured), but never
 * later than the ratio trigger. It only changes Pi's own compaction settings (`reserveTokens` = window - trigger,
 * `keepRecentTokens`), so Pi's native compaction stays the one engine: no second compactor, no re-entrancy.
 *
 * A trigger below the stable 50% is EARLY, whether it comes from `triggerTokens` or from a `usageRatio` below 0.5.
 * Headroom: what a compaction leaves is the system prompt and tool schemas (an orche worker: roughly 7-10k tokens), Pi's summary,
 * orche's restored essentials and the `keepRecentTokens` kept verbatim, and the next response must fit after it. An early trigger
 * is therefore at least MIN_TRIGGER_TOKENS, `keepRecentTokens` is capped at half the trigger, and the session hooks
 * (session-factory.ts) refuse an early compaction that would not free enough (loop guard) and fall back to the non-early policy
 * (`fallback`, else the stable 50%) for the rest of the assignment. No trigger value is claimed optimal.
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

export type CompactionPolicy = "window-ratio" | "absolute";
export type EssentialsMode = "basic" | "extended";

export interface CompactionTarget {
  /** absolute: compact once the context exceeds this many tokens. */
  triggerTokens?: number;
  /** recent tokens kept verbatim (absolute or `usageRatio` trigger; default min(20000, trigger / 4) when early; at most trigger / 2). */
  keepRecentTokens?: number;
  /** Compact once the context exceeds this fraction of the model's window (WORKER_USAGE_RATIO_RANGE; replaces the stable 0.5). */
  usageRatio?: number;
}
export interface WorkerCompactionSettings extends CompactionTarget {
  policy: CompactionPolicy;
  /** Per role (implement, answer, explore, verify, sub-worker) overrides of the absolute trigger and the usage ratio. */
  roles?: Record<string, CompactionTarget>;
  /** Per model (`provider/id`, `*` wildcards; first match wins, before roles) overrides of the absolute trigger and the usage ratio. */
  models?: (CompactionTarget & { model: string })[];
  /**
   * What a worker gets back after compaction. `basic` (default): the verbatim assignment, its Task DAG and the task ledger.
   * `extended`: also main's messages of the assignment (verbatim, versioned), the tool-call work log and the validated reference
   * to the original transcript for selective re-reading (src/pi/compaction-state.ts).
   */
  essentials: EssentialsMode;
  /** orche_spawn standard sub-workers compact with this policy and get their own essentials (default false: compaction off). */
  subWorkers: boolean;
}

export const DEFAULT_WORKER_COMPACTION: Readonly<WorkerCompactionSettings> = Object.freeze({ policy: "window-ratio", essentials: "basic", subWorkers: false });
/** Smallest accepted absolute trigger: below it the fixed prompt, essentials and kept tokens leave no room for work. */
export const MIN_TRIGGER_TOKENS = 16_384;
export const MIN_KEEP_RECENT_TOKENS = 1_024;
/** Early (absolute-policy) compactions one assignment may run before it falls back to the stable policy. */
export const MAX_EARLY_COMPACTIONS = 40;
/** The stable trigger: half of the window. */
export const STABLE_TRIGGER_RATIO = 0.5;
/** Allowed `usageRatio` values (inclusive), the range of `mainCompaction.usageRatio`. */
export const WORKER_USAGE_RATIO_RANGE = { min: 0.1, max: 0.95 } as const;

/** Pi's compaction settings for a session plus what orche records about them. */
export interface ResolvedCompaction {
  enabled: true;
  reserveTokens: number;
  keepRecentTokens: number;
  policy: CompactionPolicy;
  triggerTokens: number;
  stableTriggerTokens: number;
  /** The trigger is earlier than the stable one (an experiment in effect). */
  early: boolean;
  /** The configured `usageRatio` this session resolved to (absent: the stable 0.5). */
  usageRatio?: number;
  /** What a refused early compaction falls back to when it is not the stable policy (a non-early `usageRatio`). */
  fallback?: ResolvedCompaction;
}

/** The stable settings (the behaviour before `workerCompaction`): 50% of the window, Pi's default recent tokens. */
export function stableCompaction(contextWindow: number): ResolvedCompaction {
  const reserveTokens = Math.floor(contextWindow * STABLE_TRIGGER_RATIO);
  const triggerTokens = contextWindow - reserveTokens;
  return { enabled: true, reserveTokens, keepRecentTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, contextWindow - reserveTokens), policy: "window-ratio", triggerTokens, stableTriggerTokens: triggerTokens, early: false };
}

const globMatch = (pattern: string, value: string): boolean => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);

/** The target of one session: the first matching model rule, else its role's, else the base values (field by field under the rule). */
export function targetFor(settings: WorkerCompactionSettings, model: string | undefined, role: string | undefined): CompactionTarget {
  const byModel = model ? settings.models?.find(rule => globMatch(rule.model, model)) : undefined;
  const byRole = role ? settings.roles?.[role] : undefined;
  const pick = byModel ?? byRole;
  return { ...(settings.triggerTokens !== undefined ? { triggerTokens: settings.triggerTokens } : {}), ...(settings.keepRecentTokens !== undefined ? { keepRecentTokens: settings.keepRecentTokens } : {}), ...(settings.usageRatio !== undefined ? { usageRatio: settings.usageRatio } : {}), ...pick };
}

/**
 * The tokens a `usageRatio` lets a worker hold: ceil(window × ratio), so 0.5 is exactly the stable trigger. A trigger below the
 * stable one is raised to MIN_TRIGGER_TOKENS (never above the stable trigger): the fixed prompt and the essentials need room.
 */
export function ratioTriggerTokens(contextWindow: number, usageRatio: number): number {
  const stable = stableCompaction(contextWindow).triggerTokens;
  const raw = Math.ceil(contextWindow * usageRatio - 1e-6);
  return raw < stable ? Math.min(stable, Math.max(raw, MIN_TRIGGER_TOKENS)) : raw;
}

/** Recent tokens kept by an early trigger: default min(20000, trigger / 4), at most trigger / 2, at least MIN_KEEP_RECENT_TOKENS. */
const earlyKeep = (keepRecentTokens: number | undefined, triggerTokens: number) =>
  Math.max(MIN_KEEP_RECENT_TOKENS, Math.min(keepRecentTokens ?? Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(triggerTokens / 4)), Math.floor(triggerTokens / 2)));

/** A non-early ratio trigger: Pi's default recent tokens as the stable policy keeps them, or the configured ones (at most trigger / 2). */
function lateRatio(contextWindow: number, triggerTokens: number, usageRatio: number, keepRecentTokens: number | undefined): ResolvedCompaction {
  const keep = keepRecentTokens === undefined ? Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, triggerTokens) : Math.max(MIN_KEEP_RECENT_TOKENS, Math.min(keepRecentTokens, Math.floor(triggerTokens / 2)));
  return { enabled: true, reserveTokens: contextWindow - triggerTokens, keepRecentTokens: keep, policy: "window-ratio", triggerTokens, stableTriggerTokens: stableCompaction(contextWindow).triggerTokens, early: false, usageRatio };
}

/**
 * Resolve the compaction settings of one worker session (`model`: `provider/id`; `role`: the assignment's role or `sub-worker`).
 * Without `usageRatio` and without an absolute trigger for this session: the stable policy, exactly as before the option existed.
 */
export function resolveCompaction(settings: WorkerCompactionSettings | undefined, input: { contextWindow: number; model?: string; role?: string }): ResolvedCompaction {
  const stable = stableCompaction(input.contextWindow);
  if (!settings) return stable;
  const target = targetFor(settings, input.model, input.role);
  const absolute = settings.policy === "absolute" ? target.triggerTokens : undefined;
  const ratio = target.usageRatio;
  if (absolute === undefined && ratio === undefined) return stable;
  const ratioTrigger = ratio === undefined ? stable.triggerTokens : ratioTriggerTokens(input.contextWindow, ratio);
  if (absolute === undefined) {
    if (ratioTrigger >= stable.triggerTokens) return lateRatio(input.contextWindow, ratioTrigger, ratio!, target.keepRecentTokens);
    return { enabled: true, reserveTokens: input.contextWindow - ratioTrigger, keepRecentTokens: earlyKeep(target.keepRecentTokens, ratioTrigger), policy: "window-ratio", triggerTokens: ratioTrigger, stableTriggerTokens: stable.triggerTokens, early: true, usageRatio: ratio! };
  }
  const triggerTokens = Math.min(absolute, ratioTrigger);
  // A refused early compaction falls back to the configured ratio when that one is not early itself, else to the stable 50%.
  const fallback = ratio !== undefined && ratioTrigger > stable.triggerTokens ? { fallback: lateRatio(input.contextWindow, ratioTrigger, ratio, undefined) } : {};
  return { enabled: true, reserveTokens: input.contextWindow - triggerTokens, keepRecentTokens: earlyKeep(target.keepRecentTokens, triggerTokens), policy: "absolute", triggerTokens, stableTriggerTokens: stable.stableTriggerTokens, early: triggerTokens < stable.stableTriggerTokens, ...(ratio !== undefined ? { usageRatio: ratio } : {}), ...fallback };
}

/** The part Pi's SettingsManager takes. */
export const piCompactionSettings = (resolved: ResolvedCompaction) => ({ enabled: true, reserveTokens: resolved.reserveTokens, keepRecentTokens: resolved.keepRecentTokens });

const isInt = (value: unknown, min: number, max = 10_000_000): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function parseUsageRatio(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < WORKER_USAGE_RATIO_RANGE.min || value > WORKER_USAGE_RATIO_RANGE.max)
    throw new Error(`${at}: expected a fraction of the context window from ${WORKER_USAGE_RATIO_RANGE.min} to ${WORKER_USAGE_RATIO_RANGE.max} (0.6 = compact above 60% used)`);
  return value;
}

function parseTarget(value: unknown, at: string): CompactionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}: expected an object`);
  const target = value as Record<string, unknown>;
  const unknown = Object.keys(target).filter(key => key !== "triggerTokens" && key !== "keepRecentTokens" && key !== "usageRatio" && key !== "model");
  if (unknown.length) throw new Error(`${at}: unknown field ${unknown.join(", ")}`);
  if (target.triggerTokens !== undefined && !isInt(target.triggerTokens, MIN_TRIGGER_TOKENS)) throw new Error(`${at}.triggerTokens: expected an integer from ${MIN_TRIGGER_TOKENS} to 10000000`);
  if (target.keepRecentTokens !== undefined && !isInt(target.keepRecentTokens, MIN_KEEP_RECENT_TOKENS)) throw new Error(`${at}.keepRecentTokens: expected an integer of at least ${MIN_KEEP_RECENT_TOKENS}`);
  if (typeof target.triggerTokens === "number" && typeof target.keepRecentTokens === "number" && target.keepRecentTokens > target.triggerTokens / 2)
    throw new Error(`${at}.keepRecentTokens: at most half of triggerTokens (the kept tokens, the prompt, the summary and the restored essentials must fit below the trigger)`);
  const usageRatio = target.usageRatio === undefined ? undefined : parseUsageRatio(target.usageRatio, `${at}.usageRatio`);
  return { ...(target.triggerTokens !== undefined ? { triggerTokens: target.triggerTokens as number } : {}), ...(target.keepRecentTokens !== undefined ? { keepRecentTokens: target.keepRecentTokens as number } : {}), ...(usageRatio !== undefined ? { usageRatio } : {}) };
}

const ROLES = new Set(["implement", "answer", "explore", "verify", "sub-worker"]);

/** Parse `workerCompaction`: `"window-ratio"`, a usage ratio (`0.6`: every worker's `usageRatio`) or an object; throws an Error with the offending path. */
export function parseWorkerCompaction(value: unknown): WorkerCompactionSettings {
  if (value === "window-ratio") return { ...DEFAULT_WORKER_COMPACTION };
  if (typeof value === "number") return { ...DEFAULT_WORKER_COMPACTION, usageRatio: parseUsageRatio(value, "config.workerCompaction") };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error('config.workerCompaction: expected "window-ratio", a usage ratio or an object');
  const settings = value as Record<string, unknown>;
  const known = new Set(["policy", "triggerTokens", "keepRecentTokens", "usageRatio", "roles", "models", "essentials", "subWorkers"]);
  const unknown = Object.keys(settings).filter(key => !known.has(key));
  if (unknown.length) throw new Error(`config.workerCompaction: unknown field ${unknown.join(", ")}`);
  const policy = settings.policy ?? "window-ratio";
  if (policy !== "window-ratio" && policy !== "absolute") throw new Error('config.workerCompaction.policy: expected "window-ratio" or "absolute"');
  const essentials = settings.essentials ?? "basic";
  if (essentials !== "basic" && essentials !== "extended") throw new Error('config.workerCompaction.essentials: expected "basic" or "extended"');
  if (settings.subWorkers !== undefined && typeof settings.subWorkers !== "boolean") throw new Error("config.workerCompaction.subWorkers: expected boolean");
  const base = parseTarget(Object.fromEntries(Object.entries(settings).filter(([key]) => key === "triggerTokens" || key === "keepRecentTokens" || key === "usageRatio")), "config.workerCompaction");
  let roles: Record<string, CompactionTarget> | undefined;
  if (settings.roles !== undefined) {
    if (!settings.roles || typeof settings.roles !== "object" || Array.isArray(settings.roles)) throw new Error("config.workerCompaction.roles: expected an object keyed by role");
    roles = {};
    for (const [role, target] of Object.entries(settings.roles)) {
      if (!ROLES.has(role)) throw new Error(`config.workerCompaction.roles.${role}: unknown role (expected ${[...ROLES].join(", ")})`);
      roles[role] = parseTarget(target, `config.workerCompaction.roles.${role}`);
    }
  }
  let models: WorkerCompactionSettings["models"];
  if (settings.models !== undefined) {
    if (!Array.isArray(settings.models)) throw new Error('config.workerCompaction.models: expected an array of { "model": "provider/id-glob", "triggerTokens"?: n, "usageRatio"?: r }');
    models = settings.models.map((entry, index) => {
      const at = `config.workerCompaction.models[${index}]`;
      const model = (entry as { model?: unknown } | null)?.model;
      if (typeof model !== "string" || !model.includes("/")) throw new Error(`${at}.model: expected "provider/model-id" (with * wildcards)`);
      return { model, ...parseTarget(entry, at) };
    });
  }
  if (policy === "absolute" && base.triggerTokens === undefined && !roles && !models) throw new Error("config.workerCompaction: policy absolute needs triggerTokens (or roles/models with triggerTokens)");
  return { policy, essentials, subWorkers: settings.subWorkers === true, ...base, ...(roles ? { roles } : {}), ...(models ? { models } : {}) };
}
