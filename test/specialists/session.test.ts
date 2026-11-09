import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { runSpecialistSession, SpecialistError, type SpecialistWrapUp } from "../../src/specialists/session.js";
import { fauxRuntime } from "../helpers/faux.js";

const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
const report = { name: "report_answer", label: "Report answer", description: "Submit once.", parameters: Type.Object({ answer: Type.Integer({ minimum: 0 }) }), check: (value: { answer: number }) => value.answer === 13 ? "13 is unlucky." : undefined };

async function run(steps: Parameters<typeof fauxRuntime>[0], options: { maxTurns?: number | null; requestCheckpoint?: number; signal?: AbortSignal; onSession?: (use: { model: string; thinking?: string }) => void; wrapUp?: SpecialistWrapUp; timeoutMs?: number; unbounded?: boolean } = {}) {
  const faux = await fauxRuntime(steps);
  return runSpecialistSession({
    actor: "framer:W1", route: faux.route, runtime: faux.runtime, cwd: process.cwd(), instructions: "Answer.", prompt: "What is 6 * 7?",
    tools: ["ls"], report, ...(options.maxTurns === null ? {} : { maxTurns: options.maxTurns ?? 5 }), timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal ?? new AbortController().signal,
    ...(options.onSession ? { onSession: options.onSession } : {}), ...(options.wrapUp ? { wrapUp: options.wrapUp } : {}), ...(options.unbounded ? { unbounded: true } : {}),
    ...(options.requestCheckpoint ? { requestCheckpoint: options.requestCheckpoint } : {}),
  });
}
const seen = (context: { messages: unknown[] }, text: string) => JSON.stringify(context.messages).includes(text);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("specialist session", () => {
  it("sends an invalid or rejected report back to the model and returns the first valid one with its cost", async () => {
    // "forty-two": TypeBox 1.x Value.Convert (Pi's argument validation) would coerce a numeric string such as "42", so the invalid report is non-numeric.
    const result = await run([tool("report_answer", { answer: "forty-two" }), tool("report_answer", { answer: 13 }), tool("report_answer", { answer: 42 })]);
    expect(result.value).toEqual({ answer: 42 });
    expect(result.stats).toMatchObject({ actor: "framer:W1", requests: 3 });
    expect(Object.values(result.stats.models)).toEqual([3]);
  });

  it("reports the model and thinking level its session really runs on, once it exists, and records them in the stats", async () => {
    const seen: { model: string; thinking?: string }[] = [];
    const result = await run([tool("report_answer", { answer: 42 })], { onSession: use => seen.push(use) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toMatch(/^[^/]+\/[^/]+$/);
    expect(result.stats).toMatchObject({ model: seen[0]!.model, ...(seen[0]!.thinking ? { thinking: seen[0]!.thinking } : {}) });
    expect(Object.keys(result.stats.models)).toEqual([seen[0]!.model]);
    // Never called when the session never started.
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const none: unknown[] = [];
    await run([tool("report_answer", { answer: 42 })], { signal: controller.signal, onSession: use => none.push(use) }).catch(() => undefined);
    expect(none).toEqual([]);
  });

  it("fails when the model ends without a report, or keeps going past its turn cap", async () => {
    await expect(run([reply("forty-two")])).rejects.toThrow("framer:W1: ended without calling report_answer");
    const capped = run([tool("ls", {}), tool("ls", {}), tool("ls", {})], { maxTurns: 2 });
    await expect(capped).rejects.toThrow("no report_answer within 2 turns");
    await capped.catch(error => {
      expect(error).toBeInstanceOf(SpecialistError);
      expect((error as SpecialistError).cancelled).toBe(false);
      expect((error as SpecialistError).stats.requests).toBe(2);
    });
  });

  it("without maxTurns (orche_spawn sub-workers) there is no turn cap; the request checkpoint is one steered notice that keeps the session going", async () => {
    const counts: number[] = [];
    const look = (context: { messages: unknown[] }) => { counts.push(JSON.stringify(context.messages).split("Progress checkpoint").length - 1); return tool("ls", {}); };
    // 60 tool responses: past the old derived cap (max(50, 1.5 x assignmentRequests) with a 0 or small assignmentRequests).
    const result = await run([...Array.from({ length: 60 }, () => look), tool("report_answer", { answer: 42 })], { maxTurns: null, requestCheckpoint: 5 });
    expect(result.value).toEqual({ answer: 42 });
    expect(result.stats.requests).toBe(61);
    expect(counts.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(counts.slice(5).every(count => count === 1)).toBe(true);
    expect(result.stats.wrapUp).toBeUndefined();
  });

  it("does not start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const error = await run([tool("report_answer", { answer: 42 })], { signal: controller.signal }).catch(caught => caught);
    expect(error).toBeInstanceOf(SpecialistError);
    expect(error).toMatchObject({ cancelled: true, message: "framer:W1: cancelled" });
  });

  describe("wrap-up notice before a cap (SpecialistRun.wrapUp)", () => {
    it("one turn notice before the turn cap lets a session that keeps investigating report instead of failing", async () => {
      const step = (context: { messages: unknown[] }) => seen(context, "Turn notice:") ? tool("report_answer", { answer: 42 }) : tool("ls", {});
      const result = await run([step, step, step, step, step], { maxTurns: 5, wrapUp: { turnsLeft: 2 } });
      expect(result.value).toEqual({ answer: 42 });
      expect(result.stats.requests).toBe(4); // three turns, the notice, the report
      expect(result.stats.wrapUp).toBe("Turn notice: 2 responses left before this session ends without a report.");
      // Without the notice the same session runs into its cap and ends without a report.
      await expect(run([step, step, step, step, step], { maxTurns: 5 })).rejects.toThrow("no report_answer within 5 turns");
    });

    it("tiny caps: turnsLeft is at least 1, and a session that ignores the notice still ends at the cap", async () => {
      const reported = await run([tool("ls", {}), context => seen(context, "Turn notice: 1 response left") ? tool("report_answer", { answer: 42 }) : tool("ls", {})], { maxTurns: 2, wrapUp: { turnsLeft: 0 } });
      expect(reported.value).toEqual({ answer: 42 });
      const ignored = await run([tool("ls", {}), tool("ls", {}), tool("ls", {})], { maxTurns: 2, wrapUp: { turnsLeft: 1 } }).catch(caught => caught);
      expect(ignored).toBeInstanceOf(SpecialistError);
      expect((ignored as SpecialistError).message).toContain("no report_answer within 2 turns");
      expect((ignored as SpecialistError).stats.wrapUp).toBe("Turn notice: 1 response left before this session ends without a report.");
    });

    it("no notice while a report is being made or after one was captured", async () => {
      // An invalid report at the notice point: the session is reporting, so nothing interrupts the retry.
      const result = await run([tool("report_answer", { answer: "forty-two" }), tool("report_answer", { answer: 42 })], { maxTurns: 3, wrapUp: { turnsLeft: 2 } });
      expect(result.value).toEqual({ answer: 42 });
      expect(result.stats.wrapUp).toBeUndefined();
    });

    it("a time notice goes out at atMs while the fixed timer is armed", async () => {
      const result = await run([
        async () => { await sleep(400); return tool("ls", {}); },
        context => seen(context, "Time notice:") ? tool("report_answer", { answer: 42 }) : tool("ls", {}),
      ], { maxTurns: 5, timeoutMs: 20_000, wrapUp: { turnsLeft: 1, atMs: 100 } });
      expect(result.value).toEqual({ answer: 42 });
      expect(result.stats.wrapUp).toBe("Time notice: 1% of this session's time limit (20s) is used.");
    });

    it("completion wait (unbounded): no wall-clock cap and no time notice, but the turn cap and its notice stay", async () => {
      // A 1 ms cap and a notice at 0 ms would end or steer the session at once if the timer were armed.
      const result = await run([
        async () => { await sleep(150); return tool("ls", {}); },
        context => seen(context, "Time notice:") ? tool("report_answer", { answer: 13 }) : seen(context, "Turn notice:") ? tool("report_answer", { answer: 42 }) : tool("ls", {}),
      ], { maxTurns: 2, timeoutMs: 1, unbounded: true, wrapUp: { turnsLeft: 1, atMs: 0 } });
      expect(result.value).toEqual({ answer: 42 });
      expect(result.stats.wrapUp).toBe("Turn notice: 1 response left before this session ends without a report.");
      const capped = await run([tool("ls", {}), tool("ls", {}), tool("ls", {})], { maxTurns: 2, timeoutMs: 1, unbounded: true }).catch(caught => caught);
      expect((capped as SpecialistError).message).toContain("no report_answer within 2 turns");
    });

    it("a cancelled session sends no notice afterwards and its timer is cleared", async () => {
      const controller = new AbortController();
      const promise = run([async (_context, options) => {
        setTimeout(() => controller.abort(new Error("cancelled")), 20);
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return reply("aborted", { stopReason: "aborted" });
      }], { signal: controller.signal, timeoutMs: 20_000, wrapUp: { turnsLeft: 1, atMs: 200 } });
      const error = await promise.catch(caught => caught);
      expect(error).toBeInstanceOf(SpecialistError);
      expect((error as SpecialistError).cancelled).toBe(true);
      await sleep(300);
      expect((error as SpecialistError).stats.wrapUp).toBeUndefined();
    });
  });
});
