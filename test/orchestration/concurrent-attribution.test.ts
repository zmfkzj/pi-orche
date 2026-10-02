import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { CONCURRENT_SESSION_AMBIGUOUS, externalChangesWarning, runOrchestrated, type ConcurrentActivity } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { auditWorkspace, finalWorkspace, openWorkspaceAudit } from "../../src/orchestration/run/audit.js";
import type { RunContext } from "../../src/orchestration/run/types.js";
import { describeWorkspaceChanges, recoveryCommands } from "../../src/orchestration/workspace.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * Concurrent-session attribution. When other pi sessions were detected at start (the run's
 * `concurrentActivity` option), a file that changed while a worker bash call was in flight, that is
 * outside the worker's ownership and was not written by an edit/write call has no knowable writer:
 * it is external ("concurrent session active; ambiguous"), not an ownership violation. Without the
 * flag it stays a violation, and edit/write-tool writes outside ownership are violations either way.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sh = (cwd: string, script: string) => execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });
async function repo(files: Record<string, string> = { "core.mjs": "export const value = 0;\n", "other.mjs": "export const other = 0;\n", "package.json": "{}\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orche-concurrent-"));
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

const FLAGGED: ConcurrentActivity = { count: 1, detail: "1 other pi session active in this repository (cwd /elsewhere, last write 3s ago)" };
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "set value", owner: "A1", files: ["core.mjs"], status: "pending" };
const implemented = () => tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });
const writeCore = () => tool("write", { path: "core.mjs", content: "export const value = 1;\n" });
const externalEvents = (events: RunEvent[]) => events.filter(event => event.type === "workspace_external_change");

/** A one-worker change run: `steps` are the implementer's model responses before it reports. */
async function changeRun(dir: string, steps: FauxResponseStep[], concurrentActivity?: ConcurrentActivity) {
  const events: RunEvent[] = [];
  const f = await fauxRuntime([
    decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "small change" }),
    decision({ type: "assign", tasks: [task] }),
    ...steps,
    tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
    decision({ type: "complete", summary: "changed" }),
  ]);
  const report = await runOrchestrated({
    problem: "Set value to 1.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime,
    sink: event => events.push(event), ...(concurrentActivity ? { concurrentActivity } : {}),
  });
  expect(f.faux.getPendingResponseCount()).toBe(0);
  return { report, events };
}
const bashOther = () => tool("bash", { command: "echo 'export const other = 5;' > other.mjs" });

describe("a change run: bash-window change to an unowned file", () => {
  it("is external with the concurrency reason when concurrent sessions are flagged", async () => {
    const dir = await repo();
    const { report, events } = await changeRun(dir, [writeCore(), bashOther(), implemented()], FLAGGED);
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(events.filter(event => event.type === "ownership_violation")).toEqual([]);
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toEqual([{ path: "other.mjs", status: "modified", reason: "concurrent session active; ambiguous" }]);
    expect(CONCURRENT_SESSION_AMBIGUOUS).toBe("concurrent session active; ambiguous");
    expect(externalEvents(events)).toMatchObject([{ file: "other.mjs", reason: "concurrent session active; ambiguous", agentId: "A1" }]);
    // Visible through the external-changes warning, which names the concurrency.
    expect(report.summary).toContain("Warning: 1 file changed outside this run; not restored: other.mjs");
    expect(report.summary).toContain("another pi session was active");
    // The file is never offered for restoration.
    const { baseline, changes, external } = report.workspace!;
    expect(recoveryCommands(baseline, changes, external).join("\n")).not.toContain("other.mjs");
    expect(describeWorkspaceChanges(baseline, changes, external)).toContain("other.mjs — concurrent session active; ambiguous");
    // The worker's bash write itself is left in place.
    expect(await readFile(join(dir, "other.mjs"), "utf8")).toBe("export const other = 5;\n");
  });

  it("covers a new unowned source file too", async () => {
    const dir = await repo();
    const { report } = await changeRun(dir, [writeCore(), tool("bash", { command: "echo scratch > stray.txt" }), implemented()], FLAGGED);
    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(report.workspace?.external).toEqual([{ path: "stray.txt", status: "added", reason: "concurrent session active; ambiguous" }]);
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
  });

  it("is still an ownership violation when the run is not flagged", async () => {
    const dir = await repo();
    const { report, events } = await changeRun(dir, [writeCore(), bashOther(), implemented()]);
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([{ file: "other.mjs" }]);
    expect(report.workspace?.external).toBeUndefined();
    expect(externalEvents(events)).toEqual([]);
    expect(report.summary).not.toContain("another pi session");
  });

  it("is still an ownership violation when the detection found nobody (count 0)", async () => {
    const dir = await repo();
    const { report } = await changeRun(dir, [writeCore(), bashOther(), implemented()], { count: 0, detail: "" });
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect(report.workspace?.external).toBeUndefined();
  });

  it("leaves the worker's owned files the run's, flagged or not", async () => {
    const dir = await repo();
    const { report } = await changeRun(dir, [tool("bash", { command: "echo 'export const value = 2;' > core.mjs" }), implemented()], FLAGGED);
    expect(report.status).toBe("done");
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toBeUndefined();
  });
});

