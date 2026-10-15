import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEPENDENCY_CHANNEL, formatDependencyReport, type DependencyItem, type DependencyProvider, type RunResult } from "../../src/extension/dependencies.js";
import { createOrcheDependencyProvider, MIN_NODE_VERSION, type DependencyContext, type OrcheDependencyOptions } from "../../src/extension/doctor.js";
import { ORCHE_USAGE, parseOrcheCommand } from "../../src/extension/index.js";
import { completeOrcheArguments } from "../../src/extension/completions.js";
import { createHarness, type Harness } from "./harness.js";

const roots: string[] = [];
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture { root: string; packageDir: string; agentDir: string; cwd: string; bin: string; env: NodeJS.ProcessEnv; calls: { command: string; args: string[] }[] }

/** A fake package (package.json + node_modules), agent dir, project and PATH with stand-in git/npm executables. */
async function fixture(options: { deps?: Record<string, string>; installed?: string[]; tools?: string[]; config?: unknown } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "orche-doctor-"));
  roots.push(root);
  const packageDir = join(root, "pkg");
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  for (const dir of [packageDir, agentDir, cwd, bin]) await mkdir(dir, { recursive: true });
  const deps = options.deps ?? { sharp: "^0.35.5", "@ast-grep/napi": "^0.45.3" };
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "pi-orche", dependencies: deps }));
  for (const name of options.installed ?? Object.keys(deps)) await installFake(packageDir, name);
  for (const tool of options.tools ?? ["git", "npm"]) { await writeFile(join(bin, tool), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, tool), 0o755); }
  if (options.config !== undefined) await writeFile(join(agentDir, "orche.config.json"), typeof options.config === "string" ? options.config : JSON.stringify(options.config));
  return { root, packageDir, agentDir, cwd, bin, env: { PATH: bin }, calls: [] };
}

