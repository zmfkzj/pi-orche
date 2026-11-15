import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";

/** orche_task `files`: an existing directory named without / is refused before any worker runs; a write blocked under an exact path names `dir/`. */
const open: Harness[] = [];
const pools: WorkerPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.dispose();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
const last = (context: { messages: unknown[] }) => JSON.stringify(context.messages.at(-1));
const done = tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });
const blocked = tool("report_result", { kind: "implement", summary: "scope", data: { status: "blocked", reason: "needs newdir/" } });

async function fixture(steps: FauxResponseStep[]) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir });
  pools.push(pool);
  const execute = (args: Partial<TaskParameters> = {}) => pool.execute({ role: "implement", request: "Do it", cwd: h.cwd, projectTrusted: false, ...args });
  return { h, pool, execute };
}

describe("orche_task owned directory scope", () => {
  it("refuses an existing directory without / before a new or reused worker gets the assignment", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const { h, pool, execute } = await fixture([tool("write", { path: ".archify/flow/candidate.json", content: "{}\n" }), done]);
    await mkdir(join(h.cwd, ".archify"));
    await expect(execute({ files: [".archify"] })).rejects.toThrow('Owned path ".archify" is an existing directory, but a path without a trailing / owns only that exact path, not the files inside it. Use ".archify/"');
    expect(spawned).not.toHaveBeenCalled();
    expect(pool.list()).toEqual([]);
    // The corrected scope works; reusing that worker with the wrong scope is refused again and changes nothing.
    const first = await execute({ files: [".archify/"] });
    expect(await readFile(join(h.cwd, ".archify/flow/candidate.json"), "utf8")).toBe("{}\n");
    expect(first.details.worker).toBe("W1");
    const messages = pool.session("W1").messages.length;
    await expect(execute({ worker: "W1", files: [".archify"] })).rejects.toThrow('Use ".archify/"');
    expect(pool.session("W1").messages.length).toBe(messages);
    expect(pool.list()[0]).toMatchObject({ id: "W1", status: "idle", completedAssignments: 1 });
    // Only the corrected assignment spawned a worker.
    expect(spawned).toHaveBeenCalledTimes(1);
  });

  it("names the dir/ correction when a write under a missing directory is blocked, keeping it blocked", async () => {
    let denial = "";
    const { h, execute } = await fixture([
      tool("write", { path: "newdir/a.txt", content: "a\n" }),
      context => { denial = last(context); return blocked; },
    ]);
    await execute({ files: ["newdir"] });
    expect(denial).toContain("Blocked: newdir/a.txt is outside your owned files (newdir)");
    expect(denial).toContain('ask main to re-assign with files [\\"newdir/\\"]');
    await expect(readFile(join(h.cwd, "newdir/a.txt"))).rejects.toThrow();
  });
});
