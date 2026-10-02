import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { OrcheBusyError, OrcheController, formatOutcome } from "../../src/extension/controller.js";
import { NoRouteError } from "../../src/extension/config.js";
import type { ConcurrentSession, ConcurrentSessionsResult, DetectConcurrentSessionsOptions } from "../../src/extension/concurrent-sessions.js";
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

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const found = (cwd: string, secondsAgo = 12, id = "other"): ConcurrentSession => ({ id, cwd, file: `/sessions/${id}.jsonl`, lastWriteMs: Date.now() - secondsAgo * 1000 });

/** A controller whose user config may carry `concurrentSessions`, with an injected detector and a recording run. */
async function withDetector(detect: (options: DetectConcurrentSessionsOptions) => Promise<ConcurrentSessionsResult>, settings?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "orche-controller-concurrent-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const f = await fauxRuntime();
  await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: f.route.model }, ...(settings === undefined ? {} : { concurrentSessions: settings }) }));
  const [provider, id] = f.route.model.split("/");
  const seen: RunOptions[] = [];
  let behavior: (options: RunOptions) => Promise<RunReport> = async () => report();
  const ctl = new OrcheController({ agentDir, createRuntime: async () => f.runtime, detectConcurrentSessions: detect, run: async options => { seen.push(options); return behavior(options); } });
  return { root, agentDir, seen, ctl, model: { provider: provider!, id: id! }, onRun: (fn: (options: RunOptions) => Promise<RunReport>) => { behavior = fn; } };
}

