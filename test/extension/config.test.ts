import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONCURRENT_SESSIONS, DEFAULT_RECORDS, discoverOrcheConfig, loadOrcheConfigFile, MAX_RECORDS_RETENTION_DAYS, NoRouteError, parseConcurrentSessionsConfig, parseRecordsConfig,
  resolveConcurrentSessions, resolveRecordsSettings,
} from "../../src/extension/config.js";
import { resolveRunLimits } from "../../src/orchestration/limits.js";
import { DEFAULT_SINGLE, DEFAULT_TASK_CONTEXT, parseSingleConfig, parseTaskContextConfig } from "../../src/extension/config.js";

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

  it("carries advisors from the discovered file", async () => {
    const withAdvisors = await layout({ user: { ...cfg("u/user"), advisors: [{ preset: "plan-review", enabled: true }] } });
    const result = await discoverOrcheConfig({ ...withAdvisors, projectTrusted: true, session });
    expect(result.routes.advisors?.map(advisor => advisor.name)).toEqual(["plan-review"]);
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

  it("defaults single.ledger to off and reads it from the selected file", async () => {
    const defaults = { ledger: false, pipeline: "v1", frame: "grounded", checker: { gate: "review", threshold: 7, maxFixRounds: 1 }, nav: true, mainReview: "report", investigation: { critic: "off" }, creation: { divergence: "off", candidates: 3 } };
    expect(DEFAULT_SINGLE).toEqual(defaults);
    expect(parseSingleConfig({})).toEqual(defaults);
    expect(parseSingleConfig({ ledger: true })).toEqual({ ...defaults, ledger: true });
    const none = await layout({});
    expect((await discoverOrcheConfig({ ...none, projectTrusted: true, session })).single).toEqual(defaults);
    const files = await layout({ user: { ...cfg("u/user"), single: { ledger: true } } });
    const found = await discoverOrcheConfig({ ...files, projectTrusted: false, session });
    expect(found.single).toEqual({ ...defaults, ledger: true });
    expect(found.routes).toEqual(cfg("u/user"));
  });

  it("reads the v2 pipeline settings; v2 implies the ledger", () => {
    const policies = { investigation: { critic: "off" }, creation: { divergence: "off", candidates: 3 } };
    expect(parseSingleConfig({ pipeline: "v2" })).toEqual({ ledger: true, pipeline: "v2", frame: "grounded", checker: { gate: "review", threshold: 7, maxFixRounds: 1 }, nav: true, mainReview: "report", ...policies });
    expect(parseSingleConfig({ pipeline: "v2", ledger: false, frame: "spec", checker: { gate: "always", threshold: 3, maxFixRounds: 0 }, nav: false }))
      .toEqual({ ledger: true, pipeline: "v2", frame: "spec", checker: { gate: "always", threshold: 3, maxFixRounds: 0 }, nav: false, mainReview: "report", ...policies });
    expect(parseSingleConfig({ frame: "off", checker: { gate: "off" } })).toEqual({ ledger: false, pipeline: "v1", frame: "off", checker: { gate: "off", threshold: 7, maxFixRounds: 1 }, nav: true, mainReview: "report", ...policies });
    expect(parseSingleConfig({ mainReview: "evidence", checker: { gate: "auto" } })).toMatchObject({ pipeline: "v1", mainReview: "evidence", checker: { gate: "auto" } });
  });

  it("reads the investigation and creation workflow policies (off by default)", () => {
    expect(parseSingleConfig({ investigation: { critic: "auto" } })).toMatchObject({ investigation: { critic: "auto" }, creation: { divergence: "off", candidates: 3 } });
    expect(parseSingleConfig({ creation: { divergence: "always", candidates: 2 } })).toMatchObject({ investigation: { critic: "off" }, creation: { divergence: "always", candidates: 2 } });
    expect(parseSingleConfig({ creation: {} })).toMatchObject({ creation: { divergence: "off", candidates: 3 } });
  });

  it.each([{ investigation: null }, { investigation: { critic: "review" } }, { investigation: { other: 1 } }, { creation: [] }, { creation: { divergence: "on" } }, { creation: { candidates: 4 } }, { creation: { candidates: 1 } }, { creation: { n: 3 } }])("rejects invalid workflow policy settings %j", value => {
    expect(() => parseSingleConfig(value)).toThrow("config.single");
  });

  it.each([{ pipeline: "v3" }, { frame: "full" }, { checker: null }, { checker: { gate: "sometimes" } }, { checker: { threshold: -1 } }, { checker: { threshold: 2.5 } }, { checker: { maxFixRounds: 3 } }, { checker: { other: 1 } }, { nav: "yes" }, { mainReview: "none" }])("rejects invalid single pipeline settings %j", value => {
    expect(() => parseSingleConfig(value)).toThrow("config.single");
  });

  it.each([null, [], true, { unknown: true }, { ledger: "true" }, { ledger: 1 }, { ledger: null }])("rejects invalid single %j without fallback", async value => {
    expect(() => parseSingleConfig(value)).toThrow("config.single");
    const files = await layout({ user: { ...cfg("u/user"), single: value } });
    await expect(discoverOrcheConfig({ ...files, projectTrusted: false, session })).rejects.toThrow("config.single");
  });

});
