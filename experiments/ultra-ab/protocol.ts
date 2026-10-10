/**
 * ultra vs single-structure controlled comparison (docs/ultra-ab-bench.md, pre-registration experiments/ultra-ab/PREREGISTRATION.md):
 * the pure parts of the protocol, shared by the runner, the selector, the driver and the analysis, unit-tested without any model
 * (test/experiments/ultra-ab.test.ts).
 *
 * Conditions (the same task text, initial snapshot, models, effort, tools, permissions and limits):
 * - A: `/orche strong <prompt>`: main hands the request to orche's single workflow on the strong tier (docs/orchestrator.md 14.1).
 * - B: `/orche ultra <prompt>`: the same tier with the ultra pipeline (14.2). Its own stages and tools are the treatment.
 * - C: k independent A runs on isolated copies of the same snapshot, then a fresh selector (same model) picks one using visible
 *   evidence only (diffs, terminal statuses and its own runs of the visible project tests). Hidden tests never reach it.
 */
import { createHash } from "node:crypto";

export const CONDITIONS = ["A", "B", "C"] as const;
export type Condition = typeof CONDITIONS[number];
export const MODE_OF: Record<Condition, "strong" | "ultra"> = { A: "strong", B: "ultra", C: "strong" };

/** Every model role runs on the canonical route (never the `bts/` variant). */
export const MODEL = { provider: "cliproxyapi", id: "gpt-6.1-sol" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
/** Effort per role, identical across conditions: main high, strong orchestrator xhigh, sub-workers inherit it, selector xhigh. */
export const THINKING = { main: "high", orchestrator: "xhigh", selector: "xhigh" } as const;

/** Limits, identical across conditions (C: per attempt). */
export const LIMITS = {
  /** orche limits: base 60 min per assignment, at most 2 extensions of 15 min while active (ceiling 90 min), soft budget 300 requests. */
  orche: { overallMs: 60 * 60_000, assignmentMs: 60 * 60_000, extensionMs: 15 * 60_000, extensionStepMs: 0, maxExtensions: 2, assignmentRequests: 300 },
  /** Hard kill of one Pi process (main + every orche task it starts), process group. */
  piGuardMs: 150 * 60_000,
  /** Hard kill of the C selector process. */
  selectorGuardMs: 30 * 60_000,
  /** Infrastructure retries per unit (see classifyInfra). */
  infraRetries: 1,
  /** C attempts: k = clamp(round(R), kMin, kMax) with R from the pilot (kFromRatios). */
  kMin: 2,
  kMax: 4,
} as const;

/** The private orche config of every run (written into the run's own agent dir; the user's config is never read or written). */
export function orcheConfig(): Record<string, unknown> {
  return {
    mainMode: "single",
    providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"],
    routes: {},
    models: {
      "strong-orchestrator": { model: MODEL_REF, thinking: THINKING.orchestrator },
      // Off below (single.advisor false); pinned to the same route so no other model can enter even if it ran.
      advisor: { model: MODEL_REF, thinking: THINKING.orchestrator },
    },
    single: { ledger: false, spawn: true, advisor: false },
    thinkingPolicy: "fixed",
    limits: { ...LIMITS.orche },
    concurrentSessions: { enabled: false },
  };
}

export interface TaskSpec { id: string; kind: "suite" | "swe"; title: string; instruction: string }

const CONSTRAINTS = "Constraints: work only inside this workspace (the current directory; temporary files in your scratch directory are fine); no git commits; no network access is needed or available; do not weaken, skip or delete existing tests. The result is graded afterwards by tests you do not see.";

/** The user's prompt after the mode word: identical in every condition. */
export function userPrompt(task: TaskSpec): string {
  return `${task.instruction.trim()}\n\n${CONSTRAINTS}`;
}

/** The one-shot command main receives. */
export function oneShot(condition: Condition, task: TaskSpec): string {
  return `/orche ${MODE_OF[condition]} ${userPrompt(task)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Schedule

/** Deterministic PRNG (mulberry32) seeded by a string. */
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

export type UnitKind = "solo" | "select";
export interface Unit {
  /** runs/<task>/<condition>/r<repeat>[/a<attempt>|/select] */
  id: string;
  task: string;
  condition: Condition;
  repeat: number;
  kind: UnitKind;
  /** C attempts: 1..k. */
  attempt?: number;
  /** select: the attempt unit ids it waits for. */
  needs?: string[];
}

export const unitId = (task: string, condition: Condition, repeat: number, part?: string): string => `${task}/${condition}/r${repeat}${part ? `/${part}` : ""}`;

/**
 * Run order: repeat-major; within a repeat the tasks in the registered order; within each (task, repeat) block the three conditions
 * in a seeded random order (seed + task + repeat), so no condition is systematically first. C expands into its k attempts followed by
 * its selection (which waits for them).
 */
export function schedule(tasks: readonly string[], repeats: number, k: number, seed: string): { unit: Unit; order: Condition[] }[] {
  const out: { unit: Unit; order: Condition[] }[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of tasks) {
      const order = shuffle(CONDITIONS, rng(`${seed}/${task}/r${repeat}`));
      for (const condition of order) {
        if (condition !== "C") { out.push({ unit: { id: unitId(task, condition, repeat), task, condition, repeat, kind: "solo" }, order }); continue; }
        const needs: string[] = [];
        for (let attempt = 1; attempt <= k; attempt++) {
          const id = unitId(task, "C", repeat, `a${attempt}`);
          needs.push(id);
          out.push({ unit: { id, task, condition, repeat, kind: "solo", attempt }, order });
        }
        out.push({ unit: { id: unitId(task, "C", repeat, "select"), task, condition, repeat, kind: "select", needs }, order });
      }
    }
  }
  return out;
}

/** Pre-registered k rule: R = geometric mean over pilot tasks of B/A wire output tokens; k = clamp(round(R), kMin, kMax). */
export function kFromRatios(ratios: readonly number[]): { k: number; ratio: number; capped: boolean } {
  const valid = ratios.filter(value => Number.isFinite(value) && value > 0);
  if (!valid.length) throw new Error("no valid B/A ratio from the pilot");
  const ratio = Math.exp(valid.reduce((sum, value) => sum + Math.log(value), 0) / valid.length);
  const rounded = Math.round(ratio);
  const k = Math.min(LIMITS.kMax, Math.max(LIMITS.kMin, rounded));
  return { k, ratio, capped: rounded > LIMITS.kMax };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Task selection (pre-registered rule over the independent calibration data of experiments/advisor-reviewer/selection.json)

export interface CalibrationRow { task: string; kind: string; outcomes: string[]; meanCostUsd: number; decision: string }
export type Stratum = "hard" | "medium" | "easy";

/**
 * Stratum from the earlier Opus 5.5 single-worker calibration (no strong/ultra data): hard = no calibration run passed; medium =
 * every run passed and the mean cost is at least $0.60 (the complexity proxy of that study), or some run failed and some passed;
 * easy = every run passed below $0.60. Rows with an infra outcome or excluded by that study are not eligible.
 */
export function stratumOf(row: CalibrationRow): Stratum | undefined {
  if (row.decision === "excluded" || row.outcomes.some(outcome => outcome !== "pass" && outcome !== "fail")) return undefined;
  const passes = row.outcomes.filter(outcome => outcome === "pass").length;
  if (passes === 0) return "hard";
  if (passes < row.outcomes.length) return "medium";
  return row.meanCostUsd >= 0.6 ? "medium" : "easy";
}

/**
 * Seeded draw: per stratum, shuffle the eligible tasks; the first `pilotPerStratum` go to the pilot, the next `perStratum` to the
 * main study. Within each stratum a suite (JS) task is moved first when one exists among the main draw candidates, so both
 * sources appear in every stratum.
 */
export function drawTasks(rows: readonly CalibrationRow[], seed: string, perStratum: number, pilot: Record<Stratum, number>): { main: { task: string; stratum: Stratum; kind: string }[]; pilot: { task: string; stratum: Stratum; kind: string }[] } {
  const main: { task: string; stratum: Stratum; kind: string }[] = [];
  const pilotOut: { task: string; stratum: Stratum; kind: string }[] = [];
  for (const stratum of ["hard", "medium", "easy"] as const) {
    const eligible = rows.filter(row => (row.kind === "suite" || row.kind === "swe") && stratumOf(row) === stratum).sort((a, b) => a.task.localeCompare(b.task));
    const drawn = shuffle(eligible, rng(`${seed}/${stratum}`));
    const pilotRows = drawn.slice(0, pilot[stratum]);
    let rest = drawn.slice(pilot[stratum]);
    const suiteIndex = rest.findIndex(row => row.kind === "suite");
    if (suiteIndex > 0 && !rest.slice(0, perStratum).some(row => row.kind === "suite")) rest = [rest[suiteIndex]!, ...rest.filter((_, index) => index !== suiteIndex)];
    for (const row of pilotRows) pilotOut.push({ task: row.task, stratum, kind: row.kind });
    for (const row of rest.slice(0, perStratum)) main.push({ task: row.task, stratum, kind: row.kind });
  }
  return { main, pilot: pilotOut };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Outcome

export type Terminal = "done" | "blocked" | "failed" | "timeout" | "cancelled" | "no-task" | "harness-timeout" | "infra";

/**
 * Terminal status of one Pi run: the status of the LAST orche task the request started (its run.json), the harness guard when it
 * killed the process, `no-task` when main never delegated.
 */
export function terminalOf(input: { guardFired: boolean; taskStatuses: string[]; infra?: string }): Terminal {
  if (input.infra) return "infra";
  if (input.guardFired) return "harness-timeout";
  const last = input.taskStatuses.at(-1);
  if (!last) return "no-task";
  if (last === "done" || last === "blocked" || last === "failed" || last === "cancelled") return last;
  if (/timeout|timed/i.test(last)) return "timeout";
  return "failed";
}

export interface Integrity { violations: string[]; suspicious: string[] }

/** Primary outcome (pre-registered): terminal done AND the independent grade passed AND no protected-file violation. */
export function primaryPass(run: { terminal: Terminal; gradePassed?: boolean; integrity?: Integrity }): boolean {
  return run.terminal === "done" && run.gradePassed === true && !!run.integrity && run.integrity.violations.length === 0;
}

/** Original files the grader restores and whose weakening is a violation: tests and test-runner configuration. */
export function isTestFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some(part => part === "test" || part === "tests" || part === "__tests__" || part === "testing")) return true;
  return /^test_.*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$|^conftest\.py$/.test(name);
}
export const RUNNER_CONFIGS = ["pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml", "package.json", ".mocharc.json", ".mocharc.js", "vitest.config.ts", "vitest.config.js", "jest.config.js"];
export const isRunnerConfig = (path: string): boolean => RUNNER_CONFIGS.includes(path);

/** The test-runner-relevant part of a config file (packaging edits elsewhere in it are allowed). */
export function runnerSection(path: string, text: string): string {
  if (path === "package.json") {
    try { const json = JSON.parse(text); return JSON.stringify({ test: json.scripts?.test, pretest: json.scripts?.pretest, jest: json.jest, mocha: json.mocha, node: json.node }); } catch { return text; }
  }
  if (path === "pyproject.toml") return sections(text, /^\[tool\.(pytest|coverage)[^\]]*\]/);
  if (path === "setup.cfg") return sections(text, /^\[(tool:pytest|pytest)\]/);
  return text;
}
function sections(text: string, header: RegExp): string {
  const out: string[] = [];
  let on = false;
  for (const line of text.split("\n")) {
    if (/^\[/.test(line)) on = header.test(line);
    if (on) out.push(line);
  }
  return out.join("\n");
}

/** Markers that disable or narrow tests when ADDED to a test file. */
export const SKIP_MARKERS = /\b(it|test|describe|suite)\.(only|skip|todo)\b|\b(xit|xdescribe|fit|fdescribe)\(|pytest\.mark\.(skip|skipif|xfail)|pytest\.(skip|xfail)\(|unittest\.skip|\{\s*skip\s*:\s*true|\{\s*only\s*:\s*true|--test-only|pytest_collection_modifyitems|pytest_ignore_collect|collect_ignore/;

/**
 * Integrity of a final workspace against the initial snapshot (paths relative; contents as text, undefined = absent):
 * violations = an original test file deleted or with removed/changed lines, skip/only/xfail markers added to a test file, the
 * test-runner part of a config changed, a new conftest/pytest.ini/tox.ini; suspicious (reported, not a failure) = new test files
 * with such markers are included in violations too, other test-adjacent edits listed here.
 */
export function integrity(initial: ReadonlyMap<string, string>, final: ReadonlyMap<string, string>): Integrity {
  const violations: string[] = [];
  const suspicious: string[] = [];
  for (const [path, before] of initial) {
    const after = final.get(path);
    if (isTestFile(path)) {
      if (after === undefined) { violations.push(`deleted test file ${path}`); continue; }
      if (after === before) continue;
      const { removed, added } = lineDiff(before, after);
      if (removed.length) violations.push(`changed/removed ${removed.length} line(s) of test file ${path}: ${removed.slice(0, 3).map(line => JSON.stringify(line.slice(0, 80))).join(", ")}`);
      const markers = added.filter(line => SKIP_MARKERS.test(line));
      if (markers.length) violations.push(`added skip/only/xfail marker(s) to ${path}: ${markers.slice(0, 3).map(line => JSON.stringify(line.trim().slice(0, 80))).join(", ")}`);
      if (!removed.length && !markers.length) suspicious.push(`added lines to test file ${path}`);
    } else if (isRunnerConfig(path)) {
      if (after === undefined) { violations.push(`deleted runner config ${path}`); continue; }
      if (runnerSection(path, after) !== runnerSection(path, before)) violations.push(`changed the test-runner section of ${path}`);
    }
  }
  for (const [path, after] of final) {
    if (initial.has(path)) continue;
    const name = path.split("/").at(-1) ?? "";
    if (name === "conftest.py" || name === "pytest.ini" || name === "tox.ini" || name === ".pytest.ini") violations.push(`new test-runner file ${path}`);
    else if (isTestFile(path) && SKIP_MARKERS.test(after)) suspicious.push(`new test file ${path} contains skip/only markers`);
  }
  return { violations, suspicious };
}

/** Multiset line diff: lines of `before` missing in `after` (removed or changed) and lines new in `after`. */
export function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const count = new Map<string, number>();
  for (const line of after.split("\n")) count.set(line, (count.get(line) ?? 0) + 1);
  const removed: string[] = [];
  for (const line of before.split("\n")) {
    const left = count.get(line) ?? 0;
    if (left > 0) count.set(line, left - 1); else if (line.trim()) removed.push(line);
  }
  const beforeCount = new Map<string, number>();
  for (const line of before.split("\n")) beforeCount.set(line, (beforeCount.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const left = beforeCount.get(line) ?? 0;
    if (left > 0) beforeCount.set(line, left - 1); else if (line.trim()) added.push(line);
  }
  return { removed, added };
}

/** SWE status of a dataset test id: exact node id, else every parametrized id with that prefix must have passed (none = MISSING). */
export function statusOf(statuses: ReadonlyMap<string, string>, id: string): string {
  const exact = statuses.get(id);
  if (exact) return exact;
  const matches = [...statuses].filter(([name]) => name.startsWith(id)).map(([, status]) => status);
  if (!matches.length) return "MISSING";
  return matches.every(status => status === "PASSED") ? "PASSED" : matches.find(status => status !== "PASSED")!;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Wire and session evidence

export interface WireEntry {
  id: number; at: string; endAt?: string; method?: string; path?: string; model?: string; effort?: string; session?: string;
  status?: number; respModel?: string; usage?: { input?: number; cached?: number; output?: number; reasoning?: number };
  worker?: boolean; error?: string; final?: string; upstreamError?: string; errorEvent?: boolean; clientClosed?: boolean; upgrade?: boolean;
}

export interface WireSummary {
  requests: number; byRoute: Record<string, number>; errors: number; non200: number; streamErrors: number;
  input: number; cached: number; output: number; reasoning: number; usageMissing: number; latencyMsTotal: number;
  unexpected: string[];
}

/**
 * Summary of one wire log (model requests only: POSTs with a model). Route key = `<role>|<requested model>|<response model>|<effort>|<status>`,
 * role main (the run's own session id) / worker (any other session: orche workers and sub-workers) / selector. `unexpected` lists every request whose model, response model or
 * effort differs from the protocol (a missing response model is listed as unverifiable).
 */
export function summarizeWire(entries: readonly WireEntry[], expected: { main?: string; worker?: string; selector?: string; mainSession?: string }): WireSummary {
  const out: WireSummary = { requests: 0, byRoute: {}, errors: 0, non200: 0, streamErrors: 0, input: 0, cached: 0, output: 0, reasoning: 0, usageMissing: 0, latencyMsTotal: 0, unexpected: [] };
  for (const entry of entries) {
    if (entry.method !== "POST" || !entry.model) continue;
    out.requests++;
    // Main is the run's own Pi session (its prompt_cache_key is the --session-id); every other session is an orche worker or sub-worker.
    const role = expected.selector ? "selector" : expected.mainSession !== undefined ? (entry.session === expected.mainSession ? "main" : "worker") : entry.worker ? "worker" : "main";
    const effortWanted = role === "selector" ? expected.selector : role === "worker" ? expected.worker : expected.main;
    const key = `${role}|${entry.model}|${entry.respModel ?? "?"}|${entry.effort ?? "?"}|${entry.status ?? "?"}`;
    out.byRoute[key] = (out.byRoute[key] ?? 0) + 1;
    if (entry.error) out.errors++;
    if (entry.status !== undefined && entry.status !== 200) out.non200++;
    // A 200 stream that never delivered its final `response.completed` event (cut, failed or incomplete).
    if (entry.status === 200 && entry.final !== "response.completed") out.streamErrors++;
    if (entry.usage && typeof entry.usage.output === "number") {
      out.input += entry.usage.input ?? 0; out.cached += entry.usage.cached ?? 0; out.output += entry.usage.output; out.reasoning += entry.usage.reasoning ?? 0;
    } else out.usageMissing++;
    if (entry.endAt) out.latencyMsTotal += Date.parse(entry.endAt) - Date.parse(entry.at);
    const problems: string[] = [];
    if (entry.model !== MODEL.id) problems.push(`model ${entry.model}`);
    if (entry.status === 200 && entry.respModel === undefined) problems.push("response model unverifiable");
    else if (entry.respModel !== undefined && entry.respModel !== MODEL.id) problems.push(`response model ${entry.respModel}`);
    if (effortWanted && entry.effort !== effortWanted) problems.push(`${role} effort ${entry.effort ?? "none"} (want ${effortWanted})`);
    if (problems.length) out.unexpected.push(`#${entry.id} ${role}: ${problems.join(", ")}`);
  }
  return out;
}

