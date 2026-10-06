/** Session API: construct WorkerPool({controller, agentDir?, idleTtlMs?}), register
 * orcheTaskParameters with execute(args), and call dispose() on session_shutdown.
 * execute accepts OrcheRunArgs plus task parameters; onProgress feeds tool updates/UI. A task whose worker ran but failed, timed
 * out or was cancelled rejects with TaskFailedError (the message a plain Error would have had, plus structured details);
 * executeTool() is execute() as a tool result, with such a failure returned as an isError result that keeps the details.
 * formatWorkers(), stop(id|"all") and roster() implement the pool slash commands. */
import { Type, type Static } from "@sinclair/typebox";
import { getAgentDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentManager, type WorkerAdoptOptions } from "../agent/agent-manager.js";
import type { FailedHandover, RunHandoverWorker } from "../orchestration/run/types.js";
import type { AgentSnapshot } from "../agent/agent-handle.js";
import { normalizeOwnedPath, type TaskItem } from "../orchestration/backlog.js";
import { checkWriteRealPath, WRITE_TOOLS, WRITING_KINDS } from "../orchestration/ownership.js";
import { resolveRunLimits } from "../orchestration/limits.js";
import { taskWorkerInstructions } from "../orchestration/prompts.js";
import { orchestrationResultSchemas, requirementDefinitions, requirementIds, requiredChecklistError, type Ambiguity, type ChecklistItem } from "../orchestration/result-schemas.js";
import { createTaskPlanTool, renderTaskPlan, type TaskPlan } from "../tools/task-plan.js";
import { configureTaskWorkflow, enableTaskWorkflow, taskCompactionSettings, type CompactionStats } from "../pi/session-factory.js";
import { withExtendedContext } from "../pi/extended-context.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveRoute, resolveSpecialistRoute, type MainMode } from "../orchestration/routing.js";
import { WorkspaceAudit, type GitlinkChange, type WorkspaceChange } from "../orchestration/workspace.js";
import { WorkspaceActivity } from "../orchestration/run/activity.js";
import { CHANGED_WHILE_QUIET } from "../orchestration/run/audit.js";
import { WORKER_TOOL_NAMES } from "../tools/index.js";
import { DEFAULT_LIVENESS_WINDOW_MS, KNOWN_TOOL_TIMEOUTS_MS, mergeLiveness, type Liveness, type SessionLiveness } from "../agent/liveness.js";
import { createGenerateImageTool } from "../tools/generate-image.js";
import { loadProviderExtensions, type ProviderExtensionHost } from "../pi/provider-extensions.js";
import { ensureBundledImageProvider } from "../pi/register-bundled-image-provider.js";
import { describeSource, discoverOrcheConfig, NoRouteError } from "./config.js";
import { OrcheController, recordsIgnorePaths, routesSummary, withConcurrentWarning, withRecordLine, type OrcheRunArgs } from "./controller.js";
import type { ConcurrentActivitySummary } from "./concurrent-sessions.js";
import { errorToolResult, failureReason, type ErrorToolResult, type ToolFailure, type ToolFailureKind } from "./tool-result.js";
import { deadlineInfoOf, initialDeadline, type DeadlineInfo, type RunTiming } from "./progress.js";
import { createRunRecord, pruneRecordsOnce, resolveRecords, workerSessionFile } from "./records.js";
import { ExtendableDeadline, extensionEvent, formatExtensionProgress, formatExtensionSummary, waitExtendable, withNotExtended, type DeadlineExtension } from "../orchestration/run/extension.js";
import { createAssignmentProjector, type ContextClearedStats } from "../pi/context-projection.js";
import { recordFailure, recordHandoff, recordResult, renderLedgerForWorker, renderLedgerSummary, renderResumeBriefing, startLedger, type LedgerEvent, type TaskLedger } from "../single/ledger.js";
import { ORCHESTRATOR_TEAM_LINE, orchestratorSection, SPLIT_FORMAT, splitError, splitOf, type SplitDecision } from "../orchestrator/instructions.js";
import { createSpawnTool, scopePaths, SPAWN_TOOL, type PlannedWorker, type SpawnContext, type SpawnReason, type SubWorkerOutcome } from "../orchestrator/spawn.js";
import { createSubWorkerRunner } from "../orchestrator/sub-worker.js";

export const orcheTaskParameters = Type.Object({
  role: Type.Union([Type.Literal("explore"), Type.Literal("answer"), Type.Literal("implement"), Type.Literal("verify"), Type.Literal("game-asset"), Type.Literal("video")]),
  request: Type.String({ minLength: 1, description: "Self-contained goal, decisions, constraints and acceptance checks; the worker does not see the conversation. In the single workflow include Intent/Purpose, a testable R1..Rn requirements checklist, Constraints and non-goals, explicit Assumptions and a final Original request section with the user's text verbatim. Pass references, not copies: repository paths with line ranges/symbols, reproduction commands, artifact/run-record paths. Only short decisive irreproducible snippets inline; never whole files, diffs or long logs." }),
  context: Type.Optional(Type.String({ maxLength: 30_000, description: "Background findings and decisions, appended to request. Pass references, not copies: repository paths with line ranges/symbols, reproduction commands, artifact/run-record paths. Only short decisive irreproducible snippets (exact errors or user text); never whole files, diffs or long logs." })),
  worker: Type.Optional(Type.String()),
  files: Type.Optional(Type.Array(Type.String())),
  task: Type.Optional(Type.String({ pattern: "^T[1-9][0-9]*$", description: "Task ledger id (T1, T2, …) named in an earlier result. Pass it for a follow-up of that same task, also when another or a new worker takes it over; omit it for a different user task, even when reusing a worker. Used only when single.ledger is on." })),
  git: Type.Optional(Type.Object({
    commit: Type.Optional(Type.Boolean({ description: "Authorize git commit for this assignment." })),
    push: Type.Optional(Type.Boolean({ description: "Authorize git push (implies commit). Never force-push." })),
    remote: Type.Optional(Type.String({ minLength: 1, description: "Push remote; origin when only branch is given; omit both to push the current branch to its upstream." })),
    branch: Type.Optional(Type.String({ minLength: 1, description: "Push branch; the current branch when omitted." })),
  }, {
    additionalProperties: false,
    description: "Git grant for THIS assignment only, allowed for implement, game-asset and video (rejected for explore, answer, verify). Set it only when the user explicitly asked in this conversation to commit and/or push; otherwise omit it and the worker will not commit. Scope the commit to this task's files where possible (pass files and name them in request).",
  })),
});
export type TaskParameters = Static<typeof orcheTaskParameters>;
export type TaskRole = TaskParameters["role"];
// Extension-supplied effective mode; omitted SDK callers retain legacy routing/instructions.
type TaskArgs = Omit<OrcheRunArgs, "model"> & TaskParameters & { mainMode?: MainMode; model?: { provider: string; id: string; contextWindow?: number } };
/** A change the worker is not credited with, and why. */
export type OtherChange = WorkspaceChange & { reason: string };
/** HEAD of the task cwd's repository moved during the task (`from` absent: unborn branch; `branch` absent: detached). */
export interface HeadMove {
  from?: string;
  to?: string;
  /** Commits reachable from `to` but not from `from`; `commits` lists at most 20 (`git log --oneline`, newest first). */
  commitCount: number;
  commits: string[];
  branch?: string;
}
/** A submodule whose HEAD moved (or that appeared or went away: `from`/`to` absent) during the task; `path` is relative to the task cwd. */
export interface SubmoduleMove extends HeadMove { path: string }
export interface TaskDetails {
  worker: string;
  role: TaskRole;
  status: string;
  /** Model route of the worker (`provider/model`), when known. */
  model?: string;
  thinking?: ThinkingLevel;
  checklist?: ChecklistItem[];
  /** Requirements the worker reported as ambiguous, with the reading it implemented. */
  ambiguities?: Ambiguity[];
  plan?: TaskPlan;
  compactions?: { count: number; events: CompactionStats[] };
  warnings?: string[];
  durationMs: number;
  /**
   * When the assignment started and ended (epoch ms; `finishedAt - startedAt` is `durationMs`) and its deadline as it stood at the end (cap, extensions
   * used / allowed). UI-only, like the same keys of every partial update (see {@link RunTiming}). Absent in results recorded before they existed.
   */
  startedAt?: number;
  finishedAt?: number;
  deadline?: DeadlineInfo;
  requests: number;
  /** Changed by this worker: paths written by its edit/write tools plus changes made while one of its write-capable tool calls ran. Submodule files are `sub/file`. Always empty for read-only roles. */
  changes: WorkspaceChange[];
  /** Workspace changes observed during the task that are not attributed to this worker (they may come from other sessions or processes). */
  otherChanges: OtherChange[];
  /** Present when a submodule HEAD (gitlink) changed during the task. */
  submodules?: SubmoduleMove[];
  /** Present when HEAD of the task cwd's repository moved during the task, with or without a git grant. */
  headMoved?: HeadMove;
  roster: string;
  retired?: string[];
  /** Other pi sessions that were active on the repository when the task started. */
  concurrentSessions?: ConcurrentActivitySummary;
  /** Present when the assignment carried a git grant: the commits it created and whether a push was detected. */
  git?: GitReport;
  /** The record directory of this assignment (`<agent dir>/orche/records/<session>/<timestamp>_task-<id>`: `run.json`); the worker's transcript is the one session file it keeps across its assignments. Absent when records are off. */
  record?: string;
  /** Present when the assignment's deadline was extended because the worker was still active (see src/orchestration/run/extension.ts): every extension granted, in order. */
  extensions?: DeadlineExtension[];
  /** Newly cleared original results/reasoning at this assignment's start. */
  contextCleared?: ContextClearedStats;
  /** Present when the assignment timed out with extensions enabled: why the expired deadline was not extended (`idle`: no activity in the activity window; `budget`: all extensions used). */
  notExtended?: { reason: "idle" | "budget"; message: string };
  /** The task ledger this assignment belongs to (single workflow with `single.ledger`; see src/single/ledger.ts). */
  task?: string;
  /** Present when the named worker was gone and the task continued with this new worker, briefed from its ledger. */
  continuedFrom?: string;
  /** The orchestrator's split decision (single workflow with `single.spawn`, implement/answer): none, or the criteria it split by and why. */
  split?: SplitDecision;
  /** The sub-workers its orche_spawn calls ran (docs/orchestrator.md), in order; their transcripts are in the record. */
  spawned?: SpawnedWorker[];
}
/** One sub-worker in a task result: what it was for, how it ended and what it cost (the full report went to the orchestrator). */
export type SpawnedWorker = Omit<SubWorkerOutcome, "data" | "summary"> & { summary: string };
/** The workspace/git part of a task's details. */
type ChangeReport = Pick<TaskDetails, "changes" | "otherChanges" | "submodules" | "headMoved">;

/**
 * A task whose worker ran but did not complete its assignment: the worker failed or ended without a result, the
 * assignment timed out, or the task was cancelled. Arguments, unknown workers, a busy controller or startup errors
 * before any worker ran stay plain errors.
 *
 * It is an Error whose message is exactly the text a plain throw had, so callers that only catch errors see no
 * difference. A thrown error loses its structured data in the SDK (the agent loop records `details: {}`), so the
 * tool layer turns it into a returned error result with {@link TaskFailedError.toolResult} (see tool-result.ts):
 * `details` is the TaskDetails of the assignment that ran (model, requests, duration, changes, other changes, HEAD
 * movement, git report, ...) and `failure` the compact reason.
 */
export class TaskFailedError extends Error {
  override readonly name = "TaskFailedError";
  constructor(message: string, readonly details: TaskDetails, readonly failure: ToolFailure) { super(message); }
  /** `isError: true`, `content` = the message, `details` = the TaskDetails plus `failure`. */
  toolResult(): ErrorToolResult<TaskDetails, ToolFailure> { return errorToolResult(this.message, this.details, this.failure); }
}

