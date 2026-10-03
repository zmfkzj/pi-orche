import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { runOrchestrated, type RunOptions } from "../../src/orchestration/coordinator.js";
import { fauxRuntime } from "../helpers/faux.js";

const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const classify = tool("coordinator_decision", { decision: { type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small edit" } });
const implemented = tool("report_result", { kind: "implement", summary: "PRIVATE_IMPLEMENTER_CONTEXT", data: { status: "done" } });
const verification = (passed: boolean) => tool("report_result", { kind: "verify", summary: passed ? "tests pass" : "test fails", data: { passed, issues: passed ? [] : ["boundary missing"] } });
afterEach(() => vi.restoreAllMocks());

async function run(steps: FauxResponseStep[], extra: Partial<RunOptions> = {}) {
  const f = await fauxRuntime(steps);
  return runOrchestrated({ problem: "edit", cwd: tmpdir(), workspaceAudit: false, modelRuntime: f.runtime,
    routes: { routes: {}, default: f.route }, limits: { overallMs: 5000, decisionMs: 1000, assignmentMs: 1000, maxFixRounds: 0 }, ...extra });
}

describe("opt-in failed-run worker handover", () => {
  it("transfers live workers without disposing them; target-manager RESULT and NOTE tools retain context", async () => {
    const pool = new AgentManager();
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const sessions: AgentSession[] = [];
    let context = "";
    const report = await run([classify, implemented, verification(false),
      ctx => { context = JSON.stringify(ctx); return tool("send_message", { to: "main", content: "recovering" }); },
      tool("report_result", { kind: "implement", summary: "recovered" })], {
      onFailedHandover: ({ manager, workers, issues }) => {
        expect(issues.join(" ")).toContain("boundary missing");
        return workers.map(worker => {
          sessions.push(manager.session(worker.id));
          const id = `run-${worker.id}`;
          pool.adopt(manager.detach(worker.id), { id, role: worker.role === "verifier" ? "verify" : "implement" });
          return { ...worker, sourceId: worker.id, id };
        });
      },
    });
    try {
      expect(report.status).toBe("failed");
      expect(report.handover?.workers.map(w => w.id)).toEqual(["run-A1", "run-V1"]);
      expect(report.handover?.workers[0]?.lastTask).toMatchObject({ id: "T1", owner: "A1" });
      expect(dispose).toHaveBeenCalledTimes(1); // coordinator only
      expect(pool.session("run-A1")).toBe(sessions[0]);
      pool.assign("run-A1", "implement", "Fix the boundary");
      const note = await pool.wait("any", 1000);
      expect(note).toMatchObject({ type: "message", message: { from: "run-A1", content: "recovering" } });
      const result = await pool.wait("any", 1000);
      expect(result).toMatchObject({ type: "outcome", outcome: { agentId: "run-A1", status: "completed", result: { summary: "recovered" } } });
      expect(context).toContain("PRIVATE_IMPLEMENTER_CONTEXT");
    } finally { await pool.dispose(); }
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("does not call the hook on success", async () => {
    const hook = vi.fn(() => []);
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    expect((await run([classify, implemented, verification(true)], { onFailedHandover: hook })).status).toBe("done");
    expect(hook).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("does not call the hook when the user aborts during implementation", async () => {
    const hook = vi.fn(() => []);
    const controller = new AbortController();
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const report = await run([classify, () => { controller.abort(); return implemented; }], { signal: controller.signal, onFailedHandover: hook });
    expect(report.summary).toBe("cancelled");
    expect(hook).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("direct SDK failures dispose every session without opt-in", async () => {
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const report = await run([classify, implemented, verification(false)]);
    expect(report.status).toBe("failed");
    expect(report.handover).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("unaccepted workers are disposed as before", async () => {
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const report = await run([classify, implemented, verification(false)], { onFailedHandover: () => [] });
    expect(report.handover?.workers).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
