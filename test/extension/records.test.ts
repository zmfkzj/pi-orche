import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundEvent, createRunRecord, defaultRecordsRoot, formatRecordList, isRecordsPath, listRecords, MAX_EVENT_LINE, MAX_EVENT_STRING, MAX_EVENTS_BYTES,
  parentDirName, pruneRecords, pruneRecordsOnce, resetPruneOnce, resolveRecords, workerSessionFile, type ResolvedRecords,
} from "../../src/extension/records.js";
import { DEFAULT_RECORDS } from "../../src/extension/config.js";
import { fauxAssistantMessage as reply, fauxToolCall as call, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import { fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
afterEach(async () => {
  resetPruneOnce();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
interface Layout { root: string; agentDir: string; cwd: string; resolved: Extract<ResolvedRecords, { enabled: true }> }
async function layout(settings: Partial<typeof DEFAULT_RECORDS> = {}): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "orche-records-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const resolved = resolveRecords({ agentDir, cwd, settings: { ...DEFAULT_RECORDS, ...settings } });
  if (!resolved.enabled) throw new Error(resolved.reason);
  return { root, agentDir, cwd, resolved };
}
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
const DAY = 86_400_000;
/** Make a file or directory tree look `ms` old (children first, so the directories' own times stick). */
async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  const info = await lstat(path);
  if (info.isDirectory()) for (const name of await readdir(path)) await age(join(path, name), ms);
  await utimes(path, when, when);
}
const exists = (path: string) => lstat(path).then(() => true, () => false);

describe("records root", () => {
  it("defaults to <agentDir>/orche/records and honors records.dir", async () => {
    const l = await layout();
    expect(l.resolved.root).toBe(join(l.agentDir, "orche", "records"));
    expect(defaultRecordsRoot(l.agentDir)).toBe(l.resolved.root);
    expect(l.resolved).toMatchObject({ enabled: true, retentionDays: 30 });
    const custom = resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, dir: join(l.root, "elsewhere"), maxBytes: 5000, retentionDays: 7 } });
    expect(custom).toEqual({ enabled: true, root: join(l.root, "elsewhere"), retentionDays: 7, maxBytes: 5000 });
    expect(resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, dir: "~/orche-records-test" } })).toMatchObject({ enabled: true, root: join(homedir(), "orche-records-test") });
    expect(resolveRecords({ agentDir: l.agentDir, cwd: l.cwd })).toMatchObject({ enabled: true, root: l.resolved.root });
  });

  it("is disabled by records.enabled: false", async () => {
    const l = await layout();
    const off = resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, enabled: false } });
    expect(off).toMatchObject({ enabled: false });
    expect(createRunRecord(off, { kind: "run", cwd: l.cwd })).toBeUndefined();
    expect(workerSessionFile(off, { workerId: "W1" })).toBeUndefined();
  });

  it("refuses a root inside the workspace (also through a symlink), around it, or too broad", async () => {
    const l = await layout();
    const inside = resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, dir: join(l.cwd, ".orche-records") } });
    expect(inside).toMatchObject({ enabled: false });
    expect(inside.enabled ? "" : inside.reason).toContain("inside the workspace");
    await symlink(l.cwd, join(l.root, "link-to-work"));
    expect(resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, dir: join(l.root, "link-to-work", "records") } })).toMatchObject({ enabled: false });
    // An agent dir inside the workspace puts the default root inside it as well.
    expect(resolveRecords({ agentDir: join(l.cwd, ".pi-agent"), cwd: l.cwd })).toMatchObject({ enabled: false });
    expect(resolveRecords({ agentDir: l.agentDir, cwd: join(l.root, "work"), settings: { ...DEFAULT_RECORDS, dir: l.root } })).toMatchObject({ enabled: false });
    expect(resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, dir: "/" } })).toMatchObject({ enabled: false });
    expect(resolveRecords({ agentDir: l.agentDir, cwd: l.cwd, settings: { ...DEFAULT_RECORDS, dir: homedir() } })).toMatchObject({ enabled: false });
  });

  it("never creates a record when the directory would land inside the workspace", async () => {
    const l = await layout();
    const forced: ResolvedRecords = { enabled: true, root: join(l.cwd, "records"), retentionDays: 30 };
    expect(createRunRecord(forced, { kind: "run", cwd: l.cwd })).toBeUndefined();
    expect(await readdir(l.cwd)).toEqual([]);
  });

  it("isRecordsPath", async () => {
    const l = await layout();
    expect(isRecordsPath(join(l.resolved.root, "x", "y.jsonl"), l.resolved.root)).toBe(true);
    expect(isRecordsPath(l.resolved.root, l.resolved.root)).toBe(true);
    expect(isRecordsPath(join(l.agentDir, "sessions", "a.jsonl"), l.resolved.root)).toBe(false);
    expect(isRecordsPath(`${l.resolved.root}-other/a`, l.resolved.root)).toBe(false);
  });
});

