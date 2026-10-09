import type { DeadlineExtendedEvent } from "../../src/orchestration/run/extension.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { OrcheController } from "../../src/extension/controller.js";
import { TaskFailedError, WorkerPool, type TaskParameters } from "../../src/extension/workers.js";
import type { OrcheRunArgs } from "../../src/extension/controller.js";
import { deadlineInfoOf, extendDeadline, initialDeadline, partialUpdate, timingDetails, type DeadlineInfo, type RunTiming } from "../../src/extension/progress.js";
import { ExtendableDeadline } from "../../src/orchestration/run/extension.js";
import { defaultRunLimits } from "../../src/orchestration/limits.js";
import { answerScript, createHarness, decision, tool, type Harness } from "./harness.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

/**
 * What orche_run / orche_task send for the TUI's elapsed timer (render.ts): `details.startedAt` and `details.deadline` (base cap, current cap,
 * extensions used / allowed) in every partial update, `startedAt` / `finishedAt` / `deadline` in the final details (success, failure and
 * cancellation alike), a deadline that follows each timeout extension, and a model-facing `content` that does not change.
 */
const MINUTE = 60_000;
const BASE = 30 * MINUTE;

const open: Harness[] = [];
const pools = new Set<WorkerPool>();
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const pool of pools) await pool.dispose();
  pools.clear();
  for (const h of open.splice(0)) await h.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ---- the data helpers (progress.ts) ----

describe("deadline info helpers", () => {
  it("starts from the base cap with no extension used, and the ceiling is base + maxExtensions × extensionMs", () => {
    expect(initialDeadline(BASE, { extensionMs: BASE, maxExtensions: 10 }, 1000)).toEqual({
      baseMs: BASE, capMs: BASE, deadlineAt: 1000 + BASE, extensionMs: BASE, extensionsUsed: 0, maxExtensions: 10, hardLimitMs: 330 * MINUTE,
    });
    // with extending off the ceiling is the base cap, whatever extensionMs says
    expect(initialDeadline(BASE, { extensionMs: BASE, maxExtensions: 0 }, 0).hardLimitMs).toBe(BASE);
    expect(initialDeadline(BASE, { extensionMs: 0, maxExtensions: 5 }, 0).hardLimitMs).toBe(BASE);
  });

  it("the UI ceiling of the default linear schedule is 30 min + 10 + 20 + ... + 100 min = 580 min, also from a live deadline", async () => {
    const { resolveRunLimits } = await import("../../src/orchestration/limits.js");
    const limits = resolveRunLimits();
    expect(initialDeadline(limits.assignmentMs, limits, 0)).toEqual({ baseMs: BASE, capMs: BASE, deadlineAt: BASE, extensionMs: 10 * MINUTE, extensionStepMs: 10 * MINUTE, extensionsUsed: 0, maxExtensions: 10, hardLimitMs: 580 * MINUTE });
    let now = 0;
    const live = ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs, startedAt: 0, now: () => now });
    const active = { active: true, reasons: ["W1 streaming"], sessions: [] };
    now = BASE; live.tryExtend({ scope: "assignment", stage: "s", liveness: active });
    now = BASE + 10 * MINUTE; live.tryExtend({ scope: "assignment", stage: "s", liveness: active });
    // The live view shows the latest extension's length (20 min) and the cap 30 + 10 + 20 = 60 min.
    expect(deadlineInfoOf(live)).toEqual({ baseMs: BASE, capMs: 60 * MINUTE, deadlineAt: 60 * MINUTE, extensionMs: 20 * MINUTE, extensionStepMs: 10 * MINUTE, extensionsUsed: 2, maxExtensions: 10, hardLimitMs: 580 * MINUTE });
  });

  it("moves the cap by the overall deadline of the event; without it overall/assignment grow by one extension and a phase cap stays", () => {
    const start = initialDeadline(BASE, { extensionMs: BASE, maxExtensions: 10 }, 1000);
    const exact = extendDeadline(start, { n: 1, max: 10, extensionMs: BASE, scope: "overall", overallDeadline: 1000 + 2 * BASE }, 1000);
    expect(exact).toMatchObject({ capMs: 2 * BASE, deadlineAt: 1000 + 2 * BASE, extensionsUsed: 1, maxExtensions: 10, baseMs: BASE, hardLimitMs: 330 * MINUTE });
    // the overall deadline of a phase extension that crossed it is in the event: exact again
    expect(extendDeadline(exact, { n: 2, max: 10, extensionMs: BASE, scope: "phase", overallDeadline: 1000 + 3 * BASE }, 1000).capMs).toBe(3 * BASE);
    // hand-made events without it
    expect(extendDeadline(start, { n: 1, max: 10, extensionMs: BASE, scope: "overall" }, 1000)).toMatchObject({ capMs: 2 * BASE, extensionsUsed: 1 });
    expect(extendDeadline(start, { n: 1, max: 10, extensionMs: BASE, scope: "assignment" }, 1000).capMs).toBe(2 * BASE);
    expect(extendDeadline(start, { n: 1, max: 10, extensionMs: BASE, scope: "phase" }, 1000)).toMatchObject({ capMs: BASE, extensionsUsed: 1 });
    expect(start.extensionsUsed).toBe(0); // the old value is not modified
  });

  it("reads the state of a live ExtendableDeadline", () => {
    const deadline = new ExtendableDeadline({ startedAt: 5000, overallMs: 100, extensionMs: 50, maxExtensions: 3, now: () => 5000 });
    expect(deadlineInfoOf(deadline)).toEqual({ baseMs: 100, capMs: 100, deadlineAt: 5100, extensionMs: 50, extensionsUsed: 0, maxExtensions: 3, hardLimitMs: 250 });
    const result = deadline.tryExtend({ scope: "assignment", stage: "W1 explore", expired: 5100, liveness: { active: true, reasons: ["W1 busy"], sessions: [] } });
    expect(result.extended).toBe(true);
    expect(deadlineInfoOf(deadline)).toEqual({ baseMs: 100, capMs: 150, deadlineAt: 5150, extensionMs: 50, extensionsUsed: 1, maxExtensions: 3, hardLimitMs: 250 });
  });

  it("partialUpdate keeps the old shape (text = the lines, details.progress = the lines) and adds the timing keys only when there is some", () => {
    const deadline: DeadlineInfo = initialDeadline(BASE, { extensionMs: BASE, maxExtensions: 10 }, 7);
    expect(partialUpdate(["a", "b"])).toEqual({ content: [{ type: "text", text: "a\nb" }], details: { progress: ["a", "b"] } });
    expect(partialUpdate([], { startedAt: 7, deadline })).toEqual({ content: [{ type: "text", text: "" }], details: { progress: [], startedAt: 7, deadline } });
    expect(partialUpdate(["a"], { startedAt: 7 })).toEqual({ content: [{ type: "text", text: "a" }], details: { progress: ["a"], startedAt: 7 } });
    const timing: RunTiming = { startedAt: 7, finishedAt: 9, deadline };
    expect(timingDetails(timing)).toEqual({ startedAt: 7, finishedAt: 9, deadline });
    expect(timingDetails(timing).deadline).not.toBe(deadline); // a copy: later changes of the source do not leak into a sent update
    expect(timingDetails(undefined)).toEqual({});
  });
});

