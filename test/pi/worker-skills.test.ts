// Worker skill discovery (src/pi/worker-skills.ts): main's discovered skills reach a worker session's prompt as metadata only.
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createSession } from "../../src/pi/session-factory.js";
import { WORKER_SKILLS_NOTE, discoveredSkills, workerSkills } from "../../src/pi/worker-skills.js";
import { runSpecialistSession } from "../../src/specialists/session.js";
import { fauxRuntime } from "../helpers/faux.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function skillFixture() {
  const root = await mkdtemp(join(tmpdir(), "orche-worker-skills-"));
  roots.push(root);
  const make = async (name: string, description: string, body: string): Promise<Skill> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    await writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
    return { name, description, filePath, baseDir: dir, sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }), disableModelInvocation: false };
  };
  const visible = await make("visible-skill", "Use for visible fixture work.", "BODY-SENTINEL-VISIBLE");
  const hidden = { ...await make("hidden-skill", "Never listed to a model.", "BODY-SENTINEL-HIDDEN"), disableModelInvocation: true };
  return { root, visible, hidden };
}

/** A faux step that records what the provider receives and then answers. */
function capture(into: { text?: string }, answer: AssistantMessage): FauxResponseStep {
  return context => { into.text = JSON.stringify(context); return answer; };
}

describe("workerSkills", () => {
  it("copies metadata only, leaves disable-model-invocation skills out and does not touch the input", async () => {
    const { visible, hidden } = await skillFixture();
    const input = [visible, hidden];
    const before = structuredClone(input);
    const copied = workerSkills(input);
    expect(copied).toEqual([visible]);
    expect(copied[0]).not.toBe(visible);
    expect(copied[0]!.sourceInfo).not.toBe(visible.sourceInfo);
    expect(input).toEqual(before);
    expect(workerSkills(undefined)).toEqual([]);
  });
});

