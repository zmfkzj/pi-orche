import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONCURRENT_SESSIONS, DEFAULT_RECORDS, discoverOrcheConfig, loadOrcheConfigFile, MAX_RECORDS_RETENTION_DAYS, NoRouteError, parseConcurrentSessionsConfig, parseRecordsConfig,
  resolveConcurrentSessions, resolveRecordsSettings,
} from "../../src/extension/config.js";

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
});