// ---- the controller (orche_run) with scripted runs ----

const T = 1_790_000_000_000;
/** What the callbacks of a run saw, in order. */
function recorder() {
  const seen: Array<{ kind: "timing" | "progress"; lines: string[]; timing: RunTiming | undefined }> = [];
  return {
    seen,
    callbacks: {
      onTiming: (timing: RunTiming, lines: readonly string[]) => { seen.push({ kind: "timing", lines: [...lines], timing }); },
      onProgress: (lines: readonly string[], timing?: RunTiming) => { seen.push({ kind: "progress", lines: [...lines], timing }); },
    },
  };
}
const extended = (n: number, extra: Partial<DeadlineExtendedEvent> = {}): DeadlineExtendedEvent => ({
  type: "deadline_extended", timestamp: T + n * 1000, scope: "overall", stage: "implement backlog", extension: n, maxExtensions: 10, extensionMs: BASE,
  newDeadline: T + 40 + BASE * (n + 1), overallDeadline: T + 40 + BASE * (n + 1), reasons: ["W2 bash running 12m, cpu progressing"], ...extra,
});


function expectNoTimingText(text: string): void {
  expect(text).not.toMatch(/⏱|\btook\b|startedAt|finishedAt|elapsed/i);
}

// ---- the extension as pi loads it: orche_run and orche_task through a real AgentSession ----

