import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as assistant, type Api, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { projectImageContext } from "../../src/pi/image-context.js";

const modelFor = <T extends Api>(api: T, provider: string): Model<T> => ({
  api, provider, id: "image-budget-test", name: "Image budget test", baseUrl: "https://invalid.example",
  reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
function transcript(model: Model<Api>, responses = true): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "user", content: "One long assignment", timestamp: 1 }];
  for (let n = 1; n <= 3; n++) {
    const id = responses ? `call_${n}|fc_${n}` : `toolu_${n}`;
    messages.push({
      ...assistant([
        { type: "thinking", thinking: `reason ${n}`, thinkingSignature: responses ? JSON.stringify({ type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc_${n}` }) : `signature_${n}` },
        { type: "toolCall", id, name: "observe", arguments: {} },
      ], { stopReason: "toolUse" }),
      provider: model.provider, api: model.api, model: model.id,
    }, {
      role: "toolResult", toolCallId: id, toolName: "observe", content: [{ type: "text", text: `frame ${n}` }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false, timestamp: n,
    });
  }
  return projectImageContext(messages, { maxImages: 1, maxBase64Bytes: 100 });
}
function checkResponses(input: ReturnType<typeof convertResponsesMessages>) {
  const calls = input.filter(item => item.type === "function_call");
  const outputs = input.filter(item => item.type === "function_call_output");
  expect(calls.map(item => item.call_id)).toEqual(["call_1", "call_2", "call_3"]);
  expect(outputs.map(item => item.call_id)).toEqual(calls.map(item => item.call_id));
  expect(calls.map(item => item.id)).toEqual(["fc_1", undefined, undefined]);
  expect(input.filter(item => item.type === "reasoning").map(item => item.id)).toEqual(["rs_1"]);
  expect(JSON.stringify(input).match(/data:image\/png;base64,AAAA/g)).toHaveLength(1);
  expect(JSON.stringify(outputs)).not.toContain("No result provided");
}

describe("image budget with real provider serializers (no network)", () => {
  it.each([["openai-responses", "openai"], ["openai-codex-responses", "openai-codex"], ["cliproxyapi-codex-responses", "cliproxyapi"]])("keeps reasoning/item pairing for %s", (api, provider) => {
    const model = modelFor(api, provider);
    checkResponses(convertResponsesMessages(model, { messages: transcript(model) as Message[] } as TranscriptContext, new Set([provider])));
  });

  it("builds the actual Codex request body with one image and complete call/result pairs", async () => {
    const model = modelFor("openai-codex-responses", "openai-codex");
    let input: ReturnType<typeof convertResponsesMessages> | undefined;
    const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64");
    const output = await streamCodex(model, { messages: transcript(model) as Message[] } as TranscriptContext, {
      apiKey: `header.${payload}.signature`,
      onPayload: value => { input = (value as { input: typeof input }).input; throw new Error("stop before transport"); },
    }).result();
    expect(output.errorMessage).toContain("stop before transport");
    checkResponses(input!);
  });

  it("keeps native Anthropic tool_use/tool_result pairing and unmodified surviving signatures", async () => {
    const model = modelFor("anthropic-messages", "anthropic");
    let serialized = "";
    const blocks: { type: string; id?: string; tool_use_id?: string; signature?: string }[] = [];
    const output = await streamAnthropic(model, { messages: transcript(model, false) as Message[] } as TranscriptContext, {
      apiKey: "test-key",
      onPayload: value => {
        serialized = JSON.stringify(value);
        for (const m of (value as { messages: { content: unknown }[] }).messages) if (Array.isArray(m.content)) blocks.push(...m.content);
        throw new Error("stop before transport");
      },
    }).result();
    expect(output.errorMessage).toContain("stop before transport");
    expect(blocks.filter(b => b.type === "tool_use").map(b => b.id)).toEqual(["toolu_1", "toolu_2", "toolu_3"]);
    expect(blocks.filter(b => b.type === "tool_result").map(b => b.tool_use_id)).toEqual(["toolu_1", "toolu_2", "toolu_3"]);
    expect(blocks.filter(b => b.type === "thinking").map(b => b.signature)).toEqual(["signature_1"]);
    expect(serialized.match(/"type":"image"/g)).toHaveLength(1);
  });
});
