import type { RunEvent } from "../orchestration/events.js";
import { formatExtensionProgress, type DeadlineExtension, type ExtendableDeadline } from "../orchestration/run/extension.js";
import { CREATED_FILE_ADVICE } from "../orchestration/artifacts.js";

/**
 * Timing of a running or finished orche_run / orche_task, for the TUI timer (render.ts). UI-only data: it travels in `details`
 * (partial updates and the final result) and never in the text the model reads.
 */
export interface DeadlineInfo {
  /** The base cap (no extensions), ms. */
  baseMs: number;
  /** The overall cap now: the base plus the extensions granted so far, ms. Shown as `/ 30m`. */
  capMs: number;
  /** The overall deadline now (epoch ms): the clock the cap is counted from, plus {@link DeadlineInfo.capMs}. */
  deadlineAt: number;
  /** Length of one extension, ms. */
  extensionMs: number;
  /** Extensions granted so far / allowed (`limits.maxExtensions`; 0 when extending is off). Shown as `ext 1/10`. */
  extensionsUsed: number;
  maxExtensions: number;
  /** The most the call can last: the base plus the whole extension budget (`overallMs + maxExtensions × extensionMs`), ms. */
  hardLimitMs: number;
}

/** `details.startedAt` / `details.finishedAt` / `details.deadline` of every partial update and of the final result. */
export interface RunTiming {
  /** When execution started (epoch ms): the origin of the timer. */
  startedAt: number;
  /** When it ended (epoch ms); only in the final result. The final duration is `finishedAt - startedAt`. */
  finishedAt?: number;
  /** The deadline as it stands; absent when it is not known. */
  deadline?: DeadlineInfo;
}

/** The deadline of a call that has just started: the base cap, no extension granted yet. `startedAt` is the clock the cap is counted from. */
export function initialDeadline(baseMs: number, policy: { extensionMs: number; maxExtensions: number }, startedAt: number): DeadlineInfo {
  const enabled = policy.maxExtensions > 0 && policy.extensionMs > 0;
  return {
    baseMs, capMs: baseMs, deadlineAt: startedAt + baseMs, extensionMs: policy.extensionMs,
    extensionsUsed: 0, maxExtensions: policy.maxExtensions, hardLimitMs: baseMs + (enabled ? policy.maxExtensions * policy.extensionMs : 0),
  };
}

/** What {@link extendDeadline} needs of an extension: a `deadline_extended` event (`extension` is `n`, `maxExtensions` is `max`) or a {@link DeadlineExtension}. */
export type ExtensionStep = Pick<DeadlineExtension, "n" | "max" | "extensionMs" | "scope"> & { overallDeadline?: number | undefined };

/**
 * The deadline after an extension. `overallDeadline` (epoch ms, after the extension) gives the new cap exactly: `overallDeadline - startedAt`
 * (`startedAt`: the clock the deadline runs from). Without it (a hand-made event) the overall and assignment deadlines grow by one extension and
 * a phase cap, which does not move the overall deadline, changes nothing.
 */
export function extendDeadline(deadline: DeadlineInfo, extension: ExtensionStep, startedAt: number): DeadlineInfo {
  const deadlineAt = extension.overallDeadline ?? (extension.scope === "phase" ? deadline.deadlineAt : deadline.deadlineAt + extension.extensionMs);
  return {
    ...deadline, deadlineAt, capMs: deadlineAt - startedAt, extensionMs: extension.extensionMs,
    extensionsUsed: extension.n, maxExtensions: extension.max,
  };
}

/** The deadline of a live {@link ExtendableDeadline} (an orche_task assignment's own deadline): its base, cap and extensions as they stand. */
export function deadlineInfoOf(deadline: Pick<ExtendableDeadline, "baseOverallMs" | "overallCapMs" | "overallDeadline" | "extensionMs" | "used" | "maxExtensions" | "hardLimitMs">): DeadlineInfo {
  return {
    baseMs: deadline.baseOverallMs, capMs: deadline.overallCapMs, deadlineAt: deadline.overallDeadline, extensionMs: deadline.extensionMs,
    extensionsUsed: deadline.used, maxExtensions: deadline.maxExtensions, hardLimitMs: deadline.hardLimitMs,
  };
}

/** The `startedAt` / `finishedAt` / `deadline` details keys of `timing` (nothing for undefined). */
export function timingDetails(timing: RunTiming | undefined): Partial<RunTiming> {
  return timing ? { startedAt: timing.startedAt, ...(timing.finishedAt !== undefined ? { finishedAt: timing.finishedAt } : {}), ...(timing.deadline ? { deadline: { ...timing.deadline } } : {}) } : {};
}

