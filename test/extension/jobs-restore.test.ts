import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { TaskJobs, JOB_ENTRY_TYPE, TASK_RESULT_TYPE, type JobEntry } from "../../src/extension/jobs.js";
import { recoverOrphanRecords } from "../../src/extension/records.js";
import type { GoneWorker } from "../../src/extension/workers.js";
import { createHarness, tool, type Harness } from "./harness.js";

/**
 * Lifecycle across reloads and crashes (P1-3): a job that was running when its process died ends once as `interrupted` and is
 * announced once; worker and job ids are never reused; run.json records left at `running` by a dead process are closed.
 */
const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("TaskJobs.restore", () => {
  it("closes a job without an end entry once, keeps finished ones, and returns gone workers and used ids", () => {
    const persisted: JobEntry[] = [];
    const jobs = new TaskJobs({ pool: () => { throw new Error("unused"); }, persist: entry => persisted.push(entry), deliver: () => { throw new Error("no delivery on restore"); } });
    const entries: JobEntry[] = [
      { event: "start", job: "J1", role: "implement", worker: "W1", at: 1, request: "first", record: "/r/1", sessionFile: "/w/W1.jsonl" },
      { event: "end", job: "J1", worker: "W1", at: 2, status: "done", summary: "done: ok" },
      { event: "start", job: "J2", role: "answer", worker: "W2", at: 3, request: "second", record: "/r/2" },
    ];
    const gone: GoneWorker[] = [{ id: "W1", reason: "idle expiry after 30 min without an assignment", at: 2 }];
    const first = jobs.restore(entries, gone);
    expect(first.interrupted.map(job => job.id)).toEqual(["J2"]);
    expect(persisted).toMatchObject([{ event: "end", job: "J2", status: "interrupted" }]);
    expect(first.gone.map(worker => `${worker.id}:${worker.reason}`)).toEqual(["W1:idle expiry after 30 min without an assignment", "W2:the pi process that ran it ended without a clean shutdown (crash or kill)"]);
    expect(first.usedWorkerIds).toEqual(["W1", "W2"]);
    expect(jobs.get("J1")).toMatchObject({ status: "done" });
    // A second restore (the next reload) sees the persisted end: nothing is interrupted or announced twice.
    const second = jobs.restore([...entries, ...persisted], gone);
    expect(second.interrupted).toEqual([]);
    expect(jobs.get("J2")).toMatchObject({ status: "interrupted" });
    expect(persisted).toHaveLength(1);
  });
});

describe("recoverOrphanRecords", () => {
  const manifest = (start: string, owner?: number) => JSON.stringify({ version: 1, kind: "task", id: "x", status: "running", start, cwd: "/tmp", agents: [], files: { sessions: "sessions" }, ...(owner !== undefined ? { owner: { pid: owner } } : {}) });
  it("closes only records whose owner process is gone (or, without an owner, that went quiet for over an hour)", async () => {
    const root = await mkdtemp(join(tmpdir(), "orche-orphans-"));
    dirs.push(root);
    const parent = join(root, "S1");
    const make = async (name: string, content: string, mtime?: Date) => {
      const dir = join(parent, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "run.json"), content);
      if (mtime) await utimes(join(dir, "run.json"), mtime, mtime);
      return dir;
    };
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const dead = await make("2026-10-07T10-00-00-000Z_task-00000001", manifest("2026-10-07T10:00:00.000Z", 999_991));
    const alive = await make("2026-10-07T10-00-01-000Z_task-00000002", manifest("2026-10-07T10:00:01.000Z", 999_992));
    const legacy = await make("2026-10-07T09-00-00-000Z_task-00000003", manifest("2026-10-07T09:00:00.000Z"), new Date(now - 2 * 3600_000));
    const legacyRecent = await make("2026-10-07T11-50-00-000Z_task-00000004", manifest("2026-10-07T11:50:00.000Z"), new Date(now - 60_000));
    const mine = await make("2026-10-07T10-00-02-000Z_task-00000005", manifest("2026-10-07T10:00:02.000Z", process.pid));
    const later = await make("2026-10-07T12-00-05-000Z_task-00000006", manifest("2026-10-07T12:00:05.000Z", 999_991));
    const closed = await recoverOrphanRecords({ enabled: true, root, retentionDays: 30 }, { parentSessionId: "S1", now, isAlive: pid => pid === 999_992 });
    expect(closed.sort()).toEqual([dead, legacy].sort());
    for (const dir of [dead, legacy]) expect(JSON.parse(await readFile(join(dir, "run.json"), "utf8"))).toMatchObject({ status: "interrupted", end: "2026-10-07T12:00:00.000Z", failure: expect.stringContaining("interrupted") });
    for (const dir of [alive, legacyRecent, mine, later]) expect(JSON.parse(await readFile(join(dir, "run.json"), "utf8"))).toMatchObject({ status: "running" });
    expect(await recoverOrphanRecords({ enabled: false, reason: "off" }, { parentSessionId: "S1" })).toEqual([]);
  });
});

describe("session start after a crash", () => {
  it("announces an interrupted job once, continues its worker with a briefed successor, and never reuses ids", async () => {
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "explore", request: "look again", worker: "W4", wait: true }), reply("continued")],
      orcheSteps: [tool("report_result", { kind: "explore", summary: "Found it again" })],
      mode: "tui", mainMode: "single", single: { spawn: false },
    });
    open.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    // The branch of a session whose process died while J5 ran on W4.
    h.session.sessionManager.appendCustomEntry(JOB_ENTRY_TYPE, { event: "start", job: "J5", role: "explore", worker: "W4", at: Date.now() - 60_000, request: "look", sessionFile: "/nowhere/W4.jsonl" } satisfies JobEntry);
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" } as never);
    const ends = () => h.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === JOB_ENTRY_TYPE).map(entry => (entry as { data: JobEntry }).data).filter(entry => entry.event === "end");
    expect(ends()).toMatchObject([{ job: "J5", status: "interrupted" }]);
    expect(h.notifications.some(note => note.message.includes("J5 (W4 explore: look)") && note.message.includes("interrupted"))).toBe(true);
    // A second start (another reload) does not announce it again.
    await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" } as never);
    expect(ends()).toHaveLength(1);
    expect(h.notifications.filter(note => note.message.includes("J5 (W4")).length).toBe(1);
    // Naming the gone W4 continues with a NEW worker (W5, never W1) briefed from W4's transcript.
    await h.session.prompt("continue W4's work");
    const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "orche_task");
    expect(result).toMatchObject({ isError: false, details: { worker: "W5", continuedFrom: "W4" } });
    expect(JSON.stringify(result)).toContain("W4 was gone (the pi process that ran it ended without a clean shutdown");
    expect(h.session.messages.filter(message => message.role === "custom" && (message as { customType?: string }).customType === TASK_RESULT_TYPE)).toHaveLength(0);
  });
});