interface ToolMessage { role: string; toolName?: string; isError?: boolean; content: { type: string; text?: string }[]; details?: Record<string, any> }
const resultsOf = (h: Harness, name: string) => h.session.messages.filter(message => message.role === "toolResult" && (message as unknown as ToolMessage).toolName === name) as unknown as ToolMessage[];
const textOf = (message: { content: { text?: string }[] }) => message.content.map(part => part.text ?? "").join("\n");
/** The partial updates (`tool_execution_update`) of the tool the session reports, as pi's TUI gets them. */
function watch(h: Harness, name: string) {
  const partials: Array<{ content: { type: string; text?: string }[]; details?: Record<string, any> }> = [];
  h.session.subscribe(event => { if (event.type === "tool_execution_update" && event.toolName === name) partials.push(event.partialResult); });
  return partials;
}

interface Path {
  name: "orche_run" | "orche_task";
  /** orche_task needs a git work tree for its workspace audit. */
  git: boolean;
  mainSteps(): FauxResponseStep[];
  orcheSteps(): FauxResponseStep[];
  head: RegExp;
}
const paths: Path[] = [
  {
    name: "orche_run", git: false,
    mainSteps: () => [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")],
    orcheSteps: () => answerScript("RUN_DONE"),
    head: /^orche finished \(answer, \d+s, \d+ model requests; /,
  },
  {
    name: "orche_task", git: true,
    mainSteps: () => [tool("orche_task", { role: "explore", request: "Inspect greeting.txt" }), reply("relayed")],
    orcheSteps: () => [tool("report_result", { kind: "explore", summary: "Evidence found" })],
    head: /^orche task W1 \(explore, \d+s, \d+ requests; /,
  },
];

async function harness(path: Path, limits?: Record<string, number>, steps: { main?: FauxResponseStep[]; orche?: FauxResponseStep[] } = {}) {
  const h = await createHarness({ mainSteps: steps.main ?? path.mainSteps(), orcheSteps: steps.orche ?? path.orcheSteps() });
  open.push(h);
  if (path.git) execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  if (limits) await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "auto", limits }));
  return h;
}


describe("the timing of calls that did not succeed", () => {

  it("orche_task: a timed-out assignment keeps its timing in the error details, and the deadline in the partial updates follows the extensions", async () => {
    const blocked: FauxResponseStep = async (_context, options) => {
      await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return reply("aborted");
    };
    const h = await harness(paths[1]!, { assignmentMs: 300, extensionMs: 200, maxExtensions: 2 }, { main: [tool("orche_task", { role: "explore", request: "long task" }), reply("noted")], orche: [blocked] });
    const partials = watch(h, "orche_task");
    await h.session.prompt("delegate");
    const [result] = resultsOf(h, "orche_task");
    expect(result?.isError).toBe(true);
    expect(textOf(result!)).toContain("Worker W1 timed out after 700ms (extension budget 2/2 used)");
    const steps = partials.map(partial => partial.details!.deadline as DeadlineInfo);
    const distinct = steps.filter((deadline, index) => index === 0 || deadline.extensionsUsed !== steps[index - 1]!.extensionsUsed);
    expect(distinct.map(deadline => [deadline.capMs, deadline.extensionsUsed, deadline.maxExtensions])).toEqual([[300, 0, 2], [500, 1, 2], [700, 2, 2]]);
    const details = result!.details!;
    expect(details).toMatchObject({ worker: "W1", status: "timeout", startedAt: expect.any(Number), finishedAt: expect.any(Number), deadline: { baseMs: 300, capMs: 700, extensionsUsed: 2, maxExtensions: 2, hardLimitMs: 700 } });
    expect(details.finishedAt - details.startedAt).toBe(details.durationMs);
    expect(partials.every(partial => partial.details!.startedAt === details.startedAt)).toBe(true);
  });
});

// ---- the worker pool (orche_task) directly ----

