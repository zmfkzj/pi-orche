import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { OrcheController, formatOutcome, type OrcheOutcome } from "../../src/extension/controller.js";
import { externalChangesWarning, runOrchestrated, type RunOptions, type RunReport } from "../../src/orchestration/coordinator.js";
import type { RunLimits } from "../../src/orchestration/limits.js";
import { fauxRuntime } from "../helpers/faux.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function repo(files: Record<string, string> = { "core.mjs": "export const value = 0;\n", "other.mjs": "export const other = 0;\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-failed-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "set value", owner: "A1", files: ["core.mjs"], status: "pending" };
const sh = (cwd: string, command: string) => execFileSync("sh", ["-c", command], { cwd });

/** A real run through the controller, so the formatted tool result is the one the main model sees. */
async function run(dir: string, steps: FauxResponseStep[], limits?: Partial<RunLimits>): Promise<OrcheOutcome> {
  const f = await fauxRuntime(steps);
  const [provider, id] = f.route.model.split("/");
  const controller = new OrcheController({
    agentDir: join(dir, ".no-agent-dir"),
    createRuntime: async () => f.runtime,
    run: (options: RunOptions) => runOrchestrated({ ...options, ...(limits ? { limits } : {}) }),
  });
  return controller.run({ request: "do the work", cwd: dir, model: { provider: provider!, id: id! }, thinking: "high", projectTrusted: true });
}

describe("a failed run keeps what it produced", () => {
  it("change run with a real ownership violation: the approved result stays next to the failure summary", async () => {
    const dir = await repo();
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
      decision({ type: "assign", tasks: [task] }),
      tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
      tool("bash", { command: "echo stray > stray.txt && echo changed > other.mjs" }),
      tool("report_result", { kind: "implement", summary: "set value to 1", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
      decision({ type: "complete", summary: "Value changed from 0 to 1 and verified." }),
    ]);
    const { report } = outcome;
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations?.map(violation => violation.file).sort()).toEqual(["other.mjs", "stray.txt"]);
    // The failure stays the summary; the produced result is no longer replaced by it.
    expect(report.summary).toContain("Decomposition failure: 2 ownership violations");
    expect(report.answer).toBe("Value changed from 0 to 1 and verified.");
    expect(report.answerFromFailedRun).toBe(true);

    const text = formatOutcome(outcome);
    expect(text).toMatch(/^orche FAILED/);
    expect(text).toContain(report.summary);
    expect(text).toContain("Result from failed run (may be incomplete):\nValue changed from 0 to 1 and verified.");
    expect(text.indexOf(report.summary)).toBeLessThan(text.indexOf("Result from failed run"));
    // Recovery advice covers the run's files, never a blanket restore.
    expect(text).toContain("rm -- stray.txt");
    expect(text).not.toMatch(/--\s+\.(\s|$)/);
  });

  it("answer run: the coordinator gives up after the analysts answered, and their answer is kept", async () => {
    const dir = await repo();
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" }),
      tool("report_result", { kind: "answer", summary: "The value is 0 (core.mjs:1).", data: { evidence: ["core.mjs"] } }),
      decision({ type: "fail", reason: "could not cross-check the claim" }),
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed", summary: "could not cross-check the claim", taskClass: "answer",
      answer: "The value is 0 (core.mjs:1).", answerFromFailedRun: true,
    });
    const text = formatOutcome(outcome);
    expect(text).toContain("could not cross-check the claim");
    expect(text).toContain("Result from failed run (may be incomplete):\nThe value is 0 (core.mjs:1).");
  });

  it("answer run timeout: the answer of the analyst that finished survives the one that did not", async () => {
    const dir = await repo();
    const blocked: FauxResponseStep = async (_context, options) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return reply("stopped") as AssistantMessage;
    };
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "answer", workerCount: 2, language: "en", reason: "read-only" }),
      tool("report_result", { kind: "answer", summary: "ANALYSIS: the value is 0 (core.mjs:1).", data: { evidence: ["core.mjs"] } }),
      blocked,
    ], { overallMs: 10_000, assignmentMs: 500, decisionMs: 1000, maxExtensions: 0 });
    const { report } = outcome;
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("timeout");
    expect(report.timeouts).toHaveLength(1);
    expect(report.answer).toBe("ANALYSIS: the value is 0 (core.mjs:1).");
    expect(report.answerFromFailedRun).toBe(true);
    expect(formatOutcome(outcome)).toContain("Result from failed run (may be incomplete):\nANALYSIS: the value is 0 (core.mjs:1).");
  });

  it("without any result the answer stays the failure summary and nothing is marked", async () => {
    const dir = await repo();
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
      decision({ type: "fail", reason: "cannot plan this" }),
    ]);
    expect(outcome.report).toMatchObject({ status: "failed", summary: "cannot plan this", answer: "cannot plan this" });
    expect(outcome.report.answerFromFailedRun).toBeUndefined();
    expect(formatOutcome(outcome)).not.toContain("Result from failed run");
  });

  it("a successful run is unchanged: its answer is the decision's, not marked", async () => {
    const dir = await repo();
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" }),
      tool("report_result", { kind: "answer", summary: "The value is 0.", data: { evidence: ["core.mjs"] } }),
      decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" }),
    ]);
    expect(outcome.report).toMatchObject({ status: "done", answer: "The value is 0." });
    expect(outcome.report.answerFromFailedRun).toBeUndefined();
    expect(formatOutcome(outcome)).not.toContain("Result from failed run");
  });
});

