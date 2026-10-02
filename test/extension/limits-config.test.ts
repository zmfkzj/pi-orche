import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, type FauxResponseStep } from "@earendil-works/pi-ai";
import { defaultRunLimits } from "../../src/orchestration/limits.js";
import { ExtendableDeadline } from "../../src/orchestration/run/extension.js";
import { answerScript, createHarness, tool, type Harness } from "./harness.js";

/**
 * The timeout-extension keys of `limits` in orche.config.json (`maxExtensions`, `extensionMs`) really reach the deadline of
 * BOTH delegation tools, end to end through a real AgentSession with the extension loaded: the tool is called by the (faux) main
 * model, the config is discovered the way the extension does it (trusted `<cwd>/.pi/orche.config.json`, else
 * `<agentDir>/orche.config.json`), and what is asserted is the ExtendableDeadline the real run (controller path: `orche_run` →
 * runOrchestrated) or the real assignment (WorkerPool path: `orche_task`) is built with, plus, with short caps, the behaviour
 * it produces. Everything lives in temporary directories: the harness agent dir is a temp dir, so no user config is ever touched.
 */
const open: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of open.splice(0)) await h.dispose();
});

const MINUTE = 60_000;
const BASE = 30 * MINUTE; // default base cap
const DEFAULT_EXT = 30 * MINUTE;

/** The user-level file the harness writes has no `limits`; these rewrite it (or add the project file) with the given `limits`. */
const configOf = (h: Harness, limits?: unknown) => JSON.stringify({
  routes: {}, default: { model: h.orche.route.model }, records: { enabled: false }, mainMode: "auto", ...(limits === undefined ? {} : { limits }),
});
const writeUser = (h: Harness, limits?: unknown) => writeFile(join(h.agentDir, "orche.config.json"), configOf(h, limits));
async function writeProject(h: Harness, limits?: unknown) {
  await mkdir(join(h.cwd, ".pi"), { recursive: true });
  await writeFile(join(h.cwd, ".pi", "orche.config.json"), configOf(h, limits));
}

/** Every ExtendableDeadline the code under test builds (`fromLimits` is how both a run and an assignment make theirs), in order. */
function recordDeadlines() {
  const spy = vi.spyOn(ExtendableDeadline, "fromLimits");
  return () => spy.mock.results.flatMap(entry => entry.type === "return" ? [entry.value as ExtendableDeadline] : []);
}
const settingsOf = (deadline: ExtendableDeadline) => ({
  baseMs: deadline.baseOverallMs, extensionMs: deadline.extensionMs, maxExtensions: deadline.maxExtensions, hardLimitMs: deadline.hardLimitMs,
});
const expected = (baseMs: number, extensionMs: number, maxExtensions: number) => ({ baseMs, extensionMs, maxExtensions, hardLimitMs: baseMs + maxExtensions * extensionMs });

interface ToolResultMessage { role: string; toolName?: string; isError?: boolean; content: { type: string; text?: string }[]; details?: Record<string, any> }
const resultsOf = (h: Harness, name: string) => h.session.messages.filter(message => message.role === "toolResult" && (message as unknown as ToolResultMessage).toolName === name) as unknown as ToolResultMessage[];
const textOf = (message: ToolResultMessage) => message.content.map(part => part.text ?? "").join("\n");

/** A model request that never answers until the run/assignment aborts it: the session is "waiting for the model", which counts as active. */
const hold = (): FauxResponseStep => async (_context, options) => {
  await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
  return reply("stopped");
};
const explored = (summary = "Evidence found") => tool("report_result", { kind: "explore", summary });

/** The two delegation tools, each with a script that makes it finish normally. */
interface Path {
  name: string;
  toolName: "orche_run" | "orche_task";
  /** `calls` tool calls by the main model, each followed by a final text turn. */
  mainSteps(calls: number): FauxResponseStep[];
  orcheSteps(calls: number): FauxResponseStep[];
  /** orche_task needs a git work tree for its workspace audit. */
  git: boolean;
}
const paths: Path[] = [
  {
    name: "orche_run (controller path: runOrchestrated)", toolName: "orche_run", git: false,
    mainSteps: calls => Array.from({ length: calls }, () => [tool("orche_run", { request: "explain greeting.txt" }), reply("relayed")]).flat(),
    orcheSteps: calls => Array.from({ length: calls }, () => answerScript("RUN_DONE")).flat(),
  },
  {
    name: "orche_task (WorkerPool path: executeAssignment)", toolName: "orche_task", git: true,
    mainSteps: calls => Array.from({ length: calls }, () => [tool("orche_task", { role: "explore", request: "Inspect greeting.txt" }), reply("relayed")]).flat(),
    orcheSteps: calls => Array.from({ length: calls }, () => explored()),
  },
];

