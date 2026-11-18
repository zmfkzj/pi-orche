import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getCurrentTools, InMemoryCredentialStore, type Tool } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { WORKER_TOOL_NAMES } from "../../src/tools/index.js";
import { createTaskPlanTool } from "../../src/tools/task-plan.js";
import { createHarness, tool } from "./harness.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

// Keywords a strict provider schema compiler rejects for the whole request. uniqueItems is the one a real orchestrator start
// hit (cliproxyapi gpt-6.2-astra: "Invalid schema for 'tools[10].parameters': Unimplemented keys: [\"uniqueItems\"]"); the
// others are the composition keywords OpenAI's Structured Outputs documents as unsupported.
const STRICT_UNSUPPORTED = ["uniqueItems", "allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"];

/** `path` of every schema keyword in `unsupported` (property maps are walked as names, not as keywords). */
function unsupportedKeywords(schema: unknown, path = ""): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, index) => unsupportedKeywords(item, `${path}/${index}`));
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema).flatMap(([key, value]) => {
    if (key === "properties" && value && typeof value === "object") {
      return Object.entries(value).flatMap(([name, property]) => unsupportedKeywords(property, `${path}/properties/${name}`));
    }
    return [...(STRICT_UNSUPPORTED.includes(key) ? [`${path}/${key}`] : []), ...unsupportedKeywords(value, `${path}/${key}`)];
  });
}

describe("worker request tool schemas", () => {
  it("finds the keyword and its path, and walks property names as names", () => {
    expect(unsupportedKeywords({ type: "object", properties: { not: { type: "array", uniqueItems: true } } })).toEqual(["/properties/not/uniqueItems"]);
  });

  it("the first request of a single-workflow orchestrator declares task_plan and orche_spawn without strict-unsupported keywords", async () => {
    let tools: Tool[] | undefined;
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "implement", request: "Goal: say hi. R1: report done.", files: ["greeting.txt"] })],
      orcheSteps: [
        context => {
          tools = getCurrentTools(context.messages);
          return tool("report_result", { kind: "implement", summary: "Done.", data: { status: "done" } });
        },
      ],
    });
    try {
      await h.session.prompt("Say hi");
      const names = (tools ?? []).map(item => item.name);
      expect(names).toContain("task_plan");
      expect(names).toContain("orche_spawn");
      // The reported index: ten worker tools (read … write) come first, so task_plan is tools[10] of the request.
      expect(names.indexOf("task_plan")).toBe(10);
      expect(Object.fromEntries((tools ?? []).map(item => [item.name, unsupportedKeywords(item.parameters)]).filter(([, found]) => found!.length))).toEqual({});
    } finally { await h.dispose(); }
  });

  it("Responses wire of a worker session (loopback CPA stand-in, not the live provider): task_plan is tools[10], strict is omitted and nothing is rejected", async () => {
    // The stand-in applies the rule observed live on cliproxyapi gpt-6.2-astra/sol (2026-11-18): a function tool whose `strict` is
    // omitted or true is compiled as a strict schema and an unimplemented keyword fails the whole request; `strict: null` is not.
    const bodies: { tools?: { name: string; strict?: unknown; parameters: unknown }[] }[] = [];
    const server: Server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text) as (typeof bodies)[number];
      bodies.push(body);
      const index = (body.tools ?? []).findIndex(item => (item.strict === undefined || item.strict === true) && JSON.stringify(item.parameters).includes('"uniqueItems"'));
      if (index >= 0) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_json_schema", message: `Invalid schema for 'tools[${index}].parameters': Unimplemented keys: ["uniqueItems"]. Compilation limits apply to all strict schemas in the request.`, param: `tools[${index}].parameters`, type: "invalid_request_error" } }));
        return;
      }
      const item = { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end([
        { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""));
    });
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback port");
    const root = await mkdtemp(join(tmpdir(), "orche-tool-schemas-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const modelsPath = join(root, "models.json");
    // As pi-cliproxyapi-provider registers its models: Responses API with Pi's strict rewrite off (compat.supportsStrictMode false).
    await writeFile(modelsPath, JSON.stringify({ providers: { cliproxyapi: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-responses", apiKey: "test-only",
      models: [{ id: "bts/gpt-6.2-astra", contextWindow: 32000, maxTokens: 256, compat: { supportsStrictMode: false } }],
    } } }));
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, refreshOnCreate: false });
    const session = await createSession({
      cwd: root, modelRuntime: runtime, route: { role: "test", model: "cliproxyapi/bts/gpt-6.2-astra" }, instructions: "Answer briefly.",
      // The single-workflow worker's tool order (workers.ts): the worker set, then task_plan.
      tools: [...WORKER_TOOL_NAMES, "task_plan"], customTools: [createTaskPlanTool(() => {})],
    });
    cleanup.push(() => session.dispose());
    await session.prompt("Reply OK");
    expect(session.getLastAssistantText()).toBe("OK");
    expect(bodies).toHaveLength(1);
    const wire = bodies[0]!.tools ?? [];
    expect(wire.findIndex(item => item.name === "task_plan")).toBe(10);
    // Orche's worker sessions do not load pi-cliproxyapi-provider's `strict: null` payload adapter, so the backend's default applies.
    expect(wire.every(item => !("strict" in item))).toBe(true);
    expect(wire.filter(item => unsupportedKeywords(item.parameters).length).map(item => item.name)).toEqual([]);
  });
});
