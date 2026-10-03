import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/agent-manager.js";
import * as sessionFactory from "../../src/pi/session-factory.js";
import * as ownership from "../../src/orchestration/ownership.js";
import { WorkspaceActivity } from "../../src/orchestration/run/activity.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

const open: Harness[] = [];
const pools: WorkerPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.dispose();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
const result = (role = "explore") => tool("report_result", { kind: role, summary: "done", ...(role === "implement" ? { data: { status: "done" } } : {}) });
async function fixture(steps: FauxResponseStep[] = [result()]) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir, stopTimeoutMs: 5 });
  pools.push(pool);
  const execute = (args: Partial<TaskParameters> = {}) => pool.execute({ role: "explore", request: "Investigate", cwd: h.cwd, projectTrusted: false, ...args });
  const limits = async (assignmentRequests: number, assignmentMs = 30_000) => {
    const path = join(h.agentDir, "orche.config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, limits: { assignmentRequests, assignmentMs } }));
  };
  return { h, controller, pool, execute, limits };
}

it("directory rewrite skips a write-time ownership denial without opening another activity window", async () => {
  const { h, pool, execute } = await fixture([
    tool("ast_rewrite", { path: "src/a", pattern: "console.log($X)", replacement: "console.info($X)", language: "typescript" }),
    result("implement"),
  ]);
  await mkdir(join(h.cwd, "src/a"), { recursive: true });
  for (const name of ["allowed.ts", "blocked.ts"]) await writeFile(join(h.cwd, "src/a", name), "console.log(value);\n");
  // Simulate a policy denial appearing at write time, after the directory itself was allowed.
  // A single-task directory scope normally has no holes; this isolates its per-file wiring.
  const check = ownership.checkWriteRealPath;
  vi.spyOn(ownership, "checkWriteRealPath").mockImplementation(async options => options.input.path === "src/a/blocked.ts"
    ? { file: "src/a/blocked.ts", reason: "outside your owned files" }
    : check(options));
  const enter = vi.spyOn(WorkspaceActivity.prototype, "enter");
  await execute({ role: "implement", files: ["src/a/"] });
  expect(await readFile(join(h.cwd, "src/a/allowed.ts"), "utf8")).toBe("console.info(value);\n");
  expect(await readFile(join(h.cwd, "src/a/blocked.ts"), "utf8")).toBe("console.log(value);\n");
  expect(JSON.stringify(pool.session("W1").messages)).toContain("Skipped files:");
  expect(JSON.stringify(pool.session("W1").messages)).toContain("src/a/blocked.ts");
  expect(enter.mock.calls.filter(([, name]) => name === "ast_rewrite")).toHaveLength(1);
});

it.each(["runtime", "session"] as const)("cancellation during never-resolving %s startup releases the controller slot", async stage => {
  const { h, controller, pool, execute } = await fixture();
  const entered = deferred();
  if (stage === "runtime") {
    // Exercise the real controller runtime cache and its cancellation race.
    const options = (controller as unknown as { options: { createRuntime: () => Promise<typeof h.runtime> } }).options;
    let first = true;
    options.createRuntime = async () => { if (first) { first = false; entered.resolve(); return new Promise(() => {}); } return h.runtime; };
  } else {
    vi.spyOn(sessionFactory, "createSession").mockImplementationOnce(() => { entered.resolve(); return new Promise(() => {}); });
  }
  const task = execute();
  const rejected = expect(task).rejects.toThrow("cancelled by user");
  await entered.promise;
  expect(controller.cancel()).toBe(true);
  await rejected;
  await controller.whenIdle();
  expect(controller.busy).toBe(false);
  expect(pool.list()).toEqual([]);
  expect((await execute()).details.status).toBe("completed");
});

it("a startup deadline releases the slot and permits a new task", async () => {
  const { controller, execute, limits } = await fixture();
  await limits(0, 20);
  vi.spyOn(sessionFactory, "createSession").mockReturnValueOnce(new Promise(() => {}));
  await expect(execute()).rejects.toThrow("Worker startup timed out after 20ms");
  await controller.whenIdle();
  expect(controller.busy).toBe(false);
  await limits(0);
  expect((await execute()).details.status).toBe("completed");
});

it("cancellation with never-settling SDK abort force-disposes the worker and releases the slot", async () => {
  const { controller, pool, execute } = await fixture();
  const entered = deferred();
  const spawn = AgentManager.prototype.spawn;
  vi.spyOn(AgentManager.prototype, "spawn").mockImplementationOnce(async function (this: AgentManager, options) {
    const handle = await spawn.call(this, options);
    const session = this.session(options.id);
    vi.spyOn(session, "prompt").mockImplementation(() => { entered.resolve(); return new Promise(() => {}); });
    vi.spyOn(session, "abort").mockReturnValue(new Promise(() => {}));
    return handle;
  });
  const task = execute();
  const rejected = expect(task).rejects.toMatchObject({ message: "cancelled by user", details: { status: "cancelled" } });
  await entered.promise;
  controller.cancel();
  await rejected;
  await controller.whenIdle();
  expect(controller.busy).toBe(false);
  expect(pool.list()).toEqual([]);
  expect((await execute()).details.worker).toBe("W2");
});

it.each([[0, 1], [1, 0]])("reloads assignmentRequests from %i to %i for a reused worker", async (first, second) => {
  const read = () => tool("read", { path: "greeting.txt" });
  const { execute, limits } = await fixture([read(), read(), result(), read(), read(), result()]);
  const events: { budget: number; action: string }[] = [];
  const spawn = AgentManager.prototype.spawn;
  vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(async function (this: AgentManager, options) {
    this.subscribe(event => { if (event.type === "request_budget") events.push(event); });
    return spawn.call(this, options);
  });
  await limits(first);
  expect((await execute()).details.status).toBe("completed");
  expect(events.some(event => event.action === "stop")).toBe(first === 1);
  events.length = 0;
  await limits(second);
  expect((await execute({ worker: "W1" })).details.status).toBe("completed");
  expect(events.some(event => event.action === "stop")).toBe(second === 1);
  if (second === 1) expect(events.every(event => event.budget === 1)).toBe(true);
});
