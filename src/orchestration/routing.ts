import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseRunLimits, RunLimitsError, type RunLimits } from "./limits.js";

/**
 * Main-session delegation: single hands work to one orche_task worker, direct edits locally; ultra is the quality-first flow
 * (src/orchestrator/ultra.ts) and mdsd the single workflow with the MDSD search policy (src/orchestrator/mdsd.ts, docs/mdsd.md).
 * No mode selects models: every delegating mode runs on the selected model PROFILE (`--profile`, docs/orchestrator.md 12/14),
 * `default` (the top-level `models` tiers) unless one is selected. The former `strong` mode (single on the strong tiers) was
 * merged into single: it is read as single with the profile `strong` ({@link LEGACY_STRONG_MODE}).
 */
export const MAIN_MODES = ["single", "ultra", "mdsd", "direct"] as const;
export type MainMode = (typeof MAIN_MODES)[number];
/** The modes in which main delegates every change to one orche_task worker (the single workflow and its variants). */
export type DelegatingMode = Exclude<MainMode, "direct">;
export const isDelegatingMode = (mode: unknown): mode is DelegatingMode => mode === "single" || mode === "ultra" || mode === "mdsd";
/** Removed modes (multi-agent orche_run delegation): still accepted in config and session history, read as `single`. */
export const LEGACY_MAIN_MODES = ["auto", "multi"] as const;
export type LegacyMainMode = (typeof LEGACY_MAIN_MODES)[number] | typeof LEGACY_STRONG_MODE;
/**
 * The merged `strong` mode: in config (`mainMode`), session history, task ledgers and `/orche strong|mode strong` it is read as
 * `single` with the profile `strong` when the config defines one (also from the legacy `models.strong-*` tiers), else `default`.
 */
export const LEGACY_STRONG_MODE = "strong";
/** Single by default: the main delegates each task to one orche_task worker; switch with /orche mode or `mainMode`. */
export const DEFAULT_MAIN_MODE: MainMode = "single";
export interface ModelRoute { role: string; model: string; thinking?: ThinkingLevel; extendedContext?: boolean }
export interface RouteSettings { readonly model: string; readonly thinking?: ThinkingLevel; readonly extendedContext?: boolean }
export interface ImageSettings { readonly model: string; readonly timeoutMs?: number }
export interface RouteConfig {
  readonly routes: Readonly<Record<string, RouteSettings>>;
  readonly default?: RouteSettings;
  /** Pi package sources (installed at user scope) whose extensions register model providers for orche's own runtime. */
  readonly providerExtensions?: readonly string[];
  /** Raster generation for game-asset/video tasks; the provider must be loaded into orche's runtime. */
  readonly images?: ImageSettings;
  /** Default for routes that do not say: use the curated maximum context window of models that have one (see src/pi/extended-context.ts). */
  readonly extendedContext?: boolean;
  /** Shell commands the verifier must run (e.g. ["npm test"]); without them it discovers the project's own checks. */
  readonly verifyCommands?: readonly string[];
  /** `workers.explorerRoles[0]`: the route role of orche_task explore workers (default `explorer-path`). */
  readonly workers?: { readonly explorerRoles?: readonly string[] };
  /**
   * Models of the tiers (docs/orchestrator.md 12), each a route without a role: `main` is applied to the Pi session at its
   * start, `orchestrator` replaces main's model for the single workflow's standard-role workers, `worker` replaces the
   * orchestrator's model for its sub-workers, `advisor` is the model of the plan advisor (`single.advisor`, docs/orchestrator.md 13).
   * Unset tiers inherit (main: Pi's model; orchestrator: main; worker and advisor: the orchestrator).
   * `{ "model": "main" }` (INHERIT_MAIN) in `orchestrator`, `worker` or `advisor` names main's current model explicitly.
   * Specialists (game-asset, video) keep their routes.
   */
  readonly models?: ModelTiers;
  /** Behavior of the main session in the Pi package. Default `single`. */
  readonly mainMode?: MainMode;
  /** A removed mode (`auto`/`multi`, or the merged `strong`) found in the file; it is read as `single` and the Pi package warns about it. */
  readonly legacyMainMode?: LegacyMainMode;
  /**
   * Named model profiles (`profiles` in orche.config.json, docs/orchestrator.md 12): each overrides the orchestrator, worker and
   * advisor tiers and the routes for the requests that select it with `--profile`. `default` is not in this map: it is the
   * top-level `models` and `routes`. A null-prototype map; look names up with {@link findProfile}.
   */
  readonly profiles?: Readonly<Record<string, ModelProfile>>;
  /** Run caps in milliseconds and worker request/repair budgets; explicit values only. */
  readonly limits?: Partial<RunLimits>;
}
/**
 * Keys of the removed multi-worker coordinator (`orche_run`, advisors; docs/orchestrator.md): a config that still has them loads,
 * the keys are ignored and reported as warnings.
 */