/** Raised inside executeAssignment once the worker was given its assignment and that assignment did not complete; it becomes a {@link TaskFailedError} there. */
class WorkerFailure extends Error {
  constructor(message: string, readonly kind: ToolFailureKind, readonly status: string) { super(message); }
}
/** The text the controller throws for a cancelled task. */
const CANCELLED_TEXT = /^cancelled( by user)?$/;
/** orche_spawn outside an orchestrator assignment (another role, a sub-worker, `single.spawn` off): refused by the tool and the guard. */
const SPAWN_UNAVAILABLE = "orche_spawn is available only to the orchestrator of a single-workflow implement or answer assignment (single.spawn on); do the work yourself.";
interface Worker {
  id: string;
  role: TaskRole;
  cwd: string;
  files?: readonly string[];
  /** `provider/model` of the worker's route. */
  model?: string;
  thinking?: ThinkingLevel;
  singleWorkflow?: boolean;
  taskWorkflowInstalled?: boolean;
  requirementDefinitions?: Map<string, string>;
  requirementIds?: string[];
  request?: string;
  plan?: TaskPlan;
  unmetStreak?: Map<string, number>;
  compactions?: CompactionStats[];
  recordEvent?: (event: Record<string, unknown>) => void;
  /** Tool-activity tracker of the assignment in flight (write roles only; the spawn callbacks resolve it at event time). */
  activity?: WorkspaceActivity;
  /** HEAD at the end of the previous assignment (`sha` absent: unborn), for the stale-context prefix. */
  head?: { sha?: string };
  summary: string;
  lastUsed: number;
  tree?: string;
  contextWindow?: number;
  imageConfig?: string;
  latestInput: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The task ledger of this worker's task (single workflow with `single.ledger`), read when the worker compacts. */
  taskId?: string;
  ledger?: () => TaskLedger | undefined;
  /** Extra RESULT validation of the current assignment (the orchestrator's split decision); cleared when it ends. */
  roundCheck?: (kind: string, data: unknown) => string | undefined;
  /** The session has orche_spawn (single-workflow workers spawned by this pool). */
  spawnTool?: boolean;
  /** The orche_spawn context of the orchestrator assignment in flight; absent otherwise (the tool then refuses). */
  spawn?: SpawnContext;
}

function taskCompactionFor(worker: Worker) {
  return {
    essentials: () => {
      const ledger = worker.ledger?.();
      return `Requirements checklist and original request, verbatim:\n${worker.request ?? ""}\n\nTask DAG at compaction time:\n${worker.plan ? renderTaskPlan(worker.plan) : "No Task DAG recorded in this assignment."}${ledger ? `\n\n${renderLedgerForWorker(ledger)}` : ""}`;
    },
    onCompact: (stats: CompactionStats) => { (worker.compactions ??= []).push(stats); worker.recordEvent?.({ type: "compaction", timestamp: Date.now(), worker: worker.id, ...stats }); },
  };
}
export interface WorkerPoolOptions {
  controller: OrcheController;
  agentDir?: string;
  idleTtlMs?: number;
  /** Upper bound for a cooperative SDK abort (test seam). */
  stopTimeoutMs?: number;
  /** Receives every task-ledger event (the extension persists each as a session entry). Best effort: a throwing callback is ignored. */
  onLedgerEvent?: (event: LedgerEvent) => void;
}

// ---- git grant: validation, the line every assignment prompt carries, and the read-only commit/push report ----
const execFileAsync = promisify(execFile);
/** Roles that may write, hence the only ones that can be allowed to commit. */
export const GIT_GRANT_ROLES: readonly string[] = ["implement", "game-asset", "video"];
/** Commit lines listed in a result; `commitCount` keeps the true number. */
const MAX_COMMITS = 20;
const MAX_GITLINKS = 10;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
const BRANCH_NAME = /^[A-Za-z0-9_][\w./+-]{0,199}$/;

/** The validated grant: `commit` is always true (push implies it); `remote` is set whenever `branch` is. */
export interface GitGrant {
  commit: true;
  push: boolean;
  remote?: string;
  branch?: string;
}
/** What a granted assignment did to the repository (TaskDetails.git). */
export interface GitReport {
  grant: GitGrant;
  /** False outside a git work tree (or when git fails): nothing below is known. */
  available: boolean;
  /** HEAD when the task started / ended (absent: unborn branch or unreadable) and the branch it ended on (absent: detached). */
  headBefore?: string;
  headAfter?: string;
  branch?: string;
  /** Commits reachable from the final HEAD but not from the starting one; `commits` lists at most 20 of them (`git log --oneline`, newest first). */
  commitCount: number;
  commits: string[];
  /** Submodule gitlinks that differ between the starting and the final HEAD: `path (old → new)`. */
  gitlinks: string[];
  /** Whether a remote-tracking ref (the upstream, or the granted target) moved to a commit now contained in HEAD. */
  push: "detected" | "not-detected" | "unknown";
  /** The remote-tracking refs that were compared; `pushed`: the ref moved to a commit now contained in HEAD. */
  refs: { ref: string; before?: string; after?: string; pushed: boolean }[];
}
interface GitBaseline {
  available: boolean;
  head?: string;
  refs: Map<string, string | undefined>;
}

/** Validate the `git` argument for `role`. Undefined: no grant (not given, or it enables nothing). */
export function resolveGitGrant(role: string, input: TaskParameters["git"]): GitGrant | undefined {
  if (input === undefined) return undefined;
  if (!GIT_GRANT_ROLES.includes(role)) throw new Error(`Unsupported git grant for role ${role}; only ${GIT_GRANT_ROLES.join(", ")} may commit or push. Omit git for read-only roles.`);
  if (input.push === true && input.commit === false) throw new Error("Unsupported git grant: push requires commit; omit commit or set it to true.");
  if (input.push !== true && (input.remote !== undefined || input.branch !== undefined)) throw new Error("Unsupported git grant: remote and branch apply only with push true.");
  if (input.remote !== undefined && !REMOTE_NAME.test(input.remote)) throw new Error(`Unsupported git grant remote ${JSON.stringify(input.remote)}; use a remote name such as origin.`);
  if (input.branch !== undefined && (!BRANCH_NAME.test(input.branch) || input.branch.includes("..") || input.branch.endsWith("/") || input.branch.endsWith(".lock"))) {
    throw new Error(`Unsupported git grant branch ${JSON.stringify(input.branch)}; use a plain branch name such as main.`);
  }
  const push = input.push === true;
  if (!push && input.commit !== true) return undefined;
  const remote = input.remote ?? (input.branch !== undefined ? "origin" : undefined);
  return { commit: true, push, ...(remote ? { remote } : {}), ...(input.branch !== undefined ? { branch: input.branch } : {}) };
}

const pushTarget = (grant: GitGrant) => grant.remote && grant.branch ? `${grant.remote}/${grant.branch}` : grant.remote ? `${grant.remote} (current branch)` : "the current branch's upstream";
/** The line that ends every assignment prompt: an explicit authorization, or an explicit refusal. Reused workers keep
 * their system instruction, so each assignment states its own grant and a later one without it says so. */
export function gitAssignmentLine(grant: GitGrant | undefined): string {
  if (!grant) return "Git commit/push is NOT authorized for this assignment; do not commit.";
  return `This assignment authorizes git commit${grant.push ? ` and push to ${pushTarget(grant)}` : ""}. Commit only the changes this assignment describes (stage paths explicitly; never \`git add -A\` of unrelated files); do not force-push, rewrite history, or change git config.${grant.push ? " Push only to that target." : " Do not push."} This authorization applies to this assignment only.`;
}

/** Read-only, bounded and fail-soft: undefined when git fails; an abort still propagates. */
async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, signal, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return stdout.trim();
  } catch {
    signal?.throwIfAborted(); // cancellation must not look like "git failed"
    return undefined;
  }
}
const rev = async (cwd: string, ref: string, signal?: AbortSignal) => (await git(cwd, ["rev-parse", "--verify", "-q", ref], signal)) || undefined;
const short = (sha: string | undefined) => sha ? sha.slice(0, 7) : "none";
const remoteRef = (ref: string) => ref.replace(/^refs\/remotes\//, "");

/** Remote-tracking refs whose movement means a push: the upstream, and the granted target when it names one. */
async function trackedRefs(cwd: string, grant: GitGrant, signal?: AbortSignal): Promise<string[]> {
  const names = new Set<string>();
  const upstream = await git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"], signal);
  if (upstream?.startsWith("refs/")) names.add(upstream);
  if (grant.push && (grant.remote || grant.branch)) {
    const branch = grant.branch ?? await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], signal);
    if (branch) names.add(`refs/remotes/${grant.remote ?? "origin"}/${branch}`);
  }
  return [...names];
}

/** HEAD (and, with a grant, the tracked remote refs) before the worker starts (`available: false` when git cannot say). */
async function captureGitBaseline(cwd: string, grant: GitGrant | undefined, signal?: AbortSignal): Promise<GitBaseline> {
  if (await git(cwd, ["rev-parse", "--is-inside-work-tree"], signal) !== "true") return { available: false, refs: new Map() };
  const head = await rev(cwd, "HEAD", signal);
  const refs = new Map<string, string | undefined>();
  if (grant) for (const name of await trackedRefs(cwd, grant, signal)) refs.set(name, await rev(cwd, name, signal));
  return { available: true, ...(head ? { head } : {}), refs };
}

/** Submodule entries (mode 160000) that differ between two commits; the diff output cap bounds the cost. */
async function changedGitlinks(cwd: string, from: string, to: string): Promise<string[]> {
  const raw = await git(cwd, ["-c", "core.quotepath=false", "diff-tree", "-r", "--raw", "--no-renames", "--no-commit-id", from, to]);
  const links: string[] = [];
  for (const line of raw?.split("\n") ?? []) {
    const [meta = "", path = ""] = line.split("\t");
    const [oldMode, newMode, oldSha, newSha] = meta.slice(1).split(" ");
    if (oldMode !== "160000" && newMode !== "160000") continue;
    const sha = (value: string | undefined) => value && /[^0]/.test(value) ? short(value) : "none";
    links.push(`${path} (${sha(oldSha)} → ${sha(newSha)})`);
  }
  return links;
}

/** Commits reachable from `to` but not from `from` (all of `to` when `from` is unborn): the true count and at most 20 `git log --oneline` lines, newest first. Fail-soft. */
async function commitsBetween(cwd: string, from: string | undefined, to: string): Promise<{ commitCount: number; commits: string[] }> {
  const range = from ? `${from}..${to}` : to;
  const log = await git(cwd, ["log", "--no-color", "--no-decorate", "--no-show-signature", "--oneline", `--max-count=${MAX_COMMITS}`, range]);
  const commits = log ? log.split("\n") : [];
  const count = Number.parseInt(await git(cwd, ["rev-list", "--count", range]) ?? "", 10);
  return { commitCount: Number.isFinite(count) ? Math.max(count, commits.length) : commits.length, commits };
}

/** Commits, gitlinks and push evidence since `baseline`. Never throws: unreadable parts are left out or "unknown". */
async function reportGit(cwd: string, grant: GitGrant, baseline: GitBaseline): Promise<GitReport> {
  const empty: GitReport = { grant, available: false, commitCount: 0, commits: [], gitlinks: [], push: "unknown", refs: [] };
  if (!baseline.available) return empty;
  try {
    const headAfter = await rev(cwd, "HEAD");
    const branch = await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
    let commitCount = 0;
    let commits: string[] = [];
    let gitlinks: string[] = [];
    if (headAfter && headAfter !== baseline.head) {
      ({ commitCount, commits } = await commitsBetween(cwd, baseline.head, headAfter));
      if (baseline.head) gitlinks = (await changedGitlinks(cwd, baseline.head, headAfter)).slice(0, MAX_GITLINKS);
    }
    const names = new Set(baseline.refs.keys());
    const upstream = await git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    if (upstream?.startsWith("refs/")) names.add(upstream);
    const refs: GitReport["refs"] = [];
    for (const ref of names) {
      const before = baseline.refs.get(ref);
      const after = await rev(cwd, ref);
      // Moved: a push puts HEAD (or one of its ancestors) there; a fetch of someone else's commits does not.
      const pushed = !!after && after !== before && !!headAfter && (after === headAfter || await git(cwd, ["merge-base", "--is-ancestor", after, headAfter]) !== undefined);
      refs.push({ ref, ...(before ? { before } : {}), ...(after ? { after } : {}), pushed });
    }
    return {
      grant, available: true,
      ...(baseline.head ? { headBefore: baseline.head } : {}), ...(headAfter ? { headAfter } : {}), ...(branch ? { branch } : {}),
      commitCount, commits, gitlinks, push: refs.length ? refs.some(item => item.pushed) ? "detected" : "not-detected" : "unknown", refs,
    };
  } catch {
    return empty;
  }
}

