import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import type { ManagerEvent, ToolExecutionEvent } from "../../src/agent/agent-handle.js";
import { isWriteCapable, WorkspaceActivity } from "../../src/orchestration/run/activity.js";
import type { WorkspaceChange } from "../../src/orchestration/workspace.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

/** In-memory "workspace": snapshots are frozen copies of the file map, diffs compare them. */
function fakeWorkspace(cwd = "/repo") {
  const files = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  let counter = 0;
  const state = { clock: 0, snapshotCost: 0, failSnapshots: false, snapshots: 0, cancelled: false };
  const snapshot = async () => {
    state.snapshots++;
    state.clock += state.snapshotCost;
    if (state.failSnapshots) throw new Error("git add failed");
    const id = `tree-${++counter}`;
    trees.set(id, new Map(files));
    return id;
  };
  const diff = async (from: string, to: string): Promise<WorkspaceChange[]> => {
    const a = trees.get(from)!;
    const b = trees.get(to)!;
    const changes: WorkspaceChange[] = [];
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(path) === b.get(path)) continue;
      changes.push({ path, status: !a.has(path) ? "added" : !b.has(path) ? "deleted" : "modified" });
    }
    return changes;
  };
  const baseline = trees.set("tree-0", new Map(files)) && "tree-0";
  const activity = new WorkspaceActivity({
    cwd, tree: baseline, snapshot, diff, now: () => state.clock, startedAt: 0, cancelled: () => state.cancelled,
  });
  const start = (agent: string, id: string, toolName: string, args: unknown = {}) =>
    activity.record(agent, { phase: "start", toolCallId: id, toolName, args });
  const end = (agent: string, id: string, toolName: string, isError = false) =>
    activity.record(agent, { phase: "end", toolCallId: id, toolName, isError });
  /** One complete tool call: start event, guard, the tool's own writes, end event. */
  const call = async (agent: string, id: string, toolName: string, effect: () => void = () => {}, args: unknown = {}) => {
    start(agent, id, toolName, args);
    await activity.enter(agent, toolName);
    effect();
    end(agent, id, toolName);
  };
  return { files, state, activity, start, end, call };
}

describe("write-capable tools", () => {
  it("is everything outside the read-only set except orche's coordination tools", () => {
    for (const name of ["bash", "edit", "write", "ast_rewrite", "generate_image", "some_future_tool"]) expect(isWriteCapable(name)).toBe(true);
    for (const name of ["read", "grep", "find", "ls", "ast_search", "diagnostics", "report_result", "send_message"]) expect(isWriteCapable(name)).toBe(false);
  });
});

