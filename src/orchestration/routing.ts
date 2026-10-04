import { readFile } from "node:fs/promises";
import { parseAdvisorConfigs, AdvisorConfigError, type AdvisorConfig } from "../advisor/config.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MAX_WORKERS_LIMIT, type TeamSettings } from "./team.js";
import { parseRunLimits, RunLimitsError, type RunLimits } from "./limits.js";
import { isArtifactPattern, type AuditSettings } from "./artifacts.js";

/** Main-session delegation: auto chooses single/multi, single uses one worker, multi uses the orchestrator, direct edits locally. */
export const MAIN_MODES = ["auto", "single", "multi", "direct"] as const;
export type MainMode = (typeof MAIN_MODES)[number];
/** Direct by default: benchmarks showed single agents match delegation quality at lower cost; switch with /orche mode or `mainMode`. */
export const DEFAULT_MAIN_MODE: MainMode = "direct";
export interface ModelRoute { role: string; model: string; thinking?: ThinkingLevel; extendedContext?: boolean }
export interface RouteSettings { readonly model: string; readonly thinking?: ThinkingLevel; readonly extendedContext?: boolean }
export interface ImageSettings { readonly model: string; readonly timeoutMs?: number }
export interface RouteConfig {
  readonly routes: Readonly<Record<string, RouteSettings>>;
  readonly default?: RouteSettings;
  readonly advisors?: readonly AdvisorConfig[];
  /** Pi package sources (installed at user scope) whose extensions register model providers for orche's own runtime. */
  readonly providerExtensions?: readonly string[];
  /** Raster generation for game-asset/video tasks; the provider must be loaded into orche's runtime. */
  readonly images?: ImageSettings;
  /** Default for routes that do not say: use the curated maximum context window of models that have one (see src/pi/extended-context.ts). */
  readonly extendedContext?: boolean;
  /** Shell commands the verifier must run (e.g. ["npm test"]); without them it discovers the project's own checks. */
  readonly verifyCommands?: readonly string[];
  /** Worker team shape: maximum workers, explorer route roles and analyst angles (defaults in ./team.ts). */
  readonly workers?: Partial<TeamSettings>;
  /** Behavior of the main session in the Pi package (ignored by the standalone CLI). Default `auto`. */
  readonly mainMode?: MainMode;
  /** Run caps in milliseconds and worker request/repair budgets; explicit values only. */
  readonly limits?: Partial<RunLimits>;
  /** Extra generated-output patterns exempting only new files from workspace violations. */
  readonly audit?: AuditSettings;
}
export class RouteConfigError extends Error {
  override readonly name = "RouteConfigError";
}
const thinkingLevels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_PROVIDER_EXTENSIONS = 4;
const MAX_VERIFY_COMMANDS = 8;
function parseSettings(value: unknown, location: string): RouteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError(`${location}: expected route object`);
  const route = value as Record<string, unknown>;
  if (Object.keys(route).some(key => key !== "model" && key !== "thinking" && key !== "extendedContext")) throw new RouteConfigError(`${location}: unknown route field`);
  if (typeof route.model !== "string" || !/^[^\s/:]+\/[^\s:]+$/.test(route.model)) throw new RouteConfigError(`${location}.model: expected provider/modelId`);
  if (route.thinking !== undefined && (typeof route.thinking !== "string" || !thinkingLevels.includes(route.thinking)))
    throw new RouteConfigError(`${location}.thinking: expected ${thinkingLevels.join(", ")}`);
  if (route.extendedContext !== undefined && typeof route.extendedContext !== "boolean") throw new RouteConfigError(`${location}.extendedContext: expected boolean`);
  return {
    model: route.model,
    ...(route.thinking !== undefined ? { thinking: route.thinking as ThinkingLevel } : {}),
    ...(route.extendedContext !== undefined ? { extendedContext: route.extendedContext } : {}),
  };
}
export function parseRouteConfig(value: unknown): RouteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config: expected object");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => key !== "routes" && key !== "default" && key !== "advisors" && key !== "providerExtensions" && key !== "extendedContext" && key !== "verifyCommands" && key !== "mainMode" && key !== "workers" && key !== "limits" && key !== "audit" && key !== "images")) throw new RouteConfigError("config: unknown field");
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
  let advisors: AdvisorConfig[] | undefined;
  if (config.advisors !== undefined) {
    try { advisors = parseAdvisorConfigs(config.advisors); }
    catch (error) { throw error instanceof AdvisorConfigError ? new RouteConfigError(error.message) : error; }
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
  if (config.mainMode !== undefined && !MAIN_MODES.includes(config.mainMode as MainMode)) throw new RouteConfigError(`config.mainMode: expected ${MAIN_MODES.join(", ")}`);
  let verifyCommands: string[] | undefined;
  if (config.verifyCommands !== undefined) {
    const list = config.verifyCommands;
    if (!Array.isArray(list) || !list.length || list.length > MAX_VERIFY_COMMANDS) throw new RouteConfigError(`config.verifyCommands: expected 1-${MAX_VERIFY_COMMANDS} shell commands`);
    verifyCommands = list.map((command, index) => {
      if (typeof command !== "string" || !command.trim()) throw new RouteConfigError(`config.verifyCommands[${index}]: expected a non-empty shell command`);
      return command.trim();
    });
  }
  return {
    routes,
    ...(limits !== undefined ? { limits } : {}),
    ...(config.audit !== undefined ? { audit: parseAudit(config.audit) } : {}),
    ...(config.default !== undefined ? { default: parseSettings(config.default, "config.default") } : {}),
    ...(advisors ? { advisors } : {}),
    ...(providerExtensions ? { providerExtensions } : {}),
    ...(config.images !== undefined ? { images: parseImages(config.images) } : {}),
    ...(config.extendedContext !== undefined ? { extendedContext: config.extendedContext } : {}),
    ...(verifyCommands ? { verifyCommands } : {}),
    ...(config.workers !== undefined ? { workers: parseWorkers(config.workers) } : {}),
    ...(config.mainMode !== undefined ? { mainMode: config.mainMode as MainMode } : {}),
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

function parseAudit(value: unknown): AuditSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.audit: expected object");
  const audit = value as Record<string, unknown>;
  if (Object.keys(audit).some(key => key !== "artifacts")) throw new RouteConfigError("config.audit: unknown field");
  if (audit.artifacts === undefined) return {};
  if (!Array.isArray(audit.artifacts)) throw new RouteConfigError("config.audit.artifacts: expected string array");
  const artifacts = audit.artifacts.map((pattern, index) => {
    if (!isArtifactPattern(pattern)) throw new RouteConfigError(`config.audit.artifacts[${index}]: expected a non-empty relative concrete path, dir/, dir/** or *.ext`);
    return pattern;
  });
  return { artifacts };
}

function parseWorkers(value: unknown): Partial<TeamSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.workers: expected object");
  const workers = value as Record<string, unknown>;
  if (Object.keys(workers).some(key => key !== "maxWorkers" && key !== "explorerRoles" && key !== "answerAngles")) throw new RouteConfigError("config.workers: unknown field");
  const strings = (key: "explorerRoles" | "answerAngles", what: string): string[] | undefined => {
    const list = workers[key];
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || !list.length || list.length > MAX_WORKERS_LIMIT) throw new RouteConfigError(`config.workers.${key}: expected 1-${MAX_WORKERS_LIMIT} ${what}`);
    const items = list.map((item, index) => {
      if (typeof item !== "string" || !item.trim() || (key === "explorerRoles" && /\s/.test(item))) throw new RouteConfigError(`config.workers.${key}[${index}]: expected a non-empty ${key === "explorerRoles" ? "route role without whitespace" : "string"}`);
      return item.trim();
    });
    if (new Set(items).size !== items.length) throw new RouteConfigError(`config.workers.${key}: duplicate entry`);
    return items;
  };
  const maxWorkers = workers.maxWorkers;
  if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || (maxWorkers as number) < 1 || (maxWorkers as number) > MAX_WORKERS_LIMIT))
    throw new RouteConfigError(`config.workers.maxWorkers: expected an integer 1-${MAX_WORKERS_LIMIT}`);
  const explorerRoles = strings("explorerRoles", "route roles");
  const answerAngles = strings("answerAngles", "angles");
  return {
    ...(maxWorkers !== undefined ? { maxWorkers: maxWorkers as number } : {}),
    ...(explorerRoles ? { explorerRoles } : {}),
    ...(answerAngles ? { answerAngles } : {}),
  };
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
