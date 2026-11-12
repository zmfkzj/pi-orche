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
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionCompactFailedEvent,
  type Extension,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ResourceLoader,
  type ToolDefinition,
  type Skill,
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
import { outputCapHandler, withSummaryOutputCap } from "./output-cap.js";
import { summaryBudgetUse, takeSummaryRequests, type SummaryBudgetUse, type SummaryRequests } from "./summary-budget.js";
import { markCompaction, recordToolResult } from "./read-telemetry.js";
import { readNodeRefusal } from "./read-node-guard.js";
import { thinkingPolicyOf } from "./thinking-policy.js";
import { atEffectiveBaseline, thinkingStateOf } from "./thinking-state.js";
import { BOOKKEEPING_TOOLS, evidenceLedgerOf, recordToolCall, refText } from "./tool-evidence.js";
import { unknownToolHandler } from "./unknown-tool.js";
import { WORKER_SKILLS_NOTE, workerSkills } from "./worker-skills.js";
import { MAX_EARLY_COMPACTIONS, piCompactionSettings, stableCompaction, type ResolvedCompaction } from "./compaction-policy.js";
import { checkReference, type EssentialsResult, type ReferenceStatus } from "./compaction-state.js";
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
  /**
   * Opt-in for single-workflow task workers (and, with `workerCompaction.subWorkers`, orche_spawn sub-workers). Essentials are
   * restored verbatim after every successful compaction; see {@link TaskCompaction}.
   */
  taskCompaction?: TaskCompaction;
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
  /**
   * Skills the session lists in its prompt (`available_skills`): main's discovered skills, as metadata only (name, description,
   * absolute SKILL.md path; see worker-skills.ts). Copied at creation: a living session keeps this list. Without it, none.
   */
  skills?: readonly Skill[];
}
/** `toolCallId`: the call's id, for owners that pair the guard with the call's end (the ultra integrity probes in src/orchestrator/ultra.ts). */
export type ToolGuard = (toolName: string, input: Record<string, unknown>, toolCallId?: string) => string | undefined | Promise<string | undefined>;
/** One successful compaction: Pi's estimate before/after (`tokensAfter` includes the restored essentials) and what orche knows about it. */
export interface CompactionStats {
  tokensBefore: number;
  tokensAfter: number;
  reason?: "manual" | "threshold" | "overflow";
  policy?: ResolvedCompaction["policy"];
  triggerTokens?: number;
  /** The configured `workerCompaction` usage ratio in effect (absent: the stable 50%). */
  usageRatio?: number;
  early?: boolean;
  essentialsChars?: number;
  essentialsSections?: string[];
  essentialsMissing?: string[];
  /** `valid` | `unavailable` | `invalid`: the transcript reference checked before the compaction (extended essentials only). */
  reference?: ReferenceStatus["status"];
  /** Usage of the summary request(s) as the provider reported it (Pi stores it on the compaction entry). */
  summaryUsage?: { input: number; output: number };
  /** The essentials callback failed after the compaction; the text checked before it was restored instead (or none). */
  essentialsError?: string;
  /** Wall-clock time of the whole compaction: from Pi's session_before_compact to session_compact (preflight, every summary request
   *  and the essentials). The summary requests' own time is `summaryRequests.ms`, part of it: never add the two. */
  durationMs?: number;
  /** Characters of the summary Pi stored (the essentials restored after it are `essentialsChars`). */
  summaryChars?: number;
  /** The summary budget the (last) summary request asked for, its profile and level (summary-budget.ts). */
  summaryBudget?: SummaryBudgetUse;
  /** The summary requests of this compaction: count, immediate re-sends after an output-limit stop, their summed time and output tokens. */
  summaryRequests?: SummaryRequests;
}
/** A compaction that did not happen: refused by orche's preflight (`cause`), cancelled by another handler or aborted, or failed. */
export type CompactionEvent =
  | { type: "compaction_cancelled"; reason: string; cause: "reference_invalid" | "essentials_invalid" | "loop_guard" | "early_limit" | "aborted"; fallback?: "stable" | "ratio"; tokensBefore?: number; triggerTokens?: number; detail?: string }
  | { type: "compaction_failed"; reason: string; errorMessage?: string; willRetry: boolean; durationMs?: number; summaryBudget?: SummaryBudgetUse; summaryRequests?: SummaryRequests };
