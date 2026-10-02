import type { TimeoutDiagnostic } from "./run/deadline.js";
import type { CoordinatorDecision, Phase, TaskClass } from "./phases.js";
import type { AdvisorTriggerKind } from "../advisor/config.js";
import type { TaskItem, TaskStatus } from "./backlog.js";
import type { ManagerEvent } from "../agent/agent-handle.js";
export type RunMode = "orchestrated" | "baseline";
export interface AdvisorNote { domain: string; text: string; evidence?: string }
export type CoordinatorEvent =
  | { type: "run_started"; timestamp: number; mode: RunMode; problem: string }
  | { type: "run_timeout"; timestamp: number; diagnostic: TimeoutDiagnostic }
  | { type: "request_classified"; timestamp: number; taskClass: TaskClass; workerCount: number; language: string; reason: string }
  | { type: "phase_changed"; timestamp: number; from: Phase | "INIT"; to: Phase }
  | { type: "coordinator_usage"; timestamp: number; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Assignment-local completed requests and latest tool; UI consumers throttle per actor. No tool content. */
  | { type: "worker_activity"; timestamp: number; agentId: string; assignmentId: string; kind: string; requestCount: number; lastToolName?: string }
  /** Run-local completed coordinator requests, including decision repairs/reconsiderations. */
  | { type: "coordinator_activity"; timestamp: number; phase: Phase; requestCount: number }
  /** Emitted before each decision prompt, including repairs. */
  | { type: "coordinator_deciding"; timestamp: number; phase: Phase }
  | { type: "coordinator_decision"; timestamp: number; phase: Phase; decisionType: CoordinatorDecision["type"]; reconsidered: boolean }
  /** Advice is now being consumed, rather than merely queued as a NOTE. */
  | { type: "coordinator_reconsidering"; timestamp: number; phase: Phase }
  | { type: "root_cause_claimed"; timestamp: number; agentId: string; cause: string; via: "note" | "result" }
  | { type: "root_cause_accepted"; timestamp: number; agentId: string; cause: string }
  | { type: "preempted"; timestamp: number; agentId: string; action: "redirect" | "stop" }
  | { type: "backlog_created"; timestamp: number; tasks: readonly TaskItem[] }
  | { type: "task_dispatched"; timestamp: number; taskId: string; agentId: string }
  | { type: "task_finished"; timestamp: number; taskId: string; agentId: string; status: TaskStatus }
  /** A write that reached the workspace outside ownership; `via: "workspace"` comes from a git snapshot diff. */
  | { type: "ownership_violation"; timestamp: number; agentId: string; file: string; ownerTaskIds: readonly string[]; via?: "workspace"; created?: true }
  /** A write-tool call stopped before it ran (outside ownership or during a read-only assignment). */
  | { type: "ownership_blocked"; timestamp: number; agentId: string; tool: string; file: string; ownerTaskIds: readonly string[] }
  /** New generated output outside ownership; warned and listed, not a violation. */
  | { type: "workspace_unowned_file"; timestamp: number; agentId: string; file: string }
  | { type: "workspace_baseline"; timestamp: number; commit: string }
  | { type: "workspace_audit_unavailable"; timestamp: number; reason: string }
  | { type: "verification"; timestamp: number; passed: boolean; round: number; summary: string }
  | { type: "advisor_triggered"; timestamp: number; name: string; target: string; trigger: AdvisorTriggerKind; subject: string; await: boolean }
  | { type: "advisor_result"; timestamp: number; name: string; target: string; trigger: AdvisorTriggerKind; verdict: "ok" | "concern" | "blocker"; notes: readonly AdvisorNote[]; delivered: boolean }
  | { type: "advisor_failed"; timestamp: number; name: string; target: string; trigger: AdvisorTriggerKind; reason: string }
  | { type: "context_window"; timestamp: number; actor: string; model: string; contextWindow: number; advertisedContextWindow: number; extended: boolean }
  | { type: "advisor_usage"; timestamp: number; name: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "run_finished"; timestamp: number; status: "done" | "failed"; summary: string };
export type RunEvent = ManagerEvent | CoordinatorEvent;
export type RunEventSink = (event: RunEvent) => void;
