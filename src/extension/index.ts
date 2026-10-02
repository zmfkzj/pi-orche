import { Type } from "@sinclair/typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOrcheTools } from "../tools/index.js";
import { spillToolResult } from "../tools/spill.js";
import { formatOutcome, OrcheBusyError, OrcheController, type OrcheControllerOptions } from "./controller.js";
import type { MainMode } from "../orchestration/routing.js";
import { delegationRules, discoverMainMode, guardToolCall, isMainMode, MainModeState } from "./mode.js";
import { orcheTaskParameters, WorkerPool } from "./workers.js";

export const RESULT_MESSAGE_TYPE = "orche-result";
/** Pi built-ins that stay Pi's own but are switched on next to our tools. */
const ACTIVATE_BUILTINS = ["grep", "find", "ls"];
/** How long a one-turn override waits for the session to start the turn it just queued before giving up. */
const SINGLE_START_TIMEOUT_MS = 10_000;

const orcheRunParameters = Type.Object({
  request: Type.String({
    minLength: 1,
    description: "The instruction for the orchestrator, SELF-CONTAINED: the goal, decisions made so far in the conversation, the relevant files and findings, constraints, and acceptance criteria (what must be true and how to check it). The orchestrator does not see the conversation.",
  }),
  context: Type.Optional(Type.String({
    maxLength: 30_000,
    description: "Background from the conversation that supports the request (findings, earlier decisions, file excerpts). Appended to the request.",
  })),
});
export const ORCHE_USAGE = "Usage: /orche single|multi|direct <PROMPT> | /orche mode [auto|single|multi|direct] | /orche workers | /orche stop <id>|all | /orche cancel";
export type OrcheCommand =
  | { mode: "single" | "multi" | "direct"; prompt: string }
  | { mode: "cancel" }
  | { mode: "workers" }
  | { mode: "stop"; worker: string }
  | { mode: "mode"; value?: MainMode };
