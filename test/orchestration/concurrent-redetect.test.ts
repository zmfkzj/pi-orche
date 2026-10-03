import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { CONCURRENT_SESSION_AMBIGUOUS, runOrchestrated, type ConcurrentActivity, type RunOptions } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { auditWorkspace, finalWorkspace, openWorkspaceAudit } from "../../src/orchestration/run/audit.js";
import type { RunContext } from "../../src/orchestration/run/types.js";
import { describeProgress } from "../../src/extension/progress.js";
import { formatOutcome, OrcheController } from "../../src/extension/controller.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * Concurrent-session re-detection (`RunOptions.detectConcurrentActivity`). The detection made when a run starts is not the end of it:
 * at each workspace audit point the run asks the injected callback again, so a pi session that starts mid-run is taken into account.
 * From then on an ambiguous change (a file that changed while a worker bash call ran, outside the worker's ownership and not written
 * by an edit/write call) is external with the concurrency reason instead of an ownership violation, and the first time new sessions
 * show up one `concurrent_sessions_detected` event (the progress warning) is emitted.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sh = (cwd: string, script: string) => execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });
async function repoIn(parent: string): Promise<string> {
  const dir = join(parent, "repo");
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [path, content] of Object.entries({ "core.mjs": "export const value = 0;\n", "other.mjs": "export const other = 0;\n", "package.json": "{}\n" })) await writeFile(join(dir, path), content);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}
async function repo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "orche-redetect-"));
  dirs.push(parent);
  return repoIn(parent);
}

const ONE: ConcurrentActivity = { count: 1, detail: "other pi sessions: /elsewhere (last write 3s ago)" };
const TWO: ConcurrentActivity = { count: 2, detail: "other pi sessions: /elsewhere (last write 3s ago); /else (last write 9s ago)" };
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "set value", owner: "A1", files: ["core.mjs"], status: "pending" };
const implemented = () => tool("report_result", { kind: "implement", summary: "done", data: { status: "done" } });
const writeCore = () => tool("write", { path: "core.mjs", content: "export const value = 1;\n" });
const bashOther = () => tool("bash", { command: "echo 'export const other = 5;' > other.mjs" });
/** A scripted step that runs `effect` (something that happens in the world meanwhile), then answers with `next`. */
const meanwhile = (effect: () => void, next: FauxResponseStep): FauxResponseStep => (context, options, state, model) => {
  effect();
  return typeof next === "function" ? next(context, options, state, model) : next;
};
const ofType = <T extends RunEvent["type"]>(events: RunEvent[], type: T) => events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);

/** Explicitly planned change run; `steps` are A1's responses before it reports. */
function changeScript(steps: FauxResponseStep[]): FauxResponseStep[] {
  return [
    decision({ type: "classify", taskClass: "change", workerCount: 2, language: "en", reason: "explicit ownership" }),
    decision({ type: "assign", tasks: [task] }),
    ...steps,
    tool("report_result", { kind: "verify", summary: "checked", data: { passed: true } }),
    decision({ type: "complete", summary: "changed" }),
  ];
}
async function changeRun(dir: string, steps: FauxResponseStep[], options: Partial<RunOptions> = {}) {
  const events: RunEvent[] = [];
  const f = await fauxRuntime(changeScript(steps));
  const report = await runOrchestrated({
    problem: "Set value to 1.", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime,
    sink: event => events.push(event), ...options,
  });
  expect(f.faux.getPendingResponseCount()).toBe(0);
  return { report, events };
}

