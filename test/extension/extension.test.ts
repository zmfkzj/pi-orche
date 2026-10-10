import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { ORCHE_USAGE, parseOrcheCommand, RESULT_MESSAGE_TYPE } from "../../src/extension/index.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConcurrentSession, ConcurrentSessionsResult, DetectConcurrentSessionsOptions } from "../../src/extension/concurrent-sessions.js";

const open: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of open.splice(0)) await harness.dispose();
});
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const created = await createHarness(...args);
  open.push(created);
  return created;
}
const lastUser = (context: { messages: { role: string }[] }) => JSON.stringify(context.messages.findLast(message => message.role === "user" || message.role === "custom" || message.role === "toolResult"));
interface Posted { content: unknown; display: boolean; details?: unknown }
const resultMessages = (h: Harness): Posted[] => h.session.messages.flatMap(message => message.role === "custom" && message.customType === RESULT_MESSAGE_TYPE ? [message] : []);

describe("pi-orche as a Pi extension (real AgentSession, faux providers)", () => {
  it("exposes exactly one read and one edit, both ours, plus the search/ast/diagnostics tools", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [], mainMode: "direct" });
    const active = h.session.getActiveToolNames();
    expect(active.filter(name => name === "read")).toHaveLength(1);
    expect(active.filter(name => name === "edit")).toHaveLength(1);
    expect(h.session.getToolDefinition("read")?.description).toContain("LINE#TAG");
    expect(h.session.getToolDefinition("edit")?.description).toContain("LINE#TAG");
    expect(active).toEqual(expect.arrayContaining([...WORKER_TOOL_NAMES]));
    expect(active).not.toContain("orche_run");
    expect(active).not.toContain("orche_task");
    expect(new Set(active).size).toBe(active.length);
  });

  it("long tool output from the main session is spilled to an artifact", async () => {
    let toolText = "";
    const h = await harness({
      mainSteps: [
        tool("bash", { command: "seq 1 6000" }),
        context => {
          toolText = JSON.stringify(context.messages.findLast(message => message.role === "toolResult"));
          return reply("ok");
        },
      ],
      orcheSteps: [],
      mainMode: "direct",
    });
    await h.session.prompt("print many lines");
    expect(toolText).toContain("Full output saved to .orche/artifacts/");
    expect(toolText.length).toBeLessThan(30_000);
  });

  it("/orche direct hands the prompt to the current session as a normal user turn, with no orchestration", async () => {
    let context = "";
    const h = await harness({
      mainSteps: [ctx => { context = JSON.stringify(ctx.messages); return reply("handled by the main agent"); }],
      orcheSteps: answerScript("MUST_NOT_RUN"),
    });
    await h.session.prompt("/orche direct rename greeting"); // the command stays pending until the turn settled
    expect(h.main.faux.state.callCount).toBe(1);
    expect(context).toContain("rename greeting");
    expect(h.session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("rename greeting"))).toBe(true);
    expect(h.session.messages.some(message => message.role === "assistant")).toBe(true);
    expect(resultMessages(h)).toHaveLength(0);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(h.orche.faux.getPendingResponseCount()).toBe(3);
    expect(h.notifications).toEqual([]);
  });

  it("/orche direct while the agent is busy (even in direct) is refused, not queued without its mode or run concurrently; a plain follow-up still queues", async () => {
    const gate = deferred();
    const entered = deferred();
    const seen: string[] = [];
    const h = await harness({
      mainSteps: [
        async ctx => { seen.push(JSON.stringify(ctx.messages)); entered.resolve(); await gate.promise; return reply("first done"); },
        ctx => { seen.push(JSON.stringify(ctx.messages)); return reply("second done"); },
      ],
      orcheSteps: [],
      mainMode: "direct",
    });
    const first = h.session.prompt("first request");
    await entered.promise;
    await h.session.prompt("/orche direct second request");
    expect(h.notifications.map(n => n.message).join()).toContain("orche direct: refused. The agent is busy");
    await h.session.followUp("third request");
    expect(h.main.faux.state.callCount).toBe(1);
    gate.resolve();
    await first;
    await h.session.agent.waitForIdle();
    expect(h.main.faux.state.callCount).toBe(2);
    expect(seen[0]).not.toContain("second request");
    expect(seen.join()).not.toContain("second request");
    expect(seen[1]).toContain("third request");
  });

  it("invalid commands print usage and start nothing", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: answerScript("MUST_NOT_RUN") });
    const invalid = ["", "single", "direct", "multi", "multi   ", "explain greeting.txt", "singlefoo bar", "Single x", "cancel now", "cancelled", "fix it multi", "stop", "stop W1 W2", "workers W1"];
    for (const args of invalid) await h.session.prompt(`/orche ${args}`.trimEnd());
    await h.session.agent.waitForIdle();
    expect(h.notifications).toHaveLength(invalid.length);
    for (const note of h.notifications) expect(note).toEqual({ message: ORCHE_USAGE, type: "warning" });
    expect(h.main.faux.state.callCount).toBe(0);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(resultMessages(h)).toHaveLength(0);
    expect(h.session.messages).toEqual([]);
  });

  it("parses the mode token strictly and keeps the prompt verbatim", () => {
    expect(parseOrcheCommand("single fix the bug")).toEqual({ mode: "single", prompt: "fix the bug" });
    expect(parseOrcheCommand("  single   line one\n  line two  ")).toEqual({ mode: "single", prompt: "  line one\n  line two  " }); // one delimiter after the mode word; the rest verbatim
    expect(parseOrcheCommand("multi fix")).toBeUndefined();
    expect(parseOrcheCommand("mode auto")).toBeUndefined();
    expect(parseOrcheCommand("mode multi")).toBeUndefined();
    expect(parseOrcheCommand(" cancel ")).toEqual({ mode: "cancel" });
    expect(parseOrcheCommand("direct fix")).toEqual({ mode: "direct", prompt: "fix" });
    expect(parseOrcheCommand(" workers ")).toEqual({ mode: "workers" });
    expect(parseOrcheCommand("stop W1")).toEqual({ mode: "stop", worker: "W1" });
    expect(parseOrcheCommand("stop all")).toEqual({ mode: "stop", worker: "all" });
    for (const bad of ["", " ", "single", "multi\n", "fix", "multiple things", "orche multi x", "cancel now", "cancel\nmulti x"]) expect(parseOrcheCommand(bad)).toBeUndefined();
  });

  const blockedUntilAbort = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
    entered.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
    return reply("aborted");
  };

  it("/orche cancel with nothing running says so and starts nothing", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: answerScript("MUST_NOT_RUN") });
    await h.session.prompt("/orche cancel");
    expect(h.notifications).toEqual([{ message: "no active orche task", type: "info" }]);
    expect(h.main.faux.state.callCount).toBe(0);
    expect(h.orche.faux.state.callCount).toBe(0);
    expect(h.session.messages).toEqual([]);
  });


});
