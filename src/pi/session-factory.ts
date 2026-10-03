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
import type { AstRewriteFileGuard } from "../tools/ast.js";
import { createSpillExtension } from "../tools/spill.js";
import { withExtendedContext, type ContextWindowInfo } from "./extended-context.js";
import { dirname, resolve } from "node:path";
import { ensurePrivateDir, ensurePrivateFile } from "../agent/private-files.js";
import type { createAssignmentProjector } from "./context-projection.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
export interface SessionOptions {
  route: { role: string; model: string; thinking?: ThinkingLevel; extendedContext?: boolean };
  cwd: string;
  tools?: string[];
  customTools?: ToolDefinition[];
  instructions: string;
  /** Replaces Pi's default base system prompt; role `instructions` are still appended. */
  baseSystemPrompt?: string;
  /**
   * Persist the session as a regular pi session JSONL inside this directory (file name chosen by the SDK:
   * `<timestamp>_<session id>.jsonl`). Created `0700` when missing, the file `0600`. Without `sessionDir` and
   * `sessionFile` the session lives in memory only (the default).
   */
  sessionDir?: string;
  /**
   * Persist the session into exactly this file, which wins over `sessionDir`. A missing file is created (`0600`, parent
   * directories `0700`) and gets its session header immediately; an existing session file is continued: its entries are
   * loaded and new ones appended, so a worker that lives across assignments (or is re-created) can keep one stable file.
   * The path of a persisted session is `session.sessionFile`.
   */
  sessionFile?: string;
  modelRuntime?: ModelRuntime;
  /** Called once with the effective context window of the session's model. */
  onContextWindow?: (info: ContextWindowInfo) => void;
  /**
   * Called before every tool call with the tool name and its (validated) input. A returned
   * string blocks the call: the tool does not run and the model receives the string as the
   * error result.
   */
  toolGuard?: ToolGuard;
  /**
   * PURE per-file ownership check for directory ast_rewrite writes (workspace-relative POSIX paths).
   * Unlike toolGuard, this must have no activity gating or event side effects. A reason blocks only
   * that file; undefined allows it. Not called for single-file rewrites or dry runs.
   * Guarded sessions without this check refuse directory writes, but still allow dry runs.
   */
  writeFileGuard?: AstRewriteFileGuard;
  /**
   * Every session gets Pi's `bash` with a heartbeat (see `src/tools/bash.ts`): while a command runs, a sample is sent as
   * a tool partial update every `intervalMs` (default 15 s). Sessions without `bash` in `tools` are unaffected.
   */
  bashHeartbeat?: { intervalMs?: number };
  /** Opt-in request-only projection; the owner records each assignment boundary before prompting. */
  contextProjection?: ReturnType<typeof createAssignmentProjector>;
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
/** Never persisted: raw results remain in the agent state and session JSONL. */
function createContextProjectionExtension(projector: NonNullable<SessionOptions["contextProjection"]>): Extension {
  const path = "<orche:task-context>";
  return {
    path, resolvedPath: path, hidden: true,
    sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([["context", [((event: { messages: AgentMessage[] }) => ({ messages: projector.project(event.messages) })) as never]]]),
    tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(),
    commands: new Map(), flags: new Map(), shortcuts: new Map(),
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
      extensions: [createSpillExtension(options.cwd), ...(options.toolGuard ? [createGuardExtension(options.toolGuard)] : []), ...(options.contextProjection ? [createContextProjectionExtension(options.contextProjection)] : [])],
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
  const sessionManager = sessionManagerFor(options);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: options.route.thinking ?? "off",
    tools: options.tools,
    customTools: [...createOrcheTools({ cwd: options.cwd, bashHeartbeat: { ...options.bashHeartbeat }, astRewriteFileGuard: options.writeFileGuard ?? (options.toolGuard ? () => "Blocked: directory ast_rewrite requires a per-file write guard in guarded sessions" : undefined) }), ...(options.customTools ?? [])],
    resourceLoader: loader,
    sessionManager,
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
  });
  if (sessionManager.isPersisted()) markDisposal(session, sessionManager);
  return session;
}

/**
 * In-memory unless a target is given. A persisted session is opened on a file that already exists (created empty `0600`
 * here), so its header is written at once and every later entry is appended synchronously: a session that is short, fails
 * or is cancelled before its first reply still leaves a valid JSONL, and the SDK's own lazy flush (the file would only appear
 * with the first user/assistant message, created with the process umask) never applies. Recording is best effort: when the
 * target cannot be prepared (read-only disk, a non-session file at `sessionFile`) the session runs in memory instead of
 * failing the caller's run; the missing `session.sessionFile` shows it.
 */
function sessionManagerFor(options: SessionOptions): SessionManager {
  const file = options.sessionFile ? resolve(options.sessionFile) : undefined;
  if (!file && !options.sessionDir) return SessionManager.inMemory(options.cwd);
  try {
    const dir = file ? dirname(file) : resolve(options.sessionDir!);
    ensurePrivateDir(dir);
    const target = file ?? SessionManager.create(options.cwd, dir).getSessionFile()!;
    ensurePrivateFile(target);
    return SessionManager.open(target, dir, options.cwd);
  } catch {
    return SessionManager.inMemory(options.cwd);
  }
}

/**
 * `dispose()` detaches the session from its agent at once, so the reply that an abort cuts short is never written. When a
 * persisted session is disposed mid-stream, leave a marker entry (not part of the model context) with what had streamed so
 * far, so the transcript shows where the work stopped.
 */
function markDisposal(session: AgentSession, manager: SessionManager): void {
  const dispose = session.dispose.bind(session);
  let marked = false;
  session.dispose = () => {
    if (!marked) {
      marked = true;
      try {
        if (session.agent.state.isStreaming) manager.appendCustomEntry("orche:disposed", { whileStreaming: true, partial: partialOf(session.agent.state.streamingMessage) });
      } catch { /* the marker is a courtesy */ }
    }
    dispose();
  };
}

function partialOf(message: unknown): unknown {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  return content.map(part => {
    const item = part as { type?: string; text?: string; name?: string };
    return item.type === "text" ? { type: "text", text: (item.text ?? "").slice(0, 2000) } : { type: item.type, ...(item.name ? { name: item.name } : {}) };
  }).slice(0, 20);
}
