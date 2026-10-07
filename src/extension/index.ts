import { access } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOrcheTools } from "../tools/index.js";
import { spillToolResult } from "../tools/spill.js";
import { OrcheController, type OrcheControllerOptions } from "./controller.js";
import { inheritsMain, tierThinking, type MainMode, type ModelTiers } from "../orchestration/routing.js";
import { delegationRules, guardToolCall, isMainMode, MainModeState, type MainModeLookup } from "./mode.js";
import { contextWarning, DEFAULT_CONTEXT_WARNING, type ContextWarningSettings, type ContextWarningState } from "./context-warning.js";
import { CONFIG_FILE, DEFAULT_SINGLE, loadOrcheConfigFile } from "./config.js";
import { orcheTaskParameters, WORKER_CAPABILITY_CHANNEL, WorkerPool, type GoneWorker, type WorkerCapabilityAnswer } from "./workers.js";
import { Type } from "@sinclair/typebox";
import { JOB_ENTRY_TYPE, jobResultContent, TASK_RESULT_TYPE, TaskJobs, WORKER_ENTRY_TYPE, type AttachOptions, type DetachReason, type Job, type JobEntry } from "./jobs.js";
import { attachResult, JOB_WIDGET_KEY, jobEndNotice, jobUpdate, jobWidgetLines } from "./job-view.js";
import { recoverOrphanRecords } from "./records.js";

import { formatRecordList, listRecords } from "./records.js";
import { createOrcheRenderers, orcheTaskRenderers, renderJobResultMessage } from "./render.js";
import { partialUpdate } from "./progress.js";
import { formatSplitSummary, readSplitLog, summarizeSplits } from "../orchestrator/split-log.js";
import { applyMainModel, formatModelTiers, type ModelTiersView } from "./main-model.js";
import { defaultRunLimits } from "../orchestration/limits.js";
import { formatDuration } from "../agent/liveness.js";
import { LEDGER_ENTRY_TYPE, LEDGER_SUMMARY_TYPE, latestLedgers, type TaskLedger } from "../single/ledger.js";

export const RESULT_MESSAGE_TYPE = "orche-result";
/** Pi built-ins that stay Pi's own but are switched on next to our tools. */
const ACTIVATE_BUILTINS = ["grep", "find", "ls"];

/**
 * `mainMode` of the config file the routes come from (trusted project file, else user file), read through `loadOrcheConfigFile`: it knows the
 * extension-only keys (`concurrentSessions`, `records`) that the plain route parser behind `discoverMainMode` (mode.ts) rejects as unknown, which
 * made a config with `records` look invalid at session start and drop its `mainMode`.
 */
