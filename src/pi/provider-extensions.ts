import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession, DefaultPackageManager, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
  type AgentSession, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

export class ProviderExtensionError extends Error {
  override readonly name = "ProviderExtensionError";
}
export interface ProviderExtensionHost {
  readonly sources: readonly string[];
  /** Stops the extensions. Providers stay registered in the runtime, but their dispatch is gone: call only when the runtime is no longer used for requests. */
  dispose(): void;
}

/** The package that would load this very extension again. */
const SELF_PACKAGE = "pi-orche";

/**
 * Make providers that Pi extensions register (for example a gateway package) usable by orche's own
 * `ModelRuntime`, through Pi's public resource-loading and session APIs only.
 *
 * Each source is a Pi package source that is installed at user scope (`pi install <source>`); only
 * those packages' extensions are loaded (`noExtensions` + explicit paths, like `pi --no-extensions -e`),
 * never the user's full extension set. A hidden, tool-less in-memory session binds them to `runtime`, which
 * flushes their `registerProvider` calls into it. The session makes no model call.
 */
export async function loadProviderExtensions(
  runtime: ModelRuntime,
  sources: readonly string[],
  options: { cwd: string; agentDir?: string; signal?: AbortSignal },
): Promise<ProviderExtensionHost> {
  options.signal?.throwIfAborted();
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.inMemory({});
  const packages = new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager });
  const paths: string[] = [];
  for (const source of sources) {
    const installed = packages.getInstalledPath(source, "user");
    if (!installed) {
      throw new ProviderExtensionError(`Provider extension ${source} is not installed at user scope. Install it with: pi install ${source}`);
    }
    if (await packageName(installed) === SELF_PACKAGE) {
      throw new ProviderExtensionError(`Provider extension ${source} is pi-orche itself; loading it into an orche run would recurse.`);
    }
    paths.push(installed);
  }
  const loader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: paths,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  options.signal?.throwIfAborted();
  const { extensions, errors } = loader.getExtensions();
  if (errors.length) {
    throw new ProviderExtensionError(`Provider extensions failed to load: ${errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
  }
  if (!extensions.length) {
    throw new ProviderExtensionError(`Provider extension sources ${sources.join(", ")} contain no extensions.`);
  }
  options.signal?.throwIfAborted();
  const { session }: { session: AgentSession } = await createAgentSession({
    cwd: options.cwd, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.inMemory(options.cwd), tools: [],
  });
  if (options.signal?.aborted) { session.dispose(); options.signal.throwIfAborted(); }
  return { sources, dispose: () => session.dispose() };
}

async function packageName(directory: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return manifest && typeof manifest === "object" && "name" in manifest && typeof manifest.name === "string" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}