async function installFake(packageDir: string, name: string): Promise<void> {
  await mkdir(join(packageDir, "node_modules", name), { recursive: true });
  await writeFile(join(packageDir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

/** A runner that records every command: git --version succeeds; npm install runs `onNpm` (default: installs every dependency). */
function runner(f: Fixture, onNpm?: () => Promise<RunResult>) {
  return async (command: string, args: string[]): Promise<RunResult> => {
    f.calls.push({ command, args });
    if (command.endsWith("git")) return { code: 0, stdout: "git version 2.45.0\n", stderr: "" };
    if (onNpm) return onNpm();
    for (const name of ["sharp", "@ast-grep/napi"]) await installFake(f.packageDir, name);
    return { code: 0, stdout: "added 2 packages", stderr: "" };
  };
}

const okProbes = { sharp: async () => "libvips 8.0.0", "@ast-grep/napi": async () => "parses TypeScript" };

function provider(f: Fixture, extra: Partial<OrcheDependencyOptions> = {}): DependencyProvider<DependencyContext> {
  return createOrcheDependencyProvider({ packageDir: f.packageDir, agentDir: f.agentDir, env: f.env, nodeVersion: "24.1.0", platform: "linux", run: runner(f), probes: okProbes, providerInstalled: () => true, ...extra });
}

/** A Pi model registry stand-in: `models` are registered; providers in `noAuth` have no credentials. */
const registry = (models: string[], noAuth: string[] = [], images: string[] = []) => ({
  find: (provider: string, id: string) => models.includes(`${provider}/${id}`) ? { provider, id } : undefined,
  findOfType: (_type: "image", provider: string, id: string) => images.includes(`${provider}/${id}`) ? { provider, id } : undefined,
  getProviderAuthStatus: (provider: string) => ({ configured: !noAuth.includes(provider) }),
});

const item = (items: DependencyItem[], name: string) => items.find(entry => entry.name === name);

describe("pi-orche dependency provider: check", () => {
  it("reports a healthy installation and never installs", async () => {
    const f = await fixture({ config: { routes: {}, default: { model: "openai/gpt-5" }, models: { orchestrator: { model: "anthropic/claude" }, worker: { model: "main" } } } });
    const report = await provider(f).check({ cwd: f.cwd, isProjectTrusted: () => false, modelRegistry: registry(["openai/gpt-5", "anthropic/claude"]) });
    expect(report.items.every(entry => entry.status === "ok"), JSON.stringify(report.items)).toBe(true);
    expect(report.items.map(entry => entry.name)).toEqual([
      "npm dependencies", "sharp native binding", "@ast-grep/napi native binding", "Node.js", "git", "orche.config.json (user)", "model openai/gpt-5", "model anthropic/claude",
    ]);
    expect(item(report.items, "model anthropic/claude")?.detail).toContain("models.orchestrator");
    expect(formatDependencyReport("pi-orche", report, "check")).toMatchObject({ level: "info", text: expect.stringMatching(/^pi-orche doctor: healthy\n/) });
    // check ran only git --version: no npm, nothing written.
    expect(f.calls).toEqual([{ command: join(f.bin, "git"), args: ["--version"] }]);
  });

  it("reports missing npm dependencies, git and an old Node.js with actions", async () => {
    const f = await fixture({ installed: ["@ast-grep/napi"], tools: [] });
    const report = await provider(f, { nodeVersion: "20.11.0", platform: "darwin" }).check({ cwd: f.cwd });
    expect(item(report.items, "npm dependencies")).toMatchObject({ status: "error", detail: "missing sharp", action: expect.stringContaining("/orche install-deps") });
    expect(item(report.items, "sharp native binding")).toBeUndefined(); // not probed when missing: the npm item covers it
    expect(item(report.items, "git")).toMatchObject({ status: "error", action: expect.stringContaining("brew install git") });
    expect(item(report.items, "Node.js")).toMatchObject({ status: "error", action: expect.stringContaining(`Node.js >= ${MIN_NODE_VERSION}`) });
    expect(item(report.items, "orche.config.json")).toMatchObject({ status: "ok", detail: expect.stringContaining("every role uses the session's model") });
    expect(formatDependencyReport("pi-orche", report, "check")).toMatchObject({ level: "error", text: expect.stringMatching(/^pi-orche doctor: abnormal/) });
    expect(f.calls).toEqual([]);
  });

  it("reports a native binding that is installed but does not load", async () => {
    const f = await fixture();
    const report = await provider(f, { probes: { ...okProbes, sharp: async () => { throw new Error("Could not load the \"sharp\" module using the linux-x64 runtime"); } } }).check({ cwd: f.cwd });
    expect(item(report.items, "sharp native binding")).toMatchObject({
      status: "error",
      detail: expect.stringContaining("linux-x64 runtime"),
      action: expect.stringContaining(`cd ${f.packageDir} && rm -rf node_modules && npm install --legacy-peer-deps`),
    });
    expect(item(report.items, "@ast-grep/napi native binding")?.status).toBe("ok");
  });

  it("reports an invalid config, an untrusted project config and ignored settings", async () => {
    const f = await fixture({ config: "{ not json" });
    await mkdir(join(f.cwd, ".pi"), { recursive: true });
    await writeFile(join(f.cwd, ".pi", "orche.config.json"), JSON.stringify({ routes: {}, default: { model: "openai/gpt-5" } }));
    const report = await provider(f).check({ cwd: f.cwd, isProjectTrusted: () => false, modelRegistry: registry([]) });
    expect(item(report.items, "orche.config.json (project)")).toMatchObject({ status: "warn", optional: true, action: expect.stringContaining("/trust") });
    expect(item(report.items, "orche.config.json (user)")).toMatchObject({ status: "error", action: expect.stringContaining(`Fix ${join(f.agentDir, "orche.config.json")}`) });
    expect(report.items.some(entry => entry.name.startsWith("model "))).toBe(false);

    await writeFile(join(f.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: "openai/gpt-5" }, single: { pipeline: true } }));
    const trusted = await provider(f).check({ cwd: f.cwd, isProjectTrusted: () => true, modelRegistry: registry(["openai/gpt-5"]) });
    expect(item(trusted.items, "orche.config.json (project)")).toMatchObject({ status: "ok" });
    expect(item(trusted.items, "orche.config.json (user)")).toMatchObject({ status: "warn", optional: true, detail: expect.stringContaining("config.single.pipeline"), action: expect.stringContaining("Remove or update") });

    await writeFile(join(f.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: "openai/gpt-5" } }));
    const both = await provider(f).check({ cwd: f.cwd, isProjectTrusted: () => true, modelRegistry: registry(["openai/gpt-5"]) });
    expect(item(both.items, "orche.config.json (user)")).toMatchObject({ status: "ok", detail: expect.stringContaining("not used") });
  });

  it("checks configured models in Pi's registry: unknown, no credentials, image model", async () => {
    const f = await fixture({ config: { routes: { explorer: { model: "nope/missing" } }, default: { model: "openai/gpt-5" }, images: { model: "cliproxyapi-images/gpt-image-2.5" } } });
    const report = await provider(f).check({ cwd: f.cwd, modelRegistry: registry(["openai/gpt-5"], ["openai"]) });
    expect(item(report.items, "model nope/missing")).toMatchObject({ status: "error", detail: expect.stringContaining("routes.explorer"), action: expect.stringContaining("pi --list-models") });
    expect(item(report.items, "model openai/gpt-5")).toMatchObject({ status: "manual", action: expect.stringContaining("/login") });
    expect(item(report.items, "image model cliproxyapi-images/gpt-image-2.5")).toMatchObject({ status: "unverified", optional: true, action: expect.stringContaining("game-asset") });
    expect(JSON.stringify(report)).not.toMatch(/sk-|apiKey/);

    await writeFile(join(f.agentDir, "orche.config.json"), JSON.stringify({ default: { model: "openai/gpt-5" }, routes: {}, images: { model: "other/img" } }));
    const images = await provider(f).check({ cwd: f.cwd, modelRegistry: registry(["openai/gpt-5"]) });
    expect(item(images.items, "image model other/img")).toMatchObject({ status: "warn", optional: true, action: expect.stringContaining("images.model") });
    expect(item(images.items, "model openai/gpt-5")?.status).toBe("ok");

    const noRegistry = await provider(f).check({ cwd: f.cwd });
    expect(item(noRegistry.items, "configured models")).toMatchObject({ status: "unverified", action: expect.stringContaining("/orche doctor") });
  });

  it("reports missing provider extensions as optional and their models as unverified", async () => {
    const f = await fixture({ config: { routes: {}, default: { model: "gateway/model-x" }, providerExtensions: ["git:github.com/example/gateway"] } });
    const report = await provider(f, { providerInstalled: () => false }).check({ cwd: f.cwd, modelRegistry: registry([]) });
    expect(item(report.items, "provider extension git:github.com/example/gateway")).toMatchObject({ status: "warn", optional: true, action: expect.stringContaining("pi install git:github.com/example/gateway") });
    expect(item(report.items, "model gateway/model-x")).toMatchObject({ status: "unverified", action: expect.stringContaining("/orche single") });
  });
});