describe("orche_task (worker pool): timing callbacks and details", () => {
  async function pool(steps: FauxResponseStep[], limits: Record<string, number>) {
    const h = await createHarness({ mainSteps: [], orcheSteps: steps });
    open.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await writeFile(join(h.agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, limits }));
    const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h.runtime, detectConcurrentSessions: async () => ({ sessions: [] }) });
    const workers = new WorkerPool({ controller, agentDir: h.agentDir });
    pools.add(workers);
    const rec = recorder();
    const run = (extra: Partial<TaskParameters & OrcheRunArgs> = {}) => workers.execute({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false, ...rec.callbacks, ...extra });
    return { h, workers, rec, run };
  }
  const explored = (summary = "Evidence found") => tool("report_result", { kind: "explore", summary });

  it("announces the start and the assignment's deadline first, and every progress update repeats the same start with the live deadline", async () => {
    const { rec, run } = await pool([explored()], { assignmentMs: 20 * MINUTE, extensionMs: 5 * MINUTE, maxExtensions: 4 });
    const before = Date.now();
    const { text, details } = await run();
    expect(rec.seen[0]!.kind).toBe("timing");
    expect(rec.seen[0]!.lines).toEqual([]);
    const startedAt = rec.seen[0]!.timing!.startedAt;
    expect(startedAt).toBeGreaterThanOrEqual(before);
    for (const update of rec.seen) {
      expect(update.timing!.startedAt).toBe(startedAt);
      expect(update.timing!.deadline).toMatchObject({ baseMs: 20 * MINUTE, capMs: 20 * MINUTE, extensionMs: 5 * MINUTE, extensionsUsed: 0, maxExtensions: 4, hardLimitMs: 40 * MINUTE });
    }
    expect(rec.seen.at(-1)).toMatchObject({ kind: "progress", lines: [] }); // the closing update clears the lines
    expect(details).toMatchObject({ startedAt, deadline: { capMs: 20 * MINUTE, maxExtensions: 4 } });
    expect(details.finishedAt! - details.startedAt!).toBe(details.durationMs);
    expectNoTimingText(text);
  });

  it("raises the deadline of the progress updates by each extension granted to the assignment", async () => {
    const entered = deferred(), release = deferred();
    const held: FauxResponseStep = async () => { entered.resolve(); await release.promise; return explored("Evidence after the extension"); };
    const { rec, run } = await pool([held], { assignmentMs: 200, extensionMs: 1000, maxExtensions: 2 });
    const running = run();
    await entered.promise;
    await vi.waitFor(() => expect(rec.seen.some(update => update.timing?.deadline?.extensionsUsed === 1)).toBe(true), { timeout: 5000 });
    release.resolve();
    const { details } = await running;
    const extendedUpdate = rec.seen.find(update => update.timing?.deadline?.extensionsUsed === 1)!;
    expect(extendedUpdate.lines.some(line => line.startsWith("⏱ timeout extended 1/2"))).toBe(true);
    expect(extendedUpdate.timing!.deadline).toMatchObject({ baseMs: 200, capMs: 1200, extensionsUsed: 1, maxExtensions: 2, hardLimitMs: 2200 });
    expect(extendedUpdate.timing!.deadline!.deadlineAt).toBeGreaterThan(extendedUpdate.timing!.startedAt + 1000);
    expect(details.deadline).toMatchObject({ capMs: 1200, extensionsUsed: 1, maxExtensions: 2 });
    expect(details.extensions).toHaveLength(1); // the list of extensions is still there, unchanged
  });

  it("a task that failed keeps the timing in the error details; its message and error result content are the usual ones", async () => {
    const blocked: FauxResponseStep = async (_context, options) => {
      await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return reply("aborted");
    };
    const { run, workers } = await pool([blocked], { assignmentMs: 150, extensionMs: 100, maxExtensions: 0 });
    const error = await run().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskFailedError);
    const failed = error as TaskFailedError;
    expect(failed.message.split("\n")[0]).toBe("Worker W1 timed out after 150ms");
    expect(failed.message).toContain('Resume: a timeout is not an unmet result');
    expect(failed.details).toMatchObject({ status: "timeout", startedAt: expect.any(Number), deadline: { baseMs: 150, capMs: 150, extensionsUsed: 0, maxExtensions: 0, hardLimitMs: 150 } });
    expect(failed.details.finishedAt! - failed.details.startedAt!).toBe(failed.details.durationMs);
    const asTool = failed.toolResult();
    expect(asTool).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Worker W1 timed out after 150ms\nCheckpoint at the timeout/) }], details: { startedAt: failed.details.startedAt } });
    expect(workers.list()[0]?.status).toBe("idle");
  });

  it("the outcome of a task is reported as before when no callback is given", async () => {
    const { workers, h } = await pool([explored()], { assignmentMs: 20 * MINUTE });
    const outcome = await workers.executeTool({ role: "explore", request: "Find the evidence", cwd: h.cwd, projectTrusted: false });
    expect(outcome.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^orche task W1 \(explore, \d+s, \d+ requests; /) });
    expectNoTimingText((outcome.content[0] as { text: string }).text);
    expect(outcome.details).toMatchObject({ startedAt: expect.any(Number), finishedAt: expect.any(Number), deadline: { baseMs: 20 * MINUTE } });
  });
});
