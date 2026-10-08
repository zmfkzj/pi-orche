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
import { WorkerPool, type WorkerCapabilityAnswer, type WorkerCapabilityRequest } from "../../src/extension/workers.js";
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
  const execute = (options: { worker?: string; gui?: boolean } = {}) => pool.execute({ role: "explore", request: "Look at the app", cwd: h.cwd, projectTrusted: false, ...options });
  return { h, pool, execute };
}
const report = tool("report_result", { kind: "explore", summary: "Done", data: { status: "done" } });

describe("orche_task gui capability", () => {
  it("loads the provider's extensions into the worker session only, with its tools, instructions and timeouts", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const provider = guiProvider();
    const { pool, execute } = await fixture([tool("gui_probe", {}), report], provider.capability);
    const result = await execute({ gui: true });
    expect(result.details.gui).toBe(true);
    expect(provider.requests).toEqual([{ capability: "gui", cwd: expect.any(String), workerId: "W1" }]);
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
    expect(provider.requests).toEqual([]);
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
