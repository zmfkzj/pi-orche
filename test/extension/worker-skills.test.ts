// End to end: the skills main's Pi discovered reach orche_task workers' and orche_spawn sub-workers' prompts as metadata, also in a
// run that a triggerTurn message starts before main's own first run (Pi emits no before_agent_start for it); main's extensions,
// hooks, tools and conversation do not.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { SPAWN_TOOL } from "../../src/orchestrator/spawn.js";
import { WORKER_SKILLS_NOTE } from "../../src/pi/worker-skills.js";
import { createHarness, tool, type Harness } from "./harness.js";

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeSkill(root: string, name: string, frontmatter: string, body: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n${body}\n`);
  return join(root, name, "SKILL.md");
}

async function skillsDir() {
  const root = await mkdtemp(join(tmpdir(), "orche-main-skills-"));
  dirs.push(root);
  const visible = await writeSkill(root, "main-visible", "description: Route main-discovered work.\n", "BODY-SENTINEL-VISIBLE");
  await writeSkill(root, "main-hidden", "description: Explicit command only.\ndisable-model-invocation: true\n", "BODY-SENTINEL-HIDDEN");
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

/** Counts main's before_agent_start events: Pi emits none for a run that a triggerTurn message starts. */
function runStarts(counter: { starts: number }): ExtensionFactory {
  return pi => { pi.on("before_agent_start", () => { counter.starts++; return undefined; }); };
}

type Context = Parameters<FauxResponseFactory>[0];
const firstUser = (context: Context) => JSON.stringify(context.messages.find(message => message.role === "user"));
const turnOf = (context: Context) => context.messages.filter(message => message.role === "assistant").length;
/** A wake like a session-bus peer note or an orche result: a custom message that starts a run of its own, no user prompt. */
const wake = (h: Harness) => h.session.sendCustomMessage({ customType: "peer-note", content: "WAKE-SENTINEL: please check greeting.txt", display: true }, { triggerTurn: true });
const explore = (seen: { text?: string }) => (context: Context) => { seen.text = JSON.stringify(context); return tool("report_result", { kind: "explore", summary: "Inspected" }); };

/** A worker's prompt lists exactly main's loader list without disable-model-invocation skills (name and SKILL.md path), nothing else of main. */
function expectLoaderSkills(h: Harness, text: string) {
  const loaded = h.session.resourceLoader.getSkills().skills;
  const section = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(text)?.[1] ?? "";
  const listed = [...section.matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]).sort();
  expect(listed).toEqual(loaded.filter(skill => !skill.disableModelInvocation).map(skill => skill.name).sort());
  for (const skill of loaded.filter(item => !item.disableModelInvocation)) expect(text).toContain(skill.filePath);
  expect(text).toContain(WORKER_SKILLS_NOTE);
  expect(text).not.toContain("BODY-SENTINEL");
  expect(text).not.toContain("main_only_tool");
  expect(text).not.toContain("MAIN-HOOK-SENTINEL");
  expect(text).not.toContain("WAKE-SENTINEL");
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

  it("a run a triggerTurn message starts first (no user prompt, no before_agent_start) gives its worker and sub-worker main's skills", async () => {
    const skills = await skillsDir();
    const counter = { starts: 0 };
    const seen: { worker?: string; subWorker?: string } = {};
    // The implement worker orchestrates: it starts a verify sub-worker with orche_spawn, then reports.
    const respond: FauxResponseFactory = context => {
      if (/You are sub-worker W\d+\.\d+/.test(firstUser(context))) {
        seen.subWorker = JSON.stringify(context);
        return tool("report_result", { kind: "verify", summary: "greeting.txt says hello", data: { passed: true, evidence: ["read greeting.txt"], issues: [] } });
      }
      if (turnOf(context) === 0) {
        seen.worker = JSON.stringify(context);
        return tool(SPAWN_TOOL, { reason: "verification", workers: [{ name: "check", role: "verify", request: "Original request: greeting.txt says hello. Run your own checks." }] });
      }
      return tool("report_result", { kind: "implement", summary: "Checked and independently verified", data: { status: "done", split: { decision: "split", criteria: ["verification"], reason: "the user asked for an independent review" } } });
    };
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "implement", request: "Check that greeting.txt says hello. The user asks for an independent review.", wait: true }), reply("relayed")],
      orcheSteps: Array.from({ length: 6 }, () => respond),
      mainMode: "single", extraExtensions: [mainOnlyExtension(skills.root), runStarts(counter)],
    });
    open.push(h);
    execFileSync("git", ["init", "-q"], { cwd: h.cwd });
    await wake(h);
    expect(counter.starts).toBe(0);
    expect(seen.worker).toBeDefined();
    expect(seen.subWorker).toBeDefined();
    for (const text of [seen.worker!, seen.subWorker!]) {
      expect(text).toContain("main-visible");
      expect(text).toContain(skills.visible);
      expect(text).not.toContain("main-hidden");
      expectLoaderSkills(h, text);
    }
  });

  it("after /reload, the first run a triggerTurn message starts lists what main's loader found: global, project, package and extension skills", async () => {
    const skills = await skillsDir();
    const pkg = await mkdtemp(join(tmpdir(), "orche-skill-package-"));
    dirs.push(pkg);
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "orche-skill-package", version: "1.0.0", pi: { skills: ["./skills"] } }));
    await writeSkill(join(pkg, "skills"), "package-skill", "description: From a package.\n", "BODY-SENTINEL-PACKAGE");
    const counter = { starts: 0 };
    const seen: { text?: string } = {};
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt", wait: true }), reply("relayed")],
      orcheSteps: [explore(seen)],
      mainMode: "single", single: { spawn: false }, discoverSkills: true, settings: { packages: [pkg] },
      extraExtensions: [mainOnlyExtension(skills.root), runStarts(counter)],
    });
    open.push(h);
    await writeSkill(join(h.agentDir, "skills"), "global-skill", "description: From the user's skills.\n", "BODY-SENTINEL-GLOBAL");
    await writeSkill(join(h.agentDir, "skills"), "global-hidden", "description: Explicit command only.\ndisable-model-invocation: true\n", "BODY-SENTINEL-GLOBAL-HIDDEN");
    await writeSkill(join(h.cwd, ".pi", "skills"), "project-skill", "description: From the project.\n", "BODY-SENTINEL-PROJECT");
    await h.session.reload();
    await wake(h);
    expect(counter.starts).toBe(0);
    const names = h.session.resourceLoader.getSkills().skills.map(skill => skill.name);
    expect(names).toEqual(expect.arrayContaining(["global-skill", "global-hidden", "project-skill", "package-skill", "main-visible", "main-hidden"]));
    for (const name of ["global-skill", "project-skill", "package-skill", "main-visible"]) expect(seen.text).toContain(`<name>${name}</name>`);
    expect(seen.text).not.toContain("global-hidden");
    expectLoaderSkills(h, seen.text!);
  });

  it("nothing outside main's loader list is searched: with --no-skills a woken run's worker lists no skill", async () => {
    const counter = { starts: 0 };
    const seen: { text?: string } = {};
    const h = await createHarness({
      mainSteps: [tool("orche_task", { role: "explore", request: "Inspect greeting.txt", wait: true }), reply("relayed")],
      orcheSteps: [explore(seen)],
      mainMode: "single", single: { spawn: false }, extraExtensions: [runStarts(counter)],
    });
    open.push(h);
    await writeSkill(join(h.agentDir, "skills"), "global-skill", "description: From the user's skills.\n", "BODY-SENTINEL-GLOBAL");
    await writeSkill(join(h.cwd, ".pi", "skills"), "project-skill", "description: From the project.\n", "BODY-SENTINEL-PROJECT");
    await h.session.reload();
    await wake(h);
    expect(counter.starts).toBe(0);
    expect(h.session.resourceLoader.getSkills().skills).toEqual([]);
    expect(seen.text).toContain("report_result");
    expect(seen.text).not.toContain("<available_skills>");
    expect(seen.text).not.toContain("global-skill");
    expect(seen.text).not.toContain("project-skill");
  });
});
