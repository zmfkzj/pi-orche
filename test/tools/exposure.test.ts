import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { READ_ONLY_TOOL_NAMES, WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";

const managers: AgentManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
});

describe("tool exposure", () => {
  it("workers spawned by default expose exactly the worker set: one read, one edit, ours", async () => {
    const f = await fauxRuntime();
    const manager = new AgentManager(f.runtime);
    managers.push(manager);
    await manager.spawn({ id: "w", role: "worker", route: f.route, modelRuntime: f.runtime, cwd: process.cwd(), instructions: "x" });
    const session = manager.session("w");
    const active = session.getActiveToolNames();
    expect([...active].sort()).toEqual([...WORKER_TOOL_NAMES, "report_result", "send_message"].sort());
    expect(active.filter((n) => n === "read")).toHaveLength(1);
    expect(active.filter((n) => n === "edit")).toHaveLength(1);
    expect(session.getToolDefinition("read")?.description).toContain("LINE#TAG");
    expect(session.getToolDefinition("edit")?.description).toContain("LINE#TAG");
  });

  it("read-only list has no edit/write/bash and sessions honour baseSystemPrompt", async () => {
    const f = await fauxRuntime();
    const session = await createSession({
      route: f.route,
      cwd: process.cwd(),
      tools: [...READ_ONLY_TOOL_NAMES],
      instructions: "ROLE_INSTRUCTIONS",
      baseSystemPrompt: "CUSTOM_BASE",
      modelRuntime: f.runtime,
    });
    try {
      expect([...session.getActiveToolNames()].sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());
      expect(session.systemPrompt).toContain("CUSTOM_BASE");
      expect(session.systemPrompt).toContain("ROLE_INSTRUCTIONS");
      expect(session.systemPrompt).not.toContain("expert coding assistant");
    } finally {
      session.dispose();
    }
  });
});
