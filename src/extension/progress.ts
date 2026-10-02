import type { RunEvent } from "../orchestration/events.js";
import { CREATED_FILE_ADVICE } from "../orchestration/artifacts.js";

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
    case "run_timeout":
      return `${event.diagnostic.scope} timeout at ${event.diagnostic.stage} (${event.diagnostic.elapsedMs}ms; cap ${event.diagnostic.effectiveCapMs}ms)`;
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