/** Result lines for a report. Bounded: at most 20 commits, 10 gitlinks and one line per compared ref. */
export function formatGitReport(report: GitReport): string[] {
  if (!report.available) return ["Git: commit/push report unavailable (not a git work tree, or git failed)"];
  const lines: string[] = [];
  const { headBefore, headAfter } = report;
  if (report.commitCount > 0) {
    lines.push(`Git: ${report.commitCount} commit${report.commitCount === 1 ? "" : "s"} created on ${report.branch ?? "a detached HEAD"} (${headBefore ? short(headBefore) : "unborn"} → ${short(headAfter)}):`);
    lines.push(...report.commits.map(commit => `  ${commit}`));
    if (report.commitCount > report.commits.length) lines.push(`  … ${report.commitCount - report.commits.length} more`);
  } else if (headAfter !== headBefore) {
    lines.push(`Git: HEAD moved ${short(headBefore)} → ${short(headAfter)} without new commits (reset or checkout?)`);
  } else {
    lines.push(`Git: no commits created (HEAD ${headAfter ? `still ${short(headAfter)}` : "unborn"})`);
  }
  if (report.gitlinks.length) lines.push(`Submodule gitlinks changed: ${report.gitlinks.join(", ")}`);
  if (report.push === "detected") {
    lines.push(`Push: detected (${report.refs.filter(item => item.pushed).map(item => `${remoteRef(item.ref)} ${short(item.before)} → ${short(item.after)}`).join(", ")})${report.grant.push ? "" : "; the grant did not authorize push"}`);
  } else if (report.grant.push) {
    lines.push(report.push === "unknown"
      ? "Push: cannot be detected (no upstream or remote-tracking ref); check the remote"
      : `Push: not detected (${report.refs.map(item => item.after && item.after !== item.before ? `${remoteRef(item.ref)} moved ${short(item.before)} → ${short(item.after)}, not to a commit of this HEAD` : `${remoteRef(item.ref)} still at ${short(item.after)}`).join(", ")})`);
  }
  return lines;
}

// ---- what a task changed: attribution, HEAD movement and the lines of the result ----
/** Why a change of a read-only role is not the worker's: no edit/write call can succeed for it, and its shell calls are not tracked. */
const READ_ONLY_ROLE = "read-only role: not attributed to the worker";
const NO_GRANT_NOTE = "; commits were not authorized for this assignment, so they may come from another session or process";
const OTHER_CHANGES_NOTE = "not attributed to this worker; they may come from other sessions or processes";
const CONCURRENT_NOTE = " (may include changes made by the other pi session(s); check before attributing them to this task)";
/** Files spelled out per list in the result text (`details` keeps all of them). */
const MAX_LISTED_FILES = 50;

/**
 * Split the net changes of one assignment into the worker's and the rest. Changes of the worker: paths
 * written by a successful edit/write call, and changes that appeared while a write-capable tool call (bash,
 * ast_rewrite, ...) of the worker was in flight, since such a call can write any file (ambiguous ones stay
 * the worker's, exactly as in the run audit). Changes seen only while none of its tools ran cannot be
 * its own. A read-only role cannot edit, so nothing is attributed to it. Between two assignments of a reused
 * worker no tool of it runs, so the stale-context changes are never its own either.
 */
function attributeChanges(changes: readonly WorkspaceChange[], activity: WorkspaceActivity | undefined, readOnly: boolean): { own: WorkspaceChange[]; other: OtherChange[] } {
  const own: WorkspaceChange[] = [];
  const other: OtherChange[] = [];
  for (const change of changes) {
    const reason = readOnly ? READ_ONLY_ROLE : activity?.touchedOnlyQuiet(change.path) ? CHANGED_WHILE_QUIET : undefined;
    if (reason) other.push({ ...change, reason });
    else own.push(change);
  }
  return { own, other };
}

/** HEAD of the task cwd's repository now versus the baseline; undefined when it did not move or git cannot say. Never throws. */
async function headMovement(cwd: string, baseline: GitBaseline | undefined): Promise<HeadMove | undefined> {
  if (!baseline?.available) return undefined;
  try {
    const to = await rev(cwd, "HEAD");
    if (!to || to === baseline.head) return undefined;
    const branch = await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
    return { ...(baseline.head ? { from: baseline.head } : {}), to, ...await commitsBetween(cwd, baseline.head, to), ...(branch ? { branch } : {}) };
  } catch {
    return undefined;
  }
}

/** The commits behind each changed gitlink (bounded to 10; git runs inside the submodule). Never throws. */
async function submoduleMoves(cwd: string, links: readonly GitlinkChange[]): Promise<SubmoduleMove[]> {
  const moves: SubmoduleMove[] = [];
  for (const link of links.slice(0, MAX_GITLINKS)) {
    const counted = link.from && link.to ? await commitsBetween(resolve(cwd, link.path), link.from, link.to).catch(() => undefined) : undefined;
    moves.push({ path: link.path, ...(link.from ? { from: link.from } : {}), ...(link.to ? { to: link.to } : {}), commitCount: counted?.commitCount ?? 0, commits: counted?.commits ?? [] });
  }
  return moves;
}

const commitNoun = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;
/** `HEAD moved a..b (N commits)` and the commit lines (at most 20). `label` is "HEAD" or `Submodule <path>: HEAD`. */
function moveLines(label: string, move: HeadMove, suffix = ""): string[] {
  const range = `${short(move.from)}..${short(move.to)}`;
  return [
    `${label} moved ${range} (${move.commitCount > 0 ? commitNoun(move.commitCount) : "no new commits; reset or checkout?"})${suffix}`,
    ...move.commits.map(commit => `  ${commit}`),
    ...(move.commitCount > move.commits.length ? [`  … ${move.commitCount - move.commits.length} more`] : []),
  ];
}
function submoduleLines(moves: readonly SubmoduleMove[]): string[] {
  return moves.flatMap(move => !move.to ? [`Submodule ${move.path}: removed (was ${short(move.from)})`]
    : !move.from ? [`Submodule ${move.path}: added (HEAD ${short(move.to)})`]
    : moveLines(`Submodule ${move.path}: HEAD`, move));
}
const listPaths = (changes: readonly WorkspaceChange[]) =>
  `${changes.slice(0, MAX_LISTED_FILES).map(change => change.path).join(", ")}${changes.length > MAX_LISTED_FILES ? `, … ${changes.length - MAX_LISTED_FILES} more` : ""}`;

/**
 * The change section of a task result. "No files changed" appears only when there is nothing to report at all: no
 * file change (the worker's or anyone's), no gitlink change and no HEAD movement. With a git grant the `Git:` lines
 * already describe the commits of the task cwd's repository, so its HEAD movement is not repeated here.
 */
export function formatTaskChanges(report: Pick<TaskDetails, "changes" | "otherChanges" | "submodules" | "headMoved">, options: { concurrentWarning?: boolean; grant?: boolean } = {}): string[] {
  const { changes, otherChanges, submodules = [], headMoved } = report;
  if (!changes.length && !otherChanges.length && !submodules.length && !headMoved) return ["No files changed"];
  return [
    changes.length ? `Changed files: ${listPaths(changes)}${options.concurrentWarning ? CONCURRENT_NOTE : ""}`
      : `Changed files: none${otherChanges.length ? " attributed to this worker" : ""}`,
    ...(otherChanges.length ? [`Other workspace changes observed during the task (${OTHER_CHANGES_NOTE}): ${listPaths(otherChanges)}`] : []),
    ...(headMoved && !options.grant ? moveLines("HEAD", headMoved, NO_GRANT_NOTE) : []),
    ...submoduleLines(submodules),
  ];
}

/**
 * The stale-context section for a reused worker: what changed since its previous assignment ended, none of it by this
 * worker (the same split as in the result, with an empty "changed by this worker" list). Undefined: no audit.
 */
function formatStaleContext(report: (Pick<TaskDetails, "submodules" | "headMoved"> & { changes: readonly WorkspaceChange[] }) | undefined): string {
  const { changes = [], submodules = [], headMoved } = report ?? {};
  const files = changes.slice(0, MAX_LISTED_FILES).map(change => `${change.path} (${change.status})`);
  if (changes.length > MAX_LISTED_FILES) files.push(`… ${changes.length - MAX_LISTED_FILES} more`);
  const lines = [
    ...(files.length ? [`Changed while none of your assignments was running (${OTHER_CHANGES_NOTE}):`, ...files] : []),
    ...(headMoved ? moveLines("HEAD", headMoved) : []),
    ...submoduleLines(submodules),
  ];
  const body = !report ? "Workspace audit unavailable (not a git work tree)." : lines.length ? lines.join("\n") : "No files changed.";
  return `## Stale context: workspace changes since your previous assignment\n${body}\nRe-read changed evidence before relying on retained context.\n\n`;
}

/** A report's `data` as a record (anything else: empty). */
const dataOf = (data: unknown): Record<string, unknown> => data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};

/**
 * The prompt of one assignment. `orchestrate` (single workflow with `single.spawn`, implement/answer): the worker is the task's
 * orchestrator, decides whether to split first (src/orchestrator/instructions.ts) and reports the decision in `data.split`.
 * orche_spawn's sub-workers get the same role texts without the single workflow (no task_plan, no checklist).
 */