describe("OrcheController concurrent pi sessions", () => {
  it("flags the run, puts the warning first in the result and pins it in the progress", async () => {
    const detect = vi.fn(async (_options: DetectConcurrentSessionsOptions) => ({ sessions: [found("/work/repo/packages/a", 12), found("/work/repo", 40, "third")] }));
    const c = await withDetector(detect);
    c.onRun(async options => {
      options.sink?.({ type: "request_classified", timestamp: 3, taskClass: "change", workerCount: 2, language: "en", reason: "r" });
      return report();
    });
    const updates: string[][] = [];
    const outcome = await c.ctl.run({
      request: "do it", cwd: "/work/repo", model: c.model, projectTrusted: true,
      currentSession: { file: "/home/u/.pi/agent/sessions/--work-repo--/me.jsonl", id: "me", dir: "/home/u/.pi/agent/sessions/--work-repo--" },
      onProgress: lines => updates.push([...lines]),
    });

    // Detection ran once, with the run cwd, the configured window and the calling session identified.
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]![0]).toMatchObject({
      cwd: "/work/repo", windowMs: 10 * 60_000,
      currentSessionFile: "/home/u/.pi/agent/sessions/--work-repo--/me.jsonl", currentSessionId: "me",
    });
    expect(detect.mock.calls[0]![0].sessionsDir).toEqual(["/home/u/.pi/agent/sessions", join(c.agentDir, "sessions")]);
    // The run is flagged (T1 contract).
    expect(c.seen[0]!.concurrentActivity).toEqual({ count: 2, detail: expect.stringContaining("/work/repo/packages/a (last write 12s ago)") });
    // The result starts with the warning; the answer text itself is untouched.
    const warning = outcome.concurrentWarning!;
    expect(warning).toMatch(/^⚠ 2 other pi sessions active in this repository \(cwd \/work\/repo\/packages\/a, \/work\/repo, last write 1[12]s ago\); their changes are classified as external where possible$/);
    expect(outcome.text).toBe("final answer");
    expect(formatOutcome(outcome).startsWith(`${warning}\n\norche finished (`)).toBe(true);
    expect(outcome.details.concurrentSessions).toMatchObject({ count: 2 });
    // Progress: shown immediately, and first once milestones arrive.
    expect(updates[0]).toEqual([warning]);
    expect(updates.at(-1)).toEqual([warning, "classified as change with 2 workers"]);
    expect(outcome.details.progress).toEqual([warning, "classified as change with 2 workers"]);
  });

  it("puts the warning first in failed results too, and keeps the error class of a thrown one", async () => {
    const c = await withDetector(async () => ({ sessions: [found("/work/repo")] }));
    c.onRun(async () => report({ status: "failed", summary: "Verification kept failing" }));
    const failed = formatOutcome(await c.ctl.run({ request: "x", cwd: "/work/repo", model: c.model, projectTrusted: true }));
    expect(failed).toMatch(/^⚠ 1 other pi session active in this repository[^\n]*\n\norche FAILED \(change, 3s;/);
    expect(failed).toContain("Verification kept failing");

    c.onRun(async () => { throw new NoRouteError("no route for coordinator"); });
    const thrown = await c.ctl.run({ request: "x", cwd: "/work/repo", model: c.model, projectTrusted: true }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NoRouteError);
    expect((thrown as Error).message).toMatch(/^⚠ 1 other pi session active[^\n]*\n\nno route for coordinator$/);

    c.onRun(async () => { throw new DOMException("aborted", "AbortError"); }); // read-only message: wrapped, cause kept
    const wrapped = await c.ctl.run({ request: "x", cwd: "/work/repo", model: c.model, projectTrusted: true }).catch((error: unknown) => error) as Error;
    expect(wrapped.message).toMatch(/^⚠ 1 other pi session active[^\n]*\n\naborted$/);
    expect(wrapped.cause).toBeInstanceOf(DOMException);
    expect(c.ctl.busy).toBe(false);
  });

  it("adds nothing when no session is detected, and leaves thrown errors alone", async () => {
    const c = await withDetector(async () => ({ sessions: [] }));
    const updates: string[][] = [];
    const outcome = await c.ctl.run({ request: "x", cwd: "/work/repo", model: c.model, projectTrusted: true, onProgress: lines => updates.push([...lines]) });
    expect("concurrentActivity" in c.seen[0]!).toBe(false);
    expect(outcome.concurrentWarning).toBeUndefined();
    expect(outcome.details.concurrentSessions).toBeUndefined();
    expect(formatOutcome(outcome)).not.toContain("other pi session");
    expect(updates).toEqual([]);
    c.onRun(async () => { throw new Error("boom"); });
    await expect(c.ctl.run({ request: "x", cwd: "/work/repo", model: c.model, projectTrusted: true })).rejects.toThrow(/^boom$/);
  });

  it("is silent when detection is disabled in the config, and uses the configured window", async () => {
    const off = vi.fn(async (_options: DetectConcurrentSessionsOptions) => ({ sessions: [found("/work/repo")] }));
    const disabled = await withDetector(off, { enabled: false });
    const outcome = await disabled.ctl.run({ request: "x", cwd: "/work/repo", model: disabled.model, projectTrusted: true });
    expect(off).not.toHaveBeenCalled();
    expect("concurrentActivity" in disabled.seen[0]!).toBe(false);
    expect(formatOutcome(outcome)).not.toContain("other pi session");

    const on = vi.fn(async (_options: DetectConcurrentSessionsOptions) => ({ sessions: [] }));
    const windowed = await withDetector(on, { windowMinutes: 3 });
    await windowed.ctl.run({ request: "x", cwd: "/work/repo", model: windowed.model, projectTrusted: true });
    expect(on.mock.calls[0]![0].windowMs).toBe(3 * 60_000);
    // Without a session manager the default store of the configured agent dir is scanned.
    expect(on.mock.calls[0]![0]).not.toHaveProperty("currentSessionFile");
    expect(on.mock.calls[0]![0].sessionsDir).toEqual([join(windowed.agentDir, "sessions")]);
  });

  it("never blocks or fails the run when detection fails", async () => {
    for (const detect of [
      async () => { throw new Error("detector exploded"); },
      async () => undefined as unknown as ConcurrentSessionsResult,
      async () => ({ sessions: "nope" }) as unknown as ConcurrentSessionsResult,
    ]) {
      const c = await withDetector(detect);
      const outcome = await c.ctl.run({ request: "x", cwd: "/work/repo", model: c.model, projectTrusted: true });
      expect(outcome.report.status).toBe("done");
      expect("concurrentActivity" in c.seen[0]!).toBe(false);
      expect(formatOutcome(outcome)).not.toContain("other pi session");
    }
  });

  it("detects a real session of the same repository through the default detector, excluding the calling session", async () => {
    const root = await mkdtemp(join(tmpdir(), "orche-controller-real-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sessionDir = join(agentDir, "sessions", "--repo--");
    await mkdir(sessionDir, { recursive: true });
    const header = (id: string, cwd: string) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-02T06:10:00.000Z", cwd })}\n`;
    await writeFile(join(sessionDir, "2026-10-02T06-10-00-000Z_me.jsonl"), header("me", repo));
    await writeFile(join(sessionDir, "2026-10-02T06-10-01-000Z_other.jsonl"), header("other", join(repo, "sub")));
    await writeFile(join(sessionDir, "2026-10-02T06-10-02-000Z_elsewhere.jsonl"), header("elsewhere", root));
    const f = await fauxRuntime();
    await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: f.route.model } }));
    const [provider, id] = f.route.model.split("/");
    const seen: RunOptions[] = [];
    const ctl = new OrcheController({ agentDir, createRuntime: async () => f.runtime, run: async options => { seen.push(options); return report(); } });
    const input = { request: "x", cwd: repo, model: { provider: provider!, id: id! }, projectTrusted: true };

    const outcome = await ctl.run({ ...input, currentSession: { file: join(sessionDir, "2026-10-02T06-10-00-000Z_me.jsonl"), id: "me", dir: sessionDir } });
    expect(seen[0]!.concurrentActivity?.count).toBe(1);
    expect(seen[0]!.concurrentActivity?.detail).toContain(join(repo, "sub"));
    expect(formatOutcome(outcome)).toMatch(/^⚠ 1 other pi session active in this repository/);

    // Alone in the repository: nothing to report.
    await rm(join(sessionDir, "2026-10-02T06-10-01-000Z_other.jsonl"));
    await ctl.run({ ...input, currentSession: { id: "me", dir: sessionDir } });
    expect("concurrentActivity" in seen[1]!).toBe(false);
  });
});

