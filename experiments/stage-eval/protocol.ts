/**
 * Stage evaluation (docs/stage-eval.md): pure Pi versus orche direct / single / single + advisor on the same model, effort,
 * prompt, tasks, grader and environment, then cumulative product stages measured on the single arm. Pure parts of the protocol,
 * shared by run-one.ts, driver.ts and analyze.ts and unit-tested without any model (test/experiments/stage-eval.test.ts).
 *
 * Arms (kind):
 * - pure:            Pi CLI with no extension except the CLIProxyAPI provider bundle (model access only): no orche, no other
 *                    extension, skill, prompt template, MCP or context file. Pi's own system prompt and default tools.
 * - direct:          the same invocation plus a frozen orche runtime with `mainMode: "direct"` (main edits with orche's tools).
 * - single:          the same plus `mainMode: "single"`, `single.advisor: false` (main hands the task to one orche worker).
 * - single-advisor:  as single with `single.advisor: true` (the plan advisor on its own model route, the user's current setting).
 * Stage arms are `single` on a later frozen runtime (labels s2, s5, s6, s7 = cumulative product stages).
 */
import { createHash } from "node:crypto";

export const MODEL = { provider: "cliproxyapi", id: "claude-opus-5-5" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
/** The user's current advisor route (~/.pi/agent/orche.config.json models.advisor): another model family, thinking "main". */
export const ADVISOR_MODEL = { provider: "cliproxyapi", id: "gpt-6-astra" } as const;
export const ADVISOR_MODEL_REF = `${ADVISOR_MODEL.provider}/${ADVISOR_MODEL.id}`;
export const THINKING = "high";

export type Kind = "pure" | "direct" | "single" | "single-advisor";
export interface Arm { name: string; kind: Kind; runtime?: string }

export const BASELINE_ARMS: readonly Arm[] = [
  { name: "A", kind: "pure" },
  { name: "B", kind: "direct", runtime: "baseline" },
  { name: "C", kind: "single", runtime: "baseline" },
  { name: "D", kind: "single-advisor", runtime: "baseline" },
];

export const LIMITS = {
  /** Hard kill of one Pi process group (main and every orche session it started); the same for every arm. Not a product limit. */
  piGuardMs: 120 * 60_000,
  /** Infrastructure retries per unit (no successful model request at all). */
  infraRetries: 1,
} as const;

/**
 * The private orche.config.json of an orche arm: the user's current single-workflow settings (mainCompaction 0.8, maxSubWorkers 8,
 * advisor route gpt-6-astra with main's thinking) with every solver tier pinned to the evaluation model. Product defaults
 * everywhere else (limits, thinking policy, compaction, read nodes). Specialist routes and images are not exercised and omitted.
 */
export function orcheConfig(kind: Exclude<Kind, "pure">): Record<string, unknown> {
  return {
    mainMode: kind === "direct" ? "direct" : "single",
    // Required by the route-config parser (an object); no role route is exercised.
    routes: {},
    mainCompaction: 0.8,
    single: { advisor: kind === "single-advisor", maxSubWorkers: 8 },
    models: {
      orchestrator: { model: MODEL_REF, thinking: "main" },
      advisor: { model: ADVISOR_MODEL_REF, thinking: "main" },
    },
    default: { model: MODEL_REF, thinking: THINKING, extendedContext: true },
  };
}

export interface TaskSpec { id: string; kind: "suite" | "swe" | "image"; title: string; instruction: string }

/**
 * Appended to every task in every arm and stage. The clarification policy is the predefined unattended-benchmark policy: nobody
 * answers questions during a run and no hidden answer exists; the agent states the reading it chose. It is part of the frozen
 * prompt from the first baseline run on, so every arm and stage receives the same text.
 */
export const CONSTRAINTS = [
  "Constraints: work only inside this workspace (the current directory; temporary files in your scratch directory are fine); no git commits; no network access is needed or available; do not weaken, skip or delete existing tests. The result is graded afterwards by tests you do not see.",
  "Nobody can answer questions during this run: where the request is ambiguous, choose the reading best supported by the request and the repository, state it in your final answer, and complete the work.",
].join("\n");

export function userPrompt(task: TaskSpec): string {
  return `${task.instruction.trim()}\n\n${CONSTRAINTS}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Schedule

export function rng(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Unit { id: string; task: string; arm: Arm; repeat: number }
export const unitId = (task: string, arm: string, repeat: number): string => `${task}/${arm}/r${repeat}`;

/** Repeat-major; tasks in the plan's order; inside each (task, repeat) block the arms in a seeded random order. */
export function schedule(tasks: readonly string[], arms: readonly Arm[], repeats: number, seed: string, firstRepeat = 1): Unit[] {
  const out: Unit[] = [];
  for (let repeat = firstRepeat; repeat < firstRepeat + repeats; repeat++) {
    for (const task of tasks) {
      for (const arm of shuffle(arms, rng(`${seed}/${task}/r${repeat}`))) out.push({ id: unitId(task, arm.name, repeat), task, arm, repeat });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Outcome

export type Terminal = "done" | "blocked" | "failed" | "timeout" | "cancelled" | "no-task" | "exit-error" | "harness-timeout" | "infra";

/**
 * Terminal status of one run. Every arm: `infra` (no successful model request / harness failure), `harness-timeout` (the guard
 * killed the process group), `exit-error` (Pi exited non-zero or by a signal). Then pure and direct: `done`. Single arms: the
 * status of the LAST orche task the request started (`no-task` when main never delegated).
 */
export function terminalOf(input: { kind: Kind; infra?: string; guardFired: boolean; code: number | null; signal?: string | null; taskStatuses: readonly string[] }): Terminal {
  if (input.infra) return "infra";
  if (input.guardFired) return "harness-timeout";
  if (input.code !== 0 || input.signal) return "exit-error";
  if (input.kind === "pure" || input.kind === "direct") return "done";
  const last = input.taskStatuses.at(-1);
  if (!last) return "no-task";
  if (last === "done" || last === "blocked" || last === "failed" || last === "cancelled") return last;
  if (/timeout|timed/i.test(last)) return "timeout";
  return "failed";
}

export interface Integrity { violations: string[]; suspicious: string[] }

/** Primary outcome: terminal done AND the independent grade passed AND no protected-file violation. */
export function primaryPass(run: { terminal: Terminal; gradePassed?: boolean; integrity?: Integrity }): boolean {
  return run.terminal === "done" && run.gradePassed === true && !!run.integrity && run.integrity.violations.length === 0;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Accounting

export interface WireEntry {
  id: number; at: string; endAt?: string; method?: string; path?: string; model?: string; effort?: string; session?: string;
  status?: number; respModel?: string; usage?: { input?: number; cached?: number; output?: number; reasoning?: number };
  worker?: boolean; tools?: string[]; orcheMarker?: boolean; bytes?: number; error?: string; final?: string; clientClosed?: boolean; upgrade?: boolean;
}

export type Role = "main" | "worker" | "sub-worker" | "advisor" | "other";
export interface Rates { input: number; output: number; cacheRead: number; tiers?: { input: number; output: number; cacheRead: number; inputTokensAbove: number }[] }

/**
 * Catalog rates per million tokens (~/.pi/agent/cliproxyapi-models.json at freeze time; an API-equivalent estimate, not the
 * subscription bill). Above a tier's input threshold the whole request is priced at the tier. Cache writes are not reported
 * by the Responses stream and are not priced (a lower bound for Claude cache-write premiums).
 */
export function requestCost(usage: { uncached: number; cached: number; output: number }, rates: Rates | undefined): number {
  if (!rates) return 0;
  const total = usage.uncached + usage.cached;
  const tier = (rates.tiers ?? []).filter(item => total > item.inputTokensAbove).sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
  const r = tier ?? rates;
  return (usage.uncached * r.input + usage.cached * r.cacheRead + usage.output * r.output) / 1e6;
}

export interface Bucket { requests: number; uncached: number; cached: number; output: number; reasoning: number; costUsd: number; usageMissing: number; errors: number; latencyMs: number }
export const emptyBucket = (): Bucket => ({ requests: 0, uncached: 0, cached: 0, output: 0, reasoning: 0, costUsd: 0, usageMissing: 0, errors: 0, latencyMs: 0 });
export function addBucket(into: Bucket, from: Bucket): Bucket {
  for (const key of Object.keys(into) as (keyof Bucket)[]) into[key] += from[key];
  return into;
}

export interface WireSummary {
  total: Bucket; byRole: Partial<Record<Role, Bucket>>; byModel: Record<string, Bucket>;
  unexpected: string[]; toolsOffered: Record<Role, string[]>; orcheMarkerRequests: number; missRequests: number; missUncached: number;
}

/**
 * Summary of one wire log (POSTs with a model). The Responses usage `input_tokens` INCLUDES the cached tokens
 * (`input_tokens_details.cached_tokens`): uncached = input − cached. `reasoning` is part of `output` (never added twice).
 * Role: the session (prompt_cache_key) → role map from the run's transcripts; unknown sessions are `other` (side requests such as
 * compaction summaries). A cache miss is a request with ≥ 20k input tokens of which less than half was cached (the first request of
 * a session is a miss by construction and is counted too).
 */
export function summarizeWire(entries: readonly WireEntry[], options: { roles: ReadonlyMap<string, Role>; rates: Record<string, Rates>; expectAdvisor: boolean }): WireSummary {
  const out: WireSummary = { total: emptyBucket(), byRole: {}, byModel: {}, unexpected: [], toolsOffered: { main: [], worker: [], "sub-worker": [], advisor: [], other: [] }, orcheMarkerRequests: 0, missRequests: 0, missUncached: 0 };
  const offered: Record<Role, Set<string>> = { main: new Set(), worker: new Set(), "sub-worker": new Set(), advisor: new Set(), other: new Set() };
  for (const entry of entries) {
    if (entry.method !== "POST" || !entry.model) continue;
    const role: Role = (entry.session && options.roles.get(entry.session)) || "other";
    const bucket = emptyBucket();
    bucket.requests = 1;
    if (entry.error || (entry.status !== undefined && entry.status !== 200) || (entry.status === 200 && entry.final !== "response.completed")) bucket.errors = 1;
    if (entry.usage && typeof entry.usage.output === "number") {
      const input = entry.usage.input ?? 0, cached = Math.min(entry.usage.cached ?? 0, input);
      bucket.uncached = input - cached; bucket.cached = cached; bucket.output = entry.usage.output; bucket.reasoning = entry.usage.reasoning ?? 0;
      bucket.costUsd = requestCost({ uncached: bucket.uncached, cached, output: bucket.output }, options.rates[entry.model]);
      if (input >= 20_000 && cached < input / 2) { out.missRequests++; out.missUncached += input - cached; }
    } else bucket.usageMissing = 1;
    if (entry.endAt) bucket.latencyMs = Date.parse(entry.endAt) - Date.parse(entry.at);
    addBucket(out.total, bucket);
    addBucket(out.byRole[role] ??= emptyBucket(), bucket);
    addBucket(out.byModel[entry.model] ??= emptyBucket(), bucket);
    for (const tool of entry.tools ?? []) offered[role].add(tool);
    if (entry.orcheMarker) out.orcheMarkerRequests++;
    const wanted = role === "advisor" ? ADVISOR_MODEL.id : MODEL.id;
    const problems: string[] = [];
    if (role === "advisor" && !options.expectAdvisor) problems.push("advisor request in an arm without advisor");
    if (role !== "other" && entry.model !== wanted) problems.push(`model ${entry.model} (want ${wanted})`);
    if (role === "other" && entry.model !== MODEL.id && entry.model !== ADVISOR_MODEL.id) problems.push(`model ${entry.model}`);
    if (entry.status === 200 && entry.respModel !== undefined && !entry.respModel.includes(entry.model.replace(/^bts\//, "")) && entry.respModel !== entry.model) problems.push(`response model ${entry.respModel}`);
    if (role !== "other" && entry.effort !== undefined && entry.effort !== THINKING && entry.effort !== "low") problems.push(`effort ${entry.effort}`);
    if (problems.length) out.unexpected.push(`#${entry.id} ${role}: ${problems.join(", ")}`);
  }
  for (const role of Object.keys(offered) as Role[]) out.toolsOffered[role] = [...offered[role]].sort();
  return out;
}