export function assignmentPrompt(args: Pick<TaskParameters, "role" | "request" | "context" | "files"> & { mainMode?: MainMode; orchestrate?: boolean }, commands: readonly string[], imagesAvailable = false, grant?: GitGrant, extraInstructions = ""): string {
  const task = args.context?.trim() ? `${args.request}\n\n## Context from the requesting session\n${args.context.trim()}` : args.request;
  const scope = args.files === undefined ? "anywhere inside the workspace" : JSON.stringify(args.files);
  const split = args.orchestrate ? `,${SPLIT_FORMAT}` : "";
  const instructions: Record<TaskRole, string> = {
    explore: 'Investigate independently, read source and reproduce. DO NOT EDIT. Report findings with concrete evidence and optionally data.cause. report_result {kind:"explore",summary,data:{cause,evidence}}.',
    answer: `Strictly read-only.${args.orchestrate ? " First decide whether to split the question (Orchestration below; sub-workers of a read-only task are read-only too)." : ""} Inspect relevant files and provide an evidence-backed answer, concrete code references and explanations. Never change files. report_result {kind:"answer",summary:FULL_EVIDENCED_ANSWER,data:{evidence${args.mainMode === "single" ? ',checklist:[{id:"R1",status:"met" or "unmet" or "partial",evidence:"concrete evidence"}]' : ""}${split}}}.${args.mainMode === "single" ? " Checklist is required when the request contains R-ids." : ""}`,
    implement: args.mainMode === "single"
      ? `Own the task end to end${args.orchestrate ? " as its orchestrator: first decide whether to split it (Orchestration below), then" : ": first"} analyse the requirements and create the Task DAG with task_plan, covering every requirement id. If a requirement can be read more than one way with observably different behaviour, choose the reading closest to the Original request text, implement it, and report it in data.ambiguities. Then execute nodes sequentially in dependency order, updating statuses, implementing completely, adding or updating tests, running the project's relevant checks and iterating until they pass, preserving unrelated changes. Main does not intervene while you run. Write scope: ${scope}. Finish with report_result {kind:"implement",summary,data:{status:"done" or "blocked",reason,evidence:[checks],checklist:[{id:"R1",status:"met" or "unmet" or "partial",evidence:"concrete evidence",verifiedBy:"test name or check command that asserts this requirement's acceptance and passed"}],ambiguities:[{id:"R2",readings:["reading A","reading B"],chosen:"reading A"}]${split}}}. Checklist is required when the request contains R-ids; every met item needs verifiedBy, otherwise report it partial. ambiguities may be omitted when there are none.`
      : `Implement completely, preserving unrelated changes. Write scope: ${scope}. Run local checks on touched files. report_result {kind:"implement",summary,data:{status:"done" or "blocked",reason,evidence:[checks]}}.`,
    "game-asset": `Game asset production. Create or modify game assets (sprites, sprite sheets/atlases, tilesets, textures, icons/UI art, 3D models, animations, VFX, SFX/music, fonts, and their engine import/metadata files) inside the write scope ${scope}. First detect the engine and the project's conventions (Unity .meta, Godot .import/.tres, Unreal, Phaser/Pixi atlas JSON; existing naming, folder layout, resolution/pixels-per-unit, palette, pivot/origin, power-of-two, compression). Produce assets with locally available tools via bash (check command -v first: ImageMagick, Inkscape, Blender --background with Python, Aseprite --batch, ffmpeg, sox, Python Pillow/numpy, or hand-written SVG/procedural scripts); keep reusable generator scripts with the assets when the project has a place for them, and leave no temp files in the workspace. Never hand-fabricate binary bytes. Verify every output is valid (identify/file/ffprobe/blender), and view raster outputs or rendered previews with the read tool. Do not download third-party assets unless the request allows it; record source and license when you do. report_result {kind:"game-asset",summary,data:{status:"done" or "blocked",reason,outputs:[{path,type,spec}],evidence:[checks]}}. spec is a descriptive string.`,
    video: `Video production. Plan and produce video deliverables inside the write scope ${scope}: script/storyboard/shot list, editing and compositing, motion graphics (code-based such as Remotion, Motion Canvas or manim when the project uses them), subtitles (SRT/VTT), audio mixing and loudness normalization, thumbnails and final encodes. Use locally available tools via bash (check command -v first: ffmpeg/ffprobe, the project's own video tooling, Python, ImageMagick, sox). Render a short draft before long renders; make final encode settings explicit (container, video codec, resolution, fps, CRF/bitrate, pixel format, audio codec/sample rate, loudness target). Verify every output with ffprobe (duration, streams, resolution, fps) and inspect extracted frames with the read tool. Leave no intermediate files in the workspace unless requested. report_result {kind:"video",summary,data:{status:"done" or "blocked",reason,outputs:[{path,type,spec}],evidence:[checks]}}. spec is a descriptive string.`,
    verify: `Independent read-only review. DO NOT EDIT. ${commands.length ? `Run configured checks via bash: ${commands.map(command => JSON.stringify(command)).join(", ")}` : "Discover and run the project's own checks via bash (package.json, Makefile, pyproject.toml, Cargo.toml, go.mod or CI config)"}, plus focused checks; inspect source and git diff. report_result {kind:"verify",summary,data:{passed:boolean,evidence:[commands and outcomes],issues:[{file,description}]}}. passed:true requires actual passing checks; unexecuted checks never count as passed.`,
  };
  const rasterInstructions = imagesAvailable ? '\nUse generate_image for raster art (sprites, textures, icons, concept art, thumbnails). Request background "transparent" for sprites/icons. Always pass width/height for the exact target size: the gateway ignores size and returns roughly 1254x1254. Use kernel "nearest" for pixel art. Inspect results with read. Keep procedural/SVG generation for vector or pixel-exact assets. Record the generation prompt in outputs[].spec.' : "";
  // An orchestrator is not told it works alone: "You work alone" read as a ban on sub-workers (evaluation v2, docs/orchestrator.md 9).
  return `Assignment: ${args.role}. ${args.orchestrate ? ORCHESTRATOR_TEAM_LINE : "You work alone; there are no peers or backlog."}\n${task}\n\n${instructions[args.role]}${rasterInstructions}${extraInstructions ? `\n${extraInstructions}` : ""}\nStart summary with the conclusion (1–3 sentences), then evidence as path:line references and command outcomes. Do not paste code, diffs or logs the reader can open. Answer summaries stay complete but cite code by location instead of long quotes.\n\n${gitAssignmentLine(grant)}`;
}

/** The system instructions of an orche_task worker session; `spawn`: the session has orche_spawn (single workflow, `single.spawn`). */
export function workerSystemInstructions(spawn: boolean): string {
  return `${taskWorkerInstructions}\n${spawn ? "There are no peer workers; you start sub-workers only with orche_spawn, when an assignment's Orchestration rules call for it." : "You work alone: there are no peer workers."} Reply in the language of the request.`;
}

/** The prompt of one orche_spawn sub-worker: its role text, who spawned it and why, and (verification) that it has not seen the work. */
export function subWorkerPrompt(worker: PlannedWorker, orchestrator: string, commands: readonly string[], imagesAvailable: boolean): string {
  const preface = `You are sub-worker ${worker.id} ("${worker.name}") of orchestrator ${orchestrator}, spawned for ${worker.reason}. You cannot spawn workers.${worker.reason === "verification" ? " You have not seen how the work was done: judge only from the request below, the repository and your own checks." : ""}`;
  return assignmentPrompt({ role: worker.role, request: `${preface}\n\n${worker.request}`, ...(worker.files ? { files: worker.files } : {}) }, commands, imagesAvailable)
    .replace("You work alone; there are no peers or backlog.", "You work alone on this assignment.");
}