/** Strict command grammar: extra tokens on control commands never start work. */
export function parseOrcheCommand(args: string): OrcheCommand | undefined {
  if (/^\s*cancel\s*$/.test(args)) return { mode: "cancel" };
  if (/^\s*workers\s*$/.test(args)) return { mode: "workers" };
  const stop = /^\s*stop\s+(\S+)\s*$/.exec(args);
  if (stop?.[1]) return { mode: "stop", worker: stop[1] };
  const switchMode = /^\s*mode(?:\s+(\S+))?\s*$/.exec(args);
  if (switchMode) {
    if (switchMode[1] === undefined) return { mode: "mode" };
    return isMainMode(switchMode[1]) ? { mode: "mode", value: switchMode[1] } : undefined;
  }
  const match = /^\s*(single|multi|direct)(?:\s+([\s\S]*\S))?\s*$/.exec(args);
  return match?.[2] ? { mode: match[1] as "single" | "multi" | "direct", prompt: match[2] } : undefined;
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
    const pool = () => workers ??= new WorkerPool({ controller, ...(options.agentDir ? { agentDir: options.agentDir } : {}), ...(options.workerIdleTtlMs !== undefined ? { idleTtlMs: options.workerIdleTtlMs } : {}) });
    /** The calling session's own file/id/directory: never reported as another session, and where the session store is. */
    const currentSession = (ctx: Pick<ExtensionContext, "sessionManager">) => ({
      file: ctx.sessionManager.getSessionFile() || undefined,
      id: ctx.sessionManager.getSessionId() || undefined,
      dir: ctx.sessionManager.getSessionDir() || undefined,
    });
    const state = new MainModeState(pi);
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
    pi.on("tool_result", (event, ctx) => spillToolResult(event, ctx.cwd));
    pi.on("session_start", async (_event, ctx) => {
      const active = pi.getActiveTools();
      // An explicit `--tools` / defaultTools selection that leaves out our tools is the user's choice: keep it.
      if (ours.every(name => active.includes(name))) {
        const registered = new Set(pi.getAllTools().map(tool => tool.name));
        const extra = ACTIVATE_BUILTINS.filter(name => registered.has(name) && !active.includes(name));
        if (extra.length) pi.setActiveTools([...active, ...extra]);
      }
      const found = await discoverMainMode({ cwd: ctx.cwd, agentDir: options.agentDir ?? getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
      state.setConfig(found.mode, found.path);
      state.restore(ctx.sessionManager.getBranch());
      state.apply();
      showMode(ctx);
      if (found.error) ctx.ui.notify(`orche: ${found.error}; using the default mode ${state.session}`, "warning");
    });
    pi.on("before_agent_start", event => {
      event.systemPromptOptions.sections["orche-delegation"] = delegationRules(state.effective);
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
      description: "/orche single <prompt>: delegate to one worker for one turn. /orche multi <prompt>: run the multi-agent orchestrator. /orche direct <prompt>: edit directly for one turn. /orche mode [auto|single|multi|direct]: show/set delegation. /orche workers: list workers. /orche stop <id>|all: dispose workers. /orche cancel: stop the active task or run.",
      handler: async (args, ctx: ExtensionCommandContext) => {
        const parsed = parseOrcheCommand(args);
        if (!parsed) {
          ctx.ui.notify(ORCHE_USAGE, "warning");
          return;
        }
        if (parsed.mode === "cancel") {
          if (!controller.cancel()) {
            ctx.ui.notify("no active orche run", "info");
            return;
          }
          await controller.whenIdle();
          ctx.ui.notify("orche run cancelled", "info");
          return;
        }
        if (parsed.mode === "workers") {
          ctx.ui.notify(workers?.formatWorkers() ?? "no workers", "info");
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
        if (parsed.mode === "single" || parsed.mode === "direct") {
          // Override only an idle turn. Queued turns retain the session mode, so refuse incompatible modes.
          if (!ctx.isIdle()) {
            const compatible = parsed.mode === "direct" ? state.session === "direct" : state.session === "auto" || state.session === "single";
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
        if (controller.taskActive) {
          ctx.ui.notify(new OrcheBusyError("task").message, "error");
          return;
        }
        const request = parsed.prompt;
        const show = (lines: readonly string[]) => {
          ctx.ui.setStatus("orche", `orche: ${lines.at(-1) ?? "starting"}`);
          ctx.ui.setWidget("orche", lines.map(line => `orche · ${line}`));
        };
        const multi = async () => {
          try {
            show([]);
            const outcome = await controller.run({
              request,
              cwd: ctx.cwd,
              model: ctx.model,
              thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              projectTrusted: ctx.isProjectTrusted(),
              signal: ctx.signal,
              currentSession: currentSession(ctx),
              onProgress: show,
            });
            pi.sendMessage(
              { customType: RESULT_MESSAGE_TYPE, content: formatOutcome(outcome), display: true, details: outcome.details },
              { triggerTurn: false },
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(message, "error");
            if (!(error instanceof OrcheBusyError)) {
              pi.sendMessage({ customType: RESULT_MESSAGE_TYPE, content: `orche could not run: ${message}`, display: true, details: { status: "failed" } }, { triggerTurn: false });
            }
          } finally {
            ctx.ui.setStatus("orche", undefined);
            ctx.ui.setWidget("orche", undefined);
          }
        };
        // The interactive TUI only feeds editor input to commands while a command or turn is not pending: it queues
        // a typed `/orche cancel` behind a pending handler. So in the TUI the run goes to the background and the
        // handler returns (the editor stays usable); one-shot modes and RPC keep the handler pending until the
        // run ends, because print/json exit when it returns and RPC clients can send `/orche cancel` concurrently.
        if (ctx.mode === "tui") void multi(); else await multi();
      },
    });

    // (3) orche_run tool for the main model
    pi.registerTool({
      name: "orche_run",
      label: "orche",
      description:
        "Delegate a coding request to the pi-orche orchestrator: a coordinator plans, parallel workers explore/implement in this workspace, and an independent verifier checks the result. Returns the final report. The orchestrator does NOT see this conversation, so the request must be self-contained: goal, decisions so far, relevant files and findings, constraints, acceptance criteria. Only one run can be active; it can take several minutes and edits files in the current directory.",
      promptSnippet: "orche_run: delegate a substantial change/investigation to the multi-agent orchestrator and get its verified report",
      parameters: orcheRunParameters,
      executionMode: "sequential",
      execute: async (_id, params, signal, onUpdate, ctx) => {
        const outcome = await controller.run({
          request: params.request,
          ...(params.context ? { context: params.context } : {}),
          cwd: ctx.cwd,
          model: ctx.model,
          thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
          projectTrusted: ctx.isProjectTrusted(),
          signal,
          currentSession: currentSession(ctx),
          onProgress: lines => onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: { progress: lines } }),
        });
        if (outcome.cancelledByUser) throw new Error(`cancelled by user\n\n${formatOutcome(outcome)}`);
        if (outcome.report.status !== "done") throw new Error(formatOutcome(outcome));
        return { content: [{ type: "text", text: formatOutcome(outcome) }], details: outcome.details };
      },
    });
    pi.registerTool({
      name: "orche_task",
      label: "orche task",
      description: "Delegate one self-contained request to one persistent worker. Choose explore, answer, implement, verify, game-asset (create/modify game art, audio and model assets) or video (produce/edit video); pass worker to reuse a live worker with its retained context and original model. Implement, game-asset and video may write within files (or the workspace when omitted); other roles are read-only. Only one task or multi run can be active.",
      promptSnippet: "orche_task: one reusable worker for explore, answer, implement, verify, game-asset (game art/audio/model assets) or video (production/editing)",
      parameters: orcheTaskParameters,
      executionMode: "sequential",
      execute: async (_id, params, signal, onUpdate, ctx) => {
        const result = await pool().execute({
          ...params,
          cwd: ctx.cwd,
          model: ctx.model,
          thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
          projectTrusted: ctx.isProjectTrusted(),
          signal,
          currentSession: currentSession(ctx),
          onProgress: lines => {
            ctx.ui.setStatus("orche", lines.at(-1));
            onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: { progress: lines } });
          },
        });
        return { content: [{ type: "text", text: result.text }], details: result.details };
      },
    });
  };
}

export default createOrcheExtension();