async function harness(path: Path, options: { calls?: number; mainSteps?: FauxResponseStep[]; orcheSteps?: FauxResponseStep[] } = {}) {
  const calls = options.calls ?? 1;
  const h = await createHarness({ mainSteps: options.mainSteps ?? path.mainSteps(calls), orcheSteps: options.orcheSteps ?? path.orcheSteps(calls) });
  open.push(h);
  expect(h.agentDir.startsWith(tmpdir())).toBe(true); // never the user's ~/.pi/agent
  if (path.git) execFileSync("git", ["init", "-q"], { cwd: h.cwd });
  return h;
}

describe.each(paths)("limits in orche.config.json reach the deadline of $name", path => {
  it("without a `limits` key the product defaults apply: 30 min base + 10 × 30 min = a 5h30m ceiling", async () => {
    const h = await harness(path);
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    const [result] = resultsOf(h, path.toolName);
    expect(result?.isError).toBeFalsy();
    expect(deadlines().length).toBeGreaterThan(0);
    for (const deadline of deadlines()) expect(settingsOf(deadline)).toEqual(expected(BASE, DEFAULT_EXT, 10));
    expect(settingsOf(deadlines()[0]!).hardLimitMs).toBe(5.5 * 60 * MINUTE);
    expect(defaultRunLimits.maxExtensions).toBe(10);
  });

  it('user-level <agentDir>/orche.config.json {"limits":{"maxExtensions":5,"extensionMs":600000}} is what the deadline is built with', async () => {
    const h = await harness(path);
    await writeUser(h, { maxExtensions: 5, extensionMs: 600_000 });
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    expect(resultsOf(h, path.toolName)[0]?.isError).toBeFalsy();
    expect(deadlines().length).toBeGreaterThan(0);
    // 30 min + 5 × 10 min = 80 min; the base cap is untouched and the other keys keep their defaults.
    for (const deadline of deadlines()) {
      expect(settingsOf(deadline)).toEqual(expected(BASE, 600_000, 5));
      expect(deadline.activityWindowMs).toBe(defaultRunLimits.activityWindowMs);
    }
    expect(settingsOf(deadlines()[0]!).hardLimitMs).toBe(80 * MINUTE);
  });

  it.each([
    ["only maxExtensions", { maxExtensions: 5 }, expected(BASE, DEFAULT_EXT, 5)],
    ["only extensionMs", { extensionMs: 600_000 }, expected(BASE, 600_000, 10)],
    ["maxExtensions 0 turns extension off: the ceiling is the base", { maxExtensions: 0, extensionMs: 600_000 }, expected(BASE, 600_000, 0)],
    ["a smaller base cap lowers the ceiling by the same formula (overallMs + maxExtensions × extensionMs)", { overallMs: 15 * MINUTE, maxExtensions: 5, extensionMs: 600_000 }, expected(15 * MINUTE, 600_000, 5)],
  ])("%s", async (_name, limits, want) => {
    const h = await harness(path);
    await writeUser(h, limits);
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    expect(resultsOf(h, path.toolName)[0]?.isError).toBeFalsy();
    expect(deadlines().length).toBeGreaterThan(0);
    for (const deadline of deadlines()) expect(settingsOf(deadline)).toEqual(want);
  });

  it("a trusted project file .pi/orche.config.json wins over the user file (the selected file is used as a whole, keys are not merged)", async () => {
    const h = await harness(path, { calls: 2 });
    await writeUser(h, { maxExtensions: 5, extensionMs: 600_000 });
    await writeProject(h, { maxExtensions: 2, extensionMs: 120_000 });
    expect(h.session.settingsManager.isProjectTrusted()).toBe(true);
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    expect(resultsOf(h, path.toolName)[0]?.isError).toBeFalsy();
    expect(deadlines().length).toBeGreaterThan(0);
    for (const deadline of deadlines()) expect(settingsOf(deadline)).toEqual(expected(BASE, 120_000, 2));
    expect(settingsOf(deadlines()[0]!).hardLimitMs).toBe(34 * MINUTE);
    // A project file without `limits` still replaces the user file: the defaults apply, not the user's 5 × 10 min.
    await writeProject(h);
    const seen = deadlines().length;
    await h.session.prompt("delegate again");
    expect(resultsOf(h, path.toolName)[1]?.isError).toBeFalsy();
    expect(deadlines().length).toBeGreaterThan(seen);
    for (const deadline of deadlines().slice(seen)) expect(settingsOf(deadline)).toEqual(expected(BASE, DEFAULT_EXT, 10));
  });

  it("an untrusted project file is ignored: the user file's limits apply", async () => {
    const h = await harness(path);
    await writeUser(h, { maxExtensions: 5, extensionMs: 600_000 });
    await writeProject(h, { maxExtensions: 2, extensionMs: 120_000 });
    h.session.settingsManager.setProjectTrusted(false);
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    expect(resultsOf(h, path.toolName)[0]?.isError).toBeFalsy();
    expect(deadlines().length).toBeGreaterThan(0);
    for (const deadline of deadlines()) expect(settingsOf(deadline)).toEqual(expected(BASE, 600_000, 5));
  });

  it("an edited config applies to the next call of the same session, without reloading the extension", async () => {
    const h = await harness(path, { calls: 2 });
    await writeUser(h, { maxExtensions: 5, extensionMs: 600_000 });
    const deadlines = recordDeadlines();
    await h.session.prompt("first");
    const first = deadlines().length;
    expect(first).toBeGreaterThan(0);
    for (const deadline of deadlines()) expect(settingsOf(deadline)).toEqual(expected(BASE, 600_000, 5));
    await writeUser(h, { maxExtensions: 7, extensionMs: 300_000 });
    await h.session.prompt("second");
    expect(resultsOf(h, path.toolName)).toHaveLength(2);
    expect(deadlines().length).toBeGreaterThan(first);
    for (const deadline of deadlines().slice(first)) expect(settingsOf(deadline)).toEqual(expected(BASE, 300_000, 7));
  });

  it.each([
    [{ maxExtensions: 1.5 }, "config.limits.maxExtensions: expected a non-negative integer (0 disables extensions)"],
    [{ maxExtensions: -1 }, "config.limits.maxExtensions: expected a finite non-negative number"],
    [{ maxExtensions: "5" }, "config.limits.maxExtensions: expected a finite non-negative number"],
    [{ extensionMs: -1 }, "config.limits.extensionMs: expected a finite non-negative number"],
    [{ extensionMs: null }, "config.limits.extensionMs: expected a finite non-negative number"],
    [{ maxExtension: 5 }, "config.limits.maxExtension: unknown limit"],
  ])("an invalid value %j is the clear config error, and nothing starts", async (limits, message) => {
    const h = await harness(path);
    await writeUser(h, limits);
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    const [result] = resultsOf(h, path.toolName);
    expect(result?.isError).toBe(true);
    expect(textOf(result!)).toContain(message);
    expect(deadlines()).toEqual([]); // no run, no assignment: the error is raised before any deadline exists
    expect(h.orche.faux.state.callCount).toBe(0);
  });

  it("an invalid value in the trusted project file is the same error even when the user file is fine", async () => {
    const h = await harness(path);
    await writeUser(h, { maxExtensions: 5 });
    await writeProject(h, { maxExtensions: 1.5 });
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    const [result] = resultsOf(h, path.toolName);
    expect(result?.isError).toBe(true);
    expect(textOf(result!)).toContain("config.limits.maxExtensions: expected a non-negative integer");
    expect(deadlines()).toEqual([]);
  });
});

