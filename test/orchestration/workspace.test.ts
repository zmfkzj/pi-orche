import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { checkWrite, ownsPath } from "../../src/orchestration/ownership.js";
import { BASELINE_REF, describeWorkspaceChanges, recoveryCommands, WorkspaceAudit } from "../../src/orchestration/workspace.js";
import type { TaskItem } from "../../src/orchestration/backlog.js";
import { fauxRuntime } from "../helpers/faux.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function repo(files: Record<string, string> = { "core.mjs": "export const value = 0;\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-git-"));
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

describe("ownership guard", () => {
  const tasks: TaskItem[] = [
    { id: "core", description: "core", owner: "A1", files: ["src/core.js"], status: "running" },
    { id: "tests", description: "tests", owner: "A2", files: ["test/"], status: "pending" },
  ];
  const check = (toolName: string, input: Record<string, unknown>, agentId = "A1", assignmentKind = "implement") =>
    checkWrite({ toolName, input, cwd: "/repo", agentId, assignmentKind, tasks });
  it("allows owned writes during implement/fix only", () => {
    expect(check("edit", { path: "src/core.js" })).toBeUndefined();
    expect(check("write", { path: "./src/../src/core.js" }, "A1", "fix")).toBeUndefined();
    expect(check("write", { path: "/repo/test/a/b.test.js" }, "A2")).toBeUndefined();
    expect(check("write", { path: "src/core.js" }, "A1", "explore")?.reason).toContain("read-only");
    expect(check("write", { path: "src/core.js" }, "A1", "verify")?.reason).toContain("read-only");
  });
  it("blocks other workers' files, outside paths and a pathless ast_rewrite", () => {
    expect(check("write", { path: "test/x.test.js" })).toMatchObject({ file: "test/x.test.js", reason: expect.stringContaining("outside your owned files (src/core.js)") });
    expect(check("edit", { path: "../elsewhere.js" })?.reason).toContain("outside the workspace");
    expect(check("ast_rewrite", { pattern: "a", replacement: "b" })?.reason).toContain("explicit path");
    expect(check("ast_rewrite", { pattern: "a", replacement: "b", path: "src" })?.file).toBe("src");
    expect(check("ast_rewrite", { pattern: "a", replacement: "b", path: "test" }, "A2")).toBeUndefined();
    expect(check("ast_rewrite", { pattern: "a", replacement: "b", dryRun: true })).toBeUndefined();
    expect(check("bash", { command: "rm -rf /" })).toBeUndefined();
  });
  it("matches directory ownership by prefix, never by name prefix", () => {
    expect(ownsPath("test/", "test")).toBe(true);
    expect(ownsPath("test/", "test/a.js")).toBe(true);
    expect(ownsPath("test/", "tests/a.js")).toBe(false);
    expect(ownsPath("src/core.js", "src/core.js.bak")).toBe(false);
  });
});