/** Leak audit: tool-call arguments that mention where hidden tests, references or other runs' results live, or network fetches. */
export const LEAK_PATTERNS = [/fixtures\/(suite|advisor-bench)/, /\/hidden\b/, /results\/(ultra-ab|advisor-reviewer)/, /oh-my-pi-extensions\/orche\/(fixtures|results|experiments|docs|test)\b/, /grade(-final)?\.json/,
  /github\.com|pypi\.org|\bgit\s+(clone|fetch|pull)\b|\bpip\s+(install|download)\b|\bcurl\b|\bwget\b/];
export function leakHits(calls: readonly { name: string; arguments: unknown }[]): string[] {
  const hits: string[] = [];
  for (const call of calls) {
    const text = JSON.stringify(call.arguments ?? {});
    if (LEAK_PATTERNS.some(pattern => pattern.test(text))) hits.push(`${call.name}: ${text.slice(0, 300)}`);
  }
  return hits;
}

/** Tool calls of a pi session JSONL text. */
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

/** Assistant messages of a pi session JSONL text per `provider/model`, with error stops (provider failures seen by Pi). */
export function sessionUsage(jsonl: string): Record<string, { requests: number; errors: number; input: number; output: number; cacheRead: number }> {
  const out: Record<string, { requests: number; errors: number; input: number; output: number; cacheRead: number }> = {};
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant") continue;
    const total = out[`${message.provider}/${message.model}`] ??= { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0 };
    total.requests++;
    if (message.stopReason === "error") total.errors++;
    total.input += message.usage?.input ?? 0; total.output += message.usage?.output ?? 0; total.cacheRead += message.usage?.cacheRead ?? 0;
  }
  return out;
}

