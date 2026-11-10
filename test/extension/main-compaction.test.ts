import { describe, expect, it, vi } from "vitest";
import {
  checkMainCompaction, DEFAULT_MAIN_COMPACTION, MAIN_COMPACTION_RESUME_TYPE, MainCompaction, parseMainCompactionConfig, piReserveTokens,
  ratioThreshold, type MainCompactionSettings,
} from "../../src/extension/main-compaction.js";
import { loadOrcheConfigFile } from "../../src/extension/config.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const on = { ...DEFAULT_MAIN_COMPACTION };

describe("ratio threshold (model-independent: only the current window counts)", () => {
  it.each([
    ["128K", 128_000, 102_400],
    ["200K", 200_000, 160_000],
    ["272K", 272_000, 217_600],
    ["922K extended", 922_000, 737_600],
    ["1M (a model registered today)", 1_000_000, 800_000],
    ["1,048,576", 1_048_576, 838_860],
  ])("%s window → 80%% threshold", (_name, window, threshold) => {
    expect(ratioThreshold(window, 0.8)).toBe(threshold);
  });
  it("no usable window → no threshold", () => {
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) expect(ratioThreshold(window, 0.8)).toBeUndefined();
  });
  it("exactly 80% does not compact, one token more does (strictly above, like Pi's own `>`)", () => {
    const usage = (tokens: number | null) => ({ tokens, contextWindow: 200_000 });
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage: usage(160_000) })).toEqual({ compact: false, reason: "below" });
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage: usage(160_001) })).toMatchObject({ compact: true, threshold: 160_000, tokens: 160_001 });
  });
  it("unknown usage (right after a compaction), unknown window, disabled settings and Pi's own compaction switch", () => {
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage: { tokens: null, contextWindow: 200_000 } }).compact).toBe(false);
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage: { tokens: null, contextWindow: 200_000 } })).toMatchObject({ reason: "no_usage" });
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage: undefined })).toMatchObject({ reason: "no_window" });
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage: { tokens: 10, contextWindow: 0 } })).toMatchObject({ reason: "no_window" });
    expect(checkMainCompaction({ settings: { ...on, enabled: false }, piEnabled: true, usage: { tokens: 199_000, contextWindow: 200_000 } })).toMatchObject({ reason: "disabled" });
    expect(checkMainCompaction({ settings: on, piEnabled: false, usage: { tokens: 199_000, contextWindow: 200_000 } })).toMatchObject({ reason: "pi_disabled" });
  });
  it("mid-run leaves the turn to Pi when Pi's own reserve compacts before the next request anyway", () => {
    const usage = { tokens: 180_000, contextWindow: 200_000 };
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage, nativeReserve: 16_384 })).toMatchObject({ compact: true });
    expect(checkMainCompaction({ settings: on, piEnabled: true, usage, nativeReserve: 25_000 })).toMatchObject({ compact: false, reason: "native" });
  });
  it("a configured ratio replaces 0.8", () => {
    expect(checkMainCompaction({ settings: { ...on, usageRatio: 0.5 }, piEnabled: true, usage: { tokens: 100_001, contextWindow: 200_000 } })).toMatchObject({ compact: true, threshold: 100_000 });
  });
});

describe("Pi's reserve as Pi resolves it (settings.json compaction)", () => {
  const model = { provider: "cliproxyapi", id: "claude-fable-5-2" };
  it("modelOverrides[provider/id] → reserveTokens → 16384", () => {
    expect(piReserveTokens({}, model)).toBe(16_384);
    expect(piReserveTokens({ compaction: { reserveTokens: 50_000 } }, model)).toBe(50_000);
    expect(piReserveTokens({ compaction: { reserveTokens: 50_000, modelOverrides: { "cliproxyapi/claude-fable-5-2": { reserveTokens: 200_000 } } } }, model)).toBe(200_000);
    expect(piReserveTokens({ compaction: { modelOverrides: { "cliproxyapi/other": { reserveTokens: 200_000 } } } }, model)).toBe(16_384);
    // Pi rejects non-integers when it reads them; here they never count as a reserve.
    expect(piReserveTokens({ compaction: { reserveTokens: 0.8 } }, model)).toBe(16_384);
  });
});

