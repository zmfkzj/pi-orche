import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VARIANTS } from "../../experiments/judgment/variants.js";
import { VARIANTS_V2 } from "../../experiments/judgment/variants-v2.js";
import { MAX_SUB_WORKERS, orchestratorSection, SPLIT_JUDGMENT, splitError } from "../../src/orchestrator/instructions.js";
import { createSpawnTool, DEPTH_LIMIT_MESSAGE, executeSpawn, planSpawn, SPAWN_TOOL, type PlannedWorker, type SpawnContext, type SpawnParameters, type SubWorkerOutcome } from "../../src/orchestrator/spawn.js";
import { createSubWorkerRunner, subWorkerGuard } from "../../src/orchestrator/sub-worker.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

let ids = 0;
const nextId = () => `W1.${++ids}`;
const outcome = (worker: PlannedWorker, extra: Partial<SubWorkerOutcome> = {}): SubWorkerOutcome => ({
  id: worker.id, name: worker.name, role: worker.role, reason: worker.reason, status: worker.role === "verify" ? "passed" : "done", summary: `${worker.name} done`,
  ...(worker.files ? { files: worker.files } : {}), model: "p/m", requests: 1, models: { "p/m": 1 }, startedAt: Date.now(), durationMs: 1, costUSD: 0, changes: [], ...extra,
});
const context = (overrides: Partial<SpawnContext> = {}): SpawnContext => ({ orchestrator: "W1", nextId, runWorker: async worker => outcome(worker), ...overrides });

describe("the adopted split instruction (docs/orchestrator.md 5, 8, 9)", () => {
  it("is the checklist variant both pre-registered evaluations selected, verbatim, rendered in the orchestrator section", () => {
    expect(SPLIT_JUDGMENT).toBe(VARIANTS.checklist);
    expect(SPLIT_JUDGMENT).toBe(VARIANTS_V2.checklist);
    expect(orchestratorSection()).toContain(SPLIT_JUDGMENT);
  });
  it("renders another variant through the same section (evaluation v2 uses this path)", () => {
    expect(VARIANTS_V2.fewshot).toBe(VARIANTS.fewshot);
    const section = orchestratorSection(VARIANTS_V2["checklist-sized"]!);
    expect(section).toContain(VARIANTS_V2["checklist-sized"]!);
    expect(section).not.toContain(SPLIT_JUDGMENT);
  });
});

describe("no split (the default)", () => {
  it("accepts a report without data.split when no sub-worker ran, and validates it when given", () => {
    expect(splitError({ status: "done" }, new Set())).toBeUndefined();
    expect(splitError({ split: { decision: "none", reason: "one coupled change" } }, new Set())).toBeUndefined();
    expect(splitError({ split: { decision: "split", reason: "x" } }, new Set())).toMatch(/criteria/);
    expect(splitError({ split: { decision: "maybe", reason: "x" } }, new Set())).toMatch(/Invalid data.split/);
  });
  it("requires the decision to name every reason orche_spawn was used for", () => {
    expect(splitError({ status: "done" }, new Set(["parallelism"]))).toMatch(/required after orche_spawn/);
    expect(splitError({ split: { decision: "none", reason: "x" } }, new Set(["parallelism"]))).toMatch(/must be "split"/);
    expect(splitError({ split: { decision: "split", criteria: ["parallelism"], reason: "x" } }, new Set(["parallelism", "verification"]))).toMatch(/verification/);
    expect(splitError({ split: { decision: "split", criteria: ["parallelism", "verification"], reason: "x" } }, new Set(["parallelism", "verification"]))).toBeUndefined();
  });
  it("the tool refuses to run outside an orchestrator assignment", async () => {
    const tool = createSpawnTool(() => "orche_spawn is available only to the orchestrator");
    const result = await tool.execute("c1", { reason: "parallelism", workers: [] } as never, undefined, undefined, undefined as never);
    expect(result).toMatchObject({ isError: true });
  });
});