describe("a run re-detects other pi sessions at its audit points", () => {
  it("a session that appears after the start makes a later bash-window change external with the concurrency reason, and warns once", async () => {
    const dir = await repo();
    let appeared = false;
    const detect = vi.fn(async () => (appeared ? ONE : undefined));
    const { report, events } = await changeRun(dir, [writeCore(), meanwhile(() => { appeared = true; }, bashOther()), implemented()], { detectConcurrentActivity: detect });

    expect(report.status).toBe("done");
    expect(report.ownershipViolations).toEqual([]);
    expect(ofType(events, "ownership_violation")).toEqual([]);
    expect(report.workspace?.changes).toEqual([{ path: "core.mjs", status: "modified" }]);
    expect(report.workspace?.external).toEqual([{ path: "other.mjs", status: "modified", reason: CONCURRENT_SESSION_AMBIGUOUS }]);
    expect(CONCURRENT_SESSION_AMBIGUOUS).toBe("concurrent session active; ambiguous");
    // Asked at every audit point (the phase audits and the final one), nothing was known when the run started.
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(2);

    // One progress warning, in front of the external-change warning it explains.
    const warnings = ofType(events, "concurrent_sessions_detected");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ count: 1, detail: ONE.detail, phase: expect.any(String) });
    expect(describeProgress(warnings[0]!)).toMatch(/^⚠ other pi session activity detected during the run: 1 session active in this repository \(other pi sessions: \/elsewhere/);
    expect(events.indexOf(warnings[0]!)).toBeLessThan(events.findIndex(event => event.type === "workspace_external_change"));
    expect(report.summary).toContain("another pi session was active");
    expect((await readFile(join(dir, "other.mjs"), "utf8")).trim()).toBe("export const other = 5;");
  });

  it("without any session found the same change stays an ownership violation, and nothing is warned", async () => {
    const dir = await repo();
    const detect = vi.fn(async () => undefined);
    const { report, events } = await changeRun(dir, [writeCore(), bashOther(), implemented()], { detectConcurrentActivity: detect });
    expect(detect).toHaveBeenCalled();
    expect(report.status).toBe("failed");
    expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect(report.workspace?.external).toBeUndefined();
    expect(ofType(events, "concurrent_sessions_detected")).toEqual([]);
  });

  it("is fail-soft: a rejecting, throwing or nonsensical callback never reaches the run", async () => {
    const callbacks: Array<() => Promise<ConcurrentActivity | undefined>> = [
      async () => { throw new Error("detector exploded"); },
      () => { throw new Error("sync explosion"); },
      async () => ({ count: Number.NaN, detail: "" }),
      async () => ({ count: 0, detail: "" }),
      async () => "nope" as unknown as ConcurrentActivity,
    ];
    for (const detect of callbacks) {
      const dir = await repo();
      const { report, events } = await changeRun(dir, [writeCore(), bashOther(), implemented()], { detectConcurrentActivity: detect });
      expect(report.status).toBe("failed"); // the violation of an unflagged run, exactly as without a callback
      expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
      expect(ofType(events, "run_finished")).toHaveLength(1);
      expect(ofType(events, "concurrent_sessions_detected")).toEqual([]);
    }
  });

  it("does not repeat the start's warning: only a count above the one given at the start is new", async () => {
    const same = await changeRun(await repo(), [writeCore(), bashOther(), implemented()], { concurrentActivity: ONE, detectConcurrentActivity: async () => ONE });
    expect(same.report.status).toBe("done"); // flagged by the start detection alone
    expect(ofType(same.events, "concurrent_sessions_detected")).toEqual([]);

    const more = await changeRun(await repo(), [writeCore(), bashOther(), implemented()], { concurrentActivity: ONE, detectConcurrentActivity: async () => TWO });
    expect(ofType(more.events, "concurrent_sessions_detected")).toMatchObject([{ count: 2 }]);
  });

  it("keeps working without the callback: the start detection alone flags the run, as before", async () => {
    const { report, events } = await changeRun(await repo(), [writeCore(), bashOther(), implemented()], { concurrentActivity: ONE });
    expect(report.status).toBe("done");
    expect(report.workspace?.external).toEqual([{ path: "other.mjs", status: "modified", reason: CONCURRENT_SESSION_AMBIGUOUS }]);
    expect(ofType(events, "concurrent_sessions_detected")).toEqual([]);
  });
});

