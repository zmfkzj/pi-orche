import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { Value } from "typebox/value";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { createCodemodeExtension, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "../../src/tools/read.js";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";
import { cleanupWorkspaces, tempWorkspace } from "./harness.js";

/**
 * Pi 1.1.0 read contract for programmatic callers: `outputSchema` (text | image block) and a matching `structuredContent`,
 * which codemode scripts receive instead of the text (`codemode/execute.js` toScriptValue needs both). Orche's read keeps its
 * model-facing content and adds the structured value.
 */
afterEach(cleanupWorkspaces);

const source = ["export function alpha() {", "  return 1;", "}", "", "export const beta = 2;"].join("\n") + "\n";
async function workspace() {
  const cwd = await tempWorkspace();
  await writeFile(join(cwd, "sample.ts"), source);
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "long.txt"), Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`).join("\n"));
  await writeFile(join(cwd, "fake.png"), "not really an image\n");
  await writeFile(join(cwd, "pic.png"), await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer());
  return cwd;
}
type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: unknown; isError?: boolean };
const textOf = (result: Result) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");

describe("read structured output (pi 1.1.0 outputSchema)", () => {
  it("declares Pi's read outputSchema", async () => {
    const cwd = await workspace();
    const tool = createReadTool(cwd);
    expect(tool.outputSchema).toBeDefined();
    expect(tool.outputSchema).toBe(createReadToolDefinition(cwd).outputSchema);
  });

  it.each([
    ["a normal range", { path: "sample.ts" }],
    ["an offset/limit range", { path: "sample.ts", offset: 2, limit: 2 }],
    ["a capped file with its continuation notice", { path: "long.txt" }],
    ["an empty file", { path: "empty.txt" }],
    ["an outline", { path: "sample.ts", outline: true }],
    ["a symbol", { path: "sample.ts", symbol: "alpha" }],
    ["a .png that is not an image (Pi's text fallback)", { path: "fake.png" }],
  ])("repeats the exact model-facing text as structuredContent for %s", async (_name, args) => {
    const cwd = await workspace();
    const tool = createReadTool(cwd);
    const result = await tool.execute("r", args as never, undefined, undefined, undefined as never) as Result;
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.structuredContent).toBe(result.content[0]!.text);
    expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
  });

  it("keeps anchors, notices and hints in the text unchanged", async () => {
    const cwd = await workspace();
    const result = await createReadTool(cwd).execute("r", { path: "long.txt" } as never, undefined, undefined, undefined as never) as Result;
    expect(textOf(result)).toMatch(/^1#[0-9a-f]{4}\|line 1\n/);
    expect(textOf(result)).toContain("[Showing lines 1-2000 of 2100 (output cap). Use offset=2001 to continue.]");
    expect(Object.keys(result).sort()).toEqual(["content", "details", "structuredContent"]);
  });

  it("returns Pi's image block for a real PNG, matching the model-facing image and note", async () => {
    const cwd = await workspace();
    const tool = createReadTool(cwd);
    const result = await tool.execute("r", { path: "pic.png" } as never, undefined, undefined, undefined as never) as Result;
    const image = result.content.find(c => c.type === "image")!;
    expect(image.mimeType).toBe("image/png");
    expect(result.structuredContent).toEqual({ type: "image", data: image.data, mimeType: image.mimeType, note: textOf(result) });
    expect(Value.Check(tool.outputSchema!, result.structuredContent)).toBe(true);
  });

  it("gives codemode scripts the image block and the anchored text (real session, faux model)", async () => {
    const cwd = await workspace();
    const direct = await createReadTool(cwd).execute("r", { path: "pic.png" } as never, undefined, undefined, undefined as never) as Result;
    const anchored = textOf(await createReadTool(cwd).execute("r", { path: "sample.ts" } as never, undefined, undefined, undefined as never) as Result);
    const script = [
      "const img = await tools.read({ path: 'pic.png' });",
      "const txt = await tools.read({ path: 'sample.ts' });",
      "const outline = await tools.read({ path: 'sample.ts', outline: true });",
      "text(JSON.stringify({ kind: typeof img, type: img.type, mimeType: img.mimeType, data: img.data, note: img.note, txt, outline }));",
    ].join("\n");
    const faux = await fauxRuntime([
      reply([call("codemode", { code: script }, { id: "cm" })], { stopReason: "toolUse" }),
      reply("done"),
    ]);
    const session = await createSession({
      route: faux.route, cwd, tools: ["read", "codemode"], instructions: "test", modelRuntime: faux.runtime,
      extensionFactories: [createCodemodeExtension({ mode: "on", models: false })],
    });
    try {
      await session.prompt("go");
      const results = (session.messages as Array<{ role: string; toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "toolResult");
      expect(results.map(m => m.toolName)).toEqual(["codemode"]);
      const text = (results[0]!.content ?? []).map(c => c.text ?? "").join("\n");
      expect(results[0]!.isError, text).not.toBe(true);
      expect(text).toContain("Script completed");
      const value = JSON.parse(text.slice(text.indexOf("{\"kind\""), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
      const image = direct.content.find(c => c.type === "image")!;
      expect(value).toMatchObject({ kind: "object", type: "image", mimeType: "image/png", data: image.data, note: textOf(direct), txt: anchored });
      expect(value.outline).toMatch(/^sample\.ts: 5 lines/);
    } finally {
      session.dispose();
    }
  });
});
