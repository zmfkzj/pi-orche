import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldCompact } from "@earendil-works/pi-coding-agent";
import { DEFAULT_WORKER_COMPACTION, MIN_TRIGGER_TOKENS, parseWorkerCompaction, piCompactionSettings, resolveCompaction, stableCompaction } from "../../src/pi/compaction-policy.js";
import { checkReference, composeEssentials, renderReference, renderWorkLog } from "../../src/pi/compaction-state.js";
import { taskCompactionSettings } from "../../src/pi/session-factory.js";
import { loadOrcheConfigFile } from "../../src/extension/config.js";
import { renderMainMessages } from "../../src/extension/workers.js";
import type { EvidenceLedger } from "../../src/pi/tool-evidence.js";

describe("workerCompaction policy", () => {
  it("defaults to the stable policy, identical to the settings before the option existed", () => {
    for (const window of [32_000, 272_000, 1_000_000]) {
      const resolved = resolveCompaction(undefined, { contextWindow: window });
      expect(resolved).toMatchObject({ policy: "window-ratio", early: false, reserveTokens: Math.floor(window * 0.5), keepRecentTokens: Math.min(20_000, window - Math.floor(window * 0.5)) });
      expect(resolveCompaction({ ...DEFAULT_WORKER_COMPACTION }, { contextWindow: window })).toEqual(resolved);
      expect(taskCompactionSettings(window)).toEqual({ enabled: true, reserveTokens: resolved.reserveTokens, keepRecentTokens: resolved.keepRecentTokens });
    }
    expect(DEFAULT_WORKER_COMPACTION).toEqual({ policy: "window-ratio", essentials: "basic", subWorkers: false });
  });

  it("absolute: per model before per role before base; never later than the stable trigger; keepRecent at most half the trigger", () => {
    const settings = parseWorkerCompaction({ policy: "absolute", triggerTokens: 64_000, roles: { "sub-worker": { triggerTokens: 48_000 } }, models: [{ model: "cliproxyapi/gpt-6-*", triggerTokens: 32_000, keepRecentTokens: 8_000 }] });
    expect(resolveCompaction(settings, { contextWindow: 922_000, model: "cliproxyapi/gpt-6-astra", role: "sub-worker" })).toMatchObject({ policy: "absolute", triggerTokens: 32_000, reserveTokens: 890_000, keepRecentTokens: 8_000, early: true });
    expect(resolveCompaction(settings, { contextWindow: 922_000, model: "anthropic/x", role: "sub-worker" })).toMatchObject({ triggerTokens: 48_000, keepRecentTokens: 12_000 });
    expect(resolveCompaction(settings, { contextWindow: 922_000, model: "anthropic/x", role: "implement" })).toMatchObject({ triggerTokens: 64_000, keepRecentTokens: 16_000 });
    // A small window: the stable trigger (50%) wins, the policy is not early.
    expect(resolveCompaction(settings, { contextWindow: 100_000, model: "anthropic/x", role: "implement" })).toMatchObject({ triggerTokens: 50_000, early: false, reserveTokens: 50_000 });
    expect(stableCompaction(100_000).triggerTokens).toBe(50_000);
  });

  it("rejects unsafe or malformed settings with the offending path", () => {
    expect(() => parseWorkerCompaction({ policy: "absolute" })).toThrow(/needs triggerTokens/);
    expect(() => parseWorkerCompaction({ policy: "absolute", triggerTokens: MIN_TRIGGER_TOKENS - 1 })).toThrow(/triggerTokens/);
    expect(() => parseWorkerCompaction({ policy: "absolute", triggerTokens: 32_000, keepRecentTokens: 20_000 })).toThrow(/at most half/);
    expect(() => parseWorkerCompaction({ policy: "sometimes" })).toThrow(/policy/);
    expect(() => parseWorkerCompaction({ essentials: "all" })).toThrow(/essentials/);
    expect(() => parseWorkerCompaction({ roles: { main: { triggerTokens: 32_000 } } })).toThrow(/unknown role/);
    expect(() => parseWorkerCompaction({ models: [{ model: "nope", triggerTokens: 32_000 }] })).toThrow(/provider\/model-id/);
    expect(() => parseWorkerCompaction({ subWorkers: "yes" })).toThrow(/subWorkers/);
    expect(() => parseWorkerCompaction({ mainSession: true })).toThrow(/unknown field/);
    expect(parseWorkerCompaction("window-ratio")).toEqual(DEFAULT_WORKER_COMPACTION);
  });

  it("usageRatio: each role and model compacts at its own share of its window; omitted keeps the stable 50%; Pi's threshold fires exactly above it", () => {
    const settings = parseWorkerCompaction({ usageRatio: 0.7, roles: { verify: { usageRatio: 0.3 }, "sub-worker": { usageRatio: 0.9 } }, models: [{ model: "x/*", keepRecentTokens: 4_000 }, { model: "big/*", usageRatio: 0.4 }] });
    const window = 200_001; // odd: the stable trigger is ceil(window / 2)
    const implement = resolveCompaction(settings, { contextWindow: window, model: "a/b", role: "implement" });
    const verify = resolveCompaction(settings, { contextWindow: window, model: "a/b", role: "verify" });
    const sub = resolveCompaction(settings, { contextWindow: window, model: "a/b", role: "sub-worker" });
    expect(implement).toMatchObject({ policy: "window-ratio", usageRatio: 0.7, triggerTokens: 140_001, reserveTokens: 60_000, keepRecentTokens: 20_000, early: false });
    expect(verify).toMatchObject({ policy: "window-ratio", usageRatio: 0.3, triggerTokens: 60_001, reserveTokens: 140_000, keepRecentTokens: 15_000, early: true });
    expect(sub).toMatchObject({ usageRatio: 0.9, triggerTokens: 180_001, early: false });
    // Pi compacts strictly above contextWindow - reserveTokens: one token over each worker's own trigger, never at it.
    for (const resolved of [implement, verify, sub]) {
      expect(shouldCompact(resolved.triggerTokens, window, piCompactionSettings(resolved))).toBe(false);
      expect(shouldCompact(resolved.triggerTokens + 1, window, piCompactionSettings(resolved))).toBe(true);
    }
    // The same context is above verify's trigger, between the two, and below implement's.
    expect(shouldCompact(100_002, window, piCompactionSettings(verify))).toBe(true);
    expect(shouldCompact(100_002, window, piCompactionSettings(implement))).toBe(false);
    // A model rule wins over the role, field by field over the BASE values only (as for triggerTokens): x/* has no usageRatio of
    // its own, so a verify worker on it gets the base 0.7, not verify's 0.3.
    expect(resolveCompaction(settings, { contextWindow: 200_000, model: "x/y", role: "verify" })).toMatchObject({ usageRatio: 0.7, triggerTokens: 140_000, keepRecentTokens: 4_000 });
    expect(resolveCompaction(settings, { contextWindow: 1_000_000, model: "big/m", role: "sub-worker" })).toMatchObject({ usageRatio: 0.4, triggerTokens: 400_000, early: true });
    // Explicit 0.5 is the stable policy (odd window included); no ratio anywhere is the stable policy exactly.
    const half = resolveCompaction(parseWorkerCompaction(0.5), { contextWindow: window });
    expect(piCompactionSettings(half)).toEqual(piCompactionSettings(stableCompaction(window)));
    expect(resolveCompaction(parseWorkerCompaction({ roles: { verify: { usageRatio: 0.3 } } }), { contextWindow: window, role: "implement" })).toEqual(stableCompaction(window));
  });

  it("usageRatio bounds: early ratio triggers are at least MIN_TRIGGER_TOKENS and keep at most half the trigger; 0.95 leaves 5%", () => {
    expect(resolveCompaction(parseWorkerCompaction(0.1), { contextWindow: 100_000 })).toMatchObject({ triggerTokens: MIN_TRIGGER_TOKENS, reserveTokens: 100_000 - MIN_TRIGGER_TOKENS, keepRecentTokens: 4_096, early: true });
    // A window too small for MIN_TRIGGER_TOKENS below its stable trigger: the stable trigger, not early.
    expect(resolveCompaction(parseWorkerCompaction(0.1), { contextWindow: 20_000 })).toMatchObject({ triggerTokens: 10_000, reserveTokens: 10_000, early: false });
    expect(resolveCompaction(parseWorkerCompaction(0.1), { contextWindow: 1_000_000 })).toMatchObject({ triggerTokens: 100_000, keepRecentTokens: 20_000, early: true });
    expect(resolveCompaction(parseWorkerCompaction({ usageRatio: 0.2, keepRecentTokens: 30_000 }), { contextWindow: 200_000 })).toMatchObject({ triggerTokens: 40_000, keepRecentTokens: 20_000 });
    expect(resolveCompaction(parseWorkerCompaction(0.95), { contextWindow: 200_000 })).toMatchObject({ triggerTokens: 190_000, reserveTokens: 10_000, keepRecentTokens: 20_000, early: false });
    expect(resolveCompaction(parseWorkerCompaction({ usageRatio: 0.8, keepRecentTokens: 100_000 }), { contextWindow: 200_000 })).toMatchObject({ triggerTokens: 160_000, keepRecentTokens: 80_000 });
  });

  it("absolute + usageRatio: the ratio replaces 50% as the ceiling and, when not early, as the fallback; omitted keeps the old cap", () => {
    const late = resolveCompaction(parseWorkerCompaction({ policy: "absolute", triggerTokens: 150_000, usageRatio: 0.8 }), { contextWindow: 200_000 });
    expect(late).toMatchObject({ policy: "absolute", triggerTokens: 150_000, early: false, usageRatio: 0.8 });
    const early = resolveCompaction(parseWorkerCompaction({ policy: "absolute", triggerTokens: 32_000, usageRatio: 0.8 }), { contextWindow: 200_000 });
    expect(early).toMatchObject({ triggerTokens: 32_000, early: true, fallback: { policy: "window-ratio", triggerTokens: 160_000, reserveTokens: 40_000, early: false } });
    const capped = resolveCompaction(parseWorkerCompaction({ policy: "absolute", triggerTokens: 150_000, usageRatio: 0.3 }), { contextWindow: 200_000 });
    expect(capped).toMatchObject({ triggerTokens: 60_000, early: true });
    expect(capped.fallback).toBeUndefined(); // an early ratio falls back to the stable 50%
    // A role with only a ratio under the absolute policy: its ratio trigger.
    expect(resolveCompaction(parseWorkerCompaction({ policy: "absolute", triggerTokens: 32_000, roles: { verify: { usageRatio: 0.6 } } }), { contextWindow: 200_000, role: "verify" })).toMatchObject({ triggerTokens: 32_000, usageRatio: 0.6 });
    expect(resolveCompaction(parseWorkerCompaction({ policy: "absolute", models: [{ model: "a/*", triggerTokens: 32_000 }], roles: { verify: { usageRatio: 0.6 } } }), { contextWindow: 200_000, model: "b/c", role: "verify" })).toMatchObject({ policy: "window-ratio", triggerTokens: 120_000, usageRatio: 0.6 });
    // Without usageRatio the absolute cap stays the stable trigger (unchanged).
    expect(resolveCompaction(parseWorkerCompaction({ policy: "absolute", triggerTokens: 150_000 }), { contextWindow: 200_000 })).toMatchObject({ triggerTokens: 100_000, early: false });
  });

  it("rejects invalid usage ratios at every location with the offending path", () => {
    for (const bad of [0, 0.05, 0.96, 1, 1.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "0.6", null, true]) {
      expect(() => parseWorkerCompaction({ usageRatio: bad })).toThrow(/config\.workerCompaction\.usageRatio: expected a fraction of the context window from 0\.1 to 0\.95/);
      expect(() => parseWorkerCompaction({ roles: { verify: { usageRatio: bad } } })).toThrow(/config\.workerCompaction\.roles\.verify\.usageRatio/);
      expect(() => parseWorkerCompaction({ models: [{ model: "a/b", usageRatio: bad }] })).toThrow(/config\.workerCompaction\.models\[0\]\.usageRatio/);
    }
    for (const bad of [0.05, 0.96, Number.NaN]) expect(() => parseWorkerCompaction(bad)).toThrow(/config\.workerCompaction: expected a fraction/);
    expect(parseWorkerCompaction(0.6)).toEqual({ ...DEFAULT_WORKER_COMPACTION, usageRatio: 0.6 });
    expect(parseWorkerCompaction({ usageRatio: 0.1, roles: { explore: { usageRatio: 0.95 } } })).toEqual({ policy: "window-ratio", essentials: "basic", subWorkers: false, usageRatio: 0.1, roles: { explore: { usageRatio: 0.95 } } });
  });

  it("is read from orche.config.json and absent when the file does not set it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-compaction-config-"));
    try {
      await writeFile(join(dir, "a.json"), JSON.stringify({ routes: {}, default: { model: "p/m" }, workerCompaction: { policy: "absolute", triggerTokens: 32_000, essentials: "extended", subWorkers: true } }));
      expect((await loadOrcheConfigFile(join(dir, "a.json"))).workerCompaction).toMatchObject({ policy: "absolute", triggerTokens: 32_000, essentials: "extended", subWorkers: true });
      await writeFile(join(dir, "b.json"), JSON.stringify({ routes: {}, default: { model: "p/m" } }));
      expect((await loadOrcheConfigFile(join(dir, "b.json"))).workerCompaction).toBeUndefined();
      await writeFile(join(dir, "c.json"), JSON.stringify({ routes: {}, default: { model: "p/m" }, workerCompaction: { policy: "absolute" } }));
      await expect(loadOrcheConfigFile(join(dir, "c.json"))).rejects.toThrow(/needs triggerTokens/);
      await writeFile(join(dir, "d.json"), JSON.stringify({ routes: {}, default: { model: "p/m" }, workerCompaction: { usageRatio: 0.7, roles: { verify: { usageRatio: 0.3 } } } }));
      expect((await loadOrcheConfigFile(join(dir, "d.json"))).workerCompaction).toEqual({ policy: "window-ratio", essentials: "basic", subWorkers: false, usageRatio: 0.7, roles: { verify: { usageRatio: 0.3 } } });
      await writeFile(join(dir, "e.json"), JSON.stringify({ routes: {}, default: { model: "p/m" }, workerCompaction: { roles: { verify: { usageRatio: 2 } } } }));
      await expect(loadOrcheConfigFile(join(dir, "e.json"))).rejects.toThrow(/roles\.verify\.usageRatio/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("extended essentials parts", () => {
  const ledger: EvidenceLedger = { checks: 4, bookkeeping: 1, tag: false, calls: [
    { ref: "T1", toolCallId: "call_read", name: "read", isError: false, request: 1, atBaseline: true, target: "src/a.ts", timestamp: 1 },
    { ref: "T2", toolCallId: "call_edit", name: "edit", isError: false, request: 2, atBaseline: true, target: "src/a.ts", timestamp: 2 },
    { ref: "B1", toolCallId: "call_plan", name: "task_plan", isError: false, request: 2, atBaseline: true, timestamp: 3 },
    { ref: "T3", toolCallId: "call_test1", name: "bash", isError: true, request: 3, atBaseline: true, target: "npm test", timestamp: 4 },
    { ref: "T4", toolCallId: "call_test2", name: "bash", isError: false, request: 4, atBaseline: true, target: "npm test", timestamp: 5 },
  ] };

  it("the work log names files, commands and failed calls by their durable call ids, never T-refs or bookkeeping", () => {
    const text = renderWorkLog(ledger);
    expect(text).toContain("Files changed with edit/write/ast_rewrite (1): src/a.ts");
    expect(text).toContain("- FAILED bash `npm test` (call call_test1)");
    expect(text).toContain("- ok bash `npm test` (call call_test2)");
    expect(text).toMatch(/Failed calls \(do not repeat an approach unchanged/);
    expect(text).not.toContain("call_plan");
    expect(text).not.toMatch(/\bT\d\b/);
    expect(renderWorkLog({ calls: [], checks: 0, bookkeeping: 0, tag: false })).toBe("");
  });

  it("checkReference: unavailable in memory, invalid when the file or the entry is missing, valid when the entry is on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-ref-"));
    try {
      expect(checkReference({ persisted: false })).toMatchObject({ status: "unavailable" });
      expect(checkReference({ persisted: true, file: join(dir, "none.jsonl"), discardedEntryId: "e1" })).toMatchObject({ status: "invalid", reason: /does not exist/ });
      await writeFile(join(dir, "s.jsonl"), `${JSON.stringify({ type: "session", id: "h" })}\n${JSON.stringify({ type: "message", id: "e1" })}\n`);
      expect(checkReference({ persisted: true, file: join(dir, "s.jsonl"), discardedEntryId: "e2" })).toMatchObject({ status: "invalid", reason: /not in the transcript/ });
      const valid = checkReference({ persisted: true, file: join(dir, "s.jsonl"), discardedEntryId: "e1", startEntry: "h" });
      expect(valid).toEqual({ status: "valid", file: join(dir, "s.jsonl"), checkedEntry: "e1", startEntry: "h" });
      expect(renderReference(valid, "kept 30 days")).toContain(`your own transcript ${join(dir, "s.jsonl")}`);
      expect(renderReference(valid)).toContain("follow entry id h");
      expect(renderReference(valid)).toContain("Never re-run a command with side effects");
      expect(renderReference({ status: "unavailable", reason: "in memory" })).toMatch(/NOT available for re-reading \(in memory\)/);
      expect(await readFile(join(dir, "s.jsonl"), "utf8")).toContain("e1");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("composeEssentials reports present sections and missing required ones", () => {
    expect(composeEssentials([{ name: "request", text: "R1", required: true }, { name: "reference", text: "", required: true }, { name: "work-log", text: "" }])).toEqual({ text: "R1", sections: ["request"], missing: ["reference"] });
  });

  it("main messages: only main's delivered messages, verbatim, oldest first, with the later-wins rule; advisor, peer and undelivered excluded", () => {
    const text = renderMainMessages([
      { id: "m1", text: "Use ISO dates", queuedAt: 1000, deliveredAt: 2000, status: "delivered" },
      { id: "m2", text: "ADVISOR NOTE", queuedAt: 1500, status: "delivered", source: "advisor" },
      { id: "m3", text: "PEER NOTE", queuedAt: 1600, status: "delivered", source: "peer" },
      { id: "m4", text: "NEVER DELIVERED", queuedAt: 1700, status: "undelivered" },
      { id: "m5", text: "Actually use UTC timestamps instead of ISO dates", queuedAt: 3000, deliveredAt: 3100, status: "delivered" },
    ]);
    expect(text).toMatch(/where two conflict the later one wins/);
    expect(text.indexOf("Use ISO dates")).toBeLessThan(text.indexOf("Actually use UTC"));
    for (const hidden of ["ADVISOR NOTE", "PEER NOTE", "NEVER DELIVERED"]) expect(text).not.toContain(hidden);
    expect(renderMainMessages([])).toBe("");
  });
});
