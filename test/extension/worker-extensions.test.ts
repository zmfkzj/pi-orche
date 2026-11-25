/**
 * `workerExtensions` (orche.config.json): local Pi extension files loaded into every worker session orche creates (orche_task
 * workers, orche_spawn sub-workers, plan advisors), with their request hooks applied to the requests those sessions send; the
 * paths resolve against the config file's directory, a missing or failing one fails before any model request, and a reused
 * worker is replaced when the list changes. Without the setting no user extension reaches a worker (as before).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { OrcheController } from "../../src/extension/controller.js";
import { discoverOrcheConfig, loadOrcheConfigFile, resolveWorkerExtensions } from "../../src/extension/config.js";
import { WorkerPool } from "../../src/extension/workers.js";
import { parseRouteConfig, parseWorkerExtensions } from "../../src/orchestration/routing.js";
import { createSubWorkerRunner } from "../../src/orchestrator/sub-worker.js";
import { planSpawn } from "../../src/orchestrator/spawn.js";
import { createHarness, tool, type Harness } from "./harness.js";

const MARKER = "WORKER-EXT-MARKER";
const opened: { dispose(): Promise<void> }[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const item of opened.splice(0).reverse()) await item.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A real extension file: prefixes the first system section of every request with MARKER (request-local, like neon-system-compat). */
const MARKER_EXTENSION = `export default function (pi) {
  pi.on("context_with_system", event => ({
    messages: event.messages.map(message => {
      if (message.role !== "system" || !message.sections) return message;
      const [first] = Object.keys(message.sections);
      return { ...message, sections: { ...message.sections, [first]: ${JSON.stringify(`${MARKER}\n`)} + message.sections[first] } };
    }),
  }));
}
`;
const systemOf = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.find(message => message.role === "system"));
/** Steps that record whether each request carried MARKER in its system message. */
function observed(steps: FauxResponseStep[], seen: boolean[]): FauxResponseStep[] {
  return steps.map(step => ((context, options, state, model) => {
    seen.push(systemOf(context).includes(MARKER));
    return typeof step === "function" ? step(context, options, state, model) : step;
  }) as FauxResponseStep);
}

async function writeExtensions(agentDir: string) {
  const dir = join(agentDir, "extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "marker.ts"), MARKER_EXTENSION);
  await writeFile(join(dir, "broken.ts"), "throw new Error('broken-worker-extension');\nexport default function () {}\n");
  return { marker: join(dir, "marker.ts"), broken: join(dir, "broken.ts") };
}

async function fixture(extra: Record<string, unknown> = {}) {
  const h = await createHarness({ mainSteps: [], orcheSteps: [] });
  opened.push(h);
  const files = await writeExtensions(h.agentDir);
  const writeConfig = (more: Record<string, unknown>) => writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, ...more }));
  await writeConfig(extra);
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir });
  opened.push(pool);
  const execute = (args: Partial<Parameters<WorkerPool["execute"]>[0]> = {}) => pool.execute({ role: "answer", request: "Say hello", cwd: h.cwd, projectTrusted: false, ...args });
  return { h, pool, files, writeConfig, execute };
}
const answer = () => tool("report_result", { kind: "answer", summary: "Hello", data: {} });

