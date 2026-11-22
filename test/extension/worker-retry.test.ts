import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage as reply, type AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager, type RetrySettings } from "@earendil-works/pi-coding-agent";
import { WorkerPool } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * orche_task workers retry failed provider calls by the user's own Pi `retry` settings: the extension hands the pool
 * `pi.getSettings().retry` (global settings.json merged with a trusted project's), and without any the worker runs on Pi's defaults.
 */
const opened: Array<Harness | WorkerPool> = [];
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.dispose(); });

const overloaded = () => reply("", { stopReason: "error", errorMessage: "503 Service unavailable: overloaded" }) as AssistantMessage;
const explored = tool("report_result", { kind: "explore", summary: "Evidence found" });
type RetryView = { getRetrySettings(): ReturnType<SettingsManager["getRetrySettings"]>; getProviderRetrySettings(): ReturnType<SettingsManager["getProviderRetrySettings"]> };
const workerSettings = (pool: WorkerPool) => (pool as unknown as { manager: { session(id: string): { settingsManager: RetryView } } }).manager.session("W1").settingsManager;

describe("orche_task workers inherit the main session's Pi retry settings (real extension)", () => {
  async function delegate(settings: Record<string, unknown> | undefined, orcheSteps: ReturnType<typeof overloaded | typeof reply>[]) {
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt" }), reply("relayed")],
      orcheSteps, ...(settings ? { settings } : {}),
    });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await h.session.prompt("delegate");
    const result = h.session.messages.find(message => message.role === "toolResult" && (message as unknown as { toolName?: string }).toolName === "orche_task") as unknown as { content: { text?: string }[]; details?: Record<string, unknown> };
    return { text: result.content.map(part => part.text ?? "").join("\n"), details: result.details ?? {} };
  }

  it("retry.maxRetries 4 with a short backoff: the worker gets through four failed provider calls (Pi's default allows three)", async () => {
    const { text, details } = await delegate({ retry: { maxRetries: 4, baseDelayMs: 3, maxAgentDelayMs: 5 } }, [overloaded(), overloaded(), overloaded(), overloaded(), explored]);
    expect(details.status).toBe("completed");
    expect(text).toContain("Evidence found");
  });

  it("retry.enabled false: the worker's first provider failure ends the task (no retry)", async () => {
    const { text, details } = await delegate({ retry: { enabled: false } }, [overloaded(), explored]);
    expect(details.status).not.toBe("completed");
    expect(text).toMatch(/503|overloaded/i);
  });
});

describe("WorkerPool: the worker session's retry settings", () => {
  async function pool(retry?: () => RetrySettings | undefined) {
    const h = await createHarness({ mainSteps: [], orcheSteps: [explored] });
    opened.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const workers = new WorkerPool({ controller, agentDir: h.agentDir, ...(retry ? { retry } : {}) });
    opened.push(workers);
    const result = await workers.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false });
    expect(result.details.status).toBe("completed");
    return workerSettings(workers);
  }
  const defaults = SettingsManager.inMemory({});

  it("with the host's retry settings: agent and provider fields as the user set them, the rest Pi's defaults", async () => {
    const settings = await pool(() => ({ maxRetries: 5, baseDelayMs: 4000, provider: { maxRetries: 1, timeoutMs: 120_000 } }));
    expect(settings.getRetrySettings()).toEqual({ enabled: true, maxRetries: 5, baseDelayMs: 4000, maxAgentDelayMs: defaults.getRetrySettings().maxAgentDelayMs });
    expect(settings.getProviderRetrySettings()).toEqual({ maxRetries: 1, timeoutMs: 120_000, maxRetryDelayMs: defaults.getProviderRetrySettings().maxRetryDelayMs });
  });

  it("without host retry settings (none set, or a host that throws): Pi's defaults", async () => {
    for (const retry of [undefined, () => undefined, () => { throw new Error("older Pi"); }]) {
      const settings = await pool(retry);
      expect(settings.getRetrySettings()).toEqual(defaults.getRetrySettings());
      expect(settings.getProviderRetrySettings()).toEqual(defaults.getProviderRetrySettings());
    }
  });
});
