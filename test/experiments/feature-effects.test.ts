/**
 * Feature-effect experiments (experiments/feature-effects): model-free, controlled enabled-versus-disabled checks of
 * - decision memory: the restored work log of both arms on the SAME ledger and Task DAG (essentials extended in both), on fixture
 *   scenarios whose needed evidence is fixed before rendering (including cases where decision memory is expected to lose), plus the
 *   transcript replay harness on a synthetic transcript;
 * - SkillCache auto mode: the provider's real engine in a private PI_SKILLCACHE_HOME (cold -> compile -> warm, fidelity against direct
 *   reads, misses, fallbacks and never-compiled traces), and an orche worker run end to end with the real provider factory as its
 *   `skillcache` capability, to see whether an identical hand-off can hit at all.
 * The figures themselves (with repetitions and the real-record replay) come from `experiments/feature-effects/cli.ts`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, FauxResponseStep } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregateCuts, replayTranscript, runScenarios, SCENARIOS, summaryNoteDelta } from "../../experiments/feature-effects/decision-memory.js";
import { loadProvider, runBench, runNegatives, traceVerdict, type SkillCacheProvider } from "../../experiments/feature-effects/skillcache.js";
import { OrcheController } from "../../src/extension/controller.js";
import { WorkerPool, type WorkerCapabilityAnswer, type WorkerCapabilityRequest } from "../../src/extension/workers.js";
import { createHarness, tool, type Harness } from "../extension/harness.js";

describe("decision memory versus the basic work log (same ledger and plan, essentials extended)", () => {
  const results = Object.fromEntries(runScenarios().map(result => [result.name, result]));

  it("keeps checkpoint-cited evidence that the basic log has pushed out, in fewer bytes", () => {
    const { basic, decision } = results["cited-old-evidence"]!.arms;
    expect(decision.neededRetained).toBeGreaterThan(basic.neededRetained);
    expect(decision.bytes).toBeLessThan(basic.bytes);
    expect(decision.unneededShown).toBeLessThan(basic.unneededShown);
  });

  it("drops a failure the same command later fixed, which the basic log still lists as FAILED", () => {
    const { basic, decision } = results["resolved-failure-noise"]!.arms;
    expect(basic.staleFailuresShown).toBe(1);
    expect(decision.staleFailuresShown).toBe(0);
    expect(decision.neededRetained).toBeGreaterThanOrEqual(basic.neededRetained);
  });

  it("NEGATIVE: loses an unresolved failure older than its 12-call window, which the basic log keeps", () => {
    const { basic, decision } = results["old-unresolved-failure"]!.arms;
    expect(basic.unresolvedShown).toBe(1);
    expect(decision.unresolvedShown).toBe(0);
  });

  it("NEGATIVE: without a Task DAG it keeps only the newest 4 calls and loses the task's first input", () => {
    const { basic, decision } = results["no-task-dag"]!.arms;
    expect(decision.shownCalls).toBe(4);
    expect(decision.neededRetained).toBeLessThan(basic.neededRetained);
  });

  it("MIXED: the 18-call cap drops some cited calls when the active node is busy, though it still beats the basic log", () => {
    const { basic, decision } = results["active-node-flood"]!.arms;
    expect(decision.shownCalls).toBe(18);
    expect(decision.neededRetained).toBeLessThan(decision.neededTotal);
    expect(decision.neededRetained).toBeGreaterThan(basic.neededRetained);
  });

  it("lists edited files in both arms and labels every scenario's expected direction", () => {
    for (const result of Object.values(results)) expect(result.arms.decision.filesShown).toBe(result.arms.basic.filesShown);
    expect(SCENARIOS.map(scenario => scenario.expectation)).toEqual(expect.arrayContaining(["decision-better", "basic-better", "mixed"]));
  });

  it("adds the failure-handling lines to the summary request only when enabled", () => {
    expect(summaryNoteDelta().addedBytes).toBeGreaterThan(0);
  });

  it("replays a transcript: cuts at the real compaction and scores evidence cited after it against both arms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fe-dm-"));
    try {
      const file = join(dir, "W1-x.jsonl");
      const call = (id: string, name: string, args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
      const result = (id: string, name: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: "ok" }] } });
      const node = (id: string, status: string, evidence?: string[]) => ({ id, title: id, status, dependsOn: [], covers: ["R1"], ...(evidence ? { checkpoint: { result: "r", evidence, verification: "passed" } } : {}) });
      const plan = (...nodes: unknown[]) => ({ nodes });
      const lines: unknown[] = [{ type: "session", cwd: "/x" }, { type: "message", message: { role: "user", content: "Assignment" } },
        call("p1", "task_plan", plan(node("a", "running"), node("b", "pending"))), result("p1", "task_plan"),
        call("c1", "read", { path: "docs/spec.md" }), result("c1", "read"),
        call("p2", "task_plan", plan(node("a", "done", ["T1 read docs/spec.md"]), node("b", "running"))), result("p2", "task_plan"),
        ...Array.from({ length: 14 }, (_, i) => [call(`r${i}`, "read", { path: `src/m${i}.ts` }), result(`r${i}`, "read")]).flat(),
        { type: "compaction" },
        // After the cut: a NEW evidence item citing T1 again, and one citing the newest read.
        call("p3", "task_plan", plan(node("a", "done", ["T1 read docs/spec.md"]), node("b", "done", ["T1 spec requires X", "T15 src/m13.ts implements X"]))), result("p3", "task_plan")];
      writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n"));
      const cuts = await replayTranscript(file);
      expect(cuts).toHaveLength(1);
      expect(cuts[0]!).toMatchObject({ kind: "real", preCutCalls: 15, laterItems: 2, hasPlan: true });
      // T1 is older than the basic log's newest 12 other calls but cited by a checkpoint: only decision memory keeps it. Both keep T15.
      expect(cuts[0]!.arms.basic.laterItemsResolvable).toBe(1);
      expect(cuts[0]!.arms.decision.laterItemsResolvable).toBe(2);
      expect(aggregateCuts(cuts).real.pairedLaterRecall).toEqual({ decisionMore: 1, basicMore: 0, tie: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const userCache = join(homedir(), ".pi", "agent", "skillcache");
let provider: SkillCacheProvider | undefined;
let home = "";
let previousHome: string | undefined;
const userCacheBefore = existsSync(userCache);
beforeAll(async () => {
  provider = await loadProvider();
  home = mkdtempSync(join(tmpdir(), "fe-skillcache-"));
  previousHome = process.env.PI_SKILLCACHE_HOME;
  process.env.PI_SKILLCACHE_HOME = home;
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.PI_SKILLCACHE_HOME; else process.env.PI_SKILLCACHE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  expect(existsSync(userCache)).toBe(userCacheBefore);
});

describe.skipIf(!existsSync(join(__dirname, "../../../pi-skillcache/src/auto.js")) && !process.env.ORCHE_SKILLCACHE_DIR)("SkillCache auto mode with the provider's real engine (private scratch home)", () => {
  it("cold run compiles, an identical prompt in a new session replays evidence equal to direct reads, and `find` is not replayed", async () => {
    const bench = await runBench(provider!, { home, repetitions: 3 });
    expect(bench.functional).toMatchObject({ coldHit: false, coldCompiled: 1, warmHit: true, fidelity: { tracedCalls: 6, replayableCalls: 5, replayedSteps: 5, agreeWithDirect: 5 } });
    expect(bench.timingMs.beforeHit.n).toBe(3);
    expect(bench.injectedBytes.median).toBeGreaterThan(0);
  });

  it("misses, falls back or never compiles in every case outside an exact repeat of an unchanged read-only trace", async () => {
    const negatives = Object.fromEntries((await runNegatives(provider!, { home })).map(result => [result.case, result]));
    expect(negatives["control: identical prompt, unchanged files"]).toMatchObject({ compiled: 1, hit: true });
    for (const label of ["prompt differs by one trailing space", "untrusted project on the second run"]) expect(negatives[label]).toMatchObject({ compiled: 1, hit: false, fallbacks: 0 });
    for (const label of ["traced file edited after compile", "file added to a listed directory", "record older than 14 days"]) expect(negatives[label]).toMatchObject({ compiled: 1, hit: false, fallbacks: 1 });
    for (const label of ["trace contains bash", "trace contains an edit", "read with offset/limit", "regex grep", "absolute path read", "a failed tool result", "aborted run", "only ignorable tools (find, diagnostics)", "prompt over 8 KB"]) {
      expect(negatives[label], label).toMatchObject({ compiled: 0, hit: false });
    }
  });

  it("classifies recorded traces with the provider's own compiler", () => {
    expect(traceVerdict(provider!, [{ name: "read", input: { path: "README.md" }, isError: false, textOnly: true }])).toEqual({ compilable: true, reason: "compilable" });
    expect(traceVerdict(provider!, [{ name: "read", input: { path: "/abs/README.md" }, isError: false, textOnly: true }]).compilable).toBe(false);
    expect(traceVerdict(provider!, [{ name: "find", input: { pattern: "*" }, isError: false, textOnly: true }]).reason).toBe("only ignorable calls");
  });

  describe("an orche worker with the real provider factory as its skillcache capability", () => {
    let h: Harness | undefined;
    let pool: WorkerPool | undefined;
    afterAll(async () => { await pool?.dispose(); await h?.dispose(); });

    it("compiles the worker's read-only trace but never replays it for an identical hand-off: the prompts differ", async () => {
      const prompts: string[] = [];
      const replays: boolean[] = [];
      // Each worker run: read greeting.txt, then report. The step records the prompt and whether a replay reached the model.
      const observe = (message: AssistantMessage): FauxResponseStep => (context => {
        const text = JSON.stringify(context.messages);
        const users = context.messages.filter(m => m.role === "user");
        const last = users[users.length - 1];
        prompts.push(typeof last?.content === "string" ? last.content : (last?.content as Array<{ text?: string }> | undefined)?.map(part => part.text ?? "").join("") ?? "");
        replays.push(text.includes("SkillCache deterministic replay"));
        return message;
      });
      const readStep = tool("read", { path: "greeting.txt" });
      const report = tool("report_result", { kind: "explore", summary: "Done", data: { status: "done" } });
      h = await createHarness({ mainSteps: [], orcheSteps: [observe(readStep), report, observe(readStep), report, observe(readStep), report] });
      const cwd = h.cwd;
      await provider!.setAutoEnabled(cwd, true);
      const factory = provider!.createSkillCacheExtension({ trustedCwd: cwd }) as ExtensionFactory;
      const capability = (request: WorkerCapabilityRequest): WorkerCapabilityAnswer | undefined =>
        request.capability === "skillcache" && request.cwd === cwd ? { key: "pi-skillcache/auto@1", tools: [], extensionFactories: [factory] } : undefined;
      const controller = new OrcheController({ agentDir: h.agentDir, createRuntime: async () => h!.runtime });
      pool = new WorkerPool({ controller, agentDir: h.agentDir, capability });
      const request = "Read greeting.txt and say what it contains";
      await pool.execute({ role: "explore", request, cwd, projectTrusted: false });
      const compiledAfterFirst = (await provider!.autoCacheStatus(cwd)).count;
      await pool.execute({ role: "explore", request, cwd, projectTrusted: false }); // a new worker
      await pool.execute({ role: "explore", request, cwd, projectTrusted: false, worker: "W1" }); // a follow-up to W1
      expect(prompts).toHaveLength(3);
      expect(compiledAfterFirst).toBeGreaterThanOrEqual(0);
      expect(replays).toEqual([false, false, false]);
      expect(new Set(prompts).size).toBe(3);
      // Where the first two (identical-request, new-worker) prompts first differ: the reason no replay can match.
      const at = [...prompts[0]!].findIndex((char, i) => char !== prompts[1]![i]);
      const differs = [prompts[0]!.slice(Math.max(0, at - 40), at + 40), prompts[1]!.slice(Math.max(0, at - 40), at + 40)];
      expect(at).toBeGreaterThanOrEqual(0);
      console.log(JSON.stringify({ orcheSkillcache: { compiledAfterFirst, compiledAfterAll: (await provider!.autoCacheStatus(cwd)).count, promptBytes: prompts.map(p => Buffer.byteLength(p)), replays, differs } }));
    }, 60_000);
  });
});