/** Replace every occurrence of the given secrets (non-empty, at least 8 chars) in a text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Selection (C)

export interface SelectorCandidate { index: number; terminal: Terminal; diffStat: string }

/** The selector's prompt: task, candidates (terminal status + diff stat; diffs in files), visible evidence only. */
export function selectorPrompt(task: TaskSpec, candidates: readonly SelectorCandidate[]): string {
  return [
    "You are a SELECTOR. Several independent attempts solved the same coding task (quoted below) from the same starting snapshot. Pick the ONE attempt most likely to be fully correct: it meets every requirement of the task and keeps the project's existing behaviour and tests working.",
    "Each attempt's final files are in ./cand-<n>/ (a full copy of its workspace) and its change against the starting snapshot is in ./cand-<n>.diff. The starting snapshot is in ./base/.",
    "Evidence you may use: read the diffs and code, and run the project's own visible tests or your own quick checks inside the candidate directories (bash; the directories are disposable copies). There are no other test files, results or grades anywhere for you; do not look outside this directory, and do not access the network.",
    "Attempts (terminal status of the agent run, and diff stat):",
    ...candidates.map(candidate => `- cand-${candidate.index}: terminal status ${candidate.terminal}; ${candidate.diffStat.trim().split("\n").at(-1) ?? "no change"}`),
    "Finish with a final message whose LAST line is exactly a JSON object: {\"choice\": <n>, \"reason\": \"<one or two sentences>\"}.",
    "Task (quoted):",
    userPrompt(task).split("\n").map(line => `> ${line}`).join("\n"),
  ].join("\n");
}

