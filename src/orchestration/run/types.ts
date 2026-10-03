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

import type { Liveness, LivenessTracker } from "../../agent/liveness.js";
import type { DeadlineExtension, ExtendableDeadline } from "./extension.js";
import type { SessionRecords } from "../../agent/records.js";
import type { RunLimits } from "../limits.js";
export { defaultRunLimits, type RunLimits } from "../limits.js";
export type { AgentRecordEntry, RecordedActor, RecordedKind, SessionRecords, SessionTarget } from "../../agent/records.js";
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
  /**
   * Other pi sessions were found active on this repository (or its super/sub repository) when the
   * run started. That detection is taken once, by the caller (the extension); later re-checks come from
   * {@link RunOptions.detectConcurrentActivity}. When
   * `count > 0` the run is flagged: in change/diagnose_fix runs a file that changed while a worker
   * bash call (or another non-edit/write tool) was in flight, is outside the worker's ownership and
   * was not written by an edit/write tool is classified as external ("concurrent session active;
   * ambiguous"), not as an ownership violation. Without the flag, or with `count` 0, such a file stays
   * a violation. Writes by edit/write tools outside ownership are violations either way.
   */
  concurrentActivity?: ConcurrentActivity;
  /**
   * Re-detects other pi sessions on the repository. Injected by the caller (the extension) so that this layer stays independent
   * of how sessions are found; the run calls it at each workspace audit point to learn about sessions that started after
   * `concurrentActivity` was taken. The callback owns caching (it should answer from a cache for at least 30 seconds) and must
   * not throw: a rejection or `undefined` means "no (new) information". A result with `count > 0` flags the run like
   * `concurrentActivity` does, from that audit on.
   */
  detectConcurrentActivity?: () => Promise<ConcurrentActivity | undefined>;
  /**
   * Opt-in session records (default: none, every session stays in memory). `sessionTarget` is asked for the coordinator
   * (`id: "coordinator"`), every worker including verifiers (their ids, e.g. `A1`, `V1`) and every advisor call
   * (`advisor:<name>#<n>`), and persists the session of each it answers for; `onAgent` receives one
   * {@link AgentRecordEntry} per agent when its session ended, including on failure and cancellation. The caller owns where
   * the files go (the extension keeps them outside the workspace and outside pi's own sessions directory).
   */
  records?: SessionRecords;
  /** Opt-in failed-run recovery. Transfer accepted idle workers with manager.detach / poolManager.adopt. Never called on cancellation. */
  onFailedHandover?: (handover: FailedHandover) => readonly RunHandoverWorker[] | Promise<readonly RunHandoverWorker[]>;
}
/** Result of concurrent-session detection: `detail` is the human-readable description of the sessions. */
export interface ConcurrentActivity { count: number; detail: string }
export interface FailedHandoverWorker {
  id: string;
  role: "implementer" | "verifier" | "explorer";
  lastTask?: TaskItem;
}
export interface FailedHandover {
  manager: AgentManager;
  workers: readonly FailedHandoverWorker[];
  issues: readonly string[];
}
export interface RunHandoverWorker {
  id: string;
  sourceId: string;
  role: string;
  lastTask?: TaskItem;
}
export interface RunHandover { workers: readonly RunHandoverWorker[]; issues: readonly string[] }

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
  /**
   * Deadline extensions the run was granted (a deadline that expired while the run was still actively working, pushed out by
   * `limits.extensionMs`; at most `limits.maxExtensions`, shared by all deadlines), in order. Present only when there were some;
   * each also went out as a `deadline_extended` event.
   */
  extensions?: readonly DeadlineExtension[];
  /** Signal cancellation diagnostics captured before sessions are stopped; summary stays "cancelled". */
  cancellation?: CancellationDiagnostic;
  cleanup?: { incomplete: boolean; pending: readonly string[] };
  handover?: RunHandover;
  remainingIssues?: readonly string[];
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
  /**
   * The run's deadline: `startedAt + limits.overallMs` plus the extensions granted, and the one extension budget that every deadline
   * of the run (overall and each phase cap) shares. Everything that was `startedAt + base cap` reads it (`remaining`, `bounded`,
   * the outcome waits, the cleanup budget, the diagnostics). Created with the context; a context built by hand gets one on first
   * use (see `runDeadline` in deadline.ts).
   */
  deadline: ExtendableDeadline;
  state: PhaseState;
  manager: AgentManager;
  coordinator?: AgentSession;
  /** Liveness of the coordinator session (created with it, fed from its events); absent until the coordinator exists. */
  coordinatorLiveness?: LivenessTracker;
  /**
   * Is the run still actively working? Aggregates the coordinator and every worker (see {@link Liveness} and src/agent/liveness.ts):
   * `active` when any of them had model output, a tool event, tool output or a progressing bash heartbeat within `windowMs`
   * (default `limits.activityWindowMs`, 2 minutes), or has a request / non-bash tool in flight within its bound. It is only read: the
   * deadlines ask it when they expire (see `expiry` in deadline.ts) and extend while it says active. Installed together with the
   * first session of the run (see `ensureLiveness` in context.ts); {@link runLiveness} works on any context.
   */
  liveness?: (now?: number, windowMs?: number) => Liveness;
  /** Records bookkeeping of the coordinator session (created with it); see {@link RunOptions.records}. */
  coordinatorRecord?: { startedAt: number; requests: number; models: Record<string, number>; sessionFile?: string; model: string; thinking?: string; reported?: boolean };
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
  /** Workers whose first assignment in this run already carried the identity/request/language briefing. */
  briefedWorkers?: Set<string>;
  workerAnswers: Map<string, string>;
  /** Latest reports used by deterministic completion and failed-run handover. */
  implementationSummaries?: Map<string, string>;
  verificationResult?: import("../../agent/agent-handle.js").ResultPayload;
  remainingIssues?: string[];
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
