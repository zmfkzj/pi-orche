import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep } from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { orchestrationResultSchemas } from "../../src/orchestration/result-schemas.js";
import { formatError, schemaErrors } from "../../src/orchestration/schema-errors.js";
import { suggestToolName, unknownToolText } from "../../src/pi/unknown-tool.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

/**
 * P3(b): schema friction seen in real worker transcripts, fixed without weakening validation: Pi's TypeBox 1.x errors keep their
 * paths, a `data` sent as a JSON string is parsed before validation, and a made-up tool name gets a suggestion (never a re-route).
 * Plus the steer API's rejection rules (R2) at the manager level.
 */
const managers: AgentManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.dispose(); });
async function worker(steps: FauxResponseStep[]) {
  const f = await fauxRuntime(steps);
  const m = new AgentManager(f.runtime, { resultSchemas: orchestrationResultSchemas });
  managers.push(m);
  await m.spawn({ id: "W1", role: "test", route: f.route, modelRuntime: f.runtime, cwd: process.cwd(), instructions: "test", tools: ["read", "grep", "bash", "write"] });
  return { m, ...f };
}

describe("schema errors under both TypeBox generations", () => {
  it("formats AJV-style (TypeBox 1.x, Pi's runtime) errors with their instance path instead of '/'", () => {
    expect(formatError({ instancePath: "/checklist/0/evidence", message: "must not have fewer than 1 characters" })).toBe("/checklist/0/evidence: must not have fewer than 1 characters");
    expect(formatError({ instancePath: "", message: "must have required properties evidence", params: { requiredProperties: ["evidence"] } })).toBe("/: must have required properties evidence");
    expect(formatError({ path: "/status", message: "Expected union value" })).toBe("/status: Expected union value");
  });
  it("lists distinct errors with paths for the 0.34 iterator too", () => {
    const schema = Type.Object({ a: Type.String({ minLength: 1 }), b: Type.Number() });
    expect(schemaErrors(schema, { a: "", b: "x" })).toEqual(expect.arrayContaining([expect.stringMatching(/^\/a: /), expect.stringMatching(/^\/b: /)]));
  });
});

describe("report_result data and unknown tools in a worker session", () => {
  it("accepts data sent as a JSON string after validating the parsed object", async () => {
    const { m } = await worker([reply([call("report_result", { kind: "implement", summary: "done", data: JSON.stringify({ status: "done", evidence: ["x"] }) })], { stopReason: "toolUse" })]);
    m.assign("W1", "implement", "go");
    const waited = await m.wait("W1", 5000);
    expect(waited).toMatchObject({ type: "outcome", outcome: { status: "completed", result: { data: { status: "done" } } } });
  });
  it("a JSON string that is invalid data is still rejected, with the path of the problem", async () => {
    let rejection = "";
    const { m } = await worker([
      reply([call("report_result", { kind: "implement", summary: "done", data: JSON.stringify({ status: "finished" }) })], { stopReason: "toolUse" }),
      context => { rejection = JSON.stringify(context.messages.at(-1)); return reply([call("report_result", { kind: "implement", summary: "done", data: { status: "done" } })], { stopReason: "toolUse" }); },
    ]);
    m.assign("W1", "implement", "go");
    await m.wait("W1", 5000);
    expect(rejection).toContain("Result rejected: /status");
  });
  it("suggests the real tool for a made-up prefixed name and never runs it", async () => {
    let seen = "";
    const { m } = await worker([
      reply([call("utility_read", { path: "package.json" })], { stopReason: "toolUse" }),
      context => { seen = JSON.stringify(context.messages.at(-1)); return reply([call("report_result", { kind: "explore", summary: "ok" })], { stopReason: "toolUse" }); },
    ]);
    m.assign("W1", "explore", "go");
    await m.wait("W1", 5000);
    expect(seen).toContain("Tool utility_read not found. Did you mean read? Call it by that exact name.");
    expect(seen).toContain("Available tools:");
  });
  it("suggestions are unique matches only", () => {
    const tools = ["read", "bash", "write", "edit", "orche_spawn", "report_result"];
    expect(suggestToolName("minute_bash", tools)).toBe("bash");
    expect(suggestToolName("seek_write", tools)).toBe("write");
    expect(suggestToolName("notable_orche_spawn", tools)).toBe("orche_spawn");
    expect(suggestToolName("mcp__x__read", tools)).toBe("read");
    expect(suggestToolName("Read", tools)).toBe("read");
    expect(suggestToolName("reda", tools)).toBe("read");
    expect(suggestToolName("frobnicate", tools)).toBeUndefined();
    expect(unknownToolText("some other error", tools)).toBeUndefined();
  });
});

describe("steer (orche_task_message) at the manager", () => {
  it("rejects idle, unknown and already-reported workers; queues while running", async () => {
    const entered = deferred(), gate = deferred();
    const { m } = await worker([async () => { entered.resolve(); await gate.promise; return reply([call("report_result", { kind: "explore", summary: "ok" })], { stopReason: "toolUse" }); }]);
    expect(m.steer("W1", "hi")).toMatchObject({ status: "rejected", reason: expect.stringContaining("not running an assignment") });
    expect(m.steer("W9", "hi")).toMatchObject({ status: "rejected", reason: expect.stringContaining("not a live worker") });
    m.assign("W1", "explore", "go");
    await entered.promise;
    expect(m.steer("W1", "  ")).toMatchObject({ status: "rejected", reason: "empty message" });
    expect(m.steer("W1", "extra")).toMatchObject({ status: "queued", id: "M1" });
    gate.resolve();
    const waited = await m.wait("W1", 5000);
    expect(waited).toMatchObject({ type: "outcome", outcome: { status: "completed", injected: [{ id: "M1", status: "undelivered" }] } });
    expect(m.steer("W1", "after")).toMatchObject({ status: "rejected" });
  });
});