export const LEGACY_CONFIG_KEYS: readonly string[] = ["advisors", "audit"];
export const LEGACY_WORKERS_KEYS: readonly string[] = ["maxWorkers", "answerAngles"];
export function legacyConfigWarning(keys: readonly string[]): string {
  return `config.${keys.length === 1 ? keys[0] : `{${keys.join(", ")}}`} ${keys.length === 1 ? "was" : "were"} removed with the multi-worker coordinator and ${keys.length === 1 ? "is" : "are"} ignored${keys.includes("advisors") ? ' (the plan advisor of worker runs is now "single": { "advisor": true } with models.advisor)' : ""}${keys.includes("workers.maxWorkers") ? ' (the cap on sub-workers an orchestrator runs at the same time is now "single": { "maxSubWorkers": 2-8 }, default 4; workers.maxWorkers is not carried over)' : ""}`;
}
export const MODEL_TIERS = ["main", "orchestrator", "worker", "advisor"] as const;
export type ModelTier = typeof MODEL_TIERS[number];
/** The tiers a profile may set: every orche_task tier except `main` (the Pi session's own model, applied at session start). */
export const PROFILE_TIERS = ["orchestrator", "worker", "advisor"] as const;
export type ProfileTier = typeof PROFILE_TIERS[number];
/**
 * The former strong tiers (kebab-case and camelCase; one spelling per tier). They still load: they become the profile `strong`
 * ({@link LEGACY_STRONG_PROFILE}), with a warning, unless `profiles.strong` is defined too (a config error).
 */
export const LEGACY_STRONG_TIERS: Readonly<Record<string, ProfileTier>> = { "strong-orchestrator": "orchestrator", "strong-worker": "worker", "strong-advisor": "advisor" };
export const MODEL_TIER_ALIASES: Readonly<Record<string, string>> = { strongOrchestrator: "strong-orchestrator", strongWorker: "strong-worker", strongAdvisor: "strong-advisor" };
/** The profile name the legacy strong tiers, `mainMode: "strong"` and `/orche strong` map to. */
export const LEGACY_STRONG_PROFILE = "strong";
/** A tier of `orchestrator`, `worker` or `advisor`: a route whose model and whose thinking may each be INHERIT_MAIN. */
export interface TierSettings { readonly model: string; readonly thinking?: ThinkingLevel | typeof INHERIT_MAIN; readonly extendedContext?: boolean }
/** `main` is a plain route (the Pi session's own model); the other tiers may name main's model or thinking. */
export interface ModelTiers {
  readonly main?: RouteSettings; readonly orchestrator?: TierSettings; readonly worker?: TierSettings; readonly advisor?: TierSettings;
}
/** The profile every request uses unless `--profile` names another: the top-level `models` and `routes` as they are. */
export const DEFAULT_PROFILE = "default";
/** A profile name: letters (any script), digits, `_`, then also `.` and `-`; at most 64 characters, no whitespace or `=`. */
export const PROFILE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u;
export const isProfileName = (value: unknown): value is string => typeof value === "string" && PROFILE_NAME.test(value);
/**
 * One named profile (`profiles.<name>`): `orchestrator`, `worker` and `advisor` replace the top-level tier of the same name for the
 * requests that select it (each a tier as in `models`, `"main"` included); `null` drops the top-level tier, so that tier inherits
 * as if `models` left it unset (worker and advisor: the orchestrator; orchestrator: main). It does not switch the advisor on or
 * off (that stays `single.advisor`). `routes` replace the top-level routes of the roles they name (specialists and route-based
 * workers). Unset keys keep the top-level value. `legacy`: built from the former `models.strong-*` tiers.
 */
