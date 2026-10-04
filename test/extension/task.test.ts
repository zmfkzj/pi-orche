import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxProvider, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheControllerOptions, type OrcheRunArgs } from "../../src/extension/controller.js";
import type { ConcurrentSession, ConcurrentSessionsResult, DetectConcurrentSessionsOptions } from "../../src/extension/concurrent-sessions.js";
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
async function fixture(steps: FauxResponseStep[], idleTtlMs?: number, controllerOptions: Partial<OrcheControllerOptions> = {}) {
  const h = await harness({ mainSteps: [], orcheSteps: steps });
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, ...controllerOptions });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, idleTtlMs });
  pools.add(pool);
  const execute = (args: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress" | "currentSession">> = {}, signal?: AbortSignal) => pool.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false, ...args, signal });
  return { h, pool, controller, execute };
}
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};
const taskResults = (h: Harness) => h.session.messages.filter(message => message.role === "toolResult" && message.toolName === "orche_task");
// The auto-mode implement instruction as it was before the single-workflow change (pinned literal, not read from git).
const HEAD_IMPLEMENT = 'Implement completely, preserving unrelated changes. Write scope: ${scope}. Run local checks on touched files. report_result {kind:"implement",summary,data:{status:"done" or "blocked",reason,evidence:[checks]}}.';

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
    expect(JSON.stringify(session.messages)).toContain("Start summary with the conclusion (1–3 sentences)");
    expect(JSON.stringify(session.messages)).toContain("path:line references and command outcomes");
    expect(JSON.stringify(session.messages)).toContain("Do not paste code, diffs or logs");
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

  it.each([
    ["single", "change the greeting", true],
    ["single", "/orche single change the greeting", true],
    ["direct", "/orche single change the greeting", true],
  ] as const)("uses the effective mode for implement instructions (%s, %s)", async (mainMode, prompt, endToEnd) => {
    let instruction = "";
    const files = ["greeting.txt"];
    const h = await harness({
      mainMode,
      mainSteps: [tool("orche_task", { role: "implement", request: "Change greeting.txt", files }), reply("done")],
      orcheSteps: [context => {
        const assignment = context.messages.findLast(message => message.role === "user");
        if (!assignment || assignment.role !== "user") throw new Error("Missing worker assignment");
        const text = typeof assignment.content === "string" ? assignment.content : assignment.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        instruction = text.match(/(?:Own the task end to end:|Implement completely,)[\s\S]*?(?=\nStart summary)/)?.[0] ?? "";
        return result("implement", "Done", { status: "done" });
      }],
    });
    await h.session.prompt(prompt);
    expect(taskResults(h)).toHaveLength(1);
    expect(taskResults(h)[0]).toMatchObject({ isError: false });
    expect(instruction).toBe(endToEnd
      ? `Own the task end to end: first analyse the requirements and create the Task DAG with task_plan, covering every requirement id. If a requirement can be read more than one way with observably different behaviour, choose the reading closest to the Original request text, implement it, and report it in data.ambiguities. Then execute nodes sequentially in dependency order, updating statuses, implementing completely, adding or updating tests, running the project's relevant checks and iterating until they pass, preserving unrelated changes. Main does not intervene while you run. Write scope: ${JSON.stringify(files)}. Finish with report_result {kind:"implement",summary,data:{status:"done" or "blocked",reason,evidence:[checks],checklist:[{id:"R1",status:"met" or "unmet" or "partial",evidence:"concrete evidence",verifiedBy:"test name or check command that asserts this requirement's acceptance and passed"}],ambiguities:[{id:"R2",readings:["reading A","reading B"],chosen:"reading A"}]}}. Checklist is required when the request contains R-ids; every met item needs verifiedBy, otherwise report it partial. ambiguities may be omitted when there are none.`
      : HEAD_IMPLEMENT.replace("${scope}", JSON.stringify(files)));
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it("keeps the omitted-mode SDK implement instruction byte-identical to HEAD", async () => {
    const { pool, execute } = await fixture([result("implement", "Done", { status: "done" })]);
    await execute({ role: "implement", files: [] });
    const assignment = pool.session("W1").messages.findLast(message => message.role === "user");
    if (!assignment || assignment.role !== "user") throw new Error("Missing worker assignment");
    const text = typeof assignment.content === "string" ? assignment.content : assignment.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    expect(text.match(/Implement completely,[\s\S]*?(?=\nStart summary)/)?.[0]).toBe(HEAD_IMPLEMENT.replace("${scope}", "[]"));
  });

  it.each(["game-asset", "video"] as const)("spawns a %s route, enforces its files scope and reports output count", async role => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    let rejected = "";
    const outputs = Array.from({ length: 4 }, (_, i) => ({ path: `deliverables/output-${i}.svg`, type: "image/svg+xml", spec: "16x16 SVG" }));
    const { h, pool, execute } = await fixture([
      tool("write", { path: "other.txt", content: "forbidden" }),
      context => { rejected = JSON.stringify(context.messages); return tool("write", { path: outputs[0]!.path, content: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }); },
      ...outputs.slice(1).map(output => tool("write", { path: output.path, content: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' })),
      result(role, "Scoped production", { status: "done", outputs, evidence: ["SVG outputs"] }),
    ]);
    const outcome = await execute({ role, files: ["deliverables/**"] });
    expect(spawned.mock.calls[0]?.[0]).toMatchObject({ role, route: { role, model: h.orche.route.model } });
    expect(rejected).toContain("outside your owned files");
    await expect(readFile(join(h.cwd, "other.txt"))).rejects.toThrow();
    for (const output of outputs) expect(await readFile(join(h.cwd, output.path), "utf8")).toContain("<svg");
    expect(outcome.details.changes).toHaveLength(4);
    expect(outcome.text).toContain("outputs: 4");
    expect(outcome.text).not.toContain("files ignored");
    expect(outcome.text).not.toContain("consider orche_run");
    const prompt = JSON.stringify(pool.session("W1").messages);
    expect(prompt).toContain("deliverables/");
    expect(prompt).toContain("command -v");
    expect(prompt).toContain("read tool");
    expect(prompt).toContain(role === "game-asset" ? "Unity .meta" : "Render a short draft");
  });

  it.each(["game-asset", "video"] as const)("allows unscoped %s writes only inside the workspace", async role => {
    let rejected = "";
    const { h, execute } = await fixture([
      tool("write", { path: "../outside.txt", content: "forbidden" }),
      context => { rejected = JSON.stringify(context.messages); return tool("write", { path: "nested/allowed.txt", content: "allowed" }); },
      result(role, "Workspace production", { status: "done", outputs: [{ path: "nested/allowed.txt", type: "text", spec: "production notes" }] }),
    ]);
    await execute({ role });
    expect(rejected).toContain("outside the workspace");
    await expect(readFile(join(h.cwd, "../outside.txt"))).rejects.toThrow();
    expect(await readFile(join(h.cwd, "nested/allowed.txt"), "utf8")).toBe("allowed");
  });

  it.each(["game-asset", "video"] as const)("gives %s no write access with an empty scope and rejects globs", async role => {
    let rejected = "";
    const { h, execute } = await fixture([
      tool("write", { path: "forbidden.txt", content: "forbidden" }),
      context => { rejected = JSON.stringify(context.messages); return result(role, "No scope", { status: "blocked", reason: "empty write scope", outputs: [] }); },
    ]);
    const outcome = await execute({ role, files: [] });
    expect(rejected).toContain("outside your owned files (none)");
    await expect(readFile(join(h.cwd, "forbidden.txt"))).rejects.toThrow();
    expect(outcome.text).not.toContain("files ignored");
    await expect(execute({ role, files: ["assets/*.png"] })).rejects.toThrow("Unsupported ownership path");
  });

  for (const sessionSource of [false, true]) it.each(["game-asset", "video"] as const)(`uses the default provider's specialist model for %s (session source: ${sessionSource})`, async role => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const { h, pool } = await fixture([]);
    const faux = fauxProvider({ provider: h.orche.faux.provider.id, models: [{ id: h.orche.faux.getModel().id }, { id: "claude-opus-5-5" }] });
    faux.setResponses([result(role, "Produced", { status: "done", outputs: [] })]);
    h.runtime.registerNativeProvider(faux.provider);
    const configPath = join(h.agentDir, "orche.config.json");
    if (sessionSource) await rm(configPath);
    else await writeFile(configPath, JSON.stringify({ routes: {}, default: { model: h.orche.route.model, thinking: "high", extendedContext: true } }));
    await pool.execute({ role, request: "Produce", cwd: h.cwd, projectTrusted: false, model: h.orche.faux.getModel(), thinking: "high" });
    expect(spawned.mock.calls[0]?.[0]).toMatchObject({ role, route: { role, model: `${faux.provider.id}/claude-opus-5-5`, thinking: "high", ...(!sessionSource ? { extendedContext: true } : {}) } });
    expect(pool.session("W1").model?.id).toBe("claude-opus-5-5");
  });

  it.each(["game-asset", "video"] as const)("rejects malformed %s reports and accepts same-turn repair", async role => {
    let rejected = "";
    const { execute } = await fixture([
      result(role, "Malformed", { status: "done" }),
      context => { rejected = JSON.stringify(context.messages); return result(role, "Repaired", { status: "done", outputs: [], evidence: ["no deliverables requested"] }); },
    ]);
    const outcome = await execute({ role });
    expect(rejected).toContain("outputs");
    expect(rejected).toContain("Result rejected:");
    expect(outcome.text).toContain("Repaired");
    expect(outcome.text).toContain("outputs: 0");
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

  it("/orche cancel during a task leaves its worker reusable", async () => {
    capturePool();
    const entered = deferred();
    const h = await harness({ mainSteps: [tool("orche_task", { role: "explore", request: "long task" }), reply("cancel acknowledged"), tool("orche_task", { role: "explore", request: "follow up", worker: "W1" }), reply("done")], orcheSteps: [blocked(entered), result("explore", "Reused after cancellation")] });
    const running = h.session.prompt("start task");
    await entered.promise;
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
    expect(outcome.text.includes("Note: follow up with the same worker")).toBe(note);
    expect(outcome.text).not.toContain("orche_run");
  });

  it.each([
    ["single", "change four files"],
    ["single", "/orche single change four files"],
  ] as const)("does not add a four-file size note in the single workflow (%s, %s)", async (mainMode, prompt) => {
    const files = ["one.txt", "two.txt", "three.txt", "four.txt"];
    const h = await harness({
      mainMode,
      mainSteps: [tool("orche_task", { role: "implement", request: "Create four files", files }), reply("done")],
      orcheSteps: [...files.map(path => tool("write", { path, content: "implemented\n" })), result("implement", "Four files created", { status: "done" })],
    });
    await h.session.prompt(prompt);
    const [outcome] = taskResults(h);
    expect(outcome).toMatchObject({ isError: false, details: { changes: [...files].sort().map(path => ({ path, status: "added" })) } });
    if (!outcome || outcome.role !== "toolResult") throw new Error("Missing orche_task result");
    const text = outcome.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    expect(text.split("\n").filter(line => line.startsWith("Note:"))).toEqual(["Note: no Task DAG recorded in this assignment."]);
    expect(text).not.toContain("four or more files");
    expect(text).not.toContain("orche_run");
    expect(text).not.toContain("/orche mode");
    for (const path of files) expect(await readFile(join(h.cwd, path), "utf8")).toBe("implemented\n");
    expect(h.orche.faux.getPendingResponseCount()).toBe(0);
  });

  it.each([
    ["implement", { status: "blocked", reason: "dependency absent" }, "dependency absent"],
    ["verify", { passed: false, issues: [{ file: "x.ts", description: "failed" }] }, "verification failed"],
  ] as const)("keeps single-mode %s follow-up advice on the same worker", async (role, data, reason) => {
    const { h, pool } = await fixture([result(role, "report", data)]);
    const outcome = await pool.execute({ role, request: "Check the unit", cwd: h.cwd, projectTrusted: false, mainMode: "single" });
    expect(outcome.text).toContain(`Note: follow up with the same worker — ${reason}`);
    expect(outcome.text).not.toContain("consider orche_run");
    expect(outcome.text).not.toContain("/orche mode");
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

  describe("concurrent pi sessions", () => {
    const other = (cwd: string, secondsAgo = 20): ConcurrentSession => ({ id: "other", cwd, file: "/sessions/other.jsonl", lastWriteMs: Date.now() - secondsAgo * 1000 });
    const stub = (sessions: ConcurrentSession[]) => vi.fn(async (_options: DetectConcurrentSessionsOptions): Promise<ConcurrentSessionsResult> => ({ sessions }));
    const warningPattern = /^⚠ 1 other pi session active in this repository \(cwd [^)]*, last write (19|20|21)s ago\); their changes are classified as external where possible$/;

    it("puts the warning first in the result, in the progress lines and beside the changed files", async () => {
      const detect = stub([other("/work/repo")]);
      const { h, execute } = await fixture([
        tool("write", { path: "allowed.txt", content: "allowed" }),
        result("implement", "Scoped change", { status: "done" }),
      ], undefined, { detectConcurrentSessions: detect });
      const updates: string[][] = [];
      const outcome = await execute({ role: "implement", files: ["allowed.txt"], onProgress: lines => updates.push([...lines]), currentSession: { file: "/s/me.jsonl", id: "me" } });

      expect(detect).toHaveBeenCalledTimes(1);
      expect(detect.mock.calls[0]![0]).toMatchObject({ cwd: h.cwd, windowMs: 10 * 60_000, currentSessionFile: "/s/me.jsonl", currentSessionId: "me", sessionsDir: [join(h.agentDir, "sessions")] });
      const [warning, blank, head] = outcome.text.split("\n");
      expect(warning).toMatch(warningPattern);
      expect([blank, head!.startsWith("orche task W1 (implement")]).toEqual(["", true]);
      expect(outcome.text).toContain("Changed files: allowed.txt (may include changes made by the other pi session(s)");
      expect(outcome.details.concurrentSessions).toMatchObject({ count: 1 });
      const shown = updates.filter(lines => lines.length);
      expect(shown.length).toBeGreaterThan(0);
      for (const lines of shown) {
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe(warning);
        expect(lines[1]).toMatch(/^W1 implement · \d+ requests/);
      }
      expect(updates.at(-1)).toEqual([]);
    });

    it("adds nothing when no session is detected, or when detection is disabled or fails", async () => {
      const none = stub([]);
      const quiet = await fixture([result(), result()], undefined, { detectConcurrentSessions: none });
      const updates: string[][] = [];
      const outcome = await quiet.execute({ onProgress: lines => updates.push([...lines]) });
      expect(none).toHaveBeenCalledTimes(1);
      expect(outcome.text).not.toContain("other pi session");
      expect(outcome.details.concurrentSessions).toBeUndefined();
      expect(updates.flat().filter(line => line.includes("pi session"))).toEqual([]);

      const off = stub([other("/work/repo")]);
      const disabled = await fixture([result()], undefined, { detectConcurrentSessions: off });
      await writeFile(join(disabled.h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: disabled.h.orche.route.model }, concurrentSessions: { enabled: false } }));
      expect((await disabled.execute()).text).not.toContain("other pi session");
      expect(off).not.toHaveBeenCalled();

      const broken = await fixture([result()], undefined, { detectConcurrentSessions: async () => { throw new Error("detector exploded"); } });
      const survived = await broken.execute();
      expect(survived.text).toContain("Evidence found");
      expect(survived.text).not.toContain("other pi session");
    });

    it("prefixes a failed task's error with the warning", async () => {
      const { execute } = await fixture([reply("I will not report")], undefined, { detectConcurrentSessions: stub([other("/work/repo")]) });
      const error = await execute().catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(Error);
      const lines = (error as Error).message.split("\n");
      expect(lines[0]).toMatch(warningPattern);
      expect(lines[1]).toBe("");
      expect(lines.slice(2).join("\n").length).toBeGreaterThan(0);
    });

    it("shows the warning in the orche_task tool result of a real session and passes its own session to the detector", async () => {
      const detect = stub([other("/work/repo")]);
      const h = await harness({
        mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt" }), reply("supervised")],
        orcheSteps: [result()],
        extension: { detectConcurrentSessions: detect },
      });
      await h.session.prompt("investigate");
      const [text] = (taskResults(h)[0] as { content: { text: string }[] }).content.map(part => part.text);
      expect(text).toMatch(/^⚠ 1 other pi session active in this repository \(cwd \/work\/repo, last write (19|20|21)s ago\); their changes are classified as external where possible\n\norche task W1 \(explore/);
      expect(detect).toHaveBeenCalledTimes(1);
      expect(detect.mock.calls[0]![0]).toMatchObject({ cwd: h.cwd, currentSessionId: h.session.sessionManager.getSessionId() });
      expect(detect.mock.calls[0]![0]).not.toHaveProperty("currentSessionFile"); // in-memory session: no file yet
    });

    it("detects a real concurrent session in the same git repository through the default detector", async () => {
      const h = await harness({
        mainSteps: [tool("orche_task", { role: "explore", request: "first" }), reply("ok"), tool("orche_task", { role: "explore", request: "second", worker: "W1" }), reply("ok")],
        orcheSteps: [result(), result()],
      });
      await h.session.prompt("first");
      expect(JSON.stringify(taskResults(h))).not.toContain("other pi session");
      const dir = join(h.agentDir, "sessions", "--project--");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "2026-10-02T06-10-00-000Z_other.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: "2026-10-02T06:10:00.000Z", cwd: join(h.cwd, "packages") })}\n`);
      await h.session.prompt("second");
      const second = JSON.stringify(taskResults(h)[1]);
      expect(second).toContain("⚠ 1 other pi session active in this repository");
      expect(second).toContain(join(h.cwd, "packages"));
    });
  });

});
