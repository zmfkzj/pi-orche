import { afterEach, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AdvisorEngine, type AdvisorHost } from "../../src/advisor/engine.js";
import { runAdvisorSession } from "../../src/advisor/session.js";
vi.mock("../../src/advisor/session.js", () => ({ runAdvisorSession: vi.fn(() => new Promise(() => {})) }));
vi.mock("../../src/advisor/context.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/advisor/context.js")>(), workspaceDiff: vi.fn(async () => "") }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it("host cancellation fences advisors and bounds dispose despite an uncooperative flight", async () => {
  vi.useFakeTimers();
  const cancellation = new AbortController();
  const host: AdvisorHost = {
    cwd: process.cwd(), problem: "test", runtime: {} as ModelRuntime, routes: { routes: {}, default: { model: "fake/test" } },
    signal: cancellation.signal, coordinator: () => undefined, emit: vi.fn(),
    manager: { list: () => [], subscribe: () => () => {}, session: () => { throw new Error("none"); }, get: () => { throw new Error("none"); }, send: async message => ({ id: message.id, status: "rejected", reason: "test", mode: "context" }) },
  };
  const engine = new AdvisorEngine([{ name: "test", domains: ["tests"], targets: ["coordinator"], triggers: [{ on: "before_complete" }] }], host);
  engine.start();
  void engine.onDecision({ type: "complete", summary: "test" }, "VERIFY", 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(runAdvisorSession).toHaveBeenCalledTimes(1);
  cancellation.abort();
  const disposed = engine.disposeWithin(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await disposed).toBe(false);
  expect(vi.mocked(runAdvisorSession).mock.calls[0]![0].signal.aborted).toBe(true);
  await engine.onDecision({ type: "complete", summary: "late" }, "VERIFY", 1000);
  expect(runAdvisorSession).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
