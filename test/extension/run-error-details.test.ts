import { describe, expect, it } from "vitest";
import type { OrcheOutcome } from "../../src/extension/controller.js";
import { errorToolResult, FAILURE_LIST_ENTRIES, failureReason, runErrorResult, runFailureOf } from "../../src/extension/tool-result.js";

describe("error result builder", () => {
  const baseOutcome = (overrides: Partial<OrcheOutcome["report"]> = {}, cancelledByUser = false): OrcheOutcome => ({
    report: {
      status: "failed", summary: "first line of the failure\nsecond line", tasks: [], startedAt: 1000, finishedAt: 3500,
      taskClass: "change", answer: "partial", answerFromFailedRun: true, ...overrides,
    },
    text: "first line of the failure\nsecond line",
    source: { kind: "user", path: "/agent/orche.config.json" },
    cancelledByUser,
    details: {
      status: "failed", taskClass: "change", durationMs: 2500, config: "test config", ignoredConfigs: [], tasks: 0, requests: 3, inputTokens: 10,
      outputTokens: 5, advisorRequests: 0, models: { coordinator: { "p/m": 3 } }, contextWindows: {}, cancelled: cancelledByUser, progress: ["line"],
      ...(overrides.cleanup ? { cleanup: overrides.cleanup } : {}),
    },
  });

  it("errorToolResult marks the result as an error, keeps the text and adds the failure to a copy of the details", () => {
    const details = { model: "p/m", requests: 2 };
    const failure = { kind: "blocked" as const, status: "blocked", reason: "needs input" };
    const result = errorToolResult("the text", details, failure);
    expect(result).toEqual({ content: [{ type: "text", text: "the text" }], details: { model: "p/m", requests: 2, failure }, isError: true });
    expect(details).toEqual({ model: "p/m", requests: 2 });
  });

  it("failureReason takes the first non-empty line, collapses whitespace and bounds the length", () => {
    expect(failureReason("\n\n  first   line \nsecond")).toBe("first line");
    expect(failureReason("x".repeat(500)).length).toBe(300);
    expect(failureReason("x".repeat(500)).endsWith("…")).toBe(true);
    expect(failureReason("")).toBe("");
  });

  it("runErrorResult keeps outcome.details, the cleanup and a bounded workspace/violation summary", () => {
    const many = Array.from({ length: FAILURE_LIST_ENTRIES + 7 }, (_, index) => ({ path: `f${index}.ts`, status: "modified" as const }));
    const outcome = baseOutcome({
      cleanup: { incomplete: true, pending: ["providers"] }, rootCause: "the root cause\nmore",
      ownershipViolations: [{ agentId: "A1", file: "x.ts", via: "workspace", created: true }],
      workspace: { baseline: "abc123", changes: many, external: [{ path: "ext.ts", status: "added", reason: "another session" }] },
    });
    const result = runErrorResult(outcome);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect(result.details).toMatchObject({ ...outcome.details, requests: 3, durationMs: 2500, cleanup: { incomplete: true, pending: ["providers"] } });
    expect(result.details.failure).toMatchObject({
      kind: "failed", status: "failed", reason: "first line of the failure", rootCause: "the root cause",
      violations: [{ agentId: "A1", file: "x.ts", via: "workspace", created: true }],
      workspace: { baseline: "abc123", external: [{ path: "ext.ts", status: "added", reason: "another session" }], omitted: 7 },
    });
    expect(result.details.failure.workspace!.changes).toHaveLength(FAILURE_LIST_ENTRIES);
    expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
  });

  it("runFailureOf distinguishes user cancellation, tool-abort cancellation and plain failure", () => {
    expect(runFailureOf(baseOutcome({ summary: "cancelled" }, true))).toEqual({ kind: "cancelled", status: "failed", reason: "cancelled by user", cancelledByUser: true });
    const aborted = baseOutcome({ summary: "cancelled" });
    aborted.details = { ...aborted.details, cancelled: true };
    expect(runFailureOf(aborted)).toEqual({ kind: "cancelled", status: "failed", reason: "cancelled" });
    expect(runFailureOf(baseOutcome())).toEqual({ kind: "failed", status: "failed", reason: "first line of the failure" });
  });

  it("runErrorResult prefixes the text with 'cancelled by user' only for /orche cancel", () => {
    const user = baseOutcome({ summary: "cancelled" }, true);
    expect((runErrorResult(user).content[0] as { text: string }).text).toMatch(/^cancelled by user\n\norche CANCELLED by user /);
    expect((runErrorResult(baseOutcome()).content[0] as { text: string }).text).toMatch(/^orche FAILED /);
  });
});
