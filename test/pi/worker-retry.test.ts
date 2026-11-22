import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager, type AgentSession, type RetrySettings } from "@earendil-works/pi-coding-agent";
import { createSession, hostRetrySettings, workerRetrySettings } from "../../src/pi/session-factory.js";
import { createSubWorkerRunner } from "../../src/orchestrator/sub-worker.js";
import type { PlannedWorker } from "../../src/orchestrator/spawn.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * orche sessions take the user's own Pi `retry` settings (global settings.json merged with a trusted project's .pi/settings.json,
 * the view `pi.getSettings()` gives the extension) instead of a fixed worker policy; unset fields fall back to Pi's defaults.
 */
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orche-worker-retry-"));
  roots.push(root);
  return root;
}

/** A user's Pi settings files (global in agentDir, project in cwd/.pi), read by Pi's own SettingsManager as the host does. */
async function hostSettings(files: { global?: object; project?: object }, projectTrusted: boolean) {
  const root = await temp();
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  if (files.global) await writeFile(join(agentDir, "settings.json"), JSON.stringify(files.global));
  if (files.project) await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(files.project));
  return { cwd, host: SettingsManager.create(cwd, agentDir, { projectTrusted }) };
}

/** The retry settings a worker session created from the host's settings really runs with. */
async function workerRetry(retry: RetrySettings | undefined, cwd?: string) {
  const f = await fauxRuntime([]);
  const session = await createSession({ cwd: cwd ?? await temp(), route: f.route, modelRuntime: f.runtime, tools: [], instructions: "test", ...(retry ? { retry } : {}) });
  sessions.push(session);
  return { agent: session.settingsManager.getRetrySettings(), provider: session.settingsManager.getProviderRetrySettings() };
}

const piDefaults = () => {
  const pi = SettingsManager.inMemory({});
  return { agent: pi.getRetrySettings(), provider: pi.getProviderRetrySettings() };
};

describe("worker sessions inherit the user's Pi retry settings", () => {
  it("without any retry config a worker runs on Pi's own defaults (not a fixed orche policy)", async () => {
    const { cwd, host } = await hostSettings({}, true);
    const retry = hostRetrySettings(() => host.getSettings().retry);
    expect(retry).toBeUndefined();
    const seen = await workerRetry(retry, cwd);
    expect(seen).toEqual(piDefaults());
    expect(seen.agent).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 });
  });

  it("global settings.json: every retry field reaches the worker, including retry.provider.*; unset fields are Pi's defaults", async () => {
    const { cwd, host } = await hostSettings({ global: { retry: { maxRetries: 6, baseDelayMs: 5000, provider: { maxRetries: 2, timeoutMs: 600_000, maxRetryDelayMs: 30_000 } } } }, true);
    const seen = await workerRetry(hostRetrySettings(() => host.getSettings().retry), cwd);
    expect(seen.agent).toEqual({ enabled: true, maxRetries: 6, baseDelayMs: 5000, maxAgentDelayMs: piDefaults().agent.maxAgentDelayMs });
    expect(seen.provider).toEqual({ maxRetries: 2, timeoutMs: 600_000, maxRetryDelayMs: 30_000 });
  });

  it("a trusted project's .pi/settings.json overrides single fields (also one provider field) and keeps the global rest", async () => {
    const files = {
      global: { retry: { maxRetries: 6, baseDelayMs: 5000, provider: { maxRetries: 2, maxRetryDelayMs: 30_000 } } },
      project: { retry: { maxRetries: 1, provider: { timeoutMs: 90_000 } } },
    };
    const trusted = await hostSettings(files, true);
    const seen = await workerRetry(hostRetrySettings(() => trusted.host.getSettings().retry), trusted.cwd);
    expect(seen.agent).toMatchObject({ maxRetries: 1, baseDelayMs: 5000 });
    expect(seen.provider).toEqual({ maxRetries: 2, timeoutMs: 90_000, maxRetryDelayMs: 30_000 });
    // The same project untrusted: Pi ignores its settings, so does the worker.
    const untrusted = await hostSettings(files, false);
    const plain = await workerRetry(hostRetrySettings(() => untrusted.host.getSettings().retry), untrusted.cwd);
    expect(plain.agent).toMatchObject({ maxRetries: 6, baseDelayMs: 5000 });
    expect(plain.provider).toEqual({ maxRetries: 2, timeoutMs: undefined, maxRetryDelayMs: 30_000 });
  });

  it("false and 0 are kept as the user set them", async () => {
    const seen = await workerRetry({ enabled: false, maxRetries: 0, baseDelayMs: 0, provider: { maxRetries: 0 } });
    expect(seen.agent).toMatchObject({ enabled: false, maxRetries: 0, baseDelayMs: 0 });
    expect(seen.provider.maxRetries).toBe(0);
  });

  it("the worker keeps a copy: later changes of the host's object do not reach a living session", async () => {
    const retry: RetrySettings = { maxRetries: 4, provider: { maxRetries: 1 } };
    const copied = workerRetrySettings(retry).retry!;
    retry.maxRetries = 9;
    retry.provider!.maxRetries = 9;
    expect(copied).toEqual({ maxRetries: 4, provider: { maxRetries: 1 } });
  });

  it("a host that cannot tell (no reader, a throwing older Pi, not an object) leaves Pi's defaults", () => {
    expect(hostRetrySettings(undefined)).toBeUndefined();
    expect(hostRetrySettings(() => { throw new Error("getSettings is not a function"); })).toBeUndefined();
    expect(hostRetrySettings(() => "fast" as unknown as RetrySettings)).toBeUndefined();
    expect(hostRetrySettings(() => [] as unknown as RetrySettings)).toBeUndefined();
    expect(workerRetrySettings(undefined)).toEqual({});
  });
});

describe("orche_spawn sub-workers retry by the inherited settings", () => {
  const overloaded = () => reply("", { stopReason: "error", errorMessage: "503 Service unavailable: overloaded" }) as AssistantMessage;
  const report = reply([call("report_result", { kind: "answer", summary: "done", data: { evidence: ["x"] } } as never)], { stopReason: "toolUse" });
  async function run(retry: RetrySettings | undefined) {
    const cwd = await temp();
    const faux = await fauxRuntime([overloaded(), overloaded(), report]);
    const events: string[] = [];
    const runner = createSubWorkerRunner({
      orchestrator: "W1", cwd, runtime: faux.runtime, route: faux.route, routeSource: "orchestrator", thinkingSource: "orchestrator",
      specialistRoute: () => faux.route, prompt: worker => worker.request, timeoutMs: 30_000, maxTurns: 6,
      onSessionEvent: (_id, event) => { if (event.type === "auto_retry_start") events.push(`${String(event.attempt)}/${String(event.maxAttempts)}@${String(event.delayMs)}`); },
      ...(retry ? { retry } : {}),
    });
    const worker: PlannedWorker = { id: "W1.1", name: "w", role: "answer", request: "Answer it", reason: "parallelism" };
    const outcome = await runner(worker, [worker], new AbortController().signal, () => undefined);
    return { outcome, events };
  }

  it("a user retry config: the sub-worker retries the failed calls with the user's count and backoff, then succeeds", async () => {
    const { outcome, events } = await run({ maxRetries: 2, baseDelayMs: 3, maxAgentDelayMs: 5 });
    expect(events).toEqual(["1/2@3", "2/2@5"]);
    expect(outcome).toMatchObject({ summary: "done" });
  });

  it("retry disabled by the user: the first provider failure ends the sub-worker", async () => {
    const { outcome, events } = await run({ enabled: false });
    expect(events).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/503|overloaded/i) });
  });
});
