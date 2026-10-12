// Opt-in worker capabilities (orche_task `gui`): the provider's extension factories load into the worker's own session,
// their tools join the allowlist, session_start/session_shutdown reach them, and a capability change replaces the worker.
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool, webFetchCapability, type WorkerCapabilityAnswer, type WorkerCapabilityRequest } from "../../src/extension/workers.js";
import { createSubWorkerRunner } from "../../src/orchestrator/sub-worker.js";
import { planSpawn } from "../../src/orchestrator/spawn.js";
import { createHarness, tool, type Harness } from "./harness.js";

const open: { h: Harness; pool: WorkerPool }[] = [];
afterEach(async () => {
  for (const { h, pool } of open.splice(0)) { await pool.dispose(); await h.dispose(); }
  vi.restoreAllMocks();
});

/** A stand-in for pi-gui: one tool, and a record of the lifecycle events its extension saw. */
function guiProvider(key = "gui-1") {
  const events: string[] = [];
  const requests: WorkerCapabilityRequest[] = [];
  const factory: ExtensionFactory = pi => {
    pi.registerTool({
      name: "gui_probe", label: "GUI probe", description: "Probe the private desktop", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "desktop ok" }], details: undefined }),
    });
    pi.on("session_start", () => { events.push("start"); });
    pi.on("session_shutdown", () => { events.push("shutdown"); });
  };
  const capability = (request: WorkerCapabilityRequest): WorkerCapabilityAnswer => {
    requests.push(request);
    return request.capability === "gui"
      ? { key, tools: ["gui_probe"], extensionFactories: [factory], instructions: "GUI-INSTRUCTIONS: private desktop", toolTimeoutsMs: { gui_probe: 99_000 } }
      : undefined;
  };
  return { events, requests, capability };
}

async function fixture(steps: FauxResponseStep[], capability?: (request: WorkerCapabilityRequest) => WorkerCapabilityAnswer) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model } }));
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, ...(capability ? { capability } : {}) });
  open.push({ h, pool });
  const execute = (options: { worker?: string; gui?: boolean; role?: "explore" | "answer" | "implement" } = {}) => pool.execute({ role: "explore", request: "Look at the app", cwd: h.cwd, projectTrusted: false, ...options });
  return { h, pool, execute };
}
const report = tool("report_result", { kind: "explore", summary: "Done", data: { status: "done" } });
const answerReport = tool("report_result", { kind: "answer", summary: "Done", data: {} });

describe("orche_task gui capability", () => {
  it("loads the provider's extensions into the worker session only, with its tools, instructions and timeouts", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const provider = guiProvider();
    const { pool, execute } = await fixture([tool("gui_probe", {}), report], provider.capability);
    const result = await execute({ gui: true });
    expect(result.details.gui).toBe(true);
    expect(provider.requests).toEqual([
      { capability: "gui", cwd: expect.any(String), workerId: "W1", role: "explore", readOnly: true },
      { capability: "web-fetch", cwd: expect.any(String), workerId: "W1", role: "explore", readOnly: true },
    ]);
    const options = spawned.mock.calls[0]![0];
    expect(options.tools).toContain("gui_probe");
    expect(options.toolTimeoutsMs).toEqual({ gui_probe: 99_000 });
    expect(options.extensionFactories).toHaveLength(1);
    const session = pool.session("W1");
    expect(session.getActiveToolNames()).toContain("gui_probe");
    expect(JSON.stringify(session.messages)).toContain("desktop ok");
    expect(session.systemPrompt).toContain("GUI-INSTRUCTIONS");
    expect(provider.events).toEqual(["start"]);
    await pool.dispose();
    expect(provider.events).toEqual(["start", "shutdown"]);
  });

  it("keeps workers without gui free of the capability", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const provider = guiProvider();
    const { pool, execute } = await fixture([report], provider.capability);
    const result = await execute();
    expect(result.details.gui).toBeUndefined();
    // Only the always-asked web-fetch capability (nobody provides it here), never the GUI.
    expect(provider.requests.map(request => request.capability)).toEqual(["web-fetch"]);
    expect(spawned.mock.calls[0]![0].extensionFactories).toBeUndefined();
    expect(pool.session("W1").getActiveToolNames()).not.toContain("gui_probe");
  });

  it("fails before spawning when nobody provides the capability, or the provider refuses", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const missing = await fixture([report]);
    await expect(missing.execute({ gui: true })).rejects.toThrow(/needs the pi-gui package/);
    const refused = await fixture([report], () => ({ error: "GUI unavailable: missing kwin_wayland (apt: kwin-wayland)" }));
    await expect(refused.execute({ gui: true })).rejects.toThrow(/gui: GUI unavailable: missing kwin_wayland/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it("reuses a GUI worker when gui is omitted, and replaces it when the capability changes", async () => {
    const provider = guiProvider();
    const { pool, execute } = await fixture([report, report, report], provider.capability);
    await execute({ gui: true });
    const kept = await execute({ worker: "W1" });
    expect(kept.details.worker).toBe("W1");
    expect(kept.details.gui).toBe(true);
    expect(provider.events).toEqual(["start"]);
    const replaced = await execute({ worker: "W1", gui: false });
    expect(replaced.details.worker).toBe("W2");
    expect(replaced.details.retired).toEqual(["W1"]);
    expect(replaced.details.gui).toBeUndefined();
    expect(provider.events).toEqual(["start", "shutdown"]);
    expect(pool.session("W2").getActiveToolNames()).not.toContain("gui_probe");
  });
});