/** Minimal run context over a real temp repo: what auditWorkspace/finalWorkspace read and write. */
async function auditContext(dir: string, detect: () => Promise<ConcurrentActivity | undefined>) {
  const events: RunEvent[] = [];
  const ctx = {
    options: { cwd: dir, problem: "p", routes: { routes: {} }, sink: (event: RunEvent) => events.push(event), detectConcurrentActivity: detect },
    startedAt: Date.now(), cancelled: false, violations: [], reported: false,
    state: { phase: "BACKLOG", taskClass: "change", tasks: [{ id: "t", description: "d", owner: "A1", files: ["core.mjs"], status: "pending" }] },
  } as unknown as RunContext;
  await openWorkspaceAudit(ctx);
  expect(ctx.activity).toBeDefined();
  /** One complete worker bash call that writes `file`. */
  const bash = async (id: string, file: string, content: string) => {
    ctx.activity!.record("A1", { phase: "start", toolCallId: id, toolName: "bash", args: { command: "x" } });
    await ctx.activity!.enter("A1", "bash");
    sh(dir, `printf '%s\\n' '${content}' > ${file}`);
    ctx.activity!.record("A1", { phase: "end", toolCallId: id, toolName: "bash", isError: false });
  };
  return { ctx, events, bash, owned: (file: string) => file === "core.mjs" };
}

describe("re-detection across audits (auditWorkspace)", () => {
  it("applies from the audit that finds the sessions on; earlier audits are not rewritten; sticky once flagged; one warning per run", async () => {
    const dir = await repo();
    let answer: ConcurrentActivity | undefined;
    const { ctx, events, bash, owned } = await auditContext(dir, async () => answer);

    // 1. Nobody else is known: a bash write outside ownership is a violation.
    await bash("b1", "first.mjs", "export const first = 1;");
    await auditWorkspace(ctx, ["A1"], owned);
    expect(ctx.violations).toEqual([{ agentId: "A1", file: "first.mjs", via: "workspace", created: true }]);
    expect(ofType(events, "concurrent_sessions_detected")).toEqual([]);

    // 2. A session started meanwhile: the next audit finds it, and the same kind of change is external with the concurrency reason.
    answer = ONE;
    await bash("b2", "second.mjs", "export const second = 2;");
    await auditWorkspace(ctx, ["A1"], owned);
    expect([...ctx.externalChanges!.values()]).toEqual([{ path: "second.mjs", status: "added", reason: CONCURRENT_SESSION_AMBIGUOUS }]);
    expect(ctx.violations).toHaveLength(1); // the earlier one stays what it was
    expect(ofType(events, "concurrent_sessions_detected")).toMatchObject([{ count: 1, phase: "BACKLOG" }]);

    // 3. The session went quiet (the detection is empty again): the run stays flagged, and the warning is not repeated.
    answer = undefined;
    await bash("b3", "third.mjs", "export const third = 3;");
    await auditWorkspace(ctx, ["A1"], owned);
    expect([...ctx.externalChanges!.keys()]).toEqual(["second.mjs", "third.mjs"]);
    expect(ctx.violations).toHaveLength(1);

    // 4. More sessions: still one warning for the whole run.
    answer = { ...TWO, count: 3 };
    await bash("b4", "fourth.mjs", "export const fourth = 4;");
    await auditWorkspace(ctx, ["A1"], owned);
    expect([...ctx.externalChanges!.keys()]).toEqual(["second.mjs", "third.mjs", "fourth.mjs"]);
    expect(ofType(events, "concurrent_sessions_detected")).toHaveLength(1);
  });

  it("a read-only phase takes note of the sessions but still treats shell writes as violations", async () => {
    const dir = await repo();
    const { ctx, events, bash } = await auditContext(dir, async () => ONE);
    await bash("b1", "scratch.mjs", "export const s = 1;");
    await auditWorkspace(ctx, ["A1"], () => false, { readOnly: true });
    expect(ctx.violations).toEqual([{ agentId: "A1", file: "scratch.mjs", via: "workspace", created: true }]);
    expect(ofType(events, "concurrent_sessions_detected")).toHaveLength(1);
  });

  it("the final audit looks once more, so sessions that appeared at the very end are reported", async () => {
    const dir = await repo();
    let answer: ConcurrentActivity | undefined;
    const { ctx, events } = await auditContext(dir, async () => answer);
    answer = ONE;
    await finalWorkspace(ctx);
    expect(ofType(events, "concurrent_sessions_detected")).toMatchObject([{ count: 1 }]);
  });

  it("does not ask a cancelled run", async () => {
    const dir = await repo();
    const detect = vi.fn(async () => ONE);
    const { ctx, events } = await auditContext(dir, detect);
    ctx.signal = AbortSignal.abort(new Error("cancelled"));
    await finalWorkspace(ctx);
    expect(detect).not.toHaveBeenCalled();
    expect(ofType(events, "concurrent_sessions_detected")).toEqual([]);
  });
});

