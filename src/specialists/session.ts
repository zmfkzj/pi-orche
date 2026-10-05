/**
 * One-shot specialist sessions of the single workflow (docs/specialist-orchestration.md 4.1): a fresh session with a narrow tool
 * set, one prompt and one structured report, always disposed. The Framer and the Verifier run through here; the persistent
 * Primary worker does not. Generalizes `runAdvisorSession` (src/advisor/session.ts): any report schema, an invalid report is
 * sent back to the model to repair instead of ending the call, and usage is returned for the caller's record.
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSession, type ToolGuard } from "../pi/session-factory.js";
import { abortable } from "../orchestration/run/deadline.js";
import type { ModelRoute } from "../orchestration/routing.js";

export interface SpecialistUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface SpecialistReport<S extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: S;
  /** A semantic check after the schema check; a returned string is sent back to the model as the error to fix. */
  check?: (value: Static<S>) => string | undefined;
}
export interface SpecialistRun<S extends TSchema> {
  /** Actor id for records and errors, e.g. `framer:T1#2`. */
  actor: string;
  route: ModelRoute;
  runtime: ModelRuntime;
  cwd: string;
  instructions: string;
  prompt: string;
  /** Built-in tool names; the report tool is added. */
  tools: readonly string[];
  customTools?: readonly ToolDefinition[];
  report: SpecialistReport<S>;
  toolGuard?: ToolGuard;
  /** Turns (model responses) before the call fails without a report. */
  maxTurns: number;
  timeoutMs: number;
  signal: AbortSignal;
  /** Persist the transcript here (the assignment record's `sessions/`); in memory without it. */
  sessionFile?: string;
  /** Effective main window when the route inherits the main model with extended context. */
  inheritedContextWindow?: number;
  /** Every tool the specialist starts (progress lines). */
  onTool?: (name: string) => void;
}
export interface SpecialistStats {
  actor: string;
  model: string;
  thinking?: string;
  requests: number;
  durationMs: number;
  startedAt: number;
  usage: SpecialistUsage;
  /** `provider/model` → requests, as answered. */
  models: Record<string, number>;
  sessionFile?: string;
}
export interface SpecialistOutcome<T> { value: T; stats: SpecialistStats }

/** The call ran but produced no valid report (turn cap, timeout, model error, cancellation); `stats` says what it cost. */
export class SpecialistError extends Error {
  override readonly name = "SpecialistError";
  constructor(message: string, readonly stats: SpecialistStats, readonly cancelled: boolean) { super(message); }
}

const errorsOf = (schema: TSchema, value: unknown): string => [...Value.Errors(schema, value)].slice(0, 8).map(error => `${error.path || "/"}: ${error.message}`).join("; ");

function reportTool<S extends TSchema>(report: SpecialistReport<S>, capture: (value: Static<S>) => void): ToolDefinition {
  let accepted = false;
  return {
    name: report.name,
    label: report.label,
    description: report.description,
    parameters: report.parameters,
    execute: async (_id, args) => {
      if (accepted) return { content: [{ type: "text", text: "Report already recorded." }], details: {}, isError: true, terminate: true };
      if (!Value.Check(report.parameters, args)) return { content: [{ type: "text", text: `Invalid ${report.name} arguments: ${errorsOf(report.parameters, args)}. Fix them and call ${report.name} again.` }], details: {}, isError: true };
      const problem = report.check?.(args as Static<S>);
      if (problem) return { content: [{ type: "text", text: `${problem} Call ${report.name} again with the fix.` }], details: {}, isError: true };
      accepted = true;
      capture(args as Static<S>);
      return { content: [{ type: "text", text: "Report recorded." }], details: {}, terminate: true };
    },
  };
}

/** One bounded specialist call: fresh session, one valid report, always disposed. */
export async function runSpecialistSession<S extends TSchema>(run: SpecialistRun<S>): Promise<SpecialistOutcome<Static<S>>> {
  const startedAt = Date.now();
  const stats: SpecialistStats = { actor: run.actor, model: run.route.model, ...(run.route.thinking ? { thinking: run.route.thinking } : {}), requests: 0, durationMs: 0, startedAt, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, models: {} };
  const finish = () => { stats.durationMs = Date.now() - startedAt; return stats; };
  if (run.signal.aborted) throw new SpecialistError(`${run.actor}: cancelled`, finish(), true);
  const controller = new AbortController();
  const onAbort = () => controller.abort(run.signal.reason ?? new Error("cancelled"));
  run.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(run.timeoutMs / 1000)}s`)), Math.max(0, run.timeoutMs));
  const captured: { value?: Static<S> } = {};
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let turns = 0;
  let modelError: string | undefined;
  try {
    const creation = createSession({
      cwd: run.cwd, route: run.route, modelRuntime: run.runtime,
      tools: [...run.tools, run.report.name],
      customTools: [...(run.customTools ?? []), reportTool(run.report, value => { if (!controller.signal.aborted) captured.value ??= value; })],
      instructions: run.instructions,
      ...(run.toolGuard ? { toolGuard: run.toolGuard } : {}),
      ...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
      ...(run.inheritedContextWindow ? { inheritedContextWindow: run.inheritedContextWindow } : {}),
    }).then(created => {
      if (controller.signal.aborted) { created.dispose(); throw controller.signal.reason; }
      return created;
    });
    session = await abortable(creation, controller.signal);
    if (session.sessionFile) stats.sessionFile = session.sessionFile;
    const active = session;
    const stop = () => { void active.abort().catch(() => undefined); };
    controller.signal.addEventListener("abort", stop, { once: true });
    unsubscribe = session.subscribe(event => {
      if (event.type === "tool_execution_start") run.onTool?.(event.toolName);
      if (event.type === "turn_end" && ++turns >= run.maxTurns && captured.value === undefined) controller.abort(new Error(`no ${run.report.name} within ${run.maxTurns} turns`));
      if (event.type === "message_end" && event.message.role === "assistant") {
        const { usage } = event.message;
        const answered = `${event.message.provider}/${event.message.model}`;
        stats.requests++;
        stats.models[answered] = (stats.models[answered] ?? 0) + 1;
        stats.usage.input += usage.input; stats.usage.output += usage.output; stats.usage.cacheRead += usage.cacheRead; stats.usage.cacheWrite += usage.cacheWrite;
        stats.usage.cost += usage.cost?.total ?? 0;
        modelError = event.message.stopReason === "error" ? (event.message.errorMessage ?? "model error") : undefined;
      }
    });
    try { await abortable(session.prompt(run.prompt), controller.signal); }
    finally { controller.signal.removeEventListener("abort", stop); }
    if (captured.value === undefined) throw new Error(modelError ?? `ended without calling ${run.report.name}`);
    return { value: captured.value, stats: finish() };
  } catch (error) {
    if (error instanceof SpecialistError) throw error;
    const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message : error instanceof Error ? error.message : String(error);
    throw new SpecialistError(`${run.actor}: ${reason}`, finish(), run.signal.aborted);
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    session?.dispose();
  }
}