describe("record layout and run.json", () => {
  it("creates <root>/<parent>/<ISO timestamp>_<kind>-<id>/ with sessions/, events.jsonl and a running run.json; 0700 dirs and 0600 files", async () => {
    const l = await layout();
    const before = await mode(l.agentDir);
    const record = createRunRecord(l.resolved, {
      kind: "run", cwd: l.cwd, parentSession: { id: "parent-1", file: "/sessions/p.jsonl" }, request: "Fix the greeting", context: "Background text",
      manifest: { config: "user config /x", routes: { coordinator: { model: "p/m", thinking: "high" } } }, now: () => Date.parse("2026-10-02T06:10:00.123Z"),
    })!;
    expect(record).toBeDefined();
    expect(record.dir).toMatch(new RegExp(`^${l.resolved.root}/parent-1/2026-10-02T06-10-00-123Z_run-[0-9a-f]{8}$`));
    expect(await readdir(record.dir)).toEqual(["events.jsonl", "run.json", "sessions"]);
    const manifest = await json(join(record.dir, "run.json"));
    expect(manifest).toMatchObject({
      version: 1, kind: "run", status: "running", start: "2026-10-02T06:10:00.123Z", cwd: l.cwd, request: "Fix the greeting", context: "Background text",
      parentSession: { id: "parent-1", file: "/sessions/p.jsonl" }, config: "user config /x", routes: { coordinator: { model: "p/m", thinking: "high" } },
      agents: [], files: { events: "events.jsonl", sessions: "sessions" },
    });
    expect(manifest.id).toBe(record.dir.slice(-8));
    expect(manifest.end).toBeUndefined();
    for (const dir of [join(l.agentDir, "orche"), l.resolved.root, join(l.resolved.root, "parent-1"), record.dir, record.sessionsDir]) expect(await mode(dir), dir).toBe(0o700);
    for (const file of [record.runFile, record.eventsFile]) expect(await mode(file), file).toBe(0o600);
    // The pre-existing agent dir is not touched.
    expect(await mode(l.agentDir)).toBe(before);
  });

  it("uses no-session without a parent, sanitizes the parent id, and a task has no events file unless asked", async () => {
    const l = await layout();
    const a = createRunRecord(l.resolved, { kind: "task", cwd: l.cwd })!;
    expect(a.dir.startsWith(join(l.resolved.root, "no-session") + "/")).toBe(true);
    expect(a.dir).toMatch(/_task-[0-9a-f]{8}$/);
    expect(await readdir(a.dir)).toEqual(["run.json", "sessions"]);
    expect((await json(a.runFile)).files).toEqual({ sessions: "sessions" });
    const b = createRunRecord(l.resolved, { kind: "task", cwd: l.cwd, events: true })!;
    expect(await readdir(b.dir)).toContain("events.jsonl");
    expect(parentDirName("../../etc")).not.toContain("/");
    expect(parentDirName("../../etc")).not.toMatch(/^\./);
    expect(parentDirName("   ")).toBe("no-session");
    const evil = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "../../escape" } })!;
    expect(evil.dir.startsWith(l.resolved.root + "/")).toBe(true);
    expect(evil.dir.slice(l.resolved.root.length + 1).split("/")).toHaveLength(2);
  });

  it("finish writes the final run.json atomically: status, end, duration, summary; only the first call counts; no temp files stay", async () => {
    const l = await layout();
    let now = Date.parse("2026-10-02T06:00:00.000Z");
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, request: "r", now: () => now })!;
    record.update({ taskClass: "answer" });
    expect(await json(record.runFile)).toMatchObject({ status: "running", taskClass: "answer" });
    now += 4321;
    record.finish({ status: "done", summary: "All good", workspace: { changes: [{ path: "a.txt", status: "modified" }], external: [], violations: [] }, cleanup: { incomplete: false } });
    const done = await json(record.runFile);
    expect(done).toMatchObject({ status: "done", end: "2026-10-02T06:00:04.321Z", durationMs: 4321, summary: "All good", taskClass: "answer", cleanup: { incomplete: false } });
    expect(done.workspace.changes).toEqual([{ path: "a.txt", status: "modified" }]);
    record.finish({ status: "failed", failure: "late" });
    record.update({ summary: "ignored" });
    expect(await json(record.runFile)).toMatchObject({ status: "done", summary: "All good" });
    expect((await readdir(record.dir)).filter(name => name.includes(".tmp"))).toEqual([]);
    expect(await mode(record.runFile)).toBe(0o600);
  });

  it("final run.json for failure and cancellation", async () => {
    const l = await layout();
    const failed = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    failed.finish({ status: "failed", failure: "boom" });
    expect(await json(failed.runFile)).toMatchObject({ status: "failed", failure: "boom" });
    const cancelled = createRunRecord(l.resolved, { kind: "task", cwd: l.cwd })!;
    cancelled.finish({ status: "cancelled", summary: "cancelled by user" });
    expect(await json(cancelled.runFile)).toMatchObject({ status: "cancelled", summary: "cancelled by user" });
  });

  it("the records hook persists sessions under sessions/, deduplicates names and collects agent entries into run.json", async () => {
    const l = await layout();
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    const hook = record.records;
    expect(hook.sessionTarget!({ id: "coordinator", role: "coordinator", kind: "coordinator" })).toEqual({ sessionFile: join(record.sessionsDir, "coordinator.jsonl") });
    expect(hook.sessionTarget!({ id: "A1", role: "implementer", kind: "worker" })).toEqual({ sessionFile: join(record.sessionsDir, "A1.jsonl") });
    expect(hook.sessionTarget!({ id: "A1", role: "implementer", kind: "worker" })).toEqual({ sessionFile: join(record.sessionsDir, "A1-2.jsonl") });
    expect(hook.sessionTarget!({ id: "advisor:sec#1", role: "advisor", kind: "advisor" })).toEqual({ sessionFile: join(record.sessionsDir, "advisor-sec-1.jsonl") });
    const entry = { id: "A1", role: "implementer", kind: "worker" as const, model: "p/m", requests: 3, models: { "p/m": 3 }, durationMs: 12, startedAt: 1, status: "completed", sessionFile: join(record.sessionsDir, "A1.jsonl") };
    hook.onAgent!(entry);
    hook.onAgent!({ ...entry, requests: 4 });
    hook.onAgent!({ ...entry, id: "coordinator", role: "coordinator", kind: "coordinator" });
    const manifest = await json(record.runFile);
    expect(manifest.agents.map((agent: { id: string }) => agent.id)).toEqual(["A1", "coordinator"]);
    expect(manifest.agents[0]).toMatchObject({ requests: 4, sessionFile: join(record.sessionsDir, "A1.jsonl") });
  });

  it("request and context are kept as given up to a large bound", async () => {
    const l = await layout();
    const long = "x".repeat(1_500_000);
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, request: "Ünïcode 요청\nsecond line", context: long })!;
    const manifest = await json(record.runFile);
    expect(manifest.request).toBe("Ünïcode 요청\nsecond line");
    expect(manifest.context.length).toBeLessThan(long.length);
    expect(manifest.context).toContain("…[+500000 chars]");
  });
});