export interface ModelProfile {
  readonly orchestrator?: TierSettings | null; readonly worker?: TierSettings | null; readonly advisor?: TierSettings | null;
  readonly routes?: Readonly<Record<string, RouteSettings>>;
  readonly legacy?: boolean;
}
/** One configured tier a role may run on, in order of preference; `key` names where it is configured (`models.orchestrator`, `profiles.fast.worker`). */
export interface TierCandidate { readonly key: string; readonly tier: TierSettings }
/** The tiers of the selected profile: orchestrator and advisor candidates in order of preference, the sub-workers' tier. */
export interface ProfileTiers {
  readonly profile: string;
  readonly orchestrators: TierCandidate[];
  /** The sub-workers' tier; absent: they inherit the orchestrator. Only one candidate (unresolvable: the orchestrator's model). */
  readonly worker?: TierCandidate;
  readonly advisors: TierCandidate[];
}
/** The profile `name` of the config, when defined (own key of a null-prototype map: `constructor`, `__proto__` are names like any other). */
export function findProfile(profiles: RouteConfig["profiles"], name: string): ModelProfile | undefined {
  return profiles && Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}
/** Every profile a request may select: `default` first, then the config's in file order. */
export function profileNames(profiles: RouteConfig["profiles"]): string[] {
  return [DEFAULT_PROFILE, ...Object.keys(profiles ?? {})];
}
export class UnknownProfileError extends Error {
  override readonly name = "UnknownProfileError";
  constructor(readonly profile: string, readonly known: readonly string[], where?: string) {
    super(`Unknown profile "${profile}"${where ? ` (${where})` : ""}: orche.config.json defines ${known.map(name => `"${name}"`).join(", ")} ("default" is the top-level models). Define it under "profiles" or select another with --profile <name>.`);
  }
}
/**
 * The tiers of profile `name` (docs/orchestrator.md 12). Precedence, highest first: the profile's own tier, the top-level `models`
 * tier, then inheritance (orchestrator: main; worker and advisor: the orchestrator). Orchestrator and advisor try the profile tier
 * and then the top-level one (an unset or unresolvable profile tier falls back to it); a profile's `null` drops the top-level tier.
 * The worker has one candidate: the profile's when it names one (`null`: none), else `models.worker`; an unresolvable one inherits
 * the orchestrator. `default` is the top-level tiers alone. Unknown names throw {@link UnknownProfileError}.
 */
export function profileTiers(models: ModelTiers | undefined, profiles: RouteConfig["profiles"], name: string = DEFAULT_PROFILE): ProfileTiers {
  const profile = name === DEFAULT_PROFILE ? undefined : findProfile(profiles, name);
  if (name !== DEFAULT_PROFILE && !profile) throw new UnknownProfileError(name, profileNames(profiles));
  const candidates = (tier: ProfileTier): TierCandidate[] => {
    const own = profile && Object.hasOwn(profile, tier) ? profile[tier] : undefined;
    const dropped = own === null;
    return [
      ...(own ? [{ key: `profiles.${name}.${tier}`, tier: own }] : []),
      ...(!dropped && models?.[tier] ? [{ key: `models.${tier}`, tier: models[tier]! }] : []),
    ];
  };
  const worker = candidates("worker")[0];
  return { profile: name, orchestrators: candidates("orchestrator"), ...(worker ? { worker } : {}), advisors: candidates("advisor") };
}
/**
 * The route config a request of profile `name` runs on: the profile's `routes` over the top-level ones (one role at a time), and
 * its tiers ({@link profileTiers}). `default` returns the config unchanged. Unknown names throw {@link UnknownProfileError}.
 */
export function applyProfile(config: RouteConfig, name: string = DEFAULT_PROFILE): { config: RouteConfig; tiers: ProfileTiers } {
  const tiers = profileTiers(config.models, config.profiles, name);
  const routes = findProfile(config.profiles, name)?.routes;
  if (!routes || !Object.keys(routes).length) return { config, tiers };
  return { config: { ...config, routes: Object.assign(Object.create(null), config.routes, routes) as Record<string, RouteSettings> }, tiers };
}
/**
 * `{ "model": "main" }` in `models.orchestrator` or `models.worker`: run on main's current model and, unless the tier sets
 * `thinking`, main's current thinking, at each hand-off (what an unset `models.orchestrator` does). A model id is always
 * `provider/id`, so `main` cannot name a real model; `models.main` and routes reject it.
 * `{ "model": "provider/id", "thinking": "main" }` in the same tiers: that model with main's CURRENT thinking at each hand-off
 * (orchestrator) or spawn (worker), clamped to what the model supports as Pi clamps any level; `models.main`, routes and
 * `default` reject `thinking: "main"`.
 */
