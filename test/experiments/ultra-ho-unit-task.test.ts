import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * experiments/ultra-ho/chain.ts unitTask for a unit without a recorded fixture root (the older ultra-ab units), on a stand-in SWE
 * fixture root and cache (ADVISOR_BENCH_SWE_DIR / ADVISOR_BENCH_SWE_CACHE, read when the modules load). Regression: the analysis went
 * through ultra-ab loadTask, which requires the task's prepared venv (venv/.ready) for a run, so every analysis of such a unit failed
 * once the local venvs were pruned although it only reads the fixture and the snapshot. The run gate itself stays.
 */
let root = "";
let unitTask: typeof import("../../experiments/ultra-ho/chain.js").unitTask;
let loadTask: typeof import("../../experiments/ultra-ab/env.js").loadTask;

const task = (id: string, valid: boolean, snapshot: boolean, ready = false) => {
  mkdirSync(join(root, "swe", id), { recursive: true });
  writeFileSync(join(root, "swe", id, "task.json"), JSON.stringify({ title: id, problemStatement: "x", validation: { valid } }));
  if (snapshot) mkdirSync(join(root, "cache", id, "src"), { recursive: true });
  if (ready) { mkdirSync(join(root, "cache", id, "venv"), { recursive: true }); writeFileSync(join(root, "cache", id, "venv/.ready"), ""); }
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ultra-ho-unit-task-"));
  vi.stubEnv("ADVISOR_BENCH_SWE_DIR", join(root, "swe"));
  vi.stubEnv("ADVISOR_BENCH_SWE_CACHE", join(root, "cache"));
  vi.resetModules();
  ({ unitTask } = await import("../../experiments/ultra-ho/chain.js"));
  ({ loadTask } = await import("../../experiments/ultra-ab/env.js"));
  task("ok", true, true);
  task("ready", true, true, true);
  task("unvalidated", false, true);
  task("no-snapshot", true, false);
});
afterAll(async () => { vi.unstubAllEnvs(); vi.resetModules(); await rm(root, { recursive: true, force: true }); });

describe("unitTask without a recorded fixture root (canonical SWE task)", () => {
  it("resolves the fixture and the snapshot without a prepared venv; the run's loadTask still refuses that task", async () => {
    expect(await unitTask({ task: "ok" })).toEqual({ kind: "swe", dir: join(root, "swe/ok"), source: join(root, "cache/ok/src") });
    await expect(loadTask("ok")).rejects.toThrow(/ok: no prepared environment/);
  });
  it("a prepared venv changes nothing for the analysis", async () => {
    expect(await unitTask({ task: "ready" })).toEqual({ kind: "swe", dir: join(root, "swe/ready"), source: join(root, "cache/ready/src") });
    expect(await loadTask("ready")).toMatchObject({ id: "ready", kind: "swe", source: join(root, "cache/ready/src") });
  });
  it("still refuses an unvalidated task and a missing snapshot (never an empty analysis)", async () => {
    await expect(unitTask({ task: "unvalidated" })).rejects.toThrow(/unvalidated: not validated/);
    await expect(unitTask({ task: "no-snapshot" })).rejects.toThrow(/no-snapshot: no source snapshot at/);
  });
});
