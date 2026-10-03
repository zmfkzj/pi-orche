import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { describeWorkspaceChanges, inspectSubmodules, recoveryCommands } from "../../src/orchestration/workspace.js";
import { fauxRuntime } from "../helpers/faux.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const implemented = () => tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });
const commit = "git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm elsewhere";

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "orche-run-sub-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
async function fixture() {
  const lib = await repo({ "src/a.ts": "export const a = 0;\n", "src/b.ts": "export const b = 0;\n" });
  const cwd = await repo({ "top.ts": "export const top = 0;\n" });
  git(cwd, "submodule", "add", "-q", pathToFileURL(lib).href, "browser");
  git(cwd, "commit", "-qm", "add submodule");
  return { cwd, sub: join(cwd, "browser") };
}
async function run(cwd: string, steps: FauxResponseStep[]) {
  const events: RunEvent[] = [];
  const f = await fauxRuntime([
    decision({ type: "classify", taskClass: "change", workerCount: 2, language: "en", reason: "explicit ownership" }),
    decision({ type: "assign", tasks: [{ id: "T1", description: "edit a", owner: "A1", files: ["browser/src/a.ts"], status: "pending" }] }),
    ...steps,
    implemented(),
    tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
    decision({ type: "complete", summary: "changed" }),
  ]);
  const report = await runOrchestrated({ problem: "Edit a.", cwd, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
  expect(f.faux.getPendingResponseCount()).toBe(0);
  return { report, events };
}

describe("multi-run workspace audit includes submodules", () => {
  it("reports an owned uncommitted edit and generates recovery inside the submodule", async () => {
    const { cwd, sub } = await fixture();
    const { report } = await run(cwd, [tool("write", { path: "browser/src/a.ts", content: "export const a = 1;\n" })]);
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(report.workspace?.changes).toEqual([{ path: "browser/src/a.ts", status: "modified" }]);
    expect(report.workspace?.external).toBeUndefined();
    const workspace = report.workspace!;
    const states = await inspectSubmodules(cwd, workspace.baseline, workspace.changes.map(change => change.path));
    expect(recoveryCommands(workspace.baseline, workspace.changes, [], states)).toEqual(["git -C browser restore -- src/a.ts"]);
    expect(describeWorkspaceChanges(workspace.baseline, workspace.changes, [], states)).toContain("browser/src/a.ts (inside submodule browser)");
    expect(await readFile(join(sub, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("attributes an unowned bash edit inside the submodule to its worker", async () => {
    const { cwd } = await fixture();
    const { report, events } = await run(cwd, [tool("bash", { command: "echo 'export const b = 1;' > browser/src/b.ts" })]);
    expect(report.status).toBe("failed");
    expect(report.workspace?.changes).toEqual([{ path: "browser/src/b.ts", status: "modified" }]);
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "browser/src/b.ts", via: "workspace" }]);
    expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([{ file: "browser/src/b.ts", ownerTaskIds: [] }]);
  });

  it("reports a quiet submodule edit as external, never as a violation or a recovery target", async () => {
    const { cwd, sub } = await fixture();
    const { report } = await run(cwd, [async () => {
      await writeFile(join(sub, "src/b.ts"), "export const b = 2;\n");
      return tool("read", { path: "browser/src/a.ts" });
    }]);
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(report.workspace?.changes).toEqual([]);
    expect(report.workspace?.external).toEqual([{ path: "browser/src/b.ts", status: "modified", reason: "changed while no worker tool was running" }]);
    const workspace = report.workspace!;
    expect(recoveryCommands(workspace.baseline, workspace.changes, workspace.external)).toEqual([]);
  });

  it("keeps dirty submodule files attributable when only the umbrella HEAD moves", async () => {
    const { cwd } = await fixture();
    const { report } = await run(cwd, [tool("bash", { command: `echo 'export const b = 3;' > browser/src/b.ts && ${commit} --allow-empty` })]);
    expect(report.status).toBe("failed");
    expect(report.workspace?.changes).toEqual([{ path: "browser/src/b.ts", status: "modified" }]);
    expect(report.workspace?.external).toBeUndefined();
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "browser/src/b.ts", via: "workspace" }]);
  });

  it("checks a submodule commit's gitlink ownership while preserving dirty files and external committed content", async () => {
    const { cwd, sub } = await fixture();
    const start = git(sub, "rev-parse", "HEAD");
    const { report } = await run(cwd, [tool("bash", { command: `echo 'export const b = 4;' > browser/src/b.ts && git -C browser add src/b.ts && git -C browser -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm elsewhere && echo 'export const a = 4;' > browser/src/a.ts` })]);
    expect(git(sub, "rev-parse", "HEAD")).not.toBe(start);
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "browser", via: "workspace" }]);
    expect(report.workspace?.changes).toEqual([
      { path: "browser", status: "modified" },
      { path: "browser/src/a.ts", status: "modified" },
    ]);
    expect(report.workspace?.external).toEqual([
      { path: "browser/src/b.ts", status: "modified", reason: "committed outside this run" },
    ]);
    const workspace = report.workspace!;
    const states = await inspectSubmodules(cwd, workspace.baseline, [...workspace.changes, ...workspace.external!].map(change => change.path));
    expect(recoveryCommands(workspace.baseline, workspace.changes, workspace.external, states)).toEqual(["git -C browser restore -- src/a.ts", `git -C browser checkout ${start}`]);
    expect(describeWorkspaceChanges(workspace.baseline, workspace.changes, workspace.external, states)).toContain("browser/src/b.ts — committed outside this run");
  });

  it("flags an unowned HEAD-only move and reports its old/new commits with gitlink-aware recovery", async () => {
    const { cwd, sub } = await fixture();
    const start = git(sub, "rev-parse", "HEAD");
    const { report, events } = await run(cwd, [tool("bash", { command: "git -C browser -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --allow-empty -qm moved" })]);
    const after = git(sub, "rev-parse", "HEAD");
    expect(after).not.toBe(start);
    expect(report.status).toBe("failed");
    expect(report.workspace?.changes).toEqual([{ path: "browser", status: "modified" }]);
    expect(report.workspace?.external).toBeUndefined();
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "browser", via: "workspace" }]);
    expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([{ file: "browser", ownerTaskIds: [] }]);
    const workspace = report.workspace!;
    const states = await inspectSubmodules(cwd, workspace.baseline, workspace.changes.map(change => change.path));
    expect(states).toMatchObject([{ path: "browser", from: start, to: after }]);
    expect(recoveryCommands(workspace.baseline, workspace.changes, [], states)).toEqual([`git -C browser checkout ${start}`]);
    const advice = describeWorkspaceChanges(workspace.baseline, workspace.changes, [], states);
    expect(advice).toContain(`submodule browser HEAD moved ${start.slice(0, 12)}→${after.slice(0, 12)}; to go back: git -C browser checkout ${start}`);
    expect(advice).not.toContain("git restore");
  });

  it("keeps a HEAD move made while no worker tool runs external and out of recovery commands", async () => {
    const { cwd, sub } = await fixture();
    const { report } = await run(cwd, [() => {
      git(sub, "commit", "--allow-empty", "-qm", "elsewhere");
      return tool("read", { path: "browser/src/a.ts" });
    }]);
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(report.workspace?.changes).toEqual([]);
    expect(report.workspace?.external).toEqual([{ path: "browser", status: "modified", reason: "changed while no worker tool was running" }]);
    const workspace = report.workspace!;
    const states = await inspectSubmodules(cwd, workspace.baseline, workspace.external!.map(change => change.path));
    expect(recoveryCommands(workspace.baseline, workspace.changes, workspace.external, states)).toEqual([]);
  });
});
