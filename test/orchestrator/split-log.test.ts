import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSplitLog, formatSplitSummary, readSplitLog, SPLIT_LOG, SPLIT_LOG_ROTATED, summarizeSplits, type SplitLogEntry } from "../../src/orchestrator/split-log.js";
import { parseOrcheCommand } from "../../src/extension/index.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const root = async () => { const dir = await mkdtemp(join(tmpdir(), "split-log-")); dirs.push(dir); return join(dir, "records"); };
const entry = (overrides: Partial<SplitLogEntry> = {}): SplitLogEntry => ({
  ts: "2026-10-06T10:00:00.000Z", role: "implement", orchestrator: true, decision: "none", reported: true, criteria: [],
  subWorkers: 0, requests: 10, subRequests: 0, durationMs: 60_000, costUSD: 0.5, status: "done", model: "p/m", record: "/r/1", ...overrides,
});

describe("split log", () => {
  it("appends one JSON line per assignment in a private file under the records root and reads them back in time order", async () => {
    const dir = await root();
    appendSplitLog(dir, entry({ ts: "2026-10-06T11:00:00.000Z" }));
    appendSplitLog(dir, entry({ ts: "2026-10-06T10:00:00.000Z", decision: "split", criteria: ["parallelism"], subWorkers: 3 }));
    const text = await readFile(join(dir, SPLIT_LOG), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect((await stat(join(dir, SPLIT_LOG))).mode & 0o777).toBe(0o600);
    expect((await readSplitLog(dir)).map(line => line.ts)).toEqual(["2026-10-06T10:00:00.000Z", "2026-10-06T11:00:00.000Z"]);
  });

  it("rotates to one previous file when the next line would pass the cap, and reads both", async () => {
    const dir = await root();
    const size = JSON.stringify(entry()).length + 1;
    for (let index = 0; index < 5; index++) appendSplitLog(dir, entry({ ts: `2026-10-06T10:0${index}:00.000Z` }), size * 2);
    // 2 lines fill a file; lines 3 and 5 rotate: the previous file holds lines 3-4, the current one line 5.
    expect((await readFile(join(dir, SPLIT_LOG_ROTATED), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readFile(join(dir, SPLIT_LOG), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readSplitLog(dir)).map(line => line.ts.slice(14, 16))).toEqual(["02", "03", "04"]);
  });

  it("skips torn lines and never throws when the root cannot be written", async () => {
    const dir = await root();
    appendSplitLog(dir, entry());
    await writeFile(join(dir, SPLIT_LOG), `${await readFile(join(dir, SPLIT_LOG), "utf8")}{"ts":`, { mode: 0o600 });
    expect(await readSplitLog(dir)).toHaveLength(1);
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    expect(() => appendSplitLog(join(file, "records"), entry())).not.toThrow();
  });

  it("summarizes a period: split rate over orchestrator assignments, criteria, and cost and time by decision", () => {
    const entries = [
      entry({ ts: "2026-09-01T00:00:00.000Z", decision: "split", criteria: ["parallelism"], subWorkers: 4, costUSD: 9 }),
      entry({ ts: "2026-10-05T00:00:00.000Z", decision: "split", criteria: ["verification"], subWorkers: 1, durationMs: 300_000, costUSD: 2 }),
      entry({ ts: "2026-10-05T01:00:00.000Z", durationMs: 100_000, costUSD: 1 }),
      entry({ ts: "2026-10-05T02:00:00.000Z", durationMs: 200_000, costUSD: null, status: "failed", reported: false }),
      entry({ ts: "2026-10-05T03:00:00.000Z", role: "explore", orchestrator: false, decision: null, reported: false }),
    ];
    const all = summarizeSplits(entries);
    expect(all).toMatchObject({ assignments: 5, orchestrator: 4, split: 2, unreported: 1, criteria: { parallelism: 1, verification: 1 } });
    const recent = summarizeSplits(entries, Date.parse("2026-10-01T00:00:00.000Z"));
    expect(recent).toMatchObject({ assignments: 4, orchestrator: 3, split: 1, criteria: { verification: 1 } });
    expect(recent.byDecision.split).toEqual({ count: 1, done: 1, medianMs: 300_000, medianCostUSD: 2, totalCostUSD: 2, meanSubWorkers: 1 });
    expect(recent.byDecision.none).toEqual({ count: 2, done: 1, medianMs: 150_000, medianCostUSD: 1, totalCostUSD: 1, meanSubWorkers: 0 });
    const text = formatSplitSummary(recent, "/r");
    expect(text).toContain("since 2026-10-01");
    expect(text).toContain("4 assignments, 3 as orchestrator; split 1 (33.3%), 1 without a reported decision.");
    expect(text).toContain("- split: 1 (done 1), median 300s, median $2.00, total $2.00, 1.0 sub-workers on average");
    expect(formatSplitSummary(summarizeSplits([]), "/r")).toContain("No orche_task assignments");
  });

  it("/orche splits takes an optional positive number of days", () => {
    expect(parseOrcheCommand("splits")).toEqual({ mode: "splits" });
    expect(parseOrcheCommand(" splits 30 ")).toEqual({ mode: "splits", days: 30 });
    expect(parseOrcheCommand("splits 0")).toBeUndefined();
    expect(parseOrcheCommand("splits x")).toBeUndefined();
  });
});
