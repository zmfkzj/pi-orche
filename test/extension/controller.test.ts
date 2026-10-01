import { describe, expect, it } from "vitest";
import { OrcheBusyError, OrcheController, formatOutcome } from "../../src/extension/controller.js";
import { runOrchestrated, type RunOptions, type RunReport } from "../../src/orchestration/coordinator.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunLimits } from "../../src/orchestration/limits.js";

const report = (overrides: Partial<RunReport> = {}): RunReport => ({
  status: "done", summary: "summary", tasks: [], startedAt: 1000, finishedAt: 4000, taskClass: "change", answer: "final answer", ...overrides,
});
async function controller(run: (options: RunOptions) => Promise<RunReport>) {
  const f = await fauxRuntime();
  const model = f.route.model.split("/");
  return {
    f,
    model: { provider: model[0]!, id: model[1]! },
    controller: new OrcheController({ agentDir: "/nonexistent-agent-dir", createRuntime: async () => f.runtime, run }),
  };
}
const args = (model: { provider: string; id: string }, extra: object = {}) => ({ request: "do it", cwd: "/nonexistent-cwd", model, thinking: "high" as const, projectTrusted: true, ...extra });

describe("OrcheController", () => {
  it("passes trusted project/user limits through routes and derives defaults on session fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "orche-controller-limits-"));
    const cwd = join(root, "work"), agentDir = join(root, "agent");
    const f = await fauxRuntime();
    const [provider, id] = f.route.model.split("/");
    const seen: RunOptions[] = [];
    const ctl = new OrcheController({ agentDir, createRuntime: async () => f.runtime, run: async options => { seen.push(options); return report(); } });
    try {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(cwd, ".pi", "orche.config.json"), JSON.stringify({ routes: {}, default: { model: f.route.model }, limits: { overallMs: 120000 } }));
      await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: f.route.model }, limits: { decisionMs: 45000 } }));
      const input = { request: "test", cwd, model: { provider: provider!, id: id! }, projectTrusted: true };
      expect((await ctl.run(input)).source.kind).toBe("project");
      expect(seen[0]!.routes.limits).toEqual({ overallMs: 120000 });
      expect(seen[0]!.limits).toBeUndefined();
      expect(resolveRunLimits(seen[0]!.routes.limits)).toMatchObject({ explorationMs: 40000, assignmentMs: 120000, decisionMs: 60000 });
      expect((await ctl.run({ ...input, projectTrusted: false })).source.kind).toBe("user");
      expect(seen[1]!.routes.limits).toEqual({ decisionMs: 45000 });
      await rm(join(cwd, ".pi", "orche.config.json"));
      await rm(join(agentDir, "orche.config.json"));
      expect((await ctl.run(input)).source.kind).toBe("session");
      expect(resolveRunLimits(seen[2]!.routes.limits).overallMs).toBe(3600000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a second run while one is active, and accepts one after it ends", async () => {
    const gate = deferred();
    const c = await controller(async () => { await gate.promise; return report(); });
    const first = c.controller.run(args(c.model));
    await Promise.resolve();
    expect(c.controller.busy).toBe(true);
    await expect(c.controller.run(args(c.model))).rejects.toBeInstanceOf(OrcheBusyError);
    gate.resolve();
    expect((await first).text).toBe("final answer");
    expect(c.controller.busy).toBe(false);
    expect((await c.controller.run(args(c.model))).report.status).toBe("done");
  });

  it("cancel() and the caller's signal both reach the run, and busy clears afterwards", async () => {
    const seen: AbortSignal[] = [];
    const started = { current: deferred() };
    const c = await controller(options => new Promise<RunReport>(resolve => {
      seen.push(options.signal!);
      started.current.resolve();
      const cancelled = () => resolve(report({ status: "failed", summary: "cancelled" }));
      if (options.signal!.aborted) cancelled(); else options.signal!.addEventListener("abort", cancelled);
    }));
    const viaCancel = c.controller.run(args(c.model));
    await started.current.promise;
    expect(c.controller.cancel()).toBe(true);
    expect((await viaCancel).text).toBe("cancelled");
    expect(c.controller.cancel()).toBe(false);

    const external = new AbortController();
    started.current = deferred();
    const viaSignal = c.controller.run(args(c.model, { signal: external.signal }));
    await started.current.promise;
    external.abort();
    expect((await viaSignal).report.status).toBe("failed");
    expect(seen).toHaveLength(2);
    expect(c.controller.busy).toBe(false);
  });

  it("reports the failure summary as text and aggregates usage and progress", async () => {
    const c = await controller(async options => {
      options.sink?.({ type: "usage", timestamp: 1, agentId: "A1", assignmentId: "x", model: "m", input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
      options.sink?.({ type: "advisor_usage", timestamp: 2, name: "a", model: "m", input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
      options.sink?.({ type: "request_classified", timestamp: 3, taskClass: "change", workerCount: 2, language: "en", reason: "r" });
      return report({ status: "failed", summary: "Verification kept failing" });
    });
    const lines: string[][] = [];
    const outcome = await c.controller.run(args(c.model, { onProgress: (progress: readonly string[]) => lines.push([...progress]) }));
    expect(outcome.text).toBe("Verification kept failing");
    expect(outcome.details).toMatchObject({ status: "failed", requests: 2, inputTokens: 15, outputTokens: 3, advisorRequests: 1, durationMs: 3000 });
    expect(lines.at(-1)).toEqual(["classified as change with 2 workers"]);
    expect(formatOutcome(outcome)).toMatch(/^orche FAILED \(change, 3s;/);
  });

  it("throttles activity per actor (5s or a changed tool) without evicting milestones", async () => {
    const lines: string[][] = [];
    const c = await controller(async options => {
      for (let i = 0; i < 10; i++) options.sink?.({ type: "task_finished", timestamp: i, taskId: `T${i}`, agentId: "A1", status: "done" });
      const activity = (timestamp: number, requestCount: number, lastToolName = "read", agentId = "A1") => options.sink?.({ type: "worker_activity", timestamp, agentId, assignmentId: "x", kind: "implement", requestCount, lastToolName });
      activity(100, 1);
      activity(101, 2); // suppressed
      activity(5099, 3); // just below the interval
      activity(5100, 4); // interval boundary
      activity(5101, 4, "edit"); // changed tool, immediate
      activity(5102, 5, "edit"); // suppressed
      activity(5103, 1, "read", "A2"); // independent actor
      options.sink?.({ type: "coordinator_deciding", timestamp: 5104, phase: "EXECUTE" });
      options.sink?.({ type: "coordinator_activity", timestamp: 5105, phase: "EXECUTE", requestCount: 1 });
      options.sink?.({ type: "coordinator_activity", timestamp: 10104, phase: "EXECUTE", requestCount: 2 }); // suppressed
      options.sink?.({ type: "coordinator_activity", timestamp: 10105, phase: "EXECUTE", requestCount: 3 });
      options.sink?.({ type: "coordinator_activity", timestamp: 15105, phase: "EXECUTE", requestCount: 3 }); // identical text, no update
      return report();
    });
    const outcome = await c.controller.run(args(c.model, { onProgress: (progress: readonly string[]) => lines.push([...progress]) }));
    expect(lines).toHaveLength(17); // ten milestones, four worker updates, decision start, two coordinator updates
    expect(lines.slice(10, 14).map(update => update.at(-1))).toEqual([
      "A1 implement · 1 requests · last tool: read", "A1 implement · 4 requests · last tool: read",
      "A1 implement · 4 requests · last tool: edit", "A2 implement · 1 requests · last tool: read",
    ]);
    const retained = Array.from({ length: 8 }, (_, i) => `T${i + 2} done`);
    for (const update of lines.slice(10, 14)) expect(update.slice(0, -1)).toEqual(retained);
    expect(lines[14]).toEqual([...retained.slice(1), "coordinator deciding (EXECUTE)"]);
    expect(outcome.details.progress).toEqual([...retained.slice(1), "coordinator deciding (EXECUTE)", "coordinator deciding (EXECUTE) · 3 requests"]);
  });

  it("keeps in-flight activity as the status when advisor notes are queued", async () => {
    const updates: string[][] = [];
    const c = await controller(async options => {
      options.sink?.({ type: "worker_activity", timestamp: 0, agentId: "A1", assignmentId: "x", kind: "implement", requestCount: 12, lastToolName: "bash" });
      options.sink?.({ type: "advisor_result", timestamp: 1, name: "verification-audit", target: "coordinator", trigger: "assignment_result", verdict: "concern", notes: [], delivered: true });
      options.sink?.({ type: "worker_activity", timestamp: 2, agentId: "A1", assignmentId: "x", kind: "implement", requestCount: 13, lastToolName: "bash" }); // throttled
      options.sink?.({ type: "task_finished", timestamp: 3, agentId: "A2", taskId: "T2", status: "done" }); // another worker ending does not erase A1
      return report();
    });
    const outcome = await c.controller.run(args(c.model, { onProgress: (progress: readonly string[]) => updates.push([...progress]) }));
    expect(updates).toHaveLength(3);
    expect(outcome.details.progress).toEqual([
      "advisor verification-audit: concern → delivered → queued for the coordinator's next decision",
      "T2 done", "A1 implement · 12 requests · last tool: bash",
    ]);
  });


  it("shows advisor delivery, the next decision and reconsideration as milestones", async () => {
    const c = await controller(async options => {
      options.sink?.({ type: "advisor_result", timestamp: 0, name: "verification-audit", target: "coordinator", trigger: "assignment_result", verdict: "concern", notes: [], delivered: true });
      options.sink?.({ type: "coordinator_reconsidering", timestamp: 1, phase: "VERIFY" });
      options.sink?.({ type: "coordinator_deciding", timestamp: 2, phase: "VERIFY" });
      options.sink?.({ type: "advisor_result", timestamp: 3, name: "review", target: "coordinator", trigger: "coordinator_decision", verdict: "blocker", notes: [], delivered: false });
      options.sink?.({ type: "advisor_result", timestamp: 4, name: "review", target: "coordinator", trigger: "coordinator_decision", verdict: "ok", notes: [], delivered: false });
      return report();
    });
    const updates: string[][] = [];
    const outcome = await c.controller.run(args(c.model, { onProgress: (progress: readonly string[]) => updates.push([...progress]) }));
    expect(updates).toHaveLength(4);
    expect(outcome.details.progress).toEqual([
      "advisor verification-audit: concern → delivered → queued for the coordinator's next decision",
      "coordinator reconsidering after advisor notes", "coordinator deciding (VERIFY)", "advisor review: blocker → not delivered",
    ]);
  });

  it("formats cancellation with the pre-teardown worker snapshot and frozen last-tool age", async () => {
    const external = new AbortController();
    const cancellation = { scope: "cancelled" as const, stage: "implement backlog", phase: "EXECUTE", elapsedMs: 2210000, timestamp: 2211000, configuredCapMs: 3600000, effectiveCapMs: 1390000,
      workers: [{ id: "A1", assignmentId: "x", kind: "implement", requestCount: 37, lastToolName: "bash", lastToolAt: 2169000 }, { id: "V1", status: "idle" }],
    };
    const c = await controller(async () => {
      external.abort();
      return report({ status: "failed", summary: "cancelled", cancellation, finishedAt: 2311000 });
    });
    const outcome = await c.controller.run(args(c.model, { signal: external.signal }));
    expect(outcome.text).toBe("cancelled");
    expect(outcome.details.cancellation).toEqual(cancellation);
    expect(formatOutcome(outcome)).toContain("Cancelled at EXECUTE after 2210s; active: A1 implement (37 requests, last tool bash 42s ago), V1 idle");
  });


  it("lists changed files on success and recovery commands on failure", async () => {
    const workspace = { baseline: "0123456789abcdef0123", changes: [{ path: "src/a.js", status: "modified" as const }, { path: "stray.txt", status: "added" as const }] };
    for (const status of ["done", "failed"] as const) {
      const c = await controller(async () => report({ status, summary: "broken", workspace }));
      const text = formatOutcome(await c.controller.run(args(c.model)));
      if (status === "done") {
        expect(text).toContain("Changed files: src/a.js, stray.txt");
        expect(text).not.toContain("git restore");
      } else {
        expect(text).toContain("baseline 0123456789ab, ref refs/pi-orche/baseline");
        expect(text).toContain("git restore --source=0123456789abcdef0123 --worktree -- src/a.js");
        expect(text).toContain("rm -- stray.txt");
      }
    }
  });

  it("does not reuse a runtime with pending provider startup cleanup", async () => {
    const f = await fauxRuntime();
    let creations = 0, runs = 0;
    const ctl = new OrcheController({ agentDir: "/nonexistent-agent-dir", createRuntime: async () => { creations++; return f.runtime; },
      run: async options => { await options.createRuntime!(); return report(++runs === 1 ? { status: "failed", cleanup: { incomplete: true, pending: ["providers"] } } : {}); },
    });
    const [provider, id] = f.route.model.split("/");
    for (let i = 0; i < 3; i++) await ctl.run(args({ provider: provider!, id: id! }));
    expect(creations).toBe(2);
    expect(ctl.busy).toBe(false);
  });

  it("validates an unknown session model inside the deadline-covered runtime preparation", async () => {
    const c = await controller(runOrchestrated);
    const outcome = await c.controller.run(args({ provider: "ghost", id: "missing" }));
    expect(outcome.report.status).toBe("failed");
    expect(outcome.report.summary).toContain(".pi/orche.config.json");
    expect(c.controller.busy).toBe(false);
  });
});
