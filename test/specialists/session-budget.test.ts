import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxText as text, fauxToolCall as call, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runSpecialistSession, SpecialistError, type SpecialistBudget } from "../../src/specialists/session.js";
import { fauxRuntime } from "../helpers/faux.js";

/**
 * The budget of a specialist call (MDSD search workers, src/orchestrator/mdsd.ts): one wrap-up notice at `wrapUpAt` of the cost,
 * output-token or time allocation, an explicit cancellation at `hardStopAt` (a response that calls the report tool is let through),
 * a timer for the time dimension that also cancels a request in flight (its usage is then unknown), and the stats say what
 * happened. Requests are no budget dimension: `requestCheckpoint` (the allocation's requests, as sub-worker.ts passes it) is one
 * progress notice that keeps the session going. No turn cap (as orche_spawn runs sub-workers). Deterministic: faux model.
 */
const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
const report = { name: "report_answer", label: "Report answer", description: "Submit once.", parameters: Type.Object({ answer: Type.Integer() }) };
const probe: ToolDefinition = { name: "probe", label: "Probe", description: "Looks.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "seen" }], details: {} }) };
const budget = (values: Partial<SpecialistBudget>): SpecialistBudget => ({ requests: 100, minutes: 600, costUSD: 1000, outputTokens: 10_000_000, wrapUpAt: 0.8, hardStopAt: 1.25, ...values });
const notices = (context: Parameters<FauxResponseFactory>[0], marker = "Budget notice") =>
  context.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(marker)).length;

function start(steps: FauxResponseStep[], allocation: SpecialistBudget | undefined, options: { signal?: AbortSignal } = {}) {
  return fauxRuntime(steps).then(faux => runSpecialistSession({
    actor: "W1.1", route: faux.route, runtime: faux.runtime, cwd: process.cwd(), instructions: "Search.", prompt: "Search it.",
    tools: ["probe"], customTools: [probe], report, timeoutMs: 600_000, signal: options.signal ?? new AbortController().signal,
    ...(allocation ? { budget: allocation, requestCheckpoint: allocation.requests } : {}),
  })).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error: error as SpecialistError }));
}

afterEach(() => { vi.useRealTimers(); });

describe("specialist session: MDSD budget", () => {
  it("requests: one progress checkpoint at the allocation tells the session to keep going; no wrap-up, and work runs past the old 1.25x stop and report exemptions", async () => {
    const seen: [number, number][] = [];
    const probeOn: FauxResponseStep = context => { seen.push([notices(context, "Progress checkpoint"), notices(context)]); return tool("probe", {}); };
    // 4 requests allocated: the old ladder noticed after response 4 and stopped at 5 (7 with the report exemptions); this run reports at 13.
    const { value, error } = await start([...Array.from({ length: 12 }, () => probeOn), tool("report_answer", { answer: 7 }), reply("done")], budget({ requests: 4 }));
    expect(error).toBeUndefined();
    expect(value?.value).toEqual({ answer: 7 });
    expect(value?.stats.requests).toBe(13);
    // The checkpoint reaches request 5 on; it is sent once, and no budget notice ever goes out.
    expect(seen.map(([checkpoints]) => checkpoints)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(seen.every(([, budgetNotices]) => budgetNotices === 0)).toBe(true);
    expect(value?.stats.budget).toBeUndefined();
  });

  it("a request checkpoint does not suppress a real limit: the output-token wrap-up still goes out and invalid reports past the stop get REPORT_EXEMPTIONS attempts", async () => {
    const long = () => reply([text("x".repeat(4000)), call("probe", {})], { stopReason: "toolUse" });
    const invalid = () => reply([text("x".repeat(4000)), call("report_answer", { answer: "seven" } as never)], { stopReason: "toolUse" });
    // Checkpoint after response 1, wrap-up after response 2 (2006/2000), responses 3 and 4 cross the stop but report (exempted), 5 is stopped.
    const { error } = await start([long(), long(), invalid(), invalid(), invalid(), invalid()], budget({ requests: 1, outputTokens: 2000 }));
    expect(error!.message).toMatch(/^W1\.1: budget: output tokens at \d+\/2000 output tokens \(1\.25x the allocation\)$/);
    expect(error!.stats.requests).toBe(5);
    expect(error!.stats.budget).toMatchObject({ wrapUp: "2006/2000 output tokens" });
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
