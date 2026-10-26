/**
 * `orche_spawn`: the orchestrator's one way to split work (docs/orchestrator.md 2–3). It starts up to the session's cap (`single.maxSubWorkers`, default MAX_SUB_WORKERS) sub-workers in
 * fresh sessions at the same time and returns when all of them have reported.
 *
 * File conflicts are prevented in layers: writers must own files and their ownership may not overlap (planSpawn, with the backlog
 * validator's `file_overlap`); every write of a sub-worker is checked against its own files and its siblings' (sub-worker.ts, the
 * ownership guard); the tool is `executionMode: "sequential"`, so no other tool call of the orchestrator runs meanwhile; and a
 * workspace snapshot before and after the call reports changes outside every worker's files (bash writes, other sessions).
 * Depth is 1: the tool is registered only in orchestrator sessions, never in a sub-worker's, and a sub-worker's guard refuses it.
 */
import { Type, type Static, type TLiteral } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { normalizeOwnedPath, validateBacklog, type TaskItem } from "../orchestration/backlog.js";
import { ownsPath, WRITING_KINDS } from "../orchestration/ownership.js";
import type { RouteSettings, SubWorkerModelSource, SubWorkerThinkingSource } from "../orchestration/routing.js";
import type { WorkspaceChange } from "../orchestration/workspace.js";
import { MAX_SUB_WORKERS, MAX_VERIFICATION_ROUNDS } from "./instructions.js";
import { formatModelUse } from "../orchestration/model-use.js";
import { formatDuration } from "../agent/liveness.js";
import type { DeadlineExtension, NotExtendedReason, WaitObservation } from "../orchestration/run/extension.js";
import type { SpecialistBudget, SpecialistDeadlineStats } from "../specialists/session.js";

export const SPAWN_TOOL = "orche_spawn";
export const SPAWN_REASONS = ["parallelism", "isolation", "verification"] as const;
/**
 * The reasons of the ultra flow (src/orchestrator/ultra.ts): `exploration` (independent verification basis and hypotheses before
 * any candidate exists), `candidates` (independent implementations or answers, each implementation in its own workspace copy),
 * `verification` (fresh verifiers, the same cap) and `isolation` (game-asset/video specialists only). No `parallelism`: parallel
 * writers in the shared workspace would bypass the candidate/adoption contract.
 */
export const ULTRA_SPAWN_REASONS = ["exploration", "candidates", "verification", "isolation"] as const;
/**
 * The reasons of the MDSD search policy (src/orchestrator/mdsd.ts): `search` (a round of independent explorers, each with a strategy
 * spec), `parallelism` (writers implementing after the judgment), `verification` (fresh verifiers, the same cap) and `isolation`
 * (game-asset/video specialists only).
 */
export const MDSD_SPAWN_REASONS = ["search", "parallelism", "verification", "isolation"] as const;
export type SpawnReason = (typeof SPAWN_REASONS)[number] | (typeof ULTRA_SPAWN_REASONS)[number] | (typeof MDSD_SPAWN_REASONS)[number];
export const SUB_WORKER_ROLES = ["implement", "answer", "verify", "game-asset", "video"] as const;
export type SubWorkerRole = (typeof SUB_WORKER_ROLES)[number];
/** The guard's answer when a sub-worker tries to spawn (it never has the tool; this is the second line). */
export const DEPTH_LIMIT_MESSAGE = "Blocked: sub-workers cannot spawn workers (orche_spawn depth is 1). Do the work yourself or report what is missing.";

/** One `Type.Literal` per value, typed as a tuple so TypeBox 1.x `Static` yields the literal union (a plain array maps to `never`). */
const literals = <const T extends readonly string[]>(values: T) => values.map(value => Type.Literal(value)) as unknown as { -readonly [K in keyof T]: TLiteral<T[K]> };

