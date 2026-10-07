import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import { OrcheController } from "../../src/extension/controller.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * P2-1 wiring: every worker gets a private scratch dir outside the workspace, `writeRoots` opens a sibling directory for one
 * assignment only, and worker bash follows the same outside-workspace policy for its literal write targets.
 */
const open: Harness[] = [];
const pools: WorkerPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.dispose();
  for (const h of open.splice(0)) await h.dispose();
  vi.restoreAllMocks();
});
const scratchOf = (context: { messages: unknown[] }) => /Use your scratch directory (\S+) for temporary files/.exec(JSON.stringify(context.messages))?.[1]!;
const last = (context: { messages: unknown[] }) => JSON.stringify(context.messages.at(-1));
const done = tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });

async function fixture(steps: FauxResponseStep[]) {
  const h = await createHarness({ mainSteps: [], orcheSteps: steps });
  open.push(h);
  execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime }), agentDir: h.agentDir, scratchBase: join(dirname(h.cwd), "scratch") });
  pools.push(pool);
  const execute = (args: Partial<TaskParameters> = {}) => pool.execute({ role: "implement", request: "Do it", cwd: h.cwd, projectTrusted: false, ...args });
  return { h, pool, execute };
}

describe("worker write scope outside the workspace", () => {
  it("allows the scratch dir for file tools and bash, blocks other temp paths with advice, and scopes writeRoots to one assignment", async () => {
    const outside = join(tmpdir(), `orche-not-scratch-${process.pid}.txt`);
    const seen: Record<string, string> = {};
    let scratch = "";
    const sibling = () => join(dirname(open[0]!.cwd), "sibling");
    const { h, execute } = await fixture([
      context => { scratch = scratchOf(context); return tool("write", { path: join(scratch, "notes.md"), content: "temp\n" }); },
      context => { seen.scratchWrite = last(context); return tool("write", { path: outside, content: "x" }); },
      context => { seen.outsideWrite = last(context); return tool("bash", { command: `cat > ${outside} <<'EOF'\nx\nEOF` }); },
      context => { seen.outsideBash = last(context); return tool("bash", { command: `echo ok > ${join(scratch, "bash.txt")}` }); },
      context => { seen.scratchBash = last(context); return tool("write", { path: join(sibling(), "a.txt"), content: "a\n" }); },
      context => { seen.rootWrite = last(context); return done; },
      // Next assignment, no writeRoots: the sibling is closed again.
      () => tool("write", { path: join(sibling(), "b.txt"), content: "b\n" }),
      context => { seen.rootAfter = last(context); return done; },
    ]);
    await mkdir(sibling(), { recursive: true });
    const first = await execute({ writeRoots: ["../sibling"] });
    expect(first.details.writeRoots).toEqual([{ path: scratch, kind: "scratch" }, { path: sibling(), kind: "root" }]);
    expect(await readFile(join(scratch, "notes.md"), "utf8")).toBe("temp\n");
    expect(seen.outsideWrite).toContain("is outside the workspace");
    expect(seen.outsideWrite).toContain(`Use your scratch directory ${scratch}`);
    expect(seen.outsideBash).toContain(`scratch`);
    await expect(readFile(outside)).rejects.toThrow();
    expect(await readFile(join(scratch, "bash.txt"), "utf8")).toBe("ok\n");
    expect(await readFile(join(sibling(), "a.txt"), "utf8")).toBe("a\n");
    await execute({ worker: "W1" });
    expect(seen.rootAfter).toContain("is outside the workspace");
    await expect(readFile(join(sibling(), "b.txt"))).rejects.toThrow();
    await rm(outside, { force: true });
    expect(h.cwd).toBeTruthy();
  });

  it("rejects a write root that is the filesystem root before any worker runs", async () => {
    const { execute, pool } = await fixture([]);
    await expect(execute({ writeRoots: ["/"] })).rejects.toThrow();
    expect(pool.list()).toEqual([]);
  });
});
