/**
 * One sub-worker of an orche_spawn call: a fresh one-shot session (src/specialists/session.ts) that sees only its own request, works
 * with the worker tool set, may write only its own files, cannot spawn, and ends with one report_result. Standard roles inherit the
 * orchestrator's model and thinking unless the config sets `models.worker`; game-asset and video use their specialist routes (and generate_image when images are set up).
 */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRoute, SubWorkerModelSource, SubWorkerThinkingSource } from "../orchestration/routing.js";
import type { TaskItem } from "../orchestration/backlog.js";
import { checkWriteRealPath, WRITE_TOOLS } from "../orchestration/ownership.js";
import { orchestrationResultSchemas } from "../orchestration/result-schemas.js";
import { WORKER_TOOL_NAMES } from "../tools/index.js";
import { runSpecialistSession, SpecialistError, type SpecialistReport, type SpecialistStats } from "../specialists/session.js";
import { DEPTH_LIMIT_MESSAGE, SPAWN_TOOL, type PlannedWorker, type RunSubWorker, type SubWorkerOutcome, type SubWorkerRole } from "./spawn.js";

export const SUB_WORKER_INSTRUCTIONS = "You are a sub-worker of an orchestrator in a coding agent. Work only on your one assignment; you cannot see the orchestrator's conversation and you cannot spawn workers. Use the available tools to establish evidence. Never edit outside your owned files. Never commit or push. Reply in the language of the request. Complete the assignment with report_result, called alone.";

export interface SubWorkerEnvironment {
  orchestrator: string;
  cwd: string;
  runtime: ModelRuntime;
  /** The route standard roles run on: `models.worker` when configured, else the orchestrator's current route. */
  route: ModelRoute;
  /** Where `route` comes from (recorded per sub-worker): `models.worker`'s model, main's model named by it, or the orchestrator's. */
  routeSource: Exclude<SubWorkerModelSource, "route">;
  /** Where `route.thinking` comes from: `models.worker`'s level, main's current thinking named by it, or the orchestrator's. */
  thinkingSource: Exclude<SubWorkerThinkingSource, "route">;
  inheritedContextWindow?: number;
  /** The route of a specialist role (its own configured route, as orche_task resolves it). */
  specialistRoute(role: "game-asset" | "video"): ModelRoute;
  /** generate_image for specialists when images are configured. */
  imageTool?(): ToolDefinition | undefined;
  /** The assignment prompt of one sub-worker (src/extension/workers.ts builds it like an orche_task prompt). */
  prompt(worker: PlannedWorker, imagesAvailable: boolean): string;
  timeoutMs: number;
  maxTurns: number;
  sessionFile?(id: string): string | undefined;
}

const reportSchema = Type.Object({ kind: Type.String(), summary: Type.String({ minLength: 1 }), data: Type.Optional(Type.Unknown()) });
interface Report { kind: string; summary: string; data?: unknown }

/** report_result of a sub-worker: the kind must be its role and `data` must satisfy that role's result contract. */
function reportFor(role: SubWorkerRole): SpecialistReport<typeof reportSchema> {
  return {
    name: "report_result",
    label: "Report result",
    description: "Complete the current assignment with your result. Call alone, not alongside other tools.",
    parameters: reportSchema,
    check: value => {
      if (value.kind !== role) return `Expected report kind "${role}"; received "${value.kind}".`;
      const contract = orchestrationResultSchemas[role];
      if (!contract || ((value.data === undefined || value.data === null) && contract.optional)) return undefined;
      if (Value.Check(contract.schema, value.data)) return undefined;
      return `Invalid data: ${[...Value.Errors(contract.schema, value.data)].slice(0, 6).map(error => `${error.path || "/"}: ${error.message}`).join("; ")}. Expected data: ${JSON.stringify(contract.schema)}.`;
    },
  };
}

function statusOf(role: SubWorkerRole, data: unknown): string {
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  if (role === "verify") return record.passed === true ? "passed" : "not passed";
  return record.status === "blocked" ? "blocked" : "done";
}

