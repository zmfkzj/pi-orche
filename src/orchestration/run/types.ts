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
import type { WorkspaceActivity } from "./activity.js";

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
  workspace?: {
    baseline: string;
    /** Run-attributed changes only. */
    changes: readonly WorkspaceChange[];
    /**
     * Changes made outside this run (another session, the user, a commit elsewhere), with the reason.
     * Present only when non-empty. They are never violations and must not be restored.
     */
    external?: Array<WorkspaceChange & { reason: string }>;
  };
  taskClass: TaskClass | "unclassified";
  answer: string;
  /** The `answer` was produced by a run that ended `failed` (violation, timeout, error): it may be incomplete. */
  answerFromFailedRun?: boolean;
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
  /**
   * `head`: HEAD commit when the run started (absent on an unborn branch), to detect commits made
   * elsewhere during the run. `headRead` is false when HEAD could not be read at the start.
   */
  baseline?: { tree: string; commit: string; head?: string; headRead?: boolean };
  /**
   * Worker tool-activity tracker: in-flight write-capable tool executions, files written by
   * edit/write, and which changed files appeared in quiet vs active windows. Created together with
   * the workspace audit; absent when the audit is off.
   */
  activity?: WorkspaceActivity;
  /** Changes attributed to somebody else, by file; never violations. Reported as `workspace.external`. */
  externalChanges?: Map<string, WorkspaceChange & { reason: string }>;
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
