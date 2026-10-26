/**
 * ultra-ho: a reproducible ultra/strong experiment harness pinned to ONE model route (experiments/ultra-ho/README.md).
 * The pure parts, unit-tested without any model (test/experiments/ultra-ho.test.ts): the pinned route and the private orche config,
 * the plan and its seeded unit schedule, the wire fidelity classifier (prompt_cache_key → session → role, with usage by role at
 * list prices), and the audit of ultra stages a report names against what the runtime recorded.
 *
 * Reused unchanged from the frozen ultra-ab harness (experiments/ultra-ab/protocol.ts): `userPrompt` (the same constraints text),
 * `rng`/`shuffle`, `terminalOf`, `primaryPass`. NOT reused: its THINKING (orchestrator xhigh) and orcheConfig (older settings).
 */
import { createHash } from "node:crypto";
import { rng, shuffle, userPrompt, type TaskSpec } from "../ultra-ab/protocol.js";

export { primaryPass, terminalOf, userPrompt, type Integrity, type TaskSpec, type Terminal } from "../ultra-ab/protocol.js";

// ---------------------------------------------------------------------------------------------------------------------------
// The one route

/** Every role, every tier, every request: the canonical route (never the `bts/` variant), effort high. Never xhigh or max. */
export const MODEL = { provider: "cliproxyapi", id: "gpt-6.1-sol" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
export const THINKING = "high" as const;
/** orche's model tiers (src/orchestration/routing.ts MODEL_TIERS): all pinned, so no tier can inherit or fall back to another model. */
export const TIERS = ["main", "orchestrator", "worker", "strong-orchestrator", "strong-worker", "advisor"] as const;
export const ROUTE = { model: MODEL_REF, thinking: THINKING } as const;

export const MODES = ["ultra", "strong"] as const;
export type Mode = typeof MODES[number];

/**
 * Default limits (the plan's): orche 60 min base per assignment, at most 2 extensions of 15 min while active (ceiling 90 min),
 * soft budget 300 requests; the Pi process group (main + every orche task it starts) is killed at 150 min.
 */
export const DEFAULT_LIMITS: Readonly<Record<string, number>> = { overallMs: 60 * 60_000, assignmentMs: 60 * 60_000, extensionMs: 15 * 60_000, extensionStepMs: 0, maxExtensions: 2, assignmentRequests: 300 };
export const DEFAULT_PI_GUARD_MS = 150 * 60_000;
/** Collection and grading after Pi ended: the unit process's own outer guard is the Pi guard plus this. */
export const COLLECT_GUARD_MS = 40 * 60_000;
/** Infrastructure retries per unit: only a run without any successful model request runs again (once). */
export const INFRA_RETRIES = 1;
/** orche's run limits (src/orchestration/limits.ts RunLimits); integer-valued ones are checked as such. */
export const LIMIT_KEYS = ["overallMs", "explorationMs", "assignmentMs", "decisionMs", "maxFixRounds", "decisionRepairs", "assignmentRequests", "extensionMs", "extensionStepMs", "maxExtensions", "activityWindowMs", "observeMs"] as const;
const INTEGER_LIMITS = new Set(["maxFixRounds", "decisionRepairs", "assignmentRequests", "maxExtensions"]);

/** The private orche.config.json of every run (written into the run's own agent dir; the user's config is never read or written). */
export function orcheConfig(limits: Readonly<Record<string, number>> = DEFAULT_LIMITS): Record<string, unknown> {
  return {
    mainMode: "single",
    routes: {},
    default: { ...ROUTE },
    models: Object.fromEntries(TIERS.map(tier => [tier, { ...ROUTE }])),
    // Product default maxSubWorkers (unset); the advisor stays off (its tier is pinned anyway).
    single: { ledger: false, spawn: true, advisor: false },
    thinkingPolicy: { mode: "fixed", lengthRecovery: "redecompose" },
    limits: { ...limits },
    concurrentSessions: { enabled: false },
    bashReview: { enabled: false },
  };
}

/** The private Pi settings.json: the same route and effort as the CLI flags; SSE so the proxy can read every stream. */
export const piSettings = (): Record<string, unknown> => ({ defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: THINKING, quietStartup: true, transport: "sse" });

/** The one-shot command main receives: `/orche ultra|strong <ultra-ab userPrompt>`. */
export const oneShot = (mode: Mode, task: TaskSpec): string => `/orche ${mode} ${userPrompt(task)}`;

// ---------------------------------------------------------------------------------------------------------------------------
// Plan and schedule

export interface ArmSpec {
  name: string;
  mode: Mode;
  /** `<out>/rt-<runtime>` (cli.ts freeze): every unit of this arm runs that frozen copy. */
  runtime: string;
  /** Overrides of DEFAULT_LIMITS (orche `limits`). */
  limits?: Record<string, number>;
  piGuardMs?: number;
  note?: string;
}
export interface TaskRef { task: string; kind?: "suite" | "swe" }
export interface Plan {
  /** Study directory (relative paths: from the repository root). */
  out: string;
  phase: string;
  seed: string;
  repeats: number;
  concurrency: number;
  /** Absolute, outside the repository: workspaces, private agent dirs, TMPDIR of the runs. */
  scratch: string;
  /** Absolute, outside the repository: SWE environments are staged here (only needed with SWE tasks). */
  sweCache?: string;
  /**
   * The SWE fixture root the tasks are read from (relative: from the repository; default env.ts DEFAULT_SWE_FIXTURES, the canonical
   * fixtures/advisor-bench/swe) and the environment cache they are staged from (default DEFAULT_SWE_CACHE_SOURCE). Part of the plan
   * hash when given; a plan without them runs exactly as before.
   */
  sweFixtures?: string;
  sweCacheSource?: string;
  tasks: TaskRef[];
  arms: ArmSpec[];
  note?: string;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const TASK = /^[A-Za-z0-9._-]{1,120}$/;
const PLAN_KEYS = new Set(["out", "phase", "seed", "repeats", "concurrency", "scratch", "sweCache", "sweFixtures", "sweCacheSource", "tasks", "arms", "note"]);
const ARM_KEYS = new Set(["name", "mode", "runtime", "limits", "piGuardMs", "note"]);

/** Validate a plan. Unknown keys are refused, so no plan can name another model or effort (the route is not a plan setting). */
export function parsePlan(value: unknown): Plan {
  const fail = (message: string): never => { throw new Error(`plan: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const plan = value as Record<string, unknown>;
  const unknown = Object.keys(plan).filter(key => !PLAN_KEYS.has(key));
  if (unknown.length) fail(`unknown field(s) ${unknown.join(", ")} (the model route and effort are fixed by the harness)`);
  const text = (key: string, required = true) => { const item = plan[key]; if (item === undefined && !required) return undefined; if (typeof item !== "string" || !item.trim()) fail(`${key}: expected a non-empty string`); return item as string; };
  const count = (key: string) => { const item = plan[key]; if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1) fail(`${key}: expected an integer >= 1`); return item as number; };
  const phase = text("phase", false) ?? "main";
  if (!NAME.test(phase)) fail("phase: expected [A-Za-z0-9._-]");
  const scratch = text("scratch")!;
  if (!scratch.startsWith("/")) fail("scratch: expected an absolute path");
  const sweCache = text("sweCache", false);
  if (sweCache !== undefined && !sweCache.startsWith("/")) fail("sweCache: expected an absolute path");
  const sweFixtures = text("sweFixtures", false);
  const sweCacheSource = text("sweCacheSource", false);
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) fail("tasks: expected a non-empty array");
  const tasks = (plan.tasks as unknown[]).map((item, index): TaskRef => {
    const ref: Record<string, unknown> = typeof item === "string" ? { task: item } : item as Record<string, unknown>;
    if (!ref || typeof ref !== "object" || typeof ref.task !== "string" || !TASK.test(ref.task)) fail(`tasks[${index}]: expected a task id or { task, kind? }`);
    if (ref.kind !== undefined && ref.kind !== "suite" && ref.kind !== "swe") fail(`tasks[${index}].kind: expected "suite" or "swe"`);
    if (Object.keys(ref).some(key => key !== "task" && key !== "kind")) fail(`tasks[${index}]: unknown field`);
    return { task: ref.task as string, ...(ref.kind ? { kind: ref.kind as "suite" | "swe" } : {}) };
  });
  if (new Set(tasks.map(item => item.task)).size !== tasks.length) fail("tasks: duplicate task");
  if (!Array.isArray(plan.arms) || !plan.arms.length) fail("arms: expected a non-empty array");
  const arms = (plan.arms as unknown[]).map((item, index): ArmSpec => {
    const at = `arms[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`${at}: expected an object`);
    const arm = item as Record<string, unknown>;
    const extra = Object.keys(arm).filter(key => !ARM_KEYS.has(key));
    if (extra.length) fail(`${at}: unknown field(s) ${extra.join(", ")} (the model route and effort are fixed by the harness)`);
    if (typeof arm.name !== "string" || !NAME.test(arm.name)) fail(`${at}.name: expected [A-Za-z0-9._-]`);
    if (!MODES.includes(arm.mode as Mode)) fail(`${at}.mode: expected ${MODES.join(" or ")}`);
    if (typeof arm.runtime !== "string" || !NAME.test(arm.runtime)) fail(`${at}.runtime: expected the name of a frozen runtime ([A-Za-z0-9._-])`);
    const limits: Record<string, number> = {};
    if (arm.limits !== undefined) {
      if (!arm.limits || typeof arm.limits !== "object" || Array.isArray(arm.limits)) fail(`${at}.limits: expected an object`);
      for (const [key, number] of Object.entries(arm.limits as Record<string, unknown>)) {
        if (!(LIMIT_KEYS as readonly string[]).includes(key)) fail(`${at}.limits.${key}: unknown limit (expected ${LIMIT_KEYS.join(", ")})`);
        if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || INTEGER_LIMITS.has(key) && !Number.isSafeInteger(number)) fail(`${at}.limits.${key}: expected a finite non-negative ${INTEGER_LIMITS.has(key) ? "integer" : "number"}`);
        limits[key] = number as number;
      }
    }
    if (arm.piGuardMs !== undefined && (typeof arm.piGuardMs !== "number" || !Number.isSafeInteger(arm.piGuardMs) || arm.piGuardMs < 60_000)) fail(`${at}.piGuardMs: expected an integer >= 60000`);
    if (arm.note !== undefined && typeof arm.note !== "string") fail(`${at}.note: expected a string`);
    return { name: arm.name as string, mode: arm.mode as Mode, runtime: arm.runtime as string, ...(arm.limits !== undefined ? { limits } : {}), ...(arm.piGuardMs !== undefined ? { piGuardMs: arm.piGuardMs as number } : {}), ...(arm.note ? { note: arm.note as string } : {}) };
  });
  if (new Set(arms.map(arm => arm.name)).size !== arms.length) fail("arms: duplicate name");
  if (plan.note !== undefined && typeof plan.note !== "string") fail("note: expected a string");
  return { out: text("out")!, phase, seed: text("seed")!, repeats: count("repeats"), concurrency: count("concurrency"), scratch, ...(sweCache ? { sweCache } : {}), ...(sweFixtures ? { sweFixtures } : {}), ...(sweCacheSource ? { sweCacheSource } : {}), tasks, arms, ...(plan.note ? { note: plan.note as string } : {}) };
}

/** The effective limits and Pi guard of an arm. */
export function armSettings(arm: Pick<ArmSpec, "limits" | "piGuardMs">): { limits: Record<string, number>; piGuardMs: number } {
  return { limits: { ...DEFAULT_LIMITS, ...(arm.limits ?? {}) }, piGuardMs: arm.piGuardMs ?? DEFAULT_PI_GUARD_MS };
}

/** Hash of what defines the measured units (out, concurrency and scratch are where/how, not what). */
export function planHash(plan: Plan): string {
  const { out: _out, concurrency: _concurrency, scratch: _scratch, sweCache: _sweCache, note: _note, ...what } = plan;
  return createHash("sha256").update(JSON.stringify(what)).digest("hex");
}

export interface Unit { id: string; task: string; arm: string; repeat: number }
export const unitId = (task: string, arm: string, repeat: number): string => `${task}/${arm}/r${repeat}`;

/**
 * Run order: repeat-major; within a repeat the tasks in the plan's order; within each (task, repeat) block the arms in a seeded
 * random order (seed + task + repeat: ultra-ab's mulberry32 and Fisher-Yates), so no arm is systematically first.
 */
export function schedule(plan: Pick<Plan, "tasks" | "arms" | "repeats" | "seed">): { unit: Unit; order: string[] }[] {
  const out: { unit: Unit; order: string[] }[] = [];
  for (let repeat = 1; repeat <= plan.repeats; repeat++) {
    for (const { task } of plan.tasks) {
      const order = shuffle(plan.arms.map(arm => arm.name), rng(`${plan.seed}/${task}/r${repeat}`));
      for (const arm of order) out.push({ unit: { id: unitId(task, arm, repeat), task, arm, repeat }, order });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Wire fidelity

/** One line of experiments/mdsd-ab/proxy.mjs's wire log (copied to ./proxy.mjs). */
export interface WireEntry {
  id: number; at: string; endAt?: string; method?: string; path?: string; model?: string; effort?: string; updateEfforts?: string[];
  session?: string; status?: number; respModel?: string; finalModel?: string; final?: string;
  usage?: { input: number; cached: number; cacheWrite?: number; output: number; reasoning?: number }; costUSD?: number; unpriced?: boolean;
  noFinalEvent?: boolean; errorEvent?: boolean; providerError?: unknown; error?: string; refused?: unknown; upgrade?: boolean; parseError?: string; unparsed?: number;
}

export type Role = "main" | "orchestrator" | "sub-worker" | "other" | "unattributed";
/** A session of the run: the role and the agent id (main, W1, W1.3, …) its prompt_cache_key is attributed to. */
export interface SessionInfo { role: Exclude<Role, "unattributed">; agent: string; file?: string }

/** Role of an orche agent id: W<n> an orche_task worker (the orchestrator), W<n>.<m> its sub-worker. */
export const roleOfAgent = (agent: string): Exclude<Role, "unattributed" | "main"> => /^W\d+$/.test(agent) ? "orchestrator" : /^W\d+\.\d+$/.test(agent) ? "sub-worker" : "other";

export interface Usage { requests: number; ok: number; providerErrors: number; input: number; cached: number; cacheWrite: number; output: number; reasoning: number; costUSD: number; unpriced: number; unknownUsage: number }
const emptyUsage = (): Usage => ({ requests: 0, ok: 0, providerErrors: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, costUSD: 0, unpriced: 0, unknownUsage: 0 });
export interface Fidelity {
  /** POST model requests. */
  requests: number;
  /** Of them answered HTTP 200. */
  ok: number;
  /** Route violations: `#<id> <role> <agent>: <problem>, …` (model, request effort, configuration_update effort, response model). */
  violations: string[];
  /** Requests whose prompt_cache_key belongs to no recorded session (reported apart: the route may still be right). */
  unattributed: string[];
  byRole: Record<string, Usage>;
  bySession: Record<string, Usage & { role: string; agent: string; key: string }>;
  efforts: Record<string, number>; updateEfforts: Record<string, number>; models: Record<string, number>; respModels: Record<string, number>; statuses: Record<string, number>;
  providerErrors: { id: number; status?: number; agent: string; error: unknown }[];
  upgradesRefused: number;
  costUSD: number;
}

const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Classify one run's wire log. Every POST model request must name gpt-6.1-sol with request effort high, every configuration_update
 * item it carries must say high, and the provider's response must name gpt-6.1-sol (the stream head and the final event; a 200
 * without either is unverifiable, which is a violation too). Each request is attributed by its prompt_cache_key to the recorded
 * session it belongs to; usage and list-price cost (the proxy's `costUSD`) are summed per role and per session.
 */
export function classifyWire(entries: readonly WireEntry[], sessions: ReadonlyMap<string, SessionInfo>): Fidelity {
  const out: Fidelity = { requests: 0, ok: 0, violations: [], unattributed: [], byRole: {}, bySession: {}, efforts: {}, updateEfforts: {}, models: {}, respModels: {}, statuses: {}, providerErrors: [], upgradesRefused: 0, costUSD: 0 };
  for (const entry of entries) {
    if (entry.upgrade) { out.upgradesRefused++; continue; }
    if (entry.method === "POST" && !entry.model && (entry.parseError || entry.unparsed)) { out.violations.push(`#${entry.id} ?: unparsed POST ${entry.path ?? ""} (model and effort unverifiable)`); continue; }
    if (entry.method !== "POST" || !entry.model) continue;
    out.requests++;
    const session = entry.session !== undefined ? sessions.get(entry.session) : undefined;
    const role: Role = session?.role ?? "unattributed";
    const agent = session?.agent ?? `?${entry.session ?? "(no prompt_cache_key)"}`;
    if (!session) out.unattributed.push(`#${entry.id} ${entry.session ?? "(no prompt_cache_key)"}`);
    const problems: string[] = [];
    if (entry.model !== MODEL.id) problems.push(`model ${entry.model}`);
    if (entry.effort !== THINKING) problems.push(`request effort ${entry.effort ?? "none"}`);
    for (const effort of entry.updateEfforts ?? []) if (effort !== THINKING) problems.push(`configuration_update effort ${effort}`);
    const responded = [entry.respModel, entry.finalModel].filter((model): model is string => typeof model === "string");
    if (entry.status === 200 && !responded.length) problems.push("response model unverifiable");
    for (const model of new Set(responded)) if (model !== MODEL.id) problems.push(`response model ${model}`);
    if (problems.length) out.violations.push(`#${entry.id} ${role} ${agent}: ${problems.join(", ")}`);
    bump(out.efforts, String(entry.effort ?? "none"));
    for (const effort of entry.updateEfforts ?? []) bump(out.updateEfforts, effort);
    bump(out.models, entry.model);
    bump(out.respModels, responded.length ? [...new Set(responded)].join("|") : "?");
    bump(out.statuses, String(entry.status ?? "none"));
    const isError = entry.status !== 200 || !!entry.error || !!entry.errorEvent || !!entry.providerError;
    if (isError) out.providerErrors.push({ id: entry.id, ...(entry.status !== undefined ? { status: entry.status } : {}), agent, error: entry.providerError ?? entry.error ?? (entry.errorEvent ? "error event in the stream" : `HTTP ${entry.status ?? "none"}`) });
    const key = entry.session ?? "(none)";
    const totals = [out.byRole[role] ??= emptyUsage(), out.bySession[agent] ??= { ...emptyUsage(), role, agent, key }];
    for (const total of totals) {
      total.requests++;
      if (entry.status === 200) total.ok++;
      if (isError) total.providerErrors++;
      if (entry.usage) {
        total.input += entry.usage.input ?? 0; total.cached += entry.usage.cached ?? 0; total.cacheWrite += entry.usage.cacheWrite ?? 0;
        total.output += entry.usage.output ?? 0; total.reasoning += entry.usage.reasoning ?? 0;
        if (typeof entry.costUSD === "number") total.costUSD = round6(total.costUSD + entry.costUSD); else total.unpriced++;
      } else total.unknownUsage++;
    }
    if (entry.status === 200) out.ok++;
    if (typeof entry.costUSD === "number") out.costUSD = round6(out.costUSD + entry.costUSD);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Ultra stages: what a report names against what the runtime recorded

/** src/orchestrator/ultra.ts ULTRA_STAGES (the test checks they are the product's). */
export const ULTRA_STAGES = ["criteria", "exploration", "candidates", "evaluation", "selection", "review", "integration", "complete"] as const;
/** "verification" is the orche_spawn reason of the review stage (src/orchestrator/ultra.ts STAGE_ALIASES). */
const stageName = (stage: string | undefined): string | undefined => stage === "verification" ? "review" : stage;

/** The runtime facts of one ultra assignment (its run summary, carried state included). */
export interface UltraFacts { explorationRounds: number; candidateRounds: number; candidates: string[]; adoptions: string[]; verificationRounds: number; gate?: string }

/**
 * The furthest stage the runtime record supports (src/orchestrator/ultra.ts stage() with stoppedAt's furthest): nothing adopted →
 * at most selection (after candidates), candidates (after exploration) or exploration; adopted → review, integration once a
 * verification round ran in the assignment.
 */
export function reachedStage(facts: UltraFacts): string {
  if (facts.adoptions.length) return facts.verificationRounds > 0 ? "integration" : "review";
  if (facts.candidates.length) return "selection";
  return facts.explorationRounds ? "candidates" : "exploration";
}

/** The `data.ultra` part of a report that names stages. */
export interface UltraClaim { stage?: string; candidates?: { id?: string }[]; selection?: { chosen?: string }; review?: unknown[]; integration?: { evidence?: unknown[] } }

/**
 * Stages a report (or a result line) names that the runtime record does not show: a stage beyond the one reached, "complete"
 * without a passed gate, review entries without a verification round, a selection or integration evidence without an adoption,
 * candidate ids the runtime does not know. Empty: every named stage ran.
 */
export function unsupportedStageClaims(claim: UltraClaim | undefined, facts: UltraFacts): string[] {
  if (!claim) return [];
  const issues: string[] = [];
  const stage = stageName(claim.stage);
  const reached = reachedStage(facts);
  if (stage === "complete") { if (facts.gate !== "passed") issues.push(`stage complete named, report gate ${facts.gate ?? "not reached"}`); }
  else if (stage !== undefined) {
    const at = ULTRA_STAGES.indexOf(stage as typeof ULTRA_STAGES[number]);
    if (at < 0) issues.push(`unknown stage ${stage}`);
    else if (at > ULTRA_STAGES.indexOf(reached as typeof ULTRA_STAGES[number])) issues.push(`stage ${stage} named, the runtime reached ${reached}`);
  }
  if (Array.isArray(claim.review) && claim.review.length && facts.verificationRounds === 0) issues.push(`${claim.review.length} review finding(s) named without a verification round in this assignment`);
  if (claim.selection?.chosen && !facts.adoptions.includes(claim.selection.chosen)) issues.push(`selection of ${claim.selection.chosen} named without its adoption`);
  if (Array.isArray(claim.integration?.evidence) && claim.integration!.evidence!.length && !facts.adoptions.length) issues.push("integration evidence named without an adoption");
  const unknown = (claim.candidates ?? []).map(item => item?.id).filter((id): id is string => typeof id === "string" && !facts.candidates.includes(id));
  if (unknown.length) issues.push(`candidates the runtime does not know: ${unknown.join(", ")}`);
  return issues;
}

/** The parts of an `Ultra:` result line (src/orchestrator/ultra.ts UltraRun.lines). */
export function parseUltraLine(line: string): { stage?: string; exploration?: number; candidates?: number; verification?: number; gate?: string; carried: boolean } {
  const match = /^Ultra: stage (\S+); exploration (\d+)\/\d+ round\(s\), candidates (\d+)\/\d+ round\(s\) \(.*\), verification (\d+)\/\d+ round\(s\)(?: \(\+\d+ without a finished verifier\))?; report gate (.*?)(; continued from the previous assignment of this task)?$/.exec(line);
  if (!match) return { carried: line.includes("continued from the previous assignment of this task") };
  return { stage: match[1]!, exploration: Number(match[2]), candidates: Number(match[3]), verification: Number(match[4]), gate: match[5]!, carried: !!match[6] };
}