describe("mainCompaction config", () => {
  it("accepts false, true, a ratio and an object", () => {
    expect(parseMainCompactionConfig(false)).toEqual({ ...on, enabled: false });
    expect(parseMainCompactionConfig(true)).toEqual(on);
    expect(parseMainCompactionConfig(0.8)).toEqual(on);
    expect(parseMainCompactionConfig(0.7)).toEqual({ ...on, usageRatio: 0.7 });
    expect(parseMainCompactionConfig({})).toEqual(on);
    expect(parseMainCompactionConfig({ usageRatio: 0.9, midRun: false })).toEqual({ enabled: true, usageRatio: 0.9, midRun: false });
  });
  it.each([
    ["a percentage", 80], ["1", 1], ["0", 0], ["below 0.1", 0.05], ["a string", "0.8"], ["null", null], ["an array", [0.8]],
    ["an unknown field", { reserveRatio: 0.2 }], ["a non-boolean enabled", { enabled: "yes" }], ["a non-boolean midRun", { midRun: 1 }], ["an out-of-range usageRatio", { usageRatio: 0.99 }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseMainCompactionConfig(value)).toThrow(/config\.mainCompaction/);
  });
  it("is an extension-only key: stripped before the route parser, defaults without it, invalid values fail the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orche-main-compaction-"));
    try {
      const path = join(dir, "orche.config.json");
      await writeFile(path, JSON.stringify({ routes: {}, mainCompaction: { usageRatio: 0.75 } }));
      expect((await loadOrcheConfigFile(path)).mainCompaction).toEqual({ ...on, usageRatio: 0.75 });
      await writeFile(path, JSON.stringify({ routes: {} }));
      expect((await loadOrcheConfigFile(path)).mainCompaction).toEqual(on);
      await writeFile(path, JSON.stringify({ routes: {}, mainCompaction: 80 }));
      await expect(loadOrcheConfigFile(path)).rejects.toThrow(/config\.mainCompaction/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/** A Pi API and context double: handlers by event, a scheduled queue run by `flush`, `ctx.compact` recorded. */
function rig(options: { settings?: MainCompactionSettings; piSettings?: Record<string, unknown>; canInterrupt?: () => boolean } = {}) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const sent: { message: { customType: string; content: unknown; display: boolean }; options: unknown }[] = [];
  const queue: (() => void)[] = [];
  let settings = options.settings ?? { ...on };
  const piSettings = options.piSettings ?? { compaction: { reserveTokens: 1_000 } };
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => undefined; },
    sendMessage: (message: { customType: string; content: unknown; display: boolean }, opts: unknown) => { sent.push({ message, options: opts }); },
    getSettings: () => structuredClone(piSettings),
  };
  const state = {
    usage: { tokens: 0 as number | null, contextWindow: 100_000 },
    idle: true, pending: false, mode: "tui" as string, leaf: "e1" as string | null, signal: undefined as AbortSignal | undefined, compactThrows: false,
    branch: [{ id: "e1", type: "message", message: { role: "toolResult" } }] as { id: string; type: string; message?: { role: string; stopReason?: string } }[],
    model: { provider: "p", id: "m" },
  };
  const compactions: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }[] = [];
  const notify = vi.fn();
  const ctx = {
    get mode() { return state.mode; }, hasUI: true, ui: { notify }, get signal() { return state.signal; },
    get model() { return state.model; },
    getContextUsage: () => ({ ...state.usage }), isIdle: () => state.idle, hasPendingMessages: () => state.pending,
    sessionManager: { getLeafId: () => state.leaf, getBranch: () => state.branch },
    compact: (opts: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => { if (state.compactThrows) throw new Error("stale"); compactions.push(opts); },
  };
  const module = new MainCompaction({ settings: () => settings, canInterrupt: options.canInterrupt ?? (() => true), schedule: fn => { queue.push(fn); } });
  module.register(pi as never);
  const emit = (name: string, event: Record<string, unknown> = {}) => (handlers.get(name) ?? []).map(handler => handler({ type: name, ...event }, ctx));
  /** Runs what the module scheduled, including what those callbacks schedule (a release polling for idle Pi: bounded). */
  const flush = () => { for (let round = 0; round < 50 && queue.length; round++) queue.shift()!(); };
  const toolTurn = (outcome = "completed") => emit("turn_end", { outcome, toolResults: [{ role: "toolResult" }] });
  /** What Pi does after `ctx.compact()` interrupted a run: an aborted response after the marker, then the manual compaction. */
  const interrupted = () => { state.branch.push({ id: `e${state.branch.length + 1}`, type: "message", message: { role: "assistant", stopReason: "error" } }); };
  const succeed = (index = compactions.length - 1) => {
    emit("session_before_compact", { reason: "manual" });
    emit("session_compact", { reason: "manual" });
    compactions[index]!.onComplete?.({});
  };
  return { emit, flush, toolTurn, interrupted, succeed, state, compactions, sent, notify, module, setSettings: (next: MainCompactionSettings) => { settings = next; } };
}

