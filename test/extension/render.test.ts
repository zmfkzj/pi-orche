import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  COLLAPSED_LINES, STALE_RENDER_MS, TICK_MS, createOrcheRenderers, formatElapsed, orcheRunRenderers, orcheTaskRenderers,
  type OrcheRenderContext,
} from "../../src/extension/render.js";
import { extendDeadline, initialDeadline, type DeadlineInfo } from "../../src/extension/progress.js";

/**
 * The renderers of orche_run / orche_task, driven the way pi's ToolExecutionComponent drives them (updateDisplay: renderCall, then renderResult when
 * a result exists; `context.invalidate()` re-runs both and asks for a repaint), under fake timers. A tool block is "drawn" by calling `render()` on
 * the components, as the TUI does on every repaint.
 */
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

/** Colours become `<name>text</name>` and bold `**text**`, so what is asserted is which theme colour a piece of text got. */
const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `**${text}**` } as unknown as Theme;
const plain = (text: string) => text.replace(/<\/?[a-zA-Z]+>/g, "").replace(/\*\*/g, "");
const isWide = (code: number) => code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3));
const cells = (text: string) => [...plain(text)].reduce((sum, char) => sum + (isWide(char.codePointAt(0) ?? 0) ? 2 : 1), 0);

type Result = { content: { type: "text"; text: string }[]; details?: unknown };
const textResult = (text: string, details?: unknown): Result => ({ content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) });

const baseline = (extra: Partial<DeadlineInfo> = {}): DeadlineInfo => ({ ...initialDeadline(30 * MINUTE, { extensionMs: 30 * MINUTE, maxExtensions: 10 }, T0), ...extra });
/** A partial update as index.ts sends it (`null`: one without deadline info). */
const partial = (lines: string[], deadline: DeadlineInfo | null = baseline(), startedAt = T0): Result =>
  textResult(lines.join("\n"), { progress: lines, startedAt, ...(deadline ? { deadline } : {}) });

class Host {
  readonly state: Record<string, unknown> = {};
  invalidations = 0;
  result: Result | undefined;
  isPartial = true;
  isError = false;
  expanded = false;
  started = false;
  call: any;
  body: any;
  constructor(private readonly renderers = orcheRunRenderers, private readonly args: unknown = { request: "Fix the login redirect" }, private readonly withState = true) {}

