// End to end: the skills main's Pi discovered reach an orche_task worker's prompt as metadata; main's extensions, hooks, tools and
// conversation do not.
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { WORKER_SKILLS_NOTE } from "../../src/pi/worker-skills.js";
import { createHarness, tool, type Harness } from "./harness.js";

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function skillsDir() {
  const root = await mkdtemp(join(tmpdir(), "orche-main-skills-"));
  dirs.push(root);
  const make = async (name: string, frontmatter: string, body: string) => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n${body}\n`);
    return join(root, name, "SKILL.md");
  };
  const visible = await make("main-visible", "description: Route main-discovered work.\n", "BODY-SENTINEL-VISIBLE");
  await make("main-hidden", "description: Explicit command only.\ndisable-model-invocation: true\n", "BODY-SENTINEL-HIDDEN");
  return { root, visible };
}

/** Another main extension: it adds skills through Pi's resources_discover, a tool, and a request hook that a worker must not inherit. */
function mainOnlyExtension(path: string): ExtensionFactory {
  return pi => {
    pi.on("resources_discover", () => ({ skillPaths: [path] }));
    pi.registerTool({ name: "main_only_tool", label: "Main only", description: "Only in main", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "x" }], details: undefined }) });
    pi.on("context", event => ({ messages: [...event.messages, { role: "custom", customType: "main-hook", content: "MAIN-HOOK-SENTINEL", display: false, timestamp: Date.now() } as (typeof event.messages)[number]] }));
  };
}

describe("orche_task worker skills", () => {
  it("lists main's discovered skills (not disabled ones, not their bodies) without main's extensions, hooks, tools or conversation", async () => {
    const skills = await skillsDir();
    let mainText = "";
    let workerText = "";
    const h = await createHarness({
      mainSteps: [context => { mainText = JSON.stringify(context); return tool("orche_task", { role: "explore", request: "Inspect greeting.txt", wait: true }); }, reply("relayed")],
      orcheSteps: [context => { workerText = JSON.stringify(context); return tool("report_result", { kind: "explore", summary: "Inspected" }); }],
      mainMode: "single", single: { spawn: false }, extraExtensions: [mainOnlyExtension(skills.root)],
    });
    open.push(h);
    await h.session.prompt("MAIN-CONVERSATION-SENTINEL: please inspect");
    // Main itself sees the skill and its own extension.
    expect(mainText).toContain("main-visible");
    expect(mainText).toContain("MAIN-HOOK-SENTINEL");
    // The worker lists the same metadata, with the precedence note and its own role instructions.
    expect(workerText).toContain("<available_skills>");
    expect(workerText).toContain("main-visible");
    expect(workerText).toContain("Route main-discovered work.");
    expect(workerText).toContain(skills.visible);
    expect(workerText).toContain(WORKER_SKILLS_NOTE);
    expect(workerText).toContain("report_result");
    expect(workerText).not.toContain("main-hidden");
    expect(workerText).not.toContain("BODY-SENTINEL");
    // Nothing else of main: not its other extension's tool or request hook, not its conversation.
    expect(workerText).not.toContain("main_only_tool");
    expect(workerText).not.toContain("MAIN-HOOK-SENTINEL");
    expect(workerText).not.toContain("MAIN-CONVERSATION-SENTINEL");
  });
});
