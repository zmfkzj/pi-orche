import {
  createSyntheticSourceInfo,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type Extension,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createOrcheTools } from "../tools/index.js";
import { createSpillExtension } from "../tools/spill.js";
import { withExtendedContext, type ContextWindowInfo } from "./extended-context.js";
export interface SessionOptions {
  route: { role: string; model: string; thinking?: ThinkingLevel; extendedContext?: boolean };
  cwd: string;
  tools?: string[];
  customTools?: ToolDefinition[];
  instructions: string;
  /** Replaces Pi's default base system prompt; role `instructions` are still appended. */
  baseSystemPrompt?: string;
  sessionDir?: string;
  modelRuntime?: ModelRuntime;
  /** Called once with the effective context window of the session's model. */
  onContextWindow?: (info: ContextWindowInfo) => void;
  /**
   * Called before every tool call with the tool name and its (validated) input. A returned
   * string blocks the call: the tool does not run and the model receives the string as the
   * error result.
   */
  toolGuard?: ToolGuard;
}
export type ToolGuard = (toolName: string, input: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
/** Session extension applying a {@link ToolGuard} through Pi's public, blocking `tool_call` hook. */
function createGuardExtension(guard: ToolGuard): Extension {
  const path = "<orche:guard>";
  const handler = async (event: { toolName: string; input: Record<string, unknown> }) => {
    const reason = await guard(event.toolName, event.input);
    return reason === undefined ? undefined : { block: true, reason };
  };
  return {
    path,
    resolvedPath: path,
    hidden: true,
    sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([["tool_call", [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}
let defaultRuntime: Promise<ModelRuntime> | undefined;
export async function createSession(
  options: SessionOptions,
): Promise<AgentSession> {
  const runtime = options.modelRuntime ?? await (defaultRuntime ??= ModelRuntime.create());
  const slash = options.route.model.indexOf("/");
  const catalogModel = runtime.getModel(
    options.route.model.slice(0, slash),
    options.route.model.slice(slash + 1),
  );
  if (!catalogModel) throw new Error(`Unknown model: ${options.route.model}`);
  const { model, info } = withExtendedContext(catalogModel, options.route.extendedContext);
  options.onContextWindow?.(info);
  const loader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [createSpillExtension(options.cwd), ...(options.toolGuard ? [createGuardExtension(options.toolGuard)] : [])],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.baseSystemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [options.instructions],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return (
    await createAgentSession({
      cwd: options.cwd,
      modelRuntime: runtime,
      model,
      thinkingLevel: options.route.thinking ?? "off",
      tools: options.tools,
      customTools: [...createOrcheTools({ cwd: options.cwd }), ...(options.customTools ?? [])],
      resourceLoader: loader,
      sessionManager: options.sessionDir
        ? SessionManager.create(options.cwd, options.sessionDir)
        : SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 250,
          maxAgentDelayMs: 1000,
          provider: { maxRetries: 0, maxRetryDelayMs: 1000 },
        },
      }),
    })
  ).session;
}