describe("events.jsonl", () => {
  it("appends one JSON per line in order and truncates oversized fields", async () => {
    const l = await layout();
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    record.appendEvent({ type: "run_started", timestamp: 1, problem: "short" });
    record.appendEvent({ type: "assignment_outcome", timestamp: 2, outcome: { summary: "s".repeat(10_000), items: Array.from({ length: 80 }, (_, index) => index) } });
    record.appendEvent({ type: "run_finished", timestamp: 3, status: "done", summary: "ok" });
    const lines = (await readFile(record.eventsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
    expect(lines.map(line => line.type)).toEqual(["run_started", "assignment_outcome", "run_finished"]);
    expect(lines[0]).toEqual({ type: "run_started", timestamp: 1, problem: "short" });
    const summary: string = lines[1]!.outcome.summary;
    expect(summary.startsWith("s".repeat(MAX_EVENT_STRING))).toBe(true);
    expect(summary).toContain("…[+8000 chars]");
    expect(lines[1]!.outcome.items).toHaveLength(51);
    expect(lines[1]!.outcome.items.at(-1)).toBe("…[+30 items]");
    expect(await mode(record.eventsFile)).toBe(0o600);
  });

  it("an event whose bounded form is still too large becomes a stub, and circular or exotic values never throw", async () => {
    const l = await layout();
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    const wide: Record<string, unknown> = { type: "wide", timestamp: 9 };
    for (let index = 0; index < 50; index++) wide[`k${index}`] = "y".repeat(MAX_EVENT_STRING);
    record.appendEvent(wide);
    const circular: Record<string, unknown> = { type: "circular", timestamp: 10 };
    circular.self = circular;
    record.appendEvent(circular);
    record.appendEvent({ type: "exotic", timestamp: 11, big: 10n, fn: () => 1, undef: undefined, error: new Error("bad") });
    record.appendEvent(undefined);
    const lines = (await readFile(record.eventsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
    expect(lines[0]).toMatchObject({ type: "wide", timestamp: 9, truncated: true });
    expect(Math.max(...(await readFile(record.eventsFile, "utf8")).split("\n").map(line => line.length))).toBeLessThanOrEqual(MAX_EVENT_LINE);
    expect(lines[1]).toMatchObject({ type: "circular" });
    expect(lines[2]).toMatchObject({ type: "exotic", big: "10", error: { name: "Error", message: "bad" } });
    expect(lines[2]).not.toHaveProperty("fn");
    expect(record.errors).toEqual([]);
  });

  it("stops growing at the byte cap with one marker line", async () => {
    const l = await layout();
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    const event = { type: "worker_activity", timestamp: 1, a: "a".repeat(1900), b: "b".repeat(1900), c: "c".repeat(1900), d: "d".repeat(1900), e: "e".repeat(1900), f: "f".repeat(1900), g: "g".repeat(1900) };
    const per = JSON.stringify(boundEvent(event)).length + 1;
    expect(per).toBeLessThan(MAX_EVENT_LINE);
    const count = Math.ceil(MAX_EVENTS_BYTES / per) + 5;
    for (let index = 0; index < count; index++) record.appendEvent(event);
    const size = (await stat(record.eventsFile)).size;
    expect(size).toBeLessThanOrEqual(MAX_EVENTS_BYTES + 400);
    const text = await readFile(record.eventsFile, "utf8");
    expect(text.trim().split("\n").at(-1)).toContain("events_truncated");
    expect(text.match(/events_truncated/g)).toHaveLength(1);
  });
});

describe("fail-soft", () => {
  it("an unusable root means no record, never a throw", async () => {
    const l = await layout();
    await writeFile(join(l.root, "blocker"), "a file, not a directory");
    const broken: ResolvedRecords = { enabled: true, root: join(l.root, "blocker", "records"), retentionDays: 30 };
    expect(createRunRecord(broken, { kind: "run", cwd: l.cwd })).toBeUndefined();
    await expect(pruneRecords(broken)).resolves.toBeUndefined();
    await expect(listRecords(broken)).resolves.toEqual([]);
  });

  it("writes after the directory vanished are swallowed and remembered", async () => {
    const l = await layout();
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    await rm(record.dir, { recursive: true, force: true });
    expect(() => {
      record.appendEvent({ type: "x", timestamp: 1 });
      record.addAgent({ id: "A1", role: "r", kind: "worker", model: "m", requests: 0, models: {}, durationMs: 0, startedAt: 0, status: "idle" });
      record.update({ summary: "s" });
      record.finish({ status: "failed", failure: "f" });
    }).not.toThrow();
    expect(record.errors.length).toBeGreaterThan(0);
    expect(record.errors.length).toBeLessThanOrEqual(5);
  });
});

describe("workers/ session files", () => {
  it("<root>/<parent>/workers/<workerId>-<spawn timestamp>.jsonl, a new spawn getting a new name", async () => {
    const l = await layout();
    const spawned = Date.parse("2026-10-02T06:10:00.000Z");
    const file = workerSessionFile(l.resolved, { parentSessionId: "parent-1", workerId: "W1", spawnedAt: spawned });
    expect(file).toBe(join(l.resolved.root, "parent-1", "workers", "W1-2026-10-02T06-10-00-000Z.jsonl"));
    expect(workerSessionFile(l.resolved, { workerId: "W1", spawnedAt: spawned })).toBe(join(l.resolved.root, "no-session", "workers", "W1-2026-10-02T06-10-00-000Z.jsonl"));
    expect(workerSessionFile(l.resolved, { parentSessionId: "parent-1", workerId: "W1", spawnedAt: spawned + 1 })).not.toBe(file);
    expect(workerSessionFile(l.resolved, { parentSessionId: "p", workerId: "../../W1", spawnedAt: spawned })!.startsWith(join(l.resolved.root, "p", "workers") + "/")).toBe(true);
  });
});

describe("listRecords / formatRecordList", () => {
  it("lists the newest records of a session first, with time, kind, status and the head of the summary", async () => {
    const l = await layout();
    const make = (parent: string, kind: "run" | "task", at: string, request: string) => createRunRecord(l.resolved, { kind, cwd: l.cwd, parentSession: { id: parent }, request, now: () => Date.parse(at) })!;
    const first = make("p1", "run", "2026-10-01T10:00:00.000Z", "first request");
    first.finish({ status: "done", summary: "Fixed the thing.\nSecond line is not shown" });
    const second = make("p1", "task", "2026-10-02T10:00:00.000Z", "second request");
    second.finish({ status: "failed", failure: "x".repeat(300) });
    const running = make("p1", "run", "2026-10-03T10:00:00.000Z", "third request still running");
    make("other", "run", "2026-10-04T10:00:00.000Z", "another session");
    const noSession = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, request: "no parent" })!;
    const list = await listRecords(l.resolved, { parentSessionId: "p1" });
    expect(list.map(item => item.path)).toEqual([running.dir, second.dir, first.dir]);
    expect(list[0]).toMatchObject({ kind: "run", status: "running", summary: "third request still running", time: "2026-10-03T10:00:00.000Z" });
    expect(list[1]).toMatchObject({ kind: "task", status: "failed" });
    expect(list[1]!.summary.length).toBe(120);
    expect(list[2]).toMatchObject({ kind: "run", status: "done", summary: "Fixed the thing." });
    expect((await listRecords(l.resolved, { parentSessionId: "p1", limit: 2 })).map(item => item.path)).toEqual([running.dir, second.dir]);
    expect((await listRecords(l.resolved)).map(item => item.path)).toEqual([noSession.dir]);
    const text = formatRecordList(list);
    expect(text).toContain("2026-10-03 10:00:00Z  run  running  third request still running");
    expect(text).toContain(`\n  ${second.dir}`);
    expect(formatRecordList([])).toContain("No orche records");
  });

  it("a record without a readable run.json is still listed as unknown, other names are ignored", async () => {
    const l = await layout();
    const parent = join(l.resolved.root, "p1");
    const broken = join(parent, "2026-10-02T10-00-00-000Z_run-deadbeef");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "run.json"), "{ not json");
    await mkdir(join(parent, "random-directory"), { recursive: true });
    await writeFile(join(parent, "notes.txt"), "x");
    expect(await listRecords(l.resolved, { parentSessionId: "p1" })).toEqual([{ time: "2026-10-02T10:00:00.000Z", kind: "run", status: "unknown", summary: "", path: broken }]);
    expect(await listRecords(l.resolved, { parentSessionId: "nobody" })).toEqual([]);
  });
});

