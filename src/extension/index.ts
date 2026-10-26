import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOrcheTools } from "../tools/index.js";
import { spillToolResult } from "../tools/spill.js";
import { OrcheController, type OrcheControllerOptions } from "./controller.js";
import { inheritsMain, inheritsMainThinking, isDelegatingMode, MAIN_MODES, modeTiers, tierThinking, type MainMode, type ModelTiers } from "../orchestration/routing.js";
import { delegationRules, guardBusyToolCall, guardToolCall, isMainMode, MainModeState, type MainModeLookup } from "./mode.js";
import { contextWarning, DEFAULT_CONTEXT_WARNING, type ContextWarningSettings, type ContextWarningState } from "./context-warning.js";
import { CONFIG_FILE, DEFAULT_SINGLE, loadOrcheConfigFile } from "./config.js";
import { DEFAULT_BASH_REVIEW, guardBashReview, registryAccess, type BashReviewSettings } from "./bash-review.js";
import { orcheTaskParameters, WORKER_CAPABILITY_CHANNEL, WorkerPool, type GoneWorker, type WorkerCapabilityAnswer } from "./workers.js";
import { Type } from "typebox";
import { JOB_ENTRY_TYPE, jobResultContent, TASK_RESULT_TYPE, TaskJobs, WORKER_ENTRY_TYPE, type AttachOptions, type DetachReason, type Job, type JobEntry, type JobToolResult, type QueueArgs, type QueuedTask, type QueueEvent } from "./jobs.js";
import { attachResult, JOB_WIDGET_KEY, jobEndNotice, jobUpdate, jobWidgetLines } from "./job-view.js";
import { recoverOrphanRecords } from "./records.js";

import { formatRecordList, listRecords } from "./records.js";
import { createOrcheRenderers, orcheTaskRenderers, renderJobResultMessage } from "./render.js";
import { partialUpdate } from "./progress.js";
import { formatSplitSummary, readSplitLog, summarizeSplits } from "../orchestrator/split-log.js";
import { applyMainModel, formatModelTiers, inheritedThinking, type ModelTiersView } from "./main-model.js";
import { LONG_RESPONSE_GUIDANCE_TYPE, LongResponseWatch, type LongResponseOptions } from "./long-response.js";
import { defaultRunLimits, extensionBudgetMs, extensionLengthMs } from "../orchestration/limits.js";
import { formatDuration } from "../agent/liveness.js";
import { LEDGER_ENTRY_TYPE, LEDGER_SUMMARY_TYPE, latestLedgers, type TaskLedger } from "../single/ledger.js";
import { completeOrcheArguments } from "./completions.js";
import { discoveredSkills, workerSkills } from "../pi/worker-skills.js";
import { registerDependencyProvider } from "./dependencies.js";
import { createOrcheDependencyProvider, runDependencyCommand, type OrcheDependencyOptions } from "./doctor.js";
import { parseRouteRequest, PEER_NOTE_MAX, peerLabel, SESSION_BUS_ROUTE_EVENT } from "./peer-notes.js";

export const RESULT_MESSAGE_TYPE = "orche-result";
/** Pi built-ins that stay Pi's own but are switched on next to our tools. */
const ACTIVATE_BUILTINS = ["grep", "find", "ls"];

/**
 * `mainMode` of the config file the routes come from (trusted project file, else user file), read through `loadOrcheConfigFile`: it knows the
 * extension-only keys (`concurrentSessions`, `records`) that the plain route parser behind `discoverMainMode` (mode.ts) rejects as unknown, which
 * made a config with `records` look invalid at session start and drop its `mainMode`.
 */
