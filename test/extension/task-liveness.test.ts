import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage as reply, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController, type OrcheRunArgs } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";
import { deferred } from "../helpers/faux.js";

/** (h) orche_task: the pool exposes the liveness of its task workers (see src/agent/liveness.ts). */
const open: Harness[] = [];
const pools = new Set<WorkerPool>();
afterEach(async () => {
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
const result = (role = "explore", summary = "Evidence found", data?: ToolCall["arguments"][string]) => tool("report_result", { kind: role, summary, ...(data === undefined ? {} : { data }) });
async function fixture(steps: FauxResponseStep[]) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime });
  const pool = new WorkerPool({ controller, agentDir: h.agentDir });
  pools.add(pool);
  const execute = (args: Partial<TaskParameters & Pick<OrcheRunArgs, "onProgress">> = {}, signal?: AbortSignal) => pool.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false, ...args, signal });
  return { h, pool, execute };
}
/** A model request that does not answer until the task is aborted. */
const blocked = (entered: { resolve(): void }): FauxResponseStep => async (_context, options) => {
  entered.resolve();
  await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  return reply("aborted");
};

describe("(h) orche_task worker liveness is exposed by the WorkerPool", () => {
  it("has nothing to report before the first task", () => {
    const controller = new OrcheController({ createRuntime: async () => { throw new Error("unused"); } });
    const pool = new WorkerPool({ controller });
    expect(pool.liveness()).toEqual({ active: false, reasons: [], sessions: [] });
    expect(pool.workerLiveness("W1")).toBeUndefined();
  });

  it("shows a worker waiting for the model as active, and as idle once its task is done", async () => {
    const entered = deferred();
    const { pool, execute } = await fixture([blocked(entered), result()]);
    const abort = new AbortController();
    const running = execute({}, abort.signal);
    await entered.promise;

    const waiting = pool.liveness();
    expect(waiting.active).toBe(true);
    expect(waiting.sessions).toEqual([expect.objectContaining({ id: "W1", role: expect.any(String), state: "request-wait", active: true })]);
    expect(waiting.reasons).toEqual([expect.stringMatching(/^W1 request in flight \d+s, no output yet$/)]);
    expect(pool.workerLiveness("W1")).toMatchObject({ id: "W1", state: "request-wait", active: true });
    // The same worker is also visible to the pool's own listing.
    expect(pool.list().map(worker => [worker.id, worker.status])).toEqual([["W1", "running"]]);
    // A request with no sign of life stops counting after its bound, whatever the window.
    expect(pool.liveness(Date.now() + 6 * 60_000, 60_000).active).toBe(false);

    abort.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(pool.liveness()).toMatchObject({ active: false, reasons: [], sessions: [{ id: "W1", state: "idle", active: false }] });
    expect(pool.workerLiveness("W1")).toMatchObject({ state: "idle", active: false });
  });

  it("shows a long bash command as a tool in flight with its running time", async () => {
    const { pool, execute } = await fixture([tool("bash", { command: "sleep 30" }), result()]);
    const abort = new AbortController();
    const running = execute({}, abort.signal);
    try {
      await vi.waitFor(() => expect(pool.workerLiveness("W1")?.state).toBe("tool"), { timeout: 5000 });

      const verdict = pool.liveness();
      expect(verdict.active).toBe(true);
      expect(verdict.reasons).toEqual([expect.stringMatching(/^W1 bash running \d+s, no output yet/)]);
      // Without progress (no output, no process activity) a silent bash stops counting once its start is older than the window:
      // a bash call is judged by its progress, not bounded like another tool.
      const later = pool.liveness(Date.now() + 5 * 60_000, 60_000);
      expect(later.active).toBe(false);
      expect(later.sessions[0]).toMatchObject({ id: "W1", state: "tool", active: false });
    } finally {
      abort.abort();
      await running.catch(() => undefined);
    }
    expect(pool.workerLiveness("W1")).toMatchObject({ state: "idle", active: false });
  });

  it("lists every live worker (one entry each) and drops a retired one", async () => {
    const { pool, execute } = await fixture([result(), result()]);
    await execute();
    await execute();
    expect(pool.liveness()).toMatchObject({ active: false, sessions: [{ id: "W1", state: "idle" }, { id: "W2", state: "idle" }] });
    await pool.stop("W1");
    expect(pool.liveness().sessions.map(session => session.id)).toEqual(["W2"]);
    expect(pool.workerLiveness("W1")).toBeUndefined();
  });

  it("does not turn liveness samples into task progress lines", async () => {
    const { execute } = await fixture([result()]);
    const lines: string[][] = [];
    await execute({ onProgress: progress => { lines.push([...progress]); } });
    expect(lines.flat().filter(line => /request-wait|streaming|liveness/.test(line))).toEqual([]);
  });
});