async function discoverConfiguredMainMode(options: { cwd: string; agentDir: string; projectTrusted: boolean }): Promise<MainModeLookup & { contextWarning?: ContextWarningSettings; spawn?: boolean; warnings?: string[]; models?: ModelTiers }> {
  const candidates = [...(options.projectTrusted ? [join(options.cwd, ".pi", CONFIG_FILE)] : []), join(options.agentDir, CONFIG_FILE)];
  for (const path of candidates) {
    try { await access(path); } catch { continue; }
    try {
      const { routes, contextWarning, single, warnings } = await loadOrcheConfigFile(path);
      // The tiers with the top-level extendedContext filled in where a tier leaves it out, as routes resolve it (routing.ts);
      // not for `{ "model": "main" }`, which keeps main's own context window.
      const models = routes.models ? Object.fromEntries(Object.entries(routes.models).map(([tier, route]) => {
        const extendedContext = inheritsMain(route) ? undefined : route.extendedContext ?? routes.extendedContext;
        return [tier, { ...route, ...(extendedContext !== undefined ? { extendedContext } : {}) }];
      })) as ModelTiers : undefined;
      return { ...(routes.mainMode ? { mode: routes.mainMode } : {}), ...(routes.legacyMainMode ? { legacyMode: routes.legacyMainMode } : {}), path, contextWarning, spawn: single.spawn, ...(warnings.length ? { warnings } : {}), ...(models ? { models } : {}) };
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {};
}
/**
 * The time-budget sentence of the orche_task description, written from the default limits (so that it cannot drift from limits.ts):
 * base cap, extension length and count, and the ceiling they make. `limits` in orche.config.json override the defaults.
 */
function timeBudget(): string {
  const { assignmentMs, extensionMs, maxExtensions } = defaultRunLimits;
  const minutes = (ms: number) => ms / 60_000;
  const base = `base ${minutes(assignmentMs)} minutes per assignment`;
  const active = "worker";
  const ceiling = formatDuration(assignmentMs + maxExtensions * extensionMs);
  return `${base}; when the deadline passes while the ${active} is still actively working (using tools or producing output) it is extended by ${minutes(extensionMs)} minutes, at most ${maxExtensions} times (${maxExtensions}×${minutes(extensionMs)} minutes at most, ${ceiling} in total; these are the defaults, limits.maxExtensions / limits.extensionMs in orche.config.json change them);`;
}

/** How long a one-turn override waits for the session to start the turn it just queued before giving up. */
const SINGLE_START_TIMEOUT_MS = 10_000;
/**
 * Pi queues a prompt typed during a turn right after the `input` handlers return: an attached call detaches once the input is
 * queued (`ctx.hasPendingMessages()`), checked every {@link INPUT_CHECK_MS}, and at the latest after this grace (another
 * extension may have consumed the input; detaching then only costs main one re-attach).
 */
const INPUT_GRACE_MS = 1000;
const INPUT_CHECK_MS = 10;
/** A woken session-bus note counts as waiting for main until Pi delivers it, at most this long (Esc may drop queued notes). */
const NOTE_PENDING_MS = 60_000;
/** The event pi-session-bus emits once Pi accepted an incoming note (`{ id, wake }`; see its README). */
export const SESSION_BUS_MESSAGE_EVENT = "session-bus:message";
const SESSION_BUS_MESSAGE_TYPE = "session-bus.message";

export const ORCHE_USAGE = "Usage: /orche single|direct <PROMPT> | /orche mode [single|direct] | /orche workers | /orche stop <id>|all | /orche records | /orche splits [DAYS] | /orche models | /orche cancel | /orche detach";
export type OrcheCommand =
  | { mode: "single" | "direct"; prompt: string }
  | { mode: "cancel" }
  | { mode: "detach" }
  | { mode: "workers" }
  | { mode: "records" }
  | { mode: "splits"; days?: number }
  | { mode: "models" }
  | { mode: "stop"; worker: string }
  | { mode: "mode"; value?: MainMode };
/** Strict command grammar: extra tokens on control commands never start work. */
export function parseOrcheCommand(args: string): OrcheCommand | undefined {
  if (/^\s*cancel\s*$/.test(args)) return { mode: "cancel" };
  if (/^\s*detach\s*$/.test(args)) return { mode: "detach" };
  if (/^\s*workers\s*$/.test(args)) return { mode: "workers" };
  if (/^\s*records\s*$/.test(args)) return { mode: "records" };
  if (/^\s*models\s*$/.test(args)) return { mode: "models" };
  const splits = /^\s*splits(?:\s+(\d+))?\s*$/.exec(args);
  if (splits) return splits[1] !== undefined ? (Number(splits[1]) > 0 ? { mode: "splits", days: Number(splits[1]) } : undefined) : { mode: "splits" };
  const stop = /^\s*stop\s+(\S+)\s*$/.exec(args);
  if (stop?.[1]) return { mode: "stop", worker: stop[1] };
  const switchMode = /^\s*mode(?:\s+(\S+))?\s*$/.exec(args);
  if (switchMode) {
    if (switchMode[1] === undefined) return { mode: "mode" };
    return isMainMode(switchMode[1]) ? { mode: "mode", value: switchMode[1] } : undefined;
  }
  const match = /^\s*(single|direct)(?:\s+([\s\S]*\S))?\s*$/.exec(args);
  return match?.[2] ? { mode: match[1] as "single" | "direct", prompt: match[2] } : undefined;
}

export interface OrcheExtensionOptions extends OrcheControllerOptions {
  /** Idle worker retirement timeout, injectable for tests. */
  workerIdleTtlMs?: number;
  /** Disable only when an embedding intentionally owns an isolated worker provider setup. Default true. */
  inheritProviders?: boolean;
}
/** Build the extension; options provide config/runtime/run and idle-timeout test seams. */
export function createOrcheExtension(options: OrcheExtensionOptions = {}) {
  return function orcheExtension(pi: ExtensionAPI): void {
    const controller = new OrcheController(options);
    let workers: WorkerPool | undefined;
    /** Task ledgers of this session's branch (restored at session start): a fresh pool picks them up, so a task outlives its worker. */
    let restoredLedgers: TaskLedger[] = [];
    /** Gone workers and used worker ids of this session's branch (restored at session start): ids are never reused. */
    let restoredHistory: { gone: GoneWorker[]; usedWorkerIds: string[] } = { gone: [], usedWorkerIds: [] };
    /** The UI and mode of the latest tool call / session start, for the background job's widget and notices. */
    let lastUi: ExtensionContext["ui"] | undefined;
    let lastMode: ExtensionContext["mode"] | undefined;
    const pool = () => {
      if (!workers) {
        workers = new WorkerPool({
          controller, ...(options.agentDir ? { agentDir: options.agentDir } : {}), ...(options.workerIdleTtlMs !== undefined ? { idleTtlMs: options.workerIdleTtlMs } : {}),
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
        pi.sendMessage(
          { customType: TASK_RESULT_TYPE, content: jobResultContent(job), display: true, details: { job: job.id, worker: job.worker, role: job.role, status: job.status, startedAt: job.startedAt, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...(job.record ? { record: job.record } : {}), ...(job.result?.details ? { task: job.result.details } : {}) } },
          // Starts main's next turn when it is idle; queued behind the current turn when main is talking with the user.
          { triggerTurn: true, deliverAs: "followUp" },
        );
        const notice = jobEndNotice(job);
        try { lastUi?.notify(notice.text, notice.level); } catch { /* the UI may be gone */ }
      },
      onChange: job => {
        if (job.status !== "running") endedShown = job.id;
        paintJob();
      },
    }));

    // The job widget above the editor: running (attached / detached) with its elapsed time, then its end until the next user input.
    /** The ended job whose last state the widget still shows. */
    let endedShown: string | undefined;
    let widgetTimer: ReturnType<typeof setInterval> | undefined;
    let widgetText: string | undefined;
    const stopWidgetTimer = () => { if (widgetTimer) clearInterval(widgetTimer); widgetTimer = undefined; };
    const paintJob = () => {
      const job = jobs?.running ?? (endedShown ? jobs?.get(endedShown) : undefined);
      const lines = job ? jobWidgetLines(job, { attached: jobs?.attached === job, coarse: lastMode !== "tui" }) : undefined;
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

    // Detaching an attached call: input for main (user prompts, woken session-bus notes) and how long a note counts as waiting.
    /** Woken session-bus notes Pi has queued but not yet delivered into main's context: note id -> arrival. */
    const pendingNotes = new Map<string, number>();
    const notesWaiting = () => {
      const now = Date.now();
      for (const [id, at] of pendingNotes) if (now - at > NOTE_PENDING_MS) pendingNotes.delete(id);
      return pendingNotes.size > 0;
    };
    /** Whether input waits for main: queued user prompts or an undelivered woken note. */
    const inputWaiting = (ctx: Pick<ExtensionContext, "hasPendingMessages">) => {
      try { if (ctx.hasPendingMessages()) return true; } catch { /* stale context */ }
      return notesWaiting();
    };
    /** The attach options of a tool call: its abort signal detaches, its block shows the job's progress. */
    const attachOptions = (signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate: ((update: ReturnType<typeof jobUpdate>) => void) | undefined): AttachOptions => ({
      ...(signal ? { signal } : {}),
      pending: () => inputWaiting(ctx),
      onUpdate: job => onUpdate?.(jobUpdate(job)),
    });
    /** Detach once the input that just arrived is queued for main (or after the grace): see {@link INPUT_GRACE_MS}. */
    const detachOnInput = (ctx: ExtensionContext, reason: DetachReason) => {
      const tasks = jobs;
      const attached = tasks?.attached;
      if (!tasks || !attached) return;
      const since = Date.now();
      const check = () => {
        if (tasks.attached !== attached) return;
        let queued = false;
        try { queued = ctx.hasPendingMessages(); } catch { queued = true; }
        if (queued || Date.now() - since >= INPUT_GRACE_MS) tasks.detach(reason);
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
    /** `models.main` at the last session start: what the config set and what was applied (for /orche models). */
    let mainModel: ModelTiersView["atStart"] = {};
    /** `models.orchestrator` names a model / a thinking level of its own (main's hand-off rule then says so instead of "inherit main's"). */
    let orchestratorModel = false;
    let orchestratorThinking = false;
    const showMode = (ctx: Pick<ExtensionContext, "ui">) =>
      ctx.ui.setStatus("orche-mode", `orche: ${state.session}${state.overriding ? ` (one-turn ${state.effective})` : ""}`);

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
      // Only a model or a thinking level of its own changes main's hand-off rule; `{ "model": "main" }` and `thinking: "main"` keep
      // the earlier sentence's "main's CURRENT" for what they inherit.
      orchestratorModel = !!found.models?.orchestrator && !inheritsMain(found.models.orchestrator);
      orchestratorThinking = !!tierThinking(found.models?.orchestrator);
      // Removed settings (e.g. single.pipeline, single.mainReview) are ignored: the file still loads; say so once per session start.
      for (const warning of found.warnings ?? []) ctx.ui.notify(warning, "warning");
      // models.main: the Pi session's model and thinking, once at a fresh session start; the user's own choices are kept.
      const main = await applyMainModel(pi, ctx, event.reason, found.models?.main);
      mainModel = { ...(found.models?.main ? { configured: found.models.main } : {}), ...(main.applied ? { applied: main.applied } : {}), ...(main.skipped ? { skipped: main.skipped } : {}) };
      for (const warning of main.warnings) ctx.ui.notify(warning, "warning");
      state.restore(ctx.sessionManager.getBranch());
      restoredLedgers = latestLedgers(ctx.sessionManager.getBranch());
      workers?.restoreLedgers(restoredLedgers);
      lastUi = ctx.ui;
      lastMode = ctx.mode;
      endedShown = undefined;
      pendingNotes.clear();
      stopWidgetTimer();
      if (widgetText !== undefined) { widgetText = undefined; try { ctx.ui.setWidget(JOB_WIDGET_KEY, undefined); } catch { /* no UI */ } }
      // Jobs and gone workers of this branch: a job that never ended belonged to a process that is gone (crash): it ends now, once.
      const branch = ctx.sessionManager.getBranch();
      const customData = <T,>(type: string) => branch.filter(entry => entry.type === "custom" && (entry as { customType?: string }).customType === type).map(entry => (entry as { data?: unknown }).data as T).filter(Boolean);
      const restored = taskJobs().restore(customData<JobEntry>(JOB_ENTRY_TYPE), customData<GoneWorker>(WORKER_ENTRY_TYPE));
      restoredHistory = { gone: restored.gone, usedWorkerIds: restored.usedWorkerIds };
      workers?.restoreHistory(restored.gone, restored.usedWorkerIds);
      if (restored.interrupted.length) {
        const lines = restored.interrupted.map(job => `${job.id} (${job.worker ?? "?"} ${job.role}: ${job.request})${job.record ? ` record ${job.record}` : ""}`);
        const text = `orche: ${restored.interrupted.length === 1 ? "a background task was" : "background tasks were"} still running when the previous pi process ended, and ${restored.interrupted.length === 1 ? "is" : "are"} now marked interrupted: ${lines.join("; ")}. Naming its worker in orche_task continues the work with a new worker briefed from its transcript.`;
        ctx.ui.notify(text, "warning");
        pi.sendMessage({ customType: "orche-job-interrupted", content: text, display: true, details: { jobs: restored.interrupted.map(job => job.id) } }, { deliverAs: "nextTurn" });
      }
      // run.json records of this session left at "running" by a process that is gone: close them as interrupted (best effort, async).
      void controller.recordsFor({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), ...(ctx.model ? { model: ctx.model } : {}) })
        .then(resolved => recoverOrphanRecords(resolved, { parentSessionId: ctx.sessionManager.getSessionId() || undefined }))
        .then(recovered => { if (recovered.length) ctx.ui.notify(`orche: closed ${recovered.length} orphaned task record${recovered.length === 1 ? "" : "s"} as interrupted (their process ended while running).`, "info"); })
        .catch(() => undefined);
      state.apply();
      showMode(ctx);
      if (found.error) ctx.ui.notify(`orche: ${found.error}; using the default mode ${state.session}`, "warning");
      if (found.legacyMode && !found.error) ctx.ui.notify(`orche: mainMode "${found.legacyMode}" in ${found.path} was removed (multi-agent orche_run delegation); using "single". Set mainMode to "single" or "direct".`, "warning");
    });
    pi.on("before_agent_start", event => {
      event.systemPromptOptions.sections["orche-delegation"] = delegationRules(state.effective, { spawn, orchestratorModel, orchestratorThinking });
    });
    // Direct mode keeps the whole task in the main window: advise the user (not the model) when it fills up.
    pi.on("turn_end", (_event, ctx) => {
      const checked = contextWarning(state.effective, ctx.getContextUsage(), warningSettings, warningState);
      warningState = checked.state;
      if (checked.message) ctx.ui.notify(checked.message, "warning");
      return undefined;
    });
    // Single mode: the main session's own compaction drops the task results it saw; put the task ledgers' state back once.
    pi.on("session_compact", () => {
      if (state.effective !== "single") return;
      const summary = workers?.ledgerSummary();
      if (summary) pi.sendMessage({ customType: LEDGER_SUMMARY_TYPE, content: summary, display: false }, { triggerTurn: false });
    });
    // Second line of defence next to the tool set: `--tools`, another extension or the model can still reach a disabled tool.
    pi.on("tool_call", event => {
      const reason = guardToolCall(state.effective, event.toolName, event.input as Record<string, unknown>);
      return reason ? { block: true, reason } : undefined;
    });
    // Input for main detaches an attached call (the job keeps running); the widget's last end line goes with the next user input.
    pi.on("input", (event, ctx) => {
      if (endedShown && !jobs?.running) { endedShown = undefined; paintJob(); }
      if (jobs?.attached) detachOnInput(ctx, event.streamingBehavior === "followUp" ? "followUp" : "input");
      return undefined;
    });
    // pi-session-bus announces each note Pi accepted (after its steer is queued). A woken note detaches and counts as waiting for
    // main until Pi delivers it into the context; a suppressed one (wake off, hop or rate limit) neither wakes nor detaches.
    pi.events.on(SESSION_BUS_MESSAGE_EVENT, data => {
      const note = (typeof data === "object" && data !== null ? data : {}) as { id?: unknown; wake?: unknown };
      if (note.wake === "suppressed") return;
      if (typeof note.id === "string") pendingNotes.set(note.id, Date.now());
      jobs?.detach("session-bus");
    });
    pi.on("message_end", event => {
      const message = event.message as { role?: string; customType?: string; details?: { note?: { id?: unknown } } };
      if (message.role === "custom" && message.customType === SESSION_BUS_MESSAGE_TYPE && typeof message.details?.note?.id === "string") pendingNotes.delete(message.details.note.id);
      return undefined;
    });
    // A run that ended has taken every steered message (or Esc dropped them): nothing it queued is still waiting.
    pi.on("agent_end", () => { pendingNotes.clear(); });
    pi.registerMessageRenderer(TASK_RESULT_TYPE, renderJobResultMessage);
    pi.on("session_shutdown", async () => {
      // Running background jobs end as interrupted (entry + run record), never silently left "running"; an attached call returns.
      jobs?.dispose();
      stopWidgetTimer();
      if (widgetText !== undefined) { widgetText = undefined; try { lastUi?.setWidget(JOB_WIDGET_KEY, undefined); } catch { /* the UI may be gone */ } }
      endedShown = undefined;
      pendingNotes.clear();
      jobs = undefined;
      controller.cancel();
      await workers?.dispose();
      workers = undefined;
    });

    // (2) Delegation, one-turn overrides and worker/session controls.
    pi.registerCommand("orche", {
      description: "/orche single <prompt>: delegate to one worker for one turn. /orche direct <prompt>: edit directly for one turn. /orche mode [single|direct]: show/set delegation. /orche workers: list workers. /orche stop <id>|all: dispose workers. /orche records: list this session's recent task records (transcripts and manifests of orche tasks). /orche splits [days]: the orchestrator's split decisions over all sessions (split rate, criteria, cost and time), optionally of the last N days. /orche models: the main, orchestrator and worker models now and where each comes from (config, inherited, Pi). /orche cancel: stop the active task. /orche detach: stop waiting for the background task (it keeps running; its result arrives as a message).",
      handler: async (args, ctx: ExtensionCommandContext) => {
        const parsed = parseOrcheCommand(args);
        if (!parsed) {
          ctx.ui.notify(ORCHE_USAGE, "warning");
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
          // The three model tiers now and where each comes from (docs/orchestrator.md 12).
          const found = await discoverConfiguredMainMode({ cwd: ctx.cwd, agentDir: options.agentDir ?? getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
          ctx.ui.notify(formatModelTiers({ main: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(), mode: state.effective, ...(found.path ? { path: found.path } : {}), ...(found.error ? { error: found.error } : {}), ...(found.models ? { tiers: found.models } : {}), atStart: mainModel }), "info");
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
          // Override only an idle turn. Queued turns retain the session mode, so refuse incompatible modes.
          if (!ctx.isIdle()) {
            const compatible = state.session === parsed.mode;
            if (!compatible) {
              ctx.ui.notify(`orche ${parsed.mode}: refused. The agent is busy and this session is in mode ${state.session}, where a queued turn could not ${parsed.mode === "direct" ? "edit files" : "delegate to one worker"}. Wait for the current turn, or switch with /orche mode ${parsed.mode}.`, "warning");
              return;
            }
            pi.sendUserMessage(parsed.prompt, { deliverAs: "followUp" });
            ctx.ui.notify(`orche ${parsed.mode}: the agent is busy; the prompt is queued as a follow-up turn.`, "info");
            return;
          }
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
            state.setOverride();
            showMode(ctx);
          }
          return;
        }
      },
    });

    pi.registerTool({
      name: "orche_task",
      label: "orche task",
      description: `Delegate one self-contained request to one persistent worker. In an interactive or RPC session the task runs as a background job (J1, …) and this call stays ATTACHED to it: it waits like a blocking call, shows the worker's progress and returns the result, unless new user input, a message from another Pi session, Esc or /orche detach DETACHES it first. Then it returns at once with the job id, the worker keeps running, and the result arrives later as one orche-task-result message unless you attach again with orche_task_attach. wait:false returns as soon as the worker has its assignment (detached); wait:true, and print/JSON modes, block until the result and cannot detach (aborting cancels). Pass references, not copies: repository paths with line ranges/symbols, reproduction commands, artifact/run-record paths. Paste only short decisive irreproducible snippets (exact errors or user text); never whole files, diffs or long logs. Choose explore, answer, implement, verify, game-asset (create/modify game art, audio and model assets) or video (produce/edit video); pass worker to reuse a live worker with its retained context and original model. Implement, game-asset and video may write within files (or the workspace when omitted); other roles are read-only. Workers never git commit or push unless this assignment carries \`git\` ({commit, push, remote, branch}; implement, game-asset and video only): set it only when the user explicitly asked in this conversation to commit or push, and scope the commit to the task's files where possible. Only one task can be active. Time budget: ${timeBudget()} an idle worker times out at the base deadline, and the result says why a timeout was not extended.`,
      promptSnippet: "orche_task: one reusable worker for explore, answer, implement, verify, game-asset (game art/audio/model assets) or video (production/editing)",
      promptGuidelines: [
        "orche_task workers never git commit or push on their own. Pass `git` ({commit:true} or {push:true, remote?, branch?}) only when the user explicitly asked in this conversation to commit or push; never on your own initiative. Only implement, game-asset and video accept it; explore, answer and verify reject it.",
        "The `git` grant covers that one assignment only: a reused worker's next assignment without it may not commit. Scope the commit to the task's files where possible (pass `files`, name the paths in `request`), and check the commits listed in the result before reporting.",
        "Pass `gui: true` only when the task needs GUI applications (needs pi-gui): the worker then gets its own private desktop that the user does not see, separate from yours and from other workers'. Omit it otherwise.",
        "In interactive/RPC sessions orche_task stays attached to its job (J1, …) and returns the result like a blocking call. When it returns DETACHED (new user input or a peer-session message arrived), answer that input first; then, if the job is still running and nothing else is waiting for you, call orche_task_attach to wait for it again. Never wait with sleep, never poll orche_task_status (only when the user asks for progress or wants to cancel). Use orche_task_message to add instructions to the running worker.",
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
          cwd: ctx.cwd,
          model: ctx.model,
          ...(options.inheritProviders !== false ? { modelRegistry: ctx.modelRegistry } : {}),
          thinking: pi.getThinkingLevel(),
          projectTrusted: ctx.isProjectTrusted(),
          currentSession: currentSession(ctx),
        };
        // Background job (jobs.ts) in sessions that keep running after the turn: interactive and RPC. The call stays attached to
        // it (like a blocking call) until the job ends or something detaches it; wait:false detaches at once. Print/JSON modes exit
        // when the turn ends, so they (and an explicit wait:true) keep the blocking call.
        if (params.wait !== true && (ctx.mode === "tui" || ctx.mode === "rpc")) {
          let started = false;
          const tasks = taskJobs();
          endedShown = undefined;
          const { job, outcome } = await tasks.start({
            ...base,
            // Startup progress until the worker has its assignment; from then on the attached call's updates (jobUpdate).
            onTiming: (timing, lines) => { if (!started) onUpdate?.(partialUpdate(lines, timing)); },
            onProgress: (lines, timing) => { if (!started) onUpdate?.(partialUpdate(lines, timing)); },
          }, signal, params.wait === false ? undefined : attachOptions(signal, ctx, onUpdate));
          started = true;
          // Input that arrived while the worker started (a typed prompt, a woken peer note) is answered first.
          if (outcome && tasks.attached === job && inputWaiting(ctx)) tasks.detach("input");
          if (outcome) onUpdate?.(jobUpdate(job));
          return attachResult(outcome ? await outcome : { kind: "detached", job, reason: "background" }, "orche_task") as never;
        }
        // A task whose worker ran and failed, timed out or was cancelled comes back as an isError result that keeps its
        // details; argument validation and errors before a worker ran still throw (see WorkerPool.executeTool).
        return pool().executeTool({
          ...params,
          mainMode: state.effective,
          cwd: ctx.cwd,
          model: ctx.model,
          ...(options.inheritProviders !== false ? { modelRegistry: ctx.modelRegistry } : {}),
          thinking: pi.getThinkingLevel(),
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
      description: "Status of a background orche_task job (the running one, or the one named): worker, elapsed time, attached or detached, latest progress and liveness, or the result summary when it ended. Never waits; do not poll it: to wait for the result use orche_task_attach. Use it when the user asks about progress, or with cancel:true to stop the job (its cancelled result is delivered once).",
      promptSnippet: "orche_task_status: progress of the background orche_task job, or cancel it",
      parameters: Type.Object({
        job: Type.Optional(Type.String({ pattern: "^J[1-9][0-9]*$", description: "Job id from orche_task (J1, …); default: the running or latest job." })),
        cancel: Type.Optional(Type.Boolean({ description: "true: cancel the job." })),
      }),
      execute: async (_id, params) => {
        const tasks = taskJobs();
        if (params.cancel === true) return { content: [{ type: "text", text: await tasks.cancel(params.job) }], details: { job: params.job, cancel: true } };
        const text = tasks.status(params.job, worker => workers?.workerLiveness(worker)?.detail);
        return { content: [{ type: "text", text }], details: { job: params.job, cancel: false } };
      },
    });

    pi.registerTool({
      name: "orche_task_attach",
      label: "orche task attach",
      description: "Attach to the running background orche_task job (the one named, else the running one) and wait for its result like a blocking orche_task: the call shows the worker's progress and returns the result when the job ends. New user input, a woken message from another Pi session, Esc or /orche detach DETACH it: it then returns at once, the worker keeps running, and the result arrives as one orche-task-result message unless you attach again. Call it after you answered the input that detached the job, when the job is still running and nothing else waits for you; it refuses while input is queued. Attaching never restarts or cancels the worker.",
      promptSnippet: "orche_task_attach: wait again for the running orche_task job (detaches on new input)",
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
      description: "Send an additional or corrected instruction to the worker of the running background orche_task job. It is steered into the worker's session after its current tool calls, before its next model request; it refines the assignment and grants no permissions (no git grant, no new write scope). If the worker reports before reading it, the result lists it as undelivered: then send it as a follow-up orche_task to the same worker.",
      promptSnippet: "orche_task_message: add instructions to the running orche_task worker",
      parameters: Type.Object({
        job: Type.Optional(Type.String({ pattern: "^J[1-9][0-9]*$", description: "Job id (default: the running job)." })),
        message: Type.String({ minLength: 1, maxLength: 20_000, description: "The instruction, self-contained (the worker does not see this conversation)." }),
      }),
      execute: async (_id, params) => {
        const sent = taskJobs().message(params.job, params.message);
        return { content: [{ type: "text", text: sent.text }], details: sent.details, ...(sent.ok ? {} : { isError: true }) };
      },
    });
  };
}

export default createOrcheExtension();