describe("retention", () => {
  async function populate(l: Layout) {
    const old = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "p1" }, request: "old", now: () => Date.now() - 40 * DAY })!;
    old.appendEvent({ type: "x", timestamp: 1 });
    await writeFile(join(old.sessionsDir, "A1.jsonl"), "{}\n");
    old.finish({ status: "done" });
    const oldTask = createRunRecord(l.resolved, { kind: "task", cwd: l.cwd, parentSession: { id: "p1" }, now: () => Date.now() - 35 * DAY })!;
    const recent = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "p1" }, request: "recent" })!;
    const mid = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "p1" }, request: "ten days", now: () => Date.now() - 10 * DAY })!;
    const oldWorker = workerSessionFile(l.resolved, { parentSessionId: "p1", workerId: "W1", spawnedAt: Date.now() - 50 * DAY })!;
    const recentWorker = workerSessionFile(l.resolved, { parentSessionId: "p1", workerId: "W2" })!;
    await mkdir(join(l.resolved.root, "p1", "workers"), { recursive: true });
    await writeFile(oldWorker, "{}\n");
    await writeFile(recentWorker, "{}\n");
    const loneOld = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "lonely" }, now: () => Date.now() - 90 * DAY })!;
    for (const path of [old.dir, oldTask.dir, oldWorker, loneOld.dir]) await age(path, 60 * DAY);
    await age(mid.dir, 10 * DAY);
    return { old, oldTask, recent, mid, oldWorker, recentWorker, loneOld };
  }

  it("removes only record directories and worker files older than retentionDays under the root", async () => {
    const l = await layout();
    const made = await populate(l);
    // Things the pass must never touch: unrelated names inside the root, and everything outside it.
    await mkdir(join(l.resolved.root, "p1", "keep-me"), { recursive: true });
    await writeFile(join(l.resolved.root, "p1", "keep-me", "f.txt"), "x");
    await writeFile(join(l.resolved.root, "p1", "2026-10-02T10-00-00-000Z_run-deadbeef.jsonl"), "x");
    await writeFile(join(l.resolved.root, "root-level.txt"), "x");
    const sibling = join(l.agentDir, "orche", "records-sibling", "p1", "2026-01-01T00-00-00-000Z_run-cafebabe");
    await mkdir(sibling, { recursive: true });
    const outsideFile = join(l.agentDir, "sessions-old.jsonl");
    await writeFile(outsideFile, "{}\n");
    await age(join(l.resolved.root, "p1", "keep-me"), 90 * DAY);
    await age(sibling, 90 * DAY);
    await age(outsideFile, 90 * DAY);
    // A symlink inside the root named like a record, pointing at an old directory outside the root: neither followed nor removed.
    const target = join(l.root, "outside-target");
    await mkdir(join(target, "sessions"), { recursive: true });
    await writeFile(join(target, "run.json"), "{}");
    await age(target, 90 * DAY);
    await symlink(target, join(l.resolved.root, "p1", "2026-01-01T00-00-00-000Z_run-abcdef01"));

    const result = await pruneRecords(l.resolved);
    expect(result).toMatchObject({ removed: 4, truncated: false });
    expect(result!.freedBytes).toBeGreaterThan(0);
    for (const gone of [made.old.dir, made.oldTask.dir, made.oldWorker, made.loneOld.dir]) expect(await exists(gone), gone).toBe(false);
    for (const kept of [made.recent.dir, made.mid.dir, made.recentWorker, join(l.resolved.root, "p1", "keep-me", "f.txt"), join(l.resolved.root, "p1", "2026-10-02T10-00-00-000Z_run-deadbeef.jsonl"), join(l.resolved.root, "root-level.txt"), sibling, outsideFile, target, join(target, "run.json")]) {
      expect(await exists(kept), kept).toBe(true);
    }
    expect((await lstat(join(l.resolved.root, "p1", "2026-01-01T00-00-00-000Z_run-abcdef01"))).isSymbolicLink()).toBe(true);
    // The session left without records disappears with its directory; one that still has records stays.
    expect(await exists(join(l.resolved.root, "lonely"))).toBe(false);
    expect(await exists(join(l.resolved.root, "p1"))).toBe(true);
  });

  it("honors a shorter retention and keeps anything modified within the last hour", async () => {
    const l = await layout({ retentionDays: 5 });
    const made = await populate(l);
    const result = await pruneRecords(l.resolved);
    expect(result!.removed).toBe(5);
    expect(await exists(made.mid.dir)).toBe(false);
    expect(await exists(made.recent.dir)).toBe(true);
    const tiny = await layout({ retentionDays: 0.0001 });
    const fresh = createRunRecord(tiny.resolved, { kind: "run", cwd: tiny.cwd })!;
    expect(await pruneRecords(tiny.resolved)).toMatchObject({ removed: 0 });
    expect(await exists(fresh.dir)).toBe(true);
  });

  it("maxBytes then removes the oldest remaining records until the root fits, sparing the active ones", async () => {
    // Each record is about 1.3 KB (a 1000 byte transcript plus run.json): the cap leaves room for two of the five.
    const l = await layout({ maxBytes: 3200 });
    const dirs: string[] = [];
    for (let index = 0; index < 4; index++) {
      const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "p" }, now: () => Date.now() - (10 - index) * 3_600_000 })!;
      await writeFile(join(record.sessionsDir, "A1.jsonl"), "z".repeat(1000));
      await age(record.dir, (10 - index) * 3_600_000);
      dirs.push(record.dir);
    }
    const active = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "p" } })!;
    await writeFile(join(active.sessionsDir, "A1.jsonl"), "z".repeat(1000));
    const result = await pruneRecords(l.resolved);
    expect(result!.removed).toBe(3);
    expect(await exists(dirs[0]!)).toBe(false);
    expect(await exists(dirs[1]!)).toBe(false);
    expect(await exists(dirs[2]!)).toBe(false);
    expect(await exists(active.dir)).toBe(true);
    expect(await exists(dirs[3]!)).toBe(true);
    // No maxBytes: nothing of this age is touched.
    const plain = await layout();
    const kept = createRunRecord(plain.resolved, { kind: "run", cwd: plain.cwd, now: () => Date.now() - 10 * 3_600_000 })!;
    await age(kept.dir, 10 * 3_600_000);
    expect(await pruneRecords(plain.resolved)).toMatchObject({ removed: 0 });
  });

  it("is bounded: a deletion cap stops the pass early and says so", async () => {
    const l = await layout();
    await populate(l);
    const result = await pruneRecords(l.resolved, { maxDeletions: 1 });
    expect(result).toMatchObject({ removed: 1, truncated: true });
    const scanned = await pruneRecords(l.resolved, { maxEntries: 1 });
    expect(scanned!.truncated).toBe(true);
    expect(scanned!.scanned).toBe(1);
  });

  it("a missing root is not an error", async () => {
    const l = await layout();
    expect(await pruneRecords(l.resolved)).toBeUndefined();
    expect(await readdir(l.agentDir)).toEqual([]);
  });

  it("pruneRecordsOnce runs once per root and process", async () => {
    const l = await layout();
    const made = await populate(l);
    const first = await pruneRecordsOnce(l.resolved);
    expect(first).toMatchObject({ removed: 4 });
    const again = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, now: () => Date.now() - 80 * DAY })!;
    await age(again.dir, 80 * DAY);
    expect(await pruneRecordsOnce(l.resolved)).toBe(first);
    expect(await exists(again.dir)).toBe(true);
    resetPruneOnce();
    expect(await pruneRecordsOnce(l.resolved)).toMatchObject({ removed: 1 });
    expect(await exists(again.dir)).toBe(false);
    expect(await exists(made.recent.dir)).toBe(true);
    expect(await pruneRecordsOnce({ enabled: false, reason: "off" })).toBeUndefined();
  });

  it("a new record is private next to a group-readable one", async () => {
    const l = await layout();
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    await chmod(record.dir, 0o755);
    const next = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd })!;
    expect(await mode(next.dir)).toBe(0o700);
    expect(await mode(next.sessionsDir)).toBe(0o700);
  });
});

