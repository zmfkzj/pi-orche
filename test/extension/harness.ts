import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionUIContext, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { createOrcheExtension, type OrcheExtensionOptions } from "../../src/extension/index.js";
import { fauxRuntime } from "../helpers/faux.js";

export const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
export const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
/** Orchestration script for a read-only `answer` request that ends with `answer`. */
export const answerScript = (answer: string): FauxResponseStep[] => [
  decision({ type: "classify", taskClass: "answer", workerCount: 1, language: "en", reason: "explanation" }),
  tool("report_result", { kind: "answer", summary: answer, data: { evidence: ["greeting.txt"] } }),
  decision({ type: "answer_from_worker", sourceAgentId: "A1", summary: "done" }),
];

export interface Harness {
  session: AgentSession;
  runtime: ModelRuntime;
  cwd: string;
  agentDir: string;
  main: Awaited<ReturnType<typeof fauxRuntime>>;
  orche: Awaited<ReturnType<typeof fauxRuntime>>;
  /** `ctx.ui.notify` calls made by the extension. */
  notifications: { message: string; type?: string }[];
  /** `ctx.ui.setStatus` / `ctx.ui.setWidget` calls made by the extension (newest last; `undefined` clears). */
  statuses: { key: string; text?: string }[];
  widgets: { key: string; lines?: readonly string[] }[];
  dispose(): Promise<void>;
}
/**
 * A real interactive-style AgentSession (faux main model) with the pi-orche extension loaded through
 * DefaultResourceLoader, exactly as `pi` loads it. Orchestration runs use a second faux provider that
 * `<agentDir>/orche.config.json` routes to.
 */
export async function createHarness(options: {
  mainSteps: FauxResponseStep[];
  orcheSteps: FauxResponseStep[];
  extension?: OrcheExtensionOptions;
  writeUserConfig?: boolean;
  /** `mainMode` in the user config (default auto delegates; unset omits the key). */
  /** Resolve the main provider in the worker runtime; default tests keep separate scripts/routes. */
  inheritMainModel?: boolean;
  mainMode?: "auto" | "single" | "multi" | "direct" | "unset";
  /**
   * `records` in the user config. The default is OFF here (`{ enabled: false }`), unlike the extension's own default (on): suites that do not
   * look at records keep their exact result texts and write nothing. Pass `true` for the defaults, or a `records` object (`dir`, `retentionDays`,
   * `maxBytes`) to switch records on; they then live under `<agentDir>/orche/records` of the harness, which `dispose` removes.
   */
  records?: boolean | { enabled?: boolean; dir?: string; retentionDays?: number; maxBytes?: number };
  taskContext?: { clearBetweenAssignments?: boolean; minClearTokens?: number };
  /** `ctx.mode` the extension sees (default: the SDK default, i.e. not "tui"). */
  mode?: "tui" | "rpc" | "print" | "json";
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "orche-ext-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, "greeting.txt"), "hello world\n");
  const main = await fauxRuntime(options.mainSteps);
  const orche = await fauxRuntime(options.orcheSteps);
  main.runtime.registerNativeProvider(orche.faux.provider);
  if (options.writeUserConfig !== false) {
    const records = options.records === true ? {} : options.records === undefined || options.records === false ? { enabled: false } : options.records;
    await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: orche.route.model }, records, ...(options.taskContext ? { taskContext: options.taskContext } : {}), ...(options.mainMode === "unset" ? {} : { mainMode: options.mainMode ?? "auto" }) }));
  }
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createOrcheExtension({ agentDir, createRuntime: async () => options.inheritMainModel || options.writeUserConfig === false ? main.runtime : orche.runtime, ...options.extension })],
  });
  await resourceLoader.reload();
  const model = main.runtime.getModel(main.faux.provider.id, main.faux.getModel().id)!;
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: main.runtime, model, thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
  });
  const notifications: Harness["notifications"] = [];
  const statuses: Harness["statuses"] = [];
  const widgets: Harness["widgets"] = [];
  // Only the UI methods the extension uses; notify, setStatus and setWidget are recorded.
  const uiContext = {
    notify: (message: string, type?: string) => { notifications.push({ message, type }); },
    setStatus: (key: string, text?: string) => { statuses.push({ key, ...(text === undefined ? {} : { text }) }); },
    setWidget: (key: string, lines?: readonly string[]) => { widgets.push({ key, ...(lines === undefined ? {} : { lines }) }); },
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ uiContext, ...(options.mode ? { mode: options.mode } : {}) });
  return {
    session, runtime: main.runtime, cwd, agentDir, main, orche, notifications, statuses, widgets,
    async dispose() {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
