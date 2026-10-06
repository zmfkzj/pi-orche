import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ThinkingContent } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { createHarness, tool, type Harness } from "./harness.js";

const opened: Harness[] = [];
const pools: WorkerPool[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const pool of pools.splice(0)) await pool.dispose();
  for (const h of opened.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
const report = () => tool("report_result", { kind: "explore", summary: "Evidence retained" });
const thinking = (text: string): ThinkingContent => ({ type: "thinking", thinking: text, thinkingSignature: `signed-${text}` });
const raw = (pool: WorkerPool) => structuredClone(pool.session("W1").messages.filter(message => message.role !== "system"));
const text = (message: AgentMessage) => !('content' in message) ? "" : typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("");
const capture = (requests: AgentMessage[][], next: FauxResponseStep): FauxResponseStep => (context, options, state, model) => {
  requests.push(structuredClone(context.messages.filter(message => message.role !== "system")));
  return typeof next === "function" ? next(context, options, state, model) : next;
};
async function fixture(steps: FauxResponseStep[], taskContext?: { clearBetweenAssignments?: boolean; minClearTokens?: number }, records = false) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps, taskContext, records });
  opened.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  await writeFile(join(h.cwd, "large.txt"), Array(22).fill("L".repeat(2000)).join("\n") + "\n.orche/artifacts/original.txt\n");
  await writeFile(join(h.cwd, "medium.txt"), "M".repeat(2000) + "\n");
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  pools.push(pool);
  const execute = (args: Partial<TaskParameters> = {}) => pool.execute({ cwd: h.cwd, projectTrusted: false, role: "explore", request: "Assignment prompt", ...args });
  const setting = async (value: unknown) => {
    const file = join(h.agentDir, "orche.config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...config, taskContext: value }));
  };
  return { h, pool, execute, setting, controller };
}
function assertPaired(messages: AgentMessage[]) {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      expect(message.content.length).toBeGreaterThan(0);
      for (const block of message.content) if (block.type === "toolCall") {
        expect(messages.slice(index + 1).some(result => result.role === "toolResult" && result.toolCallId === block.id)).toBe(true);
      }
    }
    if (message.role === "toolResult") expect(messages.slice(0, index).some(assistant => assistant.role === "assistant" && assistant.content.some(block => block.type === "toolCall" && block.id === message.toolCallId))).toBe(true);
  }
}

