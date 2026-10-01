import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
let sharedRuntime: Promise<ModelRuntime> | undefined;
export function runtime(): Promise<ModelRuntime> {
  return sharedRuntime ??= ModelRuntime.create();
}
export async function raw(
  rt: ModelRuntime,
  route: string,
  tools: string[] = [],
  customTools: ToolDefinition[] = [],
  cwd = process.cwd(),
) {
  const slash = route.indexOf("/");
  const model = rt.getModel(route.slice(0, slash), route.slice(slash + 1));
  if (!model) throw new Error(`Unknown model ${route}`);
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      "Be concise. Follow explicit tool instructions exactly.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return (
    await createAgentSession({
      cwd,
      modelRuntime: rt,
      model,
      thinkingLevel: "off",
      tools,
      customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0 },
      }),
    })
  ).session;
}
export async function save(name: string, data: unknown) {
  await mkdir("results/experiments", { recursive: true });
  await writeFile(
    `results/experiments/${name}.json`,
    JSON.stringify(data, null, 2),
  );
}
export async function bounded(
  session: AgentSession,
  prompt: string,
  ms = 60000,
) {
  const timer = setTimeout(() => void session.abort(), ms);
  try {
    await session.prompt(prompt);
  } finally {
    clearTimeout(timer);
  }
}
export function text(session: AgentSession) {
  const m = session.messages.filter((x) => x.role === "assistant").at(-1);
  return (
    m?.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("") ?? ""
  );
}