export interface EssentialsContext {
  session: AgentSession;
  /** The transcript reference checked before this compaction (only with `retrieval`). */
  reference?: ReferenceStatus;
  reason?: string;
}
export interface TaskCompaction {
  essentials: (context: EssentialsContext) => string | EssentialsResult;
  onCompact?: (stats: CompactionStats) => void;
  /** Refusals, cancellations and failures (telemetry). */
  onEvent?: (event: CompactionEvent) => void;
  /** The session's compaction policy for its model (default: the stable 50% policy; src/pi/compaction-policy.ts). */
  policy?: (model: { contextWindow: number; provider: string; id: string }) => ResolvedCompaction;
  /** The essentials point to the original transcript: check it before context is discarded (extended essentials). */
  retrieval?: boolean;
}
/** The stable settings (kept for callers and tests): compact above 50% of the window. */
export function taskCompactionSettings(contextWindow: number) {
  return piCompactionSettings(stableCompaction(contextWindow));
}

export const COMPACTION_ASSIGNMENT_LABEL = "Assignment in progress at compaction time (superseded by any later Assignment message)";

/** Per-session compaction state of orche's hooks: the policy in force, the preflight of the compaction in progress, the guard. */
interface CompactionState {
  resolved?: ResolvedCompaction;
  /** Set when an early compaction was refused: the stable policy applies until the next assignment boundary. */
  fallback?: string;
  early: number;
  last?: { tokensAfter: number };
  preflight?: { reference?: ReferenceStatus; preview?: EssentialsResult; essentialsError?: string };
  /** orche's own cancellation, so the failure event Pi emits for it is not counted twice. */
  cancelling?: boolean;
  /** The last entry before the current assignment (its entries follow it). */
  startEntry?: string;
  /** When Pi's compaction in progress started (session_before_compact), for its duration. */
  startedAt?: number;
}
const compactionStates = new WeakMap<AgentSession, CompactionState>();
const compactionStateOf = (session: AgentSession): CompactionState => {
  let state = compactionStates.get(session);
  if (!state) compactionStates.set(session, state = { early: 0 });
  return state;
};
const normalizeEssentials = (value: string | EssentialsResult | undefined): EssentialsResult | undefined =>
  value === undefined ? undefined : typeof value === "string" ? { text: value, sections: value.trim() ? ["essentials"] : [], missing: [] } : value;

/** Resolve and apply the compaction settings of a task session; starts a new guard epoch (an assignment boundary). */
export function applyTaskCompaction(session: AgentSession, taskCompaction: TaskCompaction | undefined): ResolvedCompaction | undefined {
  const state = compactionStateOf(session);
  state.fallback = undefined;
  state.early = 0;
  state.last = undefined;
  state.preflight = undefined;
  state.startEntry = session.sessionManager.getLeafId() ?? undefined;
  if (!taskCompaction || !session.model) {
    state.resolved = undefined;
    session.settingsManager.applyOverrides({ compaction: { enabled: false } });
    return undefined;
  }
  state.resolved = resolvedFor(taskCompaction, session.model);
  session.settingsManager.applyOverrides({ compaction: piCompactionSettings(state.resolved) });
  return state.resolved;
}
const resolvedFor = (taskCompaction: TaskCompaction, model: { contextWindow: number; provider: string; id: string }): ResolvedCompaction =>
  taskCompaction.policy?.(model) ?? stableCompaction(model.contextWindow);