/** The guard of one sub-worker: no spawning; writes only inside its own files and never into a sibling's (symlinks resolved). */
export function subWorkerGuard(worker: PlannedWorker, siblings: readonly PlannedWorker[], cwd: string) {
  const tasks: TaskItem[] = siblings.map(sibling => ({ id: sibling.id, owner: sibling.id, description: sibling.name, files: sibling.files ?? [], status: "running" }));
  return async (toolName: string, input: Record<string, unknown>): Promise<string | undefined> => {
    if (toolName === SPAWN_TOOL) return DEPTH_LIMIT_MESSAGE;
    if (!WRITE_TOOLS.has(toolName)) return undefined;
    return (await checkWriteRealPath({ toolName, input, cwd, agentId: worker.id, assignmentKind: worker.role, tasks }))?.reason;
  };
}

export function createSubWorkerRunner(env: SubWorkerEnvironment): RunSubWorker {
  return async (worker, siblings, signal, onTool, onModel) => {
    const specialist = worker.role === "game-asset" || worker.role === "video";
    const route = specialist ? env.specialistRoute(worker.role as "game-asset" | "video") : env.route;
    const image = specialist ? env.imageTool?.() : undefined;
    const guard = subWorkerGuard(worker, siblings, env.cwd);
    const sessionFile = env.sessionFile?.(worker.id);
    const base = { id: worker.id, name: worker.name, role: worker.role, reason: worker.reason, ...(worker.files ? { files: [...worker.files] } : {}), changes: [] as string[], modelSource: specialist ? "route" as const : env.routeSource, thinkingSource: specialist ? "route" as const : env.thinkingSource };
    let started = false;
    const fromStats = (stats: SpecialistStats) => ({ model: stats.model, ...(stats.thinking ? { thinking: stats.thinking } : {}), ...(started ? {} : { notStarted: true as const }), requests: stats.requests, models: { ...stats.models }, startedAt: stats.startedAt, durationMs: stats.durationMs, costUSD: stats.usage.cost, ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}) });
    try {
      const { value, stats } = await runSpecialistSession({
        actor: worker.id, route, runtime: env.runtime, cwd: env.cwd, instructions: SUB_WORKER_INSTRUCTIONS, prompt: env.prompt(worker, !!image),
        tools: [...WORKER_TOOL_NAMES, ...(image ? [image.name] : [])], ...(image ? { customTools: [image] } : {}), report: reportFor(worker.role),
        toolGuard: guard, writeFileGuard: (file, abort) => abort?.aborted ? "cancelled" : guard("ast_rewrite", { path: file }),
        maxTurns: env.maxTurns, timeoutMs: env.timeoutMs, signal, nudges: 1, onTool,
        onSession: use => { started = true; onModel?.(use); },
        ...(sessionFile ? { sessionFile } : {}), ...(!specialist && env.inheritedContextWindow ? { inheritedContextWindow: env.inheritedContextWindow } : {}),
      });
      const report = value as Report;
      return { ...base, status: statusOf(worker.role, report.data), summary: report.summary, ...(report.data !== undefined ? { data: report.data } : {}), ...fromStats(stats) } satisfies SubWorkerOutcome;
    } catch (error) {
      const stats = error instanceof SpecialistError ? error.stats : undefined;
      const cancelled = error instanceof SpecialistError ? error.cancelled : signal.aborted;
      return {
        ...base, status: cancelled ? "cancelled" : "failed", summary: "", error: error instanceof Error ? error.message : String(error),
        ...(stats ? fromStats(stats) : { model: route.model, ...(route.thinking ? { thinking: route.thinking } : {}), ...(started ? {} : { notStarted: true as const }), requests: 0, models: {}, startedAt: Date.now(), durationMs: 0, costUSD: 0 }),
      } satisfies SubWorkerOutcome;
    }
  };
}