describe("workspace activity windows", () => {
  it("classifies changes by the window they happened in", async () => {
    const w = fakeWorkspace();
    w.files.set("external-before.txt", "x"); // quiet: before any tool
    await w.call("A1", "c1", "bash", () => w.files.set("by-tool.txt", "y"));
    await w.activity.drain(); // the queued active→quiet snapshot
    w.files.set("external-after.txt", "z"); // quiet again
    await w.activity.checkpoint();

    expect(w.activity.touchedOnlyQuiet("external-before.txt")).toBe(true);
    expect(w.activity.touchedOnlyQuiet("external-after.txt")).toBe(true);
    expect(w.activity.touchedActive("by-tool.txt")).toBe(true);
    expect(w.activity.touchedOnlyQuiet("by-tool.txt")).toBe(false);
    expect(w.activity.touchedActive("external-before.txt")).toBe(false);
    expect(w.activity.inFlight()).toEqual([]);
  });

  it("keeps a file touched in both a quiet and an active window attributable to the run", async () => {
    const w = fakeWorkspace();
    w.files.set("shared.txt", "external");
    await w.call("A1", "c1", "bash", () => w.files.set("shared.txt", "tool"));
    await w.activity.drain();
    await w.activity.checkpoint();
    expect(w.activity.touchedActive("shared.txt")).toBe(true);
    expect(w.activity.touchedOnlyQuiet("shared.txt")).toBe(false);
  });

  it("never snapshots for read-only tools, report_result or send_message", async () => {
    const w = fakeWorkspace();
    for (const [index, name] of ["read", "grep", "report_result", "send_message"].entries()) await w.call("A1", `c${index}`, name);
    await w.activity.drain();
    expect(w.state.snapshots).toBe(0);
    expect(w.activity.inFlight()).toEqual([]);
  });

  it("closes one active window per burst of overlapping tools of several workers", async () => {
    const w = fakeWorkspace();
    w.start("A1", "c1", "bash");
    w.start("A2", "c2", "write", { path: "b.txt" });
    await Promise.all([w.activity.enter("A1", "bash"), w.activity.enter("A2", "write")]);
    expect(w.state.snapshots).toBe(1); // one quiet→active snapshot for both
    expect(w.activity.inFlight()).toHaveLength(2);
    w.files.set("a.txt", "1");
    w.end("A1", "c1", "bash");
    await w.activity.drain();
    expect(w.state.snapshots).toBe(1); // A2 still running: the window stays open
    w.files.set("b.txt", "2");
    w.end("A2", "c2", "write");
    await w.activity.drain();
    expect(w.state.snapshots).toBe(2);
    expect(w.activity.touchedActive("a.txt")).toBe(true);
    expect(w.activity.touchedActive("b.txt")).toBe(true);
  });

  it("takes the quiet→active snapshot before the tool can run", async () => {
    const w = fakeWorkspace();
    w.files.set("external.txt", "x");
    w.start("A1", "c1", "bash");
    const entered = w.activity.enter("A1", "bash");
    // The external write precedes the tool; the tool's own write only happens after enter resolved.
    await entered;
    w.files.set("tool.txt", "y");
    w.end("A1", "c1", "bash");
    await w.activity.drain();
    expect(w.activity.touchedOnlyQuiet("external.txt")).toBe(true);
    expect(w.activity.touchedOnlyQuiet("tool.txt")).toBe(false);
    expect(w.activity.touchedActive("tool.txt")).toBe(true);
  });

  it("records files written by successful edit/write calls, relative to the cwd", async () => {
    const w = fakeWorkspace("/repo");
    await w.call("A1", "c1", "edit", () => w.files.set("src/a.ts", "1"), { path: "src/a.ts" });
    await w.call("A1", "c2", "write", () => w.files.set("src/b.ts", "1"), { path: "/repo/src/./b.ts" });
    w.start("A1", "c3", "edit", { path: "src/failed.ts" });
    await w.activity.enter("A1", "edit");
    w.end("A1", "c3", "edit", true);
    await w.call("A1", "c4", "write", () => {}, { path: "../outside.ts" });
    await w.call("A1", "c5", "bash", () => {}, { path: "src/bash-arg.ts" });
    await w.activity.drain();
    expect(w.activity.isWritten("src/a.ts")).toBe(true);
    expect(w.activity.isWritten("src/b.ts")).toBe(true);
    expect(w.activity.isWritten("src/failed.ts")).toBe(false);
    expect(w.activity.isWritten("../outside.ts")).toBe(false);
    expect(w.activity.isWritten("outside.ts")).toBe(false);
    expect(w.activity.isWritten("src/bash-arg.ts")).toBe(false);
  });

  it("does not open a window for a blocked call that never reached the guard's end", async () => {
    const w = fakeWorkspace();
    w.start("A1", "c1", "write", { path: "x.ts" }); // blocked by the ownership guard: no enter()
    w.end("A1", "c1", "write", true);
    await w.activity.drain();
    expect(w.state.snapshots).toBe(0);
    expect(w.activity.isWritten("x.ts")).toBe(false);
  });

  it("a settled session has nothing in flight and closes the burst", async () => {
    const w = fakeWorkspace();
    w.start("A1", "c1", "bash");
    await w.activity.enter("A1", "bash");
    w.files.set("late.txt", "x");
    w.activity.record("A1", { phase: "settled" }); // the end event was never seen
    await w.activity.drain();
    expect(w.activity.inFlight()).toEqual([]);
    expect(w.activity.touchedActive("late.txt")).toBe(true);
  });

  it("scopes sets to the run or to the current phase", async () => {
    const w = fakeWorkspace();
    w.files.set("phase1.txt", "x");
    await w.activity.checkpoint();
    w.activity.startPhase();
    w.files.set("phase2.txt", "x");
    await w.call("A1", "c1", "edit", () => w.files.set("a.ts", "1"), { path: "a.ts" });
    await w.activity.drain();
    await w.activity.checkpoint();
    expect(w.activity.touchedOnlyQuiet("phase1.txt")).toBe(true);
    expect(w.activity.touchedOnlyQuiet("phase1.txt", "phase")).toBe(false);
    expect(w.activity.touchedOnlyQuiet("phase2.txt", "phase")).toBe(true);
    expect(w.activity.isWritten("a.ts", "phase")).toBe(true);
    w.activity.startPhase();
    expect(w.activity.isWritten("a.ts", "phase")).toBe(false);
    expect(w.activity.isWritten("a.ts")).toBe(true);
  });

  it("marks changes of windows with a bash (non-edit/write) call in flight, never those of edit/write-only windows", async () => {
    const w = fakeWorkspace();
    w.files.set("quiet.txt", "x");
    await w.call("A1", "c1", "edit", () => { w.files.set("a.ts", "1"); w.files.set("edit-window-other.txt", "1"); }, { path: "a.ts" });
    await w.activity.drain();
    await w.call("A1", "c2", "bash", () => w.files.set("by-bash.txt", "1"));
    await w.activity.drain();
    w.files.set("quiet-after.txt", "x");
    await w.activity.checkpoint();
    expect(w.activity.touchedDuringShell("by-bash.txt")).toBe(true);
    expect(w.activity.touchedDuringShell("a.ts")).toBe(false);
    expect(w.activity.touchedDuringShell("edit-window-other.txt")).toBe(false);
    expect(w.activity.touchedActive("edit-window-other.txt")).toBe(true);
    expect(w.activity.touchedDuringShell("quiet.txt")).toBe(false);
    expect(w.activity.touchedDuringShell("quiet-after.txt")).toBe(false);
  });

  it("counts every non-edit/write write-capable tool as shell, and a bash joining an edit burst marks the whole burst", async () => {
    const w = fakeWorkspace();
    await w.call("A1", "c1", "ast_rewrite", () => w.files.set("rewritten.ts", "1"), { path: "src/" });
    await w.activity.drain();
    w.start("A1", "c2", "write", { path: "w.ts" });
    w.start("A2", "c3", "bash");
    await Promise.all([w.activity.enter("A1", "write"), w.activity.enter("A2", "bash")]);
    w.files.set("burst.txt", "1");
    w.end("A1", "c2", "write");
    w.end("A2", "c3", "bash");
    await w.activity.drain();
    await w.activity.checkpoint();
    expect(w.activity.touchedDuringShell("rewritten.ts")).toBe(true);
    expect(w.activity.touchedDuringShell("burst.txt")).toBe(true);
  });

  it("scopes the shell marks to the run or to the current phase", async () => {
    const w = fakeWorkspace();
    await w.call("A1", "c1", "bash", () => w.files.set("phase1.txt", "1"));
    await w.activity.drain();
    await w.activity.checkpoint();
    w.activity.startPhase();
    expect(w.activity.touchedDuringShell("phase1.txt", "phase")).toBe(false);
    expect(w.activity.touchedDuringShell("phase1.txt")).toBe(true);
  });

  it("merges windows as active once blocking snapshot time exceeds the cap", async () => {
    const w = fakeWorkspace();
    w.state.snapshotCost = 6000; // one boundary spends more than max(5s, 10% of the run)
    await w.call("A1", "c1", "bash");
    await w.activity.drain();
    const before = w.state.snapshots;
    w.files.set("external.txt", "x"); // a quiet change that would normally be classified external
    await w.call("A1", "c2", "bash", () => w.files.set("tool.txt", "y"));
    await w.activity.drain();
    expect(w.state.snapshots).toBe(before); // no boundary snapshots past the cap
    await w.activity.checkpoint();
    expect(w.activity.touchedOnlyQuiet("external.txt")).toBe(false);
    expect(w.activity.touchedActive("external.txt")).toBe(true); // ambiguous: stays the run's
    expect(w.activity.touchedActive("tool.txt")).toBe(true);
  });

  it("degrades to merged active windows when a boundary snapshot fails, without failing the tool", async () => {
    const w = fakeWorkspace();
    w.state.failSnapshots = true;
    w.files.set("external.txt", "x");
    await expect(w.call("A1", "c1", "bash", () => w.files.set("tool.txt", "y"))).resolves.toBeUndefined();
    await w.activity.drain();
    w.state.failSnapshots = false;
    await w.activity.checkpoint();
    expect(w.activity.touchedActive("external.txt")).toBe(true);
    expect(w.activity.touchedActive("tool.txt")).toBe(true);
    expect(w.activity.touchedOnlyQuiet("external.txt")).toBe(false);
  });

  it("takes no boundary snapshot after cancellation, but checkpoint still works", async () => {
    const w = fakeWorkspace();
    w.state.cancelled = true;
    await w.call("A1", "c1", "bash", () => w.files.set("tool.txt", "y"));
    await w.activity.drain();
    expect(w.state.snapshots).toBe(0);
    await w.activity.checkpoint();
    expect(w.activity.touchedActive("tool.txt")).toBe(true);
  });

  it("serialises all snapshot work and drain waits for queued jobs", async () => {
    const w = fakeWorkspace();
    await w.call("A1", "c1", "bash", () => w.files.set("a.txt", "1"));
    await w.call("A2", "c2", "bash", () => w.files.set("b.txt", "1")); // starts while A1's end-snapshot is queued
    await w.activity.drain();
    expect(w.activity.touchedActive("a.txt")).toBe(true);
    expect(w.activity.touchedActive("b.txt")).toBe(true);
    // The window tree always follows the latest snapshot: nothing is left half-closed.
    const tree = await w.activity.checkpoint();
    expect(w.activity.windowTree).toBe(tree);
    expect(w.state.snapshots).toBe(5); // A1: pre+end, A2: pre+end, checkpoint
  });
});