describe("parallel split", () => {
  it("runs every sub-worker at the same time and returns all reports", async () => {
    let running = 0;
    let peak = 0;
    const params: SpawnParameters = { reason: "parallelism", workers: [
      { name: "csv", role: "implement", request: "Add the CSV exporter", files: ["src/csv.ts", "test/csv.test.ts"] },
      { name: "cache", role: "implement", request: "Add the cache", files: ["src/cache/"] },
      { name: "docs", role: "implement", request: "Document both", files: ["docs/export.md"] },
    ] };
    const spawned: string[] = [];
    const result = await executeSpawn(context({
      runWorker: async worker => { running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 30)); running--; return outcome(worker); },
      onSpawned: (reason, outcomes) => spawned.push(reason, ...outcomes.map(item => item.name)),
    }), params, undefined);
    expect(peak).toBe(3);
    expect(result.details.workers.map(worker => [worker.name, worker.status])).toEqual([["csv", "done"], ["cache", "done"], ["docs", "done"]]);
    expect(spawned).toEqual(["parallelism", "csv", "cache", "docs"]);
    expect(result.text).toContain("You own the result");
  });
  it("needs two or more workers and at most MAX_SUB_WORKERS", () => {
    expect(() => planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "implement", request: "x", files: ["a.ts"] }] }, { nextId })).toThrow(/two or more/);
    const many = Array.from({ length: MAX_SUB_WORKERS + 1 }, (_, index) => ({ name: `w${index}`, role: "answer" as const, request: "x" }));
    expect(() => planSpawn({ reason: "parallelism", workers: many }, { nextId })).toThrow(/1 to/);
  });
  it("a read-only orchestrator (answer) spawns only read-only workers", () => {
    expect(() => planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "answer", request: "x" }, { name: "b", role: "implement", request: "y", files: ["b.ts"] }] }, { readOnly: true, nextId })).toThrow(/read-only/);
    expect(planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "answer", request: "x" }, { name: "b", role: "answer", request: "y" }] }, { readOnly: true, nextId }).workers).toHaveLength(2);
  });
});

describe("file conflicts", () => {
  it("refuses overlapping ownership, writers without files and files outside the orchestrator's scope", () => {
    expect(() => planSpawn({ reason: "parallelism", workers: [
      { name: "a", role: "implement", request: "x", files: ["src/"] }, { name: "b", role: "implement", request: "y", files: ["src/b.ts"] },
    ] }, { nextId })).toThrow(/overlap/);
    expect(() => planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "implement", request: "x" }, { name: "b", role: "answer", request: "y" }] }, { nextId })).toThrow(/must name the files/);
    expect(() => planSpawn({ reason: "parallelism", workers: [
      { name: "a", role: "implement", request: "x", files: ["src/a.ts"] }, { name: "b", role: "implement", request: "y", files: ["docs/b.md"] },
    ] }, { scope: ["src/"], nextId })).toThrow(/outside your own write scope/);
    expect(() => planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "implement", request: "x", files: ["src/*.ts"] }, { name: "b", role: "answer", request: "y" }] }, { nextId })).toThrow(/Unsupported ownership path/);
  });
  it("a refused call uses no ids", () => {
    let used = 0;
    expect(() => planSpawn({ reason: "parallelism", workers: [{ name: "a", role: "implement", request: "x", files: ["a.ts"] }, { name: "a", role: "implement", request: "y", files: ["b.ts"] }] }, { nextId: () => `x${++used}` })).toThrow(/Duplicate/);
    expect(used).toBe(0);
  });
  it("the sub-worker guard blocks writes outside its own files and into a sibling's", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orche-spawn-"));
    roots.push(cwd);
    const { workers } = planSpawn({ reason: "parallelism", workers: [
      { name: "a", role: "implement", request: "x", files: ["src/a.ts"] }, { name: "b", role: "implement", request: "y", files: ["src/b.ts"] },
    ] }, { nextId });
    const guard = subWorkerGuard(workers[0]!, workers, cwd);
    expect(await guard("edit", { path: "src/a.ts" })).toBeUndefined();
    expect(await guard("write", { path: "src/b.ts" })).toBeTruthy();
    expect(await guard("write", { path: "README.md" })).toBeTruthy();
    expect(await guard("read", { path: "src/b.ts" })).toBeUndefined();
  });
  it("warns about changes outside every sub-worker's owned files and attributes owned ones", async () => {
    const params: SpawnParameters = { reason: "parallelism", workers: [
      { name: "a", role: "implement", request: "x", files: ["src/a.ts"] }, { name: "b", role: "implement", request: "y", files: ["src/b.ts"] },
    ] };
    const result = await executeSpawn(context({
      snapshot: async () => "tree", diff: async () => [{ path: "src/a.ts", status: "modified" }, { path: "package.json", status: "modified" }] as never,
    }), params, undefined);
    expect(result.details.workers[0]!.changes).toEqual(["src/a.ts"]);
    expect(result.details.warnings.join("\n")).toContain("package.json");
  });
});

