import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { BASELINE_REF, describeWorkspaceChanges, recoveryCommands } from "../../src/orchestration/workspace.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * Workspace change attribution: changes made by other processes (another pi session, the user, a
 * commit made elsewhere) must be reported as `external`, never as ownership violations of the run.
 * Workers' own bash/write changes outside their ownership stay violations.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sh = (cwd: string, script: string) => execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });
const COMMIT = "git -c user.name=elsewhere -c user.email=e@e commit -qm elsewhere";
async function repo(files: Record<string, string> = { "core.mjs": "export const value = 0;\n", "other.mjs": "export const other = 0;\n", "package.json": "{}\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-ext-"));
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
/**
 * Pause so the (non-blocking) end-of-tool snapshot has surely run: a write that lands within
 * milliseconds after a tool ends is indistinguishable from the tool's own and counts as the run's.
 */
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

async function answerRun(dir: string, analyst: FauxResponseStep, extra: { events?: RunEvent[] } = {}) {
  const events = extra.events ?? [];
  const f = await fauxRuntime([
    decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" }),
    analyst,
    decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" }),
  ]);
  const report = await runOrchestrated({ problem: "Explain the code.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
  expect(f.faux.getPendingResponseCount()).toBe(0);
  return { report, events };
}
const analystAnswer = () => tool("report_result", { kind: "answer", summary: "explained", data: { evidence: ["core.mjs"] } });

/** Explicitly planned change run: `steps` are A1's model responses before it reports. */
async function changeRun(dir: string, steps: FauxResponseStep[]) {
  const events: RunEvent[] = [];
  const f = await fauxRuntime([
    decision({ type: "classify", taskClass: "change", workerCount: 2, language: "en", reason: "explicit ownership" }),
    decision({ type: "assign", tasks: [task] }),
    ...steps,
    tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
    decision({ type: "complete", summary: "changed" }),
  ]);
  const report = await runOrchestrated({ problem: "Set value to 1.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
  expect(f.faux.getPendingResponseCount()).toBe(0);
  return { report, events };
}
const implemented = () => tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });
const writeCore = () => tool("write", { path: "core.mjs", content: "export const value = 1;\n" });
const externalEvents = (events: RunEvent[]) => events.filter(event => event.type === "workspace_external_change");

describe("(i) changes made while no worker tool runs are external", () => {
  it("does not fail an answer run whose package.json another session edited", async () => {
    const dir = await repo();
    const { report, events } = await answerRun(dir, () => {
      sh(dir, "echo '{\"name\":\"edited elsewhere\"}' > package.json");
      return analystAnswer();
    });
    expect(report.status).toBe("done");
    expect(report.answer).toBe("explained");
    expect(report.ownershipViolations).toEqual([]);
    expect(events.filter(event => event.type === "ownership_violation")).toEqual([]);
    expect(report.workspace?.changes).toEqual([]);
    expect(report.workspace?.external).toEqual([{ path: "package.json", status: "modified", reason: "changed while no worker tool was running" }]);
    expect(externalEvents(events)).toMatchObject([{ file: "package.json", reason: "changed while no worker tool was running" }]);
    // Recovery advice never restores it, and says so.
    const advice = describeWorkspaceChanges(report.workspace!.baseline, report.workspace!.changes, report.workspace!.external);
    expect(advice).toContain("do not restore");
    expect(recoveryCommands(report.workspace!.baseline, report.workspace!.changes, report.workspace!.external)).toEqual([]);
    expect(await readFile(join(dir, "package.json"), "utf8")).toContain("edited elsewhere");
  });

  it("does not fail a change run whose unowned file changed between worker tool calls", async () => {
    const dir = await repo();
    const { report, events } = await changeRun(dir, [
      writeCore(),
      async () => {
        await settle();
        sh(dir, "echo 'export const other = 99;' > other.mjs && echo fresh > external-new.txt");
        return implemented();
      },
    ]);
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(events.filter(event => event.type === "ownership_violation")).toEqual([]);
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toEqual([
      { path: "external-new.txt", status: "added", reason: "changed while no worker tool was running" },
      { path: "other.mjs", status: "modified", reason: "changed while no worker tool was running" },
    ]);
    expect(externalEvents(events).map(event => "file" in event && event.file).sort()).toEqual(["external-new.txt", "other.mjs"]);
    // The advice lists only the run's file and keeps the external ones out of every command.
    const advice = describeWorkspaceChanges(report.workspace!.baseline, report.workspace!.changes, report.workspace!.external);
    for (const command of recoveryCommands(report.workspace!.baseline, report.workspace!.changes, report.workspace!.external)) {
      expect(command).toContain("core.mjs");
      expect(command).not.toContain("other.mjs");
      expect(command).not.toContain("external-new.txt");
    }
    expect(advice).not.toContain("-- .");
    expect(await readFile(join(dir, "other.mjs"), "utf8")).toBe("export const other = 99;\n");
  });

  it("keeps an ambiguous change the run's: a file touched by both a quiet external write and a worker bash stays a violation", async () => {
    const dir = await repo();
    const { report } = await changeRun(dir, [
      writeCore(),
      async () => {
        await settle();
        sh(dir, "echo external >> other.mjs");
        return tool("bash", { command: "echo worker >> other.mjs" });
      },
      implemented(),
    ]);
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
  });
});

describe("(ii) files committed elsewhere are external", () => {
  it("answer run: HEAD moved and the file equals the new HEAD", async () => {
    const dir = await repo();
    const before = git(dir, "rev-parse", "HEAD");
    const { report, events } = await answerRun(dir, () => {
      sh(dir, `echo 'export const value = 7;' > core.mjs && git add core.mjs && ${COMMIT}`);
      return analystAnswer();
    });
    const after = git(dir, "rev-parse", "HEAD");
    expect(after).not.toBe(before); // the other session's commit is untouched by the run
    expect(git(dir, "log", "-1", "--format=%s")).toBe("elsewhere");
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(report.workspace?.changes).toEqual([]);
    expect(report.workspace?.external).toEqual([{ path: "core.mjs", status: "modified", reason: "committed outside this run" }]);
    expect(externalEvents(events)).toMatchObject([{ file: "core.mjs", reason: "committed outside this run" }]);
    expect(git(dir, "rev-parse", `${BASELINE_REF}^`)).toBe(before);
    expect(git(dir, "show", `${report.workspace!.baseline}:core.mjs`)).toBe("export const value = 0;");
  });

  it("change run: committed during a worker's own bash call (not a quiet window) is still external", async () => {
    const dir = await repo();
    const { report, events } = await changeRun(dir, [
      writeCore(),
      // The window is active here: only the HEAD/content rule can tell this commit is not the worker's.
      tool("bash", { command: `echo 'export const other = 5;' > other.mjs && git add other.mjs && ${COMMIT}` }),
      implemented(),
    ]);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("elsewhere");
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(events.filter(event => event.type === "ownership_violation")).toEqual([]);
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toEqual([{ path: "other.mjs", status: "modified", reason: "committed outside this run" }]);
  });

  it("change run: HEAD moved but the file differs from the new HEAD, so it stays the run's violation", async () => {
    const dir = await repo();
    const { report } = await changeRun(dir, [
      writeCore(),
      tool("bash", { command: `echo 'export const other = 5;' > other.mjs && git add other.mjs && ${COMMIT} && echo '// more' >> other.mjs` }),
      implemented(),
    ]);
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect(report.workspace?.external).toBeUndefined();
  });
});

describe("(iii) a worker's own changes outside its ownership remain violations", () => {
  it("fails on a bash write to an unowned file and an unowned new source file, next to an external change", async () => {
    const dir = await repo();
    const { report, events } = await changeRun(dir, [
      writeCore(),
      tool("bash", { command: "echo changed > other.mjs && echo stray > stray.txt" }),
      async () => {
        await settle();
        sh(dir, "echo '{\"external\":true}' > package.json");
        return implemented();
      },
    ]);
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([
      { agentId: "A1", file: "other.mjs", via: "workspace" },
      { agentId: "A1", file: "stray.txt", via: "workspace", created: true },
    ]);
    expect(report.summary).toContain("2 ownership violations (other.mjs, stray.txt)");
    expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([{ file: "other.mjs" }, { file: "stray.txt", created: true }]);
    // The external edit is reported, but is not a violation.
    expect(report.workspace?.external).toEqual([{ path: "package.json", status: "modified", reason: "changed while no worker tool was running" }]);
    expect(report.workspace?.changes).toEqual([
      { path: "core.mjs", status: "modified" }, { path: "other.mjs", status: "modified" }, { path: "stray.txt", status: "added" },
    ]);
    const commands = recoveryCommands(report.workspace!.baseline, report.workspace!.changes, report.workspace!.external).join("\n");
    expect(commands).toContain("other.mjs");
    expect(commands).not.toContain("package.json");
    expect(commands).not.toContain("-- .");
  });

  it("an owned write by a worker's write tool stays the run's even when an external write follows", async () => {
    const dir = await repo();
    const { report } = await changeRun(dir, [
      writeCore(),
      async () => {
        await settle();
        sh(dir, "echo 'export const value = 2;' > core.mjs"); // somebody else edits the same file afterwards
        return implemented();
      },
    ]);
    // Written by the worker's write tool: always the run's, never external, never a violation (owned).
    expect(report.status).toBe("done");
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toBeUndefined();
  });
});