export class WorkerPool {
  private manager?: AgentManager;
  private readonly workers = new Map<string, Worker>();
  private readonly providers = new Map<string, ProviderExtensionHost>();
  private nextId = 1;
  /** Task ledgers by task id (single workflow with `single.ledger`), including tasks whose worker is gone. */
  private readonly ledgers = new Map<string, TaskLedger>();
  private nextTaskId = 1;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly options: WorkerPoolOptions) {
    if (!Number.isFinite(options.idleTtlMs ?? 1) || (options.idleTtlMs ?? 1) < 0) throw new Error("idleTtlMs must be finite and nonnegative");
  }
  /** Keep failed-run sessions intact; new W ids share the pool's collision-free sequence. */
  async adoptFailedRun(handover: FailedHandover, cwd: string, assignmentRequests: number, signal?: AbortSignal): Promise<RunHandoverWorker[]> {
    if (this.disposed || signal?.aborted) return [];
    const runtime = await this.options.controller.modelRuntime(signal).catch(error => { if (signal?.aborted) return undefined; throw error; });
    if (!runtime || this.disposed || signal?.aborted) return [];
    this.manager ??= new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas, stopTimeoutMs: this.options.stopTimeoutMs });
    this.manager.setRequestBudget(assignmentRequests);
    const roles = { implementer: "implement", verifier: "verify", explorer: "explore" } as const;
    // Recovery may exceed the new-worker cap (3) to retain every offered session; idle TTL still applies.
    return handover.workers.map(source => {
      const id = `W${this.nextId++}`;
      const session = handover.manager.session(source.id);
      const worker: Worker = { id, role: roles[source.role], cwd,
        ...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
        summary: source.lastTask?.description ?? "", lastUsed: Date.now(), latestInput: 0 };
      this.manager!.adopt(handover.manager.detach(source.id), { id, role: worker.role, ...this.callbacks(worker) });
      this.workers.set(id, worker);
      this.idle(worker);
      return { id, sourceId: source.id, role: worker.role, ...(source.lastTask ? { lastTask: source.lastTask } : {}) };
    });
  }
  /**
   * Ledgers restored from the session (its start, a reload or a resume). Their workers are gone; an orche_task that names the
   * task continues it with a new worker briefed from the ledger. Replaces the current set.
   */
  restoreLedgers(ledgers: readonly TaskLedger[]): void {
    this.ledgers.clear();
    for (const source of ledgers) {
      const ledger = structuredClone(source);
      if (ledger.primary) ledger.primary.live = this.workers.has(ledger.primary.worker);
      this.ledgers.set(ledger.taskId, ledger);
      const task = /^T(\d+)$/.exec(ledger.taskId)?.[1];
      if (task) this.nextTaskId = Math.max(this.nextTaskId, Number(task) + 1);
      // Never give a restored task's worker id to a new worker: the main session's earlier results still name the old ones.
      for (const name of [ledger.primary?.worker, ...ledger.history.map(item => item.worker)]) {
        const worker = /^W(\d+)$/.exec(name ?? "")?.[1];
        if (worker) this.nextId = Math.max(this.nextId, Number(worker) + 1);
      }
    }
  }
  /** The main-session summary of the task ledgers (newest first); undefined without any. */
  ledgerSummary(): string | undefined {
    return renderLedgerSummary([...this.ledgers.values()]);
  }
  /** The ledger of `task`, if known. */
  ledger(task: string): TaskLedger | undefined {
    return this.ledgers.get(task);
  }
  /** The most recently updated task that `worker` took. */
  private lastTaskOf(worker: string): TaskLedger | undefined {
    return [...this.ledgers.values()].filter(ledger => ledger.primary?.worker === worker).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  private persist(event: LedgerEvent): void {
    try { this.options.onLedgerEvent?.(structuredClone(event)); } catch { /* persistence is best effort */ }
  }
  private callbacks(worker: Worker): Pick<WorkerAdoptOptions, "toolGuard" | "writeFileGuard" | "onToolExecution" | "onContextWindow" | "validateResult"> {
    return {
      onContextWindow: info => { worker.contextWindow = info.contextWindow; },
      validateResult: (kind, data) => {
        const round = worker.roundCheck?.(kind, data);
        if (round) return round;
        if (!["implement", "answer"].includes(kind)) return undefined;
        const ids = worker.singleWorkflow ? worker.requirementIds ?? [] : [];
        return ids.length || (data && typeof data === "object" && "checklist" in data) ? requiredChecklistError(ids, data, kind === "implement" && ids.length > 0) : undefined;
      },
      toolGuard: async (name, input) => {
        if (name === "task_plan" && !worker.singleWorkflow) return "task_plan is available only for standard single-workflow task assignments.";
        if (name === SPAWN_TOOL && !worker.spawn) return SPAWN_UNAVAILABLE;
        const blocked = await this.guard(worker, name, input);
        if (blocked) return blocked;
        await worker.activity?.enter(worker.id, name);
        return undefined;
      },
      writeFileGuard: (file, signal) => signal?.aborted ? "cancelled" : this.guard(worker, "ast_rewrite", { path: file }),
      // Resolve the current assignment's tracker at event time, including its closing snapshot.
      onToolExecution: event => worker.activity?.record(worker.id, event),
    };
  }
  list(): AgentSnapshot[] {
    return [...this.workers.values()].map(worker => ({ ...this.manager!.get(worker.id), role: worker.role }));
  }
  session(id: string) { return this.manager!.session(id); }
  /**
   * Liveness of the pool's task workers (see src/agent/liveness.ts): `sessions` has one entry per live worker, `active` when any worker
   * running an assignment had model output, a tool event, tool output or a progressing bash heartbeat within `windowMs`, or has a
   * request / non-bash tool in flight within its bound. Idle workers are listed but never active. Read-only.
   */
  liveness(now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS): Liveness {
    return this.manager ? this.manager.liveness(now, windowMs, [...this.workers.keys()]) : mergeLiveness();
  }
  /** {@link liveness} of one task worker; undefined for an unknown (or already retired) worker. */
  workerLiveness(id: string, now: number = Date.now(), windowMs: number = DEFAULT_LIVENESS_WINDOW_MS): SessionLiveness | undefined {
    return this.manager && this.workers.has(id) ? this.manager.workerLiveness(id, now, windowMs) : undefined;
  }
  roster(): string {
    return this.list().map(worker => `${worker.id} ${worker.status} (${worker.role}: ${this.workers.get(worker.id)!.summary.slice(0, 80) || "no result yet"})`).join(", ") || "no workers";
  }
  formatWorkers(): string {
    return this.list().map(worker => {
      const meta = this.workers.get(worker.id)!;
      return `${worker.id} ${worker.status} · ${meta.role} · ${worker.completedAssignments} assignments · last: ${meta.summary.slice(0, 80) || "no result yet"} · idle ${Math.floor((Date.now() - meta.lastUsed) / 60_000)}m`;
    }).join("\n") || "no workers";
  }
  private async retire(id: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) return;
    clearTimeout(worker.timer);
    this.workers.delete(id);
    for (const ledger of this.ledgers.values()) if (ledger.primary?.worker === id) ledger.primary.live = false;
    await this.manager?.dispose(id);
  }
  private idle(worker: Worker): void {
    clearTimeout(worker.timer);
    worker.lastUsed = Date.now();
    if (this.disposed || !this.workers.has(worker.id)) return;
    worker.timer = setTimeout(() => {
      if (this.manager?.get(worker.id).status === "idle") void this.retire(worker.id).catch(() => undefined);
    }, this.options.idleTtlMs ?? 30 * 60_000);
    worker.timer.unref();
  }
  async stop(id: string): Promise<string> {
    const ids = id === "all" ? [...this.workers.keys()] : this.workers.has(id) ? [id] : [];
    if (!ids.length) return id === "all" ? "no workers" : `unknown worker ${id}`;
    await Promise.all(ids.map(worker => this.retire(worker)));
    return `Disposed workers: ${ids.join(", ")}`;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const worker of this.workers.values()) clearTimeout(worker.timer);
    this.manager?.close();
    this.disposal = (async () => {
      await this.manager?.dispose();
      this.workers.clear();
      for (const host of this.providers.values()) host.dispose();
      this.providers.clear();
    })();
    return this.disposal;
  }
  private async guard(worker: Worker, toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
    if (!WRITE_TOOLS.has(toolName)) return undefined;
    let files = worker.files;
    // With no explicit scope, use the concrete requested target as ownership. checkWrite
    // still enforces assignment kind, an explicit path, and workspace containment.
    if (files === undefined && typeof input.path === "string") {
      const path = relative(worker.cwd, resolve(worker.cwd, input.path));
      files = path && !isAbsolute(path) && path.split(sep)[0] !== ".." ? [normalizeOwnedPath(path) + "/", normalizeOwnedPath(path)] : [];
    }
    const tasks: TaskItem[] = [{ id: worker.id, owner: worker.id, description: "Single-worker assignment", files: files ?? [], status: "running" }];
    return (await checkWriteRealPath({ toolName, input, cwd: worker.cwd, agentId: worker.id, assignmentKind: worker.role, tasks }))?.reason;
  }
  /**
   * Run one assignment. Resolves with the result text and details; rejects with a plain Error before a worker ran
   * (arguments, unknown or busy worker, startup), and with a {@link TaskFailedError} when a worker ran and the task failed,
   * timed out or was cancelled. A worker that completed and reported `blocked` or `passed: false` resolves (details.status).
   */
  execute(args: TaskArgs): Promise<{ text: string; details: TaskDetails }> {
    // The details of the assignment that ran, once one did: the controller replaces whatever the callback threw when the
    // task is cancelled, even after the assignment completed.
    let ran: TaskDetails | undefined;
    return this.options.controller.task(args.signal, async signal => {
      const reused = args.worker ? this.workers.get(args.worker) : undefined;
      if (reused) clearTimeout(reused.timer);
      try {
        const result = await this.executeAssignment(args, signal);
        ran = result.details;
        return result;
      } catch (error) {
        if (error instanceof TaskFailedError) ran = error.details;
        throw error;
      } finally { if (reused && this.workers.has(reused.id) && this.manager?.get(reused.id).status === "idle") this.idle(reused); }
    }).catch((error: unknown): never => {
      if (ran && !(error instanceof TaskFailedError) && error instanceof Error && CANCELLED_TEXT.test(error.message)) {
        throw new TaskFailedError(error.message, { ...ran, status: "cancelled" }, {
          kind: "cancelled", status: "cancelled", reason: error.message, ...(error.message.endsWith("by user") ? { cancelledByUser: true as const } : {}),
        });
      }
      throw error;
    });
  }
  /**
   * {@link execute} as an orche_task tool result: the text and details on success; for a {@link TaskFailedError} an
   * `isError` result with the same text and the structured details; anything else still rejects.
   */
  async executeTool(args: TaskArgs): Promise<AgentToolResult<TaskDetails> | ErrorToolResult<TaskDetails>> {
    try {
      const result = await this.execute(args);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    } catch (error) {
      if (error instanceof TaskFailedError) return error.toolResult();
      throw error;
    }
  }
  private async executeAssignment(args: TaskArgs, signal: AbortSignal): Promise<{ text: string; details: TaskDetails }> {
    if (this.disposed) throw new Error("Worker pool is disposed");
    const grant = resolveGitGrant(args.role, args.git); // before any worker is touched: a bad grant spawns and changes nothing
    const started = Date.now();
    const workflowMode = args.mainMode === "single";
    const singleWorkflow = workflowMode && ["explore", "answer", "implement", "verify"].includes(args.role);
    const inheritMain = singleWorkflow;
    const modelWarnings: string[] = [];
    const retired: string[] = [];
    const retirementLines: string[] = [];
    const files = WRITING_KINDS.has(args.role) && args.files !== undefined ? scopePaths(args.files) : undefined;
    let worker = args.worker ? this.workers.get(args.worker) : undefined;
    const gone = !!args.worker && !worker;
    const unknownWorker = () => {
      const live = this.list().map(item => `${item.id} (${item.status}, ${item.role})`).join(", ") || "none";
      const last = args.worker ? this.lastTaskOf(args.worker) : undefined;
      const hint = last ? ` ${args.worker} last worked on task ${last.taskId}: pass task "${last.taskId}" (and omit worker) to continue it with a new worker briefed from its ledger.` : "";
      return new Error(`Unknown worker ${args.worker}; live workers: ${live}. Omit worker to start a new one.${hint}`);
    };
    // A gone worker (reload, idle expiry, pool eviction) can be named only together with a task it worked on (checked below, with the config).
    if (gone && !(singleWorkflow && args.task)) throw unknownWorker();
    if (worker && this.manager!.get(worker.id).status !== "idle") throw new Error(`Worker ${worker.id} is running; wait for its assignment to finish.`);
    let assigned = false;
    let stopPromise: Promise<void> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { if (assigned && worker) stopPromise ??= this.manager!.stop(worker.id).catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
    const sessionModel = args.model ? `${args.model.provider}/${args.model.id}` : undefined;
    const agentDir = this.options.agentDir ?? getAgentDir();
    const config = await discoverOrcheConfig({ cwd: args.cwd, agentDir, projectTrusted: args.projectTrusted, session: { model: sessionModel, thinking: args.thinking } });
    signal.throwIfAborted();
    // Task ledgers (single.ledger): `task` continues a task, also with another or a new worker; without it every assignment starts a new task.
    const ledgerOn = singleWorkflow && config.single.ledger;
    const ledgerNotes: string[] = [];
    // The orchestrator (docs/orchestrator.md): implement/answer workers of the single workflow decide whether to split and may run
    // sub-workers with orche_spawn. `single.spawn: false` keeps the earlier single worker.
    const orchestrate = singleWorkflow && config.single.spawn && (args.role === "implement" || args.role === "answer");
    let continued: TaskLedger | undefined;
    if (args.task !== undefined && ledgerOn) {
      continued = this.ledgers.get(args.task);
      if (!continued) throw new Error(`Unknown task ${args.task}; known tasks: ${[...this.ledgers.keys()].join(", ") || "none"}. Omit task to start a new task.`);
      if (gone && continued.primary?.worker !== args.worker && !continued.history.some(item => item.worker === args.worker)) throw unknownWorker();
    } else if (args.task !== undefined) {
      if (gone) throw unknownWorker();
      ledgerNotes.push(`Note: task ${args.task} ignored: task ledgers apply to single-workflow standard roles with single.ledger on.`);
    }
    // Records (records.ts): one record per assignment, outside the workspace; the worker's transcript is one stable file per worker.
    const resolved = resolveRecords({ agentDir, cwd: args.cwd, settings: config.records });
    void pruneRecordsOnce(resolved);
    // At the start, and again when the task ends, before its change note is written. A task has no ownership audit that could
    // classify the other session's writes, so the warning is all it can do: it goes first in the result, in the progress lines and
    // in a note beside the changed files.
    const tracker = await this.options.controller.trackConcurrent(args, config.concurrentSessions, signal, recordsIgnorePaths(resolved));
    let concurrent = tracker.initial;
    let warning = concurrent?.warning;
    const recheckConcurrent = async () => {
      const latest = await tracker.recheck(); // never throws; served from the start's detection when that is recent
      if (latest) { concurrent = latest; warning = latest.warning; }
    };
    const limits = resolveRunLimits(config.routes.limits);
    // The deadline the UI shows next to the elapsed time: the assignment's own, from the same limits. Replaced by the live ExtendableDeadline's state
    // once the worker has its assignment (see below), and after each extension.
    let deadlineInfo: DeadlineInfo = initialDeadline(limits.assignmentMs, limits, started);
    const timingNow = (): RunTiming => ({ startedAt: started, deadline: deadlineInfo });
    args.onTiming?.(timingNow(), warning ? [warning] : []);
    const startup = new AbortController();
    startupTimer = setTimeout(() => startup.abort(new Error(`Worker startup timed out after ${limits.assignmentMs}ms`)), Math.max(0, limits.assignmentMs - (Date.now() - started)));
    const startupSignal = AbortSignal.any([signal, startup.signal]);
    const runtime = await this.options.controller.modelRuntime(startupSignal);
    if (this.disposed) throw new Error("Worker pool is disposed");
    signal.throwIfAborted();

    if (config.routes.providerExtensions?.length) {
      const key = JSON.stringify(config.routes.providerExtensions);
      if (!this.providers.has(key)) {
        const host = await loadProviderExtensions(runtime, config.routes.providerExtensions, { cwd: args.cwd, agentDir: this.options.agentDir, signal: startupSignal });
        if (this.disposed) { host.dispose(); throw new Error("Worker pool is disposed"); }
        this.providers.set(key, host);
      }
    }
    const images = args.role === "game-asset" || args.role === "video" ? config.routes.images : undefined;
    const imageConfig = images ? JSON.stringify(images) : undefined;
    // The bundled cliproxyapi-images provider is registered lazily: only for game-asset/video with images configured,
    // after providerExtensions (which may already provide it); otherwise no provider config or credential file is read.
    ensureBundledImageProvider({ runtime, images, agentDir: this.options.agentDir ?? getAgentDir() });
    // Tools cannot be unregistered from a session. Recreate only when this optional
    // capability changes, so neither tool registration nor old instructions leak roles.
    if (worker && worker.imageConfig !== imageConfig) {
      await this.retire(worker.id);
      retired.push(worker.id);
      retirementLines.push(`${worker.id} retired: image tool configuration changed; starting a fresh worker.`);
      worker = undefined;
    }
    const reusedContext = !!worker;
    this.manager ??= new AgentManager(runtime, { resultSchemas: orchestrationResultSchemas, stopTimeoutMs: this.options.stopTimeoutMs });
    this.manager.setRequestBudget(limits.assignmentRequests);
    const routeRole = args.role === "answer" ? "analyst" : args.role === "explore" ? config.routes.workers?.explorerRoles?.[0] ?? "explorer-path" : args.role === "implement" ? "implementer" : args.role === "verify" ? "verifier" : args.role;
    const mainModel = inheritMain && args.model ? runtime.getModel(args.model.provider, args.model.id) : undefined;
    const mainWindow = args.model?.contextWindow ?? mainModel?.contextWindow ?? 0;
    const route = mainModel
      ? { role: routeRole, model: sessionModel!, thinking: args.thinking ?? "off", extendedContext: false }
      : worker && (!inheritMain || !args.model && this.manager.session(worker.id).model) ? this.manager.get(worker.id).route
      : args.role === "game-asset" || args.role === "video"
        ? resolveSpecialistRoute(config.routes, routeRole, (provider, id) => !!runtime.getModel(provider, id))
        : resolveRoute(config.routes, routeRole);
    if (inheritMain && args.model && !mainModel) modelWarnings.push(`Warning: main model ${sessionModel} is unresolvable in orche's runtime; falling back to configured route ${route.model}.`);
    if (inheritMain && !args.model) modelWarnings.push(worker && this.manager.session(worker.id).model
      ? "Warning: main model is absent; keeping this worker's current model and thinking."
      : `Warning: main model is absent; using configured route ${route.model}.`);
    if (config.source.kind === "session" && args.model && !runtime.getModel(args.model.provider, args.model.id)) throw new NoRouteError(
      `The session model ${sessionModel} cannot be resolved by orche's own model runtime (it does not see providers that other Pi extensions register, nor in-memory credentials). Route orche explicitly in ${args.cwd}/.pi/orche.config.json, and list the provider's Pi package in "providerExtensions" if the provider comes from an extension (see docs/pi-package.md).`,
    );
    if (worker && inheritMain && (args.model || !this.manager.session(worker.id).model)) {
      const session = this.manager.session(worker.id);
      const catalog = runtime.getModel(route.model.slice(0, route.model.indexOf("/")), route.model.slice(route.model.indexOf("/") + 1));
      if (!catalog) throw new Error(`Cannot switch ${worker.id}: model ${route.model} is unavailable; omit worker to start a new worker.`);
      const resolvedModel = withExtendedContext(catalog, route.extendedContext).model;
      const effective = mainModel && mainWindow > resolvedModel.contextWindow ? { ...resolvedModel, contextWindow: mainWindow } : resolvedModel;
      try {
        if (session.model?.provider !== effective.provider || session.model?.id !== effective.id || session.model?.contextWindow !== effective.contextWindow) await session.setModel(effective);
        if (session.thinkingLevel !== (route.thinking ?? "off")) session.setThinkingLevel(route.thinking ?? "off");
        worker.model = `${session.model!.provider}/${session.model!.id}`;
        worker.thinking = session.thinkingLevel;
        worker.contextWindow = session.model!.contextWindow;
        if (worker.singleWorkflow) session.settingsManager.applyOverrides({ compaction: taskCompactionSettings(worker.contextWindow) });
      } catch (error) { throw new Error(`Cannot switch model/thinking for ${worker.id}: ${String(error)}. Omit worker to start a new worker.`); }
    }
    if (!worker) {
      if (this.workers.size >= 3) {
        const oldest = [...this.workers.values()].filter(item => this.manager!.get(item.id).status === "idle").sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!oldest) throw new Error("All three workers are busy; wait for an idle worker.");
        await this.retire(oldest.id);
        retired.push(oldest.id);
        retirementLines.push(`${oldest.id} retired: least-recently-used idle worker (pool cap 3).`);
      }
      const id = `W${this.nextId++}`;
      // The worker's one transcript, for all of its assignments: <records>/<session>/workers/<id>-<spawn time>.jsonl.
      const sessionFile = workerSessionFile(resolved, { ...(args.currentSession?.id ? { parentSessionId: args.currentSession.id } : {}), workerId: id, spawnedAt: Date.now() });
      // orche_spawn only with `single.spawn` on: `single.spawn: false` keeps the earlier single worker's tool set exactly.
      const spawnTool = singleWorkflow && config.single.spawn;
      worker = { id, role: args.role, cwd: args.cwd, files, summary: "", lastUsed: Date.now(), latestInput: 0, imageConfig, singleWorkflow, taskWorkflowInstalled: singleWorkflow, spawnTool };
      const meta = worker;
      meta.model = route.model;
      meta.thinking = route.thinking ?? "off";
      const customTools = [...(images ? [createGenerateImageTool({ cwd: args.cwd, runtime, images })] : []), ...(singleWorkflow ? [createTaskPlanTool(plan => {
        meta.plan = plan;
        meta.recordEvent?.({ type: "task_plan", timestamp: Date.now(), worker: meta.id, plan });
      }, () => meta.requirementIds ?? [])] : []),
      // orche_spawn: registered once per session; usable only while an orchestrator assignment set `meta.spawn` (the guard refuses it otherwise).
      ...(spawnTool ? [createSpawnTool(() => meta.spawn ?? SPAWN_UNAVAILABLE)] : [])];
      // generate_image has its own timeout (images.timeoutMs, 180 s by default): liveness bounds a silent call by it, not by the generic tool bound.
      await this.manager.spawn({ id, role: routeRole, route, cwd: args.cwd, signal: startupSignal, tools: [...WORKER_TOOL_NAMES, ...customTools.map(tool => tool.name)], customTools, peerMessaging: false, ...(sessionFile ? { sessionFile } : {}),
        ...(images ? { toolTimeoutsMs: { generate_image: images.timeoutMs ?? KNOWN_TOOL_TIMEOUTS_MS.generate_image! } } : {}),
        contextProjection: createAssignmentProjector(),
        ...(mainModel ? { inheritedContextWindow: mainWindow } : {}),
        ...(singleWorkflow ? { taskCompaction: taskCompactionFor(meta) } : {}),
        instructions: workerSystemInstructions(!!spawnTool),
        ...this.callbacks(meta),
      });
      if (this.disposed) { await this.manager.dispose(id); throw new Error("Worker pool is disposed"); }
      this.workers.set(id, worker);
      const effectiveSession = this.manager.session(id);
      meta.model = effectiveSession.model ? `${effectiveSession.model.provider}/${effectiveSession.model.id}` : route.model;
      meta.thinking = effectiveSession.thinkingLevel ?? route.thinking ?? "off";
    }
    if (worker && singleWorkflow && !worker.taskWorkflowInstalled) {
      const meta = worker;
      const projector = createAssignmentProjector();
      await enableTaskWorkflow(this.manager.session(meta.id), taskCompactionFor(meta), createTaskPlanTool(plan => { meta.plan = plan; meta.recordEvent?.({ type: "task_plan", timestamp: Date.now(), worker: meta.id, plan }); }, () => meta.requirementIds ?? []), projector);
      this.manager.setContextProjection(meta.id, projector);
      meta.taskWorkflowInstalled = true;
    }
    clearTimeout(startupTimer);
    const meta = worker;
    if (meta.taskWorkflowInstalled) configureTaskWorkflow(this.manager.session(meta.id), singleWorkflow ? taskCompactionFor(meta) : undefined);
    meta.singleWorkflow = singleWorkflow;
    const activeSession = this.manager.session(meta.id);
    if (activeSession.model) meta.model = `${activeSession.model.provider}/${activeSession.model.id}`;
    meta.thinking = activeSession.thinkingLevel ?? meta.thinking ?? route.thinking ?? "off";
    meta.contextWindow = activeSession.model?.contextWindow ?? meta.contextWindow;
    clearTimeout(meta.timer);
    meta.role = args.role;
    meta.files = files;
    meta.latestInput = 0;
    meta.plan = undefined;
    const handoffRequest = args.request;
    // Orchestrator assignment: the sub-workers its orche_spawn calls ran, and the reasons it used (its split decision must name them).
    const orchestrating = orchestrate && !!meta.spawnTool;
    const spawned: SubWorkerOutcome[] = [];
    const spawnedReasons = new Set<SpawnReason>();
    const spawnWarnings: string[] = [];
    const definitions = requirementDefinitions(handoffRequest);
    meta.unmetStreak = new Map(singleWorkflow ? [...meta.unmetStreak ?? []].filter(([id]) => definitions.has(id) && definitions.get(id) === meta.requirementDefinitions?.get(id)) : []);
    meta.requirementDefinitions = definitions;
    meta.requirementIds = requirementIds(handoffRequest);
    meta.request = args.context ? `${handoffRequest}\n\nContext:\n${args.context}` : handoffRequest;
    meta.compactions = [];
    // This assignment's record. The worker's entry is read from the manager, so `sessionFile` is there only when the transcript really is persisted.
    const workerFile = this.manager.agentRecord(meta.id).sessionFile;
    // The task ledger (single.ledger): a new task unless `task` continues one; this worker's compaction essentials read it live.
    let ledger: TaskLedger | undefined;
    /** The task's previous worker when another worker takes the task over now; the new one gets a briefing from the ledger. */
    let handedFrom: { worker: string; sessionFile?: string; live: boolean } | undefined;
    let briefing = "";
    if (ledgerOn) {
      if (continued) {
        ledger = continued;
        if (ledger.primary && ledger.primary.worker !== meta.id) {
          handedFrom = { worker: ledger.primary.worker, ...(ledger.primary.sessionFile ? { sessionFile: ledger.primary.sessionFile } : {}), live: this.workers.has(ledger.primary.worker) };
          briefing = renderResumeBriefing(ledger, handedFrom);
        }
      } else {
        const created = startLedger(`T${this.nextTaskId++}`, args.cwd, started);
        ledger = created.ledger;
        this.ledgers.set(ledger.taskId, ledger);
        this.persist(created.event);
      }
      const taskId = ledger.taskId;
      meta.taskId = taskId;
      meta.ledger = () => this.ledgers.get(taskId);
      this.persist(recordHandoff(ledger, { request: handoffRequest, at: Date.now(),
        primary: { worker: meta.id, ...(meta.model ? { model: meta.model } : {}), ...(meta.thinking ? { thinking: meta.thinking } : {}), ...(workerFile ? { sessionFile: workerFile } : {}) } }));
    } else {
      meta.taskId = undefined;
      meta.ledger = undefined;
    }
    const ledgerDetails = (): Pick<TaskDetails, "task" | "continuedFrom"> => ({ ...(ledger ? { task: ledger.taskId } : {}), ...(handedFrom ? { continuedFrom: handedFrom.worker } : {}) });
    const taskLines = (): string[] => [
      ...(ledger ? [`Task ledger ${ledger.taskId}, assignment ${ledger.assignments}: pass task "${ledger.taskId}" for a follow-up of this task (also when another or a new worker takes it over); omit it for a different task.`] : []),
      ...(ledger && handedFrom ? [`Note: ${meta.id} took task ${ledger.taskId} over from ${handedFrom.worker}${handedFrom.live ? "" : " (not live)"}, briefed from its task ledger.`] : []),
      ...ledgerNotes,
    ];
    const record = createRunRecord(resolved, {
      kind: "task", cwd: args.cwd,
      parentSession: { ...(args.currentSession?.id ? { id: args.currentSession.id } : {}), ...(args.currentSession?.file ? { file: args.currentSession.file } : {}) },
      request: args.request, ...(args.context !== undefined ? { context: args.context } : {}),
      manifest: {
        config: describeSource(config.source), routes: routesSummary(config.routes),
        worker: { id: meta.id, role: args.role, ...(workerFile ? { sessionFile: workerFile } : {}) },
        assignment: { role: args.role, reusedWorker: reusedContext, model: meta.model, thinking: meta.thinking, ...(files ? { files } : {}), ...(grant ? { git: grant } : {}), ...(modelWarnings.length ? { warnings: modelWarnings } : {}) },
        ...(concurrent ? { concurrentSessions: concurrent.activity } : {}),
      },
    });
    meta.recordEvent = event => record?.appendEvent(event);
    /** Sub-workers in the record (`run.json` agents, their transcripts under the records' workers/), next to the orchestrator's own entry. */
    const recordSpawned = () => {
      for (const outcome of spawned) record?.addAgent({
        id: outcome.id, role: outcome.role, kind: "worker", model: outcome.model, ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
        requests: outcome.requests, models: outcome.models, durationMs: outcome.durationMs, startedAt: outcome.startedAt, status: outcome.status === "failed" || outcome.status === "cancelled" ? outcome.status : "completed",
        ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}), ...(outcome.error ? { error: outcome.error } : {}),
      });
    };
    const spawnedDetails = (): Pick<TaskDetails, "spawned"> => spawned.length ? { spawned: spawned.map(({ data: _data, summary, ...rest }) => ({ ...structuredClone(rest), summary: summary.length > 500 ? `${summary.slice(0, 499)}…` : summary })) } : {};
    /** The Split line of the result (and the sub-workers it ran); empty unless this is an orchestrator assignment. */
    const splitLines = (split: SplitDecision | undefined): string[] => {
      if (!orchestrating) return [];
      const head = split ? `Split: ${split.decision === "none" ? "none" : (split.criteria ?? []).join(" + ") || "split"} — ${split.reason.replace(/\s+/g, " ")}` : "Split: none (not reported)";
      if (!spawned.length) return [head];
      const cost = spawned.reduce((sum, outcome) => sum + outcome.costUSD, 0);
      return [head, `Sub-workers: ${spawned.map(outcome => `${outcome.id} ${outcome.name} (${outcome.role}, ${outcome.reason}): ${outcome.status}`).join("; ")} — ${spawned.reduce((sum, outcome) => sum + outcome.requests, 0)} requests${cost ? `, $${cost.toFixed(2)}` : ""}`, ...spawnWarnings.map(warning => `Warning (orche_spawn): ${warning}`)];
    };
    const workflowDetails = () => ({ thinking: meta.thinking, ...(meta.plan ? { plan: structuredClone(meta.plan) } : {}),
      ...(singleWorkflow ? { compactions: { count: meta.compactions!.length, events: [...meta.compactions!] } } : {}), ...(modelWarnings.length ? { warnings: modelWarnings } : {}), ...spawnedDetails() });
    let requests = 0;
    let contextCleared: ContextClearedStats | undefined;
    const contextDetails = () => contextCleared ? { contextCleared } : {};
    const contextLine = () => contextCleared ? [`Context: cleared ${contextCleared.results} earlier tool results (~${Math.round(contextCleared.estTokens)} tokens est.) and ${contextCleared.thinkingBlocks} thinking blocks at assignment start; repeat a call to restore its output.`] : [];
    /** The extensions this assignment's deadline was granted (progress lines, details, record), and why the last expiry was not extended. */
    const extensions: DeadlineExtension[] = [];
    let notExtended: TaskDetails["notExtended"];
    const extensionDetails = (): Pick<TaskDetails, "extensions" | "notExtended"> => ({
      ...(extensions.length ? { extensions: extensions.map(extension => ({ ...extension, reasons: [...extension.reasons] })) } : {}),
      ...(notExtended ? { notExtended: { ...notExtended } } : {}),
    });
    let audit: WorkspaceAudit | undefined;
    let before: string | undefined;
    /** Changed by the worker, and the rest of what changed in the workspace meanwhile. */
    let changes: WorkspaceChange[] = [];
    let otherChanges: OtherChange[] = [];
    let gitlinks: GitlinkChange[] = [];
    let activity: WorkspaceActivity | undefined;
    let gitBaseline: GitBaseline | undefined;
    const readOnly = !WRITING_KINDS.has(args.role);
    const progress = () => {
      const snapshot = this.manager!.get(meta.id);
      // The extension lines stay (they are part of how the task is going), ahead of the live status line, which stays last: the UI status shows the last line.
      args.onProgress?.([...(warning ? [warning] : []), ...extensions.map(extension => formatExtensionProgress(extension)), `${meta.id} ${args.role} · ${requests} requests${snapshot.lastToolName ? ` · last tool: ${snapshot.lastToolName}` : ""}`], timingNow());
    };
    const unsubscribe = this.manager.subscribe(event => {
      if (!("agentId" in event) || event.agentId !== meta.id) return;
      if (event.type === "liveness") return; // a state sample for the records, not progress
      if (event.type === "context_cleared") {
        contextCleared = { ...event.contextCleared };
        record?.appendEvent(event);
      }
      if (event.type === "usage") { requests++; meta.latestInput = event.input + event.cacheRead; }
      progress();
    });
    /** The workspace and git part of a result, as of now: the worker is not running any more when this is called. */
    const collect = async (): Promise<{ changeReport: ChangeReport; gitReport?: GitReport }> => {
      // Other sessions may have started since the task did: look again before the change note is written.
      await recheckConcurrent();
      if (audit && before) {
        // Queued boundary snapshots finish first; the last window is closed with the final snapshot.
        await activity?.drain();
        const after = activity ? await activity.checkpoint() : await audit.snapshot();
        const compared = await audit.compare(before, after);
        ({ own: changes, other: otherChanges } = attributeChanges(compared.changes, activity, readOnly));
        gitlinks = compared.gitlinks;
        meta.tree = after;
      }
      const gitReport = grant && gitBaseline ? await reportGit(args.cwd, grant, gitBaseline) : undefined;
      const headMoved = audit ? await headMovement(args.cwd, gitBaseline) : undefined;
      const submodules = await submoduleMoves(args.cwd, gitlinks);
      return { changeReport: { changes, otherChanges, ...(submodules.length ? { submodules } : {}), ...(headMoved ? { headMoved } : {}) }, ...(gitReport ? { gitReport } : {}) };
    };
    /** TaskDetails of an assignment that did not complete. What the audit cannot read is left out: the failure matters more. */
    const failedDetails = async (status: string): Promise<TaskDetails> => {
      let report: ChangeReport = { changes: [], otherChanges: [] };
      let gitReport: GitReport | undefined;
      try { ({ changeReport: report, gitReport } = await collect()); } catch { /* keep the empty lists */ }
      const finishedAt = Date.now();
      return {
        worker: meta.id, role: args.role, status, ...(meta.model ? { model: meta.model } : {}), ...workflowDetails(), durationMs: finishedAt - started, startedAt: started, finishedAt, deadline: deadlineInfo, requests, ...report, roster: this.roster(),
        ...(retired.length ? { retired } : {}), ...(concurrent ? { concurrentSessions: concurrent.activity } : {}), ...(gitReport ? { git: gitReport } : {}), ...extensionDetails(),
        ...(record ? { record: record.dir } : {}),
        ...contextDetails(), ...ledgerDetails(),
      };
    };
    /** The final `run.json` of this assignment, with this worker's entry (the lifetime totals of its one session). */
    const finishRecord = (status: "done" | "failed" | "cancelled", details: TaskDetails, extra: { summary?: string; failure?: string } = {}) => {
      if (!record) return;
      record.addAgent(this.manager!.agentRecord(meta.id));
      recordSpawned();
      record.finish({
        status,
        ...(extra.summary ? { summary: extra.summary } : {}),
        ...(extra.failure ? { failure: extra.failure } : {}),
        ...(status === "cancelled" && this.options.controller.cancelledByUser ? { cancelledByUser: true } : {}),
        outcome: { status: details.status, requests: details.requests, durationMs: details.durationMs, model: details.model, thinking: details.thinking, checklist: details.checklist, plan: details.plan, compactions: details.compactions, warnings: details.warnings, ...(details.split ? { split: details.split } : {}) },
        workspace: { changes: details.changes, otherChanges: details.otherChanges, ...(details.submodules ? { submodules: details.submodules } : {}), ...(details.headMoved ? { headMoved: details.headMoved } : {}) },
        ...(details.git ? { git: details.git } : {}),
        ...(retired.length ? { retired } : {}),
        ...(details.extensions ? { extensions: details.extensions } : {}), ...(details.notExtended ? { notExtended: details.notExtended } : {}),
        ...(concurrent ? { concurrentSessions: concurrent.activity } : {}),
      });
    };
    try {
      signal.throwIfAborted();
      // Use an uncancelled audit so cancellation still records changes made before stop. Submodules are part of the
      // task's workspace: edits inside them count (as `sub/file`) and so do moved submodule HEADs.
      audit = await WorkspaceAudit.open(args.cwd, undefined, { submodules: true });
      // HEAD before the snapshot: a commit made in between then shows up as a HEAD move instead of vanishing.
      gitBaseline = grant || audit ? await captureGitBaseline(args.cwd, grant, signal) : undefined;
      before = await audit?.snapshot();
      let prefix = "";
      if (reusedContext) {
        const stale = audit && before && meta.tree ? await audit.compare(meta.tree, before) : undefined;
        const headSince = meta.head && gitBaseline?.available && gitBaseline.head && meta.head.sha !== gitBaseline.head
          ? { ...(meta.head.sha ? { from: meta.head.sha } : {}), to: gitBaseline.head, ...await commitsBetween(args.cwd, meta.head.sha, gitBaseline.head) } : undefined;
        // No tool of this worker runs between two assignments: everything seen since is someone else's.
        prefix = formatStaleContext(audit ? { changes: stale?.changes ?? [], ...(stale?.gitlinks.length ? { submodules: await submoduleMoves(args.cwd, stale.gitlinks) } : {}), ...(headSince ? { headMoved: headSince } : {}) } : undefined);
      }
      if (briefing) prefix = `${briefing}\n${prefix}`;
      if (audit && before && !readOnly) {
        const tracked = audit;
        activity = new WorkspaceActivity({ cwd: args.cwd, tree: before, snapshot: () => tracked.snapshot(), diff: (from, to) => tracked.diff(from, to), cancelled: () => signal.aborted });
        meta.activity = activity;
      }
      signal.throwIfAborted();
      if (orchestrating) {
        // The orchestrator's sub-workers: standard roles on its current model and thinking, specialists on their own routes.
        const current = { role: routeRole, model: meta.model ?? route.model, ...(meta.thinking ?? route.thinking ? { thinking: meta.thinking ?? route.thinking } : {}) };
        const tracked = audit;
        let sub = 0;
        meta.spawn = {
          orchestrator: meta.id, ...(files ? { scope: files } : {}), ...(readOnly ? { readOnly: true } : {}), signal,
          nextId: () => `${meta.id}.${++sub}`,
          runWorker: createSubWorkerRunner({
            orchestrator: meta.id, cwd: args.cwd, runtime, route: current, ...(mainModel ? { inheritedContextWindow: mainWindow } : {}),
            specialistRoute: role => resolveSpecialistRoute(config.routes, role, (provider, id) => !!runtime.getModel(provider, id)),
            imageTool: () => config.routes.images ? createGenerateImageTool({ cwd: args.cwd, runtime, images: config.routes.images }) : undefined,
            prompt: (planned, imagesAvailable) => subWorkerPrompt(planned, meta.id, config.routes.verifyCommands ?? [], imagesAvailable),
            timeoutMs: limits.assignmentMs, maxTurns: Math.max(50, Math.round((limits.assignmentRequests ?? 200) * 1.5)),
            sessionFile: id => resolved.enabled ? workerSessionFile(resolved, { ...(args.currentSession?.id ? { parentSessionId: args.currentSession.id } : {}), workerId: id, spawnedAt: Date.now() }) : undefined,
          }),
          ...(tracked ? { snapshot: () => tracked.snapshot(), diff: async (from: string, to: string) => (await tracked.compare(from, to)).changes } : {}),
          onProgress: lines => args.onProgress?.([...(warning ? [warning] : []), ...lines], timingNow()),
          onSpawned: (reason, outcomes, warnings) => {
            spawnedReasons.add(reason);
            spawned.push(...outcomes);
            spawnWarnings.push(...warnings);
            record?.appendEvent({ type: "spawn", timestamp: Date.now(), worker: meta.id, reason, workers: outcomes.map(outcome => ({ id: outcome.id, name: outcome.name, role: outcome.role, status: outcome.status, requests: outcome.requests, durationMs: outcome.durationMs, ...(outcome.files ? { files: outcome.files } : {}) })), ...(warnings.length ? { warnings: [...warnings] } : {}) });
          },
        } satisfies SpawnContext;
        meta.roundCheck = (_kind, data) => splitError(data, spawnedReasons);
      }
      const prompt = assignmentPrompt({ ...args, request: handoffRequest, orchestrate: orchestrating, ...(files ? { files: [...files] } : {}) }, config.routes.verifyCommands ?? [], !!images, grant, orchestrating ? orchestratorSection() : "");
      const handoff = reusedContext && workflowMode ? prompt.replace(/^(Assignment[^\n]*\n)/, "$1This Assignment message supersedes earlier requirement ids and plans, including any assignment preserved at compaction time. Use only this round's requirements and Task DAG.\n") : prompt;
      this.manager.assign(meta.id, args.role, prefix + handoff, { enabled: reusedContext && config.taskContext.clearBetweenAssignments, minClearTokens: config.taskContext.minClearTokens });
      assigned = true;
      if (signal.aborted) abort();
      progress();
      // One deadline for the assignment (its orche_spawn sub-workers run inside it): base `assignmentMs`, pushed out by `extensionMs` (at most `maxExtensions` times) each time it
      // expires while the worker is still active (src/orchestration/run/extension.ts). Cancellation wins at every point: `aborted` comes back at once, in an extension window too.
      let deadline = ExtendableDeadline.fromLimits(limits, { baseMs: limits.assignmentMs });
      const manager = this.manager;
      const waitRound = async (stage: string) => {
        const current = deadline;
        deadlineInfo = deadlineInfoOf(current);
        const waited = await waitExtendable({
          deadline: current, signal, stage, scope: "assignment",
          wait: ms => manager.wait(meta.id, ms),
          liveness: (now, windowMs) => this.workerLiveness(meta.id, now, windowMs),
          onExtended: extension => {
            extensions.push({ ...extension, reasons: [...extension.reasons] });
            record?.appendEvent(extensionEvent(extension));
            record?.update({ extensions: extensions.map(granted => ({ ...granted, reasons: [...granted.reasons] })) });
            deadlineInfo = deadlineInfoOf(current);
            progress();
          },
        });
        if (signal.aborted || waited.type === "aborted") { await stopPromise; throw new WorkerFailure("cancelled", "cancelled", "cancelled"); }
        if (waited.type === "timeout") {
          const why = waited.notExtended;
          if (why.message && why.reason !== "disabled") notExtended = { reason: why.reason, message: why.message };
          await manager.stop(meta.id); await manager.wait(meta.id, 0);
          // `overallCapMs` is the base plus the extensions it received; the first line carries why it was not extended, the rest what was extended.
          const history = formatExtensionSummary(extensions, { maxExtensions: current.maxExtensions, extensionMs: current.extensionMs });
          const headline = withNotExtended(`Worker ${meta.id} timed out after ${current.overallCapMs}ms`, why);
          throw new WorkerFailure(history.length ? `${headline}\n${history.join("\n")}` : headline, "failed", "timeout");
        }
        if (waited.type !== "outcome") throw new WorkerFailure(`Worker ${meta.id} returned no result`, "failed", "no_result");
        const { outcome: reported } = waited;
        if (reported.status !== "completed" || !reported.result) throw new WorkerFailure(reported.error ?? reported.lastText ?? `Worker ${meta.id}: ${reported.status}`, "failed", reported.status);
        return { ...reported, result: reported.result };
      };
      const outcome = await waitRound(`${meta.id} ${args.role}`);
      meta.summary = outcome.result.summary;
      const { changeReport, gitReport } = await collect();
      meta.lastUsed = Date.now();
      if (!meta.singleWorkflow && meta.contextWindow && meta.latestInput >= meta.contextWindow * 0.7) {
        await this.retire(meta.id); retired.push(meta.id);
        retirementLines.push(`${meta.id} retired: context nearly full; start a new worker with the contract and evidence`);
      }
      const finishedAt = Date.now();
      const durationMs = finishedAt - started;
      const data = dataOf(outcome.result.data);
      const checklist = Array.isArray(data.checklist) ? data.checklist as ChecklistItem[] : undefined;
      const checklistLines: string[] = [];
      if (checklist) {
        const unmet = checklist.filter(item => item.status !== "met");
        const verified = checklist.filter(item => item.status === "met" && item.verifiedBy).length;
        checklistLines.push(`Checklist (worker self-report, not acceptance): ${checklist.length - unmet.length}/${checklist.length} met, ${verified} with a named passing check${unmet.length ? `; unmet: ${unmet.map(item => `${item.id} (${item.status}: ${item.evidence})`).join("; ")}` : ""}`);
        const ambiguities = Array.isArray(data.ambiguities) ? data.ambiguities as Ambiguity[] : [];
        if (ambiguities.length) {
          checklistLines.push(`Ambiguities resolved by the worker: ${ambiguities.map(item => `${item.id ?? "?"}: chose "${item.chosen}" over ${item.readings.filter(reading => reading !== item.chosen).map(reading => `"${reading}"`).join(", ")}`).join("; ")}`);
          checklistLines.push("Note: check each chosen reading against the user's original request before accepting; send a correction to the same worker if it differs.");
        }
        if (singleWorkflow) {
          const previous = meta.unmetStreak ?? new Map<string, number>();
          meta.unmetStreak = new Map(unmet.filter(item => meta.requirementDefinitions?.has(item.id)).map(item => [item.id, (previous.get(item.id) ?? 0) + 1]));
          for (const [id, count] of meta.unmetStreak) if (count >= 2) checklistLines.push(`Note: ${id} unmet in ${count} consecutive assignments of ${meta.id}; hand only the unmet items to a NEW worker (omit worker${ledger ? `, keep task "${ledger.taskId}"` : ""}) with their requirements and the relevant context.`);
        }
      } else meta.unmetStreak = new Map();
      if (ledger) {
        this.persist(recordResult(ledger, {
          role: args.role, worker: meta.id, status: typeof data.status === "string" ? data.status : outcome.status, summary: meta.summary,
          ...(checklist ? { checklist } : {}), ...(Array.isArray(data.ambiguities) ? { ambiguities: data.ambiguities as Ambiguity[] } : {}), ...(record ? { record: record.dir } : {}),
        }));
      }
      const roleData = ["status", "reason", "passed", "issues", "cause"].filter(key => data[key] !== undefined).map(key => `${key}: ${typeof data[key] === "string" ? data[key] : JSON.stringify(data[key])}`);
      if (Array.isArray(data.outputs)) roleData.push(`outputs: ${data.outputs.length}`);
      const note = data.status === "blocked" ? workflowMode && typeof data.reason === "string" && data.reason ? data.reason : "the worker reported blocked" : args.role === "verify" && data.passed === false ? "verification failed" : undefined;
      const roster = this.roster();
      const gitLines = gitReport ? formatGitReport(gitReport) : [];
      const details: TaskDetails = {
        worker: meta.id, role: args.role, status: typeof data.status === "string" ? data.status : outcome.status, ...(meta.model ? { model: meta.model } : {}), ...workflowDetails(), ...(orchestrating && splitOf(data) ? { split: splitOf(data)! } : {}), ...(checklist ? { checklist } : {}), ...(Array.isArray(data.ambiguities) && data.ambiguities.length ? { ambiguities: data.ambiguities as Ambiguity[] } : {}), durationMs, startedAt: started, finishedAt, deadline: deadlineInfo, requests, ...changeReport, roster,
        ...(retired.length ? { retired } : {}), ...(concurrent ? { concurrentSessions: concurrent.activity } : {}), ...(gitReport ? { git: gitReport } : {}), ...extensionDetails(), ...(record ? { record: record.dir } : {}),
        ...contextDetails(), ...ledgerDetails(),
      };
      finishRecord("done", details, { summary: meta.summary });
      const planNotes = singleWorkflow && !meta.plan ? ["Note: no Task DAG recorded in this assignment."] : [];
      const text = [...(warning ? [warning, ""] : []), `orche task ${meta.id} (${args.role}, ${Math.round(durationMs / 1000)}s, ${requests} requests; ${describeSource(config.source)})`, ...modelWarnings, ...contextLine(),
        ...taskLines(), "", meta.summary, ...roleData, ...checklistLines, ...splitLines(splitOf(data)), "", ...(audit ? formatTaskChanges(changeReport, { concurrentWarning: !!warning, grant: !!grant }) : ["Workspace audit unavailable (not a git work tree)"]), ...gitLines, ...deadline.summary(), `Workers: ${roster}`, ...retirementLines,
        ...planNotes, ...(!WRITING_KINDS.has(args.role) && args.files !== undefined ? ["Note: files ignored for read-only role."] : []), ...(note ? [`Note: follow up with the same worker — ${note}`] : [])].join("\n");
      return { text: withRecordLine(text, record?.dir), details };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      if (!(error instanceof WorkerFailure)) { // before the worker ran, or an unexpected error: a plain error
        record?.finish({ status: signal.aborted ? "cancelled" : "failed", failure: failureReason(base) });
        throw warning ? withConcurrentWarning(error, warning) : error;
      }
      // The worker ran: same message as ever (warning first), now with the details of what it did. The details come first: they re-check
      // for other sessions, which the warning in the message must know about.
      meta.unmetStreak = new Map();
      if (ledger) {
        this.persist(recordFailure(ledger, { role: args.role, worker: meta.id, status: error.status, reason: failureReason(base), ...(record ? { record: record.dir } : {}) }));
      }
      const details = await failedDetails(error.status);
      const thrown = warning ? withConcurrentWarning(error, warning) : error;
      finishRecord(error.kind === "cancelled" ? "cancelled" : "failed", details, { failure: failureReason(base) });
      throw new TaskFailedError([thrown instanceof Error ? thrown.message : base, ...modelWarnings, ...contextLine(), ...taskLines()].join("\n"), details, { kind: error.kind, status: error.status, reason: failureReason(base) });
    } finally {
      signal.removeEventListener("abort", abort);
      await stopPromise;
      // Whatever happened above, the record ends here (a no-op when the outcome was recorded already) and shows this worker's totals.
      if (record) {
        record.addAgent(this.manager.agentRecord(meta.id));
        record.finish({ status: signal.aborted ? "cancelled" : "failed", failure: "the task ended without a recorded outcome" });
      }
      unsubscribe();
      // Nothing may snapshot on the private index while the tracker still has jobs queued.
      meta.activity = undefined;
      meta.recordEvent = undefined;
      meta.roundCheck = undefined;
      meta.spawn = undefined;
      meta.files = files;
      await activity?.drain().catch(() => undefined);
      if (audit && before) meta.tree = await audit.snapshot().catch(() => meta.tree);
      if (audit) {
        const now = await captureGitBaseline(args.cwd, undefined).catch(() => undefined);
        meta.head = now?.available ? { ...(now.head ? { sha: now.head } : {}) } : undefined;
      }
      await audit?.close();
      if (this.workers.has(meta.id)) this.idle(meta);
      args.onProgress?.([], timingNow());
    }
    } catch (error) {
      if (worker) { worker.unmetStreak = new Map(); worker.roundCheck = undefined; }
      // Failed before its assignment started (e.g. cancelled during startup): an idle worker still gets its idle expiry.
      if (worker && this.workers.has(worker.id) && this.manager?.get(worker.id).status === "idle") this.idle(worker);
      throw error;
    } finally {
      clearTimeout(startupTimer);
      signal.removeEventListener("abort", abort);
      await stopPromise;
      if (worker && this.manager?.list().some(item => item.id === worker?.id && item.status === "disposed")) {
        clearTimeout(worker.timer);
        this.workers.delete(worker.id);
      }
    }
  }
}
