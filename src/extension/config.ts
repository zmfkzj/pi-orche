import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseRouteConfig, RouteConfigError, type RouteConfig } from "../orchestration/routing.js";
import { DEFAULT_WINDOW_MS } from "./concurrent-sessions.js";

export const CONFIG_FILE = "orche.config.json";

export interface SessionModel {
  /** `provider/modelId` of the interactive session's current model. */
  model?: string;
  thinking?: ThinkingLevel;
}
export type ConfigSource =
  | { kind: "project"; path: string }
  | { kind: "user"; path: string }
  | { kind: "session"; model: string; thinking?: ThinkingLevel };
export interface DiscoveredConfig {
  routes: RouteConfig;
  /** `concurrentSessions` of the selected file with defaults applied (enabled, 10 minutes). */
  concurrentSessions: ConcurrentSessionsSettings;
  source: ConfigSource;
  /** Config files that exist but were not used, with the reason. */
  ignored: string[];
}

/** `concurrentSessions` in orche.config.json: warn about other pi sessions active on the same repository. */
export interface ConcurrentSessionsConfig {
  /** Default true. */
  enabled?: boolean;
  /** A session counts as active when its file was written within this many minutes. Default 10. */
  windowMinutes?: number;
}
export interface ConcurrentSessionsSettings {
  enabled: boolean;
  windowMinutes: number;
}
export const DEFAULT_CONCURRENT_SESSIONS: Readonly<ConcurrentSessionsSettings> = { enabled: true, windowMinutes: DEFAULT_WINDOW_MS / 60_000 };
export const MAX_CONCURRENT_WINDOW_MINUTES = 24 * 60;

export function parseConcurrentSessionsConfig(value: unknown): ConcurrentSessionsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.concurrentSessions: expected object");
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some(key => key !== "enabled" && key !== "windowMinutes")) throw new RouteConfigError("config.concurrentSessions: unknown field");
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new RouteConfigError("config.concurrentSessions.enabled: expected boolean");
  const minutes = settings.windowMinutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_CONCURRENT_WINDOW_MINUTES))
    throw new RouteConfigError(`config.concurrentSessions.windowMinutes: expected a number greater than 0 and at most ${MAX_CONCURRENT_WINDOW_MINUTES}`);
  return {
    ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
    ...(minutes !== undefined ? { windowMinutes: minutes as number } : {}),
  };
}

export function resolveConcurrentSessions(config?: ConcurrentSessionsConfig): ConcurrentSessionsSettings {
  return {
    enabled: config?.enabled ?? DEFAULT_CONCURRENT_SESSIONS.enabled,
    windowMinutes: config?.windowMinutes ?? DEFAULT_CONCURRENT_SESSIONS.windowMinutes,
  };
}

/**
 * Load one orche config file: the route settings (validated by `parseRouteConfig`) plus the extension-only
 * `concurrentSessions` setting, which is validated here and removed before the route parser sees the file.
 */
export async function loadOrcheConfigFile(path: string): Promise<{ routes: RouteConfig; concurrentSessions: ConcurrentSessionsSettings }> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new RouteConfigError(`Cannot load route config ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  let routeValue = value;
  let concurrent: ConcurrentSessionsConfig | undefined;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "concurrentSessions")) {
    const { concurrentSessions, ...rest } = value as Record<string, unknown>;
    concurrent = parseConcurrentSessionsConfig(concurrentSessions);
    routeValue = rest;
  }
  return { routes: parseRouteConfig(routeValue), concurrentSessions: resolveConcurrentSessions(concurrent) };
}
export class NoRouteError extends Error {
  override readonly name = "NoRouteError";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route discovery for an orche run started from a Pi session:
 * 1. `<cwd>/.pi/orche.config.json` (only when Pi trusts the project: it can select models and advisors),
 * 2. `<agentDir>/orche.config.json` (`~/.pi/agent` by default),
 * 3. otherwise every role uses the session's current model and thinking level.
 * A file that exists but is invalid is an error, never a silent fallback.
 */
export async function discoverOrcheConfig(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  session: SessionModel;
}): Promise<DiscoveredConfig> {
  const ignored: string[] = [];
  const projectPath = join(options.cwd, ".pi", CONFIG_FILE);
  if (await exists(projectPath)) {
    if (options.projectTrusted) {
      return { ...(await loadOrcheConfigFile(projectPath)), source: { kind: "project", path: projectPath }, ignored };
    }
    ignored.push(`${projectPath} (project is not trusted by Pi)`);
  }
  const userPath = join(options.agentDir, CONFIG_FILE);
  if (await exists(userPath)) {
    return { ...(await loadOrcheConfigFile(userPath)), source: { kind: "user", path: userPath }, ignored };
  }
  const { model, thinking } = options.session;
  if (!model) {
    throw new NoRouteError(
      `No model is selected in this Pi session and no orche config exists. Select a model or create ${projectPath} (see docs/pi-package.md).`,
    );
  }
  return {
    routes: { routes: {}, default: { model, ...(thinking ? { thinking } : {}) } },
    concurrentSessions: resolveConcurrentSessions(),
    source: { kind: "session", model, ...(thinking ? { thinking } : {}) },
    ignored,
  };
}

export function describeSource(source: ConfigSource): string {
  return source.kind === "session"
    ? `session model ${source.model}${source.thinking ? `:${source.thinking}` : ""}`
    : `${source.kind} config ${source.path}`;
}
