import { describe, expect, it } from "vitest";
import { formatOutcome, withRecordLine, type OrcheOutcome } from "../../src/extension/controller.js";
import { errorToolResult, runErrorResult } from "../../src/extension/tool-result.js";

/** The orche_run tool was removed from the extension; the run-record result plumbing stays as library code. */
describe("the Record line and details.record plumbing", () => {
  const failure = { kind: "failed" as const, status: "failed", reason: "r" };
  it("errorToolResult appends the line once for details with a record, and leaves other details alone", () => {
    expect(errorToolResult("boom", { record: "/r/1" }, failure).content).toEqual([{ type: "text", text: "boom\n\nRecord: /r/1" }]);
    expect(errorToolResult("boom\n\nRecord: /r/1", { record: "/r/1" }, failure).content).toEqual([{ type: "text", text: "boom\n\nRecord: /r/1" }]);
    expect(errorToolResult("boom", { model: "p/m" }, failure).content).toEqual([{ type: "text", text: "boom" }]);
    expect(errorToolResult("boom", { record: "/r/1" }, failure).details).toEqual({ record: "/r/1", failure });
    expect(withRecordLine("text", undefined)).toBe("text");
  });

  it("runErrorResult and formatOutcome end with the line, for failed and cancelled outcomes", () => {
    const outcome = (cancelled: boolean): OrcheOutcome => ({
      report: { status: "failed", summary: cancelled ? "cancelled" : "gave up", tasks: [], startedAt: 0, finishedAt: 2000, taskClass: "change", answer: "gave up" },
      text: cancelled ? "cancelled" : "gave up", source: { kind: "user", path: "/a/orche.config.json" }, cancelledByUser: cancelled,
      details: { status: "failed", taskClass: "change", durationMs: 2000, config: "c", ignoredConfigs: [], tasks: 0, requests: 1, inputTokens: 1, outputTokens: 1, advisorRequests: 0, models: {}, contextWindows: {}, cancelled, progress: [], record: "/r/2" },
    });
    for (const cancelled of [false, true]) {
      const result = runErrorResult(outcome(cancelled));
      const text = (result.content[0] as { text: string }).text;
      expect(text.split("\n").at(-1)).toBe("Record: /r/2");
      expect(text.match(/Record: /g)).toHaveLength(1);
      expect(result.details).toMatchObject({ record: "/r/2", failure: { kind: cancelled ? "cancelled" : "failed" } });
      expect(formatOutcome(outcome(cancelled)).endsWith("\n\nRecord: /r/2")).toBe(true);
    }
  });
});