describe("changes made outside the run", () => {
  it("never decide the status: a finished run names them as a warning in its summary and its text", async () => {
    const dir = await repo();
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
      decision({ type: "assign", tasks: [task] }),
      // Another process writes while the worker is only thinking: no worker tool is running.
      () => { sh(dir, "echo from-elsewhere > elsewhere.txt"); return tool("write", { path: "core.mjs", content: "export const value = 1;\n" }); },
      tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
      decision({ type: "complete", summary: "changed" }),
    ]);
    const { report } = outcome;
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toEqual([{ path: "elsewhere.txt", status: "added", reason: expect.any(String) }]);
    expect(report.summary).toContain("Warning: 1 file changed outside this run; not restored: elsewhere.txt");
    expect(report.answerFromFailedRun).toBeUndefined();
    const text = formatOutcome(outcome);
    expect(text).toContain("Changed files: core.mjs");
    expect(text).toContain("Warning: 1 file changed outside this run; not restored: elsewhere.txt");
  });

  it("a failed run restores only its own files and lists the external one as do-not-restore", async () => {
    const dir = await repo();
    const outcome = await run(dir, [
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
      decision({ type: "assign", tasks: [task] }),
      () => { sh(dir, "echo from-elsewhere > elsewhere.txt"); return tool("bash", { command: "echo stray > stray.txt" }); },
      tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
      decision({ type: "complete", summary: "changed" }),
    ]);
    const { report } = outcome;
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "stray.txt", via: "workspace", created: true }]);
    expect(report.summary).toContain("1 ownership violation (stray.txt)");
    expect(report.summary).toContain("Warning: 1 file changed outside this run; not restored: elsewhere.txt");
    expect(report.answer).toBe("changed");
    expect(report.answerFromFailedRun).toBe(true);

    const text = formatOutcome(outcome);
    const commands = text.split("\n").filter(line => /^ {2}\S/.test(line));
    expect(commands).toEqual(["  rm -- stray.txt"]);
    expect(text).toContain("changed outside this run; not restored — do not restore");
    expect(text.slice(text.indexOf("do not restore"))).toContain("elsewhere.txt");
    expect(commands.join("\n")).not.toContain("elsewhere.txt");
  });
});

describe("formatOutcome with a prepared report", () => {
  const report = (overrides: Partial<RunReport>): RunReport => ({
    status: "failed", summary: "Decomposition failure: 1 ownership violation (a.ts)", tasks: [], startedAt: 0, finishedAt: 3000,
    taskClass: "answer", answer: "the analysis", ...overrides,
  });
  const outcome = (r: RunReport): OrcheOutcome => ({
    report: r, text: r.status === "done" ? r.answer : r.summary, cancelledByUser: false, source: { kind: "session" } as OrcheOutcome["source"],
    details: {
      status: r.status, taskClass: r.taskClass, durationMs: 3000, config: "cfg", ignoredConfigs: [], tasks: 0, requests: 0, inputTokens: 0,
      outputTokens: 0, advisorRequests: 0, models: {}, contextWindows: {}, cancelled: false, progress: [],
    },
  });
  const workspace = {
    baseline: "0123456789abcdef0123456789abcdef01234567",
    changes: [{ path: "a.ts", status: "modified" as const }, { path: "new.ts", status: "added" as const }],
    external: [{ path: "package.json", status: "modified" as const, reason: "committed outside this run" }],
  };

  it("shows the preserved answer under its marker, run-only recovery and the external files apart", () => {
    const text = formatOutcome(outcome(report({ answerFromFailedRun: true, workspace })));
    expect(text).toContain("Result from failed run (may be incomplete):\nthe analysis");
    expect(text).toContain("git restore --source=0123456789abcdef0123456789abcdef01234567 --worktree -- a.ts");
    expect(text).toContain("rm -- new.ts");
    expect(text).not.toMatch(/--\s+\.(\s|$)/);
    const commands = text.split("\n").filter(line => /^ {2}\S/.test(line));
    expect(commands.join("\n")).not.toContain("package.json");
    expect(text.slice(text.indexOf("changed outside this run; not restored — do not restore"))).toContain("- modified: package.json — committed outside this run");
  });

  it("does not mark an answer that is only the failure summary", () => {
    const text = formatOutcome(outcome(report({ answer: "Decomposition failure: 1 ownership violation (a.ts)" })));
    expect(text).not.toContain("Result from failed run");
    expect(text.match(/Decomposition failure/g)).toHaveLength(1);
  });

  it("lists only external files for a failed run that changed nothing itself", () => {
    const text = formatOutcome(outcome(report({ workspace: { baseline: workspace.baseline, changes: [], external: workspace.external } })));
    expect(text).toContain("No workspace change is attributed to this run");
    expect(text).toContain("package.json");
    expect(text.split("\n").filter(line => /^ {2}\S/.test(line))).toEqual([]);
  });

  it("warns about external files on a finished run without touching its status", () => {
    const text = formatOutcome(outcome(report({ status: "done", summary: "ok", workspace })));
    expect(text).toMatch(/^orche finished/);
    expect(text).toContain("Changed files: a.ts, new.ts");
    expect(text).toContain("Warning: 1 file changed outside this run; not restored: package.json");
    expect(text).not.toContain("Result from failed run");
  });

  it("shortens long external lists in the one-line warning", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, status: "modified" as const }));
    expect(externalChangesWarning(many)).toBe("Warning: 8 files changed outside this run; not restored: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, … (+3 more)");
  });
});
