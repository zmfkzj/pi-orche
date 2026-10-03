import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import { createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool } from "../../src/extension/workers.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
async function harness(options: Parameters<typeof createHarness>[0]) {
  const h = await createHarness(options);
  open.push(h);
  return h;
}
const classify = decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "one unit" });
const implemented = tool("report_result", { kind: "implement", summary: "PRIVATE_IMPLEMENTER_CONTEXT", data: { status: "done" } });
const verification = (passed: boolean) => tool("report_result", {
  kind: "verify", summary: passed ? "checked" : "PRIVATE_VERIFIER_CONTEXT",
  data: { passed, issues: passed ? [] : ["boundary case missing"], evidence: ["greeting.txt"] },
});
const failed = () => [classify, implemented, verification(false),
  tool("report_result", { kind: "fix", summary: "PRIVATE_IMPLEMENTER_CONTEXT", data: { status: "done" } }), verification(false)];
const results = (h: Harness, name = "orche_run") => h.session.messages.flatMap(message =>
  message.role === "toolResult" && message.toolName === name ? [message] : []);
const textOf = (message: { content: { type: string; text?: string }[] }) => message.content.map(part => part.text ?? "").join("\n");

describe("extension failed-run recovery", () => {
  it("maps explorer sessions to explore and retains their context", async () => {
    let context = "";
    const h = await harness({ mainSteps: [], orcheSteps: [
      tool("report_result", { kind: "explore", summary: "PRIVATE_EXPLORER_CONTEXT" }),
      ctx => { context = JSON.stringify(ctx); return tool("report_result", { kind: "explore", summary: "continued exploration" }); },
    ] });
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
    const pool = new WorkerPool({ controller, agentDir: h.agentDir });
    const source = new AgentManager(h.runtime);
    try {
      await source.spawn({ id: "X1", role: "explorer-path", route: h.orche.route, cwd: h.cwd, instructions: "Explore only." });
      const session = source.session("X1");
      source.assign("X1", "explore", "Find the cause");
      expect(await source.wait("any", 1000)).toMatchObject({ type: "outcome" });
      const adopted = await pool.adoptFailedRun({ manager: source, workers: [{ id: "X1", role: "explorer" }], issues: ["cause unresolved"] }, h.cwd, 10);
      expect(adopted).toEqual([{ id: "W1", sourceId: "X1", role: "explore" }]);
      source.close();
      await source.dispose();
      expect(pool.session("W1")).toBe(session);
      expect((await pool.execute({ role: "explore", worker: "W1", request: "Continue finding the cause", cwd: h.cwd, projectTrusted: false })).details).toMatchObject({ worker: "W1", role: "explore" });
      expect(context).toContain("PRIVATE_EXPLORER_CONTEXT");
    } finally { await pool.dispose(); await source.dispose(); }
  });

  it("cancellation while preparing the pool prevents any transfer", async () => {
    const h = await harness({ mainSteps: [], orcheSteps: [] });
    const entered = deferred();
    const ready = deferred();
    const controller = new OrcheController({ createRuntime: async () => { entered.resolve(); await ready.promise; return h.runtime; } });
    const pool = new WorkerPool({ controller });
    const source = new AgentManager();
    const detach = vi.spyOn(source, "detach");
    const abort = new AbortController();
    try {
      const transfer = pool.adoptFailedRun({ manager: source, workers: [{ id: "A1", role: "implementer" }], issues: ["blocked"] }, h.cwd, 10, abort.signal);
      await entered.promise;
      abort.abort();
      ready.resolve();
      expect(await transfer).toEqual([]);
      expect(detach).not.toHaveBeenCalled();
      expect(pool.list()).toEqual([]);
    } finally { ready.resolve(); await pool.dispose(); await source.dispose(); }
  });

  it("hands workers to the pool without id collisions; implement and verify reuse the same sessions and retained context", async () => {
    const original = new Map<string, AgentSession>();
    const reused = new Map<string, AgentSession>();
    const assign = AgentManager.prototype.assign;
    vi.spyOn(AgentManager.prototype, "assign").mockImplementation(function (this: AgentManager, ...args) {
      if (args[0] === "W2" || args[0] === "W3") reused.set(args[0], this.session(args[0]));
      return assign.apply(this, args);
    });
    let fixContext = "";
    let verifyContext = "";
    const recovery: FauxResponseStep = context => {
      const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "orche_run")!;
      const id = textOf(message as { content: { type: string; text?: string }[] }).match(/\n(\w+) \(implement\)/)![1]!;
      return tool("orche_task", { role: "implement", worker: id, request: "Fix boundary case missing" });
    };
    const h = await harness({
      mainSteps: [tool("orche_task", { role: "answer", request: "inspect greeting" }), tool("orche_run", { request: "fix greeting" }),
        recovery, tool("orche_task", { role: "verify", worker: "W3", request: "Re-check boundary case" }), reply("done")],
      orcheSteps: [tool("report_result", { kind: "answer", summary: "existing worker" }), ...failed(),
        context => { fixContext = JSON.stringify(context); return tool("write", { path: "recovered.txt", content: "fixed\n" }); },
        tool("report_result", { kind: "implement", summary: "recovered", data: { status: "done" } }),
        context => { verifyContext = JSON.stringify(context); return verification(true); }],
      extension: { run: options => runOrchestrated({ ...options, onFailedHandover: async handover => {
        for (const worker of handover.workers) original.set(worker.id, handover.manager.session(worker.id));
        return options.onFailedHandover!(handover);
      } }) },
    });
    await h.session.prompt("go");
    const result = results(h)[0]!;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Handover (orche_task worker ids):\nW2 (implement) — last task: T1: fix greeting");
    expect(textOf(result)).toContain("W3 (verify) — last task: none");
    expect(textOf(result)).toMatch(/Remaining issues:.*boundary case missing/);
    expect(reused.get("W2")).toBe(original.get("A1"));
    expect(reused.get("W3")).toBe(original.get("V1"));
    expect(fixContext).toContain("PRIVATE_IMPLEMENTER_CONTEXT");
    expect(fixContext).toContain("Fix boundary case missing");
    expect(verifyContext).toContain("PRIVATE_VERIFIER_CONTEXT");
    expect(results(h, "orche_task").map(result => result.isError)).toEqual([false, false, false]);
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toContain("W1 idle");
    expect(h.notifications.at(-1)?.message).toContain("W2 idle · implement");
    expect(h.notifications.at(-1)?.message).toContain("W3 idle · verify");
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
    await h.session.prompt("/orche stop all");
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
  });

  it("adopted workers follow the pool idle TTL", async () => {
    const h = await harness({ mainSteps: [tool("orche_run", { request: "fix greeting" }), reply("noted")], orcheSteps: failed(),
      extension: { workerIdleTtlMs: 20 } });
    await h.session.prompt("go");
    expect(textOf(results(h)[0]!)).toContain("W1 (implement)");
    await new Promise(resolve => setTimeout(resolve, 50));
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
  });

  it("multi mode skips handover and explains remaining issues", async () => {
    const h = await harness({ mainSteps: [tool("orche_run", { request: "fix greeting" }), reply("noted")],
      orcheSteps: failed(), mainMode: "multi", extension: { run: options => {
        expect(options.onFailedHandover).toBeUndefined();
        return runOrchestrated(options);
      } } });
    await h.session.prompt("go");
    expect(textOf(results(h)[0]!)).toContain("Handover skipped: orche_task is disabled in multi mode.");
    expect(textOf(results(h)[0]!)).toMatch(/Remaining issues:.*boundary case missing/);
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
  });

  it("successful runs dispose workers and do not populate the pool", async () => {
    const h = await harness({ mainSteps: [tool("orche_run", { request: "fix greeting" }), reply("noted")],
      orcheSteps: [classify, implemented, verification(true)] });
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    await h.session.prompt("go");
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(textOf(results(h)[0]!)).not.toContain("Handover");
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
  });

  it.each(["user", "signal"] as const)("%s cancellation disposes live workers without handover", async cancellation => {
    const entered = deferred();
    const blocked: FauxResponseStep = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
      return reply("aborted");
    };
    const h = await harness({ mainSteps: [tool("orche_run", { request: "fix greeting" }), reply("noted")], orcheSteps: [classify, blocked] });
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const turn = h.session.prompt("go");
    await entered.promise;
    if (cancellation === "user") await h.session.prompt("/orche cancel");
    else await h.session.abort();
    await turn;
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(textOf(results(h)[0]!)).not.toContain("Handover");
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
  });
});