describe("independent verification", () => {
  it("takes role verify only, and role verify only under verification", () => {
    expect(() => planSpawn({ reason: "verification", workers: [{ name: "v", role: "implement", request: "x", files: ["a.ts"] }] }, { nextId })).toThrow(/role verify only/);
    expect(() => planSpawn({ reason: "parallelism", workers: [{ name: "v", role: "verify", request: "x" }, { name: "w", role: "answer", request: "y" }] }, { nextId })).toThrow(/use reason "verification"/);
    const { workers } = planSpawn({ reason: "verification", workers: [{ name: "v", role: "verify", request: "Check R1-R3 against the diff", files: ["ignored.ts"] }] }, { nextId });
    expect(workers[0]).toMatchObject({ role: "verify", reason: "verification" });
    expect(workers[0]!.files).toBeUndefined();
  });
  it("a fresh verifier sees only its own request and may not write", async () => {
    const seen: string[] = [];
    const cwd = await mkdtemp(join(tmpdir(), "orche-verify-"));
    roots.push(cwd);
    await executeSpawn(context({ runWorker: async (worker, siblings) => {
      seen.push(worker.request);
      expect(await subWorkerGuard(worker, siblings, cwd)("edit", { path: "src/a.ts" })).toBeTruthy();
      return outcome(worker);
    } }), { reason: "verification", workers: [{ name: "v", role: "verify", request: "Original request: R1 add --json. Changed: src/cli.ts" }] }, undefined);
    expect(seen).toEqual(["Original request: R1 add --json. Changed: src/cli.ts"]);
  });
});

describe("isolation and model routes", () => {
  const env = (calls: string[]) => ({
    orchestrator: "W1", cwd: tmpdir(), runtime: { getModel: () => undefined } as never,
    route: { role: "implementer", model: "main/orchestrator-model", thinking: "high" },
    specialistRoute: (role: "game-asset" | "video") => { calls.push(role); return { role, model: `routes/${role}-model` }; },
    prompt: (worker: PlannedWorker) => worker.request, timeoutMs: 1_000, maxTurns: 2,
  });
  it("a specialist runs on its own route; a standard sub-worker inherits the orchestrator's model", async () => {
    const calls: string[] = [];
    const run = createSubWorkerRunner(env(calls) as never);
    const { workers } = planSpawn({ reason: "isolation", workers: [{ name: "sprites", role: "game-asset", request: "Make the sprite sheet", files: ["assets/"] }, { name: "notes", role: "answer", request: "Summarize" }] }, { nextId });
    const signal = new AbortController().signal;
    const [asset, answer] = await Promise.all(workers.map(worker => run(worker, workers, signal, () => undefined)));
    expect(calls).toEqual(["game-asset"]);
    expect(asset!.model).toBe("routes/game-asset-model");
    expect(answer!.model).toBe("main/orchestrator-model");
    // No such models in the fake runtime: each outcome is a failure, never a thrown error.
    expect([asset!.status, answer!.status]).toEqual(["failed", "failed"]);
  });
});

describe("depth limit", () => {
  it("a sub-worker's guard refuses orche_spawn", async () => {
    const { workers } = planSpawn({ reason: "verification", workers: [{ name: "v", role: "verify", request: "x" }] }, { nextId });
    expect(await subWorkerGuard(workers[0]!, workers, tmpdir())(SPAWN_TOOL, {})).toBe(DEPTH_LIMIT_MESSAGE);
  });
});