  private context(): OrcheRenderContext {
    return {
      args: this.args, toolCallId: "call-1", invalidate: () => { this.invalidations++; this.update(); }, lastComponent: undefined,
      state: this.withState ? this.state : undefined, cwd: "/work", executionStarted: this.started, argsComplete: true,
      isPartial: this.isPartial, expanded: this.expanded, showImages: false, isError: this.isError,
    } as unknown as OrcheRenderContext;
  }
  /** ToolExecutionComponent.updateDisplay */
  update(): void {
    this.call = this.renderers.renderCall(this.args as never, theme, this.context());
    this.body = this.result ? this.renderers.renderResult(this.result as never, { expanded: this.expanded, isPartial: this.isPartial }, theme, this.context()) : undefined;
  }
  start(): this { this.started = true; this.update(); return this; }
  /** A partial update of the tool arrives. */
  receive(result: Result): this { this.result = result; this.isPartial = true; this.update(); return this; }
  finish(result: Result, isError = false): this { this.result = result; this.isPartial = false; this.isError = isError; this.update(); return this; }
  expand(expanded: boolean): this { this.expanded = expanded; this.update(); return this; }
  /** One TUI repaint. */
  draw(width = 100): string[] { return [...this.call.render(width), ...(this.body?.render(width) ?? [])]; }
  drawPlain(width = 100): string[] { return this.draw(width).map(plain); }
  dispose(): void { this.call.dispose?.(); this.body?.dispose?.(); }
  /** Let `ms` pass one repaint-sized step at a time, repainting after each as the TUI does. */
  async pass(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= TICK_MS) { await vi.advanceTimersByTimeAsync(Math.min(TICK_MS, left)); this.draw(); }
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("formatElapsed", () => {
  it.each([
    [0, "0s"], [999, "0s"], [1_000, "1s"], [45_999, "45s"], [60_000, "1m 00s"], [12 * MINUTE + 34_000, "12m 34s"],
    [41 * MINUTE + 7_000, "41m 07s"], [59 * MINUTE + 59_000, "59m 59s"], [60 * MINUTE, "1h 00m 00s"], [65 * MINUTE + 7_000, "1h 05m 07s"],
    [5.5 * 60 * MINUTE, "5h 30m 00s"], [-5, "0s"],
  ])("%d ms is %s", (ms, text) => { expect(formatElapsed(ms)).toBe(text); });
});

describe("a running call", () => {
  it("shows a live timer with the cap and the extensions in the header, and the progress lines below it", async () => {
    const host = new Host().start();
    host.receive(partial(["phase EXECUTE", "W1 implement · 14 requests · last tool: edit"]));
    expect(host.drawPlain()).toEqual([
      "orche_run Fix the login redirect",
      "⏱ 0s / 30m · ext 0/10",
      "phase EXECUTE",
      "W1 implement · 14 requests · last tool: edit",
    ]);
    // theme colours: bold tool title, accent elapsed, muted cap / extension count, tool output for the lines
    expect(host.draw()).toEqual([
      "<toolTitle>**orche_run**</toolTitle> <muted>Fix the login redirect</muted>",
      "<accent>⏱ 0s</accent><muted> / 30m</muted><muted> · ext 0/10</muted>",
      "<toolOutput>phase EXECUTE</toolOutput>",
      "<toolOutput>W1 implement · 14 requests · last tool: edit</toolOutput>",
    ]);
  });

  it("ticks every second even when no progress event arrives", async () => {
    const host = new Host().start();
    host.receive(partial(["phase EXECUTE"]));
    expect(host.invalidations).toBe(0);
    await host.pass(TICK_MS);
    expect(host.invalidations).toBe(1);
    expect(host.drawPlain()[1]).toBe("⏱ 1s / 30m · ext 0/10");
    await host.pass(12 * MINUTE + 34_000 - TICK_MS); // 12m 34s in all, with no update from the tool
    expect(host.invalidations).toBe(754);
    expect(host.drawPlain()[1]).toBe("⏱ 12m 34s / 30m · ext 0/10");
    expect(host.drawPlain().slice(2)).toEqual(["phase EXECUTE"]);
  });

  it("ticks before the first update too, from the moment execution started, and shows the cap once an update brings it", async () => {
    const host = new Host().start();
    expect(host.drawPlain()).toEqual(["orche_run Fix the login redirect", "⏱ 0s"]);
    await host.pass(3_000);
    expect(host.invalidations).toBe(3);
    expect(host.drawPlain()[1]).toBe("⏱ 3s");
    host.receive(partial([]));
    expect(host.drawPlain()).toEqual(["orche_run Fix the login redirect", "⏱ 3s / 30m · ext 0/10"]);
  });

  it("counts from details.startedAt (the real start), not from when the block was first drawn", async () => {
    const host = new Host().start();
    host.receive(partial(["x"], baseline(), T0 - 90_000)); // the call started 90 s before this renderer saw it
    expect(host.drawPlain()[1]).toBe("⏱ 1m 30s / 30m · ext 0/10");
  });

  it("shows the extensions and the new cap after a deadline_extended update, and keeps them current", async () => {
    const host = new Host().start();
    host.receive(partial(["phase EXECUTE"]));
    await host.pass(29 * MINUTE);
    expect(host.drawPlain()[1]).toBe("⏱ 29m 00s / 30m · ext 0/10");
    const extended = extendDeadline(baseline(), { n: 1, max: 10, extensionMs: 30 * MINUTE, scope: "overall", overallDeadline: T0 + 60 * MINUTE }, T0);
    await host.pass(2 * MINUTE);
    host.receive(partial(["phase EXECUTE", "⏱ timeout extended 1/10 (+30m): W2 bash running 12m, cpu progressing"], extended));
    expect(host.drawPlain().slice(0, 2)).toEqual(["orche_run Fix the login redirect", "⏱ 31m 00s / 1h · ext 1/10"]);
    expect(host.draw()[1]).toBe("<accent>⏱ 31m 00s</accent><muted> / 1h</muted><warning> · ext 1/10</warning>");
    const again = extendDeadline(extended, { n: 2, max: 10, extensionMs: 30 * MINUTE, scope: "overall", overallDeadline: T0 + 90 * MINUTE }, T0);
    host.receive(partial(["⏱ timeout extended 2/10 (+30m): W2 bash running 42m"], again));
    expect(host.drawPlain()[1]).toBe("⏱ 31m 00s / 1h30m · ext 2/10");
    // and it goes on ticking against the new cap
    await host.pass(MINUTE);
    expect(host.drawPlain()[1]).toBe("⏱ 32m 00s / 1h30m · ext 2/10");
  });

  it("warns when the elapsed time is past the cap", async () => {
    const host = new Host().start();
    host.receive(partial(["x"], baseline({ capMs: 10 * MINUTE })));
    await host.pass(11 * MINUTE);
    expect(host.draw()[1]).toBe("<accent>⏱ 11m 00s</accent><warning> / 10m</warning><muted> · ext 0/10</muted>");
  });

  it("falls back to the extension line of the progress when the update carries no deadline", async () => {
    const host = new Host().start();
    host.receive(partial(["⏱ timeout extended 3/10 (+30m): still active"], null));
    expect(host.drawPlain()[1]).toBe("⏱ 0s · ext 3/10");
  });

  it("shows no extension count when extending is off (maxExtensions 0)", async () => {
    const host = new Host().start();
    host.receive(partial(["x"], initialDeadline(15 * MINUTE, { extensionMs: 30 * MINUTE, maxExtensions: 0 }, T0)));
    expect(host.drawPlain()[1]).toBe("⏱ 0s / 15m");
  });

  it("is not thrown by malformed details", async () => {
    const host = new Host().start();
    host.receive(textResult("x", { startedAt: "soon", deadline: { capMs: "30m", extensionsUsed: null }, progress: [1, null, "ok"], extensions: [5] }));
    expect(host.drawPlain()).toEqual(["orche_run Fix the login redirect", "⏱ 0s", "ok"]);
  });

  it("shows an orche_task header with its role and worker, and the request when expanded", async () => {
    const host = new Host(orcheTaskRenderers, { role: "implement", worker: "W2", request: "Add the retry\nwith backoff", files: ["src/a.ts"], git: { commit: true } }).start();
    host.receive(partial(["W2 implement · 3 requests"]));
    expect(host.drawPlain()).toEqual(["orche_task implement W2 · Add the retry with backoff", "⏱ 0s / 30m · ext 0/10", "W2 implement · 3 requests"]);
    host.expand(true);
    expect(host.drawPlain()).toEqual([
      "orche_task implement W2 · Add the retry with backoff",
      "⏱ 0s / 30m · ext 0/10",
      "  request: Add the retry", "    with backoff",
      "  role: implement · worker: W2", "  files: src/a.ts", '  git: {"commit":true}',
      "W2 implement · 3 requests",
    ]);
  });

  it("keeps the header and the timer in both views, and collapses long progress to its newest lines", async () => {
    const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
    const host = new Host().start();
    host.receive(partial(lines));
    const collapsed = host.drawPlain();
    expect(collapsed.slice(0, 2)).toEqual(["orche_run Fix the login redirect", "⏱ 0s / 30m · ext 0/10"]);
    expect(collapsed[2]).toMatch(/^\.\.\. \(4 earlier lines, .* to expand\)$/);
    expect(collapsed.slice(3)).toEqual(lines.slice(4));
    expect(collapsed.slice(3)).toHaveLength(COLLAPSED_LINES);
    const expanded = host.expand(true).drawPlain();
    expect(expanded.slice(0, 2)).toEqual(collapsed.slice(0, 2));
    expect(expanded.filter(line => line.startsWith("line "))).toEqual(lines);
    expect(expanded.join("\n")).not.toContain("to expand");
  });

  it("repaints within the width it is given, wide characters and long lines included", async () => {
    const host = new Host(orcheRunRenderers, { request: "로그인 리다이렉트를 고쳐줘 ".repeat(8) }).start();
    host.receive(partial(["⚠ 1 other pi session active in this repository (cwd /work/repo, last write 30s ago); their changes are classified as external where possible", "W1 implement · 14 requests"]));
    for (const width of [80, 40, 24, 12]) {
      const lines = host.draw(width);
      expect(Math.max(...lines.map(cells)), `width ${width}`).toBeLessThanOrEqual(width);
      expect(lines.map(plain).join(" ")).toContain("W1 implement");
    }
    host.expand(true);
    for (const width of [80, 24]) expect(Math.max(...host.draw(width).map(cells)), `expanded, width ${width}`).toBeLessThanOrEqual(width);
  });
});

describe("the timer's lifecycle", () => {
  it("runs one interval for the whole call, however often the block is re-rendered", async () => {
    const host = new Host().start();
    expect(vi.getTimerCount()).toBe(1);
    for (let index = 0; index < 20; index++) host.receive(partial([`update ${index}`]));
    for (let index = 0; index < 20; index++) host.update();
    host.expand(true).expand(false);
    expect(vi.getTimerCount()).toBe(1);
    await host.pass(5_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(host.invalidations).toBe(5);
  });

  it("stops at the final result: no more repaints, no timer, and the text no longer changes", async () => {
    const host = new Host().start();
    host.receive(partial(["phase EXECUTE"]));
    await host.pass(5_000);
    const done = baseline({ extensionsUsed: 1, capMs: 60 * MINUTE });
    host.finish(textResult("orche finished (change, 2467s, 213 model requests; project config)\n\nDone.", { progress: [], startedAt: T0, finishedAt: T0 + 41 * MINUTE + 7_000, durationMs: 2_462_000, deadline: done }));
    expect(vi.getTimerCount()).toBe(0);
    const repaints = host.invalidations;
    const shown = host.drawPlain();
    expect(shown[1]).toBe("took 41m 07s · ext 1/10"); // finishedAt - startedAt wins over durationMs
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(host.invalidations).toBe(repaints);
    expect(host.drawPlain()).toEqual(shown);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a success", false],
    ["a failure or a cancellation (an error result)", true],
  ])("is cleared by %s", async (_name, isError) => {
    const host = new Host().start();
    host.receive(partial(["phase EXECUTE"]));
    expect(vi.getTimerCount()).toBe(1);
    host.finish(textResult("text", { startedAt: T0, finishedAt: T0 + 5_000, deadline: baseline() }), isError);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.drawPlain()[1]).toBe("took 5s");
  });

  it("is cleared by a final result that arrives without any partial update (an error thrown before a run existed)", async () => {
    const host = new Host().start();
    await host.pass(4_000);
    host.finish(textResult("An orche run is already active in this session", {}), true);
    expect(vi.getTimerCount()).toBe(0);
    // no timing details at all: what this renderer watched is all there is
    expect(host.drawPlain()[1]).toBe("took 4s");
  });

  it("is cleared when the host disposes the block, and an update after that starts exactly one again", async () => {
    const host = new Host().start();
    host.receive(partial(["a"]));
    expect(vi.getTimerCount()).toBe(1);
    host.dispose();
    expect(vi.getTimerCount()).toBe(0);
    host.receive(partial(["b"]));
    host.receive(partial(["c"]));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("is not cleared by the dispose of a block that was already replaced by a newer render", async () => {
    const host = new Host().start();
    const replaced = host.call;
    host.update();
    replaced.dispose();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops by itself when nothing has drawn the block for a while (it left the screen), and restarts with the next update", async () => {
    const host = new Host().start();
    host.receive(partial(["a"]));
    // nothing repaints the block: the host dropped it without telling us
    await vi.advanceTimersByTimeAsync(STALE_RENDER_MS + 2 * TICK_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.invalidations).toBeLessThanOrEqual(STALE_RENDER_MS / TICK_MS + 1);
    const seen = host.invalidations;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.invalidations).toBe(seen);
    host.receive(partial(["b"]));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps ticking for as long as a repainted block runs: 1000 ticks, still one timer", async () => {
    const host = new Host().start();
    host.receive(partial(["a"]));
    await host.pass(1000 * TICK_MS);
    expect(host.invalidations).toBe(1000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("starts nothing for a call that is not executing (arguments still streaming, or an orphaned call of a reloaded session)", async () => {
    const host = new Host();
    host.update();
    host.update();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.drawPlain()).toEqual(["orche_run Fix the login redirect"]);
  });

  it("starts no timer when the host gives no persistent state (it could never be stopped)", async () => {
    const host = new Host(orcheRunRenderers, { request: "x" }, false).start();
    host.receive(partial(["a"]));
    expect(vi.getTimerCount()).toBe(0);
    expect(host.drawPlain()[1]).toBe("⏱ 0s");
  });

  it("does not keep the process alive (the interval is unref'ed)", async () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation((() => ({ unref, ref: vi.fn() })) as never);
    try {
      new Host().start().receive(partial(["a"]));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toBe(TICK_MS);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});

describe("a finished call", () => {
  const finalDetails = { progress: ["phase DONE"], startedAt: T0, finishedAt: T0 + 41 * MINUTE + 7_000, durationMs: 41 * MINUTE + 5_000, deadline: baseline({ extensionsUsed: 1, capMs: 60 * MINUTE }) };

  it("shows the duration from the details, not from the clock: the same after a reload, a re-render and a day later", async () => {
    const live = new Host().start();
    live.receive(partial(["phase EXECUTE"]));
    live.finish(textResult("Report", finalDetails));
    expect(live.drawPlain()[1]).toBe("took 41m 07s · ext 1/10");

    vi.setSystemTime(T0 + 24 * 60 * MINUTE);
    // a session reload: a fresh block with the final result at once, never executing, no live state
    const reloaded = new Host().finish(textResult("Report", finalDetails));
    expect(reloaded.drawPlain()).toEqual(["orche_run Fix the login redirect", "took 41m 07s · ext 1/10", "Report"]);
    expect(reloaded.draw()[1]).toBe("<muted>took 41m 07s</muted><muted> · ext 1/10</muted>");
    reloaded.expand(true).expand(false);
    expect(reloaded.drawPlain()[1]).toBe("took 41m 07s · ext 1/10");
    expect(live.drawPlain()[1]).toBe("took 41m 07s · ext 1/10");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses durationMs for results that carry no startedAt/finishedAt (recorded before they existed)", async () => {
    const legacy = new Host().finish(textResult("Report", { durationMs: 125_000, progress: [] }));
    expect(legacy.drawPlain()[1]).toBe("took 2m 05s");
    const task = new Host(orcheTaskRenderers, { role: "explore", request: "x" }).finish(textResult("Report", { worker: "W1", durationMs: 7_000, extensions: [{ n: 1, max: 10 }, { n: 2, max: 10 }] }));
    expect(task.drawPlain()[1]).toBe("took 7s · ext 2/10");
  });

  it("shows nothing of the timing for a result without any, when it was not watched live", async () => {
    const bare = new Host().finish(textResult("Something went wrong", {}), true);
    expect(bare.drawPlain()).toEqual(["orche_run Fix the login redirect", "Something went wrong"]);
  });

  it("shows ext only when extensions were used", async () => {
    const none = new Host().finish(textResult("Report", { ...finalDetails, deadline: baseline() }));
    expect(none.drawPlain()[1]).toBe("took 41m 07s");
  });

  it("shows the result text as the host would: first lines collapsed with a hint, everything expanded; the header stays", async () => {
    const report = Array.from({ length: 25 }, (_, index) => `report ${index + 1}`);
    const host = new Host().finish(textResult(report.join("\n"), finalDetails));
    const collapsed = host.drawPlain();
    expect(collapsed.slice(0, 2)).toEqual(["orche_run Fix the login redirect", "took 41m 07s · ext 1/10"]);
    expect(collapsed.slice(2, 12)).toEqual(report.slice(0, 10));
    expect(collapsed[12]).toMatch(/^\.\.\. \(15 more lines, .* to expand\)$/);
    const expanded = host.expand(true).drawPlain();
    expect(expanded.slice(0, 2)).toEqual(collapsed.slice(0, 2));
    expect(expanded.filter(line => line.startsWith("report "))).toEqual(report);
    expect(expanded.join("\n")).not.toContain("to expand");
  });

  it("strips escape sequences from the text before drawing it", async () => {
    const host = new Host().finish(textResult("\u001b[31mred\u001b[0m and \u001b]8;;http://x\u0007link\u001b]8;;\u0007\tend", finalDetails));
    expect(host.drawPlain()[2]).toBe("red and link   end");
  });

  it("never touches the result it renders (the model-facing content stays as it was)", async () => {
    const result = textResult("Report text", finalDetails);
    const copy = structuredClone(result);
    const host = new Host().start();
    host.receive(partial(["a"]));
    host.finish(result);
    host.drawPlain();
    expect(result).toEqual(copy);
  });

  describe("the model line of an orche_task error result", () => {
    const ran = { worker: "W1", role: "implement", status: "no_result", model: "openai/gpt-5", thinking: "high", models: { "openai/gpt-5": 3 }, durationMs: 7_000 };
    const task = () => new Host(orcheTaskRenderers, { role: "implement", request: "x" });
    it("is drawn from the details after the message's first line and its model warnings; the content stays as it was", async () => {
      const result = textResult("Still no report\nWarning: main model is absent; using configured route a/b.\n\nRecord: /r", ran);
      const copy = structuredClone(result);
      expect(task().finish(result, true).drawPlain().slice(2)).toEqual(["Still no report", "Warning: main model is absent; using configured route a/b.", "Model: openai/gpt-5 · thinking high", "", "Record: /r"]);
      expect(result).toEqual(copy);
    });
    it("follows a leading concurrent-session warning like the success text, and shows several models and unknown values honestly", async () => {
      const warned = task().finish(textResult("Warning: another pi session\n\nWorker W1 timed out after 150ms", { ...ran, models: { "openai/gpt-5": 2, "openai/gpt-5-mini": 1 } }), true);
      expect(warned.drawPlain().slice(2)).toEqual(["Warning: another pi session", "", "Worker W1 timed out after 150ms", "Model: openai/gpt-5 ×2, openai/gpt-5-mini ×1 · thinking high"]);
      expect(task().finish(textResult("cancelled", { worker: "W1" }), true).drawPlain().slice(1)).toEqual(["cancelled", "Model: model unknown · thinking unknown"]);
    });
    it("is not added to a success (its text has the line), an error before any worker ran, or another tool", async () => {
      expect(task().finish(textResult("orche task W1 (implement, 7s, 3 requests; c)\nModel: openai/gpt-5 · thinking high", ran)).drawPlain().slice(2)).toEqual(["orche task W1 (implement, 7s, 3 requests; c)", "Model: openai/gpt-5 · thinking high"]);
      expect(task().finish(textResult("Unknown worker W9", {}), true).drawPlain().slice(1)).toEqual(["Unknown worker W9"]);
      expect(new Host().finish(textResult("Run failed", ran), true).drawPlain().slice(2)).toEqual(["Run failed"]);
    });
  });
});

describe("createOrcheRenderers", () => {
  it("titles the block with the tool's name", () => {
    const host = new Host(createOrcheRenderers("orche_custom"), { request: "x" }).start();
    expect(host.drawPlain()[0]).toBe("orche_custom x");
  });
});

describe("redrawing", () => {
  it("shows state changes without re-rendering the components (the lines are built at draw time)", async () => {
    const host = new Host().start();
    host.receive(partial(["a"]));
    const call = host.call;
    expect(plain(call.render(80)[1])).toBe("⏱ 0s / 30m · ext 0/10");
    vi.setSystemTime(T0 + 61_000);
    expect(plain(call.render(80)[1])).toBe("⏱ 1m 01s / 30m · ext 0/10");
    call.invalidate();
    expect(plain(call.render(80)[1])).toBe("⏱ 1m 01s / 30m · ext 0/10");
  });
});

// The same renderers inside pi's own ToolExecutionComponent (the real host: its shell, its render context, its invalidate -> requestRender path).
describe("inside pi's ToolExecutionComponent", () => {
  const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

  function block(args: unknown = { request: "Fix the login redirect" }) {
    initTheme();
    const ui = { requestRender: vi.fn() };
    const definition = { name: "orche_run", label: "orche", description: "d", parameters: {}, execute: async () => ({ content: [], details: {} }), ...orcheRunRenderers };
    const component = new ToolExecutionComponent("orche_run", "call-1", args, {}, definition as never, ui as never, "/work");
    const lines = () => component.render(80).map(strip).map(line => line.trim()).filter(line => line !== "");
    return { component, ui, lines };
  }

  it("ticks, repaints and stops: a live block, then the final one", async () => {
    const { component, ui, lines } = block();
    component.setArgsComplete();
    component.markExecutionStarted();
    expect(vi.getTimerCount()).toBe(1);
    component.updateResult({ content: [{ type: "text", text: "phase EXECUTE" }], details: { progress: ["phase EXECUTE"], startedAt: T0, deadline: baseline() } } as never, true);
    expect(lines()).toEqual(["orche_run Fix the login redirect", "⏱ 0s / 30m · ext 0/10", "phase EXECUTE"]);
    const asked = ui.requestRender.mock.calls.length;
    for (let second = 1; second <= 90; second++) { await vi.advanceTimersByTimeAsync(TICK_MS); lines(); } // the TUI repaints
    expect(ui.requestRender.mock.calls.length - asked).toBe(90);
    expect(lines()[1]).toBe("⏱ 1m 30s / 30m · ext 0/10");
    expect(vi.getTimerCount()).toBe(1);

    component.updateResult({ content: [{ type: "text", text: "orche finished\n\nDone." }], details: { startedAt: T0, finishedAt: T0 + 41 * MINUTE + 7_000, deadline: baseline({ extensionsUsed: 1, capMs: 60 * MINUTE }) } } as never, false);
    expect(vi.getTimerCount()).toBe(0);
    expect(lines()).toEqual(["orche_run Fix the login redirect", "took 41m 07s · ext 1/10", "orche finished", "Done."]);
    const after = ui.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(ui.requestRender.mock.calls.length).toBe(after);
  });

  it("shows a reloaded finished result at once, with no timer", async () => {
    const { component, lines } = block();
    component.updateResult({ content: [{ type: "text", text: "Report" }], details: { startedAt: T0, finishedAt: T0 + 125_000, durationMs: 124_000 } } as never, false);
    expect(vi.getTimerCount()).toBe(0);
    expect(lines()).toEqual(["orche_run Fix the login redirect", "took 2m 05s", "Report"]);
  });

  it("expands and collapses with the host's own toggle, the header staying", async () => {
    const { component, lines } = block();
    component.markExecutionStarted();
    const progress = Array.from({ length: 13 }, (_, index) => `step ${index + 1}`);
    component.updateResult({ content: [{ type: "text", text: progress.join("\n") }], details: { progress, startedAt: T0, deadline: baseline() } } as never, true);
    const collapsed = lines();
    expect(collapsed.slice(0, 2)).toEqual(["orche_run Fix the login redirect", "⏱ 0s / 30m · ext 0/10"]);
    expect(collapsed.filter(line => line.startsWith("step "))).toHaveLength(COLLAPSED_LINES);
    component.setExpanded(true);
    const expanded = lines();
    expect(expanded.slice(0, 2)).toEqual(collapsed.slice(0, 2));
    expect(expanded.filter(line => line.startsWith("step "))).toEqual(progress);
    expect(vi.getTimerCount()).toBe(1);
  });
});
