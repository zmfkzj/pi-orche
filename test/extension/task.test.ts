import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { ORCHE_USAGE } from "../../src/extension/index.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

const open: Harness[] = [];
const pools = new Set<WorkerPool>();
afterEach(async () => {
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
const result = (role = "explore", summary = "Evidence found", data?: ToolCall["arguments"][string]) => tool("report_result", { kind: role, summary, ...(data === undefined ? {} : { data }) });
async function harness(options: Parameters<typeof createHarness>[0]) {
  const h = await createHarness(options);
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  return h;
}
function capturePool() {
  const execute = WorkerPool.prototype.execute;
  vi.spyOn(WorkerPool.prototype, "execute").mockImplementation(function (this: WorkerPool, args) {
    pools.add(this);
    return execute.call(this, args);
  });
}
async function fixture(steps: FauxResponseStep[], idleTtlMs?: number) {
  const h = await harness({ mainSteps: [], orcheSteps: steps });
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, idleTtlMs });
  pools.add(pool);
  const execute = (args: Partial<TaskParameters> = {}, signal?: AbortSignal) => pool.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false, ...args, signal });
  return { h, pool, controller, execute };
}
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};
const taskResults = (h: Harness) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === "orche_task");

describe("orche_task persistent session workers", () => {
  it("registers the tool, spawns W1, reports evidence, audit and stable roster", async () => {
    capturePool();
    const h = await harness({ mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt", context: "Background evidence", files: ["ignored*"] }), reply("supervised")], orcheSteps: [result()] });
    await h.session.prompt("investigate");
    const text = JSON.stringify(taskResults(h));
    expect(text).toContain("orche task W1 (explore");
    expect(text).toContain("Evidence found");
    expect(text).toContain("No files changed");
    expect(text).toContain("Workers: W1 idle (explore");
    expect(text).toContain("files ignored for read-only role");
    expect(text).not.toContain("consider orche_run");
    const pool = [...pools][0]!;
    expect(pool.list()[0]).toMatchObject({ id: "W1", completedAssignments: 1 });
    const session = pool.session("W1");
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "edit", "write", "ast_rewrite", "report_result"]));
    expect(session.getActiveToolNames()).not.toContain("send_message");
    expect(JSON.stringify(session.messages)).toContain("Context from the requesting session");
  });

  it("reuses the same session across roles and identifies stale workspace context", async () => {
    const { h, pool, execute } = await fixture([result("explore", "First evidence"), result("implement", "Second evidence", { status: "done" })]);
    await execute({ request: "FIRST_PROMPT" });
    const original = pool.session("W1");
    await writeFile(join(h.cwd, "greeting.txt"), "changed externally\n");
    const second = await execute({ worker: "W1", role: "implement", request: "SECOND_PROMPT" });
    expect(pool.session("W1")).toBe(original);
    expect(pool.list()[0]?.completedAssignments).toBe(2);
    const messages = JSON.stringify(original.messages);
    expect(messages).toContain("FIRST_PROMPT");
    expect(messages).toContain("SECOND_PROMPT");
    expect(messages).toContain("Stale context");
    expect(messages).toContain("greeting.txt (modified)");
    expect(second.text).toContain("No files changed");
  });

  it("enforces implement ownership before writes and audits the allowed write", async () => {
    let rejected = "";
    const { h, execute } = await fixture([
      tool("write", { path: "other.txt", content: "forbidden" }),
      context => { rejected = JSON.stringify(context.messages); return tool("write", { path: "allowed.txt", content: "allowed" }); },
      result("implement", "Scoped change", { status: "done" }),
    ]);
    const outcome = await execute({ role: "implement", files: ["allowed.txt"] });
    expect(rejected).toContain("outside your owned files");
    await expect(readFile(join(h.cwd, "other.txt"))).rejects.toThrow();
    expect(await readFile(join(h.cwd, "allowed.txt"), "utf8")).toBe("allowed");
    expect(outcome.text).toContain("Changed files: allowed.txt");
    expect(outcome.details.changes).toEqual([{ path: "allowed.txt", status: "added" }]);
  });

  for (const explicit of [true, false]) it(`blocks a symlinked allowed.txt before execution (explicit scope: ${explicit})`, async context => {
    let rejected = "";
    const { h, execute } = await fixture([
      tool("write", { path: "allowed.txt", content: "forbidden" }),
      messages => { rejected = JSON.stringify(messages.messages); return result("implement", "Link blocked", { status: "blocked" }); },
    ]);
    await writeFile(join(h.cwd, "other.txt"), "unchanged");
    try { await symlink("other.txt", join(h.cwd, "allowed.txt"), "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) context.skip("symlink creation unavailable");
      else throw error;
    }
    const outcome = await execute({ role: "implement", ...(explicit ? { files: ["allowed.txt"] } : {}) });
    expect(rejected).toContain("outside your owned files (");
    expect(rejected).toContain("symlink to other.txt");
    expect(await readFile(join(h.cwd, "other.txt"), "utf8")).toBe("unchanged");
    expect(outcome.details.changes).toEqual([]);
  });

  it("blocks edit in explore as read-only and rejects unsupported implement globs", async () => {
    let rejected = "";
    const { h, execute } = await fixture([tool("edit", { path: "greeting.txt", edits: [] }), context => { rejected = JSON.stringify(context.messages); return result(); }]);
    await execute();
    expect(rejected).toContain("assignment explore is read-only");
    expect(await readFile(join(h.cwd, "greeting.txt"), "utf8")).toBe("hello world\n");
    await expect(execute({ role: "implement", files: ["src/*.ts"] })).rejects.toThrow("Unsupported ownership path");
  });

  it("unknown and disposed ids list live workers rather than inventing reused context", async () => {
    const { pool, execute } = await fixture([result(), result()]);
    await execute();
    await expect(execute({ worker: "W99" })).rejects.toThrow("Unknown worker W99; live workers: W1 (idle, explore). Omit worker to start a new one.");
    await pool.stop("W1");
    await execute();
    await expect(execute({ worker: "W1" })).rejects.toThrow("live workers: W2 (idle, explore)");
  });

  it("evicts the least-recently-used idle worker at cap three; ids are monotonic", async () => {
    const { pool, execute } = await fixture([result(), result(), result(), result(), result()]);
    await execute(); await execute(); await execute();
    await execute({ worker: "W1" });
    const fourth = await execute();
    expect(fourth.details.worker).toBe("W4");
    expect(fourth.details.retired).toEqual(["W2"]);
    expect(fourth.text).toContain("W2 retired: least-recently-used");
    expect(pool.list().map(worker => worker.id)).toEqual(["W1", "W3", "W4"]);
    expect(pool.formatWorkers().split("\n")).toHaveLength(3);
  });

  it("retires context-full workers after their assignment and rejects later reuse", async () => {
    const { h, pool, execute } = await fixture([]);
    // Faux overwrites scripted usage with a prompt estimate (one token per four
    // characters). A tiny model on the same route exercises the real 70% policy;
    // the context alone exceeds it, without adding a production test seam.
    const faux = fauxProvider({ provider: h.orche.faux.provider.id, models: [{ id: h.orche.faux.getModel().id, contextWindow: 1_000, maxTokens: 100 }] });
    faux.setResponses([result()]);
    h.runtime.registerNativeProvider(faux.provider);

    const outcome = await execute({ context: "e".repeat(4_000) });
    expect(outcome.text).toContain("W1 retired: context nearly full");
    expect(outcome.details.worker).toBe("W1");
    expect(outcome.details.retired).toEqual(["W1"]);
    expect(outcome.details.roster).toBe("no workers");
    expect(pool.list()).toEqual([]);
    await expect(execute({ worker: "W1" })).rejects.toThrow("Unknown worker W1; live workers: none. Omit worker to start a new one.");
  });

  it("expires idle workers with an injectable TTL", async () => {
    const { pool, execute } = await fixture([result()], 20);
    await execute();
    await vi.waitFor(() => expect(pool.list()).toEqual([]));
    await expect(execute({ worker: "W1" })).rejects.toThrow("Unknown worker W1");
  });

  it("refuses tasks while multi owns the shared session activity slot", async () => {
    const entered = deferred();
    const { controller, execute, h } = await fixture([blocked(entered)]);
    const running = controller.run({ request: "Long multi", cwd: h.cwd, projectTrusted: false });
    await entered.promise;
    await expect(execute()).rejects.toThrow("An orche run is already active");
    controller.cancel();
    await running;
  });

  it("refuses /orche multi during a task; /orche cancel leaves its worker reusable", async () => {
    capturePool();
    const entered = deferred();
    const h = await harness({ mainSteps: [tool("orche_task", { role: "explore", request: "long task" }), reply("cancel acknowledged"), tool("orche_task", { role: "explore", request: "follow up", worker: "W1" }), reply("done")], orcheSteps: [blocked(entered), result("explore", "Reused after cancellation")] });
    const running = h.session.prompt("start task");
    await entered.promise;
    await h.session.prompt("/orche multi competing");
    expect(h.notifications.some(note => note.message.includes("already active"))).toBe(true);
    await h.session.prompt("/orche cancel");
    await running;
    expect(JSON.stringify(taskResults(h))).toContain("cancelled by user");
    const pool = [...pools][0]!;
    expect(pool.list()[0]?.status).toBe("idle");
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toContain("W1 idle");
    await h.session.prompt("continue");
    expect(JSON.stringify(taskResults(h))).toContain("Reused after cancellation");
    expect(pool.list()).toHaveLength(1);
  });

  it("rejects a running worker and stops on the tool abort signal", async () => {
    const entered = deferred();
    const { pool, execute } = await fixture([blocked(entered)]);
    const abort = new AbortController();
    const running = execute({}, abort.signal);
    await entered.promise;
    // Mutual exclusion wins before a reuse attempt can reach the running worker.
    await expect(execute({ worker: "W1" })).rejects.toThrow("already active");
    abort.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(pool.list()[0]?.status).toBe("idle");
  });

  it("rejects reuse when an externally started assignment is running", async () => {
    let manager: AgentManager | undefined;
    const assign = AgentManager.prototype.assign;
    vi.spyOn(AgentManager.prototype, "assign").mockImplementation(function (this: AgentManager, ...args) {
      manager = this;
      return assign.apply(this, args);
    });
    const entered = deferred();
    const { pool, execute } = await fixture([result(), blocked(entered)]);
    await execute();
    manager!.assign("W1", "explore", "External running assignment");
    await entered.promise;
    await expect(execute({ worker: "W1" })).rejects.toThrow("Worker W1 is running");
    await pool.stop("W1");
  });


  it("lists and disposes workers with slash commands and rejects malformed stop", async () => {
    capturePool();
    const h = await harness({ mainSteps: [tool("orche_task", { role: "explore", request: "one" }), reply("ok"), tool("orche_task", { role: "explore", request: "two" }), reply("ok")], orcheSteps: [result(), result()] });
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
    await h.session.prompt("first");
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toContain("W1 idle · explore · 1 assignments · last: Evidence found · idle 0m");
    await h.session.prompt("/orche stop");
    expect(h.notifications.at(-1)?.message).toBe(ORCHE_USAGE);
    await h.session.prompt("/orche stop W99");
    expect(h.notifications.at(-1)?.message).toBe("unknown worker W99");
    await h.session.prompt("/orche stop W1");
    expect(h.notifications.at(-1)?.message).toContain("Disposed workers: W1");
    await h.session.prompt("second");
    await h.session.prompt("/orche stop all");
    expect(h.notifications.at(-1)?.message).toContain("Disposed workers: W2");
    await h.session.prompt("/orche workers");
    expect(h.notifications.at(-1)?.message).toBe("no workers");
  });

  it.each([
    ["implement", { status: "blocked", reason: "dependency absent" }, true],
    ["verify", { passed: false, issues: [{ file: "x.ts", description: "failed" }] }, true],
    ["verify", { passed: true }, false],
    ["explore", { cause: "observed" }, false],
  ] as const)("adds escalation note only for relevant %s outcomes", async (role, data, note) => {
    const { execute } = await fixture([result(role, "report", data)]);
    const outcome = await execute({ role });
    expect(outcome.text.includes("Note: consider orche_run (multi)")).toBe(note);
  });

  it("session_shutdown disposes worker sessions and clears the idle pool idempotently", async () => {
    capturePool();
    const h = await harness({ mainSteps: [tool("orche_task", { role: "explore", request: "inspect" }), reply("ok")], orcheSteps: [result()] });
    await h.session.prompt("task");
    const pool = [...pools][0]!;
    const worker = pool.session("W1");
    const dispose = vi.spyOn(worker, "dispose");
    await h.session.reload(); // documented lifecycle: reload emits session_shutdown
    expect(dispose).toHaveBeenCalledOnce();
    expect(pool.list()).toEqual([]);
    await pool.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