/** Role of an orche transcript from its file name (records/<session>/workers/<name>-<timestamp>.jsonl). */
export function roleOfTranscript(fileName: string): Role {
  const name = fileName.split("/").at(-1) ?? "";
  if (/^W\d+(?:\.\d+)*\.advisor-/.test(name)) return "advisor";
  if (/^W\d+\.\d+-/.test(name)) return "sub-worker";
  if (/^W\d+-/.test(name)) return "worker";
  return "other";
}

/** The session id of a Pi transcript (its first `session` entry). */
export function transcriptSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n", 5)) {
    try { const entry = JSON.parse(line); if (entry?.type === "session" && typeof entry.id === "string") return entry.id; } catch { /* partial */ }
  }
  return undefined;
}

export interface TranscriptStats {
  assistantMessages: number; toolCalls: number; reads: number; repeatReads: number; compactions: number; thinkingLevels: Record<string, number>;
  toolNames: Record<string, number>;
}

/**
 * Tool and compaction statistics of one transcript. A repeat read is a `read` call whose (path, offset, limit) the same session
 * already read; reads of `.orche/artifacts/*` (saved full outputs) are counted separately by the tool-event log.
 */
export function transcriptStats(jsonl: string): TranscriptStats {
  const out: TranscriptStats = { assistantMessages: 0, toolCalls: 0, reads: 0, repeatReads: 0, compactions: 0, thinkingLevels: {}, toolNames: {} };
  const seen = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "compaction") { out.compactions++; continue; }
    if (entry?.type === "thinking_level_change") { out.thinkingLevels[entry.thinkingLevel] = (out.thinkingLevels[entry.thinkingLevel] ?? 0) + 1; continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    out.assistantMessages++;
    for (const part of message.content) {
      if (part?.type !== "toolCall") continue;
      out.toolCalls++;
      out.toolNames[part.name] = (out.toolNames[part.name] ?? 0) + 1;
      if (part.name === "read") {
        out.reads++;
        const args = part.arguments ?? {};
        const key = JSON.stringify([args.path, args.offset ?? null, args.limit ?? null, args.symbol ?? null]);
        if (seen.has(key)) out.repeatReads++; else seen.add(key);
      }
    }
  }
  return out;
}

