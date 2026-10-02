import { expect, it } from "vitest";
import { decide } from "../../src/orchestration/run/decisions.js";
import { defaultRunLimits, type RunContext } from "../../src/orchestration/run/types.js";
import type { RunEvent } from "../../src/orchestration/events.js";

it.each(["normal", "awaited", "queued"])("records validated %s decisions without changing their result", async mode => {
  const events: RunEvent[] = [];
  const complete = { type: "complete", summary: "done" };
  const fail = { type: "fail", reason: "advisor concern" };
  const responses = [{ type: "invalid" }, complete, fail];
  const ctx = {
    startedAt: Date.now(), limits: defaultRunLimits, cancelled: false,
    state: { phase: "VERIFY", tasks: [], fixRounds: 0, maxFixRounds: 2, maxWorkers: 3 },
    options: { sink: (event: RunEvent) => events.push(event) }, manager: { list: () => [] }, workerIds: [],
    mainNotes: mode === "queued" ? [{ from: "advisor:audit", content: "review" }] : [],
    advisors: { settle: async () => {}, onDecision: async () => mode === "awaited" ? 1 : 0 },
    coordinator: { prompt: async () => { ctx.decisionSet = true; ctx.decisionValue = responses.shift(); } },
    decisionSet: false, decisionValue: undefined,
  } as unknown as RunContext;
  expect(await decide(ctx, {})).toEqual(mode === "awaited" ? fail : complete);
  const decisions = events.filter(event => event.type === "coordinator_decision");
  expect(decisions.map(({ decisionType, reconsidered }) => ({ decisionType, reconsidered }))).toEqual([
    { decisionType: "complete", reconsidered: mode === "queued" },
    ...(mode === "awaited" ? [{ decisionType: "fail", reconsidered: true }] : []),
  ]);
  for (const event of decisions) expect(event).toMatchObject({ phase: "VERIFY", timestamp: expect.any(Number) });
});
