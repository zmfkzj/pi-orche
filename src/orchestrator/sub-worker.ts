/**
 * One sub-worker of an orche_spawn call: a fresh one-shot session (src/specialists/session.ts) that sees only its own request, works
 * with the worker tool set, may write only its own files, cannot spawn, and ends with one report_result. Standard roles inherit the
 * orchestrator's model and thinking unless the config sets `models.worker` (strong/ultra: `models.strong-worker`; under `"thinkingPolicy": "phase"` implement/answer run one
 * supported level below the orchestrator's assignment level and verify at it: docs/thinking-policy.md); game-asset and video use their
 * specialist routes (and generate_image when images are set up).
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { formatSchemaErrors } from "../orchestration/schema-errors.js";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRoute, SubWorkerModelSource, SubWorkerThinkingSource } from "../orchestration/routing.js";
import type { TaskItem } from "../orchestration/backlog.js";
import { relative, resolve, sep } from "node:path";
import { checkWriteRealPath, WRITE_TOOLS } from "../orchestration/ownership.js";
import { checkBashWrites } from "../orchestration/bash-writes.js";
import { orchestrationResultSchemas } from "../orchestration/result-schemas.js";
import { WORKER_TOOL_NAMES } from "../tools/index.js";
import { runSpecialistSession, SpecialistError, type SpecialistDeadline, type SpecialistReport, type SpecialistStats } from "../specialists/session.js";
import { DEPTH_LIMIT_MESSAGE, SPAWN_TOOL, subWorkerDeadline, type PlannedWorker, type RunSubWorker, type SubWorkerOutcome, type SubWorkerRole } from "./spawn.js";

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
  /**
   * The route of `verify` sub-workers when it differs from `route` (the phase thinking policy: standard roles at the step level,
   * an independent verification at the orchestrator's baseline), with where its thinking comes from.
   */
  verifyRoute?: ModelRoute;
  verifyThinkingSource?: Exclude<SubWorkerThinkingSource, "route">;
  /** The output-limit recovery ladder of standard sub-workers (the thinking policy's; src/pi/length-recovery.ts). */
  lengthLadder?: "redecompose" | "step-down";
  inheritedContextWindow?: number;
  /** The route of a specialist role (its own configured route, as orche_task resolves it). */
  specialistRoute(role: "game-asset" | "video"): ModelRoute;
  /** generate_image for specialists when images are configured. */
  imageTool?(): ToolDefinition | undefined;
  /** The assignment prompt of one sub-worker (src/extension/workers.ts builds it like an orche_task prompt). */
  prompt(worker: PlannedWorker, imagesAvailable: boolean): string;
  /** Fixed time cap of a sub-worker; only without `deadline`. */
  timeoutMs: number;
  /**
   * The activity-aware deadline of every sub-worker: the orchestrator assignment's resolved limits (base `assignmentMs`, the
   * extension schedule, activity window, observation period), counted from each sub-worker's own start and judged by its own
   * session only. The orchestrator's assignment still bounds it: when that stops, the sub-worker is cancelled.
   */
  deadline?: Pick<SpecialistDeadline, "limits" | "toolTimeoutsMs">;
  maxTurns: number;
  sessionFile?(id: string): string | undefined;
  /** Every event of a sub-worker's session (its orchestrator's liveness tracks it), and the end of that session. Throws are ignored. */
  onSessionEvent?(id: string, event: { type: string; [key: string]: unknown }): void;
  onSessionEnd?(id: string): void;
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
      return `Invalid data: ${formatSchemaErrors(contract.schema, value.data, 6)}. Expected data: ${JSON.stringify(contract.schema)}.`;
    },
  };
}

function statusOf(role: SubWorkerRole, data: unknown): string {
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  if (role === "verify") return record.passed === true ? "passed" : "not passed";
  return record.status === "blocked" ? "blocked" : "done";
}

/**
 * The guard of one sub-worker: no spawning; writes only inside its own files and never into a sibling's (symlinks resolved). An
 * ultra candidate works in its own workspace copy: its siblings' copies are elsewhere, so only its own files count, the protected
 * verification basis is refused, and literal shell writes outside its copy are blocked.
 */
