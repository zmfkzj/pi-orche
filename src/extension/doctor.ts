/**
 * pi-orche's dependency provider (`/orche doctor`, `/orche install-deps`, and the umbrella's `/oh-my-pi doctor|install-deps`
 * through {@link registerDependencyProvider}). The shared contract and helpers are in ./dependencies.ts (a verbatim copy of
 * the umbrella's contract); everything orche-specific is here.
 *
 * check() is read-only: it resolves and loads orche's own npm dependencies in-process (a native binding can be installed but
 * broken for this platform), runs `git --version` with a timeout, reads the user and project orche.config.json through
 * orche's own loader and looks the configured models up in Pi's model registry (registry and auth status only: no request,
 * no credential is read or printed). install() runs only `npm install --legacy-peer-deps` in the package directory when an
 * npm dependency is missing; Node.js, git, broken bindings, configuration and credentials are reported as manual steps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  findExecutable, formatDependencyReport, insideNodeModules, installNpmDependencies, npmDependencyItem, npmPackageInstalled, outputTail, runProcess,
  type DependencyItem, type DependencyMode, type DependencyProvider, type DependencyReport,
} from "./dependencies.js";
import { CONFIG_FILE, loadOrcheConfigFile } from "./config.js";
import { inheritsMain, type RouteConfig } from "../orchestration/routing.js";

export const ORCHE_DEPENDENCY_ID = "orche";
export const ORCHE_DEPENDENCY_LABEL = "pi-orche";
export const ORCHE_DEPENDENCY_COMMAND = "/orche";
/** Pi's own engines.node (@earendil-works/pi-coding-agent 1.2.0); orche declares none of its own and uses Node 22 APIs. */
export const MIN_NODE_VERSION = "22.19.0";
/** The bundled image provider's id (pi-gateway-images, see src/pi/bundled-images.ts); not imported to keep check() light. */
const BUNDLED_IMAGE_PROVIDER = "cliproxyapi-images";
const PROBE_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
/** The package root (src/extension/ -> ../..). */
export const ORCHE_PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The part of Pi's command context the provider reads (ExtensionCommandContext satisfies it). */
export interface DependencyContext {
  cwd: string;
  isProjectTrusted?: () => boolean;
  modelRegistry?: {
    find(provider: string, modelId: string): unknown;
    findOfType?(type: "image", provider: string, modelId: string): unknown;
    getProviderAuthStatus?(provider: string): { configured: boolean };
  };
}

/** A load probe of one npm dependency: resolves with a short detail (version, platform), rejects when it cannot load or work. */
export type LoadProbe = () => Promise<string>;

export interface OrcheDependencyOptions {
  /** Package root whose package.json / node_modules are checked and installed (default: this package). */
  packageDir?: string;
  /** Pi agent dir with the user orche.config.json (default: getAgentDir()). */
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Node.js version to check (default: process.versions.node). */
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** Process runner for `git --version` and `npm install` (default: runProcess). */
  run?: typeof runProcess;
  /** Load probes by npm dependency name (default: {@link defaultLoadProbes}). */
  probes?: Record<string, LoadProbe>;
  /** Whether a providerExtensions source is installed at user scope (default: Pi's package manager, read-only). */
  providerInstalled?: (source: string, agentDir: string, cwd: string) => boolean;
}

/** What each probed npm dependency is for (item names and failure details). */
const PROBED: Record<string, { name: string; purpose: string }> = {
  "@ast-grep/napi": { name: "@ast-grep/napi native binding", purpose: "ast_search, outline and edit tools" },
  sharp: { name: "sharp native binding", purpose: "image processing of generate_image" },
  typescript: { name: "typescript", purpose: "the diagnostics tool's bundled compiler" },
  "pi-gateway-images": { name: "pi-gateway-images (bundled image provider)", purpose: "the bundled cliproxyapi-images provider" },
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The real probes: each loads the module and makes it do a little in-memory work. */
export const defaultLoadProbes: Record<string, LoadProbe> = {
  "@ast-grep/napi": async () => {
    const { parse, Lang } = await import("@ast-grep/napi");
    const kind = parse(Lang.TypeScript, "const a = 1;").root().kind();
    if (kind !== "program") throw new Error(`unexpected parse result ${kind}`);
    return `parses TypeScript (${process.platform}-${process.arch})`;
  },
  sharp: async () => {
    const sharp = (await import("sharp")).default;
    await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    return `libvips ${sharp.versions.vips} (${process.platform}-${process.arch})`;
  },
  typescript: async () => {
    const mod = await import("typescript") as { version?: string; default?: { version?: string } };
    const version = mod.version ?? mod.default?.version;
    if (!version) throw new Error("typescript loaded without a version");
    return `version ${version}`;
  },
  "pi-gateway-images": async () => {
    const mod = await import("../pi/bundled-images.js");
    if (typeof mod.createProviderConfig !== "function") throw new Error("createProviderConfig is missing");
    return `provider ${mod.PROVIDER_ID}`;
  },
};

function defaultProviderInstalled(source: string, agentDir: string, cwd: string): boolean {
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}) });
  return !!packages.getInstalledPath(source, "user");
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function nodeInstallHint(platform: NodeJS.Platform): string {
  const how = platform === "darwin" ? "brew install node@22, or nvm install 22"
    : platform === "win32" ? "winget install OpenJS.NodeJS.LTS, or nvm-windows: nvm install 22"
    : "nvm install 22, or your distribution's Node.js 22+ package (e.g. NodeSource)";
  return `Install Node.js >= ${MIN_NODE_VERSION} (${how}), then restart pi with it`;
}