describe("workspace audit", () => {
  it("is unavailable outside git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-nogit-"));
    dirs.push(dir);
    expect(await WorkspaceAudit.open(dir)).toBeUndefined();
  });
  it("sees changes by any means, leaves index/HEAD alone, and restores the baseline", async () => {
    const dir = await repo({ "core.mjs": "export const value = 0;\n", "keep.txt": "keep\n", ".gitignore": "ignored/\n" });
    await writeFile(join(dir, "dirty.txt"), "uncommitted before the run\n");
    const audit = (await WorkspaceAudit.open(dir))!;
    const head = git(dir, "rev-parse", "HEAD");
    const status = git(dir, "status", "--porcelain");
    const before = await audit.snapshot();
    const commit = await audit.checkpoint(before);
    expect(git(dir, "rev-parse", BASELINE_REF)).toBe(commit);
    await writeFile(join(dir, "core.mjs"), "export const value = 1;\n");
    await writeFile(join(dir, "dirty.txt"), "changed by the run\n");
    await writeFile(join(dir, "new file.txt"), "added\n");
    await rm(join(dir, "keep.txt"));
    await mkdir(join(dir, "ignored"));
    await writeFile(join(dir, "ignored/build.log"), "ignored\n");
    await mkdir(join(dir, ".orche/artifacts"), { recursive: true });
    await writeFile(join(dir, ".orche/artifacts/x.txt"), "spill\n");
    const after = await audit.snapshot();
    const changes = await audit.diff(before, after);
    expect(changes).toEqual(expect.arrayContaining([
      { path: "core.mjs", status: "modified" }, { path: "dirty.txt", status: "modified" },
      { path: "new file.txt", status: "added" }, { path: "keep.txt", status: "deleted" },
    ]));
    expect(changes).toHaveLength(4);
    // The user's HEAD and index are untouched.
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    expect(status).toBe("?? dirty.txt");
    for (const command of recoveryCommands(commit, changes)) execFileSync("sh", ["-c", command], { cwd: dir });
    expect(await audit.diff(before, await audit.snapshot())).toEqual([]);
    expect(await readFile(join(dir, "dirty.txt"), "utf8")).toBe("uncommitted before the run\n");
    expect(describeWorkspaceChanges(commit, changes)).toContain("git restore --source=");
    expect(describeWorkspaceChanges(commit, changes)).toContain("rm -- 'new file.txt'");
    await audit.close();
  });
  it.each([
    { ignored: true, scope: "." },
    { ignored: false, scope: "." },
    { ignored: true, scope: "pkg" },
    { ignored: false, scope: "pkg" },
  ])("excludes .orche contents (ignored: $ignored, cwd: $scope)", async ({ ignored, scope }) => {
    const dir = await repo({
      [join(scope, "core.txt")]: "before\n",
      [join(scope, "keep.txt")]: "keep\n",
      ".gitignore": `${ignored ? ".orche/\n" : ""}ignored/\n`,
    });
    const cwd = join(dir, scope);
    await mkdir(join(cwd, ".orche/artifacts"), { recursive: true });
    await writeFile(join(cwd, ".orche/artifacts/existing.txt"), "before\n");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "--", "staged.txt");
    const head = git(dir, "rev-parse", "HEAD");
    const index = await readFile(join(dir, ".git/index"));
    const audit = (await WorkspaceAudit.open(cwd))!;
    try {
      const before = await audit.snapshot();
      await writeFile(join(cwd, "core.txt"), "after\n");
      await rm(join(cwd, "keep.txt"));
      await writeFile(join(cwd, "new.txt"), "new\n");
      await writeFile(join(cwd, ".orche/artifacts/existing.txt"), "after\n");
      await writeFile(join(cwd, ".orche/artifacts/new.txt"), "spill\n");
      await mkdir(join(cwd, "ignored"));
      await writeFile(join(cwd, "ignored/build.txt"), "ignored\n");
      await mkdir(join(cwd, ".orche-other"));
      await writeFile(join(cwd, ".orche-other/keep.txt"), "not excluded\n");
      const after = await audit.snapshot();
      expect(await audit.diff(before, after)).toEqual([
        { path: ".orche-other/keep.txt", status: "added" },
        { path: "core.txt", status: "modified" },
        { path: "keep.txt", status: "deleted" },
        { path: "new.txt", status: "added" },
      ]);
      for (const tree of [before, after]) {
        expect(git(cwd, "ls-tree", "-r", "--name-only", tree, "--", ".orche")).toBe("");
      }
      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
      expect(await readFile(join(dir, ".git/index"))).toEqual(index);
      expect(await readFile(join(cwd, ".orche/artifacts/existing.txt"), "utf8")).toBe("after\n");
      expect(await readFile(join(cwd, ".orche/artifacts/new.txt"), "utf8")).toBe("spill\n");
    } finally {
      await audit.close();
    }
  });
  it("reports paths relative to a subdirectory cwd", async () => {
    const dir = await repo({ "pkg/a.js": "a\n", "other/b.js": "b\n" });
    const audit = (await WorkspaceAudit.open(join(dir, "pkg")))!;
    const before = await audit.snapshot();
    await writeFile(join(dir, "pkg/a.js"), "changed\n");
    await writeFile(join(dir, "other/b.js"), "outside cwd\n");
    expect(await audit.diff(before, await audit.snapshot())).toEqual([{ path: "a.js", status: "modified" }]);
    await audit.close();
  });
});