describe("pi-orche dependency provider: install", () => {
  it("installs missing npm dependencies, then is idempotent", async () => {
    const f = await fixture({ installed: [] });
    const deps = provider(f);
    const first = await deps.install({ cwd: f.cwd });
    expect(item(first.items, "npm dependencies")).toMatchObject({ status: "installed" });
    expect(first.items.filter(entry => entry.name !== "npm dependencies").every(entry => entry.status === "ok")).toBe(true);
    expect(f.calls.filter(call => call.command === "npm")).toEqual([{ command: "npm", args: ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"] }]);
    const second = await deps.install({ cwd: f.cwd });
    expect(item(second.items, "npm dependencies")).toEqual({ name: "npm dependencies", status: "ok", detail: "already installed" });
    expect(formatDependencyReport("pi-orche", second, "install").text).toMatch(/^pi-orche install-deps: already available/);
    expect(f.calls.filter(call => call.command === "npm")).toHaveLength(1);
  });

  it("reports a failed npm install with its error tail and a manual command", async () => {
    const f = await fixture({ installed: [] });
    const report = await provider(f, { run: runner(f, async () => ({ code: 1, stdout: "", stderr: "npm ERR! network ETIMEDOUT" })) }).install({ cwd: f.cwd });
    expect(item(report.items, "npm dependencies")).toMatchObject({ status: "failed", detail: expect.stringContaining("ETIMEDOUT"), action: `Run by hand and read the error: cd ${f.packageDir} && npm install --legacy-peer-deps` });
  });

  it("leaves git and Node.js to the user and shares one in-flight install", async () => {
    const f = await fixture({ installed: [], tools: ["npm"] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deps = provider(f, { nodeVersion: "18.0.0", platform: "win32", run: runner(f, async () => { await gate; for (const name of ["sharp", "@ast-grep/napi"]) await installFake(f.packageDir, name); return { code: 0, stdout: "", stderr: "" }; }) });
    const a = deps.install({ cwd: f.cwd });
    const b = deps.install({ cwd: f.cwd });
    expect(b).toBe(a);
    release();
    const report = await a;
    expect(f.calls.filter(call => call.command === "npm")).toHaveLength(1);
    expect(item(report.items, "git")).toMatchObject({ status: "manual", action: expect.stringContaining("winget install Git.Git") });
    expect(item(report.items, "Node.js")).toMatchObject({ status: "manual", action: expect.stringContaining("winget install OpenJS.NodeJS.LTS") });
    expect(report.note).toContain("/orche doctor");
  });
});

describe("/orche doctor and install-deps", () => {
  it("are exact control words that change no one-shot prompt; completions offer them", () => {
    expect(parseOrcheCommand("doctor")).toEqual({ mode: "doctor" });
    expect(parseOrcheCommand("  install-deps \n")).toEqual({ mode: "install-deps" });
    for (const bad of ["doctor now", "install-deps sharp", "install", "Doctor"]) expect(parseOrcheCommand(bad)).toBeUndefined();
    expect(parseOrcheCommand("single doctor")).toEqual({ mode: "single", prompt: "doctor" });
    expect(parseOrcheCommand("direct install-deps")).toEqual({ mode: "direct", prompt: "install-deps" });
    expect(parseOrcheCommand("models")).toEqual({ mode: "models" });
    expect(parseOrcheCommand("splits 7")).toEqual({ mode: "splits", days: 7 });
    expect(ORCHE_USAGE).toContain("/orche doctor | /orche install-deps");
    expect(completeOrcheArguments("do")?.map(entry => entry.value)).toEqual(["doctor"]);
    expect(completeOrcheArguments("ins")?.map(entry => entry.value)).toEqual(["install-deps"]);
    expect(completeOrcheArguments("d")?.map(entry => entry.value)).toEqual(["direct ", "detach", "doctor"]);
  });

  it("answer the umbrella's synchronous request and notify the formatted reports through the command", async () => {
    const f = await fixture();
    let events: ExtensionAPI["events"] | undefined;
    const h = await createHarness({
      mainSteps: [], orcheSteps: [], mainMode: "direct",
      extension: { dependencies: { packageDir: f.packageDir, env: f.env, run: runner(f), probes: okProbes, nodeVersion: "24.1.0" } },
      extraExtensions: [pi => { events = pi.events; }],
    });
    open.push(h);
    const provided: DependencyProvider[] = [];
    events!.emit(DEPENDENCY_CHANNEL, { version: 1, provide: (value: DependencyProvider) => provided.push(value) });
    expect(provided.map(entry => [entry.id, entry.label, entry.command])).toEqual([["orche", "pi-orche", "/orche"]]);

    await h.session.prompt("/orche doctor");
    const doctor = h.notifications.at(-1)!;
    expect(doctor.message).toMatch(/^pi-orche doctor: /);
    expect(doctor.message).toContain("[ok] sharp native binding: libvips 8.0.0");
    expect(doctor.message).toContain(`[ok] orche.config.json (user): ${join(h.agentDir, "orche.config.json")} is valid`);
    expect(doctor.message).toContain(`model ${h.orche.route.model}`);

    await h.session.prompt("/orche install-deps");
    const install = h.notifications.at(-1)!;
    expect(install).toEqual({ message: expect.stringMatching(/^pi-orche install-deps: already available\n/), type: "info" });
    expect(h.statuses.filter(status => status.key === "orche-deps")).toEqual([{ key: "orche-deps", text: "pi-orche: installing dependencies…" }, { key: "orche-deps" }]);
    expect(f.calls.some(call => call.command === "npm")).toBe(false);
    expect(h.main.faux.state.callCount).toBe(0);
  });
});