describe("workerExtensions: config", () => {
  it("parses local paths and refuses malformed lists, package sources and duplicates", () => {
    expect(parseRouteConfig({ routes: {}, workerExtensions: ["extensions/a.ts", "/abs/b", "~/c.ts"] }).workerExtensions).toEqual(["extensions/a.ts", "/abs/b", "~/c.ts"]);
    expect(parseRouteConfig({ routes: {} }).workerExtensions).toBeUndefined();
    for (const bad of [[], "a.ts", [""], [" a.ts"], ["a.ts "], [1], ["a\0b"], ["a.ts", "a.ts"], Array.from({ length: 9 }, (_, i) => `e${i}.ts`)]) {
      expect(() => parseRouteConfig({ routes: {}, workerExtensions: bad }), JSON.stringify(bad)).toThrow("config.workerExtensions");
    }
    for (const source of ["npm:@scope/pkg", "git:github.com/a/b", "https://example.com/x.ts"]) expect(() => parseWorkerExtensions([source])).toThrow("is a package source");
    expect(() => parseWorkerExtensions(["~user/x.ts"])).toThrow("only ~/ is expanded");
  });

  it("resolves entries against the config file's directory (not the task cwd), expands ~/ and rejects missing or repeated paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "orche-wext-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const files = await writeExtensions(agentDir);
    const cwd = join(root, "elsewhere");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: "p/m" }, workerExtensions: ["extensions/marker.ts", files.broken] }));
    const found = await discoverOrcheConfig({ cwd, agentDir, projectTrusted: false, session: {} });
    expect(found.routes.workerExtensions).toEqual([files.marker, files.broken]);
    // A trusted project config resolves against its own directory (<cwd>/.pi).
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi", "extensions", "p.ts"), MARKER_EXTENSION);
    await writeFile(join(cwd, ".pi", "orche.config.json"), JSON.stringify({ routes: {}, default: { model: "p/m" }, workerExtensions: ["extensions/p.ts"] }));
    expect((await discoverOrcheConfig({ cwd, agentDir, projectTrusted: true, session: {} })).routes.workerExtensions).toEqual([join(cwd, ".pi", "extensions", "p.ts")]);
    // ~/ is the home directory.
    const home = relative(homedir(), files.marker);
    if (!home.startsWith("..")) expect(await resolveWorkerExtensions("/nowhere", [`~/${home}`])).toEqual([files.marker]);
    await expect(resolveWorkerExtensions(agentDir, ["extensions/missing.ts"])).rejects.toThrow(`config.workerExtensions[0]: ${join(agentDir, "extensions", "missing.ts")} does not exist (relative entries are resolved against ${agentDir}`);
    await expect(resolveWorkerExtensions(agentDir, ["extensions/marker.ts", "./extensions/marker.ts"])).rejects.toThrow(`config.workerExtensions[1]: ${files.marker} is listed twice`);
    await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, workerExtensions: ["extensions/missing.ts"] }));
    await expect(loadOrcheConfigFile(join(agentDir, "orche.config.json"))).rejects.toThrow("does not exist");
  });
});

describe("workerExtensions: orche_task workers", () => {
  it("loads the configured extension into the worker session: its request hook reaches every request the worker sends", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const { h, files, execute } = await fixture({ workerExtensions: ["extensions/marker.ts"] });
    const seen: boolean[] = [];
    h.orche.faux.setResponses(observed([tool("read", { path: "greeting.txt" }), answer()], seen));
    const result = await execute();
    expect(result.details.worker).toBe("W1");
    expect(seen).toEqual([true, true]);
    expect(spawned.mock.calls[0]![0].extensionPaths).toEqual([files.marker]);
    expect(spawned.mock.calls[0]![0].extensionFactories).toBeUndefined();
  });

  it("without the setting no user extension reaches the worker (as before)", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const { h, execute } = await fixture();
    const seen: boolean[] = [];
    h.orche.faux.setResponses(observed([answer()], seen));
    await execute();
    expect(seen).toEqual([false]);
    expect(spawned.mock.calls[0]![0].extensionPaths).toBeUndefined();
  });

  it("a failing extension fails the task before any model request", async () => {
    const { h, execute } = await fixture({ workerExtensions: ["extensions/broken.ts"] });
    h.orche.faux.setResponses([answer()]);
    await expect(execute()).rejects.toThrow(/broken-worker-extension/);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(h.orche.faux.getPendingResponseCount()).toBe(1);
  });

  it("keeps a reused worker while the list is unchanged and replaces it when the list is added or removed", async () => {
    const { h, writeConfig, execute } = await fixture();
    const seen: boolean[] = [];
    h.orche.faux.setResponses(observed([answer(), answer(), answer(), answer()], seen));
    expect((await execute()).details.worker).toBe("W1");
    await writeConfig({ workerExtensions: ["extensions/marker.ts"] });
    const added = await execute({ worker: "W1" });
    expect(added.details.worker).toBe("W2");
    expect(added.details.retired).toEqual(["W1"]);
    expect(added.text).toContain("W1 retired: workerExtensions were configured; a fresh worker continues, briefed from W1's transcript.");
    const kept = await execute({ worker: "W2" });
    expect(kept.details.worker).toBe("W2");
    expect(kept.details.retired).toBeUndefined();
    await writeConfig({});
    const removed = await execute({ worker: "W2" });
    expect(removed.details.worker).toBe("W3");
    expect(removed.text).toContain("W2 retired: workerExtensions were removed");
    expect(seen).toEqual([false, true, true, false]);
  });
});

