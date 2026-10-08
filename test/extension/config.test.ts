import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONCURRENT_SESSIONS, DEFAULT_RECORDS, discoverOrcheConfig, loadOrcheConfigFile, MAX_RECORDS_RETENTION_DAYS, NoRouteError, parseConcurrentSessionsConfig, parseRecordsConfig,
  resolveConcurrentSessions, resolveRecordsSettings,
} from "../../src/extension/config.js";
import { resolveRunLimits } from "../../src/orchestration/limits.js";
import { parseRouteConfig } from "../../src/orchestration/routing.js";
import { DEFAULT_SINGLE, DEFAULT_TASK_CONTEXT, parseSingleConfig, parseTaskContextConfig, parseWriteRootsConfig, resolveWriteRoots } from "../../src/extension/config.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function layout(files: { project?: unknown; user?: unknown }) {
  const root = await mkdtemp(join(tmpdir(), "orche-cfg-"));
  roots.push(root);
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  if (files.project !== undefined) await writeFile(join(cwd, ".pi", "orche.config.json"), typeof files.project === "string" ? files.project : JSON.stringify(files.project));
  if (files.user !== undefined) await writeFile(join(agentDir, "orche.config.json"), JSON.stringify(files.user));
  return { cwd, agentDir };
}
const cfg = (model: string) => ({ routes: {}, default: { model } });
const session = { model: "openai/session-model", thinking: "high" as const };