describe("persistent task assignment context projection", () => {
  it("projects real provider requests once per reused assignment, preserving calls, prompts, artifacts, pairing and raw records", async () => {
    const requests: AgentMessage[][] = [];
    const { h, pool, execute } = await fixture([
      reply([thinking("before-clear"), { type: "text", text: "Keep first assistant text", textSignature: "text-before" }, call("read", { path: "large.txt" })], { stopReason: "toolUse" }),
      reply([thinking("after-clear"), { type: "text", text: "Keep later assistant text", textSignature: "text-after" }, call("bash", { command: "printf '%15000d' 0; exit 1" })], { stopReason: "toolUse" }),
      reply([thinking("later"), call("read", { path: "greeting.txt" })], { stopReason: "toolUse" }),
      reply([thinking("only-thinking")]),
      reply([thinking("report-thinking"), call("report_result", { kind: "explore", summary: "First assignment" })], { stopReason: "toolUse" }),
      capture(requests, reply([thinking("current-thinking"), call("read", { path: "greeting.txt" })], { stopReason: "toolUse" })),
      capture(requests, reply([thinking("current-nudge-thinking")])),
      capture(requests, report()),
    ], undefined, true);
    const first = await execute({ request: "FIRST assignment" });
    expect(first.details.contextCleared).toBeUndefined();
    const original = raw(pool);
    const boundary = original.length;
    const second = await execute({ worker: "W1", request: "SECOND assignment" });
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(JSON.stringify(request.slice(0, boundary))).toBe(JSON.stringify(requests[0]!.slice(0, boundary)));
    const projected = requests[0]!.slice(0, boundary);
    expect(projected).toHaveLength(original.length);
    const earliest = original.findIndex(message => message.role === "toolResult" && message.toolName === "read");
    for (let index = 0; index < boundary; index++) {
      const before = original[index]!;
      const after = projected[index]!;
      if (before.role === "toolResult" && before.toolName !== "report_result" && text(before).length > 600) {
        expect(text(after)).toContain(`[Earlier ${before.toolName} result cleared to save context (${text(before).length} chars). Repeat the call if you need it.`);
        expect({ ...after, content: before.content }).toEqual(before);
      } else if (before.role === "assistant" && index > earliest) {
        const remaining = before.content.filter(block => block.type !== "thinking");
        expect(after).toEqual({ ...before, content: remaining.length ? remaining : [{ type: "text", text: "[earlier reasoning omitted]" }] });
      } else expect(after).toEqual(before);
    }
    expect(JSON.stringify(projected)).toContain("signed-before-clear");
    expect(JSON.stringify(projected)).not.toContain("signed-after-clear");
    expect(JSON.stringify(projected)).toContain("[earlier reasoning omitted]");
    expect(JSON.stringify(projected)).toContain("Full output: .orche/artifacts/original.txt");
    expect(JSON.stringify(projected)).toMatch(/Full output: \.orche\/artifacts\/bash-/);
    expect(projected.find(message => message.role === "toolResult" && message.toolName === "bash")).toMatchObject({ isError: true });
    const currentRaw = raw(pool);
    expect(requests[0]![boundary]).toEqual(currentRaw[boundary]);
    expect(text(currentRaw[boundary]!)).toContain("## Stale context:");
    expect(text(currentRaw[boundary]!)).toContain("SECOND assignment");
    expect(JSON.stringify(requests[1]!.slice(boundary))).toContain("signed-current-thinking");
    expect(JSON.stringify(requests[2]!.slice(boundary))).toContain("signed-current-nudge-thinking");
    for (const request of requests) assertPaired(request);
    expect(currentRaw.slice(0, boundary)).toEqual(original);
    expect(second.details.contextCleared).toMatchObject({ results: 2, thinkingBlocks: 4 });
    const stats = second.details.contextCleared!;
    expect(stats.estTokens).toBe(original.filter(message => message.role === "toolResult" && ["read", "bash"].includes(message.toolName) && text(message).length > 600).reduce((sum, message) => sum + text(message).length / 4, 0));
    expect(second.text).toContain(`Context: cleared 2 earlier tool results (~${Math.round(stats.estTokens)} tokens est.) and 4 thinking blocks at assignment start; repeat a call to restore its output.`);
    const manifest = JSON.parse(await readFile(join(second.details.record!, "run.json"), "utf8"));
    expect(manifest.worker.sessionFile).toBe(pool.session("W1").sessionFile);
    const entries = (await readFile(manifest.worker.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const recorded = entries.filter(entry => entry.type === "message" && entry.message.role !== "system").map(entry => entry.message);
    expect(recorded).toEqual(currentRaw);
    expect(JSON.stringify(recorded)).toContain("L".repeat(2000));
    expect(JSON.stringify(recorded)).not.toContain("Earlier read result cleared");
    const events = (await readFile(join(second.details.record!, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "context_cleared")).toEqual([expect.objectContaining({ agentId: "W1", contextCleared: stats })]);
    expect((await readFile(join(h.cwd, ".orche", "artifacts", text(projected.find(message => message.role === "toolResult" && message.toolName === "bash")!).match(/Full output: \.orche\/artifacts\/([^\]]+)/)![1]!), "utf8")).length).toBeGreaterThanOrEqual(15000);
  });

  it("below the threshold sends exactly the original prior messages, including thinking", async () => {
    const requests: AgentMessage[][] = [];
    const { pool, execute } = await fixture([
      reply([thinking("small-before"), call("read", { path: "medium.txt" })], { stopReason: "toolUse" }),
      reply([thinking("small-after"), call("report_result", { kind: "explore", summary: "Done" })], { stopReason: "toolUse" }),
      capture(requests, report()),
    ]);
    await execute();
    const original = raw(pool);
    const second = await execute({ worker: "W1" });
    expect(requests[0]!.slice(0, original.length)).toEqual(original);
    expect(second.details.contextCleared).toBeUndefined();
    expect(second.text).not.toContain("Context: cleared");
  });

  it("applies a changed minClearTokens setting only at the next assignment boundary", async () => {
    const requests: AgentMessage[][] = [];
    const { pool, execute, setting } = await fixture([tool("read", { path: "medium.txt" }), report(), capture(requests, tool("read", { path: "greeting.txt" })), capture(requests, report()), capture(requests, report())]);
    await execute();
    const original = raw(pool);
    await execute({ worker: "W1" });
    expect(requests[0]!.slice(0, original.length)).toEqual(original);
    expect(requests[1]!.slice(0, original.length)).toEqual(original);
    await setting({ minClearTokens: 0 });
    const third = await execute({ worker: "W1" });
    expect(third.details.contextCleared?.results).toBe(1);
    expect(JSON.stringify(requests[2])).toContain("Earlier read result cleared");
    expect(JSON.stringify(requests[2])).not.toContain("M".repeat(2000));
  });

  it("keeps a no-new-clear boundary byte-identical with no event or result line", async () => {
    const requests: AgentMessage[][] = [];
    const { pool, execute } = await fixture([
      tool("read", { path: "large.txt" }), report(),
      capture(requests, reply([thinking("second-current"), call("report_result", { kind: "explore", summary: "Done" })], { stopReason: "toolUse" })),
      capture(requests, report()),
    ], undefined, true);
    await execute();
    expect((await execute({ worker: "W1" })).details.contextCleared?.results).toBe(1);
    const original = raw(pool);
    const previousProjection = [...requests[0]!, ...original.slice(requests[0]!.length)];
    const third = await execute({ worker: "W1" });
    expect(third.details.contextCleared).toBeUndefined();
    expect(third.text).not.toContain("Context: cleared");
    expect(JSON.stringify(requests[1]!.slice(0, original.length))).toBe(JSON.stringify(previousProjection));
    expect(JSON.stringify(requests[1])).toContain("signed-second-current");
    const eventsText = await readFile(join(third.details.record!, "events.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const events = eventsText.split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "context_cleared")).toEqual([]);
  });


  it("keeps earlier placeholders stable over four assignments and counts only newly clearable output", async () => {
    const secondRequests: AgentMessage[][] = [];
    const thirdRequests: AgentMessage[][] = [];
    const fourthRequests: AgentMessage[][] = [];
    const { pool, execute } = await fixture([
      tool("read", { path: "large.txt" }), report(),
      capture(secondRequests, tool("read", { path: "medium.txt" })), capture(secondRequests, report()),
      capture(thirdRequests, tool("read", { path: "large.txt" })), capture(thirdRequests, report()),
      capture(fourthRequests, report()),
    ]);
    await execute();
    const firstBoundary = raw(pool).length;
    expect((await execute({ worker: "W1" })).details.contextCleared?.results).toBe(1);
    const secondBoundary = raw(pool).length;
    const third = await execute({ worker: "W1" });
    expect(third.details.contextCleared).toBeUndefined();
    for (const request of [...secondRequests, ...thirdRequests]) expect(JSON.stringify(request.slice(0, firstBoundary))).toBe(JSON.stringify(secondRequests[0]!.slice(0, firstBoundary)));
    expect(JSON.stringify(thirdRequests[0])).toContain("M".repeat(2000));
    // A newly large result acquired mid-assignment is not cleared in that assignment.
    expect(JSON.stringify(thirdRequests[1]!.slice(secondBoundary))).toContain("L".repeat(2000));
    const fourth = await execute({ worker: "W1" });
    expect(fourth.details.contextCleared?.results).toBe(2);
    expect(JSON.stringify(fourthRequests[0]!.slice(0, firstBoundary))).toBe(JSON.stringify(secondRequests[0]!.slice(0, firstBoundary)));
    expect(JSON.stringify(fourthRequests[0])).not.toContain("M".repeat(2000));
    expect(JSON.stringify(fourthRequests[0])).not.toContain("L".repeat(2000));
    for (const request of [...secondRequests, ...thirdRequests, ...fourthRequests]) assertPaired(request);
  });

  it("reads disabled settings at every task call without dropping an existing projection", async () => {
    const requests: AgentMessage[][] = [];
    const { pool, execute, setting } = await fixture([tool("read", { path: "large.txt" }), report(), capture(requests, report()), capture(requests, report()), capture(requests, report()), capture(requests, report())], { clearBetweenAssignments: false });
    await execute();
    const original = raw(pool);
    expect((await execute({ worker: "W1" })).details.contextCleared).toBeUndefined();
    expect(requests[0]!.slice(0, original.length)).toEqual(original);
    await setting({ clearBetweenAssignments: true });
    expect((await execute({ worker: "W1" })).details.contextCleared?.results).toBe(1);
    const clearedPrefix = JSON.stringify(requests[1]!.slice(0, original.length));
    await setting({ clearBetweenAssignments: false });
    expect((await execute({ worker: "W1" })).details.contextCleared).toBeUndefined();
    expect(JSON.stringify(requests[2]!.slice(0, original.length))).toBe(clearedPrefix);
    await setting({ clearBetweenAssignments: true });
    expect((await execute({ worker: "W1" })).details.contextCleared).toBeUndefined();
    expect(JSON.stringify(requests[3]!.slice(0, original.length))).toBe(clearedPrefix);
  });

  it("rejects invalid settings before dispatching another assignment", async () => {
    const { h, pool, execute, setting } = await fixture([report()]);
    await execute();
    const original = raw(pool);
    for (const value of [{ typo: true }, { clearBetweenAssignments: "no" }, { minClearTokens: -1 }, { minClearTokens: 1.5 }]) {
      await setting(value);
      await expect(execute({ worker: "W1" })).rejects.toThrow("config.taskContext");
      expect(raw(pool)).toEqual(original);
      expect(h.orche.faux.state.callCount).toBe(1);
    }
  });



  it("default AgentManager sessions (the orche_run path) are unprojected even when reused", async () => {
    const requests: AgentMessage[][] = [];
    const { h } = await fixture([tool("read", { path: "large.txt" }), report(), capture(requests, report())]);
    const manager = new AgentManager(h.runtime);
    managers.push(manager);
    await manager.spawn({ id: "A1", role: "explorer-path", route: h.orche.route, cwd: h.cwd, instructions: "test", tools: ["read"] });
    manager.assign("A1", "explore", "first");
    expect((await manager.wait("A1", 5000)).type).toBe("outcome");
    const original = structuredClone(manager.session("A1").messages.filter(message => message.role !== "system"));
    manager.assign("A1", "explore", "second");
    expect((await manager.wait("A1", 5000)).type).toBe("outcome");
    expect(requests[0]!.slice(0, original.length)).toEqual(original);
    expect(JSON.stringify(requests[0])).toContain("L".repeat(2000));
  });

});
