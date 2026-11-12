import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssignmentProjector } from "../../src/pi/context-projection.js";
import { IMAGE_CONTEXT_LIMITS, OMITTED_TOOL_IMAGE, keptImageStart } from "../../src/pi/image-context.js";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [], sessions: AgentSession[] = [];
afterEach(async () => {
  sessions.splice(0).forEach(session => session.dispose());
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const results = (messages: readonly AgentMessage[]): ToolResultMessage[] => messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
const imageCount = (messages: readonly AgentMessage[]) => results(messages).reduce((sum, m) => sum + m.content.filter(b => b.type === "image").length, 0);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=";

describe("image budget on actual worker provider requests", () => {
  it.each([false, true])("projects every turn with assignment clearing %s; raw state and JSONL stay complete", async withAssignment => {
    const root = await mkdtemp(join(tmpdir(), "orche-image-context-")); roots.push(root);
    const requests: AgentMessage[][] = [];
    const total = IMAGE_CONTEXT_LIMITS.maxImages + 4;
    const responses: FauxResponseStep[] = Array.from({ length: total + 1 }, (_, i) => context => {
      requests.push(structuredClone(context.messages));
      return i === total ? reply("done") : reply([
        { type: "thinking", thinking: `reason ${i}`, thinkingSignature: `signed-${i}` },
        call("observe_fixture", { index: i }),
      ], { stopReason: "toolUse" });
    });
    const f = await fauxRuntime(responses);
    const projector = withAssignment ? createAssignmentProjector() : undefined;
    // Even an explicitly disabled assignment clearer must not disable transport-size hygiene.
    projector?.beginAssignment([], 0, { enabled: false });
    const session = await createSession({
      cwd: root, route: f.route, modelRuntime: f.runtime, instructions: "test", tools: ["observe_fixture"],
      sessionFile: join(root, "worker.jsonl"), contextProjection: projector,
      customTools: [{
        name: "observe_fixture", label: "Observe fixture", description: "Return a fixture screenshot", parameters: Type.Object({ index: Type.Number() }),
        execute: async (_id, { index }) => ({ content: [{ type: "text", text: `Observed frame ${index}; saved /tmp/frame-${index}.png` }, { type: "image", data: png, mimeType: "image/png" }], details: { index } }),
      }],
    });
    sessions.push(session);
    await session.prompt("One long GUI assignment");
    expect(requests).toHaveLength(total + 1);
    requests.forEach((request, index) => {
      // Batched default: all images up to the ceiling (8), then pruned to 4 and growing again (8 → 4 at the 9th image).
      expect(imageCount(request)).toBe(index - keptImageStart(Array(index).fill(png.length), IMAGE_CONTEXT_LIMITS));
      expect(imageCount(request)).toBe(index <= IMAGE_CONTEXT_LIMITS.maxImages ? index : IMAGE_CONTEXT_LIMITS.keepImages + (index - IMAGE_CONTEXT_LIMITS.maxImages - 1));
      expect(results(request)).toHaveLength(index);
      for (const result of results(request)) {
        expect(request.some(m => m.role === "assistant" && m.content.some(b => b.type === "toolCall" && b.id === result.toolCallId))).toBe(true);
      }
    });
    expect(JSON.stringify(requests.at(-1))).toContain(OMITTED_TOOL_IMAGE);
    expect(results(requests.at(-1)!).at(-1)?.content).toContainEqual({ type: "image", data: png, mimeType: "image/png" });
    expect(imageCount(session.messages)).toBe(total);
    expect(JSON.stringify(session.messages)).not.toContain(OMITTED_TOOL_IMAGE);
    const persisted = (await readFile(session.sessionFile!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const raw = persisted.filter(e => e.type === "message").map(e => e.message as AgentMessage);
    expect(imageCount(raw)).toBe(total);
    expect(JSON.stringify(raw)).not.toContain(OMITTED_TOOL_IMAGE);
    // Reopen the full raw record: no saved projection indices or manual compaction are required.
    session.dispose();
    f.faux.setResponses([context => { requests.push(structuredClone(context.messages)); return reply("resumed"); }]);
    const resumed = await createSession({ cwd: root, route: f.route, modelRuntime: f.runtime, instructions: "test", tools: [], sessionFile: session.sessionFile });
    sessions.push(resumed);
    await resumed.prompt("Continue from the same record");
    expect(imageCount(requests.at(-1)!)).toBe(total - keptImageStart(Array(total).fill(png.length), IMAGE_CONTEXT_LIMITS));
    expect(imageCount(resumed.messages)).toBe(total);
  });
});