describe("MainCompaction lifecycle", () => {
  it("compacts once after a settled run above the threshold, without a continuation note", () => {
    const r = rig();
    r.state.usage.tokens = 80_001;
    r.emit("agent_settled", { aborted: false });
    expect(r.compactions).toHaveLength(0); // scheduled after Pi's settled actions
    r.flush();
    expect(r.compactions).toHaveLength(1);
    expect(r.notify.mock.calls[0]![0]).toContain("above mainCompaction 80%");
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1); // in flight: no duplicate
    r.succeed(); r.flush();
    expect(r.sent).toHaveLength(0);
  });

  it("does not compact at or below the threshold, after an aborted run, while busy or queued, or outside interactive/RPC mode", () => {
    const r = rig();
    r.state.usage.tokens = 80_000;
    r.emit("agent_settled", { aborted: false }); r.flush();
    r.state.usage.tokens = 90_000;
    r.emit("agent_settled", { aborted: true }); r.flush();
    r.state.idle = false; r.emit("agent_settled", { aborted: false }); r.flush();
    r.state.idle = true; r.state.pending = true; r.emit("agent_settled", { aborted: false }); r.flush();
    r.state.pending = false;
    for (const mode of ["print", "json"]) { r.state.mode = mode; r.emit("agent_settled", { aborted: false }); r.flush(); }
    expect(r.compactions).toHaveLength(0);
    r.state.mode = "rpc"; r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1);
  });

  it("respects mainCompaction off and Pi's compaction.enabled false (Pi's own settings stay unchanged)", () => {
    const off = rig({ settings: { ...on, enabled: false } });
    off.state.usage.tokens = 99_000;
    off.emit("agent_settled", { aborted: false }); off.toolTurn(); off.flush();
    expect(off.compactions).toHaveLength(0);
    const piOff = rig({ piSettings: { compaction: { enabled: false } } });
    piOff.state.usage.tokens = 99_000;
    piOff.emit("agent_settled", { aborted: false }); piOff.toolTurn(); piOff.flush();
    expect(piOff.compactions).toHaveLength(0);
  });

  it("mid-run: interrupts after the tool results, keeps orche's non-abort semantics once, continues with a hidden note", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn();
    expect(r.compactions).toHaveLength(1);
    expect(r.notify.mock.calls[0]![0]).toContain("continues after the summary");
    r.interrupted();
    expect(r.module.effectiveAborted(true)).toBe(false);
    expect(r.module.effectiveAborted(true)).toBe(true); // consumed once
    r.succeed();
    expect(r.sent).toHaveLength(0); // after Pi's compaction_end handlers (queued input first)
    r.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ message: { customType: MAIN_COMPACTION_RESUME_TYPE, display: false }, options: { triggerTurn: true } });
  });

  it.each([
    ["no tool results (the run ends: the settled check covers it)", (r: ReturnType<typeof rig>) => r.emit("turn_end", { outcome: "completed", toolResults: [] })],
    ["an error turn", (r: ReturnType<typeof rig>) => r.toolTurn("error")],
    ["queued user messages", (r: ReturnType<typeof rig>) => { r.state.pending = true; r.toolTurn(); }],
    ["Pi's own threshold fires before the next request", (r: ReturnType<typeof rig>) => { r.state.usage.tokens = 99_500; r.toolTurn(); }],
    ["print mode", (r: ReturnType<typeof rig>) => { r.state.mode = "print"; r.toolTurn(); }],
    ["another compaction running", (r: ReturnType<typeof rig>) => { r.emit("session_before_compact", { reason: "threshold" }); r.toolTurn(); }],
  ])("mid-run is skipped with %s", (_name, act) => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    act(r);
    expect(r.compactions).toHaveLength(0);
  });

  it("mid-run is skipped while orche holds a one-shot request or held-back input, and with midRun false", () => {
    const held = rig({ canInterrupt: () => false });
    held.state.usage.tokens = 85_000;
    held.toolTurn();
    expect(held.compactions).toHaveLength(0);
    held.emit("agent_settled", { aborted: false }); held.flush();
    expect(held.compactions).toHaveLength(1); // the settled run is compacted instead
    const noMid = rig({ settings: { ...on, midRun: false } });
    noMid.state.usage.tokens = 85_000;
    noMid.toolTurn();
    expect(noMid.compactions).toHaveLength(0);
  });

  it("never continues a run the user cancelled during the summary, and does not retry before new input", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); r.interrupted();
    r.emit("session_before_compact", { reason: "manual" });
    r.emit("session_compact_failed", { reason: "manual", aborted: true });
    r.compactions[0]!.onError?.(new Error("Compaction cancelled"));
    r.flush();
    expect(r.sent).toHaveLength(0);
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1); // blocked
    r.emit("input", { text: "go on", source: "interactive" });
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(2);
  });

  it("a failed summary continues the interrupted run once and blocks further attempts (no loop)", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); r.interrupted();
    r.emit("session_before_compact", { reason: "manual" });
    r.emit("session_compact_failed", { reason: "manual", aborted: false, errorMessage: "Compaction failed: boom" });
    r.compactions[0]!.onError?.(new Error("boom"));
    r.flush();
    expect(r.sent).toHaveLength(1);
    r.toolTurn(); r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1);
  });

  it("a compaction Pi ran first supersedes the pending attempt: ours is cancelled, the run continues, nothing is blocked", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); r.interrupted();
    r.emit("session_before_compact", { reason: "threshold" });
    r.emit("session_compact", { reason: "threshold" });
    const results = r.emit("session_before_compact", { reason: "manual" });
    expect(results).toContainEqual({ cancel: true });
    r.emit("session_compact_failed", { reason: "manual", aborted: true });
    r.compactions[0]!.onError?.(new Error("Compaction cancelled"));
    r.flush();
    expect(r.sent).toHaveLength(1);
    r.state.usage.tokens = 85_000;
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(2);
  });

  it("a prompt the user sent during the compaction replaces the continuation note", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); r.interrupted();
    r.emit("session_before_compact", { reason: "manual" });
    r.emit("session_compact", { reason: "manual" });
    r.compactions[0]!.onComplete?.({});
    r.emit("input", { text: "new instruction", source: "interactive" });
    r.flush();
    expect(r.sent).toHaveLength(0);
  });

  it("no note when the run was not actually cut off (it ended on its own) or Pi is busy again", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); // no aborted response appended
    r.succeed(); r.flush();
    expect(r.sent).toHaveLength(0);
    const busy = rig();
    busy.state.usage.tokens = 85_000;
    busy.toolTurn(); busy.interrupted(); busy.succeed();
    busy.state.idle = false; busy.flush();
    expect(busy.sent).toHaveLength(0);
  });

  it("a session switch or reload drops the attempt's callbacks", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); r.interrupted();
    r.emit("session_shutdown", { reason: "reload" });
    r.emit("session_start", { reason: "reload" });
    r.compactions[0]!.onComplete?.({});
    r.flush();
    expect(r.sent).toHaveLength(0);
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(2); // a fresh state, not stuck "in flight"
  });

  it("loop guard: a summary that leaves usage above the threshold stops the ratio until usage is below it again", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.emit("agent_settled", { aborted: false }); r.flush();
    r.succeed();
    r.state.usage.tokens = null; // Pi knows no usage until the next response
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1);
    r.state.usage.tokens = 82_000; // first measurement after our compaction: still above
    r.emit("turn_end", { outcome: "completed", toolResults: [] });
    r.emit("agent_settled", { aborted: false }); r.flush();
    r.toolTurn();
    expect(r.compactions).toHaveLength(1);
    r.state.usage.tokens = 40_000;
    r.emit("agent_settled", { aborted: false }); r.flush(); // below: re-armed
    r.state.usage.tokens = 81_000;
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(2);
  });

  it("a model switch re-evaluates against the new model's window while idle", () => {
    const r = rig();
    r.state.usage = { tokens: 120_000, contextWindow: 200_000 };
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(0); // 60% of 200K
    r.state.usage = { tokens: 120_000, contextWindow: 128_000 };
    r.state.model = { provider: "new", id: "released-today" };
    r.emit("model_select", { model: r.state.model, source: "set" }); r.flush();
    expect(r.compactions).toHaveLength(1); // 94% of 128K
  });
});