describe("createSession skills", () => {
  it("lists main's skills in the worker's available_skills with the precedence note, never their bodies", async () => {
    const { visible, hidden } = await skillFixture();
    const seen: { text?: string } = {};
    const f = await fauxRuntime([capture(seen, reply("ok"))]);
    const session = await createSession({ cwd: visible.baseDir, route: f.route, modelRuntime: f.runtime, tools: ["read", "bash"], instructions: "ROLE-INSTRUCTIONS: report in the requested format", skills: [visible, hidden] });
    await session.prompt("hi");
    expect(session.systemPrompt).toContain("<available_skills>");
    const text = seen.text!;
    expect(text).toContain("<available_skills>");
    expect(text).toContain("visible-skill");
    expect(text).toContain("Use for visible fixture work.");
    expect(text).toContain(JSON.stringify(visible.filePath).slice(1, -1));
    expect(text).not.toContain("hidden-skill");
    expect(text).not.toContain("BODY-SENTINEL");
    expect(text).toContain(WORKER_SKILLS_NOTE);
    expect(text).toContain("ROLE-INSTRUCTIONS: report in the requested format");
    // Skills add no tool: the session keeps exactly the tools it was given.
    expect(session.getActiveToolNames().sort()).toEqual(expect.arrayContaining(["bash", "read"]));
    expect(session.getActiveToolNames()).not.toContain("skill");
    session.dispose();
  });

  it("keeps a session without skills free of the section and the note", async () => {
    const { visible, hidden } = await skillFixture();
    const seen: { text?: string } = {};
    const f = await fauxRuntime([capture(seen, reply("ok"))]);
    // Only invisible skills: nothing to list, so no note either.
    const session = await createSession({ cwd: visible.baseDir, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", skills: [hidden] });
    await session.prompt("hi");
    expect(seen.text).not.toContain("<available_skills>");
    expect(seen.text).not.toContain(WORKER_SKILLS_NOTE);
    session.dispose();
    const plain = await fauxRuntime([capture(seen, reply("ok"))]);
    const without = await createSession({ cwd: visible.baseDir, route: plain.route, modelRuntime: plain.runtime, tools: ["read"], instructions: "test" });
    await without.prompt("hi");
    expect(seen.text).not.toContain("<available_skills>");
    without.dispose();
  });

  it("a living session keeps the list it was created with", async () => {
    const { visible } = await skillFixture();
    const list: Skill[] = [visible];
    const seen: { text?: string } = {};
    const f = await fauxRuntime([reply("first"), capture(seen, reply("second"))]);
    const session = await createSession({ cwd: visible.baseDir, route: f.route, modelRuntime: f.runtime, tools: ["read"], instructions: "test", skills: list });
    await session.prompt("one");
    list.length = 0;
    session.setActiveToolsByName(["read", "bash"]);
    await session.prompt("two");
    expect(seen.text).toContain("visible-skill");
    session.dispose();
  });
});

describe("specialist (orche_spawn sub-worker) sessions", () => {
  it("pass the skills to their session like orche_task workers", async () => {
    const { visible } = await skillFixture();
    const seen: { text?: string } = {};
    const f = await fauxRuntime([capture(seen, reply([call("report_result", { ok: true })], { stopReason: "toolUse" }))]);
    const outcome = await runSpecialistSession({
      actor: "W1.1", route: f.route, runtime: f.runtime, cwd: visible.baseDir, instructions: "SUB-WORKER-INSTRUCTIONS", prompt: "do it",
      tools: ["read"], report: { name: "report_result", label: "Report", description: "Report", parameters: Type.Object({ ok: Type.Boolean() }) },
      maxTurns: 3, timeoutMs: 10_000, signal: new AbortController().signal, skills: [visible],
    });
    expect(outcome.value).toEqual({ ok: true });
    expect(seen.text).toContain("visible-skill");
    expect(seen.text).toContain("SUB-WORKER-INSTRUCTIONS");
    expect(seen.text).toContain(WORKER_SKILLS_NOTE);
    expect(seen.text).not.toContain("BODY-SENTINEL");
  });
});

describe("discoveredSkills (main's skill commands, before main's first run)", () => {
  it("takes skill commands only, reads disable-model-invocation from the listed file and leaves out what cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "orche-discovered-skills-"));
    roots.push(root);
    const file = async (name: string, content: string) => {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "SKILL.md"), content);
      return join(root, name, "SKILL.md");
    };
    const visible = await file("visible", "---\nname: visible\ndescription: Shown.\n---\nBODY\n");
    const hidden = await file("hidden", "---\nname: hidden\ndescription: Explicit only.\ndisable-model-invocation: true\n---\nBODY\n");
    const quoted = await file("quoted", "---\nname: quoted\ndescription: A string flag is not the boolean.\ndisable-model-invocation: \"true\"\n---\nBODY\n");
    const broken = await file("broken", "---\nname: broken\ndescription: [unclosed\n---\nBODY\n");
    const source = (path: string) => ({ ...createSyntheticSourceInfo(path, { source: "local", baseDir: root }) });
    const skills = discoveredSkills([
      { name: "workbench", description: "an extension command", source: "extension", sourceInfo: source(visible) },
      { name: "review", description: "a prompt template", source: "prompt", sourceInfo: source(visible) },
      { name: "skill:visible", description: "Shown.", source: "skill", sourceInfo: source(visible) },
      { name: "skill:hidden", description: "Explicit only.", source: "skill", sourceInfo: source(hidden) },
      { name: "skill:quoted", description: "A string flag is not the boolean.", source: "skill", sourceInfo: source(quoted) },
      { name: "skill:broken", description: "Unparsable.", source: "skill", sourceInfo: source(broken) },
      { name: "skill:gone", description: "Deleted since.", source: "skill", sourceInfo: source(join(root, "gone", "SKILL.md")) },
      { name: "skill:relative", description: "Not absolute.", source: "skill", sourceInfo: source("relative/SKILL.md") },
    ]);
    expect(skills.map(skill => skill.name)).toEqual(["visible", "quoted"]);
    expect(skills[0]).toMatchObject({ name: "visible", description: "Shown.", filePath: visible, baseDir: join(root, "visible"), disableModelInvocation: false });
    expect(skills[0]!.sourceInfo.path).toBe(visible);
    expect(discoveredSkills(undefined)).toEqual([]);
  });
});
