import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated, type RunOptions } from "../../src/orchestration/coordinator.js";
import { AgentManager } from "../../src/agent/agent-manager.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { fauxRuntime } from "../helpers/faux.js";

const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const classify = tool("coordinator_decision", { decision: { type: "classify", taskClass: "change", workerCount: 1, language: "ko", reason: "focused edit" } });
const implemented = (kind = "implement", summary = "상수를 수정했습니다.") => tool("report_result", { kind, summary, data: { status: "done" } });
const verified = (passed: boolean) => tool("report_result", { kind: "verify", summary: passed ? "검증 통과." : "Boundary test failed", data: { passed, evidence: "node --test: boundary", ...(!passed ? { issues: ["handle zero input"] } : {}) } });
afterEach(() => vi.restoreAllMocks());

async function run(implementation: FauxResponseStep[], verification: FauxResponseStep[], options: Partial<RunOptions> = {}) {
  const coordinator = await fauxRuntime([classify]);
  const worker = await fauxRuntime(implementation);
  const verifier = await fauxRuntime(verification);
  coordinator.runtime.registerNativeProvider(worker.faux.provider);
  coordinator.runtime.registerNativeProvider(verifier.faux.provider);
  const events: RunEvent[] = [];
  const report = await runOrchestrated({
    problem: "상수를 수정하세요.", cwd: tmpdir(), workspaceAudit: false,
    routes: { routes: { coordinator: coordinator.route, implementer: worker.route, verifier: verifier.route } },
    modelRuntime: coordinator.runtime, limits: { overallMs: 5000, assignmentMs: 1000, decisionMs: 1000 },
    sink: event => events.push(event), ...options,
  });
  return { report, events, coordinator, worker, verifier };
}

describe("deterministic one-worker change", () => {
  it("classifies once, dispatches repo-wide ownership and composes the final answer from implementation and V1 evidence", async () => {
    const r = await run([implemented()], [verified(true)]);
    expect(r.report.status).toBe("done");
    expect(r.coordinator.faux.state.callCount).toBe(1);
    expect(r.report.summary).toBe("상수를 수정했습니다.\n\n검증 통과.\n\nnode --test: boundary");
    expect(r.report.answer).toBe(r.report.summary);
    expect(r.report.tasks).toMatchObject([{ id: "T1", owner: "A1", files: ["/"], description: "상수를 수정하세요.", status: "done" }]);
    expect(r.events.filter(e => e.type === "phase_changed").map(e => e.to)).toEqual(["EXPLORE", "BACKLOG", "EXECUTE", "VERIFY", "DONE"]);
    for (const type of ["backlog_created", "task_dispatched", "task_finished", "verification"]) expect(r.events.some(e => e.type === type)).toBe(true);
  });

  it("fixes V1 issues using the same implementer context and re-verifies without coordinator requests", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    let context = "";
    const r = await run([implemented(), ctx => { context = JSON.stringify(ctx); return implemented("fix", "경계 조건을 수정했습니다."); }], [verified(false), verified(true)]);
    expect(r.report.status).toBe("done");
    expect(r.coordinator.faux.state.callCount).toBe(1);
    expect(spawn.mock.calls.map(([options]) => options.id)).toEqual(["A1", "V1"]);
    expect(context).toContain("상수를 수정했습니다.");
    expect(context).toContain("handle zero input");
    expect(context).toContain("node --test: boundary");
    expect(r.events.filter(e => e.type === "assignment_started").map(e => [e.agentId, e.assignment.kind])).toEqual([["A1", "implement"], ["V1", "verify"], ["A1", "fix"], ["V1", "verify"]]);
    expect(r.events.filter(e => e.type === "verification").map(e => e.round)).toEqual([0, 1]);
  });

  it("exhausts the default one fix round and fails with V1 issues", async () => {
    const r = await run([implemented(), implemented("fix")], [verified(false), verified(false)]);
    expect(r.report.status).toBe("failed");
    expect(r.report.summary).toContain("handle zero input");
    expect(r.coordinator.faux.state.callCount).toBe(1);
    expect(r.worker.faux.state.callCount).toBe(2);
    expect(r.verifier.faux.state.callCount).toBe(2);
  });

  it("honors a zero fix-round limit", async () => {
    const r = await run([implemented()], [verified(false)], { limits: { maxFixRounds: 0 } });
    expect(r.report.status).toBe("failed");
    expect(r.report.summary).toContain("handle zero input");
    expect(r.worker.faux.state.callCount).toBe(1);
  });

  it("fails immediately when the implementer reports blocked", async () => {
    const r = await run([tool("report_result", { kind: "implement", summary: "blocked", data: { status: "blocked", reason: "missing credentials" } })], []);
    expect(r.report.status).toBe("failed");
    expect(r.report.summary).toContain("missing credentials");
    expect(r.coordinator.faux.state.callCount).toBe(1);
    expect(r.verifier.faux.state.callCount).toBe(0);
  });

  it("creates and edits across root scopes while rejecting outside paths and symlink escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orche-root-"));
    const cwd = join(parent, "repo");
    const outside = join(parent, "outside");
    await mkdir(join(cwd, "existing"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(cwd, "existing/file.txt"), "before\n");
    await writeFile(join(outside, "secret.txt"), "untouched\n");
    await symlink(outside, join(cwd, "escape"));
    await symlink(join(cwd, "existing"), join(cwd, "alias"));
    try {
      const r = await run([
        tool("read", { path: "existing/file.txt" }),
        context => {
          const anchor = JSON.stringify(context).match(/1#[a-f0-9]+/)?.[0];
          if (!anchor) throw new Error("Read did not return an edit anchor");
          return tool("edit", { path: "existing/file.txt", edits: [{ op: "replace", at: anchor, text: "edited" }] });
        },
        tool("write", { path: "new/nested/file.txt", content: "created\n" }),
        tool("write", { path: "new/nested/file.txt", content: "updated\n" }),
        tool("write", { path: "new-root.txt", content: "root file\n" }),
        tool("write", { path: "alias/second.txt", content: "internal symlink allowed\n" }),
        tool("write", { path: "../outside/secret.txt", content: "bad\n" }),
        tool("write", { path: "escape/secret.txt", content: "bad\n" }),
        implemented(),
      ], [verified(true)], { cwd });
      expect(r.report.status).toBe("done");
      expect(await readFile(join(cwd, "existing/file.txt"), "utf8")).toBe("edited\n");
      expect(await readFile(join(cwd, "new/nested/file.txt"), "utf8")).toBe("updated\n");
      expect(await readFile(join(cwd, "new-root.txt"), "utf8")).toBe("root file\n");
      expect(await readFile(join(cwd, "existing/second.txt"), "utf8")).toBe("internal symlink allowed\n");
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("untouched\n");
      expect(r.events.filter(e => e.type === "ownership_blocked").map(e => e.file)).toEqual(["../outside/secret.txt", "escape/secret.txt"]);
      expect(r.coordinator.faux.state.callCount).toBe(1);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});