export function gitInstallHint(platform: NodeJS.Platform): string {
  const how = platform === "darwin" ? "xcode-select --install, or brew install git"
    : platform === "win32" ? "winget install Git.Git"
    : "sudo apt install git (Debian/Ubuntu), sudo dnf install git (Fedora) or sudo pacman -S git (Arch)";
  return `Install git and put it on PATH (${how}), then restart pi`;
}

/** The reinstall step for a dependency that is installed but does not load (wrong platform binary, broken install). */
function reinstallAction(packageDir: string, platform: NodeJS.Platform): string {
  const arch = `${platform}-${process.arch}`;
  return insideNodeModules(packageDir)
    ? `Reinstall pi-orche so npm fetches the ${arch} build (pi update --extensions, or pi remove and pi install its source), then /reload`
    : `Reinstall the dependencies for ${arch}: cd ${packageDir} && rm -rf node_modules && npm install --legacy-peer-deps, then /reload`;
}

/** Create the provider; `options` are test seams. Overlapping installs share one in-flight run. */
export function createOrcheDependencyProvider(options: OrcheDependencyOptions = {}): DependencyProvider<DependencyContext> {
  const packageDir = options.packageDir ?? ORCHE_PACKAGE_DIR;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runProcess;
  const probes = options.probes ?? defaultLoadProbes;
  const providerInstalled = options.providerInstalled ?? defaultProviderInstalled;
  const agentDir = () => options.agentDir ?? getAgentDir();

  const nodeItem = (mode: DependencyMode): DependencyItem => {
    const version = options.nodeVersion ?? process.versions.node;
    if (compareVersions(version, MIN_NODE_VERSION) >= 0) return { name: "Node.js", status: "ok", detail: mode === "install" ? `already available (${version})` : `${version} (>= ${MIN_NODE_VERSION})` };
    return { name: "Node.js", status: mode === "install" ? "manual" : "error", detail: `${version} is older than ${MIN_NODE_VERSION} (Pi's minimum)`, action: nodeInstallHint(platform) };
  };

  const gitItem = async (mode: DependencyMode): Promise<DependencyItem> => {
    const name = "git";
    const path = findExecutable("git", env);
    if (!path) return { name, status: mode === "install" ? "manual" : "error", detail: "not on PATH (needed for worktrees, commits, change tracking and file listing)", action: gitInstallHint(platform) };
    const result = await run(path, ["--version"], { env, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code === 0) return { name, status: "ok", detail: mode === "install" ? `already available (${result.stdout.trim()})` : `${result.stdout.trim()} (${path})` };
    return { name, status: mode === "install" ? "manual" : "error", detail: `${path} --version failed: ${outputTail(result)}`, action: `Repair or reinstall git: ${gitInstallHint(platform)}` };
  };

  /** Load probes of the installed, probed dependencies; missing ones are covered by the npm item. */
  const loadItems = async (mode: DependencyMode): Promise<DependencyItem[]> => {
    let names: string[];
    try { names = Object.keys(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dependencies ?? {}); }
    catch { return []; }
    const items: DependencyItem[] = [];
    for (const dep of names) {
      const probe = probes[dep];
      const meta = PROBED[dep];
      if (!probe || !meta || !npmPackageInstalled(packageDir, dep)) continue;
      try {
        const detail = await withTimeout(probe(), PROBE_TIMEOUT_MS, `loading ${dep}`);
        items.push({ name: meta.name, status: "ok", detail: mode === "install" ? `loads (${detail})` : detail });
      } catch (error) {
        items.push({ name: meta.name, status: mode === "install" ? "manual" : "error", detail: `installed but does not load (${meta.purpose}): ${errorText(error)}`, action: reinstallAction(packageDir, platform) });
      }
    }
    return items;
  };

  const configItems = async (ctx: DependencyContext): Promise<{ items: DependencyItem[]; effective?: { path: string; routes: RouteConfig } }> => {
    const items: DependencyItem[] = [];
    let trusted = false;
    try { trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false; } catch { /* untrusted */ }
    const projectPath = join(ctx.cwd, ".pi", CONFIG_FILE);
    const userPath = join(agentDir(), CONFIG_FILE);
    let effective: { path: string; routes: RouteConfig } | undefined;
    let effectiveChosen = false;
    for (const [kind, path] of [["project", projectPath], ["user", userPath]] as const) {
      if (!existsSync(path)) continue;
      const name = `orche.config.json (${kind})`;
      if (kind === "project" && !trusted) {
        items.push({ name, status: "warn", optional: true, detail: `${path} is ignored: Pi does not trust this project`, action: `Run /trust in this project (or start pi with --approve) so orche reads ${path}, or move its settings to ${userPath}` });
        continue;
      }
      try {
        const loaded = await loadOrcheConfigFile(path);
        const used = !effectiveChosen;
        if (loaded.warnings.length) items.push({ name, status: "warn", optional: true, detail: `${path} loads; ignored settings: ${loaded.warnings.join("; ")}`, action: `Remove or update the ignored settings in ${path} (see orche's README)` });
        else items.push({ name, status: "ok", detail: `${path} is valid${used ? "" : ` (not used: the project config takes precedence)`}` });
        if (used) effective = { path, routes: loaded.routes };
      } catch (error) {
        items.push({ name, status: "error", detail: `${path} is invalid: ${errorText(error)}`, action: `Fix ${path} (${errorText(error)}; see orche's README / docs/pi-package.md), then run /orche doctor again` });
      }
      // The first file that applies is the one orche uses (discoverOrcheConfig): an invalid one is an error, never a fallback.
      effectiveChosen = true;
    }
    if (!items.length) items.push({ name: "orche.config.json", status: "ok", detail: `none (${projectPath}, ${userPath}): every role uses the session's model` });
    return { items, ...(effective ? { effective } : {}) };
  };

  const modelItems = (ctx: DependencyContext, config: { path: string; routes: RouteConfig }): DependencyItem[] => {
    const { routes, path } = config;
    const uses = new Map<string, string[]>();
    const add = (model: string, where: string) => uses.set(model, [...(uses.get(model) ?? []), where]);
    if (routes.default) add(routes.default.model, "default");
    for (const [role, route] of Object.entries(routes.routes)) add(route.model, `routes.${role}`);
    for (const [tier, route] of Object.entries(routes.models ?? {})) if (route && !inheritsMain(route)) add(route.model, `models.${tier}`);
    const items: DependencyItem[] = [];
    const providerExtensions = routes.providerExtensions ?? [];
    for (const source of providerExtensions) {
      let installed = false;
      try { installed = providerInstalled(source, agentDir(), ctx.cwd); } catch { /* reported as missing */ }
      items.push(installed
        ? { name: `provider extension ${source}`, status: "ok", detail: "installed at user scope" }
        : { name: `provider extension ${source}`, status: "warn", optional: true, detail: `not installed at user scope; orche falls back to Pi's inherited providers (${path} providerExtensions)`, action: `pi install ${source}, or remove the entry from providerExtensions in ${path}` });
    }
    const registry = ctx.modelRegistry;
    if (!registry && (uses.size || routes.images)) {
      items.push({ name: "configured models", status: "unverified", detail: "no Pi model registry in this context", action: "Run /orche doctor (or /orche models) inside a Pi session to look the models up" });
      return items;
    }
    const credentials = (provider: string, model: string, where: string): DependencyItem => {
      let configured: boolean | undefined;
      try { configured = registry?.getProviderAuthStatus?.(provider).configured; } catch { configured = undefined; }
      if (configured === false) return { name: `model ${model}`, status: "manual", detail: `registered, but provider ${provider} has no credentials set (${where})`, action: `Log in or set the API key for ${provider}: run /login in Pi and choose ${provider}, or set the provider's API key environment variable, then /orche doctor` };
      return { name: `model ${model}`, status: "ok", detail: `registered${configured ? ", credentials set (not tested)" : ""} (${where})` };
    };
    for (const [model, where] of uses) {
      const slash = model.indexOf("/");
      const provider = model.slice(0, slash);
      const found = registry!.find(provider, model.slice(slash + 1));
      if (found) { items.push(credentials(provider, model, where.join(", "))); continue; }
      items.push(providerExtensions.length
        ? { name: `model ${model}`, status: "unverified", detail: `not in Pi's model registry (${where.join(", ")}); providerExtensions may register it in orche's own runtime`, action: `Verify with a small task, e.g. /orche single say hello, or check the id with pi --list-models` }
        : { name: `model ${model}`, status: "error", detail: `not in Pi's model registry (${where.join(", ")} in ${path})`, action: `Use a model listed by pi --list-models in ${path}, or install/configure the provider that offers ${model}, then /reload` });
    }
    if (routes.images) {
      const model = routes.images.model;
      const slash = model.indexOf("/");
      const provider = model.slice(0, slash);
      const name = `image model ${model}`;
      let found: unknown;
      try { found = registry!.findOfType?.("image", provider, model.slice(slash + 1)); } catch { found = undefined; }
      if (found) items.push({ ...credentials(provider, model, "images.model"), name, optional: true });
      else if (provider === BUNDLED_IMAGE_PROVIDER) items.push({ name, status: "unverified", optional: true, detail: "bundled provider: registered in orche's runtime when a game-asset/video task starts; it reads CLIProxyAPI settings (cliproxyapi.json / auth.json in the agent dir)", action: "Verify by generating an image in a game-asset task; check CLIProxyAPI with /cliproxyapi doctor if pi-cliproxyapi is installed" });
      else items.push(providerExtensions.length
        ? { name, status: "unverified", optional: true, detail: "not in Pi's model registry; providerExtensions may register it in orche's runtime", action: "Verify by generating an image in a game-asset task" }
        : { name, status: "warn", optional: true, detail: `not in Pi's model registry: generate_image would fail (images.model in ${path})`, action: `Set images.model in ${path} to a registered image model (e.g. ${BUNDLED_IMAGE_PROVIDER}/gpt-image-2.5), or remove "images" to keep generate_image off` });
    }
    return items;
  };

  let installing: Promise<DependencyReport> | undefined;
  return {
    id: ORCHE_DEPENDENCY_ID,
    label: ORCHE_DEPENDENCY_LABEL,
    command: ORCHE_DEPENDENCY_COMMAND,
    async check(ctx) {
      const items: DependencyItem[] = [];
      const guard = async (name: string, section: () => Promise<DependencyItem[]> | DependencyItem[]) => {
        try { items.push(...await section()); }
        catch (error) { items.push({ name, status: "unverified", detail: `check failed: ${errorText(error)}`, action: `Run /orche doctor again; if it keeps failing, check ${name} by hand` }); }
      };
      await guard("npm dependencies", () => npmDependencyItem(packageDir, ORCHE_DEPENDENCY_COMMAND));
      await guard("npm dependency loading", () => loadItems("check"));
      await guard("Node.js", () => [nodeItem("check")]);
      await guard("git", async () => [await gitItem("check")]);
      await guard("orche.config.json", async () => {
        const config = await configItems(ctx);
        return [...config.items, ...(config.effective ? modelItems(ctx, config.effective) : [])];
      });
      return { items };
    },
    install() {
      installing ??= (async (): Promise<DependencyReport> => {
        const items: DependencyItem[] = [];
        try {
          items.push(...await installNpmDependencies(packageDir, { env, run }));
        } catch (error) {
          items.push({ name: "npm dependencies", status: "failed", detail: errorText(error), action: `Run by hand and read the error: cd ${packageDir} && npm install --legacy-peer-deps` });
        }
        items.push(...await loadItems("install"), nodeItem("install"), await gitItem("install"));
        return { items, note: "Configuration, models and credentials are not installed: /orche doctor checks them." };
      })().finally(() => { installing = undefined; });
      return installing;
    },
  };
}

/** `/orche doctor` and `/orche install-deps`: run the provider and notify the formatted report. */
export async function runDependencyCommand(provider: DependencyProvider<DependencyContext>, mode: DependencyMode, ctx: Pick<ExtensionCommandContext, "ui"> & DependencyContext): Promise<void> {
  let report: DependencyReport;
  if (mode === "install") ctx.ui.setStatus("orche-deps", "pi-orche: installing dependencies…");
  try {
    report = mode === "check" ? await provider.check(ctx) : await provider.install(ctx);
  } catch (error) {
    report = { items: [{ name: mode === "check" ? "doctor" : "install-deps", status: mode === "check" ? "unverified" : "failed", detail: errorText(error), action: `Run /orche ${mode === "check" ? "doctor" : "install-deps"} again; if it keeps failing, cd ${ORCHE_PACKAGE_DIR} && npm install --legacy-peer-deps` }] };
  } finally {
    if (mode === "install") ctx.ui.setStatus("orche-deps", undefined);
  }
  const { text, level } = formatDependencyReport(ORCHE_DEPENDENCY_LABEL, report, mode);
  ctx.ui.notify(text, level);
}