/**
 * The tool update for the progress `lines` (newest last): the lines as text and as `details.progress`, plus the timing keys when known. The
 * text is what the TUI and RPC clients show while the call runs; the model only ever sees the final result.
 */
export function partialUpdate(lines: readonly string[], timing?: RunTiming): { content: { type: "text"; text: string }[]; details: { progress: readonly string[] } & Partial<RunTiming> } {
  return { content: [{ type: "text", text: lines.join("\n") }], details: { progress: lines, ...timingDetails(timing) } };
}

/** One short human line per notable run event; undefined for events that are not worth showing. */
export function describeProgress(event: RunEvent): string | undefined {
  switch (event.type) {
    case "worker_activity":
      return `${event.agentId} ${event.kind} · ${event.requestCount} requests${event.lastToolName ? ` · last tool: ${event.lastToolName}` : ""}`;
    case "coordinator_activity":
      return `coordinator deciding (${event.phase}) · ${event.requestCount} requests`;
    case "coordinator_deciding":
      return `coordinator deciding (${event.phase})`;
    case "coordinator_reconsidering":
      return "coordinator reconsidering after advisor notes";
    case "run_timeout": {
      // Why the deadline was not extended (no activity in the window / budget used up) is part of the line.
      const why = event.diagnostic.extensions?.notExtended?.message;
      return `${event.diagnostic.scope} timeout at ${event.diagnostic.stage} (${event.diagnostic.elapsedMs}ms; cap ${event.diagnostic.effectiveCapMs}ms)${why ? `: ${why}` : ""}`;
    }
    case "deadline_extended":
      return formatExtensionProgress({ n: event.extension, max: event.maxExtensions, extensionMs: event.extensionMs, reasons: event.reasons });
    case "request_classified":
      return `classified as ${event.taskClass} with ${event.workerCount} worker${event.workerCount === 1 ? "" : "s"}`;
    case "phase_changed":
      return `phase ${event.to}`;
    case "root_cause_accepted":
      return `root cause accepted from ${event.agentId}`;
    case "backlog_created":
      return `backlog of ${event.tasks.length} task${event.tasks.length === 1 ? "" : "s"}`;
    case "task_dispatched":
      return `${event.agentId} started ${event.taskId}`;
    case "task_finished":
      return `${event.taskId} ${event.status}`;
    case "verification":
      return `verification ${event.passed ? "passed" : "failed"} (round ${event.round})`;
    case "result_rejected":
      return `${event.agentId} ${event.kind} RESULT rejected (attempt ${event.attempt})`;
    case "ownership_violation":
      if (event.created) return `ownership violation: ${event.agentId} created unowned source file ${event.file}. ${CREATED_FILE_ADVICE}`;
      return event.via === "workspace"
        ? `ownership violation: ${event.file} changed during work by ${event.agentId}`
        : `ownership violation: ${event.agentId} wrote ${event.file}`;
    case "ownership_blocked":
      return `blocked ${event.agentId} ${event.tool} on ${event.file}`;
    case "request_budget":
      return event.action === "notice" ? undefined : `${event.agentId} request budget ${event.action === "stop" ? "exhausted; forcing a report" : "exceeded; assignment failed"}`;
    case "workspace_unowned_file":
      return `new unowned file ${event.file} (listed in the report)`;
    case "workspace_external_change":
      return `warning: external change (not this run): ${event.file} — ${event.reason}`;
    case "concurrent_sessions_detected":
      return `⚠ other pi session activity detected during the run: ${event.count} session${event.count === 1 ? "" : "s"} active in this repository (${event.detail}); changes made while a worker command ran are classified as external where the writer is ambiguous`;
    case "workspace_audit_unavailable":
      return `workspace audit off: ${event.reason}`;
    case "advisor_result":
      if (event.verdict === "ok") return undefined;
      const delivery = !event.delivered ? "not delivered"
        : event.target === "coordinator" || event.target === "main" ? "delivered → queued for the coordinator's next decision"
        : `delivered → queued for ${event.target}'s next turn`;
      return `advisor ${event.name}: ${event.verdict} → ${delivery}`;
    case "advisor_failed":
      return `advisor ${event.name} failed: ${event.reason}`;
    default:
      return undefined;
  }
}
