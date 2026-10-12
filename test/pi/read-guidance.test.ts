// The read tool's narrowing guidance reaches what a worker's model receives: its system prompt (Pi's tool guidelines)
// and the read declaration (description), through the real worker session factory and a faux provider.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage as reply, getCurrentSystemPrompt, getCurrentTools, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("worker read guidance", () => {
  it("is in the worker's system prompt and read declaration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orche-read-guidance-"));
    roots.push(cwd);
    const seen: { prompt?: string; description?: string } = {};
    const step: FauxResponseStep = (context) => {
      seen.prompt = getCurrentSystemPrompt(context.messages);
      seen.description = getCurrentTools(context.messages).find(tool => tool.name === "read")?.description;
      return reply("ok");
    };
    const f = await fauxRuntime([step]);
    const session = await createSession({ cwd, route: f.route, modelRuntime: f.runtime, tools: ["read", "grep", "edit"], instructions: "ROLE" });
    await session.prompt("hi");
    expect(seen.prompt).toContain("after grep, read offset/limit around the matches; in a large JS/TS/Markdown file, outline then symbol.");
    expect(seen.prompt).toContain("Read small files, images and documents you must read completely in full (Markdown is never outlined automatically).");
    expect(seen.description).toContain("a JS/TS file over 16KB returns its declaration outline first; offset: 1 reads its text.");
    session.dispose();
  });
});