export const INHERIT_MAIN = "main";
export const inheritsMain = (route: TierSettings | undefined): boolean => route?.model === INHERIT_MAIN;
/** The tier takes main's current thinking by name: `thinking: "main"`, or `model: "main"` without a thinking of its own. */
export const inheritsMainThinking = (route: TierSettings | undefined): boolean => route?.thinking === INHERIT_MAIN || inheritsMain(route) && route?.thinking === undefined;
/** The tier's own thinking level, when it sets one (not `"main"`). */
export const tierThinking = (route: TierSettings | undefined): ThinkingLevel | undefined => route?.thinking === INHERIT_MAIN ? undefined : route?.thinking;
/**
 * Where an orche_task assignment's model comes from (details, run.json, split log): its `models` tier's model (`config`), main's
 * model named by the tier with `"main"` (`config:main`) or inherited because the tier is unset (`main`), or a route (`route`).
 */
export type AssignmentModelSource = "config" | "config:main" | "main" | "route";
/**
 * Where its thinking level comes from, in the same terms: the tier's own level (`config`), main's current thinking named by the
 * tier (`config:main`: `thinking: "main"`, or `model: "main"` without a level), main's thinking inherited because the tier does
 * not say (`main`), or a route or the reused worker's own (`route`); `effort`: a one-shot request's `--effort`, which replaces all
 * of these for that request's assignments. The level recorded next to it is the one the session runs on, after Pi clamped it to the model.
 */
export type AssignmentThinkingSource = AssignmentModelSource | "effort";
/** Where a sub-worker's model comes from: `models.worker`'s model (`config`), main's model named by it with `"main"`
 * (`config:main`), the orchestrator's model because it is unset (`orchestrator`), or a specialist's route (`route`). */
export type SubWorkerModelSource = "config" | "config:main" | "orchestrator" | "route";
/** Where a sub-worker's thinking comes from: `models.worker`'s own level (`config`), main's current thinking named by it
 * (`config:main`), the orchestrator's assignment level (`orchestrator`), one supported level below it for a standard sub-worker
 * under the phase thinking policy (`orchestrator:step`, docs/thinking-policy.md), or a specialist's route (`route`). */
