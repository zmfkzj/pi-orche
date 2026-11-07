/**
 * When a worker session compacts (`workerCompaction` in orche.config.json; docs/compaction.md).
 *
 * The stable policy (`window-ratio`, the default and the behaviour before this option existed) compacts a single-workflow worker
 * once its context passes 50% of the model's window and keeps Pi's default 20k recent tokens. `absolute` is an EXPERIMENT for
 * worker sessions only (never the main session): compact once the context passes `triggerTokens` (per role or per model when
 * configured), but never later than the stable trigger. It only changes Pi's own compaction settings (`reserveTokens` =
 * window - trigger, `keepRecentTokens`), so Pi's native compaction stays the one engine: no second compactor, no re-entrancy.
 *
 * Headroom: what a compaction leaves is the system prompt and tool schemas (an orche worker: roughly 7-10k tokens), Pi's summary,
 * orche's restored essentials and the `keepRecentTokens` kept verbatim, and the next response must fit after it. `keepRecentTokens`
 * is therefore capped at half the trigger, and the session hooks (session-factory.ts) refuse an early compaction that would not
 * free enough (loop guard) and fall back to the stable policy for the rest of the assignment. No trigger value is claimed optimal.
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

export type CompactionPolicy = "window-ratio" | "absolute";
export type EssentialsMode = "basic" | "extended";

export interface CompactionTarget {
  /** absolute: compact once the context exceeds this many tokens. */
  triggerTokens?: number;
  /** absolute: recent tokens kept verbatim (default min(20000, trigger / 4); at most trigger / 2). */
  keepRecentTokens?: number;
}
export interface WorkerCompactionSettings extends CompactionTarget {
  policy: CompactionPolicy;
  /** Per role (implement, answer, explore, verify, sub-worker) overrides of the absolute trigger. */
  roles?: Record<string, CompactionTarget>;
  /** Per model (`provider/id`, `*` wildcards; first match wins, before roles) overrides of the absolute trigger. */
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
}

/** The stable settings (the behaviour before `workerCompaction`): 50% of the window, Pi's default recent tokens. */
export function stableCompaction(contextWindow: number): ResolvedCompaction {
  const reserveTokens = Math.floor(contextWindow * STABLE_TRIGGER_RATIO);
  const triggerTokens = contextWindow - reserveTokens;
  return { enabled: true, reserveTokens, keepRecentTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, contextWindow - reserveTokens), policy: "window-ratio", triggerTokens, stableTriggerTokens: triggerTokens, early: false };
}

const globMatch = (pattern: string, value: string): boolean => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);

/** The absolute target of one session: the first matching model rule, else its role's, else the base values. */
export function targetFor(settings: WorkerCompactionSettings, model: string | undefined, role: string | undefined): CompactionTarget {
  const byModel = model ? settings.models?.find(rule => globMatch(rule.model, model)) : undefined;
  const byRole = role ? settings.roles?.[role] : undefined;
  const pick = byModel ?? byRole;
  return { ...(settings.triggerTokens !== undefined ? { triggerTokens: settings.triggerTokens } : {}), ...(settings.keepRecentTokens !== undefined ? { keepRecentTokens: settings.keepRecentTokens } : {}), ...pick };
}

/** Resolve the compaction settings of one worker session (`model`: `provider/id`; `role`: the assignment's role or `sub-worker`). */
export function resolveCompaction(settings: WorkerCompactionSettings | undefined, input: { contextWindow: number; model?: string; role?: string }): ResolvedCompaction {
  const stable = stableCompaction(input.contextWindow);
  if (!settings || settings.policy !== "absolute") return stable;
  const target = targetFor(settings, input.model, input.role);
  if (target.triggerTokens === undefined) return stable;
  const triggerTokens = Math.min(target.triggerTokens, stable.stableTriggerTokens);
  const keepRecentTokens = Math.max(MIN_KEEP_RECENT_TOKENS, Math.min(target.keepRecentTokens ?? Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(triggerTokens / 4)), Math.floor(triggerTokens / 2)));
  return { enabled: true, reserveTokens: input.contextWindow - triggerTokens, keepRecentTokens, policy: "absolute", triggerTokens, stableTriggerTokens: stable.stableTriggerTokens, early: triggerTokens < stable.stableTriggerTokens };
}

/** The part Pi's SettingsManager takes. */
export const piCompactionSettings = (resolved: ResolvedCompaction) => ({ enabled: true, reserveTokens: resolved.reserveTokens, keepRecentTokens: resolved.keepRecentTokens });

const isInt = (value: unknown, min: number, max = 10_000_000): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function parseTarget(value: unknown, at: string): CompactionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}: expected an object`);
  const target = value as Record<string, unknown>;
  const unknown = Object.keys(target).filter(key => key !== "triggerTokens" && key !== "keepRecentTokens" && key !== "model");
  if (unknown.length) throw new Error(`${at}: unknown field ${unknown.join(", ")}`);
  if (target.triggerTokens !== undefined && !isInt(target.triggerTokens, MIN_TRIGGER_TOKENS)) throw new Error(`${at}.triggerTokens: expected an integer from ${MIN_TRIGGER_TOKENS} to 10000000`);
  if (target.keepRecentTokens !== undefined && !isInt(target.keepRecentTokens, MIN_KEEP_RECENT_TOKENS)) throw new Error(`${at}.keepRecentTokens: expected an integer of at least ${MIN_KEEP_RECENT_TOKENS}`);
  if (typeof target.triggerTokens === "number" && typeof target.keepRecentTokens === "number" && target.keepRecentTokens > target.triggerTokens / 2)
    throw new Error(`${at}.keepRecentTokens: at most half of triggerTokens (the kept tokens, the prompt, the summary and the restored essentials must fit below the trigger)`);
  return { ...(target.triggerTokens !== undefined ? { triggerTokens: target.triggerTokens as number } : {}), ...(target.keepRecentTokens !== undefined ? { keepRecentTokens: target.keepRecentTokens as number } : {}) };
}

const ROLES = new Set(["implement", "answer", "explore", "verify", "sub-worker"]);

/** Parse `workerCompaction`; throws an Error with the offending path. */
export function parseWorkerCompaction(value: unknown): WorkerCompactionSettings {
  if (value === "window-ratio") return { ...DEFAULT_WORKER_COMPACTION };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error('config.workerCompaction: expected "window-ratio" or an object');
  const settings = value as Record<string, unknown>;
  const known = new Set(["policy", "triggerTokens", "keepRecentTokens", "roles", "models", "essentials", "subWorkers"]);
  const unknown = Object.keys(settings).filter(key => !known.has(key));
  if (unknown.length) throw new Error(`config.workerCompaction: unknown field ${unknown.join(", ")}`);
  const policy = settings.policy ?? "window-ratio";
  if (policy !== "window-ratio" && policy !== "absolute") throw new Error('config.workerCompaction.policy: expected "window-ratio" or "absolute"');
  const essentials = settings.essentials ?? "basic";
  if (essentials !== "basic" && essentials !== "extended") throw new Error('config.workerCompaction.essentials: expected "basic" or "extended"');
  if (settings.subWorkers !== undefined && typeof settings.subWorkers !== "boolean") throw new Error("config.workerCompaction.subWorkers: expected boolean");
  const base = parseTarget(Object.fromEntries(Object.entries(settings).filter(([key]) => key === "triggerTokens" || key === "keepRecentTokens")), "config.workerCompaction");
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
    if (!Array.isArray(settings.models)) throw new Error('config.workerCompaction.models: expected an array of { "model": "provider/id-glob", "triggerTokens": n }');
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