/** Tool-event log (PI_ORCHE_TOOL_EVENTS) summary: reductions by reducer and reads of saved full outputs (artifacts). */
export function toolEventStats(lines: readonly any[]): { reductions: Record<string, number>; artifactAccesses: number; reducedThenAccessed: number; omittedDiagnostics: number } {
  const reductions: Record<string, number> = {};
  const artifacts = new Set<string>();
  const accessed = new Set<string>();
  let artifactAccesses = 0, omittedDiagnostics = 0;
  for (const event of lines) {
    if (event?.type === "output_reduced") {
      reductions[event.reducer] = (reductions[event.reducer] ?? 0) + 1;
      if (event.artifact) artifacts.add(event.artifact);
      omittedDiagnostics += Math.max(0, (event.diagnostics?.original ?? 0) - (event.diagnostics?.visible ?? 0));
    } else if (event?.type === "artifact_access") {
      artifactAccesses++;
      for (const path of event.artifacts ?? []) accessed.add(path);
    }
  }
  return { reductions, artifactAccesses, reducedThenAccessed: [...artifacts].filter(path => accessed.has(path)).length, omittedDiagnostics };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Leak audit (hidden tests, references, other runs, network)

export const LEAK_PATTERNS = [/fixtures\/(suite|advisor-bench)/, /\/hidden\b/, /results\/(stage-eval|ultra-ab|advisor-reviewer)/, /oh-my-pi-extensions\/orche\/(fixtures|results|experiments|docs|test)\b/, /grade(-final)?\.json/,
  /github\.com|pypi\.org|\bgit\s+(clone|fetch|pull)\b|\bpip\s+(install|download)\b|\bcurl\b|\bwget\b/];
export function leakHits(calls: readonly { name: string; arguments: unknown }[]): string[] {
  const hits: string[] = [];
  for (const call of calls) {
    const text = JSON.stringify(call.arguments ?? {});
    if (LEAK_PATTERNS.some(pattern => pattern.test(text))) hits.push(`${call.name}: ${text.slice(0, 300)}`);
  }
  return hits;
}

export function sessionToolCalls(jsonl: string): { name: string; arguments: unknown }[] {
  const calls: { name: string; arguments: unknown }[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === "toolCall") calls.push({ name: part.name, arguments: part.arguments });
  }
  return calls;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Analysis

export interface Row { task: string; arm: string; repeat: number; pass: boolean }

export function taskRates(rows: readonly Row[], arm: string): Map<string, number> {
  const groups = new Map<string, boolean[]>();
  for (const row of rows) if (row.arm === arm) groups.set(row.task, [...(groups.get(row.task) ?? []), row.pass]);
  return new Map([...groups].map(([task, passes]) => [task, passes.filter(Boolean).length / passes.length]));
}

export interface Paired { tasks: number; meanDiff: number; ci95: [number, number]; better: number; worse: number; same: number; signTestP: number }

/** Task-level paired comparison Y − X of per-task means: percentile bootstrap over tasks (repeats stay inside a task), sign test. */
export function pairedMeans(x: ReadonlyMap<string, number>, y: ReadonlyMap<string, number>, options: { resamples?: number; seed?: string } = {}): Paired {
  const tasks = [...x.keys()].filter(task => y.has(task)).sort();
  const diffs = tasks.map(task => y.get(task)! - x.get(task)!);
  const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
  const random = rng(options.seed ?? "bootstrap");
  const samples: number[] = [];
  const n = options.resamples ?? 10_000;
  if (diffs.length) for (let i = 0; i < n; i++) samples.push(mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!)));
  samples.sort((a, b) => a - b);
  const pick = (q: number) => samples.length ? samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))]! : NaN;
  const better = diffs.filter(d => d > 0).length, worse = diffs.filter(d => d < 0).length;
  return { tasks: tasks.length, meanDiff: mean(diffs), ci95: [pick(0.025), pick(0.975)], better, worse, same: tasks.length - better - worse, signTestP: signTest(better, worse) };
}

export function signTest(plus: number, minus: number): number {
  const n = plus + minus;
  if (!n) return 1;
  const k = Math.min(plus, minus);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomial(n, i);
  return Math.min(1, 2 * tail / 2 ** n);
}
function binomial(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - k + i) / i;
  return value;
}