const managers: AgentManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.dispose(); });

/** A real AgentSession (faux model) running one custom tool, observed through onToolExecution. */
async function observedTool(observer: (event: ToolExecutionEvent) => void | Promise<void>, toolName = "work") {
  const entered = deferred();
  const release = deferred();
  const f = await fauxRuntime([
    reply([call(toolName, { path: "SECRET_ARG" })], { stopReason: "toolUse" }),
    reply([call("report_result", { kind: "explore", summary: "done" })], { stopReason: "toolUse" }),
  ]);
  const m = new AgentManager(f.runtime);
  managers.push(m);
  const events: ManagerEvent[] = [];
  m.subscribe(event => events.push(event));
  await m.spawn({
    id: "a", role: "test", route: f.route, modelRuntime: f.runtime, cwd: process.cwd(), instructions: "test", tools: [toolName],
    customTools: [{
      name: toolName, label: toolName, description: toolName, parameters: Type.Object({ path: Type.String() }),
      execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "ok" }], details: {} }; },
    }],
    onToolExecution: observer,
  });
  return { m, events, entered, release };
}

describe("AgentManager onToolExecution", () => {
  it("reports start (with args), end and settle, without leaking arguments into ManagerEvents", async () => {
    const seen: ToolExecutionEvent[] = [];
    const { m, events, entered, release } = await observedTool(event => { seen.push(event); });
    m.assign("a", "explore", "go");
    await entered.promise;
    expect(seen).toEqual([{ phase: "start", toolCallId: expect.any(String), toolName: "work", args: { path: "SECRET_ARG" } }]);
    release.resolve();
    expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    const phases = seen.map(event => event.phase);
    expect(phases.slice(0, 2)).toEqual(["start", "end"]);
    expect(seen[1]).toMatchObject({ phase: "end", toolName: "work", isError: false, toolCallId: (seen[0] as { toolCallId: string }).toolCallId });
    expect(phases.at(-1)).toBe("settled");
    // report_result is observed too: the tracker, not the manager, decides it is not write-capable.
    expect(seen.some(event => event.toolName === "report_result")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("SECRET_ARG");
  });

  it("still delivers the end of a tool that finishes after the manager was closed", async () => {
    const seen: ToolExecutionEvent[] = [];
    const { m, entered, release } = await observedTool(event => { seen.push(event); });
    m.assign("a", "explore", "go");
    await entered.promise;
    m.close("run over");
    release.resolve();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(seen.map(event => event.phase)).toContain("end");
  });

  it("swallows observer errors and rejections", async () => {
    const { m, entered, release } = await observedTool(event => {
      if (event.phase === "start") throw new Error("observer bug");
      return Promise.reject(new Error("async observer bug"));
    });
    m.assign("a", "explore", "go");
    await entered.promise;
    release.resolve();
    expect(await m.wait("a", 2000)).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { summary: "done" } } });
  });

  it("feeds a WorkspaceActivity from real session events", async () => {
    const w = fakeWorkspace();
    const { m, entered, release } = await observedTool(event => w.activity.record("a", event), "generate_image");
    m.assign("a", "explore", "go");
    await entered.promise;
    expect(w.activity.inFlight()).toEqual([{ agentId: "a", toolName: "generate_image" }]);
    release.resolve();
    await m.wait("a", 2000);
    expect(w.activity.inFlight()).toEqual([]);
  });
});