/**
 * End to end through the controller: the real detector over a real sessions directory, a run whose scripted worker plays "another pi
 * session starts" by writing a session file in the middle of the run.
 */
describe("a session file that appears after the run started (controller, real detector)", () => {
  async function fixture(controllerOptions: { concurrentRecheckMs?: number } = {}) {
    const root = await mkdtemp(join(tmpdir(), "orche-redetect-e2e-"));
    dirs.push(root);
    const cwd = await repoIn(root);
    const agentDir = join(root, "agent");
    const sessions = join(agentDir, "sessions", "--repo--");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, "2026-10-02T06-10-00-000Z_other-session.jsonl");
    const appear = () => writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "other-session", timestamp: "2026-10-02T06:10:00.000Z", cwd })}\n`);
    const f = await fauxRuntime(changeScript([writeCore(), meanwhile(appear, bashOther()), implemented()]));
    await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: f.route.model }, records: { enabled: false } }));
    const events: RunEvent[] = [];
    const controller = new OrcheController({
      agentDir, createRuntime: async () => f.runtime, ...controllerOptions,
      run: options => runOrchestrated({ ...options, sink: event => { events.push(event); options.sink?.(event); } }),
    });
    const updates: string[][] = [];
    const outcome = await controller.run({ request: "Set value to 1.", cwd, projectTrusted: false, onProgress: lines => updates.push([...lines]) });
    expect(f.faux.getPendingResponseCount()).toBe(0);
    return { outcome, events, updates, cwd };
  }

  it("classifies the later ambiguous change as external with the concurrency reason, and warns once", async () => {
    const { outcome, events, updates } = await fixture({ concurrentRecheckMs: 0 });
    expect(outcome.report.status).toBe("done");
    expect(outcome.report.ownershipViolations).toEqual([]);
    expect(outcome.report.workspace?.external).toEqual([{ path: "other.mjs", status: "modified", reason: CONCURRENT_SESSION_AMBIGUOUS }]);

    const warnings = ofType(events, "concurrent_sessions_detected");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.detail).toContain("other pi sessions:");
    // The warning is pinned in the progress (it stays while milestones scroll) and in the result.
    expect(outcome.details.progress[0]).toMatch(/^⚠ other pi session activity detected during the run: 1 session active in this repository/);
    expect(updates.filter(lines => lines[0]?.startsWith("⚠ other pi session activity")).length).toBeGreaterThan(0);
    expect(outcome.concurrentWarning).toMatch(/^⚠ 1 other pi session active in this repository/);
    expect(outcome.details.concurrentSessions).toMatchObject({ count: 1 });
    expect(formatOutcome(outcome).startsWith(`${outcome.concurrentWarning}\n\norche finished (`)).toBe(true);
  });

  it("answers re-checks from the last detection for 30 seconds by default, so a session that started a moment ago is not seen yet", async () => {
    const { outcome, events } = await fixture();
    expect(outcome.report.status).toBe("failed");
    expect(outcome.report.ownershipViolations).toEqual([{ agentId: "A1", file: "other.mjs", via: "workspace" }]);
    expect(ofType(events, "concurrent_sessions_detected")).toEqual([]);
    expect(outcome.concurrentWarning).toBeUndefined();
  });
});