function createCompactionExtension(options: SessionOptions, getSession: () => AgentSession): Extension {
  const path = "<orche:task-compaction>";
  /**
   * Preflight, before Pi discards anything: check the transcript reference (retrieval) and build the essentials once. An EARLY
   * compaction (absolute policy below the stable trigger) is refused when its reference is not valid, its essentials cannot be
   * built or miss a required section, the previous compaction left too little room (loop guard), or the assignment's early
   * compactions are used up; the session then falls back to the stable policy for the rest of the assignment. A stable threshold,
   * overflow or manual compaction is never refused here (the context must shrink); its essentials say whether the reference holds.
   */
  const before = (event: SessionBeforeCompactEvent) => {
    const taskCompaction = options.taskCompaction;
    if (!taskCompaction) return undefined;
    const session = getSession();
    const state = compactionStateOf(session);
    state.startedAt = Date.now();
    takeSummaryRequests(session); // this compaction's summary requests are counted from here
    const entries = event.branchEntries;
    const kept = entries.findIndex(entry => entry.id === event.preparation.firstKeptEntryId);
    const discarded = (kept > 0 ? entries[kept - 1] : entries.at(-1))?.id;
    const reference = taskCompaction.retrieval ? checkReference({ persisted: session.sessionManager.isPersisted(), ...(session.sessionFile ? { file: session.sessionFile } : {}), ...(discarded ? { discardedEntryId: discarded } : {}), ...(state.startEntry ? { startEntry: state.startEntry } : {}) }) : undefined;
    let preview: EssentialsResult | undefined, essentialsError: string | undefined;
    try { preview = normalizeEssentials(taskCompaction.essentials({ session, ...(reference ? { reference } : {}), reason: event.reason })); } catch (error) { essentialsError = error instanceof Error ? error.message : String(error); }
    state.preflight = { ...(reference ? { reference } : {}), ...(preview ? { preview } : {}), ...(essentialsError ? { essentialsError } : {}) };
    const resolved = state.resolved;
    if (!resolved?.early || state.fallback || event.reason !== "threshold") return undefined;
    const margin = Math.max(2048, Math.floor(resolved.triggerTokens * 0.15));
    const tokensBefore = event.preparation.tokensBefore;
    const cause = reference && reference.status !== "valid" ? "reference_invalid" as const
      : !preview || preview.missing.length || essentialsError ? "essentials_invalid" as const
      : state.last && (tokensBefore - state.last.tokensAfter < margin || state.last.tokensAfter > resolved.triggerTokens - margin) ? "loop_guard" as const
      : state.early >= MAX_EARLY_COMPACTIONS ? "early_limit" as const
      : undefined;
    if (!cause) { state.early++; return undefined; }
    state.fallback = cause;
    state.cancelling = true;
    state.startedAt = undefined;
    state.preflight = undefined;
    // Back to the non-early policy: the configured usage ratio when it is not early itself (compaction-policy.ts), else the stable 50%.
    if (session.model) session.settingsManager.applyOverrides({ compaction: piCompactionSettings(resolved.fallback ?? stableCompaction(session.model.contextWindow)) });
    const detail = cause === "reference_invalid" && reference && reference.status !== "valid" ? reference.reason : cause === "essentials_invalid" ? essentialsError ?? `missing: ${preview?.missing.join(", ") ?? "essentials"}` : cause === "loop_guard" ? `previous compaction left ${state.last?.tokensAfter} tokens; trigger ${resolved.triggerTokens}` : undefined;
    try { taskCompaction.onEvent?.({ type: "compaction_cancelled", reason: event.reason, cause, fallback: resolved.fallback ? "ratio" : "stable", tokensBefore, triggerTokens: resolved.triggerTokens, ...(detail ? { detail } : {}) }); } catch { /* telemetry cannot change the decision */ }
    return { cancel: true };
  };
  const handler = (event: SessionCompactEvent) => {
    // Successful compaction has already rebuilt the canonical transcript. Never use old indices again.
    options.contextProjection?.reset();
    const session = getSession();
    const taskCompaction = options.taskCompaction;
    const state = compactionStateOf(session);
    const pre = state.preflight;
    state.preflight = undefined;
    let result: EssentialsResult | undefined, essentialsError: string | undefined;
    try { result = normalizeEssentials(taskCompaction?.essentials({ session, ...(pre?.reference ? { reference: pre.reference } : {}), reason: event.reason })); }
    catch (error) { essentialsError = error instanceof Error ? error.message : String(error); result = pre?.preview; }
    if (result?.text) {
      // The compact hook is a finalized boundary (also between turns), so append synchronously:
      // sendCustomMessage would queue while streaming and could miss the very next request.
      session.sessionManager.appendCustomMessageEntry("orche:task-essentials", `${COMPACTION_ASSIGNMENT_LABEL}:\n${result.text}`, false);
      session.refreshContext();
    }
    const tokensAfter = session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    state.last = { tokensAfter };
    const usage = event.compactionEntry.usage;
    const resolved = state.fallback || !state.resolved ? undefined : state.resolved;
    const durationMs = state.startedAt !== undefined ? Date.now() - state.startedAt : undefined;
    state.startedAt = undefined;
    const summaryBudget = summaryBudgetUse(session);
    const summaryRequests = takeSummaryRequests(session);
    const summary = event.compactionEntry.summary;
    try { markCompaction(session); } catch { /* telemetry only */ }
    taskCompaction?.onCompact?.({
      tokensBefore: event.compactionEntry.tokensBefore, tokensAfter, reason: event.reason,
      ...(resolved ? { policy: resolved.policy, triggerTokens: resolved.triggerTokens, early: resolved.early, ...(resolved.usageRatio !== undefined ? { usageRatio: resolved.usageRatio } : {}) }
        : state.fallback ? { policy: "window-ratio" as const, ...(state.resolved?.fallback?.usageRatio !== undefined ? { usageRatio: state.resolved.fallback.usageRatio, triggerTokens: state.resolved.fallback.triggerTokens } : {}) } : {}),
      ...(result ? { essentialsChars: result.text.length, essentialsSections: result.sections, essentialsMissing: result.missing } : {}),
      ...(pre?.reference ? { reference: pre.reference.status } : {}),
      ...(usage ? { summaryUsage: { input: usage.input ?? 0, output: usage.output ?? 0 } } : {}),
      ...(essentialsError ? { essentialsError } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(typeof summary === "string" ? { summaryChars: summary.length } : {}),
      ...(summaryBudget ? { summaryBudget } : {}),
      ...(summaryRequests ? { summaryRequests } : {}),
    });
  };
  const failed = (event: SessionCompactFailedEvent) => {
    const session = getSession();
    const state = compactionStateOf(session);
    state.preflight = undefined;
    const durationMs = state.startedAt !== undefined ? Date.now() - state.startedAt : undefined;
    state.startedAt = undefined;
    if (state.cancelling) { state.cancelling = false; return; }
    const summaryBudget = summaryBudgetUse(session);
    const summaryRequests = takeSummaryRequests(session);
    try {
      options.taskCompaction?.onEvent?.(event.aborted
        ? { type: "compaction_cancelled", reason: event.reason, cause: "aborted", ...(event.errorMessage ? { detail: event.errorMessage } : {}) }
        : { type: "compaction_failed", reason: event.reason, ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}), willRetry: event.willRetry, ...(durationMs !== undefined ? { durationMs } : {}), ...(summaryBudget ? { summaryBudget } : {}), ...(summaryRequests ? { summaryRequests } : {}) });
    } catch { /* telemetry only */ }
  };
  return { path, resolvedPath: path, hidden: true, sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([["session_before_compact", [before as never]], ["session_compact", [handler as never]], ["session_compact_failed", [failed as never]]]), tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
}
/**
 * Worker-session hygiene that every orche session gets: output-limit recovery (length-recovery.ts), a suggestion on Pi's bare
 * `Tool X not found` result (unknown-tool.ts), the explicit output budget of Claude requests through CLIProxyAPI (output-cap.ts), and
 * the tool-call ledger behind checkpoint evidence (tool-evidence.ts: a `[orche ref Tn]` line on tool results when the assignment's
 * thinking policy links evidence), and the tool boundary of read nodes (read-node-guard.ts: only read-only tools while a Task DAG node
 * marked read:true runs at the read level). None of them re-routes a tool call.
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
    try { recordToolResult(session, event); } catch { /* telemetry only */ }
    const thinking = thinkingStateOf(session);
    const running = thinkingPolicyOf(session)?.plan?.nodes.find(node => node.status === "running")?.id;
    const record = recordToolCall(session, event, { request: thinking.requestSeq, ...(thinking.requestLevel ? { level: thinking.requestLevel } : {}), atBaseline: atEffectiveBaseline(thinking, thinking.requestLevel), ...(running ? { node: running } : {}) });
    if (!evidenceLedgerOf(session).tag || BOOKKEEPING_TOOLS.has(event.toolName)) return undefined;
    return { content: [...event.content, { type: "text" as const, text: refText(record) }], ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) };
  };
  // Read nodes (read-node-guard.ts): only read-only tools while a read node runs at the read level, in every mode.
  const toolCall = (event: { toolName: string }) => {
    const session = getSession();
    if (!session) return undefined;
    const reason = readNodeRefusal(session, event.toolName);
    return reason === undefined ? undefined : { block: true, reason };
  };
  return {
    path, resolvedPath: path, hidden: true,
    sourceInfo: createSyntheticSourceInfo(path, { source: "orche" }),
    handlers: new Map([
      ["message_end", [messageEnd as never]],
      ["tool_call", [toolCall as never]],
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
  const handler = async (event: { toolName: string; input: Record<string, unknown>; toolCallId?: string }) => {
    const reason = await guard(event.toolName, event.input, event.toolCallId);
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
  applyTaskCompaction(session, taskCompaction);
}

/** Toggle a previously installed workflow at role/mode boundaries; specialists retain ordinary behaviour. */
export function configureTaskWorkflow(session: AgentSession, taskCompaction: SessionOptions["taskCompaction"]): void {
  const state = taskSessions.get(session);
  if (!state) throw new Error("Session cannot configure the single workflow; omit worker to start a new worker.");
  state.options.taskCompaction = taskCompaction;
  const names = session.getActiveToolNames().filter(name => name !== "task_plan");
  session.setActiveToolsByName(taskCompaction ? [...names, "task_plan"] : names);
  applyTaskCompaction(session, taskCompaction);
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
  const skills = workerSkills(options.skills);
  const loader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [createSpillExtension(options.cwd), ...(options.toolGuard ? [createGuardExtension(options.toolGuard)] : []), createContextProjectionExtension(() => options.contextProjection), compactionExtension, hygieneExtension, ...(factoryExtensions?.extensions ?? [])],
      errors: [],
      runtime: factoryExtensions?.runtime ?? createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: skills.map(skill => ({ ...skill, sourceInfo: { ...skill.sourceInfo } })), diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.baseSystemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => skills.length ? [options.instructions, WORKER_SKILLS_NOTE] : [options.instructions],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const sessionManager = sessionManagerFor(options);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    // Session-local view: Pi's summary requests skip before_provider_request, so they get the output budget here (output-cap.ts),
    // and the summary budget (summary-budget.ts; task sessions: their essentials are restored, not summarized); every other request
    // through it (turns, extensions' ctx.modelRegistry, direct calls) is unchanged.
    modelRuntime: await withSummaryOutputCap(runtime, () => createdSession, { restoredLabel: () => options.taskCompaction ? COMPACTION_ASSIGNMENT_LABEL : undefined }),
    model,
    thinkingLevel: options.route.thinking ?? "off",
    // Allow a later hand-over upgrade, but do not register task_plan for run workers.
    tools: options.tools ? [...new Set([...options.tools, "task_plan"])] : undefined,
    customTools: [...createOrcheTools({ cwd: options.cwd, bashHeartbeat: { ...options.bashHeartbeat }, astRewriteFileGuard: options.writeFileGuard ?? (options.toolGuard ? () => "Blocked: directory ast_rewrite requires a per-file write guard in guarded sessions" : undefined) }), ...(options.customTools ?? [])],
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: options.taskCompaction ? piCompactionSettings(resolvedFor(options.taskCompaction, model)) : { enabled: false },
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
  if (options.taskCompaction) applyTaskCompaction(session, options.taskCompaction);
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