describe("workspace audit in a run", () => {
  const task = { id: "change", description: "set value", owner: "A1", files: ["core.mjs"], status: "pending" };
  it("reports a bash change to an unowned file as a violation and lists every change with recovery", async () => {
    const dir = await repo({ "core.mjs": "export const value = 0;\n", "other.mjs": "export const other = 0;\n" });
    const events: RunEvent[] = [];
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
      decision({ type: "assign", tasks: [task] }),
      tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
      tool("ast_rewrite", { pattern: "value", replacement: "other" }),
      tool("bash", { command: "echo stray > stray.txt && echo changed > other.mjs" }),
      tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
      decision({ type: "complete", summary: "changed" }),
    ]);
    const report = await runOrchestrated({ problem: "Set value to 1.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("2 ownership violations (other.mjs, stray.txt)");
    expect(report.ownershipViolations).toEqual([
      { agentId: "A1", file: "other.mjs", via: "workspace" },
      { agentId: "A1", file: "stray.txt", via: "workspace", created: true },
    ]);
    // .txt defaults to source: creation and modification both violate, but only creation is marked.
    expect(events.filter(event => event.type === "workspace_unowned_file")).toEqual([]);
    expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([
      { agentId: "A1", file: "other.mjs", via: "workspace", ownerTaskIds: [] },
      { agentId: "A1", file: "stray.txt", via: "workspace", created: true, ownerTaskIds: [] },
    ]);
    expect(describeWorkspaceChanges(report.workspace!.baseline, report.workspace!.changes)).toContain("rm -- stray.txt");
    // The pathless ast_rewrite never ran; the owned write did.
    expect(events.filter(event => event.type === "ownership_blocked")).toMatchObject([{ agentId: "A1", tool: "ast_rewrite" }]);
    expect(await readFile(join(dir, "core.mjs"), "utf8")).toBe("export const value = 1;\n");
    const baseline = events.find(event => event.type === "workspace_baseline");
    expect(report.workspace).toEqual({ baseline: baseline && "commit" in baseline ? baseline.commit : "missing", changes: [
      { path: "core.mjs", status: "modified" }, { path: "other.mjs", status: "modified" }, { path: "stray.txt", status: "added" },
    ] });
    expect(git(dir, "show", `${report.workspace!.baseline}:core.mjs`)).toBe("export const value = 0;");
    expect(f.faux.getPendingResponseCount()).toBe(0);
  });
  it.each([
    { file: "coverage/lcov.info", files: ["core.mjs"], violation: false },
    { file: "stray.ts", files: ["core.mjs"], violation: true },
    { file: "new.ts", files: ["core.mjs", "new.ts"], violation: false },
  ])("audits implementer creation of $file (violation: $violation)", async ({ file, files, violation }) => {
    const dir = await repo();
    const events: RunEvent[] = [];
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
      decision({ type: "assign", tasks: [{ ...task, files }] }),
      tool("bash", { command: `mkdir -p ${file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "."} && echo created > ${file}` }),
      tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } }),
      tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
      decision({ type: "complete", summary: "changed" }),
    ]);
    const report = await runOrchestrated({ problem: "Make a change.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, sink: event => events.push(event) });
    expect(report.status).toBe(violation ? "failed" : "done");
    expect(report.ownershipViolations).toEqual(violation ? [{ agentId: "A1", file, via: "workspace", created: true }] : []);
    expect(events.filter(event => event.type === "workspace_unowned_file")).toMatchObject(file.startsWith("coverage/") ? [{ agentId: "A1", file }] : []);
    if (violation) {
      expect(report.summary).toContain(`created unowned source file ${file}`);
      expect(report.summary).toContain("Own the path in the backlog");
      expect(report.summary).toContain("audit.artifacts");
      expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([{ agentId: "A1", file, via: "workspace", created: true, ownerTaskIds: [] }]);
    }
    expect(report.workspace?.changes).toEqual([{ path: file, status: "added" }]);
    expect(describeWorkspaceChanges(report.workspace!.baseline, report.workspace!.changes)).toContain(`rm -- ${file}`);
    expect(f.faux.getPendingResponseCount()).toBe(0);
  });
  it.each([false, true])("audits read-only analyst creation (artifact escape hatch: %s)", async exempt => {
    const dir = await repo();
    const events: RunEvent[] = [];
    const f = await fauxRuntime([
      decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" }),
      () => {
        // Analysts expose no bash/write tool. Simulate an out-of-band check/script side effect
        // during their assignment so the snapshot backstop, not the tool guard, is exercised.
        execFileSync("sh", ["-c", "echo notes > notes.md"], { cwd: dir });
        return tool("report_result", { kind: "answer", summary: "explained", data: { evidence: ["core.mjs"] } });
      },
      decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" }),
    ]);
    const report = await runOrchestrated({ problem: "Explain the code.", cwd: dir, routes: { routes: {}, default: { model: f.route.model }, ...(exempt ? { audit: { artifacts: ["notes.md"] } } : {}) }, modelRuntime: f.runtime, sink: event => events.push(event) });
    expect(report.status).toBe(exempt ? "done" : "failed");
    expect(report.ownershipViolations).toEqual(exempt ? [] : [{ agentId: "A1", file: "notes.md", via: "workspace", created: true }]);
    expect(events.filter(event => event.type === "workspace_unowned_file")).toMatchObject(exempt ? [{ agentId: "A1", file: "notes.md" }] : []);
    expect(report.workspace?.changes).toEqual([{ path: "notes.md", status: "added" }]);
    expect(f.faux.getPendingResponseCount()).toBe(0);
  });

  it("a clean run reports its changes without violations; workspaceAudit:false disables it", async () => {
    for (const workspaceAudit of [true, false]) {
      const dir = await repo();
      const f = await fauxRuntime([
        decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
        decision({ type: "assign", tasks: [task] }),
        tool("write", { path: "core.mjs", content: "export const value = 1;\n" }),
        tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } }),
        tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
        decision({ type: "complete", summary: "changed" }),
      ]);
      const report = await runOrchestrated({ problem: "Set value to 1.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, workspaceAudit });
      expect(report.status).toBe("done");
      expect(report.ownershipViolations).toEqual([]);
      if (workspaceAudit) expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
      else {
        expect(report.workspace).toBeUndefined();
        expect(() => git(dir, "rev-parse", "--verify", "--quiet", BASELINE_REF)).toThrow();
      }
    }
  });
});
