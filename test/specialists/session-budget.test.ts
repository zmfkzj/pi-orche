import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxText as text, fauxToolCall as call, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runSpecialistSession, SpecialistError, type SpecialistBudget } from "../../src/specialists/session.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * The budget of a specialist call (MDSD search workers, src/orchestrator/mdsd.ts): one wrap-up notice at `wrapUpAt` of any
 * allocated dimension, an explicit cancellation at `hardStopAt` (a response that calls the report tool is let through), a timer
 * for the time dimension that also cancels a request in flight (its usage is then unknown), and the stats say what happened.
 * Deterministic: faux model, no real provider.
 */
const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
const report = { name: "report_answer", label: "Report answer", description: "Submit once.", parameters: Type.Object({ answer: Type.Integer() }) };
const probe: ToolDefinition = { name: "probe", label: "Probe", description: "Looks.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "seen" }], details: {} }) };
const budget = (values: Partial<SpecialistBudget>): SpecialistBudget => ({ requests: 100, minutes: 600, costUSD: 1000, outputTokens: 10_000_000, wrapUpAt: 0.8, hardStopAt: 1.25, ...values });
const notices = (context: Parameters<FauxResponseFactory>[0]) =>
  context.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Budget notice")).length;

function start(steps: FauxResponseStep[], allocation: SpecialistBudget | undefined, options: { signal?: AbortSignal } = {}) {
  return fauxRuntime(steps).then(faux => runSpecialistSession({
    actor: "W1.1", route: faux.route, runtime: faux.runtime, cwd: process.cwd(), instructions: "Search.", prompt: "Search it.",
    tools: ["probe"], customTools: [probe], report, maxTurns: 50, timeoutMs: 600_000, signal: options.signal ?? new AbortController().signal,
    ...(allocation ? { budget: allocation } : {}),
  })).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error: error as SpecialistError }));
}

afterEach(() => { vi.useRealTimers(); });

describe("specialist session: MDSD budget", () => {
  it("requests: one wrap-up notice once 80% is used; the next response may report (also past the stop line) and the stats say when the notice went out", async () => {
    const seen: number[] = [];
    const answer: FauxResponseStep = context => { seen.push(notices(context)); return notices(context) ? tool("report_answer", { answer: 7 }) : tool("probe", {}); };
    // 4 requests allocated: after response 4 the ratio is 1.0 (>= 0.8: notice); response 5 reaches 1.25 but calls the report tool.
    const { value } = await start([tool("probe", {}), tool("probe", {}), tool("probe", {}), tool("probe", {}), answer, reply("done")], budget({ requests: 4 }));
    expect(value?.value).toEqual({ answer: 7 });
    expect(seen).toEqual([1]);
    expect(value?.stats.budget).toEqual({ wrapUp: "4/4 requests" });
  });

  it("requests: a model that ignores the notice is cancelled explicitly at hardStopAt; the error and the stats name the dimension", async () => {
    const { error } = await start(Array.from({ length: 12 }, () => tool("probe", {})), budget({ requests: 4 }));
    expect(error).toBeInstanceOf(SpecialistError);
    expect(error!.cancelled).toBe(false);
    expect(error!.message).toBe("W1.1: budget: requests at 5/4 requests (1.25x the allocation)");
    expect(error!.stats.requests).toBe(5);
    expect(error!.stats.budget).toEqual({ wrapUp: "4/4 requests", stoppedBy: "requests at 5/4 requests (1.25x the allocation)" });
  });

  it("output tokens: the provider-reported usage after each response counts; the response that crosses the line is measured, not cut", async () => {
    // The faux provider reports ceil(chars / 4) output tokens: 4000 x's plus "\nprobe:{}" = 1003 tokens per response.
    const long = () => reply([text("x".repeat(4000)), call("probe", {})], { stopReason: "toolUse" });
    const { error } = await start(Array.from({ length: 8 }, long), budget({ outputTokens: 2000 }));
    expect(error!.message).toBe("W1.1: budget: output tokens at 3009/2000 output tokens (1.25x the allocation)");
    expect(error!.stats.usage.output).toBe(3009);
    expect(error!.stats.budget).toEqual({ wrapUp: "2006/2000 output tokens", stoppedBy: "output tokens at 3009/2000 output tokens (1.25x the allocation)" });
  });

  it("a model that keeps sending invalid reports past the stop line gets REPORT_EXEMPTIONS attempts, then the stop", async () => {
    const invalid = () => tool("report_answer", { answer: "seven" });
    const { error } = await start([tool("probe", {}), tool("probe", {}), tool("probe", {}), tool("probe", {}), invalid(), invalid(), invalid(), invalid()], budget({ requests: 4 }));
    expect(error!.message).toBe("W1.1: budget: requests at 7/4 requests (1.25x the allocation)");
    expect(error!.stats.requests).toBe(7);
  });

  it("time: the timer cancels a request in flight at hardStopAt; its usage is marked unknown, the caller's signal is untouched", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(0);
    const hang: FauxResponseStep = async (_context, options) => {
      await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return reply("aborted");
    };
    const caller = new AbortController();
    const settled = start([tool("probe", {}), hang], budget({ minutes: 1 }), { signal: caller.signal });
    let done = false;
    void settled.then(() => { done = true; });
    for (let step = 0; step < 40 && !done; step++) await vi.advanceTimersByTimeAsync(5_000);
    const { error } = await settled;
    expect(error).toBeInstanceOf(SpecialistError);
    expect(error!.message).toMatch(/^W1\.1: budget: time at 1\.[23]\/1 min \(1\.25x the allocation\)$/);
    expect(error!.stats.budget).toMatchObject({ wrapUp: "0.8/1 min", inFlightUnknown: true });
    expect(error!.stats.durationMs).toBeGreaterThanOrEqual(75_000);
    expect(error!.stats.durationMs).toBeLessThan(85_000);
    expect(caller.signal.aborted).toBe(false);
  });

  it("the caller's cancellation still wins and is reported as cancelled, with what the budget saw so far", async () => {
    const caller = new AbortController();
    const cancel: FauxResponseStep = () => { caller.abort(new Error("cancelled by the orchestrator")); return tool("probe", {}); };
    const { error } = await start([tool("probe", {}), cancel, tool("probe", {})], budget({ requests: 100 }), { signal: caller.signal });
    expect(error!.cancelled).toBe(true);
    // The response running when the caller cancelled ended aborted: its usage is unknown, and the stats say so.
    expect(error!.stats.budget).toEqual({ inFlightUnknown: true });
  });

  it("no budget: nothing changes (no notice, no stop, no budget stats)", async () => {
    const { value } = await start([tool("probe", {}), tool("probe", {}), tool("probe", {}), tool("probe", {}), tool("probe", {}), tool("report_answer", { answer: 1 }), reply("done")], undefined);
    expect(value?.value).toEqual({ answer: 1 });
    expect(value?.stats.budget).toBeUndefined();
  });
});
