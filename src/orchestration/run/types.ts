import type { CancellationDiagnostic, TimeoutDiagnostic } from "./deadline.js";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { NoteMessage } from "../../messaging/message.js";
import type { ProviderExtensionHost } from "../../pi/provider-extensions.js";
import type { AdvisorEngine } from "../../advisor/engine.js";
import type { PhaseState, TaskClass } from "../phases.js";
import type { TaskItem } from "../backlog.js";
import type { RouteConfig } from "../routing.js";
import type { RunEventSink } from "../events.js";
import type { WorkspaceAudit, WorkspaceChange } from "../workspace.js";
import type { TeamSettings } from "../team.js";
import type { AuditSettings } from "../artifacts.js";

import type { RunLimits } from "../limits.js";
export { defaultRunLimits, type RunLimits } from "../limits.js";
export interface RunOptions {
  problem: string;
  cwd: string;
  routes: RouteConfig;
  sink?: RunEventSink;
  modelRuntime?: ModelRuntime;
  /** Lazy runtime preparation executes inside the overall deadline (modelRuntime takes precedence). */
  createRuntime?: () => Promise<ModelRuntime>;
  limits?: Partial<RunLimits>;
  /** Overrides routes.audit settings for generated new files. */
  audit?: AuditSettings;
  /** Replaces Pi's default base system prompt for the coordinator and every worker session (not advisors); roles are still appended. */
  baseSystemPrompt?: string;
  /** Aborting cancels the run: sessions are stopped and disposed and a failed report with summary "cancelled" is returned. */
  signal?: AbortSignal;
  /**
   * Snapshot the workspace with git (default true): the baseline is kept at refs/pi-orche/baseline
   * for recovery, read-only phases and out-of-ownership writes by any means (bash included) are
   * reported as violations, and the report lists every changed file. No effect outside git.
   */
  workspaceAudit?: boolean;
}
export interface RunReport {
  status: "done" | "failed";
  summary: string;
  rootCause?: string;
  tasks: readonly TaskItem[];
  startedAt: number;
  finishedAt: number;
  ownershipViolations?: readonly OwnershipViolation[];
  /**
   * Workspace changes since the run started, from git snapshots (absent outside a git work tree).
   * `baseline` is a commit holding the pre-run contents, also kept at refs/pi-orche/baseline.
   */
  workspace?: { baseline: string; changes: readonly WorkspaceChange[] };
  taskClass: TaskClass | "unclassified";
  answer: string;
  timeouts?: readonly TimeoutDiagnostic[];
  /** Signal cancellation diagnostics captured before sessions are stopped; summary stays "cancelled". */
  cancellation?: CancellationDiagnostic;
  cleanup?: { incomplete: boolean; pending: readonly string[] };
}
/**
 * A write outside the writer's ownership that actually reached the workspace. `via: "workspace"`
 * comes from a snapshot diff (bash, generated files): `agentId` then lists every worker active
 * in that phase, since a shared working tree cannot attribute the change to one of them.
 */
export interface OwnershipViolation { agentId: string; file: string; via?: "workspace"; created?: true }
export interface RunContext {
  options: RunOptions;
  limits: RunLimits;
  /** Resolved worker team shape (routes.workers over the defaults). */
  team: TeamSettings;
  /** Resolved new-file policy (programmatic options over routes.audit). */
  auditSettings?: AuditSettings;
  startedAt: number;
  state: PhaseState;
  manager: AgentManager;
  coordinator?: AgentSession;
  decisionValue: unknown;
  decisionSet: boolean;
  activeTasks: Map<string, TaskItem>;
  violations: OwnershipViolation[];
  audit?: WorkspaceAudit;
  /** Snapshot tree the next workspace audit diffs against. */
  auditTree?: string;
  baseline?: { tree: string; commit: string };
  /** Decision schema last sent to the coordinator, to avoid resending an identical one. */
  lastSchema?: string;
  unsubscribers: (() => void)[];
  mainNotes: NoteMessage[];
  bufferedNoteIds: Set<string>;
  workerIds: string[];
  workerAnswers: Map<string, string>;
  advisors?: AdvisorEngine;
  providerHost?: Promise<ProviderExtensionHost>;
  cancelled: boolean;
  signal?: AbortSignal;
  cancel?: (reason: unknown) => void;
  stage?: string;
  timeouts?: TimeoutDiagnostic[];
  cancellation?: CancellationDiagnostic;
  reported?: boolean;
}
export interface RootCauseClaim {
  agentId: string;
  cause: string;
  via: "note" | "result";
  evidence: unknown;
}