describe("a record wired to a real run (what the extension does)", () => {
  const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
  const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
  const classify = decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "read-only" });
  const answer = tool("report_result", { kind: "answer", summary: "The value is 0.", data: { evidence: ["core.mjs"] } });

  for (const outcome of ["done", "failed"] as const) it(`${outcome}: run.json start+final, events.jsonl, one 0600 session per agent, everything outside the workspace`, async () => {
    const l = await layout();
    const f = await fauxRuntime([classify, answer, decision(outcome === "done" ? { type: "answer_from_worker", sourceAgentId: "A1", summary: "explained" } : { type: "fail", reason: "gave up" })]);
    const record = createRunRecord(l.resolved, { kind: "run", cwd: l.cwd, parentSession: { id: "parent-9" }, request: "what is the value?" })!;
    expect(await json(record.runFile)).toMatchObject({ status: "running", agents: [] });
    const report = await runOrchestrated({
      problem: "what is the value?", cwd: l.cwd, routes: { routes: {}, default: { model: f.route.model, thinking: "low" } }, modelRuntime: f.runtime,
      limits: { overallMs: 10_000, decisionMs: 2000, assignmentMs: 2000 }, sink: event => record.appendEvent(event), records: record.records,
    });
    record.finish({ status: report.status, summary: report.summary, taskClass: report.taskClass, cleanup: report.cleanup });
    expect(report.status).toBe(outcome);
    const manifest = await json(record.runFile);
    expect(manifest).toMatchObject({ kind: "run", status: outcome, taskClass: "answer", cleanup: { incomplete: false } });
    expect(manifest.durationMs).toBeGreaterThanOrEqual(0);
    expect(manifest.agents.map((agent: { id: string }) => agent.id).sort()).toEqual(["A1", "coordinator"]);
    for (const agent of manifest.agents as Array<{ id: string; sessionFile: string; model: string; requests: number }>) {
      expect(agent.sessionFile).toBe(join(record.sessionsDir, `${agent.id}.jsonl`));
      expect(agent.model).toBe(f.route.model);
      expect(agent.requests).toBeGreaterThan(0);
      const lines = (await readFile(agent.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
      expect(lines[0]).toMatchObject({ type: "session", cwd: l.cwd });
      expect(lines.filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(agent.requests);
      expect(await mode(agent.sessionFile), agent.id).toBe(0o600);
    }
    const events = (await readFile(record.eventsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string });
    expect(events[0]!.type).toBe("run_started");
    expect(events.at(-1)!.type).toBe("run_finished");
    expect(events.some(event => event.type === "usage")).toBe(true);
    for (const dir of [l.resolved.root, join(l.resolved.root, "parent-9"), record.dir, record.sessionsDir]) expect(await mode(dir), dir).toBe(0o700);
    expect(await readdir(l.cwd)).toEqual([]);
    expect(manifest.agents.find((agent: { id: string }) => agent.id === "coordinator").status).toBe(outcome === "done" ? "completed" : "failed");
  });
});
