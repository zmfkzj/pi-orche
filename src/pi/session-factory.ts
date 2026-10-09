import {
  createSyntheticSourceInfo,
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  estimateTokens,
  DEFAULT_COMPACTION_SETTINGS,
  type SessionCompactEvent,
  type Extension,
  type ExtensionFactory,
  type LoadExtensionsResult,
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
import { projectImageContext } from "./image-context.js";
import { lengthRecoveryHandlers, type LengthRecoveryOptions } from "./length-recovery.js";
import { outputCapHandler } from "./output-cap.js";
import { thinkingPolicyOf } from "./thinking-policy.js";
import { atEffectiveBaseline, thinkingStateOf } from "./thinking-state.js";
import { BOOKKEEPING_TOOLS, evidenceLedgerOf, recordToolCall, refText } from "./tool-evidence.js";
import { unknownToolHandler } from "./unknown-tool.js";
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
  /** Opt-in only for single-workflow task workers. Essentials are restored verbatim after every successful compaction. */
  taskCompaction?: { essentials: () => string; onCompact?: (stats: CompactionStats) => void };
  /** Effective main window, including extended context, when inheriting its model. */
  inheritedContextWindow?: number;
  /**
   * Pi extension factories of opt-in worker capabilities (see WorkerCapabilityProvider in src/extension/workers.ts), loaded
   * into this session only. The session is then bound (`session_start`, e.g. MCP servers connect) and its `dispose()`
   * emits `session_shutdown` first, as Pi's own runtime does on quit, so the extensions release what they started.
   * Their tools still need to be listed in `tools`.
   */
  extensionFactories?: readonly ExtensionFactory[];
  /**
   * Output-limit recovery (src/pi/length-recovery.ts): a thinking-only or cut-off response is no longer "recovered" by compacting a
   * context that is far from full; the worker gets a bounded next-step continuation instead. On by default (`mode: "nudge"`);
   * `{ mode: "off" }` keeps Pi's own behaviour (the state is still tracked).
   */
  lengthRecovery?: LengthRecoveryOptions;
}
export type ToolGuard = (toolName: string, input: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
export interface CompactionStats { tokensBefore: number; tokensAfter: number }
export function taskCompactionSettings(contextWindow: number) {
  const reserveTokens = Math.floor(contextWindow * 0.5);
  return { enabled: true, reserveTokens, keepRecentTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, contextWindow - reserveTokens) };
}

export const COMPACTION_ASSIGNMENT_LABEL = "Assignment in progress at compaction time (superseded by any later Assignment message)";

