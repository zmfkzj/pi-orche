import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as assistant, type AssistantMessage, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { Api, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { applyProjection, createAssignmentProjector, findClearCandidates, planAssignmentProjection } from "../../src/pi/context-projection.js";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const result = (id: string, text: string, toolName = "read"): ToolResultMessage => ({
  role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2,
});
const call = (id: string, name = "read"): ToolCall => ({
  type: "toolCall", id, name, arguments: { path: "src/example.ts", offset: 20 }, thoughtSignature: "keep-call-metadata",
});
const thinking = (text = "reason", redacted = false) => ({ type: "thinking" as const, thinking: text, thinkingSignature: "encrypted-payload", redacted });
const project = (messages: AgentMessage[], boundaryIndex: number, minClearTokens = 10_000) => {
  const plan = planAssignmentProjection({ messages, boundaryIndex, minClearTokens });
  return { plan, projected: applyProjection(messages, plan, boundaryIndex) };
};
const textOf = (message: AgentMessage) => JSON.stringify("content" in message ? message.content : undefined);

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("assignment context projection", () => {
  it("clears at the threshold and leaves requests byte-identical just below it", () => {
    const below = [user("first"), result("r", "x".repeat(39_999)), user("second")];
    const { plan, projected } = project(below, 2);
    expect(plan.stats).toEqual({ results: 0, estTokens: 0, thinkingBlocks: 0 });
    expect(JSON.stringify(projected)).toBe(JSON.stringify(below));
    expect(projected).toBe(below);
    const projector = createAssignmentProjector();
    projector.beginAssignment(below, 2);
    expect(projector.project(below)).toBe(below);
    const at = [user("first"), result("r", "x".repeat(40_000)), user("second")];
    const cleared = project(at, 2);
    expect(cleared.plan.stats).toEqual({ results: 1, estTokens: 10_000, thinkingBlocks: 0 });
    expect(textOf(cleared.projected[1]!)).toContain("[Earlier read result cleared to save context (40000 chars). Repeat the call if you need it.]");
  });

  it("uses the strict 600-char cutoff, concatenates text blocks, counts all images, and exempts report_result", () => {
    const split = result("split", "x".repeat(300));
    split.content.push({ type: "text", text: "y".repeat(301) });
    const image = result("image", "caption");
    image.content.push({ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/png" });
    const report = result("report", "x".repeat(50_000), "report_result");
    report.content.push({ type: "image", data: "AAAA", mimeType: "image/png" });
    const messages = [result("small", "x".repeat(600)), split, image, report];
    const candidates = findClearCandidates(messages, 4);
    expect(candidates.map(candidate => [candidate.toolCallId, candidate.textChars, candidate.images, candidate.estTokens]))
      .toEqual([["split", 601, 0, 150.25], ["image", 7, 2, 2001.75]]);
    const { projected } = project(messages, 4, 0);
    expect(projected[0]).toBe(messages[0]);
    expect(projected[3]).toBe(report);
    expect(textOf(projected[2]!)).toContain("(7 chars, 2 images)");
    expect((projected[2] as ToolResultMessage).content).toHaveLength(1);
  });

  it("clears an image-only result even with zero text", () => {
    const message = result("image", "");
    message.content = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
    const { plan, projected } = project([message], 1, 1_000);
    expect(plan.stats.estTokens).toBe(1_000);
    expect(textOf(projected[0]!)).toContain("(0 chars, 1 image)");
  });

  it("carries the first artifact path inside a placeholder independent of boundary numbers", () => {
    const original = result("r", `${"x".repeat(601)}\nFull output: .orche/artifacts/first-output.txt; later '.orche/artifacts/second.txt'`);
    const first = project([original, user("next")], 1, 0).projected[0];
    const later = project([original, user("next"), user("later")], 2, 0).projected[0];
    expect(textOf(first!)).toContain("need it. Full output: .orche/artifacts/first-output.txt]");
    expect(textOf(first!)).not.toContain("second.txt");
    expect(JSON.stringify(first)).toBe(JSON.stringify(later));
  });

  it("keeps calls, arguments, error flags, metadata, pairing and parallel tool-result order", () => {
    const calls = assistant([thinking(), { type: "text", text: "reading", textSignature: "keep-text-metadata" }, call("r"), call("b", "bash")]);
    const read = { ...result("r", "x".repeat(24_000)), isError: true, details: { metadata: "original" } };
    const bash = result("b", "y".repeat(16_000), "bash");
    const small = result("s", "small");
    const messages = [user("first"), calls, read, bash, assistant([call("s")]), small, user("second")];
    const { projected } = project(messages, 6);
    expect(projected.map(message => message.role)).toEqual(messages.map(message => message.role));
    expect(projected[1]).toBe(calls);
    expect(projected[4]).toBe(messages[4]);
    expect(projected[5]).toBe(small);
    for (const index of [2, 3]) {
      const { content: _originalContent, ...metadata } = messages[index] as ToolResultMessage;
      const { content: _projectedContent, ...projectedMetadata } = projected[index] as ToolResultMessage;
      expect(projectedMetadata).toEqual(metadata);
    }
    expect((projected[2] as ToolResultMessage).toolCallId).toBe("r");
    expect((projected[3] as ToolResultMessage).toolCallId).toBe("b");
  });

  it("strips all later prior-turn reasoning payloads, never earlier or current-turn thinking", () => {
    const before = assistant([thinking("before"), call("r")]);
    const text = { type: "text" as const, text: "kept", textSignature: "text-signature" };
    const toolCall = call("small");
    // Raw provider/legacy shapes are tolerated alongside Pi's normalized thinking blocks.
    const after = assistant([thinking("after"), thinking("", true), text, toolCall]);
    (after.content as unknown[]).push({ type: "redacted-thinking", data: "secret" }, { type: "redacted_thinking", data: "secret" }, { type: "reasoning", encrypted_content: "secret" });
    const onlyThinking = assistant([thinking("omit entire content")]);
    const current = assistant([thinking("current"), call("now")]);
    const messages = [user("first"), before, result("r", "x".repeat(40_000)), after, onlyThinking, user("second"), current];
    const { plan, projected } = project(messages, 5);
    expect(plan.stats.thinkingBlocks).toBe(6);
    expect(projected[1]).toBe(before);
    expect((projected[3] as AssistantMessage).content).toEqual([text, toolCall]);
    expect((projected[3] as AssistantMessage).content[0]).not.toBe(text);
    expect((projected[3] as AssistantMessage).content[1]).not.toBe(toolCall);
    expect((projected[4] as AssistantMessage).content).toEqual([{ type: "text", text: "[earlier reasoning omitted]" }]);
    expect(JSON.stringify(projected[3])).not.toContain("encrypted-payload");
    expect(projected[5]).toBe(messages[5]);
    expect(projected[6]).toBe(current);
  });

  it("does not omit thinking if no result has been cleared", () => {
    const messages = [result("r", "x".repeat(601)), assistant([thinking()]), user("next")];
    const { plan, projected } = project(messages, 2);
    expect(plan.omittedReasoning.size).toBe(0);
    expect(projected).toEqual(messages);
  });

  it("never mutates even deeply frozen input or previous planning state", () => {
    const messages = freeze([user("first"), result("r", "x".repeat(40_000)), assistant([thinking(), call("s")]), user("second")]);
    const original = JSON.stringify(messages);
    const prior = new Map();
    const plan = planAssignmentProjection({ messages, boundaryIndex: 3, previouslyCleared: prior });
    applyProjection(messages, plan, 3);
    expect(JSON.stringify(messages)).toBe(original);
    expect(prior.size).toBe(0);
  });

  it("identifies by transcript position as well as call ID, so repeated IDs do not clear current results", () => {
    const messages = [result("same", "x".repeat(40_000)), user("second"), result("same", "y".repeat(8_000)), user("third")];
    const first = planAssignmentProjection({ messages, boundaryIndex: 1 });
    const second = planAssignmentProjection({ messages, boundaryIndex: 3, previouslyCleared: first.cleared });
    const projected = applyProjection(messages, second, 3);
    expect(second.stats.results).toBe(0);
    expect(second.cleared.size).toBe(1);
    expect(projected[2]).toBe(messages[2]);
  });

  it("preserves the monotonic prefix across three boundaries and clears only newly sufficient output", () => {
    const projector = createAssignmentProjector();
    const messages: AgentMessage[] = [user("one"), assistant([thinking("first"), call("r")]), result("r", "x".repeat(40_000)), assistant([thinking("old")])];
    projector.beginAssignment(messages, 0);
    expect(projector.project(messages)).toEqual(messages);
    const boundary2 = messages.length;
    messages.push(user("two"));
    const plan2 = projector.beginAssignment(messages, boundary2);
    expect(plan2.stats).toEqual({ results: 1, estTokens: 10_000, thinkingBlocks: 1 });
    const prefix2 = JSON.stringify(projector.project(messages).slice(0, boundary2));
    messages.push(assistant([thinking("new"), call("new")]), result("new", "y".repeat(8_000)), assistant("done"));
    expect(JSON.stringify(projector.project(messages).slice(0, boundary2))).toBe(prefix2);
    const boundary3 = messages.length;
    messages.push(user("three"));
    const previousProjection = JSON.stringify(projector.project(messages).slice(0, boundary3));
    const plan3 = projector.beginAssignment(messages, boundary3);
    expect(plan3.stats.results).toBe(0);
    expect(plan3.stats.estTokens).toBe(0);
    expect(plan3.stats.thinkingBlocks).toBe(0);
    expect(JSON.stringify(projector.project(messages).slice(0, boundary3))).toBe(previousProjection);
    expect(JSON.stringify(projector.project(messages).slice(0, boundary2))).toBe(prefix2);
    expect(projector.project(messages)[boundary3 - 2]).toEqual(messages[boundary3 - 2]);
    messages.push(result("enough", "z".repeat(32_000)), user("four"));
    const plan4 = projector.beginAssignment(messages, messages.length - 1);
    expect(plan4.stats).toEqual({ results: 2, estTokens: 10_000, thinkingBlocks: 0 });
    // Thinking before the earliest newly cleared result still has its original context.
    expect(textOf(projector.project(messages)[boundary2 + 1]!)).toContain("new");
    expect(plan4.cleared.size).toBe(3);
    expect(JSON.stringify(projector.project(messages).slice(0, boundary2))).toBe(prefix2);
  });

  it("rebuilds only changed messages per request, isolated from downstream mutation", () => {
    const projector = createAssignmentProjector();
    const messages = [user("one"), result("r", "x".repeat(40_000)), assistant([thinking(), call("s"), { type: "text", text: "kept" }]), user("next")];
    projector.beginAssignment(messages, 3);
    const prefix = JSON.stringify(projector.project(messages));
    const output = projector.project(messages);
    expect(output).not.toBe(messages);
    expect(output[0]).toBe(messages[0]);
    expect(output[3]).toBe(messages[3]);
    (output[1] as ToolResultMessage).content[0] = { type: "text", text: "downstream changed" };
    const changed = output[2] as AssistantMessage;
    (changed.content[0] as ToolCall).arguments.path = "downstream changed";
    (changed.content[1] as { text: string }).text = "downstream changed";
    expect(JSON.stringify(projector.project(messages))).toBe(prefix);
    expect(projector.project(messages)[2]).not.toBe(output[2]);
    messages.push(assistant([thinking("current")]), result("current", "x".repeat(80_000)));
    expect(projector.project(messages).slice(3)).toEqual(messages.slice(3));
    expect(projector.plan?.stats.results).toBe(1);
  });

  it("disabling prevents new clears but keeps existing clears, reasoning omissions and IDs", () => {
    const projector = createAssignmentProjector();
    const messages = [result("r", "x".repeat(40_000)), assistant([thinking(), call("call_s|fc_s")]), result("call_s|fc_s", "small"), user("two")];
    const first = projector.beginAssignment(messages, 3);
    const prefix = JSON.stringify(projector.project(messages));
    messages.push(result("new", "y".repeat(40_000)), assistant([thinking("disabled")]), user("three"));
    const disabled = projector.beginAssignment(messages, 6, { enabled: false });
    expect(disabled.stats).toEqual({ results: 0, estTokens: 0, thinkingBlocks: 0 });
    expect(JSON.stringify(projector.project(messages).slice(0, 4))).toBe(prefix);
    expect(projector.project(messages)[4]).toBe(messages[4]);
    expect(projector.project(messages)[5]).toBe(messages[5]);
    expect(disabled.cleared).toBe(first.cleared);
    expect(disabled.omittedReasoning).toBe(first.omittedReasoning);
    expect(disabled.idRewrites).toBe(first.idRewrites);
    const enabled = projector.beginAssignment(messages, 6, { enabled: true });
    expect(enabled.stats).toEqual({ results: 1, estTokens: 10_000, thinkingBlocks: 1 });
    expect(JSON.stringify(projector.project(messages).slice(0, 4))).toBe(prefix);
  });

  it("returns the input array for a never-cleared worker, including disabled and empty plans", () => {
    const projector = createAssignmentProjector();
    const messages = [user("one"), result("r", "x".repeat(601)), assistant([thinking()])];
    expect(projector.project(messages)).toBe(messages);
    projector.beginAssignment(messages, 3, { enabled: false, minClearTokens: 0 });
    expect(projector.project(messages)).toBe(messages);
    projector.beginAssignment(messages, 3);
    expect(projector.project(messages)).toBe(messages);
    const empty: AgentMessage[] = [];
    projector.beginAssignment(empty, 0, { minClearTokens: 0 });
    expect(projector.project(empty)).toBe(empty);
  });

  it("has safe defaults before assignment dispatch and rejects invalid positions or thresholds", () => {
    expect(createAssignmentProjector().project([user("hello")])).toEqual([user("hello")]);
    for (const boundaryIndex of [-1, 0.5, 2, NaN]) {
      expect(() => findClearCandidates([user("hello")], boundaryIndex)).toThrow(RangeError);
    }
    for (const minClearTokens of [-1, 1.5, Infinity, NaN]) {
      expect(() => planAssignmentProjection({ messages: [], boundaryIndex: 0, minClearTokens })).toThrow(RangeError);
    }
    expect(project([], 0, 0).plan.stats.results).toBe(0);
  });
});

const providerModel = <T extends Api>(api: T, provider: string): Model<T> => ({
  api, provider, id: "projection-test", name: "Projection test", baseUrl: "https://invalid.example",
  reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

function providerTranscript(model: Model<Api>, responses = true): AgentMessage[] {
  const id = (n: number) => responses ? `call_${n}|fc_${n}` : `toolu_${n}`;
  const reason = (n: number) => ({
    type: "thinking" as const, thinking: `reason ${n}`,
    thinkingSignature: responses ? JSON.stringify({ type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc_${n}` }) : `signature_${n}`,
  });
  const reply = (n: number, extraCalls: ToolCall[] = []): AssistantMessage => ({
    ...assistant([reason(n), call(id(n)), ...extraCalls], { stopReason: "toolUse" }),
    provider: model.provider, api: model.api, model: model.id,
  });
  return [user("one"), reply(1), result(id(1), "x".repeat(40_000)),
    reply(2, [call(id(3), "report_result")]), result(id(2), "small"), result(id(3), "report", "report_result"), user("two")];
}

function assertResponsesPairing(input: ReturnType<typeof convertResponsesMessages>) {
  const calls = input.filter(item => item.type === "function_call");
  const outputs = input.filter(item => item.type === "function_call_output");
  expect(calls.map(item => item.call_id)).toEqual(["call_1", "call_2", "call_3"]);
  expect(outputs.map(item => item.call_id)).toEqual(calls.map(item => item.call_id));
  expect(outputs.map(item => item.output)).not.toContain("No result provided");
  expect(input.filter(item => item.type === "reasoning").map(item => item.id)).toEqual(["rs_1"]);
  expect(calls.map(item => item.id)).toEqual(["fc_1", undefined, undefined]);
}

describe("projected provider replay", () => {
  it.each([
    ["openai-responses", "openai"], ["openai-codex-responses", "openai-codex"],
    ["cliproxyapi-codex-responses", "cliproxyapi"],
  ])("omits orphaned Responses item IDs and preserves call_id pairing for %s", (api, provider) => {
    const model = providerModel(api, provider);
    const messages = providerTranscript(model);
    const projector = createAssignmentProjector();
    const plan = projector.beginAssignment(messages, 6);
    expect(plan.idRewrites.size).toBe(4); // two calls, two small/exempt results
    const projected = projector.project(messages);
    assertResponsesPairing(convertResponsesMessages(model, { messages: [...projected] as Message[] } as TranscriptContext, new Set([provider])));
    expect((projected[4] as ToolResultMessage).toolCallId).toBe("call_2");
    expect((projected[5] as ToolResultMessage).toolCallId).toBe("call_3");
    const bytes = JSON.stringify(projected);
    const noClear = projector.beginAssignment(messages, 7);
    expect(noClear.stats).toEqual({ results: 0, estTokens: 0, thinkingBlocks: 0 });
    expect([...noClear.idRewrites]).toEqual([...plan.idRewrites]);
    expect(JSON.stringify(projector.project(messages))).toBe(bytes);
  });

  it("uses the real openai-codex-responses body builder without network access", async () => {
    const model = providerModel("openai-codex-responses", "openai-codex");
    const messages = providerTranscript(model);
    const { projected } = project(messages, 6);
    let body: { input: ReturnType<typeof convertResponsesMessages>; store: boolean } | undefined;
    const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64");
    const output = await streamCodex(model, { messages: [...projected] as Message[] } as TranscriptContext, {
      apiKey: `header.${payload}.signature`,
      onPayload: value => { body = value as typeof body; throw new Error("stop before transport"); },
    }).result();
    expect(output.errorMessage).toContain("stop before transport");
    expect(body?.store).toBe(false);
    assertResponsesPairing(body!.input);
  });

  it("preserves native anthropic-messages tool_use/tool_result pairing", async () => {
    const model = providerModel("anthropic-messages", "anthropic");
    const messages = providerTranscript(model, false);
    const { plan, projected } = project(messages, 6);
    expect(plan.idRewrites.size).toBe(0);
    expect((projected[4] as ToolResultMessage).toolCallId).toBe("toolu_2");
    const converted: { type: string; id?: string; tool_use_id?: string; signature?: string }[] = [];
    const output = await streamAnthropic(model, { messages: [...projected] as Message[] } as TranscriptContext, {
      apiKey: "test-key",
      onPayload: value => {
        const body = value as { messages: { content: unknown }[] };
        for (const message of body.messages) if (Array.isArray(message.content)) converted.push(...message.content);
        throw new Error("stop before transport");
      },
    }).result();
    expect(output.errorMessage).toContain("stop before transport");
    expect(converted.filter(block => block.type === "tool_use").map(block => block.id)).toEqual(["toolu_1", "toolu_2", "toolu_3"]);
    expect(converted.filter(block => block.type === "tool_result").map(block => block.tool_use_id)).toEqual(["toolu_1", "toolu_2", "toolu_3"]);
    expect(converted.filter(block => block.type === "thinking").map(block => block.signature)).toEqual(["signature_1"]);
  });

  it("rewrites only the matching occurrence when Responses IDs are reused", () => {
    const messages = [assistant([thinking(), call("same|fc_same")]), result("same|fc_same", "x".repeat(40_000)),
      assistant([thinking(), call("same|fc_same")]), result("same|fc_same", "small"), user("next"),
      assistant([thinking("current"), call("same|fc_same")]), result("same|fc_same", "small")];
    const { projected } = project(messages, 4);
    expect(projected[0]).toBe(messages[0]);
    expect((projected[1] as ToolResultMessage).toolCallId).toBe("same|fc_same");
    expect(((projected[2] as AssistantMessage).content[0] as ToolCall).id).toBe("same");
    expect((projected[3] as ToolResultMessage).toolCallId).toBe("same");
    expect(projected[5]).toBe(messages[5]);
    expect(projected[6]).toBe(messages[6]);
  });
});

it("keeps every reasoning signature's generating context over mixed boundaries and a disable/enable toggle", () => {
  const projector = createAssignmentProjector();
  const raw: AgentMessage[] = [];
  const generatedUnder = new Map<number, string>();
  let id = 0, clears = 0, noClears = 0, checks = 0;
  const request = () => {
    const projected = projector.project(raw);
    for (let index = 0; index < projected.length; index++) {
      const message = projected[index]!;
      if (message.role !== "assistant" || !message.content.some(block => block.type === "thinking")) continue;
      expect(JSON.stringify(projected.slice(0, index)), `signature at ${index}`).toBe(generatedUnder.get(index));
      expect(message).toEqual(raw[index]);
      checks++;
    }
    return projected;
  };
  const sizes = [60_000, 100, 20_000, 20_000, 100, 50_000, 100, 100, 44_000, 100];
  const enabled = [true, true, true, true, true, false, false, true, true, true];
  sizes.forEach((size, assignment) => {
    const before = JSON.stringify(request());
    const plan = projector.beginAssignment(raw, raw.length, { enabled: enabled[assignment] });
    if (plan.stats.results) clears++;
    else {
      noClears++;
      expect(plan.stats.thinkingBlocks).toBe(0);
      expect(JSON.stringify(request())).toBe(before);
    }
    raw.push(user(`assignment ${assignment}`));
    for (const chars of [size, 50, -1]) {
      generatedUnder.set(raw.length, JSON.stringify(request()));
      const toolName = chars < 0 ? "report_result" : "read";
      const callId = `call_${++id}|fc_${id}`;
      raw.push(assistant([thinking(`signed ${assignment}-${id}`), call(callId, toolName)]));
      raw.push(result(callId, "x".repeat(Math.max(chars, 20)), toolName));
    }
    request();
  });
  expect(clears).toBeGreaterThanOrEqual(3);
  expect(noClears).toBeGreaterThanOrEqual(3);
  expect(checks).toBeGreaterThan(100);
});

describe("compaction projection boundary reset", () => {
  it("drops all stale index maps mid-assignment and plans afresh at the next boundary", () => {
    const projector = createAssignmentProjector();
    const before: AgentMessage[] = [user("old"), assistant([call("reused"), thinking()]), result("reused", "x".repeat(5000))];
    projector.beginAssignment(before, before.length, { minClearTokens: 0 });
    expect(textOf(projector.project(before)[2]!)).toContain("cleared");
    projector.reset();
    const after: AgentMessage[] = [user("summary"), assistant([call("reused")]), result("reused", "y".repeat(5000))];
    expect(projector.project(after)).toBe(after);
    expect(() => projector.project([user("short summary")])).not.toThrow();
    expect(projector.plan).toBeUndefined();
    projector.beginAssignment(after, after.length, { minClearTokens: 0 });
    expect(projector.plan?.stats.results).toBe(1);
    expect(textOf(projector.project(after)[2]!)).toContain("cleared");
  });
});