/** A stand-in for pi-browser's `web-fetch`: one tool per worker session, its key switchable, or an error. */
function fetchProvider(options: { gui?: boolean } = {}) {
  const events: string[] = [];
  const requests: WorkerCapabilityRequest[] = [];
  const state: { key: string; error?: string } = { key: "fetch-1" };
  const factory: ExtensionFactory = pi => {
    pi.registerTool({
      name: "web_probe", label: "Web probe", description: "Read a public page", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "page ok" }], details: undefined }),
    });
    pi.on("session_start", () => { events.push("start"); });
    pi.on("session_shutdown", () => { events.push("shutdown"); });
  };
  const gui = guiProvider();
  const capability = (request: WorkerCapabilityRequest): WorkerCapabilityAnswer => {
    requests.push(request);
    if (request.capability === "gui" && options.gui) return gui.capability(request);
    if (request.capability !== "web-fetch") return undefined;
    return state.error ? { error: state.error } : { key: state.key, tools: ["web_probe"], extensionFactories: [factory], instructions: "FETCH-INSTRUCTIONS: public pages only", toolTimeoutsMs: { web_probe: 135_000 } };
  };
  return { events, requests, state, capability, gui };
}

describe("web-fetch capability (every worker)", () => {
  it("gives every worker its own instance of the provider's tool, without being asked by the task", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const provider = fetchProvider();
    const { pool, execute } = await fixture([tool("web_probe", {}), answerReport], provider.capability);
    const result = await execute({ role: "answer" });
    expect(result.details.webFetch).toBe(true);
    expect(provider.requests).toEqual([{ capability: "web-fetch", cwd: expect.any(String), workerId: "W1", role: "answer", readOnly: true }]);
    const options = spawned.mock.calls[0]![0];
    expect(options.tools).toContain("web_probe");
    // Main-only delegation tools are never inherited through a capability.
    expect(options.tools).not.toContain("orche_task");
    expect(options.toolTimeoutsMs).toEqual({ web_probe: 135_000 });
    const session = pool.session("W1");
    expect(session.getActiveToolNames()).toContain("web_probe");
    expect(session.getActiveToolNames()).not.toContain("orche_task");
    expect(JSON.stringify(session.messages)).toContain("page ok");
    expect(session.systemPrompt).toContain("FETCH-INSTRUCTIONS");
    expect(provider.events).toEqual(["start"]);
    await pool.dispose();
    expect(provider.events).toEqual(["start", "shutdown"]);
  });

  it("runs the task without the tool when the provider refuses, and tells the worker and main why", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const provider = fetchProvider();
    provider.state.error = "browser_fetch unavailable: obscura is not installed";
    const { pool, execute } = await fixture([report], provider.capability);
    const result = await execute();
    expect(result.details.webFetch).toBeUndefined();
    expect(result.details.webFetchUnavailable).toBe("browser_fetch unavailable: obscura is not installed");
    expect(spawned.mock.calls[0]![0].tools).not.toContain("web_probe");
    expect(spawned.mock.calls[0]![0].extensionFactories).toBeUndefined();
    expect(pool.session("W1").systemPrompt).toContain("browser_fetch unavailable: obscura is not installed");
  });

  it("merges it with the GUI capability and passes the writing role as not read-only", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const provider = fetchProvider({ gui: true });
    const implementReport = tool("report_result", { kind: "implement", summary: "Done", data: { status: "done", reason: "ok", evidence: [] } });
    const { pool, execute } = await fixture([implementReport, implementReport], provider.capability);
    await execute({ role: "implement", gui: true }).catch(() => undefined);
    expect(provider.requests.map(request => [request.capability, request.role, request.readOnly])).toEqual([["gui", "implement", false], ["web-fetch", "implement", false]]);
    const options = spawned.mock.calls[0]![0];
    expect(options.tools).toEqual(expect.arrayContaining(["gui_probe", "web_probe"]));
    expect(options.extensionFactories).toHaveLength(2);
    expect(options.toolTimeoutsMs).toEqual({ gui_probe: 99_000, web_probe: 135_000 });
    const prompt = pool.session("W1").systemPrompt;
    expect(prompt).toContain("GUI-INSTRUCTIONS");
    expect(prompt).toContain("FETCH-INSTRUCTIONS");
  });

  it("keeps a reused worker while the capability is unchanged, and replaces it when it changes or disappears", async () => {
    const provider = fetchProvider();
    const { pool, execute } = await fixture([report, report, report, report], provider.capability);
    await execute();
    expect((await execute({ worker: "W1" })).details.worker).toBe("W1");
    provider.state.key = "fetch-2";
    const changed = await execute({ worker: "W1" });
    expect(changed.details.worker).toBe("W2");
    expect(changed.details.retired).toEqual(["W1"]);
    expect(provider.events).toEqual(["start", "shutdown", "start"]);
    provider.state.error = "browser_fetch unavailable: obscura is not installed";
    const gone = await execute({ worker: "W2" });
    expect(gone.details.worker).toBe("W3");
    expect(gone.details.webFetchUnavailable).toMatch(/obscura is not installed/);
    expect(pool.session("W3").getActiveToolNames()).not.toContain("web_probe");
    expect(provider.events).toEqual(["start", "shutdown", "start", "shutdown"]);
  });
});