describe("orche config discovery", () => {
  it("preserves explicit limits without prefilled defaults and surfaces bad keys", async () => {
    const files = await layout({ project: { ...cfg("p/project"), limits: { overallMs: 3600000 } }, user: { ...cfg("u/user"), limits: { decisionMs: 45000 } } });
    expect((await discoverOrcheConfig({ ...files, projectTrusted: true, session })).routes.limits).toEqual({ overallMs: 3600000 });
    expect((await discoverOrcheConfig({ ...files, projectTrusted: false, session })).routes.limits).toEqual({ decisionMs: 45000 });
    const broken = await layout({ user: { ...cfg("u/user"), limits: { overallMs: -1 } } });
    await expect(discoverOrcheConfig({ ...broken, projectTrusted: true, session })).rejects.toThrow("config.limits.overallMs");
  });

  it("(i) passes the timeout-extension keys through discovery and validates them like the other limits", async () => {
    const limits = { overallMs: 600000, extensionMs: 300000, maxExtensions: 2, activityWindowMs: 60000 };
    const files = await layout({ user: { ...cfg("u/user"), limits } });
    const found = await discoverOrcheConfig({ ...files, projectTrusted: false, session });
    expect(found.routes.limits).toEqual(limits); // explicit values only: nothing is prefilled
    expect(resolveRunLimits(found.routes.limits)).toMatchObject({ ...limits, explorationMs: 200000, assignmentMs: 600000, decisionMs: 300000 });
    // Absent keys resolve to the defaults (30 minutes, 10 extensions of 30 minutes, a 2 minute activity window); 0 turns extension off.
    expect(resolveRunLimits(undefined)).toMatchObject({ overallMs: 1_800_000, assignmentMs: 1_800_000, extensionMs: 1_800_000, maxExtensions: 10, activityWindowMs: 120_000 });
    const off = await layout({ user: { ...cfg("u/user"), limits: { maxExtensions: 0 } } });
    expect(resolveRunLimits((await discoverOrcheConfig({ ...off, projectTrusted: false, session })).routes.limits).maxExtensions).toBe(0);

    const invalid: [Record<string, unknown>, string][] = [
      [{ maxExtensions: 1.5 }, "config.limits.maxExtensions: expected a non-negative integer"],
      [{ maxExtensions: -1 }, "config.limits.maxExtensions: expected a finite non-negative number"],
      [{ maxExtensions: "3" }, "config.limits.maxExtensions"],
      [{ extensionMs: -1 }, "config.limits.extensionMs: expected a finite non-negative number"],
      [{ extensionMs: null }, "config.limits.extensionMs"],
      [{ activityWindowMs: "2m" }, "config.limits.activityWindowMs"],
      [{ activityWindowMs: Number.POSITIVE_INFINITY }, "config.limits.activityWindowMs"],
      [{ maxExtension: 3 }, "config.limits.maxExtension: unknown limit"],
    ];
    for (const [bad, message] of invalid) {
      const broken = await layout({ user: { ...cfg("u/user"), limits: bad } });
      await expect(discoverOrcheConfig({ ...broken, projectTrusted: false, session }), JSON.stringify(bad)).rejects.toThrow(message);
    }
  });

  it("prefers the trusted project file, then the user file, then the session model", async () => {
    const both = await layout({ project: cfg("p/project"), user: cfg("u/user") });
    const project = await discoverOrcheConfig({ ...both, projectTrusted: true, session });
    expect(project.source.kind).toBe("project");
    expect(project.routes.default?.model).toBe("p/project");

    const userOnly = await layout({ user: cfg("u/user") });
    const user = await discoverOrcheConfig({ ...userOnly, projectTrusted: true, session });
    expect(user.source.kind).toBe("user");
    expect(user.routes.default?.model).toBe("u/user");

    const none = await layout({});
    const fallback = await discoverOrcheConfig({ ...none, projectTrusted: true, session });
    expect(fallback.source).toEqual({ kind: "session", model: "openai/session-model", thinking: "high" });
    expect(fallback.routes).toEqual({ routes: {}, default: { model: "openai/session-model", thinking: "high" } });
  });

  it("does not let an untrusted project choose models: falls through and reports the ignored file", async () => {
    const both = await layout({ project: cfg("p/project"), user: cfg("u/user") });
    const result = await discoverOrcheConfig({ ...both, projectTrusted: false, session });
    expect(result.source.kind).toBe("user");
    expect(result.ignored).toHaveLength(1);
    expect(result.ignored[0]).toContain("not trusted");
  });

  it("surfaces an invalid config file instead of silently falling back", async () => {
    const broken = await layout({ project: "{ not json", user: cfg("u/user") });
    await expect(discoverOrcheConfig({ ...broken, projectTrusted: true, session })).rejects.toThrow("Cannot load route config");
    const typo = await layout({ user: { routes: {}, advisor: [] } });
    await expect(discoverOrcheConfig({ ...typo, projectTrusted: true, session })).rejects.toThrow("unknown field");
  });

  it("fails with guidance when there is neither a config nor a session model", async () => {
    const none = await layout({});
    await expect(discoverOrcheConfig({ ...none, projectTrusted: true, session: {} })).rejects.toBeInstanceOf(NoRouteError);
    await expect(discoverOrcheConfig({ ...none, projectTrusted: true, session: {} })).rejects.toThrow(".pi/orche.config.json");
  });


  it("defaults concurrentSessions to enabled with a 10 minute window, from every config source", async () => {
    expect(DEFAULT_CONCURRENT_SESSIONS).toEqual({ enabled: true, windowMinutes: 10 });
    expect(resolveConcurrentSessions()).toEqual({ enabled: true, windowMinutes: 10 });
    const noSetting = await layout({ user: cfg("u/user") });
    expect((await discoverOrcheConfig({ ...noSetting, projectTrusted: true, session })).concurrentSessions).toEqual({ enabled: true, windowMinutes: 10 });
    const none = await layout({});
    expect((await discoverOrcheConfig({ ...none, projectTrusted: true, session })).concurrentSessions).toEqual({ enabled: true, windowMinutes: 10 });
  });

  it("reads concurrentSessions from the selected file and keeps it out of the route config", async () => {
    const files = await layout({
      project: { ...cfg("p/project"), concurrentSessions: { windowMinutes: 3 } },
      user: { ...cfg("u/user"), concurrentSessions: { enabled: false } },
    });
    const project = await discoverOrcheConfig({ ...files, projectTrusted: true, session });
    expect(project.concurrentSessions).toEqual({ enabled: true, windowMinutes: 3 });
    expect(project.routes).toEqual(cfg("p/project"));
    // An untrusted project file is ignored entirely, including its concurrentSessions.
    const user = await discoverOrcheConfig({ ...files, projectTrusted: false, session });
    expect(user.concurrentSessions).toEqual({ enabled: false, windowMinutes: 10 });
    const both = await layout({ user: { ...cfg("u/user"), concurrentSessions: { enabled: true, windowMinutes: 0.5 } } });
    expect((await discoverOrcheConfig({ ...both, projectTrusted: true, session })).concurrentSessions).toEqual({ enabled: true, windowMinutes: 0.5 });
    const empty = await layout({ user: { ...cfg("u/user"), concurrentSessions: {} } });
    expect((await discoverOrcheConfig({ ...empty, projectTrusted: true, session })).concurrentSessions).toEqual({ enabled: true, windowMinutes: 10 });
  });

  it("validates concurrentSessions like the other settings", async () => {
    expect(parseConcurrentSessionsConfig({ enabled: false, windowMinutes: 30 })).toEqual({ enabled: false, windowMinutes: 30 });
    expect(parseConcurrentSessionsConfig({})).toEqual({});
    const invalid: [unknown, string][] = [
      [null, "config.concurrentSessions: expected object"],
      [[], "config.concurrentSessions: expected object"],
      [true, "config.concurrentSessions: expected object"],
      [{ enable: false }, "config.concurrentSessions: unknown field"],
      [{ enabled: "no" }, "config.concurrentSessions.enabled"],
      [{ enabled: 0 }, "config.concurrentSessions.enabled"],
      [{ windowMinutes: 0 }, "config.concurrentSessions.windowMinutes"],
      [{ windowMinutes: -5 }, "config.concurrentSessions.windowMinutes"],
      [{ windowMinutes: "10" }, "config.concurrentSessions.windowMinutes"],
      [{ windowMinutes: Number.NaN }, "config.concurrentSessions.windowMinutes"],
      [{ windowMinutes: Number.POSITIVE_INFINITY }, "config.concurrentSessions.windowMinutes"],
      [{ windowMinutes: 24 * 60 + 1 }, "config.concurrentSessions.windowMinutes"],
    ];
    for (const [value, message] of invalid) expect(() => parseConcurrentSessionsConfig(value), JSON.stringify(value)).toThrow(message);
    for (const [value, message] of [[{ windowMinutes: 0 }, "windowMinutes"], [{ bogus: 1 }, "unknown field"], ["x", "expected object"]] as const) {
      const files = await layout({ user: { ...cfg("u/user"), concurrentSessions: value } });
      await expect(discoverOrcheConfig({ ...files, projectTrusted: true, session }), JSON.stringify(value)).rejects.toThrow(message);
    }
  });

  it("still rejects unknown top-level fields and unreadable files when loading a config file", async () => {
    const typo = await layout({ user: { ...cfg("u/user"), concurrentSession: { enabled: false } } });
    await expect(loadOrcheConfigFile(join(typo.agentDir, "orche.config.json"))).rejects.toThrow("config: unknown field");
    await expect(loadOrcheConfigFile(join(typo.agentDir, "missing.json"))).rejects.toThrow("Cannot load route config");
    const array = await layout({ user: [] });
    await expect(loadOrcheConfigFile(join(array.agentDir, "orche.config.json"))).rejects.toThrow("config: expected object");
  });

  it("defaults records to enabled with 30 days retention, from every config source", async () => {
    const expected = { enabled: true, retentionDays: 30 };
    expect(DEFAULT_RECORDS).toEqual(expected);
    expect(resolveRecordsSettings()).toEqual(expected);
    const noSetting = await layout({ user: cfg("u/user") });
    expect((await discoverOrcheConfig({ ...noSetting, projectTrusted: true, session })).records).toEqual(expected);
    const none = await layout({});
    expect((await discoverOrcheConfig({ ...none, projectTrusted: true, session })).records).toEqual(expected);
    const empty = await layout({ user: { ...cfg("u/user"), records: {} } });
    expect((await discoverOrcheConfig({ ...empty, projectTrusted: true, session })).records).toEqual(expected);
  });

  it("reads records from the selected file and keeps it out of the route config", async () => {
    const files = await layout({
      project: { ...cfg("p/project"), records: { dir: "/var/orche-records", retentionDays: 7, maxBytes: 1048576 } },
      user: { ...cfg("u/user"), records: { enabled: false } },
    });
    const project = await discoverOrcheConfig({ ...files, projectTrusted: true, session });
    expect(project.records).toEqual({ enabled: true, dir: "/var/orche-records", retentionDays: 7, maxBytes: 1048576 });
    expect(project.routes).toEqual(cfg("p/project"));
    // An untrusted project file is ignored entirely, including its records.
    expect((await discoverOrcheConfig({ ...files, projectTrusted: false, session })).records).toEqual({ enabled: false, retentionDays: 30 });
    const home = await layout({ user: { ...cfg("u/user"), records: { dir: "~/orche-records", retentionDays: 0.5 }, concurrentSessions: { windowMinutes: 3 } } });
    const loaded = await loadOrcheConfigFile(join(home.agentDir, "orche.config.json"));
    expect(loaded.records).toEqual({ enabled: true, dir: "~/orche-records", retentionDays: 0.5 });
    expect(loaded.concurrentSessions).toEqual({ enabled: true, windowMinutes: 3 });
    expect(loaded.routes).toEqual(cfg("u/user"));
  });

  it("validates records like the other settings", async () => {
    expect(parseRecordsConfig({ enabled: false, dir: "/abs/records", retentionDays: 90, maxBytes: 5 })).toEqual({ enabled: false, dir: "/abs/records", retentionDays: 90, maxBytes: 5 });
    expect(parseRecordsConfig({})).toEqual({});
    expect(parseRecordsConfig({ dir: "~/records" })).toEqual({ dir: "~/records" });
    expect(resolveRecordsSettings({ maxBytes: 10 })).toEqual({ enabled: true, retentionDays: 30, maxBytes: 10 });
    const invalid: [unknown, string][] = [
      [null, "config.records: expected object"],
      [[], "config.records: expected object"],
      [false, "config.records: expected object"],
      [{ enable: false }, "config.records: unknown field"],
      [{ enabled: "no" }, "config.records.enabled"],
      [{ enabled: 1 }, "config.records.enabled"],
      [{ dir: "" }, "config.records.dir"],
      [{ dir: "relative/records" }, "config.records.dir"],
      [{ dir: "./records" }, "config.records.dir"],
      [{ dir: "~" }, "config.records.dir"],
      [{ dir: "~other/records" }, "config.records.dir"],
      [{ dir: " /padded" }, "config.records.dir"],
      [{ dir: 5 }, "config.records.dir"],
      [{ retentionDays: 0 }, "config.records.retentionDays"],
      [{ retentionDays: -1 }, "config.records.retentionDays"],
      [{ retentionDays: "30" }, "config.records.retentionDays"],
      [{ retentionDays: Number.NaN }, "config.records.retentionDays"],
      [{ retentionDays: Number.POSITIVE_INFINITY }, "config.records.retentionDays"],
      [{ retentionDays: MAX_RECORDS_RETENTION_DAYS + 1 }, "config.records.retentionDays"],
      [{ maxBytes: 0 }, "config.records.maxBytes"],
      [{ maxBytes: 1.5 }, "config.records.maxBytes"],
      [{ maxBytes: -5 }, "config.records.maxBytes"],
      [{ maxBytes: "1000" }, "config.records.maxBytes"],
    ];
    for (const [value, message] of invalid) expect(() => parseRecordsConfig(value), JSON.stringify(value)).toThrow(message);
    for (const [value, message] of [[{ retentionDays: 0 }, "retentionDays"], [{ bogus: 1 }, "unknown field"], ["x", "expected object"]] as const) {
      const files = await layout({ user: { ...cfg("u/user"), records: value } });
      await expect(discoverOrcheConfig({ ...files, projectTrusted: true, session }), JSON.stringify(value)).rejects.toThrow(message);
    }
  });

  it("still rejects a mistyped records key", async () => {
    const typo = await layout({ user: { ...cfg("u/user"), record: { enabled: false } } });
    await expect(loadOrcheConfigFile(join(typo.agentDir, "orche.config.json"))).rejects.toThrow("config: unknown field");
  });
  it("defaults taskContext from every source and uses the trusted file as a whole", async () => {
    expect(parseTaskContextConfig({})).toEqual(DEFAULT_TASK_CONTEXT);
    const none = await layout({});
    expect((await discoverOrcheConfig({ ...none, projectTrusted: true, session })).taskContext).toEqual({ clearBetweenAssignments: true, minClearTokens: 10000 });
    const files = await layout({ project: { ...cfg("p/project"), taskContext: { minClearTokens: 0 } }, user: { ...cfg("u/user"), taskContext: { clearBetweenAssignments: false, minClearTokens: 42 } } });
    const project = await discoverOrcheConfig({ ...files, projectTrusted: true, session });
    expect(project.taskContext).toEqual({ clearBetweenAssignments: true, minClearTokens: 0 });
    expect(project.routes).toEqual(cfg("p/project"));
    expect((await discoverOrcheConfig({ ...files, projectTrusted: false, session })).taskContext).toEqual({ clearBetweenAssignments: false, minClearTokens: 42 });
    await writeFile(join(files.cwd, ".pi", "orche.config.json"), JSON.stringify(cfg("p/project")));
    expect((await discoverOrcheConfig({ ...files, projectTrusted: true, session })).taskContext).toEqual(DEFAULT_TASK_CONTEXT);
  });

  it.each([null, [], true, { unknown: true }, { clearBetweenAssignments: "true" }, { clearBetweenAssignments: 0 }, { clearBetweenAssignments: null }, { minClearTokens: -1 }, { minClearTokens: 0.5 }, { minClearTokens: "10000" }, { minClearTokens: null }, { minClearTokens: Number.NaN }, { minClearTokens: Infinity }])("rejects invalid taskContext %j without fallback", async value => {
    expect(() => parseTaskContextConfig(value)).toThrow("config.taskContext");
    const files = await layout({ user: { ...cfg("u/user"), taskContext: value } });
    await expect(discoverOrcheConfig({ ...files, projectTrusted: false, session })).rejects.toThrow("config.taskContext");
  });

  it("defaults single to {ledger:false, spawn:true, advisor:false} and reads it from the selected file", async () => {
    const defaults = { ledger: false, spawn: true, advisor: false };
    expect(DEFAULT_SINGLE).toEqual(defaults);
    expect(parseSingleConfig({})).toEqual(defaults);
    expect(parseSingleConfig({ ledger: true })).toEqual({ ...defaults, ledger: true });
    expect(parseSingleConfig({ spawn: false })).toEqual({ ...defaults, spawn: false });
    expect(parseSingleConfig({ advisor: true })).toEqual({ ...defaults, advisor: true });
    const none = await layout({});
    expect((await discoverOrcheConfig({ ...none, projectTrusted: true, session })).single).toEqual(defaults);
    const files = await layout({ user: { ...cfg("u/user"), single: { ledger: true } } });
    const found = await discoverOrcheConfig({ ...files, projectTrusted: false, session });
    expect(found.single).toEqual({ ...defaults, ledger: true });
    expect(found.routes).toEqual(cfg("u/user"));
  });

  // The v2 pipeline, Workflow Policy and mainReview were removed (docs/orchestrator.md): old keys still load, are ignored and warned about.
  it.each([
    [{ advisors: [{ name: "x", model: "p/m" }] }, "advisors"],
    [{ audit: { artifacts: ["dist/"] } }, "audit"],
    [{ workers: { maxWorkers: 3, answerAngles: ["a"] } }, "workers.maxWorkers"],
    [{ workers: { maxWorkers: 99, explorerRoles: ["explorer-x"] } }, "workers.maxWorkers"],
  ])("ignores the removed coordinator setting %j with a warning and still loads", async (value, key) => {
    const warnings: string[] = [];
    const parsed = parseRouteConfig({ ...cfg("u/user"), ...value }, warnings);
    expect(parsed.routes).toEqual(cfg("u/user").routes);
    expect(warnings.join("\n")).toContain(key);
    expect(warnings.join("\n")).toContain("removed with the multi-worker coordinator");
    const explorerRoles = (value as { workers?: { explorerRoles?: string[] } }).workers?.explorerRoles;
    expect(parsed.workers).toEqual(explorerRoles ? { explorerRoles } : undefined);
    const files = await layout({ user: { ...cfg("u/user"), ...value } });
    const loaded = await loadOrcheConfigFile(join(files.agentDir, "orche.config.json"));
    expect(loaded.warnings.join("\n")).toContain(key);
    const found = await discoverOrcheConfig({ ...files, projectTrusted: false, session });
    expect(found.warnings?.join("\n")).toContain(key);
  });
  it.each([{ pipeline: "v2" }, { pipeline: "v3" }, { frame: "spec" }, { checker: { gate: "always" } }, { nav: false }, { mainReview: "evidence" }, { investigation: { critic: "auto" } }, { creation: { divergence: "always", candidates: 2 } }])("ignores the removed single setting %j with a warning", async value => {
    const warnings: string[] = [];
    expect(parseSingleConfig({ ...value, ledger: true }, warnings)).toEqual({ ledger: true, spawn: true, advisor: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(Object.keys(value)[0]);
    const files = await layout({ user: { ...cfg("u/user"), single: value } });
    const path = join(files.agentDir, "orche.config.json");
    const loaded = await loadOrcheConfigFile(path);
    expect(loaded.single).toEqual({ ledger: false, spawn: true, advisor: false });
    expect(loaded.warnings.join("\n")).toContain(Object.keys(value)[0]);
    const found = await discoverOrcheConfig({ ...files, projectTrusted: false, session });
    expect(found.single).toEqual({ ledger: false, spawn: true, advisor: false });
    expect(found.warnings?.join("\n")).toContain(Object.keys(value)[0]);
  });

  it.each([{ spawn: "yes" }, { spawn: null }])("rejects invalid single.spawn %j", value => {
    expect(() => parseSingleConfig(value)).toThrow("config.single");
  });
  // single.advisor (docs/orchestrator.md 13): a boolean like the other single switches; an old file without it means off.
  it.each([{ advisor: "on" }, { advisor: null }, { advisor: 1 }])("rejects invalid single.advisor %j", value => {
    expect(() => parseSingleConfig(value)).toThrow("config.single.advisor: expected boolean");
  });
  it("reads single.advisor from the selected file; a file without it (or without single) keeps the advisor off", async () => {
    const on = await layout({ user: { ...cfg("u/user"), single: { advisor: true } } });
    expect((await discoverOrcheConfig({ ...on, projectTrusted: false, session })).single.advisor).toBe(true);
    const old = await layout({ user: { ...cfg("u/user"), single: { ledger: true } } });
    expect((await discoverOrcheConfig({ ...old, projectTrusted: false, session })).single.advisor).toBe(false);
    const bare = await layout({ user: cfg("u/user") });
    expect((await discoverOrcheConfig({ ...bare, projectTrusted: false, session })).single.advisor).toBe(false);
    const invalid = await layout({ user: { ...cfg("u/user"), single: { advisor: "yes" } } });
    await expect(discoverOrcheConfig({ ...invalid, projectTrusted: false, session })).rejects.toThrow("config.single.advisor: expected boolean");
  });

  it.each([null, [], true, { unknown: true }, { ledger: "true" }, { ledger: 1 }, { ledger: null }])("rejects invalid single %j without fallback", async value => {
    expect(() => parseSingleConfig(value)).toThrow("config.single");
    const files = await layout({ user: { ...cfg("u/user"), single: value } });
    await expect(discoverOrcheConfig({ ...files, projectTrusted: false, session })).rejects.toThrow("config.single");
  });


  it("defaults writeRoots to [] from every source and reads it from the selected file only", async () => {
    const none = await layout({});
    expect((await discoverOrcheConfig({ ...none, projectTrusted: true, session })).writeRoots).toEqual([]);
    const plain = await layout({ user: cfg("u/user") });
    expect((await discoverOrcheConfig({ ...plain, projectTrusted: true, session })).writeRoots).toEqual([]);
    const files = await layout({ project: { ...cfg("p/project"), writeRoots: ["../sibling", "/srv/shared"] }, user: { ...cfg("u/user"), writeRoots: ["~/Code/other"] } });
    const project = await discoverOrcheConfig({ ...files, projectTrusted: true, session });
    expect(project.writeRoots).toEqual(["../sibling", "/srv/shared"]);
    expect(project.routes).toEqual(cfg("p/project"));
    // An untrusted project file is ignored entirely, including its writeRoots.
    expect((await discoverOrcheConfig({ ...files, projectTrusted: false, session })).writeRoots).toEqual(["~/Code/other"]);
    expect((await loadOrcheConfigFile(join(files.agentDir, "orche.config.json"))).writeRoots).toEqual(["~/Code/other"]);
  });

  it("validates writeRoots and rejects /, the home directory and wrong types", async () => {
    expect(parseWriteRootsConfig([])).toEqual([]);
    expect(parseWriteRootsConfig(["a", "/b", "~/c"])).toEqual(["a", "/b", "~/c"]);
    const invalid: [unknown, string][] = [
      [null, "config.writeRoots: expected an array"],
      ["/srv", "config.writeRoots: expected an array"],
      [{ path: "/srv" }, "config.writeRoots: expected an array"],
      [[5], "config.writeRoots[0]: expected a string"],
      [["/ok", null], "config.writeRoots[1]: expected a string"],
      [[""], "config.writeRoots[0]: expected a non-empty path"],
      [["  "], "config.writeRoots[0]: expected a non-empty path"],
      [[" /padded"], "config.writeRoots[0]: expected a non-empty path"],
      [["/"], "config.writeRoots[0]: the filesystem root / cannot be a write root"],
      [["//"], "filesystem root"],
      [["/./"], "filesystem root"],
      [[homedir()], "the home directory"],
      [[`${homedir()}/`], "the home directory"],
      [["~"], "only ~/ is expanded"],
      [["~/"], "the home directory"],
      [["~other/x"], "only ~/ is expanded"],
    ];
    for (const [value, message] of invalid) expect(() => parseWriteRootsConfig(value), JSON.stringify(value)).toThrow(message);
    for (const [value, message] of [[["/"], "filesystem root"], ["x", "expected an array"], [[1], "expected a string"]] as const) {
      const files = await layout({ user: { ...cfg("u/user"), writeRoots: value } });
      await expect(discoverOrcheConfig({ ...files, projectTrusted: true, session }), JSON.stringify(value)).rejects.toThrow(message);
    }
    const typo = await layout({ user: { ...cfg("u/user"), writeRoot: ["/srv"] } });
    await expect(loadOrcheConfigFile(join(typo.agentDir, "orche.config.json"))).rejects.toThrow("config: unknown field");
  });

  it("resolves writeRoots against the task cwd into absolute normalized paths", () => {
    expect(resolveWriteRoots("/home/u/Code/repo", ["../sibling", "/srv/x/", "/srv/./x", "sub/../lib", "~/Code/other"])).toEqual([
      "/home/u/Code/sibling", "/srv/x", "/home/u/Code/repo/lib", join(homedir(), "Code/other"),
    ]);
    expect(resolveWriteRoots("/w", [])).toEqual([]);
    expect(() => resolveWriteRoots("/w", [".."])).toThrow("filesystem root");
    expect(() => resolveWriteRoots(join(homedir(), "repo"), [".."])).toThrow("the home directory");
  });

});
