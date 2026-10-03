import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
/** Not a git work tree: these runs must not snapshot or write refs into the developer's repository. */
const outsideGit = tmpdir();

afterEach(() => vi.restoreAllMocks());
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "Set value to one", owner: "A1", files: ["core.mjs"], status: "pending" };

describe("proportional request classification with real Pi sessions", () => {
  for (const language of ["en", "ko"]) {
    it(`answers read-only explanation in ${language} without implementation or verification`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "orche-answer-"));
      const source = "export const value = 7;\n";
      await writeFile(join(dir, "core.mjs"), source);
      const answer = language === "ko" ? "core.mjs의 value는 상수 7입니다. 파일을 수정하지 않았습니다." : "core.mjs exports the constant value 7. No files were modified.";
      const problem = language === "ko" ? "이 코드가 무엇을 하는지 설명하세요. 파일은 수정하지 마세요." : "Explain this code; do not modify any files.";
      const events: RunEvent[] = [];
      const dispose = vi.spyOn(AgentSession.prototype, "dispose");
      const spawned = vi.spyOn(AgentManager.prototype, "spawn");
      let activeTools: string[] = [];
      const disposeWithin = AgentManager.prototype.disposeWithin;
      vi.spyOn(AgentManager.prototype, "disposeWithin").mockImplementation(function (this: AgentManager, timeoutMs) {
        activeTools = this.session("A1").getActiveToolNames();
        return disposeWithin.call(this, timeoutMs);
      });
      let evidenceContext = "";
      let decisionContext = "";
      const f = await fauxRuntime([
        decision({ type: "classify", taskClass: "answer", workerCount: 1, language, reason: "Explicitly read-only explanation" }),
        tool("read", { path: "core.mjs" }),
        context => {
          evidenceContext = JSON.stringify(context);
          return tool("report_result", { kind: "answer", summary: answer, data: { evidence: ["core.mjs exports value 7"] } });
        },
        context => {
          decisionContext = JSON.stringify(context.messages.findLast(message => message.role === "user"));
          return decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: language === "ko" ? "코드 설명 완료" : "Explanation complete" });
        },
      ]);
      try {
        const report = await runOrchestrated({ problem, cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
        expect(report).toMatchObject({ status: "done", taskClass: "answer", answer, tasks: [] });
        expect(evidenceContext).toContain("export const value = 7");
        expect(decisionContext).toContain("core.mjs exports value 7");
        if (language === "ko") expect(decisionContext).toContain("Korean requests require Korean answers");
        expect(events.filter(event => event.type === "assignment_started").map(event => event.assignment.kind)).toEqual(["answer"]);
        expect(events.some(event => event.type === "verification" || event.type === "backlog_created" || event.type === "ownership_violation")).toBe(false);
        expect(events.find(event => event.type === "request_classified")).toMatchObject({ taskClass: "answer", workerCount: 1, language });
        const manager = spawned.mock.contexts[0];
        if (!(manager instanceof AgentManager)) throw new Error("Worker manager not observed");
        expect(manager.get("A1").status).toBe("disposed");
        expect(activeTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "report_result"]));
        expect(activeTools).not.toEqual(expect.arrayContaining(["edit"]));
        expect(activeTools).not.toEqual(expect.arrayContaining(["write"]));
        expect(activeTools).not.toEqual(expect.arrayContaining(["bash"]));
        expect(await readdir(dir)).toEqual(["core.mjs"]);
        expect(await readFile(join(dir, "core.mjs"), "utf8")).toBe(source);
        expect(dispose).toHaveBeenCalledTimes(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  it("uses one implementer for a trivial change, skips diagnosis and verifies the actual change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-change-"));
    await writeFile(join(dir, "core.mjs"), "export const value = 0;\n");
    await writeFile(join(dir, "core.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './core.mjs';\ntest('requested constant', () => assert.equal(value, 1));\n");
    const events: RunEvent[] = [];
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    let verificationMessages: AgentSession["messages"] = [];
    const disposeWithin = AgentManager.prototype.disposeWithin;
    vi.spyOn(AgentManager.prototype, "disposeWithin").mockImplementation(function (this: AgentManager, timeoutMs) {
      verificationMessages = [...this.session("V1").messages];
      return disposeWithin.call(this, timeoutMs);
    });
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "One-line literal edit" }),
      tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
      tool("report_result", { kind: "implement", summary: "Changed the requested constant", data: { status: "done" } }),
      tool("bash", { command: "node --test", timeout: 10 }),
      tool("report_result", { kind: "verify", summary: "node --test passed", data: { passed: true } }),
    ]);
    try {
      const report = await runOrchestrated({ problem: "One-line change: set value to 1.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
      expect(report).toMatchObject({ status: "done", taskClass: "change", answer: "Changed the requested constant\n\nnode --test passed" });
      expect(spawned.mock.calls.map(([options]) => options.role)).toEqual(["implementer", "verifier"]);
      expect(events.filter(event => event.type === "assignment_started").map(event => event.assignment.kind)).toEqual(["implement", "verify"]);
      expect(events.some(event => event.type === "root_cause_claimed" || event.type === "root_cause_accepted" || event.type === "preempted")).toBe(false);
      expect(events.filter(event => event.type === "phase_changed").map(event => event.to)).toEqual(["EXPLORE", "BACKLOG", "EXECUTE", "VERIFY", "DONE"]);
      expect(await readFile(join(dir, "core.mjs"), "utf8")).toBe("export const value = 1;\n");
      const verified = spawnSync(process.execPath, ["--test"], { cwd: dir, timeout: 10000, encoding: "utf8" });
      expect(verified.status).toBe(0);
      const manager = spawned.mock.contexts[0];
      if (!(manager instanceof AgentManager)) throw new Error("Worker manager not observed");
      expect(manager.get("V1").status).toBe("disposed");
      expect(verificationMessages.some(message => message.role === "toolResult" && message.toolName === "bash" && !message.isError)).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("diagnoses an unexplained defect with one selected explorer, retaining the original convergence path", async () => {
    const events: RunEvent[] = [];
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "diagnose_fix", workerCount: 1, language: "en", reason: "Focused unexplained defect" }),
      tool("plan_exploration", { explorers: [{ role: "explorer-path", angle: "trace defect" }] }),
      tool("report_result", { kind: "explore", summary: "cause", data: { cause: "incorrect comparison", evidence: ["boundary reproduction"] } }),
      decision({ type: "root_cause_accepted", cause: "incorrect comparison", sourceAgentId: "A1", evidence: ["boundary reproduction"] }),
      tool("report_result", { kind: "backlog_proposal", summary: "proposal", data: { sourceAgentId: "A1", items: [{ title: "Fix comparison", description: "Correct comparison", files: ["core.mjs"] }] } }),
      decision({ type: "assign", tasks: [task] }),
      tool("report_result", { kind: "implement", summary: "implemented", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "verified", data: { passed: true } }),
      decision({ type: "complete", summary: "Defect fixed and verified." }),
    ]);
    const report = await runOrchestrated({ problem: "Investigate and fix an unexplained defect", cwd: outsideGit, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
    expect(report).toMatchObject({ status: "done", taskClass: "diagnose_fix", rootCause: "incorrect comparison" });
    expect(events.filter(event => event.type === "assignment_started").map(event => [event.agentId, event.assignment.kind])).toEqual([["A1", "explore"], ["A1", "backlog_proposal"], ["A1", "implement"], ["V1", "verify"]]);
    expect(events.some(event => event.type === "root_cause_accepted")).toBe(true);
  });
  for (const workerCount of [2, 3]) {
    it(`dispatches ${workerCount} independent implementers for a larger clear change`, async () => {
      const events: RunEvent[] = [];
      const tasks = Array.from({ length: workerCount }, (_, index) => ({
        id: `change-${index}`, description: `Independent requested change ${index}`,
        owner: `A${index + 1}`, files: [`part-${index}.js`], status: "pending",
      }));
      const f = await fauxRuntime([
        decision({ type: "classify", taskClass: "change", workerCount, language: "en", reason: "Independent substantial file areas" }),
        decision({ type: "assign", tasks }),
        ...tasks.map(() => tool("report_result", { kind: "implement", summary: "implemented", data: { status: "done" } })),
        tool("report_result", { kind: "verify", summary: "verified", data: { passed: true } }),
        decision({ type: "complete", summary: "Requested changes implemented and verified." }),
      ]);
      const report = await runOrchestrated({ problem: "Implement substantial independent requested changes", cwd: outsideGit, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
      expect(report.status).toBe("done");
      expect(events.filter(event => event.type === "task_dispatched").map(event => event.agentId)).toEqual(tasks.map(task => task.owner));
      const dispatches = events.flatMap((event, index) => event.type === "task_dispatched" ? [index] : []);
      const firstFinished = events.findIndex(event => event.type === "task_finished");
      expect(dispatches.every(index => index < firstFinished)).toBe(true);
      expect(events.some(event => event.type === "assignment_started" && ["explore", "backlog_proposal"].includes(event.assignment.kind))).toBe(false);
    });
  }
  it("lets a gated final coordinator approval exceed the old 90-second cap inside the overall budget", async () => {
    const entered = deferred();
    const release = deferred();
    const answer = "환불 설명: 코드 근거와 경계 조건을 포함한 전체 답변입니다.";
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "ko", reason: "읽기 전용 설명" }),
      tool("report_result", { kind: "answer", summary: answer, data: { evidence: ["src/refunds.js"] } }),
      async (_context, options) => {
        entered.resolve();
        await new Promise<void>(resolve => {
          void release.promise.then(() => resolve());
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "설명 완료" });
      },
    ]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const running = runOrchestrated({
      problem: "한국어로 설명하고 코드를 수정하지 마세요.", cwd: outsideGit,
      routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime,
      limits: { overallMs: 240000 },
    }).finally(() => { settled = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(90001);
      expect(settled).toBe(false);
      release.resolve();
      const report = await running;
      expect(report).toMatchObject({ status: "done", taskClass: "answer", answer });
      expect(report.finishedAt - report.startedAt).toBe(90001);
    } finally {
      release.resolve();
      await running;
      vi.useRealTimers();
    }
  });
  it("uses repo-wide ownership for all four writes of a one-worker tax refactor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-tax-ownership-"));
    const files = ["src/estimate.js", "src/invoice.js", "src/tax.js", "test/tax.test.js"];
    const events: RunEvent[] = [];
    const refactor = { id: "tax-consolidation", description: "Consolidate tax calculation and add regression coverage", owner: "A1", files: ["src/**", "test/**", "tests/**"], status: "pending" };
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "Focused shared-module refactor" }),
      ...files.map(path => tool("write", { path, content: "// tax refactor ownership fixture\n" })),
      tool("report_result", { kind: "implement", summary: "Consolidated tax module and callers", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "Verified", data: { passed: true } }),
    ]);
    try {
      const report = await runOrchestrated({ problem: "Consolidate duplicated tax calculation into one source module", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
      for (const path of files) expect(await readFile(join(dir, path), "utf8")).toBe("// tax refactor ownership fixture\n");
      expect(report.status).toBe("done");
      expect(report.tasks[0]?.files).toEqual(["/"]);
      expect(events.filter(event => event.type === "ownership_violation")).toEqual([]);
      expect(report.ownershipViolations).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("uses the configured team: more than three analysts, custom angles reused cyclically", async () => {
    const angles = ["ANGLE_ALPHA contracts", "ANGLE_BETA boundaries", "ANGLE_GAMMA findings"];
    const seen: string[] = [];
    const analyst: FauxResponseStep = context => {
      const text = JSON.stringify(context);
      const angle = angles.find(candidate => text.includes(candidate)) ?? "none";
      seen.push(angle);
      return tool("report_result", { kind: "answer", summary: `answer from ${angle}` });
    };
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "answer", workerCount: 4, language: "en", reason: "Four independent review areas" }),
      analyst, analyst, analyst, analyst,
      decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "done" }),
    ]);
    const events: RunEvent[] = [];
    const report = await runOrchestrated({
      problem: "Review this code; do not modify files.", cwd: outsideGit, modelRuntime: f.runtime, sink: event => events.push(event),
      routes: { routes: {}, default: { model: f.route.model }, workers: { maxWorkers: 4, answerAngles: angles } },
    });
    expect(report).toMatchObject({ status: "done", taskClass: "answer" });
    expect(events.find(event => event.type === "request_classified")).toMatchObject({ workerCount: 4 });
    expect(seen.sort()).toEqual([angles[0], angles[0], angles[1], angles[2]].sort());
  });
  it("rejects a workerCount above the configured maximum", async () => {
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "answer", workerCount: 3, language: "en", reason: "too many" }),
      decision({ type: "classify", taskClass: "answer", workerCount: 3, language: "en", reason: "too many" }),
      decision({ type: "classify", taskClass: "answer", workerCount: 3, language: "en", reason: "too many" }),
    ]);
    const report = await runOrchestrated({ problem: "Explain.", cwd: outsideGit, modelRuntime: f.runtime, routes: { routes: {}, default: { model: f.route.model }, workers: { maxWorkers: 2 } } });
    expect(report).toMatchObject({ status: "failed", summary: expect.stringContaining("bounded repairs") });
  });
});