describe("workerExtensions: orche_spawn sub-workers", () => {
  it("loads the extension into a sub-worker's own session; none without it; a failing one fails before any request", async () => {
    const h: Harness = await createHarness({ mainSteps: [], orcheSteps: [] });
    opened.push(h);
    const files = await writeExtensions(h.agentDir);
    const runner = (extensionPaths?: string[]) => createSubWorkerRunner({
      orchestrator: "W1", cwd: h.cwd, runtime: h.runtime, route: h.orche.route, routeSource: "orchestrator", thinkingSource: "orchestrator",
      specialistRoute: () => h.orche.route, prompt: worker => worker.request, timeoutMs: 30_000, maxTurns: 5, ...(extensionPaths ? { extensionPaths } : {}),
    });
    const { workers } = planSpawn({ reason: "isolation", workers: [{ name: "probe", role: "answer", request: "Say hello" }] }, { nextId: () => "W1.1" });
    const seen: boolean[] = [];
    h.orche.faux.setResponses(observed([answer(), answer()], seen));
    expect((await runner([files.marker])(workers[0]!, workers, new AbortController().signal, () => undefined)).status).toBe("done");
    expect((await runner()(workers[0]!, workers, new AbortController().signal, () => undefined)).status).toBe("done");
    expect(seen).toEqual([true, false]);
    h.orche.faux.setResponses([answer()]);
    const failed = await runner([files.broken])(workers[0]!, workers, new AbortController().signal, () => undefined);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/broken-worker-extension/);
    expect(h.orche.faux.getPendingResponseCount()).toBe(1);
  });
});

describe("workerExtensions: plan advisors", () => {
  it("loads the extension into the advisor's session too", async () => {
    const { h, pool, files, writeConfig } = await fixture();
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    const workerFaux = fauxProvider({ provider: "wext-worker", models: [{ id: "w", reasoning: true }] });
    const advisorFaux = fauxProvider({ provider: "wext-advisor", models: [{ id: "a", reasoning: true }] });
    h.runtime.registerNativeProvider(workerFaux.provider);
    h.runtime.registerNativeProvider(advisorFaux.provider);
    await writeConfig({ mainMode: "single", single: { advisor: true }, models: { advisor: { model: "wext-advisor/a", thinking: "low" } }, workerExtensions: [files.marker] });
    const checklist = [{ id: "R1", status: "met", evidence: "greeting.txt:1", verifiedBy: "cat greeting.txt" }];
    const done = tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", checklist, split: { decision: "none", criteria: [], reason: "small" }, advice: { decision: "applied", reason: "Checked it." } } });
    const advisorSeen: boolean[] = [];
    advisorFaux.setResponses(observed([tool("report_result", { advice: "Check the newline.", evidence: ["read greeting.txt"] })], advisorSeen));
    const workerSeen: boolean[] = [];
    workerFaux.setResponses(observed([tool("task_plan", { nodes: [{ id: "fix", title: "Fix greeting", dependsOn: [], covers: ["R1"], status: "running" }] }), done, done], workerSeen));
    const model = workerFaux.getModel();
    const result = await pool.execute({ role: "implement", request: "Intent/Purpose: fix the greeting\nR1: greeting.txt says hello.\nOriginal request\nfix it", cwd: h.cwd, projectTrusted: false, mainMode: "single", model, thinking: "high" });
    expect(result.details.advisor).toMatchObject({ status: "processed", model: "wext-advisor/a" });
    expect(advisorSeen).toEqual([true]);
    expect(workerSeen.length).toBeGreaterThan(0);
    expect(workerSeen.every(Boolean)).toBe(true);
  });
});