describe("web-fetch capability (orche_spawn sub-workers)", () => {
  it("loads a sub-worker's own instance with its own id and role, and ends it with the sub-worker", async () => {
    const provider = fetchProvider();
    const h = await createHarness({ mainSteps: [], orcheSteps: [tool("web_probe", {}), tool("report_result", { kind: "answer", summary: "Read it", data: {} })] });
    open.push({ h, pool: new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir }) });
    const run = createSubWorkerRunner({
      orchestrator: "W1", cwd: h.cwd, runtime: h.runtime, route: h.orche.route, routeSource: "orchestrator", thinkingSource: "orchestrator",
      specialistRoute: () => h.orche.route, prompt: worker => worker.request, timeoutMs: 30_000, maxTurns: 5,
      webFetch: planned => webFetchCapability(provider.capability, { cwd: h.cwd, workerId: planned.id, role: planned.role, readOnly: true }),
    });
    const { workers } = planSpawn({ reason: "isolation", workers: [{ name: "web", role: "answer", request: "Read the page" }] }, { nextId: () => "W1.1" });
    const outcome = await run(workers[0]!, workers, new AbortController().signal, () => undefined);
    expect(outcome.status).toBe("done");
    expect(provider.requests).toEqual([{ capability: "web-fetch", cwd: h.cwd, workerId: "W1.1", role: "answer", readOnly: true }]);
    expect(provider.events).toEqual(["start", "shutdown"]);
  });
});
