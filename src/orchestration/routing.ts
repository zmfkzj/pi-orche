import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseRunLimits, RunLimitsError, type RunLimits } from "./limits.js";

/** Main-session delegation: single hands work to one orche_task worker, direct edits locally. */
export const MAIN_MODES = ["single", "direct"] as const;
export type MainMode = (typeof MAIN_MODES)[number];
/** Removed modes (multi-agent orche_run delegation): still accepted in config and session history, read as `single`. */
export const LEGACY_MAIN_MODES = ["auto", "multi"] as const;
export type LegacyMainMode = (typeof LEGACY_MAIN_MODES)[number];
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
   * Models of the three tiers (docs/orchestrator.md 12), each a route without a role: `main` is applied to the Pi session at its
   * start, `orchestrator` replaces main's model for the single workflow's standard-role workers, `worker` replaces the
   * orchestrator's model for its sub-workers. Unset tiers inherit (main: Pi's model; orchestrator: main; worker: orchestrator).
   * `{ "model": "main" }` (INHERIT_MAIN) in `orchestrator` or `worker` names main's current model explicitly.
   * Specialists (game-asset, video) keep their routes.
   */
  readonly models?: ModelTiers;
  /** Behavior of the main session in the Pi package. Default `single`. */
  readonly mainMode?: MainMode;
  /** A removed mode (`auto`/`multi`) found in the file; it is read as `single` and the Pi package warns about it. */
  readonly legacyMainMode?: LegacyMainMode;
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
  return `config.${keys.length === 1 ? keys[0] : `{${keys.join(", ")}}`} ${keys.length === 1 ? "was" : "were"} removed with the multi-worker coordinator and ${keys.length === 1 ? "is" : "are"} ignored`;
}
export const MODEL_TIERS = ["main", "orchestrator", "worker"] as const;
export type ModelTier = typeof MODEL_TIERS[number];
/** A tier of `orchestrator` or `worker`: a route whose model and whose thinking may each be INHERIT_MAIN. */
export interface TierSettings { readonly model: string; readonly thinking?: ThinkingLevel | typeof INHERIT_MAIN; readonly extendedContext?: boolean }
/** `main` is a plain route (the Pi session's own model); `orchestrator` and `worker` may name main's model or thinking. */
export interface ModelTiers { readonly main?: RouteSettings; readonly orchestrator?: TierSettings; readonly worker?: TierSettings }
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
 * not say (`main`), or a route or the reused worker's own (`route`). The level recorded next to it is the one the session runs
 * on, after Pi clamped it to the model.
 */
export type AssignmentThinkingSource = AssignmentModelSource;
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
/** `"main"` outside `models.orchestrator`/`models.worker` (routes, default, models.main): nothing to inherit from there. */
const thinkingMainError = (location: string) => new RouteConfigError(`${location}.thinking: "main" (inherit main's thinking) is for models.orchestrator and models.worker; expected ${thinkingLevels.join(", ")}`);
function parseThinking(value: unknown, location: string): ThinkingLevel | undefined {
  if (value === INHERIT_MAIN) throw thinkingMainError(location);
  if (value !== undefined && (typeof value !== "string" || !thinkingLevels.includes(value)))
    throw new RouteConfigError(`${location}.thinking: expected ${thinkingLevels.join(", ")}`);
  return value as ThinkingLevel | undefined;
}
function parseSettings(value: unknown, location: string): RouteSettings {
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
  if (Object.keys(config).some(key => !LEGACY_CONFIG_KEYS.includes(key) && key !== "routes" && key !== "default" && key !== "providerExtensions" && key !== "extendedContext" && key !== "verifyCommands" && key !== "mainMode" && key !== "workers" && key !== "limits" && key !== "images" && key !== "models")) throw new RouteConfigError("config: unknown field");
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
  const legacyMainMode = typeof config.mainMode === "string" && (LEGACY_MAIN_MODES as readonly string[]).includes(config.mainMode) ? config.mainMode as LegacyMainMode : undefined;
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
  return {
    routes,
    ...(limits !== undefined ? { limits } : {}),
    ...(config.default !== undefined ? { default: parseSettings(config.default, "config.default") } : {}),
    ...(providerExtensions ? { providerExtensions } : {}),
    ...(config.images !== undefined ? { images: parseImages(config.images) } : {}),
    ...(config.extendedContext !== undefined ? { extendedContext: config.extendedContext } : {}),
    ...(verifyCommands ? { verifyCommands } : {}),
    ...(workers?.explorerRoles ? { workers } : {}),
    ...(config.models !== undefined ? { models: parseModelTiers(config.models) } : {}),
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

/** `models`: `main`, `orchestrator` and `worker`, each `{model, thinking?, extendedContext?}` validated like a route. */
function parseModelTiers(value: unknown): ModelTiers {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.models: expected object");
  const tiers = value as Record<string, unknown>;
  const unknown = Object.keys(tiers).find(key => !(MODEL_TIERS as readonly string[]).includes(key));
  if (unknown !== undefined) throw new RouteConfigError(`config.models.${unknown}: unknown tier (expected ${MODEL_TIERS.join(", ")})`);
  const parsed: { -readonly [T in ModelTier]?: ModelTiers[T] } = {};
  for (const tier of MODEL_TIERS) if (tiers[tier] !== undefined) (parsed as Record<ModelTier, TierSettings>)[tier] = parseTier(tier, tiers[tier]);
  return parsed;
}
/**
 * One tier: a route; in `orchestrator` and `worker` the model may be `"main"` (`{ "model": "main", "thinking"? }`) and the
 * thinking may be `"main"` (INHERIT_MAIN). `{ "model": "main", "thinking": "main" }` means `{ "model": "main" }` and is read as it.
 */
function parseTier(tier: ModelTier, value: unknown): TierSettings {
  const location = `config.models.${tier}`;
  const route = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const thinkingMain = route?.thinking === INHERIT_MAIN;
  if (thinkingMain && tier === "main") throw thinkingMainError(location);
  if (value !== INHERIT_MAIN && route?.model !== INHERIT_MAIN) {
    if (!thinkingMain) return parseSettings(value, location);
    const { thinking: _main, ...rest } = route!;
    return { ...parseSettings(rest, location), thinking: INHERIT_MAIN };
  }
  if (tier === "main") throw new RouteConfigError(`${location}: "main" (inherit main's model) is for models.orchestrator and models.worker; models.main is the Pi session's own model (omit it to keep Pi's model)`);
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