/** Minimal run context over a real temp repo: what auditWorkspace/finalWorkspace read and write. */
async function auditContext(dir: string, concurrentActivity?: ConcurrentActivity) {
  const events: RunEvent[] = [];
  const ctx = {
    options: { cwd: dir, problem: "p", routes: { routes: {} }, sink: (event: RunEvent) => events.push(event), ...(concurrentActivity ? { concurrentActivity } : {}) },
    startedAt: Date.now(), cancelled: false, violations: [], reported: false,
    state: { phase: "BACKLOG", taskClass: "change", tasks: [{ id: "t", description: "d", owner: "A1", files: ["core.mjs"], status: "pending" }] },
  } as unknown as RunContext;
  await openWorkspaceAudit(ctx);
  expect(ctx.activity).toBeDefined();
  /** One complete worker tool call: start event, write guard, the tool's own effect, end event. */
  const toolCall = async (agent: string, id: string, toolName: string, args: unknown, effect: () => void) => {
    ctx.activity!.record(agent, { phase: "start", toolCallId: id, toolName, args });
    await ctx.activity!.enter(agent, toolName);
    effect();
    ctx.activity!.record(agent, { phase: "end", toolCallId: id, toolName, isError: false });
  };
  const owned = (file: string) => file === "core.mjs";
  return { ctx, events, toolCall, owned };
}