export type SubWorkerThinkingSource = SubWorkerModelSource | "orchestrator:step";
export class RouteConfigError extends Error {
  override readonly name = "RouteConfigError";
}
const thinkingLevels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_PROVIDER_EXTENSIONS = 4;
const MAX_VERIFY_COMMANDS = 8;
/** The former MAX_WORKERS_LIMIT bound of `workers.explorerRoles`. */
const MAX_EXPLORER_ROLES = 8;
/** `"main"` outside the inheriting tiers (routes, default, models.main): nothing to inherit from there. */
const INHERITING_TIERS = "models.orchestrator, models.worker, models.advisor and the same tiers of profiles.<name>";
const thinkingMainError = (location: string) => new RouteConfigError(`${location}.thinking: "main" (inherit main's thinking) is for ${INHERITING_TIERS}; expected ${thinkingLevels.join(", ")}`);
function parseThinking(value: unknown, location: string): ThinkingLevel | undefined {
  if (value === INHERIT_MAIN) throw thinkingMainError(location);
  if (value !== undefined && (typeof value !== "string" || !thinkingLevels.includes(value)))
    throw new RouteConfigError(`${location}.thinking: expected ${thinkingLevels.join(", ")}`);
  return value as ThinkingLevel | undefined;
}
/** One route object `{ model: "provider/id", thinking?, extendedContext? }` (routes, `default`, `models.main`, mdsd.replication.models). */
export function parseSettings(value: unknown, location: string): RouteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError(`${location}: expected route object`);
  const route = value as Record<string, unknown>;
  if (Object.keys(route).some(key => key !== "model" && key !== "thinking" && key !== "extendedContext")) throw new RouteConfigError(`${location}: unknown route field`);
  if (typeof route.model !== "string" || !/^[^\s/:]+\/[^\s:]+$/.test(route.model)) throw new RouteConfigError(`${location}.model: expected provider/modelId`);
  parseThinking(route.thinking, location);
  if (route.extendedContext !== undefined && typeof route.extendedContext !== "boolean") throw new RouteConfigError(`${location}.extendedContext: expected boolean`);
  return {
    model: route.model,
    ...(route.thinking !== undefined ? { thinking: route.thinking as ThinkingLevel } : {}),
    ...(route.extendedContext !== undefined ? { extendedContext: route.extendedContext } : {}),
  };
}
/** Parse a route config; keys of the removed coordinator are ignored and reported in `warnings` (when given). */
export function parseRouteConfig(value: unknown, warnings?: string[]): RouteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config: expected object");
  const config = value as Record<string, unknown>;
  const legacy = Object.keys(config).filter(key => LEGACY_CONFIG_KEYS.includes(key));
  if (Object.keys(config).some(key => !LEGACY_CONFIG_KEYS.includes(key) && key !== "routes" && key !== "default" && key !== "providerExtensions" && key !== "extendedContext" && key !== "verifyCommands" && key !== "mainMode" && key !== "workers" && key !== "limits" && key !== "images" && key !== "models" && key !== "profiles")) throw new RouteConfigError("config: unknown field");
  let limits: Partial<RunLimits> | undefined;
  if (config.limits !== undefined) {
    try { limits = parseRunLimits(config.limits, "config.limits"); }
    catch (error) { throw error instanceof RunLimitsError ? new RouteConfigError(error.message) : error; }
  }
  if (config.extendedContext !== undefined && typeof config.extendedContext !== "boolean") throw new RouteConfigError("config.extendedContext: expected boolean");
  if (!config.routes || typeof config.routes !== "object" || Array.isArray(config.routes)) throw new RouteConfigError("config.routes: expected object");
  const routes: Record<string, RouteSettings> = Object.create(null) as Record<string, RouteSettings>;
  for (const [role, settings] of Object.entries(config.routes)) {
    if (!role.trim() || role !== role.trim()) throw new RouteConfigError("config.routes: role must be nonempty without surrounding whitespace");
    routes[role] = parseSettings(settings, `config.routes.${role}`);
  }
  let providerExtensions: string[] | undefined;
  if (config.providerExtensions !== undefined) {
    const list = config.providerExtensions;
    if (!Array.isArray(list) || !list.length || list.length > MAX_PROVIDER_EXTENSIONS) throw new RouteConfigError(`config.providerExtensions: expected 1-${MAX_PROVIDER_EXTENSIONS} package sources`);
    providerExtensions = list.map((source, index) => {
      if (typeof source !== "string" || !source.trim() || source !== source.trim()) throw new RouteConfigError(`config.providerExtensions[${index}]: expected a non-empty Pi package source such as "npm:@scope/package"`);
      return source;
    });
    if (new Set(providerExtensions).size !== providerExtensions.length) throw new RouteConfigError("config.providerExtensions: duplicate source");
  }
  const legacyMainMode = typeof config.mainMode === "string" && ((LEGACY_MAIN_MODES as readonly string[]).includes(config.mainMode) || config.mainMode === LEGACY_STRONG_MODE) ? config.mainMode as LegacyMainMode : undefined;
  if (config.mainMode !== undefined && !legacyMainMode && !MAIN_MODES.includes(config.mainMode as MainMode)) throw new RouteConfigError(`config.mainMode: expected ${MAIN_MODES.join(", ")}`);
  let verifyCommands: string[] | undefined;
  if (config.verifyCommands !== undefined) {
    const list = config.verifyCommands;
    if (!Array.isArray(list) || !list.length || list.length > MAX_VERIFY_COMMANDS) throw new RouteConfigError(`config.verifyCommands: expected 1-${MAX_VERIFY_COMMANDS} shell commands`);
    verifyCommands = list.map((command, index) => {
      if (typeof command !== "string" || !command.trim()) throw new RouteConfigError(`config.verifyCommands[${index}]: expected a non-empty shell command`);
      return command.trim();
    });
  }
  const workers = config.workers !== undefined ? parseWorkers(config.workers, legacy) : undefined;
  if (legacy.length) warnings?.push(legacyConfigWarning(legacy));
  const models = config.models !== undefined ? parseModelTiers(config.models) : undefined;
  const profiles = config.profiles !== undefined ? parseProfiles(config.profiles) : undefined;
  // The former strong tiers become the profile `strong` (strong mode was merged into single; docs/orchestrator.md 12).
  if (models?.strong) {
    if (profiles && Object.hasOwn(profiles, LEGACY_STRONG_PROFILE)) throw new RouteConfigError(`config.models.{${models.strongKeys.join(", ")}} and config.profiles.${LEGACY_STRONG_PROFILE} both define the profile "${LEGACY_STRONG_PROFILE}"; move the strong tiers into profiles.${LEGACY_STRONG_PROFILE} (orchestrator, worker, advisor)`);
    warnings?.push(`config.models.{${models.strongKeys.join(", ")}}: strong mode was merged into single; these tiers are read as the profile "${LEGACY_STRONG_PROFILE}" (profiles.${LEGACY_STRONG_PROFILE}), selected with --profile ${LEGACY_STRONG_PROFILE} (e.g. /orche single --profile ${LEGACY_STRONG_PROFILE} <PROMPT>; ultra and mdsd no longer pick them by themselves). Move them into "profiles": { "${LEGACY_STRONG_PROFILE}": { … } }.`);
  }
  const allProfiles = models?.strong ? Object.assign(Object.create(null), { [LEGACY_STRONG_PROFILE]: models.strong }, profiles) as Record<string, ModelProfile> : profiles;
  if (legacyMainMode === LEGACY_STRONG_MODE) warnings?.push(`config.mainMode "strong" was merged into "single": read as single with the profile "${allProfiles && Object.hasOwn(allProfiles, LEGACY_STRONG_PROFILE) ? LEGACY_STRONG_PROFILE : DEFAULT_PROFILE}"${allProfiles && Object.hasOwn(allProfiles, LEGACY_STRONG_PROFILE) ? "" : " (no profile strong is defined)"}; set mainMode to "single" and select a profile with /orche mode single --profile <name>.`);
  return {
    routes,
    ...(limits !== undefined ? { limits } : {}),
    ...(config.default !== undefined ? { default: parseSettings(config.default, "config.default") } : {}),
    ...(providerExtensions ? { providerExtensions } : {}),
    ...(config.images !== undefined ? { images: parseImages(config.images) } : {}),
    ...(config.extendedContext !== undefined ? { extendedContext: config.extendedContext } : {}),
    ...(verifyCommands ? { verifyCommands } : {}),
    ...(workers?.explorerRoles ? { workers } : {}),
    ...(models ? { models: models.tiers } : {}),
    ...(allProfiles ? { profiles: allProfiles } : {}),
    ...(legacyMainMode ? { mainMode: "single" as const, legacyMainMode } : config.mainMode !== undefined ? { mainMode: config.mainMode as MainMode } : {}),
  };
}
function parseImages(value: unknown): ImageSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.images: expected object");
  const images = value as Record<string, unknown>;
  if (Object.keys(images).some(key => key !== "model" && key !== "timeoutMs")) throw new RouteConfigError("config.images: unknown field");
  if (typeof images.model !== "string" || !/^[^\s/:]+\/[^\s:]+$/.test(images.model)) throw new RouteConfigError("config.images.model: expected provider/modelId");
  if (images.timeoutMs !== undefined && (typeof images.timeoutMs !== "number" || !Number.isFinite(images.timeoutMs) || images.timeoutMs <= 0)) throw new RouteConfigError("config.images.timeoutMs: expected a positive finite number");
  return { model: images.model, ...(images.timeoutMs !== undefined ? { timeoutMs: images.timeoutMs as number } : {}) };
}

