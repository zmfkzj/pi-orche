import { access } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOrcheTools } from "../tools/index.js";
import { spillToolResult } from "../tools/spill.js";
import { OrcheController, type OrcheControllerOptions } from "./controller.js";
import type { MainMode } from "../orchestration/routing.js";
import { delegationRules, guardToolCall, isMainMode, MainModeState, type MainModeLookup } from "./mode.js";
import { contextWarning, DEFAULT_CONTEXT_WARNING, type ContextWarningSettings, type ContextWarningState } from "./context-warning.js";
import { CONFIG_FILE, loadOrcheConfigFile } from "./config.js";
import { orcheTaskParameters, WorkerPool } from "./workers.js";

import { formatRecordList, listRecords } from "./records.js";
import { orcheTaskRenderers } from "./render.js";
import { partialUpdate } from "./progress.js";
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
async function discoverConfiguredMainMode(options: { cwd: string; agentDir: string; projectTrusted: boolean }): Promise<MainModeLookup & { contextWarning?: ContextWarningSettings; pipeline?: "v1" | "v2" }> {
  const candidates = [...(options.projectTrusted ? [join(options.cwd, ".pi", CONFIG_FILE)] : []), join(options.agentDir, CONFIG_FILE)];
  for (const path of candidates) {
    try { await access(path); } catch { continue; }
    try {
      const { routes, contextWarning, single } = await loadOrcheConfigFile(path);
      return { ...(routes.mainMode ? { mode: routes.mainMode } : {}), ...(routes.legacyMainMode ? { legacyMode: routes.legacyMainMode } : {}), path, contextWarning, pipeline: single.pipeline };
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

export const ORCHE_USAGE = "Usage: /orche single|direct <PROMPT> | /orche mode [single|direct] | /orche workers | /orche stop <id>|all | /orche records | /orche cancel";
export type OrcheCommand =
  | { mode: "single" | "direct"; prompt: string }
  | { mode: "cancel" }
  | { mode: "workers" }
  | { mode: "records" }
  | { mode: "stop"; worker: string }
  | { mode: "mode"; value?: MainMode };
/** Strict command grammar: extra tokens on control commands never start work. */
export function parseOrcheCommand(args: string): OrcheCommand | undefined {
  if (/^\s*cancel\s*$/.test(args)) return { mode: "cancel" };
  if (/^\s*workers\s*$/.test(args)) return { mode: "workers" };
  if (/^\s*records\s*$/.test(args)) return { mode: "records" };
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
}
/** Build the extension; options provide config/runtime/run and idle-timeout test seams. */
export function createOrcheExtension(options: OrcheExtensionOptions = {}) {
  return function orcheExtension(pi: ExtensionAPI): void {
    const controller = new OrcheController(options);
    let workers: WorkerPool | undefined;
    /** Task ledgers of this session's branch (restored at session start): a fresh pool picks them up, so a task outlives its worker. */
    let restoredLedgers: TaskLedger[] = [];
    const pool = () => {
      if (!workers) {
        workers = new WorkerPool({
          controller, ...(options.agentDir ? { agentDir: options.agentDir } : {}), ...(options.workerIdleTtlMs !== undefined ? { idleTtlMs: options.workerIdleTtlMs } : {}),
          // One small entry per ledger event, not part of the model context: it follows the session branch and survives reloads.
          onLedgerEvent: event => pi.appendEntry(LEDGER_ENTRY_TYPE, event),
        });
        if (restoredLedgers.length) workers.restoreLedgers(restoredLedgers);
      }
      return workers;
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
    /** `single.pipeline` of the config file read at session start: the single-mode rules differ for v2 (the Framer writes implement contracts). */
    let pipeline: "v1" | "v2" = "v1";
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
    pi.on("session_start", async (_event, ctx) => {
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
      pipeline = found.pipeline ?? "v1";
      state.restore(ctx.sessionManager.getBranch());
      restoredLedgers = latestLedgers(ctx.sessionManager.getBranch());
      workers?.restoreLedgers(restoredLedgers);
      state.apply();
      showMode(ctx);
      if (found.error) ctx.ui.notify(`orche: ${found.error}; using the default mode ${state.session}`, "warning");
      if (found.legacyMode && !found.error) ctx.ui.notify(`orche: mainMode "${found.legacyMode}" in ${found.path} was removed (multi-agent orche_run delegation); using "single". Set mainMode to "single" or "direct".`, "warning");
    });
    pi.on("before_agent_start", event => {
      event.systemPromptOptions.sections["orche-delegation"] = delegationRules(state.effective, { pipeline });
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
    pi.on("session_shutdown", async () => {
      controller.cancel();
      await workers?.dispose();
      workers = undefined;
    });

    // (2) Delegation, one-turn overrides and worker/session controls.
    pi.registerCommand("orche", {
      description: "/orche single <prompt>: delegate to one worker for one turn. /orche direct <prompt>: edit directly for one turn. /orche mode [single|direct]: show/set delegation. /orche workers: list workers. /orche stop <id>|all: dispose workers. /orche records: list this session's recent task records (transcripts and manifests of orche tasks). /orche cancel: stop the active task.",
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
      description: `Delegate one self-contained request to one persistent worker. Pass references, not copies: repository paths with line ranges/symbols, reproduction commands, artifact/run-record paths. Paste only short decisive irreproducible snippets (exact errors or user text); never whole files, diffs or long logs. Choose explore, answer, implement, verify, game-asset (create/modify game art, audio and model assets) or video (produce/edit video); pass worker to reuse a live worker with its retained context and original model. Implement, game-asset and video may write within files (or the workspace when omitted); other roles are read-only. Workers never git commit or push unless this assignment carries \`git\` ({commit, push, remote, branch}; implement, game-asset and video only): set it only when the user explicitly asked in this conversation to commit or push, and scope the commit to the task's files where possible. Only one task can be active. Time budget: ${timeBudget()} an idle worker times out at the base deadline, and the result says why a timeout was not extended.`,
      promptSnippet: "orche_task: one reusable worker for explore, answer, implement, verify, game-asset (game art/audio/model assets) or video (production/editing)",
      promptGuidelines: [
        "orche_task workers never git commit or push on their own. Pass `git` ({commit:true} or {push:true, remote?, branch?}) only when the user explicitly asked in this conversation to commit or push; never on your own initiative. Only implement, game-asset and video accept it; explore, answer and verify reject it.",
        "The `git` grant covers that one assignment only: a reused worker's next assignment without it may not commit. Scope the commit to the task's files where possible (pass `files`, name the paths in `request`), and check the commits listed in the result before reporting.",
      ],
      parameters: orcheTaskParameters,
      ...orcheTaskRenderers,
      executionMode: "sequential",
      execute: async (_id, params, signal, onUpdate, ctx) => {
        // A task whose worker ran and failed, timed out or was cancelled comes back as an isError result that keeps its
        // details; argument validation and errors before a worker ran still throw (see WorkerPool.executeTool).
        return pool().executeTool({
          ...params,
          mainMode: state.effective,
          cwd: ctx.cwd,
          model: ctx.model,
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
  };
}

export default createOrcheExtension();