describe("auditWorkspace with a flagged run", () => {
  it("keeps an edit/write-tool write outside ownership a violation, and still frees the bash-window one", async () => {
    const dir = await repo();
    const { ctx, events, toolCall, owned } = await auditContext(dir, FLAGGED);
    // The write tool landed outside the worker's ownership (e.g. ownership changed after the call).
    await toolCall("A1", "w1", "write", { path: "other.mjs" }, () => sh(dir, "echo 'export const other = 9;' > other.mjs"));
    // A bash call changes another unowned file: its writer is ambiguous.
    await toolCall("A1", "b1", "bash", { command: "echo x > scratch.mjs" }, () => sh(dir, "echo 'export const s = 1;' > scratch.mjs"));
    await auditWorkspace(ctx, ["A1"], owned);

    expect(ctx.violations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect([...ctx.externalChanges!.values()]).toEqual([{ path: "scratch.mjs", status: "added", reason: CONCURRENT_SESSION_AMBIGUOUS }]);
    expect(events.filter(event => event.type === "ownership_violation")).toMatchObject([{ file: "other.mjs" }]);
    expect(externalEvents(events)).toMatchObject([{ file: "scratch.mjs", reason: CONCURRENT_SESSION_AMBIGUOUS }]);

    // The final list agrees: the written file is the run's, the ambiguous one is external only.
    const workspace = await finalWorkspace(ctx);
    expect(workspace?.changes).toEqual([{ path: "other.mjs", status: "modified" }]);
    expect(workspace?.external).toEqual([{ path: "scratch.mjs", status: "added", reason: CONCURRENT_SESSION_AMBIGUOUS }]);
  });

  it("keeps a file written by a write tool a violation even if a bash call also touched it", async () => {
    const dir = await repo();
    const { ctx, toolCall, owned } = await auditContext(dir, FLAGGED);
    await toolCall("A1", "w1", "write", { path: "other.mjs" }, () => sh(dir, "echo one > other.mjs"));
    await toolCall("A1", "b1", "bash", { command: "echo two >> other.mjs" }, () => sh(dir, "echo two >> other.mjs"));
    await auditWorkspace(ctx, ["A1"], owned);
    expect(ctx.violations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect([...(ctx.externalChanges?.values() ?? [])]).toEqual([]);
  });

  it("is a violation for the same bash-window change when the run is not flagged", async () => {
    const dir = await repo();
    const { ctx, events, toolCall, owned } = await auditContext(dir);
    await toolCall("A1", "b1", "bash", { command: "echo x" }, () => sh(dir, "echo 'export const other = 9;' > other.mjs"));
    await auditWorkspace(ctx, ["A1"], owned);
    expect(ctx.violations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect([...(ctx.externalChanges?.values() ?? [])]).toEqual([]);
    expect(externalEvents(events)).toEqual([]);
  });

  it("does not apply to a change made while only edit/write tools ran", async () => {
    const dir = await repo();
    const { ctx, toolCall, owned } = await auditContext(dir, FLAGGED);
    // A write call to an owned file; another file changes in the same window with no bash in flight.
    await toolCall("A1", "w1", "write", { path: "core.mjs" }, () => sh(dir, "echo 'export const value = 1;' > core.mjs && echo elsewhere > other.mjs"));
    await auditWorkspace(ctx, ["A1"], owned);
    // Not a shell window: the conservative attribution is kept (the run's change, a violation).
    expect(ctx.violations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect([...(ctx.externalChanges?.values() ?? [])]).toEqual([]);
  });

  it("reports the file once across phases, and phase facts do not leak into the next audit", async () => {
    const dir = await repo();
    const { ctx, events, toolCall, owned } = await auditContext(dir, FLAGGED);
    await toolCall("A1", "b1", "bash", { command: "x" }, () => sh(dir, "echo one > other.mjs"));
    await auditWorkspace(ctx, ["A1"], owned);
    await toolCall("A1", "b2", "bash", { command: "x" }, () => sh(dir, "echo two > other.mjs"));
    await auditWorkspace(ctx, ["A1"], owned);
    await auditWorkspace(ctx, ["V1"], () => false);
    expect(ctx.violations).toEqual([]);
    expect(externalEvents(events)).toHaveLength(1);
    const workspace = await finalWorkspace(ctx);
    expect(workspace?.changes).toEqual([]);
    expect(workspace?.external).toEqual([{ path: "other.mjs", status: "modified", reason: CONCURRENT_SESSION_AMBIGUOUS }]);
  });

  it("does not apply to a read-only phase", async () => {
    const dir = await repo();
    const { ctx, toolCall } = await auditContext(dir, FLAGGED);
    await toolCall("A1", "b1", "bash", { command: "x" }, () => sh(dir, "echo one > other.mjs"));
    await auditWorkspace(ctx, ["A1"], () => false, { readOnly: true });
    expect(ctx.violations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect([...(ctx.externalChanges?.values() ?? [])]).toEqual([]);
  });
});

describe("externalChangesWarning", () => {
  it("keeps the one-line form without the concurrency reason, and adds a visible line with it", () => {
    expect(externalChangesWarning([{ path: "a.ts", status: "modified", reason: "committed outside this run" }]))
      .toBe("Warning: 1 file changed outside this run; not restored: a.ts");
    const text = externalChangesWarning([
      { path: "a.ts", status: "modified", reason: "committed outside this run" },
      { path: "b.ts", status: "added", reason: CONCURRENT_SESSION_AMBIGUOUS },
    ]);
    expect(text.split("\n")).toEqual([
      "Warning: 2 files changed outside this run; not restored: a.ts, b.ts",
      "Warning: 1 of them changed while a worker command ran and another pi session was active, so the writer is ambiguous (not counted as an ownership violation; review before keeping): b.ts",
    ]);
  });
});