/**
 * `models`: `main`, `orchestrator`, `worker` and `advisor`, each `{model, thinking?, extendedContext?}` validated like a route. The
 * former `strong-orchestrator`, `strong-worker` and `strong-advisor` (or `strongOrchestrator`, `strongWorker`, `strongAdvisor`)
 * still load as the profile `strong`: its orchestrator and advisor (unset: the top-level tier, as before), and its worker (unset:
 * `null`, so the sub-workers inherit the strong orchestrator as before, never `models.worker`).
 */
function parseModelTiers(value: unknown): { tiers: ModelTiers; strong?: ModelProfile; strongKeys: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.models: expected object");
  const tiers = value as Record<string, unknown>;
  const unknown = Object.keys(tiers).find(key => !(MODEL_TIERS as readonly string[]).includes(key) && !Object.hasOwn(LEGACY_STRONG_TIERS, key) && !Object.hasOwn(MODEL_TIER_ALIASES, key));
  if (unknown !== undefined) throw new RouteConfigError(`config.models.${unknown}: unknown tier (expected ${MODEL_TIERS.join(", ")}; other models go into a profile: "profiles": { "<name>": { "orchestrator": …, "worker": …, "advisor": … } })`);
  const parsed: { -readonly [T in ModelTier]?: ModelTiers[T] } = {};
  for (const tier of MODEL_TIERS) {
    const raw = tiers[tier];
    if (raw !== undefined) (parsed as Record<ModelTier, TierSettings>)[tier] = parseTier(tier === "main", raw, `config.models.${tier}`);
  }
  const strong: { -readonly [T in ProfileTier]?: TierSettings | null } = {};
  const strongKeys: string[] = [];
  for (const [key, tier] of Object.entries(LEGACY_STRONG_TIERS)) {
    const alias = Object.keys(MODEL_TIER_ALIASES).find(name => MODEL_TIER_ALIASES[name] === key);
    if (alias && tiers[alias] !== undefined && tiers[key] !== undefined) throw new RouteConfigError(`config.models: "${key}" and "${alias}" name the same tier; keep one`);
    const name = tiers[key] !== undefined ? key : alias && tiers[alias] !== undefined ? alias : undefined;
    if (!name) continue;
    strongKeys.push(name);
    strong[tier] = parseTier(false, tiers[name], `config.models.${name}`);
  }
  if (!strongKeys.length) return { tiers: parsed, strongKeys };
  return { tiers: parsed, strong: { ...strong, ...(strong.worker === undefined ? { worker: null } : {}), legacy: true }, strongKeys };
}
/**
 * `profiles`: named model profiles, as many as needed. Each `{ orchestrator?, worker?, advisor?, routes? }`: tiers as in `models`
 * (`"main"` included) or `null` (drop the top-level tier), routes as the top-level `routes`. `default` is reserved: it is the
 * top-level `models` and `routes`. Names: {@link PROFILE_NAME}.
 */
