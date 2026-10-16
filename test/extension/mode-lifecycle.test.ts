import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager,
  type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createOrcheExtension } from "../../src/extension/index.js";
import { MainModeState, MODE_ENTRY_TYPE, TOOLS_ENTRY_TYPE } from "../../src/extension/mode.js";
import { fauxRuntime } from "../helpers/faux.js";
import { tool } from "./harness.js";

const roots: string[] = [];
const runtimes: AgentSessionRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Real SDK lifecycle, disk-backed sessions in scratch, faux model; no provider calls. */
async function setup(mode: "single" | "strong" | "ultra" | "direct") {
  const root = await mkdtemp(join(tmpdir(), "orche-mode-lifecycle-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, mainMode: mode, records: { enabled: false }, bashReview: { enabled: false } }));
  const f = await fauxRuntime();
  let api: ExtensionAPI;
  const starts: string[] = [];
  const errors: string[] = [];
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime: f.runtime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [async pi => {
          api = pi;
          await createOrcheExtension({ agentDir, inheritProviders: false, createRuntime: async () => f.runtime })(pi);
          pi.registerTool({
            name: "nested", label: "Nested", description: "Call another tool", parameters: Type.Object({ name: Type.String() }),
            async execute(_id, args, _signal, _update, ctx) {
              const outcome = await ctx.executeTool(args.name, {});
              return { ...outcome.result, isError: outcome.isError };
            },
          });
          pi.registerTool({ name: "activate_late", label: "Activate", description: "Test a late tool registration", parameters: Type.Object({}),
            async execute() { late(); return { content: [{ type: "text", text: "registered" }], details: undefined }; } });
          pi.on("session_start", event => { starts.push(event.reason); });
        }],
      },
    });
    return { services, diagnostics: services.diagnostics, ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: f.faux.getModel(), thinkingLevel: "off" }) };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")) });
  runtimes.push(runtime);
  const bind = async () => { await runtime.session.bindExtensions({ onError: event => { errors.push(event.error); } }); };
  runtime.setRebindSession(bind);
  await bind();
  let executions = 0;
  const forbidden = mode === "direct" ? "orche_task" : "write";
  function late(exposure: ToolDefinition["exposure"] = "direct") {
    api!.registerTool({ name: forbidden, label: "Forbidden", description: "Must not execute", exposure, parameters: Type.Object({}),
      async execute() { executions++; return { content: [{ type: "text", text: "MUST_NOT_RUN" }], details: undefined }; } });
    if (exposure === "direct") api!.setActiveTools([...api!.getActiveTools(), forbidden]);
  }
  return { f, runtime, late, forbidden, starts, errors, executions: () => executions };
}

describe("Pi 1.3 late and restored main tools", () => {
  it.each(["single", "strong", "ultra", "direct"] as const)("%s never executes forbidden late tools, including nested calls after reload/resume/new", async mode => {
    const h = await setup(mode);
    const file = h.runtime.session.sessionFile!;
    for (const transition of ["startup", "reload", "resume", "new"] as const) {
      if (transition === "reload") await h.runtime.session.reload();
      if (transition === "resume") {
        await h.runtime.newSession();
        await h.runtime.switchSession(file);
      }
      if (transition === "new") await h.runtime.newSession();
      // Deferred tools are callable even when absent from the model's active tool set in Pi 1.3.
      h.late("deferred");
      expect(h.runtime.session.getActiveToolNames()).not.toContain(h.forbidden);
      h.f.faux.setResponses([tool("nested", { name: h.forbidden }), reply("blocked")]);
      await h.runtime.session.prompt(`Attempt nested forbidden tool after ${transition}`);
      const nested = h.runtime.session.messages.findLast(message => message.role === "toolResult");
      expect(JSON.stringify(nested)).toContain(`Blocked by orche mode \\"${mode}\\"`);
      expect(h.executions()).toBe(0);
      // Another extension (or a restored default tool set) can re-activate the same name.
      h.late();
      h.f.faux.setResponses([tool(h.forbidden, {}), reply("blocked")]);
      await h.runtime.session.prompt(`Attempt direct forbidden tool after ${transition}`);
      expect(h.executions()).toBe(0);
      expect(h.runtime.session.messages.findLast(message => message.role === "toolResult")).toMatchObject({ isError: true });
    }
    expect(h.starts).toEqual(["startup", "reload", "new", "resume", "new"]);
    expect(h.errors).toEqual([]);
  });

  it("filters late reactivations from every request, not only the initial session loadout", async () => {
    const h = await setup("single");
    const declared: string[][] = [];
    const capture = (context: TranscriptContext) => {
      declared.push(getCurrentTools(context.messages).map(tool => tool.name));
      return reply("ok");
    };
    h.late();
    h.f.faux.setResponses([context => { capture(context); return tool("activate_late", {}); }, capture]);
    await h.runtime.session.prompt("Check the late registration");
    expect(declared).toHaveLength(2);
    for (const tools of declared) expect(tools).not.toContain("write");
    expect(h.runtime.session.getActiveToolNames()).not.toContain("write");
  });
});

describe("mode restoration", () => {
  it("drops a one-turn direct override when adopting a new branch/session", () => {
    let active = ["read", "write", "orche_task"];
    const state = new MainModeState({ getActiveTools: () => active, getAllTools: () => ["read", "write", "orche_task"].map(name => ({ name })) as never,
      setActiveTools: names => { active = names; }, appendEntry: () => {} });
    state.setOverride("direct");
    state.restore([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "single" } }]);
    state.apply();
    expect(state.effective).toBe("single");
    expect(active).not.toContain("write");
  });

  it("keeps removed tools pending until they register instead of forgetting them on resume", () => {
    let active = ["read"];
    const registered = ["read"];
    const state = new MainModeState({ getActiveTools: () => active, getAllTools: () => registered.map(name => ({ name })) as never,
      setActiveTools: names => { active = names; }, appendEntry: () => {} });
    state.restore([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "direct" } },
      { type: "custom", customType: TOOLS_ENTRY_TYPE, data: { removed: ["write"] } }]);
    state.apply();
    registered.push("write");
    state.apply();
    expect(active).toContain("write");
  });
});