describe("MainCompaction on a restored session already above the threshold", () => {
  it("loading it compacts nothing; the first run's end (or tool turn) does", () => {
    const r = rig();
    r.state.usage.tokens = 95_000;
    r.emit("session_start", { reason: "resume" }); r.flush();
    expect(r.compactions).toHaveLength(0);
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1);
  });
});

describe("MainCompaction.deliver: orche's turn-starting messages around a compaction", () => {
  const result = (id: string) => ({ customType: "orche-task-result", content: `result ${id}`, display: true });
  const turn = { triggerTurn: true as const, deliverAs: "followUp" as const };
  const types = (r: ReturnType<typeof rig>) => r.sent.map(entry => `${entry.message.customType}:${String(entry.message.content).slice(0, 9)}:${(entry.options as { triggerTurn?: boolean }).triggerTurn}`);

  it("no compaction: sent at once, unchanged", () => {
    const r = rig();
    r.module.deliver(result("J1"), turn);
    expect(r.sent).toEqual([{ message: result("J1"), options: turn }]);
  });

  it("held from the moment the automatic compaction is requested (before Pi starts it) until it returned, then sent once in order", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.emit("agent_settled", { aborted: false }); r.flush();
    expect(r.compactions).toHaveLength(1);
    r.module.deliver(result("J1"), turn); // Pi is still aborting / preparing: no session_before_compact yet
    r.emit("session_before_compact", { reason: "manual" });
    r.module.deliver(result("J2"), turn);
    r.emit("session_compact", { reason: "manual" });
    r.flush();
    expect(r.sent).toHaveLength(0); // Pi clears its compaction state after the hooks: wait for compact() to return
    r.compactions[0]!.onComplete?.({});
    r.module.deliver(result("J3"), turn); // behind the held ones while their release is scheduled
    expect(r.sent).toHaveLength(0);
    r.flush();
    expect(types(r)).toEqual(["orche-task-result:result J1:true", "orche-task-result:result J2:true", "orche-task-result:result J3:true"]);
    r.module.deliver(result("J4"), turn);
    expect(r.sent).toHaveLength(4);
  });

  it("mid-run: the continuation note goes first, the held result behind it (Pi queues it as a follow-up of that run)", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn();
    r.module.deliver(result("J1"), turn);
    r.interrupted();
    r.succeed(); r.flush();
    expect(types(r)).toEqual([`${MAIN_COMPACTION_RESUME_TYPE}:[orche] M:true`, "orche-task-result:result J1:true"]);
  });

  it("Esc during the summary: no continuation, and the held result is shown without starting a turn", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.toolTurn(); r.interrupted();
    r.module.deliver(result("J1"), turn);
    r.emit("session_before_compact", { reason: "manual" });
    r.emit("session_compact_failed", { reason: "manual", aborted: true });
    r.compactions[0]!.onError?.(new Error("Compaction cancelled"));
    r.flush();
    expect(types(r)).toEqual(["orche-task-result:result J1:false"]);
  });

  it("a failed summary or a superseded attempt still delivers the held result with its turn (never lost, never twice)", () => {
    const failed = rig();
    failed.state.usage.tokens = 85_000;
    failed.emit("agent_settled", { aborted: false }); failed.flush();
    failed.module.deliver(result("J1"), turn);
    failed.emit("session_before_compact", { reason: "manual" });
    failed.emit("session_compact_failed", { reason: "manual", aborted: false, errorMessage: "Compaction failed: boom" });
    failed.compactions[0]!.onError?.(new Error("boom"));
    failed.flush(); failed.flush();
    expect(types(failed)).toEqual(["orche-task-result:result J1:true"]);
    const superseded = rig();
    superseded.state.usage.tokens = 85_000;
    superseded.emit("agent_settled", { aborted: false }); superseded.flush();
    superseded.module.deliver(result("J1"), turn);
    superseded.emit("session_before_compact", { reason: "threshold" });
    superseded.emit("session_compact", { reason: "threshold" });
    expect(superseded.emit("session_before_compact", { reason: "manual" })).toContainEqual({ cancel: true });
    superseded.emit("session_compact_failed", { reason: "manual", aborted: true });
    superseded.compactions[0]!.onError?.(new Error("Compaction cancelled"));
    superseded.flush();
    expect(types(superseded)).toEqual(["orche-task-result:result J1:true"]);
  });

  it("a compaction request that throws at once leaves nothing held: the next message is sent at once", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.state.compactThrows = true;
    r.emit("agent_settled", { aborted: false });
    r.flush();
    r.module.deliver(result("J1"), turn);
    r.flush();
    expect(types(r)).toEqual(["orche-task-result:result J1:true"]);
  });

  it("another manual compaction (the user's /compact): held from its start until Pi is idle again; cancelled → shown without a turn", () => {
    const r = rig();
    r.emit("session_before_compact", { reason: "manual" });
    r.module.deliver(result("J1"), turn);
    r.state.idle = false; // Pi still finishes its compaction after the hooks
    r.emit("session_compact", { reason: "manual" });
    r.flush();
    expect(r.sent).toHaveLength(0);
    r.state.idle = true;
    r.flush();
    expect(types(r)).toEqual(["orche-task-result:result J1:true"]);
    // A run started meanwhile (the user's queued prompt): Pi queues the message behind it.
    r.emit("session_before_compact", { reason: "manual" });
    r.module.deliver(result("J2"), turn);
    r.state.idle = false; r.state.signal = new AbortController().signal;
    r.emit("session_compact", { reason: "manual" }); r.flush();
    expect(types(r).at(-1)).toBe("orche-task-result:result J2:true");
    r.state.idle = true; r.state.signal = undefined;
    r.emit("session_before_compact", { reason: "manual" });
    r.module.deliver(result("J3"), turn);
    r.emit("session_compact_failed", { reason: "manual", aborted: true }); r.flush();
    expect(types(r).at(-1)).toBe("orche-task-result:result J3:false");
  });

  it("Pi's threshold or overflow compaction (inside a run, where Pi queues messages itself) holds nothing", () => {
    const r = rig();
    r.emit("session_before_compact", { reason: "threshold" });
    r.module.deliver(result("J1"), turn);
    expect(types(r)).toEqual(["orche-task-result:result J1:true"]);
  });

  it("a session shutdown keeps held messages in that session without a turn; stale callbacks and the next session get nothing of them", () => {
    const r = rig();
    r.state.usage.tokens = 85_000;
    r.emit("agent_settled", { aborted: false }); r.flush();
    r.module.deliver(result("J1"), turn);
    r.emit("session_shutdown", { reason: "reload" });
    expect(types(r)).toEqual(["orche-task-result:result J1:false"]);
    r.emit("session_start", { reason: "reload" });
    r.compactions[0]!.onComplete?.({}); // the old session's compaction returns late
    r.flush();
    expect(r.sent).toHaveLength(1);
    r.module.deliver(result("J2"), turn); // the new session: nothing pending, sent at once
    expect(types(r).at(-1)).toBe("orche-task-result:result J2:true");
  });
});