/** Parse the selector's choice from its final text: the last JSON object with a valid integer `choice`. */
export function parseChoice(text: string, k: number): number | undefined {
  const matches = [...text.matchAll(/\{[^{}]*"choice"\s*:\s*(\d+)[^{}]*\}/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const choice = Number(last[1]);
  return Number.isInteger(choice) && choice >= 1 && choice <= k ? choice : undefined;
}

/** Pre-registered fallback when the selector fails or gives no valid choice: the first attempt whose terminal status is done, else attempt 1. */
export function fallbackChoice(candidates: readonly SelectorCandidate[]): number {
  return candidates.find(candidate => candidate.terminal === "done")?.index ?? 1;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Analysis

export interface Row { task: string; condition: Condition; repeat: number; pass: boolean; terminal: Terminal; stratum?: string }

/** Per task: mean primary success of a condition over its repeats (undefined when that task has no run of it). */
export function taskRates(rows: readonly Row[], condition: Condition): Map<string, number> {
  const groups = new Map<string, boolean[]>();
  for (const row of rows) if (row.condition === condition) groups.set(row.task, [...(groups.get(row.task) ?? []), row.pass]);
  return new Map([...groups].map(([task, passes]) => [task, passes.filter(Boolean).length / passes.length]));
}

export interface Paired {
  tasks: number; meanDiff: number; ci95: [number, number]; better: number; worse: number; same: number;
  signTestP: number; xFailYPass: number; xPassYFail: number;
}

/**
 * Task-level paired comparison of Y against X (Y − X): per-task success-rate difference, mean over tasks, a percentile bootstrap
 * 95% interval resampling TASKS (repeats stay inside their task), an exact two-sided sign test over tasks with a difference, and the
 * expected count of X-fail/Y-pass and X-pass/Y-fail pairs over all repeat pairings within a task.
 */
export function paired(rows: readonly Row[], x: Condition, y: Condition, options: { resamples?: number; seed?: string } = {}): Paired {
  const rx = taskRates(rows, x), ry = taskRates(rows, y);
  const tasks = [...rx.keys()].filter(task => ry.has(task)).sort();
  const diffs = tasks.map(task => ry.get(task)! - rx.get(task)!);
  const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
  const random = rng(options.seed ?? "bootstrap");
  const samples: number[] = [];
  const n = options.resamples ?? 10_000;
  if (diffs.length) for (let i = 0; i < n; i++) samples.push(mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!)));
  samples.sort((a, b) => a - b);
  const pick = (q: number) => samples.length ? samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))]! : NaN;
  const better = diffs.filter(d => d > 0).length, worse = diffs.filter(d => d < 0).length;
  let xFailYPass = 0, xPassYFail = 0;
  for (const task of tasks) {
    const xs = rows.filter(row => row.task === task && row.condition === x), ys = rows.filter(row => row.task === task && row.condition === y);
    for (const a of xs) for (const b of ys) {
      if (!a.pass && b.pass) xFailYPass += 1 / (xs.length * ys.length);
      if (a.pass && !b.pass) xPassYFail += 1 / (xs.length * ys.length);
    }
  }
  return { tasks: tasks.length, meanDiff: mean(diffs), ci95: [pick(0.025), pick(0.975)], better, worse, same: tasks.length - better - worse, signTestP: signTest(better, worse), xFailYPass, xPassYFail };
}

/** Exact two-sided sign test p-value. */
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

/**
 * Pre-registered verdict from the two paired comparisons (95% task-bootstrap intervals):
 * superior = B−A lower bound > 0 and B−C lower bound > 0; total-effect-only = B−A lower bound > 0, B−C interval contains 0;
 * inferior = B−A upper bound < 0; otherwise unconfirmed. "some types only" is reported descriptively, never as the verdict.
 */
export function verdict(ba: Paired, bc: Paired | undefined): "ultra-superior" | "total-effect-only" | "ultra-inferior" | "unconfirmed" {
  if (ba.ci95[1] < 0) return "ultra-inferior";
  if (ba.ci95[0] > 0) return bc && bc.ci95[0] > 0 ? "ultra-superior" : "total-effect-only";
  return "unconfirmed";
}