function parseProfiles(value: unknown): Record<string, ModelProfile> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.profiles: expected object");
  const profiles = Object.create(null) as Record<string, ModelProfile>;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const location = `config.profiles.${name}`;
    if (name === DEFAULT_PROFILE) throw new RouteConfigError(`${location}: "default" is reserved: the default profile is the top-level "models" and "routes"; change those, or give this profile another name`);
    if (!isProfileName(name)) throw new RouteConfigError(`${location}: invalid profile name (expected letters, digits or _, then also . or -, at most 64 characters, no whitespace)`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RouteConfigError(`${location}: expected object with orchestrator, worker, advisor and/or routes`);
    const profile = raw as Record<string, unknown>;
    const unknown = Object.keys(profile).find(key => !(PROFILE_TIERS as readonly string[]).includes(key) && key !== "routes");
    if (unknown !== undefined) throw new RouteConfigError(`${location}.${unknown}: unknown field (expected ${PROFILE_TIERS.join(", ")}, routes${unknown === "main" ? "; models.main is the Pi session's own model and is not part of a profile" : ""})`);
    const parsed: { -readonly [K in keyof ModelProfile]?: ModelProfile[K] } = {};
    for (const tier of PROFILE_TIERS) {
      if (!Object.hasOwn(profile, tier)) continue;
      parsed[tier] = profile[tier] === null ? null : parseTier(false, profile[tier], `${location}.${tier}`);
    }
    if (profile.routes !== undefined) {
      if (!profile.routes || typeof profile.routes !== "object" || Array.isArray(profile.routes)) throw new RouteConfigError(`${location}.routes: expected object`);
      const routes = Object.create(null) as Record<string, RouteSettings>;
      for (const [role, settings] of Object.entries(profile.routes)) {
        if (!role.trim() || role !== role.trim()) throw new RouteConfigError(`${location}.routes: role must be nonempty without surrounding whitespace`);
        routes[role] = parseSettings(settings, `${location}.routes.${role}`);
      }
      parsed.routes = routes;
    }
    profiles[name] = parsed;
  }
  return profiles;
}
/**
 * One tier: a route; except in `models.main` the model may be `"main"` (`{ "model": "main", "thinking"? }`) and the
 * thinking may be `"main"` (INHERIT_MAIN). `{ "model": "main", "thinking": "main" }` means `{ "model": "main" }` and is read as it.
 */
