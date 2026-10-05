import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { runSpecialistSession, SpecialistError } from "../../src/specialists/session.js";
import { fauxRuntime } from "../helpers/faux.js";

const tool = (name: string, args: Record<string, unknown>) => reply([call(name, args as never)], { stopReason: "toolUse" });
const report = { name: "report_answer", label: "Report answer", description: "Submit once.", parameters: Type.Object({ answer: Type.Integer({ minimum: 0 }) }), check: (value: { answer: number }) => value.answer === 13 ? "13 is unlucky." : undefined };

async function run(steps: Parameters<typeof fauxRuntime>[0], options: { maxTurns?: number; signal?: AbortSignal } = {}) {
  const faux = await fauxRuntime(steps);
  return runSpecialistSession({
    actor: "framer:W1", route: faux.route, runtime: faux.runtime, cwd: process.cwd(), instructions: "Answer.", prompt: "What is 6 * 7?",
    tools: ["ls"], report, maxTurns: options.maxTurns ?? 5, timeoutMs: 30_000, signal: options.signal ?? new AbortController().signal,
  });
}

describe("specialist session", () => {
  it("sends an invalid or rejected report back to the model and returns the first valid one with its cost", async () => {
    const result = await run([tool("report_answer", { answer: "42" }), tool("report_answer", { answer: 13 }), tool("report_answer", { answer: 42 })]);
    expect(result.value).toEqual({ answer: 42 });
    expect(result.stats).toMatchObject({ actor: "framer:W1", requests: 3 });
    expect(Object.values(result.stats.models)).toEqual([3]);
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

  it("does not start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const error = await run([tool("report_answer", { answer: 42 })], { signal: controller.signal }).catch(caught => caught);
    expect(error).toBeInstanceOf(SpecialistError);
    expect(error).toMatchObject({ cancelled: true, message: "framer:W1: cancelled" });
  });
});