/** orche_spawn's parameters with the session's per-call cap (`single.maxSubWorkers`). */
export function spawnParametersFor(maxSubWorkers: number) {
  return Type.Object({
    reason: Type.Union(literals(SPAWN_REASONS), { description: "Why you split: parallelism (independent parts at the same time), isolation (a game-asset/video specialist or a part that must run apart), verification (fresh independent verifiers, role verify only)." }),
    workers: Type.Array(Type.Object({
      name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$", description: "Short unit name, unique in this call (e.g. csv, cache, verify)." }),
      role: Type.Union(literals(SUB_WORKER_ROLES), { description: "implement (writes its own files), answer (read-only investigation), verify (read-only independent verification), game-asset or video (specialists)." }),
      request: Type.String({ minLength: 1, description: "Self-contained request: the sub-worker sees nothing else. Goal, acceptance criteria, constraints, file references and the user's wording where it matters; not your reasoning." }),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned files or directories (dir/ or dir/**) of a writing role; required for implement, game-asset and video; ignored for read-only roles." })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: maxSubWorkers }),
  }, { additionalProperties: false });
}
export const spawnParameters = spawnParametersFor(MAX_SUB_WORKERS);
export type SpawnParameters = Static<typeof spawnParameters>;
/** orche_spawn of an ultra orchestrator: the ultra reasons, for a fix candidate `from` (an earlier candidate to start from), and for a candidates call `excluded` and `reference` (analyst-reported files left out of the candidates, or given to them as read-only context, with their grounds). */
export function ultraSpawnParametersFor(maxSubWorkers: number) {
  return Type.Object({
    reason: Type.Union(literals(ULTRA_SPAWN_REASONS), { description: `exploration (before any candidate: independent verification-basis builders, role implement owning the test/check files they write, and hypothesis analysts, role answer), candidates (2-${maxSubWorkers} independent implementations, each in its own workspace copy, or independent answers for a read-only task), verification (fresh verifiers, role verify only), isolation (a game-asset/video specialist).` }),
    workers: Type.Array(Type.Object({
      name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$", description: "Short unit name, unique in this call (e.g. basis, cause, cand-a, verify)." }),
      role: Type.Union(literals(SUB_WORKER_ROLES), { description: "implement (writes its own files; a candidate writes only in its workspace copy), answer (read-only), verify (read-only independent verification), game-asset or video (specialists)." }),
      request: Type.String({ minLength: 1, description: "Self-contained request: the sub-worker sees nothing else. Goal, acceptance criteria, constraints, file references and the user's wording where it matters; not your reasoning and, for exploration and first-round candidates, never another worker's conclusions." }),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned files or directories of a writing role (for a candidate: inside its own workspace copy; candidates may own the same paths)." })),
      from: Type.Optional(Type.String({ minLength: 1, description: "candidates only: id of an earlier candidate (e.g. W1.3) whose workspace this fix candidate starts from; the earlier one stays unchanged." })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: maxSubWorkers }),
    // The analysts' hand-off (ultra.ts, docs/orchestrator.md 14.2): a reported file no candidate gets, left out with its grounds.
    excluded: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ minLength: 1, description: "A workspace file an exploration analyst reported (as the exploration result or the refusal lists it)." }),
      reason: Type.String({ minLength: 1, description: "Why the candidates need not handle it." }),
      evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10, description: "[orche ref Tn] of your own successful checks (read, grep, bash) made after the exploration round that reported it, whose arguments or output name the file." }),
    }, { additionalProperties: false }), { maxItems: 100, description: "candidates only: files the exploration analysts reported that no candidate gets, each with a reason and evidence. Every other reported file must be assigned (the same candidate owns it in its files and names it in its request) or listed in reference; files outside your write scope are recorded as out of scope automatically." })),
    // The analysts' hand-off: a reported file the candidates only read (context, no transfer), named in a request, with its grounds.
    reference: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ minLength: 1, description: "A workspace file an exploration analyst reported (as the exploration result or the refusal lists it), named in at least one candidate's request of this call." }),
      reason: Type.String({ minLength: 1, description: "Why the candidates only read it, as context, and change nothing there." }),
      evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10, description: "[orche ref Tn] of your own successful checks (read, grep, bash) made after the exploration round that reported it, whose arguments or output name the file." }),
    }, { additionalProperties: false }), { maxItems: 100, description: "candidates only: analyst-reported files the candidates get as read-only context (no transfer of a change), each named in a candidate's request, with a reason and evidence." })),
  }, { additionalProperties: false });
}
export const ultraSpawnParameters = ultraSpawnParametersFor(MAX_SUB_WORKERS);
/** orche_spawn of an MDSD orchestrator: the MDSD reasons, a strategy per search worker, the plan (first search) and adapt (later rounds). */
export function mdsdSpawnParametersFor(maxSubWorkers: number) {
  return Type.Object({
    reason: Type.Union(literals(MDSD_SPAWN_REASONS), { description: `search (a round of 2-${maxSubWorkers} independent read-only explorers, role answer, each with its strategy; the first round also takes plan, a later one adapt), parallelism (writers implementing after the judgment, role implement, disjoint owned files), verification (fresh read-only verifiers, role verify), isolation (a game-asset/video specialist).` }),
    workers: Type.Array(Type.Object({
      name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$", description: "Short unit name, unique in this call (e.g. invert-gate, decompose-resume)." }),
      role: Type.Union(literals(SUB_WORKER_ROLES), { description: "answer (a search explorer: read-only), implement (a parallelism writer), verify (a fresh verifier), game-asset or video (specialists)." }),
      request: Type.String({ minLength: 1, description: "Self-contained request: the task, references and the user's wording where it matters; never another path's conclusions. The runtime puts the strategy brief (objective, constraints, strategy, budget, output contract) in front of it." }),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned files or directories of a parallelism writer." })),
      strategy: Type.Optional(Type.Unknown({ description: "search only: {framing, operators: 1-3 of EXPAND|DECOMPOSE|INVERT|TRANSFER|CHALLENGE|VALIDATE, hypothesis_space:[…], evidence_scope:[…], method:[…], reasoning: 1-3 of deduction|induction|abduction|backtracking|comparison|experiment, direction: bottom-up|top-down|backward|cross-cutting, validation: 1-3 of falsification|reproduction|comparison|constraint-check, purpose?: explore|exploit (adaptive rounds), targets?: [aggregation ids], budget?: {requests, minutes, costUSD, outputTokens}}" })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: maxSubWorkers }),
    plan: Type.Optional(Type.Unknown({ description: "search, first round: {objective: the user's goal unchanged, constraints: [mandatory constraints verbatim], success: [criteria], rationale: why diversifying pays here}." })),
    adapt: Type.Optional(Type.Unknown({ description: "search, later rounds: {basis: [aggregation ids F…/D…/C…/G… that justify the round], reason}." })),
  }, { additionalProperties: false });
}
/** One orche_spawn call of any tool variant. */
export interface SpawnCall { reason: SpawnReason; workers: { name: string; role: SubWorkerRole; request: string; files?: string[]; from?: string; strategy?: unknown }[]; plan?: unknown; adapt?: unknown; excluded?: { path: string; reason: string; evidence: string[] }[]; reference?: { path: string; reason: string; evidence: string[] }[] }

/** Canonical ownership paths: concrete files or directory prefixes (`dir/`, `dir/**`, `dir/**\/*` → `dir/`); globs, absolute and outside paths are errors. */
export function scopePaths(files: readonly string[]): string[] {
  return [...new Set(files.map(file => {
    const path = normalizeOwnedPath(file.replaceAll("\\", "/").replace(/\/\*\*(?:\/\*)?$/, "/"));
    if (!path || /[*?\[\]{}]/.test(path) || isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.split("/")[0] === "..")
      throw new Error(`Unsupported ownership path ${JSON.stringify(file)}; use concrete files, directory prefixes ending /, or directory/**`);
    return path;
  }))];
}

/**
 * One validated sub-worker. `workspace` (ultra candidates): its private workspace copy, its cwd; `from`: the earlier candidate it
 * starts from; `protectedPaths`: workspace-relative paths of the verification basis it may not write.
 */
export interface PlannedWorker {
  id: string; name: string; role: SubWorkerRole; request: string; reason: SpawnReason; files?: string[]; workspace?: string; from?: string; protectedPaths?: readonly string[];
  /** Ultra candidate: submodule paths, empty in its copy and never adopted (its file tools are blocked there). */
  outsidePaths?: readonly string[];
  /** MDSD search worker: its strategy spec (validated by the stage hooks), the brief put in front of its request, its budget, its report contract. */
  strategy?: unknown;
  brief?: string;
  budget?: SpecialistBudget;
  check?: (data: unknown) => string | undefined;
  /** MDSD replication cell (mdsd.replication): its own model route instead of the inherited one (thinking: its own, else the orchestrator's). */
  route?: RouteSettings;
  /** MDSD explorer with mdsd.explorerScratch: its private scratch directory, a write root like every orche worker's scratch. */
  scratch?: string;
}

/**
 * Validate one call and give the workers their ids (only after it is valid, so a refused call uses none). Throws an Error whose
 * message tells the orchestrator what to change. `maxSubWorkers`: the session's per-call cap (default MAX_SUB_WORKERS).
 */
export function planSpawn(params: SpawnCall, options: { scope?: readonly string[]; readOnly?: boolean; ultra?: boolean; mdsd?: boolean; maxSubWorkers?: number; nextId: () => string }): { workers: PlannedWorker[]; notes: string[] } {
  const { reason, workers } = params;
  const notes: string[] = [];
  const max = options.maxSubWorkers ?? MAX_SUB_WORKERS;
  if (!workers.length || workers.length > max) throw new Error(`orche_spawn takes 1 to ${max} workers per call (this session's cap, set by single.maxSubWorkers).`);
  const names = new Set<string>();
  for (const worker of workers) {
    if (names.has(worker.name)) throw new Error(`Duplicate worker name ${worker.name}; names must be unique in one call.`);
    names.add(worker.name);
  }
  if (reason === "verification" && workers.some(worker => worker.role !== "verify")) throw new Error('reason "verification" takes role verify only: a fresh read-only verifier.');
  if (reason !== "verification" && workers.some(worker => worker.role === "verify")) throw new Error('role verify is an independent verifier: use reason "verification".');
  if (reason === "parallelism" && workers.length < 2) throw new Error('reason "parallelism" needs two or more workers; do a single part yourself.');
  const candidates = reason === "candidates";
  if ((candidates || reason === "exploration") && !options.ultra) throw new Error(`reason "${reason}" belongs to ultra mode; use ${options.mdsd ? "search, parallelism, isolation or verification" : "parallelism, isolation or verification"}.`);
  if (reason === "search" && !options.mdsd) throw new Error('reason "search" belongs to the MDSD search policy (mode mdsd); use parallelism, isolation or verification.');
  if (!options.mdsd && (params.plan !== undefined || params.adapt !== undefined || workers.some(worker => worker.strategy !== undefined))) throw new Error("plan, adapt and strategy belong to the MDSD search policy (mode mdsd).");
  if (options.ultra && params.excluded !== undefined && !candidates) throw new Error('excluded (analyst-reported files left out of the candidates, each with a reason and evidence) belongs to reason "candidates" only.');
  if (options.ultra && params.reference !== undefined && !candidates) throw new Error('reference (analyst-reported files the candidates get as read-only context, each with a reason and evidence) belongs to reason "candidates" only.');
  if (options.mdsd) {
    if (reason === "parallelism" && workers.some(worker => worker.role !== "implement")) throw new Error('in mdsd mode reason "parallelism" is for writers implementing after the judgment (role implement); independent exploration paths are reason "search" (each with its strategy).');
    if (reason === "isolation" && workers.some(worker => worker.role !== "game-asset" && worker.role !== "video")) throw new Error('in mdsd mode reason "isolation" is for game-asset and video specialists only; exploration goes through reason "search".');
  }
  if (options.ultra) {
    if (reason === "parallelism") throw new Error('ultra mode has no reason "parallelism": independent implementations are candidates (reason "candidates", each in its own workspace copy), and the verification basis and hypotheses are exploration.');
    if (reason === "isolation" && workers.some(worker => worker.role !== "game-asset" && worker.role !== "video")) throw new Error('in ultra mode reason "isolation" is for game-asset and video specialists only; other work goes through exploration and candidates.');
    if (reason === "exploration" && (workers.length < 2 || workers.some(worker => worker.role !== "implement" && worker.role !== "answer"))) throw new Error('reason "exploration" takes two or more independent workers: verification-basis builders (role implement, owning the test or check files they write) and hypothesis/approach analysts (role answer).');
    if (candidates) {
      if (workers.length < 2) throw new Error(`reason "candidates" takes 2 to ${max} independent candidates; one attempt is no comparison.`);
      const role = workers[0]!.role;
      if ((role !== "implement" && role !== "answer") || workers.some(worker => worker.role !== role)) throw new Error('candidates are all role implement (implementations, each in its own workspace copy) or all role answer (independent answers of a read-only task).');
      const requests = new Set(workers.map(worker => worker.request.trim().replace(/\s+/g, " ")));
      if (requests.size !== workers.length) throw new Error("candidate requests must differ: give each candidate its own approach or hypothesis, so the candidates are diverse.");
    }
  }
  if (!candidates && workers.some(worker => worker.from !== undefined)) throw new Error('from (start from an earlier candidate) is for reason "candidates" only.');
  const planned = workers.map((worker): Omit<PlannedWorker, "id"> => {
    const writes = WRITING_KINDS.has(worker.role);
    const from = worker.from !== undefined ? { from: worker.from } : {};
    if (!writes) {
      if (worker.files?.length) notes.push(`files ignored for read-only ${worker.name}.`);
      if (worker.from !== undefined) throw new Error(`${worker.name}: from applies to implement candidates only (an answer candidate has no workspace).`);
      return { name: worker.name, role: worker.role, request: worker.request, reason, ...(worker.strategy !== undefined ? { strategy: worker.strategy } : {}) };
    }
    if (options.readOnly) throw new Error(`${worker.name} (${worker.role}) would write files, but this assignment is read-only: spawn answer or verify workers only.`);
    if (!worker.files?.length) throw new Error(`${worker.name} (${worker.role}) must name the files or directories it owns in files.`);
    const files = scopePaths(worker.files);
    if (options.scope) {
      const outside = files.filter(path => !options.scope!.some(owned => ownsPath(owned, path.replace(/\/$/, ""))));
      if (outside.length) throw new Error(`${worker.name} would own ${outside.join(", ")} outside your own write scope (${options.scope.join(", ")}).`);
    }
    return { name: worker.name, role: worker.role, request: worker.request, reason, files, ...from };
  });
  // Candidates work in separate workspace copies: they may own the same paths. Everyone else shares the workspace.
  if (!candidates) {
    const tasks: TaskItem[] = planned.map(worker => ({ id: worker.name, owner: worker.name, description: worker.name, files: worker.files ?? [], status: "pending" }));
    const overlaps = validateBacklog(tasks, planned.map(worker => worker.name)).filter(issue => issue.type === "file_overlap");
    if (overlaps.length) throw new Error(`Owned files overlap: ${overlaps.map(issue => issue.type === "file_overlap" ? `${issue.taskIds[0]} (${issue.files[0]}) and ${issue.taskIds[1]} (${issue.files[1]})` : "").join("; ")}. Give every file to one worker, or do coupled parts in one worker.`);
  }
  return { workers: planned.map(worker => ({ ...worker, id: options.nextId() })), notes };
}

/** What one sub-worker did. `status`: done | blocked (writers, answer) · passed | not passed (verify) · failed | cancelled (no valid report). */
export interface SubWorkerOutcome {
  id: string;
  name: string;
  role: SubWorkerRole;
  reason: SpawnReason;
  status: string;
  summary: string;
  data?: unknown;
  error?: string;
  files?: string[];
  /** `provider/id` of the sub-worker's session (the route's while {@link SubWorkerOutcome.notStarted}). */
  model: string;
  /** The thinking level the session ran on, after Pi's clamp (the route's while {@link SubWorkerOutcome.notStarted}). */
  thinking?: string;
  /** The session never started: `model` and `thinking` are only what it was routed to, and it is shown as unknown. */
  notStarted?: true;
  /** Where the model came from (SubWorkerModelSource): `models.worker`'s model or main's named by it, the orchestrator's, or a route. */
  modelSource: SubWorkerModelSource;
  /** Where `thinking` came from (SubWorkerThinkingSource); `thinking` is the level the session ran on, after Pi's clamp. */
  thinkingSource?: SubWorkerThinkingSource;
  requests: number;
  models: Record<string, number>;
  startedAt: number;
  durationMs: number;
  costUSD: number;
  /** Token usage of the session as the provider reported it (absent when the session never answered). */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** MDSD search worker: when its budget wrap-up notice went out and what stopped it (src/specialists/session.ts). */
  budget?: { wrapUp?: string; stoppedBy?: string; inFlightUnknown?: boolean };
  sessionFile?: string;
  /** Workspace paths changed during the call inside this worker's owned files (an ultra candidate: in its own workspace copy). */
  changes: string[];
  /** The sub-worker's activity-aware deadline (absent with a fixed cap): extensions, observations and why it stopped, if it did. */
  deadline?: SubWorkerDeadline;
  /** Ultra candidate: its workspace copy (absolute path). */
  workspace?: string;
  /** Ultra candidate: it changed protected verification-basis files in its copy, so it cannot be adopted. */
  tampered?: string[];
}

/**
 * The deadline of one sub-worker as it ran: counted from its own start, extended only by its own activity, by the orchestrator
 * assignment's limits. `hardLimitMs` is its own ceiling; the orchestrator's assignment can end it earlier (it is then `cancelled`).
 */
export interface SubWorkerDeadline {
  baseMs: number;
  hardLimitMs: number;
  maxExtensions: number;
  extensions: DeadlineExtension[];
  /** Total time the extensions added. */
  extendedMs: number;
  observations: number;
  /** The last periodic observation: liveness and recorded progress, kept apart. */
  lastObservation?: WaitObservation;
  /** Why the deadline stopped the sub-worker (its status is then `failed`): idle at an expiry, budget used up, or stalled. */
  notExtended?: { reason: NotExtendedReason; message: string };
}

/** The outcome's deadline part from a specialist call's deadline stats. */
export function subWorkerDeadline(stats: SpecialistDeadlineStats): SubWorkerDeadline {
  return {
    baseMs: stats.baseMs, hardLimitMs: stats.hardLimitMs, maxExtensions: stats.maxExtensions, extensions: stats.extensions.map(extension => ({ ...extension, reasons: [...extension.reasons] })),
    extendedMs: stats.extensions.reduce((sum, extension) => sum + extension.extensionMs, 0), observations: stats.observations,
    ...(stats.lastObservation ? { lastObservation: { ...stats.lastObservation, reasons: [...stats.lastObservation.reasons] } } : {}),
    ...(stats.notExtended ? { notExtended: { reason: stats.notExtended.reason, message: stats.notExtended.message ?? stats.notExtended.reason } } : {}),
  };
}

/** One deadline event of a running sub-worker: an extension granted, or a periodic observation. */
export type SubWorkerDeadlineEvent = { type: "extended"; extension: DeadlineExtension } | { type: "observation"; observation: WaitObservation };

/** `ext 2/10 (+30m in total) · stopped: not extended: no activity in the last 2m`: the deadline line of a sub-worker in the orche_spawn result. */
export function formatSubWorkerDeadline(deadline: SubWorkerDeadline): string | undefined {
  if (!deadline.extensions.length && !deadline.notExtended) return undefined;
  const used = `${deadline.extensions.length}/${deadline.maxExtensions} extension${deadline.maxExtensions === 1 ? "" : "s"}${deadline.extensions.length ? ` (+${formatDuration(deadline.extendedMs)}: ${deadline.extensions.map(extension => `+${formatDuration(extension.extensionMs)}`).join(", ")})` : ""}`;
  return `Deadline: base ${formatDuration(deadline.baseMs)}, ${used}${deadline.notExtended ? `; stopped: ${deadline.notExtended.message}` : ""}`;
}

/** `provider/id · thinking high` of one sub-worker as it ran (see model-use.ts); unknown when its session never started. */
export const outcomeModelUse = (outcome: Pick<SubWorkerOutcome, "model" | "thinking" | "models" | "notStarted">): string =>
  formatModelUse(outcome.notStarted ? {} : { model: outcome.model, thinking: outcome.thinking, answered: outcome.models });

/** `onModel`: once the sub-worker's session exists, the model and thinking level it really runs on (the live progress lines show them). */
/** `onDeadline`: each extension of the sub-worker's own deadline and each periodic observation (status lines and records only). */
export type RunSubWorker = (worker: PlannedWorker, siblings: readonly PlannedWorker[], signal: AbortSignal, onTool: (name: string) => void, onModel?: (use: { model: string; thinking?: string }) => void, onDeadline?: (event: SubWorkerDeadlineEvent) => void) => Promise<SubWorkerOutcome>;

/** What the orchestrator's assignment provides to one orche_spawn call (src/extension/workers.ts). */
export interface SpawnContext {
  orchestrator: string;
  /** The orchestrator's own write scope (normalized); undefined: the whole workspace. */
  scope?: readonly string[];
  /** A read-only assignment (answer): only read-only sub-workers. */
  readOnly?: boolean;
  /** The orchestrator assignment's own cancellation, next to the tool call's. */
  signal?: AbortSignal;
  /** Sub-workers per call (`single.maxSubWorkers` of the orchestrator's session; default {@link MAX_SUB_WORKERS}). */
  maxSubWorkers?: number;
  nextId(): string;
  runWorker: RunSubWorker;
  /** Workspace snapshot and diff for the after-the-fact conflict check; absent outside a git work tree. */
  snapshot?(): Promise<string>;
  diff?(from: string, to: string): Promise<readonly WorkspaceChange[]>;
  /** Live status lines (the main session's progress). */
  onProgress?(lines: string[]): void;
  /** Every finished call (details, records). */
  onSpawned?(reason: SpawnReason, outcomes: readonly SubWorkerOutcome[], warnings: readonly string[]): void;
  /**
   * Verification rounds this assignment may start (default {@link MAX_VERIFICATION_ROUNDS}); main raises it with orche_task
   * `verificationRounds` only when the user explicitly asked for more review rounds.
   */
  maxVerificationRounds?: number;
  /** A verification call refused at the cap (the result then has to state what stays unresolved; see workers.ts). */
  onVerificationRefused?(rounds: number, cap: number): void;
  /** Ultra mode: the stage contract of this assignment (src/orchestrator/ultra.ts); absent in single, strong and mdsd. */
  ultra?: UltraSpawnHooks;
  /** MDSD mode: the search policy of this assignment (src/orchestrator/mdsd.ts); absent in the other modes. */
  mdsd?: SpawnStageHooks;
}

/**
 * A stage contract around one orche_spawn call (ultra's stages, MDSD's search policy). `resolve` (optional) gives the call that runs
 * (MDSD: a pinned first search round of mdsd.replication); `validate` checks the call before any id is given out; `prepare` checks it
 * again with the ids and may give workers what they need (ultra: workspace copies; MDSD: the strategy brief, budget and report
 * contract, and with replication further cells with fresh ids from `nextId`); `finish` records the outcomes and returns lines for the
 * tool result. `call` is the whole orche_spawn call (MDSD reads its plan and adapt); ultra ignores it.
 */
export interface SpawnStageHooks {
  /** The call that runs instead of `call` (default: `call`); may refuse it by throwing, before any id is given out. */
  resolve?(call: SpawnCall): SpawnCall;
  /** Stage order, caps and roles, checked before any id is given out (a refused call uses none); throws with what to change. */
  validate(reason: SpawnReason, workers: readonly { role: string; name: string; from?: string; strategy?: unknown; request?: string; files?: readonly string[] }[], call?: SpawnCall): void;
  prepare(reason: SpawnReason, workers: PlannedWorker[], signal: AbortSignal, call?: SpawnCall, nextId?: () => string): Promise<PlannedWorker[]>;
  finish(reason: SpawnReason, workers: readonly PlannedWorker[], outcomes: SubWorkerOutcome[]): Promise<string[]>;
}
/** The ultra stage contract (src/orchestrator/ultra.ts): candidates get their workspace copies in `prepare`. */
export type UltraSpawnHooks = SpawnStageHooks;

export interface SpawnDetails { reason: SpawnReason; workers: SubWorkerOutcome[]; warnings: string[]; durationMs: number; ultra?: string[] }

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const dataLine = (data: unknown): string | undefined => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const parts = ["status", "passed", "reason", "issues", "evidence", "outputs"].filter(key => record[key] !== undefined).map(key => `${key}: ${typeof record[key] === "string" ? record[key] : JSON.stringify(record[key])}`);
  return parts.length ? clip(parts.join("; "), 2_000) : undefined;
};

export function formatSpawn(details: SpawnDetails): string {
  const cost = details.workers.reduce((sum, worker) => sum + worker.costUSD, 0);
  const requests = details.workers.reduce((sum, worker) => sum + worker.requests, 0);
  const lines = [`orche_spawn (${details.reason}): ${details.workers.length} sub-worker${details.workers.length === 1 ? "" : "s"}, ${Math.round(details.durationMs / 1000)}s, ${requests} requests${cost ? `, $${cost.toFixed(2)}` : ""}`];
  for (const worker of details.workers) {
    lines.push("", `${worker.id} ${worker.name} (${worker.role}, ${Math.round(worker.durationMs / 1000)}s, ${worker.requests} requests; ${outcomeModelUse(worker)}): ${worker.status}${worker.error ? ` — ${clip(worker.error, 300)}` : ""}`);
    // An MDSD explorer's complete report is in the round data the MDSD lines point to; its summary stays short here.
    if (worker.summary) lines.push(clip(worker.summary, worker.reason === "search" ? 900 : 4_000));
    const data = worker.reason === "search" ? undefined : dataLine(worker.data);
    if (data) lines.push(data);
    if (worker.files) lines.push(`Owned: ${worker.files.join(", ")}; changed: ${worker.changes.length ? worker.changes.join(", ") : "none"}`);
    if (worker.workspace) lines.push(`Workspace (candidate copy): ${worker.workspace}${worker.tampered?.length ? `; changed protected basis files ${worker.tampered.join(", ")}: not adoptable` : ""}`);
    const deadline = worker.deadline ? formatSubWorkerDeadline(worker.deadline) : undefined;
    if (deadline) lines.push(deadline);
  }
  if (details.warnings.length) lines.push("", ...details.warnings.map(warning => `Warning: ${warning}`));
  if (details.ultra?.length) lines.push("", ...details.ultra);
  lines.push("", "You own the result: review each report, check the changed files, run the project checks yourself, then fix or finish what is missing.");
  return lines.join("\n");
}

/** Run one validated call: all workers at once, then the conflict check. Never rejects for a sub-worker's failure (that is its outcome). */
export async function executeSpawn(context: SpawnContext, submitted: SpawnCall, signal: AbortSignal | undefined, onUpdate?: (text: string) => void): Promise<{ text: string; details: SpawnDetails }> {
  // A stage contract (ultra's stages or MDSD's search policy) may replace the call (MDSD: a pinned first round of mdsd.replication)
  // and refuse it before any id is given out.
  const stage = context.ultra ?? context.mdsd;
  const params = stage?.resolve ? stage.resolve(submitted) : submitted;
  stage?.validate(params.reason, params.workers, params);
  const planned = planSpawn(params, { ...(context.scope ? { scope: context.scope } : {}), ...(context.readOnly ? { readOnly: true } : {}), ...(context.ultra ? { ultra: true } : {}), ...(context.mdsd ? { mdsd: true } : {}), ...(context.maxSubWorkers !== undefined ? { maxSubWorkers: context.maxSubWorkers } : {}), nextId: () => context.nextId() });
  const notes = planned.notes;
  const started = Date.now();
  const signals = [signal, context.signal].filter((item): item is AbortSignal => !!item);
  const abort = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
  // The stage contract may still refuse the call (nothing ran yet); ultra gives candidates their workspace copies, MDSD gives
  // explorers their strategy brief, budget and report contract (and, with replication, the further cells their own ids).
  const workers = stage ? await stage.prepare(params.reason, planned.workers, abort, params, () => context.nextId()) : planned.workers;
  const before = context.snapshot && context.diff ? await context.snapshot().catch(() => undefined) : undefined;
  const status = new Map(workers.map(worker => [worker.id, "starting"]));
  /** What each sub-worker's session runs on, once it exists. */
  const used = new Map<string, string>();
  /** Each sub-worker's deadline state: `ext 2/10`, the last check. */
  const timing = new Map<string, string>();
  let lastUpdate = 0;
  const linesNow = () => workers.map(worker => `${context.orchestrator} → ${worker.id} ${worker.name} (${worker.role}${used.has(worker.id) ? ` · ${used.get(worker.id)}` : ""}): ${status.get(worker.id)}${timing.has(worker.id) ? ` · ${timing.get(worker.id)}` : ""}`);
  const publish = (force = false) => {
    const lines = linesNow();
    context.onProgress?.(lines);
    // Partial tool output keeps the orchestrator "active" for its deadline while its sub-workers work (liveness counts tool output).
    if (force || Date.now() - lastUpdate >= 3_000) { lastUpdate = Date.now(); onUpdate?.(lines.join("\n")); }
  };
  /**
   * Deadline events of a sub-worker go to the status lines only, never to the tool's partial output: a periodic observation is
   * produced whether or not the sub-worker is alive, so it must not count as the orchestrator's activity (its liveness merges the
   * sub-workers' own session events instead).
   */
  const showTiming = (id: string, event: SubWorkerDeadlineEvent) => {
    if (event.type === "extended") {
      const { extension } = event;
      timing.set(id, `ext ${extension.n}/${extension.max} (+${formatDuration(extension.extensionMs)}): ${extension.reasons[0] ?? "still active"}`);
    } else {
      const { observation } = event;
      const ext = observation.extensionsUsed ? `ext ${observation.extensionsUsed} · ` : "";
      timing.set(id, `${ext}check ${observation.n}: ${observation.alive ? "alive" : `NOT alive${observation.inExtension ? ` (${observation.inactiveStreak} consecutive)` : ""}`}`);
    }
    context.onProgress?.(linesNow());
  };
  publish(true);
  const outcomes = await Promise.all(workers.map(async worker => {
    const outcome = await context.runWorker(worker, workers, abort, name => { status.set(worker.id, `last tool ${name}`); publish(); }, use => { used.set(worker.id, formatModelUse(use)); publish(true); }, event => showTiming(worker.id, event));
    used.set(worker.id, outcomeModelUse(outcome));
    status.set(worker.id, outcome.status);
    timing.delete(worker.id);
    publish(true);
    return outcome;
  }));
  const warnings = notes.map(note => note.replace(/\.$/, ""));
  if (before !== undefined && context.snapshot && context.diff) {
    try {
      const after = await context.snapshot();
      const changes = await context.diff(before, after);
      const unowned: string[] = [];
      for (const change of changes) {
        // A candidate writes only in its own copy: whatever changed here is nobody's.
        const owners = outcomes.filter(outcome => !outcome.workspace && outcome.files?.some(owned => ownsPath(owned, change.path)));
        for (const owner of owners) owner.changes.push(change.path);
        if (!owners.length) unowned.push(change.path);
      }
      if (unowned.length) warnings.push(`changed during orche_spawn outside every sub-worker's owned files: ${unowned.slice(0, 30).join(", ")}${unowned.length > 30 ? `, … ${unowned.length - 30} more` : ""} (a shell write of a sub-worker or another session; check them)`);
    } catch { warnings.push("workspace check after orche_spawn failed; check the changed files yourself"); }
  }
  // Ultra: candidate diffs, the protected verification basis and the stage record, after the shared-workspace check above.
  // MDSD: the round's measured footprints, redundancy, aggregation and budget (the same `ultra` lines slot of the result).
  let ultra: string[] | undefined;
  if (stage) {
    try { ultra = await stage.finish(params.reason, workers, outcomes); } catch (error) { ultra = [context.ultra ? `Ultra: recording this call failed (${error instanceof Error ? error.message : String(error)}); its candidates cannot be adopted.` : `MDSD: recording this call failed (${error instanceof Error ? error.message : String(error)}); its measurements are incomplete.`]; }
  }
  const details: SpawnDetails = { reason: params.reason, workers: outcomes, warnings, durationMs: Date.now() - started, ...(ultra?.length ? { ultra } : {}) };
  context.onSpawned?.(params.reason, outcomes, warnings);
  return { text: formatSpawn(details), details };
}

/**
 * The tool. `context()` resolves the current assignment's SpawnContext at call time (the tool lives as long as the worker's
 * session; the context only during an orchestrator assignment) or says why it is unavailable.
 */
/**
 * Verification rounds (orche_spawn calls with reason "verification") one orchestrator assignment may start. A review loop that
 * finds something new in every round does not converge by itself (one real task ran five rounds and 116 minutes); past the cap the
 * orchestrator fixes what is clearly in scope and reports the remaining findings (`data.unresolved`) for main and the user to decide.
 * A round counts once a verifier finished its review (passed or not passed). A call refused before any verifier ran (an invalid call,
 * a stage contract's refusal) counts nothing, and a round in which every verifier failed or was cancelled (a provider disconnect, a
 * crash) reviewed nothing: it counts apart (`voidVerificationRounds`, against the same cap), so it does not use up the review a later
 * adoption still needs, while repeated failures stop too.
 */
const verificationRounds = new WeakMap<SpawnContext, number>();
const voidVerificationRounds = new WeakMap<SpawnContext, number>();
const reviewed = (outcome: SubWorkerOutcome) => outcome.status === "passed" || outcome.status === "not passed";

/** `maxSubWorkers`: the session's per-call cap (`single.maxSubWorkers`, read when the session starts), in the schema and the description. */
export function createSpawnTool(context: () => SpawnContext | string, options: { ultra?: boolean; mdsd?: boolean; maxSubWorkers?: number } = {}): ToolDefinition {
  const max = options.maxSubWorkers ?? MAX_SUB_WORKERS;
  return {
    name: SPAWN_TOOL,
    label: "orche spawn",
    description: options.ultra
      ? `Start up to ${max} sub-workers in fresh sessions at the same time and wait for all of them, by the ultra stage contract of your assignment: exploration (independent verification basis and hypotheses), candidates (independent implementations, each in its own workspace copy, or independent answers), verification (fresh read-only verifiers) or isolation (a game-asset/video specialist). Sub-workers see only their request and cannot spawn.`
      : options.mdsd
      ? `Start up to ${max} sub-workers in fresh sessions at the same time and wait for all of them, by the MDSD search policy of your assignment: search (independent read-only explorers, each with a strategy spec; plan on the first round, adapt on later ones), parallelism (writers implementing after the judgment), verification (fresh read-only verifiers) or isolation (a game-asset/video specialist). Sub-workers see only their request and cannot spawn.`
      : `Start up to ${max} sub-workers in fresh sessions at the same time and wait for all of them: independent parallel parts (each writer owns disjoint files), an isolated game-asset/video specialist, or fresh read-only verifiers. Sub-workers see only their request and cannot spawn. Use it only when the orchestration rules of your assignment say the task should be split.`,
    parameters: options.ultra ? ultraSpawnParametersFor(max) : options.mdsd ? mdsdSpawnParametersFor(max) : spawnParametersFor(max),
    executionMode: "sequential",
    execute: async (_id, params, signal, onUpdate): Promise<AgentToolResult<SpawnDetails | undefined>> => {
      const current = context();
      if (typeof current === "string") return { content: [{ type: "text", text: current }], details: undefined, isError: true } as AgentToolResult<undefined>;
      const verification = (params as SpawnCall).reason === "verification";
      const cap = current.maxVerificationRounds ?? MAX_VERIFICATION_ROUNDS;
      if (verification) {
        const rounds = verificationRounds.get(current) ?? 0;
        const voids = voidVerificationRounds.get(current) ?? 0;
        if (rounds >= cap) {
          current.onVerificationRefused?.(rounds, cap);
          return { content: [{ type: "text", text: `Refused: this assignment already ran ${rounds} verification round${rounds === 1 ? "" : "s"} (the cap is ${cap}; only main can raise it, with orche_task verificationRounds when the user asks for more review). Do not start another review round: fix only clear, in-scope defects the last verifiers found, run the project checks yourself (the cap limits fresh verifier sessions, not your own tests), and report_result with data.unresolved listing the remaining findings and any verification you could not do (one short item each, with file references; [] only when nothing remains) so main and the user can decide on them.` }], details: undefined, isError: true } as AgentToolResult<undefined>;
        }
        if (voids >= cap) {
          current.onVerificationRefused?.(rounds + voids, cap);
          return { content: [{ type: "text", text: `Refused: ${voids} verification round${voids === 1 ? "" : "s"} of this assignment ended without any verifier's verdict (each verifier failed or was cancelled; the cap for such rounds is ${cap}). Do not start another review round: run the project checks yourself, and report_result with data.unresolved listing the review that could not run and the remaining findings (one short item each, with file references) so main and the user can decide on them.` }], details: undefined, isError: true } as AgentToolResult<undefined>;
        }
        // Taken while the call runs (orche_spawn calls run one at a time) and given back below when the round reviewed nothing.
        verificationRounds.set(current, rounds + 1);
      }
      const giveBack = () => verificationRounds.set(current, Math.max(0, (verificationRounds.get(current) ?? 1) - 1));
      const voidRound = () => { const voids = (voidVerificationRounds.get(current) ?? 0) + 1; voidVerificationRounds.set(current, voids); return voids; };
      // executeSpawn publishes its status lines once the call is valid and prepared, right before its workers start.
      let started = false;
      let result: Awaited<ReturnType<typeof executeSpawn>>;
      try {
        result = await executeSpawn(current, params as SpawnCall, signal, text => { started = true; onUpdate?.({ content: [{ type: "text", text }], details: undefined }); });
      } catch (error) {
        // Refused before any verifier ran: no round. Failed after they started: no verdict reached the orchestrator, a round without one.
        if (verification) { giveBack(); if (started) voidRound(); }
        throw error;
      }
      let text = result.text;
      if (verification && !result.details.workers.some(reviewed)) {
        giveBack();
        const voids = voidRound();
        const left = Math.max(0, cap - voids);
        text += `\n\nNo verifier finished with a verdict (each failed or was cancelled): this round does not count against the verification cap (${left} such round${left === 1 ? "" : "s"} left).`;
      }
      return { content: [{ type: "text", text }], details: result.details };
    },
  } as ToolDefinition;
}