export function subWorkerGuard(worker: PlannedWorker, siblings: readonly PlannedWorker[], cwd: string) {
  const root = worker.workspace ?? cwd;
  const tasks: TaskItem[] = (worker.workspace ? [worker] : siblings).map(sibling => ({ id: sibling.id, owner: sibling.id, description: sibling.name, files: sibling.files ?? [], status: "running" }));
  const protectedPaths = worker.protectedPaths ?? [];
  const outsidePaths = worker.outsidePaths ?? [];
  const under = (path: string, owned: string) => path === owned || path.startsWith(`${owned.replace(/\/$/, "")}/`);
  return async (toolName: string, input: Record<string, unknown>): Promise<string | undefined> => {
    if (toolName === SPAWN_TOOL) return DEPTH_LIMIT_MESSAGE;
    if (worker.workspace && toolName === "bash" && typeof input.command === "string") {
      const verdict = checkBashWrites(input.command, { cwd: root, roots: [], readOnly: false });
      if (!verdict.allowed) return `${verdict.reason} (a candidate writes only inside its workspace copy ${root})`;
    }
    if (!WRITE_TOOLS.has(toolName)) return undefined;
    if ((protectedPaths.length || outsidePaths.length) && typeof input.path === "string") {
      const path = relative(root, resolve(root, input.path)).split(sep).join("/");
      if (protectedPaths.some(owned => under(path, owned))) return `Blocked: ${path} is part of the protected verification basis of this ultra task; implement against it, never change it (report a basis problem in your result instead).`;
      if (outsidePaths.some(owned => under(path, owned))) return `Blocked: ${path} is inside a submodule, which ultra candidate copies do not contain; a candidate cannot change submodules (report what it would need there instead).`;
    }
    return (await checkWriteRealPath({ toolName, input, cwd: root, agentId: worker.id, assignmentKind: worker.role, tasks }))?.reason;
  };
}

export function createSubWorkerRunner(env: SubWorkerEnvironment): RunSubWorker {
  return async (worker, siblings, signal, onTool, onModel, onDeadline) => {
    const specialist = worker.role === "game-asset" || worker.role === "video";
    const verifyRoute = worker.role === "verify" && env.verifyRoute ? env.verifyRoute : undefined;
    const route = specialist ? env.specialistRoute(worker.role as "game-asset" | "video") : verifyRoute ?? env.route;
    const image = specialist ? env.imageTool?.() : undefined;
    const guard = subWorkerGuard(worker, siblings, env.cwd);
    const cwd = worker.workspace ?? env.cwd;
    const sessionFile = env.sessionFile?.(worker.id);
    const base = { id: worker.id, name: worker.name, role: worker.role, reason: worker.reason, ...(worker.files ? { files: [...worker.files] } : {}), ...(worker.workspace ? { workspace: worker.workspace } : {}), changes: [] as string[], modelSource: specialist ? "route" as const : env.routeSource, thinkingSource: specialist ? "route" as const : verifyRoute ? env.verifyThinkingSource ?? env.thinkingSource : env.thinkingSource };
    let started = false;
    const fromStats = (stats: SpecialistStats) => ({ model: stats.model, ...(stats.thinking ? { thinking: stats.thinking } : {}), ...(started ? {} : { notStarted: true as const }), requests: stats.requests, models: { ...stats.models }, startedAt: stats.startedAt, durationMs: stats.durationMs, costUSD: stats.usage.cost, ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}), ...(stats.deadline ? { deadline: subWorkerDeadline(stats.deadline) } : {}) });
    try {
      const { value, stats } = await runSpecialistSession({
        actor: worker.id, route, runtime: env.runtime, cwd, instructions: SUB_WORKER_INSTRUCTIONS, prompt: env.prompt(worker, !!image),
        tools: [...WORKER_TOOL_NAMES, ...(image ? [image.name] : [])], ...(image ? { customTools: [image] } : {}), report: reportFor(worker.role),
        toolGuard: guard, writeFileGuard: (file, abort) => abort?.aborted ? "cancelled" : guard("ast_rewrite", { path: file }),
        maxTurns: env.maxTurns, timeoutMs: env.timeoutMs, signal, nudges: 1, onTool,
        ...(env.deadline ? { deadline: { ...env.deadline, onExtended: extension => onDeadline?.({ type: "extended", extension }), onObservation: observation => onDeadline?.({ type: "observation", observation }) } } : {}),
        onSession: use => { started = true; onModel?.(use); },
        ...(env.onSessionEvent ? { onEvent: (event: { type: string; [key: string]: unknown }) => env.onSessionEvent!(worker.id, event) } : {}),
        ...(sessionFile ? { sessionFile } : {}), ...(!specialist && env.inheritedContextWindow ? { inheritedContextWindow: env.inheritedContextWindow } : {}),
        ...(!specialist && env.lengthLadder ? { lengthRecovery: { ladder: env.lengthLadder } } : {}),
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
    } finally {
      try { env.onSessionEnd?.(worker.id); } catch { /* an observer cannot alter the outcome */ }
    }
  };
}