describe("the configured extension budget is what a run/assignment really gets (short caps, real timers)", () => {
  const blockedUntilAbort = (entered?: { resolve(): void }): FauxResponseStep => async (_context, options) => {
    entered?.resolve();
    await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
    return reply("aborted");
  };

  it("orche_run: a coordinator that is busy at every deadline gets base + maxExtensions × extensionMs from the config file, then the timeout says the budget is used up", async () => {
    const h = await harness(paths[0]!, { mainSteps: [tool("orche_run", { request: "long job" }), reply("noted")], orcheSteps: [hold()] });
    // The phase caps are set high so that only the overall deadline (800 ms + 2 × 250 ms) is in play.
    await writeUser(h, { overallMs: 800, extensionMs: 250, maxExtensions: 2, decisionMs: 100_000, assignmentMs: 100_000, explorationMs: 100_000 });
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    expect(deadlines().map(settingsOf)).toEqual([expected(800, 250, 2)]);
    const [result] = resultsOf(h, "orche_run");
    expect(result?.isError).toBe(true);
    expect(textOf(result!)).toContain("overall timeout at Coordinator decision");
    expect(textOf(result!)).toContain("extension budget 2/2 used");
    const details = result!.details!;
    expect(details.extensions.map((extension: { n: number; max: number; extensionMs: number }) => [extension.n, extension.max, extension.extensionMs])).toEqual([[1, 2, 250], [2, 2, 250]]);
    expect(details.progress.join("\n")).toContain("timeout extended 2/2");
    expect(details.timeouts).toHaveLength(1);
    expect(details.timeouts[0]).toMatchObject({ scope: "overall", extensions: { used: 2, max: 2, extensionMs: 250, notExtended: { reason: "budget" } } });
    expect(details.timeouts[0].effectiveCapMs).toBeGreaterThanOrEqual(1290);
    expect(details.timeouts[0].effectiveCapMs).toBeLessThan(1500);
    expect(details.durationMs).toBeGreaterThanOrEqual(1290);
  });

  it("orche_task: a worker that is busy at every deadline gets assignmentMs + maxExtensions × extensionMs from the config file, then the timeout says the budget is used up", async () => {
    const h = await harness(paths[1]!, { mainSteps: [tool("orche_task", { role: "explore", request: "long task" }), reply("noted")], orcheSteps: [blockedUntilAbort()] });
    await writeUser(h, { assignmentMs: 300, extensionMs: 200, maxExtensions: 2 });
    const deadlines = recordDeadlines();
    await h.session.prompt("delegate");
    expect(deadlines().map(settingsOf)).toEqual([expected(300, 200, 2)]);
    const [result] = resultsOf(h, "orche_task");
    expect(result?.isError).toBe(true);
    expect(textOf(result!)).toContain("Worker W1 timed out after 700ms (extension budget 2/2 used)"); // 300 base + 2 × 200
    const details = result!.details!;
    expect(details.extensions.map((extension: { n: number; max: number; extensionMs: number; scope: string }) => [extension.n, extension.max, extension.extensionMs, extension.scope])).toEqual([[1, 2, 200, "assignment"], [2, 2, 200, "assignment"]]);
    expect(details).toMatchObject({ worker: "W1", status: "timeout", notExtended: { reason: "budget", message: "extension budget 2/2 used" } });
  });

  it("with `maxExtensions: 0` in the config nothing is extended: the plain timeout at the base cap, for both tools", async () => {
    const hRun = await harness(paths[0]!, { mainSteps: [tool("orche_run", { request: "long job" }), reply("noted")], orcheSteps: [hold()] });
    await writeUser(hRun, { overallMs: 300, extensionMs: 250, maxExtensions: 0, decisionMs: 100_000, assignmentMs: 100_000, explorationMs: 100_000 });
    const runDeadlines = recordDeadlines();
    await hRun.session.prompt("delegate");
    expect(runDeadlines().map(settingsOf)).toEqual([expected(300, 250, 0)]);
    const runResult = resultsOf(hRun, "orche_run")[0]!;
    expect(runResult.isError).toBe(true);
    expect(textOf(runResult)).toContain("overall timeout at Coordinator decision");
    expect(runResult.details).not.toHaveProperty("extensions");
    vi.restoreAllMocks();

    const hTask = await harness(paths[1]!, { mainSteps: [tool("orche_task", { role: "explore", request: "long task" }), reply("noted")], orcheSteps: [blockedUntilAbort()] });
    await writeUser(hTask, { assignmentMs: 200, extensionMs: 250, maxExtensions: 0 });
    const taskDeadlines = recordDeadlines();
    await hTask.session.prompt("delegate");
    expect(taskDeadlines().map(settingsOf)).toEqual([expected(200, 250, 0)]);
    const taskResult = resultsOf(hTask, "orche_task")[0]!;
    expect(taskResult.isError).toBe(true);
    expect(textOf(taskResult)).toContain("Worker W1 timed out after 200ms");
    expect(textOf(taskResult)).not.toContain("extension budget");
    expect(taskResult.details).not.toHaveProperty("extensions");
  });
});