async function discoverConfiguredMainMode(options: { cwd: string; agentDir: string; projectTrusted: boolean }): Promise<MainModeLookup & { contextWarning?: ContextWarningSettings; spawn?: boolean; advisor?: boolean; bashReview?: BashReviewSettings; warnings?: string[]; models?: ModelTiers }> {
  const candidates = [...(options.projectTrusted ? [join(options.cwd, ".pi", CONFIG_FILE)] : []), join(options.agentDir, CONFIG_FILE)];
  for (const path of candidates) {
    try { await access(path); } catch { continue; }
    try {
      const { routes, contextWarning, single, bashReview, warnings } = await loadOrcheConfigFile(path);
      // The tiers with the top-level extendedContext filled in where a tier leaves it out, as routes resolve it (routing.ts);
      // not for `{ "model": "main" }`, which keeps main's own context window.
      const models = routes.models ? Object.fromEntries(Object.entries(routes.models).map(([tier, route]) => {
        const extendedContext = inheritsMain(route) ? undefined : route.extendedContext ?? routes.extendedContext;
        return [tier, { ...route, ...(extendedContext !== undefined ? { extendedContext } : {}) }];
      })) as ModelTiers : undefined;
      return { ...(routes.mainMode ? { mode: routes.mainMode } : {}), ...(routes.legacyMainMode ? { legacyMode: routes.legacyMainMode } : {}), path, contextWarning, spawn: single.spawn, advisor: single.advisor, bashReview, ...(warnings.length ? { warnings } : {}), ...(models ? { models } : {}) };
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {};
}
/** The text of the latest user message on the session branch: the task main's Bash safety review is told about (clipped there). */
function lastUserText(ctx: ExtensionContext): string | undefined {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.flatMap(block => block && typeof block === "object" && (block as { type?: string }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : []).join("\n");
      return undefined;
    }
  } catch { /* no session branch */ }
  return undefined;
}
/**
 * The time-budget sentence of the orche_task description, written from the default limits (so that it cannot drift from limits.ts):
 * base cap, the extension schedule and count, and the ceiling they make. `limits` in orche.config.json override the defaults.
 */
function timeBudget(): string {
  const { assignmentMs, extensionMs, extensionStepMs, maxExtensions, observeMs } = defaultRunLimits;
  const minutes = (ms: number) => ms / 60_000;
  const base = `base ${minutes(assignmentMs)} minutes per assignment`;
  const active = "worker";
  const schedule = { extensionMs, extensionStepMs, maxExtensions };
  const ceiling = formatDuration(assignmentMs + extensionBudgetMs(schedule));
  const last = minutes(extensionLengthMs(schedule, maxExtensions));
  const lengths = extensionStepMs ? `by ${minutes(extensionMs)} minutes the first time and ${minutes(extensionStepMs)} minutes more each time after (${minutes(extensionMs)}, ${minutes(extensionLengthMs(schedule, 2))} … ${last} minutes)` : `by ${minutes(extensionMs)} minutes`;
  return `${base}; when the deadline passes while the ${active} is still actively working (using tools or producing output) it is extended ${lengths}, at most ${maxExtensions} times (${formatDuration(extensionBudgetMs(schedule))} of extensions at most, ${ceiling} in total; these are the defaults, limits.maxExtensions / limits.extensionMs / limits.extensionStepMs in orche.config.json change them); the worker is checked every ${minutes(observeMs)} minutes whatever the extension length, and one with no sign of life in 2 consecutive checks during an extension is stopped (missing progress alone never stops it); a timeout is not an unmet result: continue it with the same worker (and task) as the result says;`;
}

/** How long a one-turn override waits for the session to start the turn it just queued before giving up. */
const SINGLE_START_TIMEOUT_MS = 10_000;
/**
 * Pi queues a steer typed during a turn right after the `input` handlers return: an attached call detaches once the steer is
 * queued (`ctx.hasPendingMessages()`), checked every {@link INPUT_CHECK_MS}, and at the latest after this grace (another
 * extension may have consumed the input; detaching then only costs main one re-attach). A follow-up never detaches: Pi delivers
 * it when the run has nothing else to do, i.e. after the attached call returned the job's result.
 */
const INPUT_GRACE_MS = 1000;
const INPUT_CHECK_MS = 10;
/** A woken session-bus note counts as waiting for main until Pi delivers it, at most this long (Esc may drop queued notes). */
const NOTE_PENDING_MS = 60_000;
/** The event pi-session-bus emits once Pi accepted an incoming note (`{ id, wake }`; see its README). */
export const SESSION_BUS_MESSAGE_EVENT = "session-bus:message";
const SESSION_BUS_MESSAGE_TYPE = "session-bus.message";
/** How many routed note ids are remembered against a repeated offer (the bus itself drops duplicate ids). */
const ROUTED_NOTES_KEPT = 256;
/** How long orche_task's approval dialog waits for the user while a job runs; no answer in time approves nothing. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** The two answers of that dialog: only the first, chosen by the user, approves (jobs.ts queue). */
export const APPROVE_QUEUED = "Approve: queue it to start after the running job has finished";
export const DECLINE_QUEUED = "Decline: do not delegate it";
/** The answers of the dialog that confirms main's control of the running worker (orche_task_message, orche_task_status cancel). */
export const CONFIRM_MESSAGE = "Send: it adds to or corrects the running worker's own task";
export const DECLINE_MESSAGE = "Do not send";
export const CONFIRM_CANCEL = "Cancel the running job";
export const DECLINE_CANCEL = "Keep it running";
/** The longest orche_task_message the user is asked to confirm, shown in full; a longer one is not sent while a job runs. */
export const MESSAGE_CONFIRM_MAX = 2000;
/** A message to main about an approved queued task that could not start after its job's result said it would. */
export const QUEUE_MESSAGE_TYPE = "orche-task-queue";

export const ORCHE_USAGE = "Usage: /orche single|strong|ultra|mdsd|direct <PROMPT> | /orche mode [single|strong|ultra|mdsd|direct] | /orche workers | /orche stop <id>|all | /orche records | /orche splits [DAYS] | /orche models | /orche cancel | /orche detach | /orche doctor | /orche install-deps";
export type OrcheCommand =
  | { mode: MainMode; prompt: string }
  | { mode: "cancel" }
  | { mode: "detach" }
  | { mode: "workers" }
  | { mode: "records" }
  | { mode: "splits"; days?: number }
  | { mode: "models" }
  | { mode: "stop"; worker: string }
  | { mode: "mode"; value?: MainMode }
  | { mode: "doctor" }
  | { mode: "install-deps" };
/** What each mode does to the request of a one-shot `/orche <mode> <prompt>` (usage and refusal texts). */
const ONE_SHOT_EFFECT: Record<MainMode, string> = {
  single: "delegates it to one worker on the general model tiers (models.orchestrator, models.worker)",
  strong: "delegates it to one worker on the strong model tiers (models.strong-orchestrator, models.strong-worker)",
  ultra: "runs it with the quality-first ultra orchestration on the strong model tiers",
  mdsd: "runs it with the MDSD search policy (multi-dimensional search diversification: independent exploration paths that differ in interpretation, hypotheses, sources, reasoning, direction and validation, then integration, adaptive search and verification) on the strong model tiers",
  direct: "lets main edit directly, without workers",
};
/**
 * The usage of `/orche strong`, `/orche ultra` or `/orche mdsd` given without a prompt (or only whitespace): what the one-shot command does, and that
 * the session's mode stays unless `/orche mode <mode>` sets it. Undefined for anything else (`single`/`direct` keep the general usage).
 */
export function oneShotUsage(args: string): string | undefined {
  const mode = /^\s*(\S+)\s*$/.exec(args)?.[1];
  if (mode !== "strong" && mode !== "ultra" && mode !== "mdsd") return undefined;
  return `Usage: /orche ${mode} <PROMPT>: ${ONE_SHOT_EFFECT[mode]} for this one request (the prompt may span lines). The session's mode does not change; /orche mode ${mode} switches it.`;
}
/**
 * Why a one-shot command is refused while main is busy: it starts only from an idle session, so its own run (prompt, tools, workers)
 * is in its mode; a queued turn would run as an ordinary prompt and lose it, also when the session's mode happens to be the same.
 */
export function busyRefusal(requested: MainMode, session: MainMode): string {
  const alternative = requested === session
    ? `, or send the prompt without "/orche ${requested}" to queue it as an ordinary follow-up in the session's mode (${session})`
    : `, or switch the session with /orche mode ${requested}`;
  return `orche ${requested}: refused. The agent is busy, and a one-shot /orche ${requested} request starts only when the session is idle, so that its run and its workers use ${requested} mode (it ${ONE_SHOT_EFFECT[requested]}); a queued turn would lose that. Send it again when the current run has ended${alternative}.`;
}
/** The system prompt section with main's delegation rules for its mode. */
const DELEGATION_SECTION = "orche-delegation";
/**
 * Strict command grammar: extra tokens on control commands never start work. A one-shot command `<mode> <PROMPT>` is the mode word
 * (after optional leading whitespace), ONE whitespace character as the delimiter (a space, a tab or a line break), then the prompt:
 * everything after the delimiter, verbatim (its own leading and trailing whitespace, lines, quotes and slashes included). A missing or
 * whitespace-only prompt is no command (the caller shows the usage).
 */
export function parseOrcheCommand(args: string): OrcheCommand | undefined {
  if (/^\s*cancel\s*$/.test(args)) return { mode: "cancel" };
  if (/^\s*detach\s*$/.test(args)) return { mode: "detach" };
  if (/^\s*workers\s*$/.test(args)) return { mode: "workers" };
  if (/^\s*records\s*$/.test(args)) return { mode: "records" };
  if (/^\s*models\s*$/.test(args)) return { mode: "models" };
  // Dependency health check and install (doctor.ts). Exact words only: a prompt always follows a mode word, so neither changes a one-shot request.
  if (/^\s*doctor\s*$/.test(args)) return { mode: "doctor" };
  if (/^\s*install-deps\s*$/.test(args)) return { mode: "install-deps" };
  const splits = /^\s*splits(?:\s+(\d+))?\s*$/.exec(args);
  if (splits) return splits[1] !== undefined ? (Number(splits[1]) > 0 ? { mode: "splits", days: Number(splits[1]) } : undefined) : { mode: "splits" };
  const stop = /^\s*stop\s+(\S+)\s*$/.exec(args);
  if (stop?.[1]) return { mode: "stop", worker: stop[1] };
  const switchMode = /^\s*mode(?:\s+(\S+))?\s*$/.exec(args);
  if (switchMode) {
    if (switchMode[1] === undefined) return { mode: "mode" };
    return isMainMode(switchMode[1]) ? { mode: "mode", value: switchMode[1] } : undefined;
  }
  const match = new RegExp(`^\\s*(${MAIN_MODES.join("|")})(?:\\s([\\s\\S]*))?$`).exec(args);
  const prompt = match?.[2];
  return prompt !== undefined && /\S/.test(prompt) ? { mode: match![1] as MainMode, prompt } : undefined;
}

export interface OrcheExtensionOptions extends OrcheControllerOptions {
  /** Idle worker retirement timeout, injectable for tests. */
  workerIdleTtlMs?: number;
  /** Disable only when an embedding intentionally owns an isolated worker provider setup. Default true. */
  inheritProviders?: boolean;
  /** Thresholds of the main session's long-response watch (long-response.ts), injectable for tests. */
  longResponse?: LongResponseOptions;
  /** How long orche_task's approval dialog (a delegation while a job runs) waits for the user; default 5 minutes. */
  approvalTimeoutMs?: number;
  /** Seams of the dependency provider behind `/orche doctor|install-deps` (doctor.ts); agentDir defaults to `agentDir` above. */
  dependencies?: OrcheDependencyOptions;
}
/** Build the extension; options provide config/runtime/run and idle-timeout test seams. */
export function createOrcheExtension(options: OrcheExtensionOptions = {}) {
  return function orcheExtension(pi: ExtensionAPI): void {
    // First, before anything that could fail: the umbrella's /oh-my-pi doctor|install-deps asks every package synchronously.
    const dependencies = createOrcheDependencyProvider({ ...(options.agentDir ? { agentDir: options.agentDir } : {}), ...options.dependencies });
    registerDependencyProvider(pi.events, dependencies);
    const controller = new OrcheController(options);
    let workers: WorkerPool | undefined;
    /** Task ledgers of this session's branch (restored at session start): a fresh pool picks them up, so a task outlives its worker. */
    let restoredLedgers: TaskLedger[] = [];
    /** Gone workers and used worker ids of this session's branch (restored at session start): ids are never reused. */
    let restoredHistory: { gone: GoneWorker[]; usedWorkerIds: string[] } = { gone: [], usedWorkerIds: [] };
    /** The UI and mode of the latest tool call / session start, for the background job's widget and notices. */
    let lastUi: ExtensionContext["ui"] | undefined;
    let lastMode: ExtensionContext["mode"] | undefined;
    /**
     * Metadata of the skills main's Pi discovered, for new workers' own prompts (src/pi/worker-skills.ts): the list of main's latest
     * run (before_agent_start). Pi 1.2.0 and later emit before_agent_start for every run that starts while idle: a user prompt
     * (`messageType: "user"`) and a run a triggerTurn message starts (`"custom"`: a session-bus wake, an orche result). Undefined
     * until main's first run of this runtime; an older Pi host (peer `*`) emits nothing for a custom run, so when such a run is
     * main's first after a session start or /reload, its workers take the same loader list from Pi's slash commands when they
     * start. Nothing else of main reaches a worker this way: no extension, hook, conversation or state.
     */
    let mainSkills: Skill[] | undefined;
    const knownSkills = (): Skill[] => {
      if (mainSkills) return mainSkills;
      try {
        return discoveredSkills(pi.getCommands());
      } catch {
        return [];
      }
    };
    const pool = () => {
      if (!workers) {
        workers = new WorkerPool({
          controller, ...(options.agentDir ? { agentDir: options.agentDir } : {}), ...(options.workerIdleTtlMs !== undefined ? { idleTtlMs: options.workerIdleTtlMs } : {}),
          skills: knownSkills,
          // One small entry per ledger event, not part of the model context: it follows the session branch and survives reloads.
          onLedgerEvent: event => pi.appendEntry(LEDGER_ENTRY_TYPE, event),
          // Workers that go away are remembered in the session, so naming one later continues with a new worker briefed from it.
          onWorkerGone: worker => { try { pi.appendEntry(WORKER_ENTRY_TYPE, worker); } catch { /* best effort, e.g. during shutdown */ } },
          // Opt-in capabilities other extensions provide for a worker's own session (pi-gui: `gui`). The first answer wins.
          capability: request => {
            let answer: WorkerCapabilityAnswer;
            pi.events.emit(WORKER_CAPABILITY_CHANNEL, { ...request, provide: (value: WorkerCapabilityAnswer) => { answer ??= value; } });
            return answer;
          },
        });
        if (restoredLedgers.length) workers.restoreLedgers(restoredLedgers);
        workers.restoreHistory(restoredHistory.gone, restoredHistory.usedWorkerIds);
      }
      return workers;
    };
    // Background orche_task jobs (jobs.ts): started by orche_task, announced once to the attached call or as an orche-task-result message.
    let jobs: TaskJobs | undefined;
    const taskJobs = () => (jobs ??= new TaskJobs({
      pool,
      persist: entry => { try { pi.appendEntry(JOB_ENTRY_TYPE, entry); } catch { /* best effort */ } },
      deliver: (job: Job) => {
        // The result of a job that another request started does not enter a one-shot run: it waits for that run to end (heldBack).
        if (oneShot && !oneShot.jobs.has(job.id)) heldBack.push({ kind: "result", job });
        else deliverResult(job);
        const notice = jobEndNotice(job);
        try { lastUi?.notify(notice.text, notice.level); } catch { /* the UI may be gone */ }
      },
      onChange: job => {
        if (job.status !== "running") endedShown = job.id;
        paintJob();
      },
      onQueue: event => announceQueue(event),
      // A queued task delegates: not once the session's main switched delegation off (direct mode) since the user approved it.
      canStartQueued: () => isDelegatingMode(state.effective) ? undefined : `delegation is off now (orche mode ${state.effective})`,
    }));
    /** What became of an approved queued task (jobs.ts): the user hears it once; main gets a message only when nothing told it yet. */
    const announceQueue = (event: QueueEvent) => {
      if (event.kind === "started") {
        try { lastUi?.notify(`orche: ${event.task.id}, the task you approved, started as ${event.job.id} (${event.job.worker ?? "?"} ${event.job.role}); its result arrives as a message.`, "info"); } catch { /* the UI may be gone */ }
        return;
      }
      try { lastUi?.notify(`orche: ${event.task.id}, the task you approved (${event.task.role}: ${event.task.request}), was dropped and did not start: ${event.reason}.`, "warning"); } catch { /* the UI may be gone */ }
      // `result`: the result of the job it waited for says so; `cancel`: the caller hears it. `start`: that result said it would start.
      if (event.source !== "start") return;
      pi.sendMessage(
        { customType: QUEUE_MESSAGE_TYPE, content: `[orche queued task ${event.task.id} dropped] The task the user approved to run after ${event.task.after} (${event.task.role}: ${event.task.request}) did not start: ${event.reason}. Nothing was delegated. Tell the user; delegate it again only when they ask.`, display: true, details: { queued: event.task.id, after: event.task.after, reason: event.reason } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    };

    const deliverResult = (job: Job, triggerTurn = true) => pi.sendMessage(
      { customType: TASK_RESULT_TYPE, content: jobResultContent(job), display: true, details: { job: job.id, worker: job.worker, role: job.role, status: job.status, startedAt: job.startedAt, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...(job.record ? { record: job.record } : {}), ...(job.result?.details ? { task: job.result.details } : {}) } },
      // Starts main's next turn when it is idle; queued behind the current turn when main is talking with the user.
      triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
    );
    /**
     * The one-shot `/orche <mode> <prompt>` request whose run is going on (docs/orchestrator.md 14.5): main's mode is its override until
     * that run settles, and only what belongs to the request enters the run: its prompt and the context Pi sends with it, user steers
     * (they correct the request), results of the jobs it started. Other requests are held back (`heldBack`) and each runs afterwards
     * as its own run in the session's mode. Anything else that still arrives once main answers (a peer session's note, another
     * extension's message) cannot be told apart from a new request: the override ends there, conservatively, and the rest of the run
     * follows the session's mode (prompt, tools, guard, dispatch).
     */
    let oneShot: { mode: MainMode; jobs: Set<string>; answering: boolean } | undefined;
    /** Follow-up prompts and job results of other requests that arrived during a one-shot run, in arrival order. */
    const heldBack: ({ kind: "input"; text: string; images?: InputEvent["images"] } | { kind: "result"; job: Job })[] = [];
    /** The notice about background jobs a crash interrupted: it goes with the next prompt that is not a one-shot request. */
    let interruptedNotice: { customType: string; content: string; display: boolean; details: unknown } | undefined;
    // The job widget above the editor: running (attached / detached) with its elapsed time, then its end until the next user input.
    /** The ended job whose last state the widget still shows. */
    let endedShown: string | undefined;
    let widgetTimer: ReturnType<typeof setInterval> | undefined;
    let widgetText: string | undefined;
    const stopWidgetTimer = () => { if (widgetTimer) clearInterval(widgetTimer); widgetTimer = undefined; };
    const paintJob = () => {
      const job = jobs?.running ?? (endedShown ? jobs?.get(endedShown) : undefined);
      const queued = jobs?.queued;
      const lines = job ? [
        ...jobWidgetLines(job, { attached: jobs?.attached === job, coarse: lastMode !== "tui" }),
        // The approved task waiting for it (not while the user is still being asked).
        ...(queued && queued.state !== "asking" ? [`⧗ orche ${queued.id} · ${queued.role} · approved: ${queued.state === "starting" ? "starting" : `starts after ${queued.after} has finished (done)`}`] : []),
      ] : undefined;
      const text = lines?.join("\n");
      if (text !== widgetText) {
        widgetText = text;
        try { lastUi?.setWidget(JOB_WIDGET_KEY, lines); } catch { /* the UI may be gone */ }
      }
      // Only the TUI gets the per-second clock; RPC clients get the widget again when its text changes.
      if (job?.status === "running" && lastMode === "tui") {
        if (!widgetTimer) { widgetTimer = setInterval(paintJob, 1000); widgetTimer.unref?.(); }
      } else stopWidgetTimer();
    };

    // Detaching an attached call: input for main (user steers, woken session-bus notes) and how long a note counts as waiting.
    /** Woken session-bus notes Pi has queued but not yet delivered into main's context: note id -> arrival. */
    const pendingNotes = new Map<string, number>();
    /** Session-bus notes routed to a running worker (note id -> where it went), so that the same note never goes there twice. */
    const routedNotes = new Map<string, { to: string; ref: string }>();
    const notesWaiting = () => {
      const now = Date.now();
      for (const [id, at] of pendingNotes) if (now - at > NOTE_PENDING_MS) pendingNotes.delete(id);
      return pendingNotes.size > 0;
    };
    /**
     * User prompts queued for main while it runs (`input` events with `streamingBehavior`), not yet delivered. Pi delivers every
     * queued steer before any follow-up, each as a user message (`message_start`, after Pi took it out of its queue), and
     * `ctx.hasPendingMessages()` counts both queues together; these counts tell a waiting steer (answer it now) from a follow-up
     * that waits for the run to end. They are counts, not texts: other input handlers and prompt templates may change the text
     * Pi queues. An input another extension handled is never queued: its count goes with the next delivered user message, once
     * nothing is queued any more, or when the session settles.
     */
    const queued = { steer: 0, followUp: 0 };
    /** When the last queued-kind input arrived: until Pi has queued it (at most {@link INPUT_GRACE_MS}) its count is kept. */
    let lastQueuedInput = 0;
    const resetQueued = () => { queued.steer = 0; queued.followUp = 0; };
    /**
     * Whether input waits for main that an attached call must make way for: a queued steer or an undelivered woken note. Queued
     * follow-ups alone do not count: they wait for the job's result like Pi's follow-up queue waits for the run. A queued message
     * orche saw no input for counts as a steer (the earlier, safe behaviour).
     */
    const inputWaiting = (ctx: Pick<ExtensionContext, "hasPendingMessages">) => {
      let pending = false;
      try { pending = ctx.hasPendingMessages(); } catch { /* stale context */ }
      // Nothing queued and no input on its way into the queue: counts of inputs that were never queued are stale.
      if (!pending && Date.now() - lastQueuedInput >= INPUT_GRACE_MS) resetQueued();
      if (pending && (queued.steer > 0 || queued.followUp === 0)) return true;
      return notesWaiting();
    };
    /** The attach options of a tool call: its abort signal detaches, its block shows the job's progress. */
    const attachOptions = (signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate: ((update: ReturnType<typeof jobUpdate>) => void) | undefined): AttachOptions => ({
      ...(signal ? { signal } : {}),
      pending: () => inputWaiting(ctx),
      onUpdate: job => onUpdate?.(jobUpdate(job)),
    });
    /**
     * Detach once the steer that just arrived is queued for main (or after the grace): see {@link INPUT_GRACE_MS}. Only this
     * attachment: a later attach (even to the same job) is not touched. While follow-ups are queued `ctx.hasPendingMessages()`
     * is already true, so the first check detaches; Pi queues the steer as soon as the input handlers have returned, so only
     * another extension's slow async input handler can make that check come first (then the next attach is refused once the
     * steer is queued).
     */
    const detachOnInput = (ctx: ExtensionContext) => {
      const tasks = jobs;
      const attachment = tasks?.attachment;
      if (!tasks || !attachment) return;
      const since = Date.now();
      const check = () => {
        if (tasks.attachment !== attachment) return;
        let isQueued = false;
        try { isQueued = ctx.hasPendingMessages(); } catch { isQueued = true; }
        if (isQueued || Date.now() - since >= INPUT_GRACE_MS) tasks.detach("input");
        else setTimeout(check, INPUT_CHECK_MS).unref?.();
      };
      setTimeout(check, 0).unref?.();
    };
    /** The calling session's own file/id/directory: never reported as another session, and where the session store is. */
    const currentSession = (ctx: Pick<ExtensionContext, "sessionManager">) => ({
      file: ctx.sessionManager.getSessionFile() || undefined,
      id: ctx.sessionManager.getSessionId() || undefined,
      dir: ctx.sessionManager.getSessionDir() || undefined,
    });
    const state = new MainModeState(pi);
    let warningSettings: ContextWarningSettings = { ...DEFAULT_CONTEXT_WARNING, thresholds: [...DEFAULT_CONTEXT_WARNING.thresholds] };
    let warningState: ContextWarningState = { warnedLevel: 0 };
    /** `single.spawn` of the config file read at session start: whether the single worker is an orchestrator (orche_spawn). */
    let spawn: boolean = DEFAULT_SINGLE.spawn;
    /** `bashReview` of the config file read at session start (defaults without a valid file): main's Bash safety review (bash-review.ts). */
    let bashReview: BashReviewSettings = { ...DEFAULT_BASH_REVIEW };
    /** `models.main` at the last session start: what the config set and what was applied (for /orche models). */
    let mainModel: ModelTiersView["atStart"] = {};
    /** The config's model tiers at the last session start: the mode's orchestrator tier decides main's hand-off rule (its own model or
     * thinking level, or "inherit main's"); strong and ultra read models.strong-orchestrator, with models.orchestrator as its fallback. */
    let configuredTiers: ModelTiers | undefined;
    /** The floor of an implicit thinking inheritance (main-model.ts inheritedThinking): models.main's thinking, else main's level
     * at the last session start. Lowering main's thinking later does not lower the workers that only inherit it. */
    let thinkingFloor: { level: ThinkingLevel; source: "models.main" | "session start" } | undefined;
    /** Main's thinking now, and the level a tier that sets no thinking of its own inherits from it. */
    const handOffThinking = () => {
      const thinking = pi.getThinkingLevel();
      return { thinking, inheritedThinking: inheritedThinking(thinking, thinkingFloor?.level) };
    };
    /** The main session's long-response watch (long-response.ts): notifies the user, adds a request-local note after a long failure. */
    const longResponse = new LongResponseWatch(() => state.effective, (message, type) => { try { lastUi?.notify(message, type); } catch { /* the UI may be gone */ } }, options.longResponse);
    const showMode = (ctx: Pick<ExtensionContext, "ui">) =>
      ctx.ui.setStatus("orche-mode", `orche: ${state.session}${state.overriding ? ` (one-turn ${state.effective})` : ""}`);
    const endOneShot = (ui: ExtensionContext["ui"]) => {
      if (!oneShot) return;
      oneShot = undefined;
      state.setOverride();
      try { showMode({ ui }); } catch { /* the UI may be gone */ }
    };
    /**
     * Send what a one-shot run held back, in order, once it has settled: called from `agent_settled`, where Pi runs each prompt and
     * triggered message as its own run after the other (a fresh `before_agent_start`, the session's mode). After Esc (aborted) nothing
     * starts: held prompts go back to the editor like Pi's own queue, held results are shown without a turn.
     */
    const releaseHeldBack = (ui: ExtensionContext["ui"], aborted: boolean) => {
      const items = heldBack.splice(0);
      const returned: string[] = [];
      for (const item of items) {
        if (item.kind === "result") { deliverResult(item.job, !aborted); continue; }
        if (aborted) { returned.push(item.text); continue; }
        pi.sendUserMessage(item.images?.length ? [{ type: "text", text: item.text }, ...item.images] : item.text, { deliverAs: "followUp", expandPromptTemplates: true });
      }
      if (!returned.length) return;
      try {
        const current = ui.getEditorText();
        ui.setEditorText([...returned, ...(current ? [current] : [])].join("\n\n"));
      } catch { /* no editor */ }
      try { ui.notify(`orche: the one-shot run was aborted; ${returned.length === 1 ? "the prompt queued during it was" : `${returned.length} prompts queued during it were`} not sent (back in the editor).`, "info"); } catch { /* no UI */ }
    };
    /** The `orche-delegation` prompt section of a mode (the rules main follows in it). */
    const delegationSection = (mode: MainMode) => {
      const head = modeTiers(configuredTiers, mode).orchestrators[0];
      return delegationRules(mode, { spawn, orchestratorModel: !!head && !inheritsMain(head.tier), orchestratorThinking: !!tierThinking(head?.tier), orchestratorThinkingMain: inheritsMainThinking(head?.tier), ...(head ? { orchestratorKey: head.key } : {}) });
    };

    // (1) Our tools replace Pi's read/edit by name; they are bound to the cwd of the call, not of the process.
    const byCwd = new Map<string, Map<string, ToolDefinition>>();
    const forCwd = (cwd: string, name: string): ToolDefinition => {
      let tools = byCwd.get(cwd);
      if (!tools) {
        tools = new Map(createOrcheTools({ cwd }).map(tool => [tool.name, tool]));
        byCwd.set(cwd, tools);
      }
      return tools.get(name)!;
    };
    const ours: string[] = [];
    for (const template of createOrcheTools({ cwd: process.cwd() })) {
      ours.push(template.name);
      pi.registerTool({
        ...template,
        execute: (id, params, signal, onUpdate, ctx) => forCwd(ctx.cwd, template.name).execute(id, params, signal, onUpdate, ctx),
      });
    }
    pi.on("tool_result", (event, ctx) => spillToolResult(
      event, ctx.cwd, process.env.PI_ORCHE_TOOL_EVENTS ? ctx.sessionManager.getSessionId() : undefined,
    ));
    pi.on("session_start", async (event, ctx) => {
      const active = pi.getActiveTools();
      // An explicit `--tools` / defaultTools selection that leaves out our tools is the user's choice: keep it.
      if (ours.every(name => active.includes(name))) {
        const registered = new Set(pi.getAllTools().map(tool => tool.name));
        const extra = ACTIVATE_BUILTINS.filter(name => registered.has(name) && !active.includes(name));
        if (extra.length) pi.setActiveTools([...active, ...extra]);
      }
      const found = await discoverConfiguredMainMode({ cwd: ctx.cwd, agentDir: options.agentDir ?? getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
      state.setConfig(found.mode, found.path);
      warningSettings = found.contextWarning ?? { ...DEFAULT_CONTEXT_WARNING, thresholds: [...DEFAULT_CONTEXT_WARNING.thresholds] };
      warningState = { warnedLevel: 0 };
      spawn = found.spawn ?? DEFAULT_SINGLE.spawn;
      bashReview = found.bashReview ?? { ...DEFAULT_BASH_REVIEW };
      // Only a model or a thinking level of its own changes main's hand-off rule; `{ "model": "main" }` and `thinking: "main"` keep
      // the earlier sentence's "main's CURRENT" for what they inherit.
      configuredTiers = found.models;
      // Removed settings (e.g. single.pipeline, single.mainReview) are ignored: the file still loads; say so once per session start.
      for (const warning of found.warnings ?? []) ctx.ui.notify(warning, "warning");
      // models.main: the Pi session's model and thinking, once at a fresh session start; the user's own choices are kept.
      const main = await applyMainModel(pi, ctx, event.reason, found.models?.main);
      mainModel = { ...(found.models?.main ? { configured: found.models.main } : {}), ...(main.applied ? { applied: main.applied } : {}), ...(main.skipped ? { skipped: main.skipped } : {}) };
      for (const warning of main.warnings) ctx.ui.notify(warning, "warning");
      // The floor of implicit thinking inheritance: models.main's level when the config sets one, else main's level now (after
      // models.main was applied at a fresh start; a resumed or reloaded session takes the level it has at this start).
      thinkingFloor = found.models?.main?.thinking ? { level: found.models.main.thinking, source: "models.main" } : { level: pi.getThinkingLevel(), source: "session start" };
      longResponse.reset();
      // Not known until main's own run (before_agent_start); workers started before it read Pi's command list (knownSkills).
      mainSkills = undefined;
      state.restore(ctx.sessionManager.getBranch());
      restoredLedgers = latestLedgers(ctx.sessionManager.getBranch());
      workers?.restoreLedgers(restoredLedgers);
      lastUi = ctx.ui;
      lastMode = ctx.mode;
      endedShown = undefined;
      pendingNotes.clear();
      resetQueued();
      oneShot = undefined;
      heldBack.length = 0;
      // Like a message Pi keeps for the next turn, the notice outlives a reload (not a switch to another session).
      if (event.reason !== "reload") interruptedNotice = undefined;
      stopWidgetTimer();
      if (widgetText !== undefined) { widgetText = undefined; try { ctx.ui.setWidget(JOB_WIDGET_KEY, undefined); } catch { /* no UI */ } }
      // Jobs and gone workers of this branch: a job that never ended belonged to a process that is gone (crash): it ends now, once.
      const branch = ctx.sessionManager.getBranch();
      const customData = <T,>(type: string) => branch.filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === type).map(entry => (entry as { data?: unknown }).data as T).filter(Boolean);
      const restored = taskJobs().restore(customData<JobEntry>(JOB_ENTRY_TYPE), customData<GoneWorker>(WORKER_ENTRY_TYPE));
      restoredHistory = { gone: restored.gone, usedWorkerIds: restored.usedWorkerIds };
      workers?.restoreHistory(restored.gone, restored.usedWorkerIds);
      // An approved queued task never starts in a later session: said once, with the interrupted jobs.
      const dropped = restored.droppedQueue.map((task: QueuedTask) => `${task.id} (${task.role}: ${task.request}; it was to start after ${task.after})`);
      const droppedText = dropped.length ? `the task${dropped.length === 1 ? "" : "s"} the user approved to run after a background job did not start before the previous pi session ended and ${dropped.length === 1 ? "is" : "are"} dropped: ${dropped.join("; ")}; delegate again only when the user asks.` : "";
      if (restored.interrupted.length || dropped.length) {
        const lines = restored.interrupted.map(job => `${job.id} (${job.worker ?? "?"} ${job.role}: ${job.request})${job.record ? ` record ${job.record}` : ""}`);
        const interruptedText = restored.interrupted.length ? `orche: ${restored.interrupted.length === 1 ? "a background task was" : "background tasks were"} still running when the previous pi process ended, and ${restored.interrupted.length === 1 ? "is" : "are"} now marked interrupted: ${lines.join("; ")}. Naming its worker in orche_task continues the work with a new worker briefed from its transcript.` : "";
        const text = [interruptedText, droppedText ? (interruptedText ? `Also, ${droppedText}` : `orche: ${droppedText}`) : ""].filter(Boolean).join(" ");
        ctx.ui.notify(text, "warning");
        // With the next run's start (before_agent_start), but not with a one-shot request's: those jobs are not part of it. On Pi
        // 1.2.0 and later that may be a run a triggerTurn message starts (an orche result, a session-bus wake), not only a user
        // prompt: the notice goes with whichever run comes first, once, as it reports the session's state, not a reply to a prompt.
        interruptedNotice = { customType: "orche-job-interrupted", content: text, display: true, details: { jobs: restored.interrupted.map(job => job.id), ...(dropped.length ? { queued: restored.droppedQueue.map((task: QueuedTask) => task.id) } : {}) } };
      }
      // run.json records of this session left at "running" by a process that is gone: close them as interrupted (best effort, async).
      void controller.recordsFor({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), ...(ctx.model ? { model: ctx.model } : {}) })
        .then(resolved => recoverOrphanRecords(resolved, { parentSessionId: ctx.sessionManager.getSessionId() || undefined }))
        .then(recovered => { if (recovered.length) ctx.ui.notify(`orche: closed ${recovered.length} orphaned task record${recovered.length === 1 ? "" : "s"} as interrupted (their process ended while running).`, "info"); })
        .catch(() => undefined);
      state.apply();
      showMode(ctx);
      if (found.error) ctx.ui.notify(`orche: ${found.error}; using the default mode ${state.session}`, "warning");
      if (found.legacyMode && !found.error) ctx.ui.notify(`orche: mainMode "${found.legacyMode}" in ${found.path} was removed (multi-agent orche_run delegation); using "single". Set mainMode to one of ${MAIN_MODES.join(", ")}.`, "warning");
    });
    // Every run main starts while idle (Pi 1.2.0+: user prompts and runs a triggerTurn message starts alike; older hosts: user
    // prompts only). Both kinds get the skill list and the delegation section of the mode in force, and the first takes the notice.
    pi.on("before_agent_start", event => {
      // Late/restored tools may have become active since session_start.
      state.apply();
      mainSkills = workerSkills(event.systemPromptOptions.skills);
      event.systemPromptOptions.sections[DELEGATION_SECTION] = delegationSection(state.effective);
      if (!interruptedNotice || oneShot) return undefined;
      const message = interruptedNotice;
      interruptedNotice = undefined;
      return { message };
    });
    // Pi writes the prompt sections when a run starts (before_agent_start: since Pi 1.2.0 also for a run a triggerTurn message
    // starts while idle, before it only for user prompts) and keeps them for the rest of that run (its tool turns, steers and
    // follow-ups, a job result that arrives while main is busy): every model request carries the section of the mode in force NOW,
    // so a one-shot mode never outlives its request in the prompt (an override that ended mid-run, a run an older Pi started
    // without before_agent_start). When the recorded section is already current nothing is added. Request-local: the transcript
    // keeps what Pi recorded.
    pi.on("context_with_system", event => {
      // As Pi records a custom section in the transcript (buildSystemPromptSections wraps it in its name's tags).
      const wanted = `<${DELEGATION_SECTION}>\n${delegationSection(state.effective)}\n</${DELEGATION_SECTION}>`;
      let current: string | undefined;
      for (const message of event.messages) {
        const sections = message.role === "system" ? (message as { sections?: Record<string, string | null> }).sections : undefined;
        if (sections && DELEGATION_SECTION in sections) current = sections[DELEGATION_SECTION] ?? undefined;
      }
      if (current === wanted) return undefined;
      // Where Pi puts its own prompt updates: after the last answer and its tool results (never between a call and its result), before
      // the input of the request being answered.
      const messages = [...event.messages];
      const lastAnswer = messages.map(message => message.role).lastIndexOf("assistant");
      let at = lastAnswer < 0 ? messages.length : lastAnswer + 1;
      while (at < messages.length && messages[at]!.role === "toolResult") at++;
      messages.splice(at, 0, { role: "system", content: "", sections: { [DELEGATION_SECTION]: wanted }, timestamp: Date.now() } as (typeof messages)[number]);
      return { messages };
    });
    // After a long main response failed without a tool call (long-response.ts), every model request of this session gets a short
    // request-local note at the end of its context (Pi's auto-retry included: `context` runs before each request) until a response
    // completes or the user aborts. Appended last, so the cached prefix of the request stays the same; never stored in the session.
    pi.on("context", event => {
      const note = longResponse.guidance();
      if (!note) return undefined;
      return { messages: [...event.messages, { role: "custom", customType: LONG_RESPONSE_GUIDANCE_TYPE, content: note, display: false, timestamp: Date.now() } as (typeof event.messages)[number]] };
    });
    pi.on("message_update", event => { longResponse.messageUpdate(event.message as Parameters<LongResponseWatch["messageUpdate"]>[0]); });
    // Every mode: advise the user (not the model) when main's context fills up (context-warning.ts); direct mode names single mode,
    // the delegating modes /compact or a new session, since delegating does not shrink the history main already holds.
    pi.on("turn_end", (_event, ctx) => {
      state.apply();
      const checked = contextWarning(state.effective, ctx.getContextUsage(), warningSettings, warningState);
      warningState = checked.state;
      if (checked.message) ctx.ui.notify(checked.message, "warning");
      return undefined;
    });
    // Single mode: the main session's own compaction drops the task results it saw; put the task ledgers' state back once.
    pi.on("session_compact", () => {
      if (!isDelegatingMode(state.effective)) return;
      const summary = workers?.ledgerSummary();
      if (summary) pi.sendMessage({ customType: LEDGER_SUMMARY_TYPE, content: summary, display: false }, { triggerTurn: false });
    });
    // Second line of defence next to the tool set: `--tools`, another extension or the model can still reach a disabled tool.
    // Then, for a Bash call that passed it, the Bash safety review (bash-review.ts): main's own bash, codemode's nested bash
    // calls included (each its own tool_call). Worker and sub-worker sessions have their own guards and review (workers.ts, sub-worker.ts).
    pi.on("tool_call", async (event, ctx) => {
      const reason = guardToolCall(state.effective, event.toolName, event.input as Record<string, unknown>) ?? busyGuard(event.toolName);
      if (reason) return { block: true, reason };
      const review = await guardBashReview(event.toolName, event.input as Record<string, unknown>, {
        settings: bashReview, access: () => registryAccess(ctx.modelRegistry), cwd: ctx.cwd, task: lastUserText(ctx), signal: ctx.signal,
      });
      return review ? { block: true, reason: review } : undefined;
    });
    /**
     * The read-only window (mode.ts guardBusyToolCall): while a background job runs, or the task the user approved waits for it, main
     * of a delegating mode only reads. Checked per call, so it ends with the job (and the queued task's start). Direct mode keeps its own
     * meaning: the user chose to edit directly there.
     */
    const busyGuard = (toolName: string): string | undefined => {
      if (!isDelegatingMode(state.effective)) return undefined;
      const busy = jobs?.running?.id ?? jobs?.queued?.id;
      if (!busy) return undefined;
      let info: Parameters<typeof guardBusyToolCall>[2];
      try { info = pi.getAllTools().find(tool => tool.name === toolName); } catch { /* unknown: blocked unless allowlisted */ }
      return guardBusyToolCall(toolName, busy, info);
    };
    /** A refusal of orche_task's approval gate: nothing was delegated and the running job is untouched. */
    const notDelegated = (text: string, details: Record<string, unknown>, isError = false): JobToolResult => ({
      content: [{ type: "text", text }], details: { approval: "not-approved", ...details }, ...(isError ? { isError: true } : {}),
    });
    /** The dialog text: what runs now (and keeps running), what exactly is requested, and what approving does and does not mean. */
    const approvalTitle = (running: Job, task: QueuedTask, args: QueueArgs, timeoutMs: number): string => {
      const p = args as unknown as Record<string, unknown>;
      const list = (value: unknown) => Array.isArray(value) && value.length ? value.map(String).join(", ") : undefined;
      const git = p.git && typeof p.git === "object" ? Object.entries(p.git as Record<string, unknown>).filter(([, value]) => value !== undefined && value !== false).map(([key, value]) => value === true ? key : `${key} ${String(value)}`).join(", ") : undefined;
      const scope = [
        `role ${task.role}`,
        typeof p.worker === "string" ? `reuses worker ${p.worker}` : "new worker",
        ...(typeof p.task === "string" ? [`task ${p.task}`] : []),
        ...(list(p.files) ? [`files: ${list(p.files)}`] : []),
        ...(list(p.writeRoots) ? [`also writes outside the workspace: ${list(p.writeRoots)}`] : []),
        ...(git ? [`git: ${git}`] : []),
        ...(p.gui === true ? ["GUI desktop"] : []),
      ].join(" · ");
      const request = String(p.request ?? "").trim();
      return [
        `orche: approve one more delegation while ${running.id} runs?`,
        "",
        `Running now: ${running.id} · ${running.worker ?? "?"} ${running.role} · ${running.request}`,
        `It keeps running: approving does not cancel, pause or replace it.`,
        "",
        `Requested (${task.id}): ${scope}`,
        request.length > 700 ? `${request.slice(0, 700)}…` : request,
        "",
        `Approve: this one request is queued and starts as its own background job only after ${running.id} has finished successfully (done). It never runs at the same time as ${running.id}. It is dropped, not started, if ${running.id} fails, is cancelled or interrupted, if delegation is switched off (direct mode) or the session ends first.`,
        `Decline, Esc or no answer within ${formatDuration(timeoutMs)}: nothing is delegated.`,
      ].join("\n");
    };
    /**
     * orche_task while a background job runs (or an approved task already waits for it): the user approves in Pi's own dialog
     * (`ctx.ui.select`, TUI and RPC) or nothing is delegated. Only the user's choice of {@link APPROVE_QUEUED} approves; a decline,
     * Esc, a timeout, a failed dialog, no UI, a session or mode change while asking all refuse. Approved while the job still runs:
     * the call's arguments, as shown, wait for it (jobs.ts queue) and this returns at once. Approved after the job ended done in the
     * meantime: undefined, the call proceeds as an ordinary orche_task. Returns the tool result of the call otherwise.
     */
    const approveWhileBusy = async (tasks: TaskJobs, args: QueueArgs, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<JobToolResult | undefined> => {
      const running = tasks.running;
      const waiting = tasks.queued;
      const keeps = running ? `${running.id} keeps running; nothing was cancelled or replaced.` : "";
      if (waiting) return notDelegated(`Not delegated: ${waiting.id} (${waiting.role}: ${waiting.request}) ${waiting.state === "asking" ? "is waiting for the user's approval" : waiting.state === "queued" ? `already waits for ${waiting.after}` : "is starting"}, and at most one approved task waits for the running job. ${keeps} Tell the user; they can ask again once it has started.`, { reason: "slot-taken", queued: waiting.id });
      if (!running) return undefined;
      if (!ctx.hasUI) return notDelegated(`Not delegated: ${running.id} is still running, and delegating another task meanwhile needs the user's approval in a dialog, which this session cannot show (no UI). ${keeps} Tell the user; they can ask again once ${running.id} has ended.`, { reason: "no-ui", job: running.id });
      const reserved = tasks.reserve(running, args);
      if (typeof reserved === "string") return notDelegated(`Not delegated: ${reserved}. ${keeps}`, { reason: "unavailable", job: running.id });
      const timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
      let answer: string | undefined;
      let failure: string | undefined;
      try {
        answer = await ctx.ui.select(approvalTitle(running, reserved, args, timeoutMs), [APPROVE_QUEUED, DECLINE_QUEUED], { ...(signal ? { signal } : {}), timeout: timeoutMs });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      // Checked after the dialog: a late answer to a dialog whose turn, session or mode is gone approves nothing.
      const refusal: [reason: string, text: string] | undefined = failure !== undefined ? ["dialog-error", `the approval dialog failed (${failure})`]
        : signal?.aborted ? ["aborted", "the turn was interrupted (Esc) while the user was asked"]
        : jobs !== tasks ? ["session-changed", "the session changed while the user was asked"]
        : !isDelegatingMode(state.effective) ? ["mode-changed", `delegation was switched off (orche mode ${state.effective}) while the user was asked`]
        : answer === APPROVE_QUEUED ? undefined
        : answer === DECLINE_QUEUED ? ["declined", "the user declined"]
        : ["no-answer", "the user did not answer (dismissed or timed out)"];
      if (refusal) {
        tasks.withdraw(reserved.id);
        return notDelegated(`Not delegated: ${refusal[1]}. ${keeps} Do not call orche_task for this request again unless the user asks; answer what you can by reading, or tell them they can ask again once ${running.id} has ended.`, { reason: refusal[0], job: running.id }, refusal[0] === "dialog-error");
      }
      const approved = tasks.approve(reserved.id);
      if ("queued" in approved) {
        const id = approved.queued.id;
        try { ctx.ui.notify(`orche: ${id} approved: it starts after ${running.id} has finished (done); ${running.id} keeps running.`, "info"); } catch { /* no UI */ }
        return {
          content: [{ type: "text", text: `Queued ${id} with the user's approval in the dialog: it starts as its own background job only after ${running.id} has ended done, never next to it; if ${running.id} fails or is cancelled it is dropped (the result of ${running.id} says which), and its own result arrives later as an orche-task-result message. ${keeps} Tell the user it is queued; then, if ${running.id} is still running and nothing else is waiting for you, call orche_task_attach {"job":"${running.id}"} to wait for it.` }],
          details: { approval: "approved", queued: id, after: running.id },
        };
      }
      if ("ended" in approved) {
        // The job ended while the user was asked: done, the approved request starts now as an ordinary orche_task (this call).
        if (approved.ended.status === "done") return undefined;
        return notDelegated(`Not delegated: ${running.id} ended ${approved.ended.status} while the user was asked, and the approval covered running it only after ${running.id} completed. Tell the user; delegate it again only when they ask.`, { reason: "job-ended", job: running.id, status: approved.ended.status });
      }
      return notDelegated("Not delegated: the session changed while the user was asked.", { reason: "session-changed" });
    };
    /**
     * Main's control of the running worker asks the user first, in Pi's own dialog: a message into its session (orche_task_message)
     * could carry a new task past orche_task's approval and the run-after-the-job order, and cancelling (orche_task_status cancel)
     * could replace it. Whether a message only refines the running task cannot be told reliably from its text, so every message is
     * confirmed. Only the exact confirm option chosen by the user proceeds; decline, Esc, timeout, a failing dialog, no UI, or the job,
     * session or mode changing meanwhile return the refusal (nothing sent, nothing cancelled). Undefined: confirmed, go ahead.
     * The user's own /orche cancel and Esc/detach need no dialog.
     */
    const confirmWorkerControl = async (tasks: TaskJobs, job: Job, kind: "message" | "cancel", ctx: ExtensionContext, signal: AbortSignal | undefined, message = ""): Promise<JobToolResult | undefined> => {
      const what = kind === "message" ? "Not sent" : "Not cancelled";
      const after = () => job.status !== "running"
        ? `${job.id} ended ${job.status} meanwhile; nothing else was ${kind === "message" ? "sent to" : "cancelled"}, and this confirmation is not reused for another job. Do not try again unless the user asks.`
        : kind === "message"
          ? `${job.id} keeps running with its task unchanged. If this is a new task, delegate it with orche_task (it asks the user to queue it after ${job.id}); do not send it again unless the user asks.`
          : `${job.id} keeps running. Do not try again unless the user asks; they can stop it with /orche cancel.`;
      const refuse = (reason: string, text: string, isError = false): JobToolResult => ({
        content: [{ type: "text", text: `${what}: ${text}. ${after()}` }], details: { approval: "not-approved", reason, job: job.id, control: kind }, ...(isError ? { isError: true } : {}),
      });
      if (!ctx.hasUI) return refuse("no-ui", `${kind === "message" ? "a message to the running worker" : "cancelling the running job"} needs the user's confirmation in a dialog, which this session cannot show (no UI)`);
      // The user confirms the whole message they would send: one too long to read in a dialog is not sent this way.
      if (kind === "message" && message.length > MESSAGE_CONFIRM_MAX) return refuse("too-long", `the message has ${message.length} characters, more than the ${MESSAGE_CONFIRM_MAX} the user can confirm in full in a dialog; send a shorter correction, or deliver longer work as a follow-up orche_task after ${job.id}`);
      const timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
      const running = `Running: ${job.id} · ${job.worker ?? "?"} ${job.role} · ${job.request}`;
      const title = kind === "message" ? [
        `orche: send this to the worker of ${job.id}?`,
        "",
        running,
        "",
        "Message, in full (it is added to that worker's CURRENT task, mid-run):",
        message,
        "",
        `Send only if it adds to or corrects ${job.id}'s own task. Sending does not approve a new task: a new task does not belong here; it is delegated with orche_task, which asks you to queue it after ${job.id} has finished. The message grants no permissions.`,
        `Do not send, Esc or no answer within ${formatDuration(timeoutMs)}: nothing is sent.`,
      ].join("\n") : [
        `orche: cancel ${job.id}?`,
        "",
        running,
        "",
        `Cancelling stops the worker now; its partial work stays in the workspace and its cancelled result is delivered once.${tasks.queued ? ` The task approved to run after it (${tasks.queued.id}) is dropped.` : ""}`,
        `Keep it running, Esc or no answer within ${formatDuration(timeoutMs)}: nothing is cancelled.`,
      ].join("\n");
      const [yes, no] = kind === "message" ? [CONFIRM_MESSAGE, DECLINE_MESSAGE] : [CONFIRM_CANCEL, DECLINE_CANCEL];
      let answer: string | undefined;
      try {
        answer = await ctx.ui.select(title, [yes, no], { ...(signal ? { signal } : {}), timeout: timeoutMs });
      } catch (error) {
        return refuse("dialog-error", `the confirmation dialog failed (${error instanceof Error ? error.message : String(error)})`, true);
      }
      if (signal?.aborted) return refuse("aborted", "the turn was interrupted (Esc) while the user was asked");
      if (jobs !== tasks) return refuse("session-changed", "the session changed while the user was asked");
      if (!isDelegatingMode(state.effective)) return refuse("mode-changed", `delegation was switched off (orche mode ${state.effective}) while the user was asked`);
      if (answer === no) return refuse("declined", "the user declined");
      if (answer !== yes) return refuse("no-answer", "the user did not answer (dismissed or timed out)");
      // Confirmed for this job only: when it ended meanwhile (another job may run now), nothing is sent or cancelled.
      if (job.status !== "running" || tasks.running !== job) return refuse("job-ended", `${job.id} is no longer running`);
      return undefined;
    };
    // A steer for main detaches an attached call (the job keeps running); a follow-up stays queued in Pi until the run has nothing
    // else to do, i.e. after the attached call returned the result. The widget's last end line goes with the next user input.
    pi.on("input", (event, ctx) => {
      if (endedShown && !jobs?.running) { endedShown = undefined; paintJob(); }
      if (event.streamingBehavior) lastQueuedInput = Date.now();
      if (event.streamingBehavior === "followUp") {
        // Another request: during a one-shot run it waits for that run to end and then runs as its own, in the session's mode.
        if (oneShot) {
          heldBack.push({ kind: "input", text: event.text, ...(event.images?.length ? { images: event.images } : {}) });
          ctx.ui.notify(`orche: queued until the one-shot /orche ${oneShot.mode} request has ended; it then runs as its own turn in the session's mode (${state.session}).`, "info");
          return { action: "handled" as const };
        }
        queued.followUp++;
        return undefined;
      }
      if (event.streamingBehavior === "steer") queued.steer++;
      if (jobs?.attached) detachOnInput(ctx);
      return undefined;
    });
    // pi-session-bus announces each note Pi accepted (after its steer is queued). A woken note detaches and counts as waiting for
    // main until Pi delivers it into the context; a suppressed one (wake off, hop or rate limit) neither wakes nor detaches, and
    // neither does one routed to the running worker (below): main only gets its copy.
    pi.events.on(SESSION_BUS_MESSAGE_EVENT, data => {
      const note = (typeof data === "object" && data !== null ? data : {}) as { id?: unknown; wake?: unknown; routed?: unknown };
      if (note.wake === "suppressed" || note.routed) return;
      if (typeof note.id === "string" && routedNotes.has(note.id)) return;
      if (typeof note.id === "string") pendingNotes.set(note.id, Date.now());
      jobs?.detach("session-bus");
    });
    /**
     * A note another Pi session sent goes straight to the running worker (peer-notes.ts): pi-session-bus offers it here before it
     * reaches main, and orche claims it once the worker accepted it. No dialog: orche_task_message's confirmation is for what main
     * adds to the running task, and the peer, not main, wrote this; the worker gets it framed as untrusted peer input that grants
     * nothing. Only in a delegating mode (where main is read-only meanwhile), only to the job running now; without one, or when its
     * worker refuses (reported, stopping), the claim is not made and the bus delivers the note to main as before.
     */
    pi.events.on(SESSION_BUS_ROUTE_EVENT, data => {
      const request = parseRouteRequest(data);
      if (!request || !jobs || !isDelegatingMode(state.effective)) return;
      const known = routedNotes.get(request.note.id);
      if (known) { request.claim(known); return; } // the same note again: it is already there, never twice
      // A note too long to read as one worker message stays with main, like an orche_task_message over its limit.
      if (request.note.content.length > PEER_NOTE_MAX) return;
      const routed = jobs.routePeerNote(request.note);
      if (!routed || "rejected" in routed) return;
      const route = { to: `the running worker ${routed.worker} of orche job ${routed.job.id}`, ref: routed.id };
      routedNotes.set(request.note.id, route);
      if (routedNotes.size > ROUTED_NOTES_KEPT) routedNotes.delete(routedNotes.keys().next().value!);
      request.claim(route);
      try { lastUi?.notify(`orche: a session-bus note from ${peerLabel(request.note)} went straight to ${routed.worker} (${routed.job.id}) as ${routed.id}; main has a copy and was not woken.`, "info"); } catch { /* the UI may be gone */ }
    });
    pi.on("message_start", (event, ctx) => {
      const message = event.message as { role?: string; customType?: string; details?: { job?: unknown } };
      if (message.role === "assistant" && oneShot) oneShot.answering = true;
      longResponse.messageStart(event.message as Parameters<LongResponseWatch["messageStart"]>[0]);
      // A message main did not ask for that arrives in a one-shot run once main answers (the prompt's own context came before) and is
      // not part of the request: a peer note, another extension's message. Not attributable, so the request's mode ends here.
      if (message.role === "custom" && oneShot?.answering) {
        const own = message.customType === LEDGER_SUMMARY_TYPE
          || (message.customType === TASK_RESULT_TYPE && typeof message.details?.job === "string" && oneShot.jobs.has(message.details.job));
        if (!own) {
          const mode = oneShot.mode;
          endOneShot(ctx.ui);
          ctx.ui.notify(`orche: a message from outside the one-shot /orche ${mode} request arrived (${message.customType ?? "custom"}); the rest of this run follows the session's mode (${state.session}).`, "info");
        }
      }
      // Pi takes a queued user prompt out of its queue as it delivers it, steers first.
      if (message.role !== "user") return undefined;
      if (queued.steer > 0) queued.steer--; else if (queued.followUp > 0) queued.followUp--;
      return undefined;
    });
    pi.on("message_end", event => {
      const message = event.message as { role?: string; customType?: string; details?: { note?: { id?: unknown } } };
      if (message.role === "custom" && message.customType === SESSION_BUS_MESSAGE_TYPE && typeof message.details?.note?.id === "string") pendingNotes.delete(message.details.note.id);
      longResponse.messageEnd(event.message as Parameters<LongResponseWatch["messageEnd"]>[0]);
      return undefined;
    });
    // A run that ended has taken every steered message (or Esc dropped them): nothing it queued is still waiting.
    pi.on("agent_end", () => { pendingNotes.clear(); });
    // A settled session runs no queued continuation: no user prompt is still queued (Esc returned them to the editor).
    // A one-shot request ends with its run; what it held back runs next, each as its own run (Pi starts them after this event).
    pi.on("agent_settled", (event, ctx) => {
      resetQueued();
      // Not at agent_end: Pi's auto-retry starts after it, and the note must reach that retry.
      longResponse.settled(event.aborted);
      if (!oneShot && !heldBack.length) return;
      endOneShot(ctx.ui);
      releaseHeldBack(ctx.ui, event.aborted);
    });
    pi.registerMessageRenderer(TASK_RESULT_TYPE, renderJobResultMessage);
    pi.on("session_shutdown", async () => {
      // Running background jobs end as interrupted (entry + run record), never silently left "running"; an attached call returns.
      jobs?.dispose();
      longResponse.reset();
      stopWidgetTimer();
      if (widgetText !== undefined) { widgetText = undefined; try { lastUi?.setWidget(JOB_WIDGET_KEY, undefined); } catch { /* the UI may be gone */ } }
      endedShown = undefined;
      pendingNotes.clear();
      resetQueued();
      oneShot = undefined;
      heldBack.length = 0;
      jobs = undefined;
      controller.cancel();
      await workers?.dispose();
      workers = undefined;
    });

    // (2) Delegation, one-turn overrides and worker/session controls.
    pi.registerCommand("orche", {
      description: "/orche single <prompt>: delegate one request to one worker. /orche strong <prompt>: the same on the strong tiers (models.strong-orchestrator, models.strong-worker). /orche ultra <prompt>: one request with quality-first ultra orchestration on the strong tiers. /orche mdsd <prompt>: one request with the MDSD search policy (diversified exploration paths, integration, adaptive search, verification; docs/mdsd.md) on the strong tiers. /orche direct <prompt>: edit directly for one turn. These one-shot commands leave the session's mode as it is and start only when the session is idle; with task ledgers (single.ledger) a task started by such a request keeps its mode when continued, otherwise later turns run in the session's mode. /orche mode [single|strong|ultra|mdsd|direct]: show/set the session's delegation mode. /orche workers: list workers. /orche stop <id>|all: dispose workers. /orche records: list this session's recent task records (transcripts and manifests of orche tasks). /orche splits [days]: the orchestrator's split decisions over all sessions (split rate, criteria, cost and time), optionally of the last N days. /orche models: the main, orchestrator, worker, advisor, strong-orchestrator and strong-worker models now and where each comes from (config, inherited, Pi), and whether the advisor (single.advisor) is on. /orche cancel: stop the active task. /orche detach: stop waiting for the background task (it keeps running; its result arrives as a message). /orche doctor: check pi-orche's dependencies (npm packages and native bindings, Node.js, git, orche.config.json, configured models) and say what to do when something is wrong. /orche install-deps: install missing npm dependencies; lists what needs a manual step.",
      // Read-only: the current roster supplies `stop <id>`; completion never creates, starts or stops workers.
      getArgumentCompletions: prefix => {
        let ids: string[] = [];
        try { ids = workers?.list().map(worker => worker.id) ?? []; } catch { /* no live pool: static candidates only */ }
        return completeOrcheArguments(prefix, ids);
      },
      handler: async (args, ctx: ExtensionCommandContext) => {
        const parsed = parseOrcheCommand(args);
        if (!parsed) {
          // `/orche ultra` without a prompt: the one-shot usage (nothing starts, the mode stays); anything else: the full usage.
          ctx.ui.notify(oneShotUsage(args) ?? ORCHE_USAGE, "warning");
          return;
        }
        if (parsed.mode === "doctor" || parsed.mode === "install-deps") {
          await runDependencyCommand(dependencies, parsed.mode === "doctor" ? "check" : "install", ctx);
          return;
        }
        if (parsed.mode === "cancel") {
          if (!controller.cancel()) {
            ctx.ui.notify("no active orche task", "info");
            return;
          }
          await controller.whenIdle();
          ctx.ui.notify("orche task cancelled", "info");
          return;
        }
        if (parsed.mode === "detach") {
          const attached = jobs?.attached;
          if (!attached || !jobs?.detach("command")) {
            const running = jobs?.running;
            ctx.ui.notify(running ? `orche ${running.id} is already detached; its result arrives as a message` : "no attached orche task", "info");
            return;
          }
          ctx.ui.notify(`orche ${attached.id} detached: it keeps running and its result arrives as a message (/orche cancel stops it)`, "info");
          return;
        }
        if (parsed.mode === "workers") {
          ctx.ui.notify(workers?.formatWorkers() ?? "no workers", "info");
          return;
        }
        if (parsed.mode === "records") {
          // The records of the calling session, newest first: where each run's transcripts and run.json are.
          const resolved = await controller.recordsFor({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), ...(ctx.model ? { model: ctx.model } : {}), thinking: ctx.thinkingLevel ?? pi.getThinkingLevel() });
          if (!resolved.enabled) {
            ctx.ui.notify(`orche records are off: ${resolved.reason}`, "info");
            return;
          }
          const sessionId = ctx.sessionManager.getSessionId() || undefined;
          const list = await listRecords(resolved, { ...(sessionId ? { parentSessionId: sessionId } : {}), limit: 10 });
          ctx.ui.notify(list.length ? `orche records (${resolved.root}):\n${formatRecordList(list)}` : formatRecordList(list), "info");
          return;
        }
        if (parsed.mode === "models") {
          // The model tiers now and where each comes from (docs/orchestrator.md 12), with the advisor's on/off state (13).
          const found = await discoverConfiguredMainMode({ cwd: ctx.cwd, agentDir: options.agentDir ?? getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
          ctx.ui.notify(formatModelTiers({ main: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(), ...(thinkingFloor ? { thinkingFloor } : {}), mode: state.effective, ...(found.path ? { path: found.path } : {}), ...(found.error ? { error: found.error } : {}), ...(found.models ? { tiers: found.models } : {}), advisor: found.advisor ?? DEFAULT_SINGLE.advisor, atStart: mainModel }), "info");
          return;
        }
        if (parsed.mode === "splits") {
          // The split log of every session (it outlives the 30-day records): split rate, criteria, cost and time by decision.
          const resolved = await controller.recordsFor({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), ...(ctx.model ? { model: ctx.model } : {}), thinking: ctx.thinkingLevel ?? pi.getThinkingLevel() });
          if (!resolved.enabled) {
            ctx.ui.notify(`orche records are off, so there is no split log: ${resolved.reason}`, "info");
            return;
          }
          const since = parsed.days !== undefined ? Date.now() - parsed.days * 86_400_000 : undefined;
          ctx.ui.notify(formatSplitSummary(summarizeSplits(await readSplitLog(resolved.root), since), resolved.root), "info");
          return;
        }
        if (parsed.mode === "stop") {
          ctx.ui.notify(workers ? await workers.stop(parsed.worker) : parsed.worker === "all" ? "no workers" : `unknown worker ${parsed.worker}`, "info");
          return;
        }
        if (parsed.mode === "mode") {
          if (parsed.value) {
            state.choose(parsed.value);
            showMode(ctx);
            ctx.ui.notify(`orche mode: ${parsed.value} (saved in this session)`, "info");
            return;
          }
          const { source, path } = state.source;
          ctx.ui.notify(`orche mode: ${state.session} (${source === "config" ? `config ${path ?? ""}`.trim() : source === "session" ? "set with /orche mode in this session" : "default"})`, "info");
          return;
        }
        {
          // A one-shot request starts only from an idle session (its own run, in its mode); while busy it is refused, never queued as an
          // ordinary prompt that would lose its mode (busyRefusal).
          if (!ctx.isIdle() || oneShot) {
            ctx.ui.notify(busyRefusal(parsed.mode, state.session), "warning");
            return;
          }
          const request = { mode: parsed.mode, jobs: new Set<string>(), answering: false };
          oneShot = request;
          state.setOverride(parsed.mode);
          showMode(ctx);
          // Keep the command pending until the turn it started has settled: one-shot modes (--print / --mode json)
          // exit as soon as the command returns, which would cut the turn off. sendUserMessage is fire-and-forget,
          // so observe the run's own start/settle events.
          let begun = false;
          const started = Promise.withResolvers<void>();
          const settled = Promise.withResolvers<void>();
          const unsubscribe = [
            pi.on("agent_start", () => { begun = true; started.resolve(); }),
            pi.on("agent_settled", () => settled.resolve()),
          ];
          const startTimer = setTimeout(() => started.resolve(), SINGLE_START_TIMEOUT_MS);
          try {
            pi.sendUserMessage(parsed.prompt);
            await started.promise;
            if (begun) await settled.promise;
            else ctx.ui.notify(`orche ${parsed.mode}: the session did not start a turn for the prompt.`, "warning");
          } finally {
            clearTimeout(startTimer);
            for (const off of unsubscribe) off();
            // Its run's agent_settled ended it already; a prompt that started no run (or one the override ended) ends it here.
            if (oneShot === request) endOneShot(ctx.ui);
          }
          return;
        }
      },
    });

    pi.registerTool({
      name: "orche_task",
      label: "orche task",
      description: `Delegate one self-contained request to one persistent worker. In an interactive or RPC session the task runs as a background job (J1, …) and this call stays ATTACHED to it: it waits like a blocking call, shows the worker's progress and returns the result, unless a user message steered into the turn, a message from another Pi session that orche did not route straight to the running worker, Esc or /orche detach DETACHES it first; a queued follow-up message does not detach it and reaches you after the result. Then it returns at once with the job id, the worker keeps running, and the result arrives later as one orche-task-result message unless you attach again with orche_task_attach. wait:false returns as soon as the worker has its assignment (detached); wait:true, and print/JSON modes, block until the result and cannot detach (aborting cancels). Pass references, not copies: repository paths with line ranges/symbols, reproduction commands, artifact/run-record paths. Paste only short decisive irreproducible snippets (exact errors or user text); never whole files, diffs or long logs. Choose explore, answer, implement, verify, game-asset (create/modify game art, audio and model assets) or video (produce/edit video); pass worker to reuse a live worker with its retained context and original model. Implement, game-asset and video may write within files (or the workspace when omitted); other roles are read-only. Workers never git commit or push unless this assignment carries \`git\` ({commit, push, remote, branch}; implement, game-asset and video only): set it only when the user explicitly asked in this conversation to commit or push, and scope the commit to the task's files where possible. Only one task can be active: while a job runs, this call first asks the user in a Pi dialog to approve queueing this request after that job (it then starts only once that job has ended done, never next to it or in its place; declined, dismissed or unanswered, nothing is delegated), and you cannot approve it yourself. Time budget: ${timeBudget()} an idle worker times out at the base deadline, and the result says why a timeout was not extended.`,
      promptSnippet: "orche_task: one reusable worker for explore, answer, implement, verify, game-asset (game art/audio/model assets) or video (production/editing)",
      promptGuidelines: [
        "orche_task workers never git commit or push on their own. Pass `git` ({commit:true} or {push:true, remote?, branch?}) only when the user explicitly asked in this conversation to commit or push; never on your own initiative. Only implement, game-asset and video accept it; explore, answer and verify reject it.",
        "The `git` grant covers that one assignment only: a reused worker's next assignment without it may not commit. Scope the commit to the task's files where possible (pass `files`, name the paths in `request`), and check the commits listed in the result before reporting.",
        "Pass `gui: true` only when the task needs GUI applications (needs pi-gui): the worker then gets its own private desktop that the user does not see, separate from yours and from other workers'. Omit it otherwise.",
        "Workers do not share your tools or their state: none of your browser_* session tools, tabs, profiles or logins reach them. With pi-browser installed every worker gets its own stateless browser_fetch for public web pages (the result says when it is unavailable, e.g. obscura not installed). A task that needs a rendered, interactive web page (tabs, clicks, forms, sign-in) needs `gui: true` with a writing role (implement): the worker browses in its private desktop with a fresh browser profile, not the user's. With `gui: true`, read-only roles (explore, answer, verify) get an observe-only desktop: no clicks, typing or form input.",
        "In interactive/RPC sessions orche_task stays attached to its job (J1, …) and returns the result like a blocking call. When it returns DETACHED (a steered user message or a peer-session message arrived), answer that input first; then, if the job is still running and nothing else is waiting for you, call orche_task_attach to wait for it again. Queued follow-up messages never detach and do not count as waiting: Pi delivers them after the result, when the turn has nothing else to do. Never wait with sleep, never poll orche_task_status (only when the user asks for progress or wants to cancel). Use orche_task_message to add instructions to the running worker.",
        "While a background job runs, answer questions that need only reading yourself (read, grep, find, ls, ast_search; other tools are blocked until it ends) and never cancel, replace or re-delegate the running worker for a question. Delegate only what needs a worker: orche_task then asks the user to approve queueing it after the running job; only the user's answer in that dialog approves it.",
        "Every worker has a private scratch directory for temporary files. Pass `writeRoots` (implement/game-asset/video) only when the user explicitly asked to change a location outside the workspace, such as a sibling repository; it applies to that assignment only.",
        "An implement/answer orchestrator may run at most 2 fresh-verifier rounds; further rounds are refused and the result lists the remaining findings (data.unresolved, a `Verification cap:` line). Pass `verificationRounds` (up to 5) only when the user explicitly asked for more independent review rounds.",
      ],
      parameters: orcheTaskParameters,
      ...orcheTaskRenderers,
      executionMode: "sequential",
      execute: async (_id, params, signal, onUpdate, ctx) => {
        lastUi = ctx.ui;
        lastMode = ctx.mode;
        const base = {
          ...params,
          mainMode: state.effective,
          // A one-shot `/orche <mode> <prompt>` run: the assignment runs in that request's mode (with task ledgers its task keeps it).
          ...(state.overriding ? { oneShot: { session: state.session } } : {}),
          cwd: ctx.cwd,
          model: ctx.model,
          ...(options.inheritProviders !== false ? { modelRegistry: ctx.modelRegistry } : {}),
          ...handOffThinking(),
          projectTrusted: ctx.isProjectTrusted(),
          currentSession: currentSession(ctx),
        };
        // While a background job runs (or an approved task waits for it), a new delegation needs the user's explicit approval in Pi's
        // own dialog, for the blocking path (wait:true) too: approved, it waits for the running job (jobs.ts queue), never runs next to it.
        if (jobs?.running || jobs?.queued) {
          const gated = await approveWhileBusy(jobs, { ...base, ...structuredClone(params) }, ctx, signal);
          if (gated) return gated as never;
        }
        // Background job (jobs.ts) in sessions that keep running after the turn: interactive and RPC. The call stays attached to
        // it (like a blocking call) until the job ends or something detaches it; wait:false detaches at once. Print/JSON modes exit
        // when the turn ends, so they (and an explicit wait:true) keep the blocking call.
        if (params.wait !== true && (ctx.mode === "tui" || ctx.mode === "rpc")) {
          let started = false;
          // The one-shot request this call belongs to: its job's result may enter its run (and continue it), unlike other jobs'.
          const request = oneShot;
          const tasks = taskJobs();
          endedShown = undefined;
          const { job, outcome } = await tasks.start({
            ...base,
            // Startup progress until the worker has its assignment; from then on the attached call's updates (jobUpdate).
            onTiming: (timing, lines) => { if (!started) onUpdate?.(partialUpdate(lines, timing)); },
            onProgress: (lines, timing) => { if (!started) onUpdate?.(partialUpdate(lines, timing)); },
          }, signal, params.wait === false ? undefined : attachOptions(signal, ctx, onUpdate));
          started = true;
          request?.jobs.add(job.id);
          // A steer or woken peer note that arrived while the worker started is answered first; a queued follow-up waits for the result.
          if (outcome && tasks.attached === job && inputWaiting(ctx)) tasks.detach("input");
          if (outcome) onUpdate?.(jobUpdate(job));
          return attachResult(outcome ? await outcome : { kind: "detached", job, reason: "background" }, "orche_task") as never;
        }
        // A task whose worker ran and failed, timed out or was cancelled comes back as an isError result that keeps its
        // details; argument validation and errors before a worker ran still throw (see WorkerPool.executeTool).
        return pool().executeTool({
          ...params,
          mainMode: state.effective,
          // A one-shot `/orche <mode> <prompt>` run: the assignment runs in that request's mode (with task ledgers its task keeps it).
          ...(state.overriding ? { oneShot: { session: state.session } } : {}),
          cwd: ctx.cwd,
          model: ctx.model,
          ...(options.inheritProviders !== false ? { modelRegistry: ctx.modelRegistry } : {}),
          ...handOffThinking(),
          projectTrusted: ctx.isProjectTrusted(),
          signal,
          currentSession: currentSession(ctx),
          onTiming: (timing, lines) => onUpdate?.(partialUpdate(lines, timing)),
          onProgress: (lines, timing) => {
            ctx.ui.setStatus("orche", lines.at(-1));
            onUpdate?.(partialUpdate(lines, timing));
          },
        });
      },
    });

    pi.registerTool({
      name: "orche_task_status",
      label: "orche task status",
      description: "Status of a background orche_task job (the running one, or the one named): worker, elapsed time, attached or detached, latest progress and liveness, or the result summary when it ended, and the task the user approved to run after it (Q1, …), if any. Never waits; do not poll it: to wait for the result use orche_task_attach. Use it when the user asks about progress, or with cancel:true to stop the job (only when the user asks; the user confirms it in a dialog first, nothing is cancelled otherwise; its cancelled result is delivered once; a task queued after it is then dropped), or with a queued task's id (Q1, …) and cancel:true to drop that task before it starts (only when the user asks).",
      promptSnippet: "orche_task_status: progress of the background orche_task job, or cancel it",
      parameters: Type.Object({
        job: Type.Optional(Type.String({ pattern: "^[JQ][1-9][0-9]*$", description: "Job id from orche_task (J1, …) or an approved queued task (Q1, …); default: the running or latest job." })),
        cancel: Type.Optional(Type.Boolean({ description: "true: cancel the job (or drop the queued task)." })),
      }),
      execute: async (_id, params, signal, _onUpdate, ctx) => {
        const tasks = taskJobs();
        if (params.job?.startsWith("Q")) {
          const queued = tasks.queued;
          if (params.cancel === true) return { content: [{ type: "text", text: tasks.cancelQueued(params.job) }], details: { job: params.job, cancel: true } };
          const text = queued?.id === params.job
            ? `${queued.id} ${queued.state} · ${queued.role}${queued.worker ? ` · worker ${queued.worker}` : ""} · ${queued.state === "asking" ? "the user is being asked to approve it" : queued.state === "queued" ? `approved by the user; starts after ${queued.after} has ended done, dropped if it fails or is cancelled` : "starting now"}\nRequest: ${queued.request}`
            : `No queued task ${params.job} (a queued task that started is a job now: see the latest job).`;
          return { content: [{ type: "text", text }], details: { job: params.job, cancel: false } };
        }
        if (params.cancel === true) {
          // Cancelling the running job asks the user first (one dialog), so that main cannot replace the running task by itself.
          const target = params.job ? tasks.get(params.job) : tasks.running;
          if (target?.status === "running") {
            const refused = await confirmWorkerControl(tasks, target, "cancel", ctx, signal);
            if (refused) return refused as never;
          }
          // The confirmed job by id: never another job that started meanwhile.
          return { content: [{ type: "text", text: await tasks.cancel(target?.id ?? params.job) }], details: { job: target?.id ?? params.job, cancel: true } };
        }
        const text = tasks.status(params.job, worker => workers?.workerLiveness(worker)?.detail);
        return { content: [{ type: "text", text }], details: { job: params.job, cancel: false } };
      },
    });

    pi.registerTool({
      name: "orche_task_attach",
      label: "orche task attach",
      description: "Attach to the running background orche_task job (the one named, else the running one) and wait for its result like a blocking orche_task: the call shows the worker's progress and returns the result when the job ends. A user message steered into the turn, a woken message from another Pi session (not one orche routed straight to the running worker), Esc or /orche detach DETACH it: it then returns at once, the worker keeps running, and the result arrives as one orche-task-result message unless you attach again. Call it after you answered the input that detached the job, when the job is still running and nothing else waits for you; it refuses while a steered message or a woken peer note is waiting; queued follow-up messages do not count (they wait for the result). Attaching never restarts or cancels the worker.",
      promptSnippet: "orche_task_attach: wait again for the running orche_task job (detaches on steered input, not on follow-ups)",
      parameters: Type.Object({
        job: Type.Optional(Type.String({ pattern: "^J[1-9][0-9]*$", description: "Job id from orche_task (J1, …); default: the running job." })),
      }),
      ...createOrcheRenderers("orche_task_attach"),
      executionMode: "sequential",
      execute: async (_id, params, signal, onUpdate, ctx) => {
        lastUi = ctx.ui;
        lastMode = ctx.mode;
        const tasks = taskJobs();
        const job = params.job ? tasks.get(params.job) : tasks.running;
        if (job?.status === "running") onUpdate?.(jobUpdate(job));
        const outcome = await tasks.attach(params.job, attachOptions(signal, ctx, onUpdate));
        return attachResult(outcome, "orche_task_attach") as never;
      },
    });

    pi.registerTool({
      name: "orche_task_message",
      label: "orche task message",
      description: "Send an additional or corrected instruction for the running worker's OWN task (the background orche_task job). The user confirms each message in a dialog first: a new task must not be slipped into the running worker; it goes to orche_task, which asks to queue it after the running job. Declined, dismissed, unanswered or without a UI, nothing is sent. Once sent, it is steered into the worker's session after its current tool calls, before its next model request; it refines the assignment and grants no permissions (no git grant, no new write scope). If the worker reports before reading it, the result lists it as undelivered: then send it as a follow-up orche_task to the same worker. Not for session-bus messages from other Pi sessions: orche routes those to the running worker itself (no dialog), and your copy says so; do not relay them.",
      promptSnippet: "orche_task_message: add instructions for the running orche_task worker's own task (the user confirms)",
      parameters: Type.Object({
        job: Type.Optional(Type.String({ pattern: "^J[1-9][0-9]*$", description: "Job id (default: the running job)." })),
        message: Type.String({ minLength: 1, maxLength: 20_000, description: `The instruction, self-contained (the worker does not see this conversation); the user confirms it in full, so at most ${MESSAGE_CONFIRM_MAX} characters are sent.` }),
      }),
      execute: async (_id, params, signal, _onUpdate, ctx) => {
        const tasks = taskJobs();
        const target = params.job ? tasks.get(params.job) : tasks.running;
        // Not running: tasks.message refuses with its own error, nothing to confirm.
        if (target?.status === "running") {
          const refused = await confirmWorkerControl(tasks, target, "message", ctx, signal, params.message);
          if (refused) return refused as never;
        }
        // The confirmed job by id: never another job that started meanwhile.
        const sent = tasks.message(target?.id ?? params.job, params.message);
        return { content: [{ type: "text", text: sent.text }], details: sent.details, ...(sent.ok ? {} : { isError: true }) };
      },
    });
  };
}

export default createOrcheExtension();
