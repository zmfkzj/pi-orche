import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { fauxAssistantMessage as reply, fauxToolCall as call, type ToolCall } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import type { RunContext } from "../../src/orchestration/run/types.js";
import { workerAssignment } from "../../src/orchestration/run/context.js";
import { answerPrompt, explorationPrompt, implementationPrompt, proposalPrompt, verificationPrompt, taskWorkerInstructions } from "../../src/orchestration/prompts.js";
import { fauxRuntime } from "../helpers/faux.js";

const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (args: ToolCall["arguments"]) => tool("coordinator_decision", { decision: args });
afterEach(() => vi.restoreAllMocks());

describe("cacheable worker prefixes and first-assignment briefing", () => {
  it("uses identical instructions and tool order across implementers and runs, briefing each worker only once", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    for (const [language, problem] of [["en", "Change independent modules"], ["ko", "독립 모듈을 수정하세요"]] as const) {
      const tasks = [
        { id: "one", owner: "A1", description: "First unit", files: ["one.js"], dependsOn: [], status: "pending" },
        { id: "two", owner: "A2", description: "Second unit", files: ["two.js"], dependsOn: [], status: "pending" },
        { id: "three", owner: "A1", description: "Follow-up", files: ["three.js"], dependsOn: ["one", "two"], status: "pending" },
      ];
      const events: RunEvent[] = [];
      const f = await fauxRuntime([
        decision({ type: "classify", taskClass: "change", workerCount: 2, language, reason: "Independent units" }),
        decision({ type: "assign", tasks }),
        ...tasks.map(() => tool("report_result", { kind: "implement", summary: "Done", data: { status: "done" } })),
        tool("report_result", { kind: "verify", summary: "Verified", data: { passed: true } }),
        decision({ type: "complete", summary: "Done" }),
      ]);
      const report = await runOrchestrated({ problem: problem!, cwd: tmpdir(), workspaceAudit: false, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
      expect(report.status).toBe("done");
      const assignments = events.filter(event => event.type === "assignment_started");
      for (const id of ["A1", "A2", "V1"]) {
        const prompts = assignments.filter(event => event.agentId === id).map(event => event.assignment.prompt);
        expect(prompts[0]?.startsWith(`Your id is ${id}. Reply in the user's language (${language}).`)).toBe(true);
        expect(prompts[0]?.split(problem!).length).toBe(2);
        expect(prompts[0]?.match(/Your id is/g)).toHaveLength(1);
        expect(prompts[0]?.match(/Reply in the user's language/g)).toHaveLength(1);
        for (const later of prompts.slice(1)) {
          expect(later).not.toContain("Your id is");
          expect(later).not.toContain("User request:");
          expect(later).not.toContain("Reply in the user's language");
        }
      }
      expect(assignments.filter(event => event.agentId === "A1")).toHaveLength(2);
    }
    const implementers = spawned.mock.calls.map(([options]) => options).filter(options => options.role === "implementer");
    expect(implementers).toHaveLength(4);
    for (const options of implementers) {
      expect(options.instructions).toBe(implementers[0]!.instructions);
      expect(options.tools).toEqual(implementers[0]!.tools);
      expect(options.instructions).toContain("Your id, user request and reply language arrive in the first assignment.");
      expect(options.instructions).not.toContain("Your id is");
    }
    const verifiers = spawned.mock.calls.map(([options]) => options).filter(options => options.role === "verifier");
    expect(verifiers[0]!.instructions).toBe(verifiers[1]!.instructions);
  });

  it("adds the request only to first assignments that do not already contain it", () => {
    const ctx = { options: { problem: "Investigate widget" }, state: { language: "en" } } as RunContext;
    for (const [id, prompt, included] of [
      ["W1", explorationPrompt("Investigate widget", "trace", []), true],
      ["W2", answerPrompt("Investigate widget", "review", []), true],
      ["W3", verificationPrompt("Investigate widget", []), true],
      ["W4", proposalPrompt("cause", []), false],
    ] as const) {
      const first = workerAssignment(ctx, id, prompt, included);
      expect(first.split("Investigate widget")).toHaveLength(2);
      expect(first).toContain(`Your id is ${id}. Reply in the user's language (en).`);
      expect(workerAssignment(ctx, id, "Assignment: fix.")).toBe("Assignment: fix.");
    }
    expect(taskWorkerInstructions).not.toContain("first assignment");
  });

  it("briefs every answer analyst once with the Korean rule, outside byte-stable system instructions", async () => {
    const spawned = vi.spyOn(AgentManager.prototype, "spawn");
    const rule = "Korean requests require Korean answers";
    for (const [language, problem] of [["en", "Review the widget"], ["ko", "위젯을 검토하세요"]] as const) {
      const events: RunEvent[] = [];
      const f = await fauxRuntime([
        decision({ type: "classify", taskClass: "answer", workerCount: 2, language, reason: "Review" }),
        tool("report_result", { kind: "answer", summary: "Evidence one", data: { evidence: [] } }),
        tool("report_result", { kind: "answer", summary: "Evidence two", data: { evidence: [] } }),
        decision({ type: "answer", answer: "Approved answer", summary: "Done" }),
      ]);
      const report = await runOrchestrated({ problem, cwd: tmpdir(), workspaceAudit: false, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
      expect(report.status).toBe("done");
      const assignments = events.filter(event => event.type === "assignment_started");
      expect(assignments).toHaveLength(2);
      for (const event of assignments) expect(event.assignment.prompt.split(rule)).toHaveLength(2);
    }
    const analysts = spawned.mock.calls.map(([options]) => options).filter(options => options.role === "analyst");
    expect(analysts).toHaveLength(4);
    for (const analyst of analysts) {
      expect(analyst.instructions).toBe(analysts[0]!.instructions);
      expect(analyst.instructions).not.toContain(rule);
    }
  });


  it("requires conclusion-first reference evidence without shortening full answers", () => {
    const task = { id: "unit", description: "Change widget", owner: "W1", files: ["widget.ts"], status: "pending" as const };
    for (const prompt of [explorationPrompt("p", "a", []), proposalPrompt("c", []), implementationPrompt(task, [task], false), implementationPrompt(task, [task], true), verificationPrompt("p", [task]), answerPrompt("p", "a", [])]) {
      expect(prompt).toContain("Start summary with the conclusion (1–3 sentences)");
      expect(prompt).toContain("path:line references and command outcomes");
      expect(prompt).toContain("Do not paste code, diffs or logs");
    }
    expect(answerPrompt("p", "a", [])).toContain("summary:FULL_EVIDENCED_ANSWER");
  });
});