function createCompactionExtension(options: SessionOptions, getSession: () => AgentSession): Extension {
  const path = "<orche:task-compaction>";
  const handler = (event: SessionCompactEvent) => {
    // Successful compaction has already rebuilt the canonical transcript. Never use old indices again.
    options.contextProjection?.reset();
    const session = getSession();
    const essentials = options.taskCompaction?.essentials();
    if (essentials) {
      // The compact hook is a finalized boundary (also between turns), so append synchronously:
      // sendCustomMessage would queue while streaming and could miss the very next request.
      session.sessionManager.appendCustomMessageEntry("orche:task-essentials", `${COMPACTION_ASSIGNMENT_LABEL}:\n${essentials}`, false);
      session.refreshContext();
    }
    options.taskCompaction?.onCompact?.({ tokensBefore: event.compactionEntry.tokensBefore, tokensAfter: session.messages.reduce((sum, message) => sum + estimateTokens(message), 0) });
  };
  return { path, resolvedPath: path, hidden: true, sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([["session_compact", [handler as never]]]), tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
}
/**
 * Worker-session hygiene that every orche session gets: output-limit recovery (length-recovery.ts), a suggestion on Pi's bare
 * `Tool X not found` result (unknown-tool.ts), the explicit output budget of Claude requests through CLIProxyAPI (output-cap.ts), and
 * the tool-call ledger behind checkpoint evidence (tool-evidence.ts: a `[orche ref Tn]` line on tool results when the assignment's
 * thinking policy links evidence). None of them re-routes a tool call.
 */
function createWorkerHygieneExtension(options: SessionOptions, getSession: () => AgentSession | undefined): Extension {
  const path = "<orche:worker-hygiene>";
  const length = lengthRecoveryHandlers(getSession, options.lengthRecovery);
  const unknownTool = unknownToolHandler(() => getSession()?.getActiveToolNames() ?? []);
  const outputCap = outputCapHandler(getSession);
  const messageEnd = (event: { message: AgentMessage }) => {
    length.message_end(event as never);
    return unknownTool(event as never);
  };
  const toolResult = (event: { toolCallId: string; toolName: string; input?: Record<string, unknown>; isError: boolean; content: unknown[]; structuredContent?: unknown }) => {
    const session = getSession();
    if (!session) return undefined;
    const thinking = thinkingStateOf(session);
    const running = thinkingPolicyOf(session)?.plan?.nodes.find(node => node.status === "running")?.id;
    const record = recordToolCall(session, event, { request: thinking.requestSeq, ...(thinking.requestLevel ? { level: thinking.requestLevel } : {}), atBaseline: atEffectiveBaseline(thinking, thinking.requestLevel), ...(running ? { node: running } : {}) });
    if (!evidenceLedgerOf(session).tag || BOOKKEEPING_TOOLS.has(event.toolName)) return undefined;
    return { content: [...event.content, { type: "text" as const, text: refText(record) }], ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) };
  };
  return {
    path, resolvedPath: path, hidden: true,
    sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([
      ["message_end", [messageEnd as never]],
      ["session_before_compact", [length.session_before_compact as never]],
      ["agent_before_settle", [length.agent_before_settle as never]],
      ["before_provider_request", [outputCap as never]],
      ["tool_result", [toolResult as never]],
    ]),
    tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(),
    commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
}
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
/** Never persisted: assignment clears and rolling image limits leave raw agent/session history intact. */
function createContextProjectionExtension(getProjector: () => SessionOptions["contextProjection"]): Extension {
  const path = "<orche:task-context>";
  return {
    path, resolvedPath: path, hidden: true,
    sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([["context", [((event: { messages: AgentMessage[] }) => ({ messages: projectImageContext(getProjector()?.project(event.messages) ?? event.messages) })) as never]]]),
    tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(),
    commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
}

const taskSessions = new WeakMap<AgentSession, { options: SessionOptions; tools: Extension["tools"] }>();
/** Upgrade a handed-over run worker at its first single-workflow task boundary without losing history. */
export async function enableTaskWorkflow(session: AgentSession, taskCompaction: NonNullable<SessionOptions["taskCompaction"]>, planTool: ToolDefinition, projector: NonNullable<SessionOptions["contextProjection"]>): Promise<void> {
  const state = taskSessions.get(session);
  if (!state) throw new Error("Session cannot enable the single workflow; omit worker to start a new worker.");
  state.options.taskCompaction = taskCompaction;
  state.options.contextProjection = projector;
  state.tools.set(planTool.name, { definition: planTool, sourceInfo: createSyntheticSourceInfo("<orche:task-workflow>", { source: "orche" }) });
  await session.reload();
  session.setActiveToolsByName([...session.getActiveToolNames(), planTool.name]);
  if (session.model) session.settingsManager.applyOverrides({ compaction: taskCompactionSettings(session.model.contextWindow) });
}

/** Toggle a previously installed workflow at role/mode boundaries; specialists retain ordinary behaviour. */
export function configureTaskWorkflow(session: AgentSession, taskCompaction: SessionOptions["taskCompaction"]): void {
  const state = taskSessions.get(session);
  if (!state) throw new Error("Session cannot configure the single workflow; omit worker to start a new worker.");
  state.options.taskCompaction = taskCompaction;
  const names = session.getActiveToolNames().filter(name => name !== "task_plan");
  session.setActiveToolsByName(taskCompaction ? [...names, "task_plan"] : names);
  session.settingsManager.applyOverrides({ compaction: taskCompaction && session.model ? taskCompactionSettings(session.model.contextWindow) : { enabled: false } });
}

/**
 * Load capability extension factories the way Pi's SDK loads inline extensions, with nothing else: no settings packages
 * (in-memory settings), no user/project extensions, skills, prompts, themes or context files. A factory that throws fails
 * the session creation with its message.
 */
async function loadFactoryExtensions(cwd: string, factories: readonly ExtensionFactory[]): Promise<LoadExtensionsResult> {
  const loader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [...factories],
  });
  await loader.reload();
  const result = loader.getExtensions();
  if (result.errors.length) throw new Error(`Worker capability extensions failed to load: ${result.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
  return result;
}

/**
 * Start the capability extensions (`session_start`) and make `dispose()` emit `session_shutdown` first, like Pi's runtime
 * host on quit. Disposal stays synchronous: handlers start at once (Pi's MCP extension begins closing its servers, whose
 * transports finish with their own SIGTERM/SIGKILL timers) and are not awaited.
 */
async function bindFactoryExtensions(session: AgentSession): Promise<void> {
  await session.bindExtensions({});
  const dispose = session.dispose.bind(session);
  let shutdown = false;
  session.dispose = () => {
    if (!shutdown) {
      shutdown = true;
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
    }
    dispose();
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
  const resolved = withExtendedContext(catalogModel, options.route.extendedContext);
  const model = options.inheritedContextWindow && options.inheritedContextWindow > resolved.model.contextWindow
    ? { ...resolved.model, contextWindow: options.inheritedContextWindow } : resolved.model;
  const info = { ...resolved.info, contextWindow: model.contextWindow, extended: model.contextWindow > catalogModel.contextWindow };
  let createdSession: AgentSession | undefined;
  const compactionExtension = createCompactionExtension(options, () => createdSession!);
  const hygieneExtension = createWorkerHygieneExtension(options, () => createdSession);
  options.onContextWindow?.(info);
  // Capability extensions (e.g. pi-gui's MCP server for a GUI worker) load once, with their own extension runtime, which
  // the session then uses: their `pi.*` calls (tools, MCP registrations) must reach the runner of this session.
  const factoryExtensions = options.extensionFactories?.length ? await loadFactoryExtensions(options.cwd, options.extensionFactories) : undefined;
  const loader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [createSpillExtension(options.cwd), ...(options.toolGuard ? [createGuardExtension(options.toolGuard)] : []), createContextProjectionExtension(() => options.contextProjection), compactionExtension, hygieneExtension, ...(factoryExtensions?.extensions ?? [])],
      errors: [],
      runtime: factoryExtensions?.runtime ?? createExtensionRuntime(),
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
    // Allow a later hand-over upgrade, but do not register task_plan for run workers.
    tools: options.tools ? [...new Set([...options.tools, "task_plan"])] : undefined,
    customTools: [...createOrcheTools({ cwd: options.cwd, bashHeartbeat: { ...options.bashHeartbeat }, astRewriteFileGuard: options.writeFileGuard ?? (options.toolGuard ? () => "Blocked: directory ast_rewrite requires a per-file write guard in guarded sessions" : undefined) }), ...(options.customTools ?? [])],
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: options.taskCompaction ? taskCompactionSettings(model.contextWindow) : { enabled: false },
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 250,
        maxAgentDelayMs: 1000,
        provider: { maxRetries: 0, maxRetryDelayMs: 1000 },
      },
    }),
  });
  createdSession = session;
  taskSessions.set(session, { options, tools: compactionExtension.tools });
  if (factoryExtensions) await bindFactoryExtensions(session);
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
