import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession } from "../../src/pi/session-factory.js";
import { runAdvisorSession, type AdvisorRun } from "../../src/advisor/session.js";
import { resolveAdvisor } from "../../src/advisor/config.js";
vi.mock("../../src/pi/session-factory.js", () => ({ createSession: vi.fn() }));
const run = (signal: AbortSignal): AdvisorRun => ({ advisor: resolveAdvisor({ name: "test", domains: ["tests"], targets: ["coordinator"], triggers: [] }), route: { role: "advisor", model: "fake" }, runtime: {} as ModelRuntime, cwd: process.cwd(), prompt: "private", signal, timeoutMs: 10, onUsage: () => {}, onContextWindow: () => {} });
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("does not create a session when already cancelled", async () => {
  const c = new AbortController(); c.abort(new Error("cancelled"));
  await expect(runAdvisorSession(run(c.signal))).rejects.toThrow("cancelled");
  expect(createSession).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("bounds creation, tracks pending creation, disposes a late session and never prompts", async () => {
  const deferred = Promise.withResolvers<AgentSession>(); vi.mocked(createSession).mockReturnValue(deferred.promise);
  const onCreationPending = vi.fn();
  const promise = runAdvisorSession({ ...run(new AbortController().signal), onCreationPending });
  const checked = expect(promise).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(10); await checked;
  const dispose = vi.fn(), prompt = vi.fn(); deferred.resolve({ dispose, prompt } as unknown as AgentSession);
  await vi.advanceTimersByTimeAsync(0);
  expect(dispose).toHaveBeenCalledTimes(1); expect(prompt).not.toHaveBeenCalled();
  expect(onCreationPending.mock.calls).toEqual([[true], [false]]); expect(vi.getTimerCount()).toBe(0);
});
it("cancellation during prompt returns despite an uncooperative prompt/abort and observes late rejection", async () => {
  const prompt = Promise.withResolvers<void>(); const abort = Promise.withResolvers<void>(); const dispose = vi.fn();
  vi.mocked(createSession).mockResolvedValue({ prompt: () => prompt.promise, abort: () => abort.promise, dispose, subscribe: () => () => {} } as unknown as AgentSession);
  const c = new AbortController(); const promise = runAdvisorSession(run(c.signal));
  const checked = expect(promise).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(0); c.abort(new Error("cancelled")); await checked;
  expect(dispose).toHaveBeenCalledTimes(1);
  prompt.reject(new Error("late prompt")); abort.reject(new Error("late abort")); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