function parseTier(isMain: boolean, value: unknown, location: string): TierSettings {
  const route = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const thinkingMain = route?.thinking === INHERIT_MAIN;
  if (thinkingMain && isMain) throw thinkingMainError(location);
  if (value !== INHERIT_MAIN && route?.model !== INHERIT_MAIN) {
    if (!thinkingMain) return parseSettings(value, location);
    const { thinking: _main, ...rest } = route!;
    return { ...parseSettings(rest, location), thinking: INHERIT_MAIN };
  }
  if (isMain) throw new RouteConfigError(`${location}: "main" (inherit main's model) is for ${INHERITING_TIERS}; models.main is the Pi session's own model (omit it to keep Pi's model)`);
  if (!route) throw new RouteConfigError(`${location}: expected route object; write { "model": "main" } to inherit main's model`);
  if (Object.keys(route).some(key => key !== "model" && key !== "thinking" && key !== "extendedContext")) throw new RouteConfigError(`${location}: unknown route field`);
  if (route.extendedContext !== undefined) throw new RouteConfigError(`${location}.extendedContext: not with model "main" (main's model is inherited with main's context window)`);
  const thinking = thinkingMain ? undefined : parseThinking(route.thinking, location);
  return { model: INHERIT_MAIN, ...(thinking !== undefined ? { thinking } : {}) };
}
/** `workers`: only `explorerRoles` still applies; the coordinator's `maxWorkers` and `answerAngles` are ignored (reported in `legacy`). */
function parseWorkers(value: unknown, legacy: string[]): { explorerRoles?: readonly string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.workers: expected object");
  const workers = value as Record<string, unknown>;
  if (Object.keys(workers).some(key => key !== "explorerRoles" && !LEGACY_WORKERS_KEYS.includes(key))) throw new RouteConfigError("config.workers: unknown field");
  legacy.push(...Object.keys(workers).filter(key => LEGACY_WORKERS_KEYS.includes(key)).map(key => `workers.${key}`));
  const list = workers.explorerRoles;
  if (list === undefined) return {};
  if (!Array.isArray(list) || !list.length || list.length > MAX_EXPLORER_ROLES) throw new RouteConfigError(`config.workers.explorerRoles: expected 1-${MAX_EXPLORER_ROLES} route roles`);
  const explorerRoles = list.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || /\s/.test(item)) throw new RouteConfigError(`config.workers.explorerRoles[${index}]: expected a non-empty route role without whitespace`);
    return item;
  });
  if (new Set(explorerRoles).size !== explorerRoles.length) throw new RouteConfigError("config.workers.explorerRoles: duplicate entry");
  return { explorerRoles };
}
export async function loadRouteConfig(path: string): Promise<RouteConfig> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new RouteConfigError(`Cannot load route config ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  return parseRouteConfig(value);
}
export function resolveRoute(config: RouteConfig, role: string): ModelRoute {
  const route = (Object.hasOwn(config.routes, role) ? config.routes[role] : undefined) ?? config.default;
  if (!route) throw new RouteConfigError(`No route for role ${role} and no default route`);
  const extendedContext = route.extendedContext ?? config.extendedContext;
  return { role, ...route, ...(extendedContext !== undefined ? { extendedContext } : {}) };
}

export const SPECIALIST_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  "game-asset": "claude-opus-5-5",
  video: "claude-opus-5-5",
};
/** Explicit routes win; otherwise prefer the specialist model on the default provider
 * only when the runtime has it. Preserve all effective default settings and errors. */
export function resolveSpecialistRoute(config: RouteConfig, role: string, hasModel: (provider: string, id: string) => boolean): ModelRoute {
  const route = resolveRoute(config, role);
  if (Object.hasOwn(config.routes, role) || !Object.hasOwn(SPECIALIST_DEFAULT_MODELS, role)) return route;
  const id = SPECIALIST_DEFAULT_MODELS[role]!;
  const provider = route.model.slice(0, route.model.indexOf("/"));
  return hasModel(provider, id) ? { ...route, model: `${provider}/${id}` } : route;
}
export function parseRouteOverride(override: string): ModelRoute {
  const equals = override.indexOf("=");
  if (equals <= 0 || equals !== override.lastIndexOf("=")) throw new RouteConfigError("Override must be role=provider/modelId[:thinking]");
  const role = override.slice(0, equals);
  if (!role.trim() || role !== role.trim() || /\s/.test(role)) throw new RouteConfigError("Override role must be nonempty without whitespace");
  const reference = override.slice(equals + 1);
  const colon = reference.indexOf(":");
  const settings = colon < 0 ? { model: reference } : { model: reference.slice(0, colon), thinking: reference.slice(colon + 1) };
  return { role, ...parseSettings(settings, `override.${role}`) };
}
export function applyRouteOverrides(config: RouteConfig, overrides: readonly string[]): RouteConfig {
  const routes: Record<string, RouteSettings> = Object.assign(Object.create(null), config.routes) as Record<string, RouteSettings>;
  for (const override of overrides) {
    const { role, ...settings } = parseRouteOverride(override);
    routes[role] = settings;
  }
  return { ...config, routes };
}
