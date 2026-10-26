/**
 * headroom-pool (experiments/headroom-pool/README.md, results/headroom-pool/PROTOCOL.md): acquire NEW public failure cases with
 * measured gpt-6.1-sol/high headroom for a later witness-continuity comparison. This module holds the pure, frozen rules (unit-tested
 * in test/experiments/headroom-pool.test.ts without any model):
 *   - the one model route of every model role;
 *   - the finite candidate pools (source files, exposure exclusion, mechanical prescreen, seeded order, caps);
 *   - the eligibility rules E1..E7 a case must pass before any calibration, and the bounded setup repairs;
 *   - the ordinary baseline prompt and its finite opportunity;
 *   - attempt classification (stop kind, validity), the calibration schedule, the promotion, family and stop rules and the
 *     attempt bounds;
 *   - exact binomial (Clopper-Pearson) intervals for reported counts.
 * Nothing here calls a model, reads hidden tests or reads a reference fix.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------------------------------------------
// Route

/** Every model request of every model role (the baseline solver; this study has no model-based scoring or adjudication). */
export const MODEL = { provider: "cliproxyapi", id: "gpt-6.1-sol" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
export const EFFORT = "high" as const;
/** Pi settings of every session (same model and effort as the CLI flags; SSE so the unit proxy reads every stream). */
export const piSettings = (): Record<string, unknown> => ({ defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: EFFORT, quietStartup: true, transport: "sse" });

// ---------------------------------------------------------------------------------------------------------------------------
// Pools

export const ORDER_SEED = "headroom-pool-2026-10-25";
export type PoolName = "A" | "B";
export interface PoolSource { name: PoolName; dataset: string; splits: string[]; files: string[]; cap: number; contingent?: string }
/**
 * Pool A: the SWE-rebench leaderboard 2026 splits (the newest published). Pool B (a contingency frozen now, used only when pool A
 * ends with fewer than MIN_FAMILIES promoted families, and then the last pool): the three preceding monthly splits. Each pool is
 * finite: at most `cap` prescreened, unexposed records in seeded order.
 */
export const POOLS: Readonly<Record<PoolName, PoolSource>> = {
  A: { name: "A", dataset: "nebius/SWE-rebench-leaderboard", splits: ["2026_01", "2026_02", "2026_03"], files: ["results/iso-token/raw/rebench-2026_01.jsonl", "results/iso-token/raw/rebench-2026_02.jsonl", "results/iso-token/raw/rebench-2026_03.jsonl"], cap: 60 },
  B: { name: "B", dataset: "nebius/SWE-rebench-leaderboard", splits: ["2025_10", "2025_11", "2025_12"], files: ["results/headroom-pool/raw/rebench-2025_10.jsonl", "results/headroom-pool/raw/rebench-2025_11.jsonl", "results/headroom-pool/raw/rebench-2025_12.jsonl"], cap: 60, contingent: "only when pool A ends with fewer than MIN_FAMILIES promoted families" },
};

export interface RawRecord {
  instance_id: string; repo: string; base_commit: string; problem_statement: string; interface?: string | null; created_at: string;
  install_config?: { install?: string; python?: string; test_cmd?: string; pre_install?: unknown; pip_packages?: unknown } | null;
  FAIL_TO_PASS?: string[]; PASS_TO_PASS?: string[]; patch?: string; test_patch?: string;
}

/** Seeded order key of a record (ascending). */
export const orderKey = (id: string): string => createHash("sha256").update(`${ORDER_SEED}:${id}`).digest("hex");

/** Upstream issue identity: repository name without the owner plus the number (ids are `<owner>__<repo>-<n>[_interface]`). */
export function upstreamKey(id: string): string {
  const base = id.replace(/_interface$/, "");
  const match = /^(.+?)__(.+)-(\d+)$/.exec(base);
  return match ? `${match[2]!.toLowerCase()}#${match[3]}` : base.toLowerCase();
}

const FENCE = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/g;
/** Code-like lines of a fenced block: Python statements, REPL prompts, calls, or shell command lines. */
const CODE_LINE = /^\s*(?:>>>\s|\$\s|import\s+\w|from\s+[\w.]+\s+import\s|def\s+\w+\s*\(|class\s+\w+|@\w+|[\w.\[\]"']+\s*=\s*\S|[\w.]+\s*\(.*\)\s*$|(?:python3?|pytest|pip|uv|tox|pdm|poetry|hatch|nox)\s+\S)/;
const TRACEBACK_ONLY = /^\s*(?:Traceback \(most recent call last\):|File ".*", line \d+.*|\^+|[\w.]+(?:Error|Exception|Warning)\b.*|During handling.*|The above exception.*)?\s*$/;
const EXPECTATION = /\b(?:expected|expect(?:s|ing|ation)?|should(?:n't| not)?|instead|correct(?:ly)?|intended)\b/i;

/** The fenced blocks of a problem statement that contain at least one code-like line and are not merely a traceback. */
export function codeBlocks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(FENCE)) {
    const body = match[1] ?? "";
    const lines = body.split("\n").filter(line => line.trim());
    if (!lines.length || lines.every(line => TRACEBACK_ONLY.test(line))) continue;
    if (lines.some(line => CODE_LINE.test(line) && !TRACEBACK_ONLY.test(line))) out.push(body);
  }
  return out;
}

export interface Prescreen { m1NoInterface: boolean; m2Reproduction: boolean; m3Expectation: boolean; codeBlocks: number; passed: boolean }
/** Mechanical prescreen M1..M3 (pure; no judgement): no interface text, a fenced reproduction, a stated expectation. */
export function prescreen(record: Pick<RawRecord, "problem_statement" | "interface">): Prescreen {
  const text = record.problem_statement ?? "";
  const blocks = codeBlocks(text);
  const result = { m1NoInterface: !String(record.interface ?? "").trim(), m2Reproduction: blocks.length > 0, m3Expectation: EXPECTATION.test(text), codeBlocks: blocks.length };
  return { ...result, passed: result.m1NoInterface && result.m2Reproduction && result.m3Expectation };
}

/**
 * Exposure evidence of one record (exposure.ts collects it; ignored `results/` included):
 *   modelRuns: result paths of model sessions (completed, aborted, screened or calibrated) that touched the record or an alias;
 *   historicalFixtureSet: the record belongs to fixtures/advisor-bench/swe (the historical pool used across the earlier studies);
 *   setupOnly: fixture/cache/pool-listing membership without any model session (NOT exposure);
 *   named: the upstream issue is named as exposed by the requesting session;
 *   duplicateOf: another id of the same upstream issue that is exposed.
 */
export interface ExposureFacts { modelRuns: string[]; historicalFixtureSet: boolean; setupOnly: string[]; named: boolean; duplicateOf?: string }
/** Exposure rule X: excluded when any model session touched the record or its upstream issue, or it is in the historical set. */
export const exposed = (facts: ExposureFacts): boolean => facts.modelRuns.length > 0 || facts.historicalFixtureSet || facts.named || facts.duplicateOf !== undefined;

/** Upstream issues named as already exposed by the requesting session (cross-check of the scan). */
export const NAMED_EXPOSED = ["isort#2491", "docstub#123", "tox#3904", "tox#3846", "schemathesis#3933", "docsight#437", "narwhals#3478", "huggingface_hub#4056", "smolvm#172", "sqlglot#7187", "stravalib#709"] as const;

export interface PoolEntry { id: string; upstream: string; order: string; split: string; createdAt: string; repo: string; prescreen: Prescreen; exposure: ExposureFacts; excluded?: string }
/** The frozen pool: unexposed prescreened records in seeded order, at most `cap`; everything else is listed with its exclusion. */
export function selectPool(entries: readonly PoolEntry[], cap: number): { pool: PoolEntry[]; excluded: PoolEntry[] } {
  const sorted = [...entries].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const pool: PoolEntry[] = [], excluded: PoolEntry[] = [];
  for (const entry of sorted) {
    const reason = exposed(entry.exposure) ? "X: exposed in an earlier study" : !entry.prescreen.m1NoInterface ? "M1: interface text (feature/API task)" : !entry.prescreen.m2Reproduction ? "M2: no fenced reproduction" : !entry.prescreen.m3Expectation ? "M3: no stated expectation" : pool.length >= cap ? `cap: beyond the first ${cap}` : undefined;
    if (reason) excluded.push({ ...entry, excluded: reason }); else pool.push(entry);
  }
  return { pool, excluded };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Eligibility (envbuild.ts records E1; qualify.ts records E4/E5/E7; the witness file and its provenance record document E2/E3/E6)

export const ELIGIBILITY = {
  E1: "Native environment: the base-commit snapshot; uv-managed CPython at the dataset's Python version; the dataset's own install command under the bounded transformations (INSTALL_TRANSFORMS) with dependencies resolved as of the record's date; the package imports from the snapshot.",
  E2: "Runnable public reproduction: the issue's own reproduction (code or command with the issue's inputs) runs offline in E1 without services, credentials, special hardware, GUI or network; completions only where the issue text or the public docs it cites determine them, each recorded as an adaptation.",
  E3: "Observable expectation: the issue states the expected behaviour concretely enough to check mechanically (a value, shape, type, output, or that the call succeeds together with the stated result).",
  E4: "Native failure: the witness fails on the pre-fix snapshot with the issue's reported symptom, in every qualification run.",
  E5: "Known-correct artifact: the witness passes with the reference fix applied offline, in every qualification run (validation only; the fix contributes nothing to the witness).",
  E6: "Grounding and blindness: every expected value is quoted from the issue (or public docs at the base commit) in the witness provenance; the witness author did not read the hidden tests or the reference fix before the witness was frozen.",
  E7: "Mechanical, isolated run: sandbox without network, under WITNESS_GUARD_MS; environment problems make a run untrusted (exit 2), never pass or fail.",
} as const;
export type EligibilityRule = keyof typeof ELIGIBILITY;
export const WITNESS_GUARD_MS = 180_000;
export const QUALIFY_REPEATS = 2;

/**
 * The only setup repairs (E1). The dataset's install command is split at `&&`/`;`; each step is mapped by this fixed table and
 * nothing else is repaired (amendment A1, recorded before any qualification or calibration: the uv/submodule rows were added after
 * the first mechanical plan refusals, uniformly for every record):
 *   pip install … | python -m pip install … | uv pip install [--system] …  → `uv pip install --exclude-newer <date+1d> …` into the
 *       case venv, non-editable (-e/--editable dropped, -q/-v/--quiet/--no-cache-dir/--root-user-action/--system dropped);
 *   pip install [-U] pip|setuptools|wheel|uv, uv venv, source .venv/bin/activate, cd /testbed, export DEBIAN_FRONTEND=…  → dropped
 *       (plumbing of the dataset's container that the case venv replaces);
 *   uv sync [--group G] [--extra E] [--all-extras] [--dev]  → `uv sync --frozen --no-editable …` (the project's lock) into the venv;
 *   git submodule update --init --recursive  → the submodules at the base commit's gitlinks are fetched with the source;
 *   anything else (apt/conda/system packages, other scripts or tools, other indexes)  → E1 fails with the step quoted.
 * Version-bypass variables for dynamic-versioning backends are set (envbuild.ts VERSION_BYPASS). One retry for a network failure.
 */
export const INSTALL_TRANSFORMS = ["uv-pip-exclude-newer", "non-editable", "drop-container-plumbing", "uv-sync-frozen", "submodules-at-gitlinks", "version-bypass"] as const;
export const NETWORK_RETRIES = 1;

export type InstallStep = { kind: "uv-pip"; argv: string[] } | { kind: "uv-sync"; argv: string[] } | { kind: "submodules" };
export interface InstallPlan { ok: true; steps: InstallStep[] }
export interface InstallRefusal { ok: false; reason: string }
const DROP_FLAGS = new Set(["-q", "--quiet", "--no-cache-dir", "--root-user-action=ignore", "--system", "-e", "--editable", "-U", "--upgrade", "-v", "--verbose", "--break-system-packages"]);
/** Combined short flags (`-qe`, `-ve`): drop q/v/e/U letters; keep anything else (e.g. `-r`). */
function cleanFlag(word: string): string | undefined {
  if (DROP_FLAGS.has(word)) return undefined;
  if (/^-[a-zA-Z]{2,}$/.test(word)) { const rest = word.slice(1).replace(/[qveU]/g, ""); return rest ? `-${rest}` : undefined; }
  return word;
}
/** The bounded transformation of a dataset install command (pure). `python` is the case venv's interpreter. */
export function installPlan(install: string, python: string, excludeNewer: string): InstallPlan | InstallRefusal {
  const parts = install.split(/\s*(?:&&|;)\s*/).map(part => part.trim()).filter(Boolean);
  const steps: InstallStep[] = [];
  for (const part of parts) {
    const words = part.split(/\s+/).map(word => word.replace(/^["']|["']$/g, ""));
    if (/^export DEBIAN_FRONTEND=\S+$/.test(part) || /^cd \/testbed$/.test(part) || /^(source|\.) \.venv\/bin\/activate$/.test(part) || /^uv venv(\s+\.venv)?$/.test(part)) continue;
    if (/^git submodule update --init --recursive$/.test(part)) { steps.push({ kind: "submodules" }); continue; }
    if (words[0] === "uv" && words[1] === "sync") {
      const args = words.slice(2).map(cleanFlag).filter((word): word is string => word !== undefined);
      if (args.some(word => !/^--(group|extra|all-extras|dev|all-groups)$/.test(word) && !/^--(group|extra)=/.test(word) && !/^[\w.-]+$/.test(word))) return { ok: false, reason: `uv sync step with unsupported options: ${part}` };
      steps.push({ kind: "uv-sync", argv: ["uv", "sync", "--python", python, "--frozen", "--no-editable", ...args] });
      continue;
    }
    const start = words[0] === "python" && words[1] === "-m" && words[2] === "pip" ? 3 : words[0] === "pip" || words[0] === "pip3" ? 1 : words[0] === "uv" && words[1] === "pip" ? 2 : -1;
    if (start < 0 || words[start] !== "install") return { ok: false, reason: `install step outside the bounded transformations: ${part}` };
    const targets = words.slice(start + 1).map(cleanFlag).filter((word): word is string => word !== undefined);
    if (targets.some(word => /^--(index-url|extra-index-url|find-links|trusted-host)\b/.test(word) || word === "-f" || word === "-i")) return { ok: false, reason: `install step names another index: ${part}` };
    if (!targets.length || targets.every(word => /^(pip|setuptools|wheel|uv)([<>=!~].*)?$/.test(word))) continue;
    steps.push({ kind: "uv-pip", argv: ["uv", "pip", "install", "--python", python, "--exclude-newer", excludeNewer, ...targets] });
  }
  return steps.some(step => step.kind !== "submodules") ? { ok: true, steps } : { ok: false, reason: "no install step" };
}
/** The dependency cut-off of a record: its date plus one day (ISO date). */
export const excludeNewerOf = (createdAt: string): string => new Date(Date.parse(createdAt.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt) ? "" : "Z")) + 86_400_000).toISOString().slice(0, 10);

export interface QualificationRuns { prefix: string[]; reference: string[] }
/** E4/E5/E7 verdict from the witness statuses (pure): every pre-fix run fails, every reference run passes, nothing untrusted. */
export function qualifies(runs: QualificationRuns, repeats = QUALIFY_REPEATS): { qualified: boolean; failed?: "E4" | "E5" | "E7"; detail: string } {
  if (runs.prefix.length < repeats || runs.reference.length < repeats) return { qualified: false, failed: "E7", detail: `incomplete runs (${runs.prefix.length}/${runs.reference.length})` };
  const bad = [...runs.prefix, ...runs.reference].filter(status => status !== "pass" && status !== "fail");
  if (bad.length) return { qualified: false, failed: "E7", detail: `untrusted/error runs: ${bad.join(", ")}` };
  if (!runs.prefix.every(status => status === "fail")) return { qualified: false, failed: "E4", detail: `pre-fix ${runs.prefix.join(", ")}` };
  if (!runs.reference.every(status => status === "pass")) return { qualified: false, failed: "E5", detail: `reference ${runs.reference.join(", ")}` };
  return { qualified: true, detail: `pre-fix ${runs.prefix.join(", ")}; reference ${runs.reference.join(", ")}` };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Baseline: ordinary solving with a finite opportunity

/** One baseline session: at most this many model requests (refused at the unit proxy) and this much wall time. */
export const CAL_BUDGET = { maxRequests: 120, wallMs: 50 * 60_000 } as const;
/**
 * The baseline prompt: the earlier studies' ordinary SWE instruction (experiments/ultra-ab/env.ts sweInstruction, issue verbatim,
 * hidden tests, existing tests must pass), the constraints and the budget. Pool cases have no interface text (M1), so nothing but the
 * public issue is task information. No witness, no hint, no reference to this study.
 */
export function baselinePrompt(task: { problemStatement: string }): string {
  return [
    "Resolve the GitHub issue below in this repository (a snapshot of the project at the time of the issue, without git history). Hidden tests written by the maintainers will check the fix; the existing tests must keep passing.",
    "Python environment: `python` and `pytest` on PATH run the code of the project you are in (the nearest directory with pyproject.toml/setup.py/setup.cfg above the current directory) with the project's dependencies preinstalled (read-only; no pip, no network).",
    "",
    "## Issue",
    task.problemStatement.trim(),
    "",
    `Budget: this session has at most ${CAL_BUDGET.maxRequests} model requests and ${CAL_BUDGET.wallMs / 60_000} minutes.`,
    "",
    "Constraints: work only inside this workspace (the current directory; temporary files in $TMPDIR are fine); no git commits; no network access is needed or available; do not weaken, skip or delete existing tests. When you are done, end your turn with a short summary of what you changed and why.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Attempts

export type StopKind = "turn-end" | "length" | "budget" | "time" | "provider-error" | "route-refused" | "no-model" | "crash";
export interface WireTotals {
  forwarded: number; completed: number; refusedRoute: number; refusedUnverifiable: number; refusedBudget: number;
  providerErrors: number; offRouteResponses: number; unknownUsage: number;
}
/**
 * How the Pi invocation ended (pure). `events` is its JSON event stream; `inFlightMs` the age of the oldest forwarded request that had
 * not completed when the process ended (0 when none).
 */
export function stopOf(events: string, run: { code: number | null; guardFired: boolean }, wire: WireTotals): { stop: StopKind; detail: string } {
  let last: any, assistantSeen = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "message_end" && event.message?.role === "assistant") { last = event.message; assistantSeen = true; }
  }
  if (wire.refusedRoute + wire.refusedUnverifiable > 0 || wire.offRouteResponses > 0) return { stop: "route-refused", detail: `${wire.refusedRoute} route / ${wire.refusedUnverifiable} unverifiable refusal(s), ${wire.offRouteResponses} off-route response(s)` };
  if (run.guardFired) return { stop: "time", detail: "wall-time guard" };
  if (!assistantSeen) return wire.forwarded === 0 ? { stop: "no-model", detail: `no assistant message, exit ${run.code}` } : { stop: "crash", detail: `no assistant message after ${wire.forwarded} request(s), exit ${run.code}` };
  const reason = String(last.stopReason ?? "");
  const error = String(last.errorMessage ?? "");
  if (reason === "stop") return run.code === 0 ? { stop: "turn-end", detail: "stop" } : { stop: "crash", detail: `stop with exit ${run.code}` };
  if (reason === "length") return { stop: "length", detail: "output length limit" };
  if (reason === "error" || reason === "aborted") {
    if (wire.refusedBudget > 0 || /request budget of \d+ model requests/.test(error)) return { stop: "budget", detail: error.slice(0, 300) };
    if (/pinned route/.test(error)) return { stop: "route-refused", detail: error.slice(0, 300) };
    if (wire.providerErrors > 0 || /\b(429|5\d\d)\b|overloaded|capacity|rate.?limit|network error|ECONN|socket|timed? ?out|terminated/i.test(error)) return { stop: "provider-error", detail: error.slice(0, 300) };
    return { stop: "crash", detail: error.slice(0, 300) };
  }
  return { stop: "crash", detail: `stopReason ${reason || "none"}, exit ${run.code}` };
}

export type InvalidClass = "infrastructure" | "capacity" | "off-route" | "refusal";
export interface AttemptFacts { stop: StopKind; wire: WireTotals; inFlightAtEndMs: number; refusalSuspected: boolean }
/** An in-flight request older than this when the wall guard fires makes the time stop an outage, not an exhausted opportunity. */
export const OUTAGE_IN_FLIGHT_MS = 10 * 60_000;
/**
 * Attempt validity (pure). Invalid: any off-route/unverifiable refusal or off-route response; a provider error stop or an outage-made
 * time stop (capacity); output-length stops, crashes, no model request (infrastructure); a provider refusal (empty change with a
 * refusal text). Valid outcomes: turn-end, budget, time. Unknown usage never makes an attempt valid or invalid (it is reported).
 */
export function classifyAttempt(facts: AttemptFacts): { valid: true; terminal: "turn-end" | "budget" | "time" } | { valid: false; invalid: InvalidClass; detail: string } {
  const { stop, wire } = facts;
  if (wire.refusedRoute + wire.refusedUnverifiable > 0 || wire.offRouteResponses > 0 || stop === "route-refused") return { valid: false, invalid: "off-route", detail: `route ${wire.refusedRoute}, unverifiable ${wire.refusedUnverifiable}, off-route responses ${wire.offRouteResponses}` };
  if (stop === "provider-error") return { valid: false, invalid: "capacity", detail: "provider error ended the session" };
  if (stop === "time" && facts.inFlightAtEndMs >= OUTAGE_IN_FLIGHT_MS) return { valid: false, invalid: "capacity", detail: `a request was in flight for ${Math.round(facts.inFlightAtEndMs / 1000)} s when time ran out` };
  if (stop === "length" || stop === "crash" || stop === "no-model" || wire.forwarded === 0) return { valid: false, invalid: "infrastructure", detail: `stop ${stop}, forwarded ${wire.forwarded}` };
  if (facts.refusalSuspected) return { valid: false, invalid: "refusal", detail: "no change and a refusal text" };
  return { valid: true, terminal: stop as "turn-end" | "budget" | "time" };
}
/** A provider/policy refusal: the session changed nothing and its last text refuses (pure). */
export const REFUSAL = /\b(I can(?:'|no)t help with|I'm (?:not able|unable) to (?:help|assist)|cannot assist with|against (?:my|the) (?:policy|guidelines))\b/i;
export const refusalSuspected = (finalText: string, changedFiles: number): boolean => changedFiles === 0 && REFUSAL.test(finalText);

export type WitnessStatus = "pass" | "fail" | "untrusted" | "tampered" | "error";
export type Outcome = "solved" | "miss" | "unscored" | "invalid";
/** A valid attempt is a miss when the frozen public witness fails on its final workspace, solved when it passes, else unscored. */
export function outcomeOf(attempt: { valid: boolean; witness?: WitnessStatus }): Outcome {
  if (!attempt.valid) return "invalid";
  if (attempt.witness === "fail") return "miss";
  if (attempt.witness === "pass") return "solved";
  return "unscored";
}

// ---------------------------------------------------------------------------------------------------------------------------
// Calibration schedule, promotion, families, stop, bounds

export const SCREEN_RUNS = 2;
export const CONFIRM_RUNS = 3;
/** A case is promoted when at least this many of its valid confirmation runs are misses. */
export const PROMOTE_MIN_CONFIRM_MISSES = 2;
/** At most one rerun of an invalid attempt (a slot); a valid outcome (miss or not) is never rerun. */
export const MAX_RERUNS = 1;
/** At most this many qualified cases per pool are calibrated (pool order). */
export const MAX_CALIBRATED = 20;
export const MIN_FAMILIES = 2;
/** Upper bound on counted baseline attempts per pool: every slot of every calibrated case with its one rerun. */
export const MAX_ATTEMPTS_PER_POOL = MAX_CALIBRATED * (SCREEN_RUNS + CONFIRM_RUNS) * (1 + MAX_RERUNS);
/** Harness validation sessions (never counted, never on a pool case). */
export const MAX_SMOKE_SESSIONS = 3;
/** Scheduling only (no effect on any rule): concurrent baseline sessions. */
export const CONCURRENCY = 8;

export type Phase = "screen" | "confirm";
export interface CalUnit { name: string; case: string; phase: Phase; slot: number }
/** Unit names of a case's phase: <case>-s1, <case>-s2 (screening), <case>-c1..c3 (confirmation). */
export function unitsOf(caseId: string, phase: Phase): CalUnit[] {
  const count = phase === "screen" ? SCREEN_RUNS : CONFIRM_RUNS;
  return Array.from({ length: count }, (_, index) => ({ name: `${caseId}-${phase === "screen" ? "s" : "c"}${index + 1}`, case: caseId, phase, slot: index + 1 }));
}
/** Whether a slot gets another attempt: only after an invalid attempt, at most MAX_RERUNS times. */
export const rerunSlot = (outcomes: readonly Outcome[]): boolean => outcomes.length > 0 && outcomes.length <= MAX_RERUNS && outcomes.at(-1) === "invalid";
/** The outcome of a slot: its last attempt's (an invalid slot after its rerun is missing). */
export const slotOutcome = (outcomes: readonly Outcome[]): Outcome | "missing" => outcomes.length === 0 ? "missing" : outcomes.at(-1)!;

/** Whether a case needs confirmation runs: at least one screening miss. */
export const needsConfirmation = (screen: readonly (Outcome | "missing")[]): boolean => screen.includes("miss");

export interface CaseCalibration { case: string; repo: string; screen: (Outcome | "missing")[]; confirm: (Outcome | "missing")[]; mechanism?: string }
/** The promotion rule (pure): a screening miss, then at least PROMOTE_MIN_CONFIRM_MISSES misses among the confirmation runs. */
export const promoted = (c: CaseCalibration): boolean => needsConfirmation(c.screen) && c.confirm.filter(outcome => outcome === "miss").length >= PROMOTE_MIN_CONFIRM_MISSES;

/**
 * Families: connected components of the promoted cases, where two cases are connected when they share the upstream repository OR
 * the public behaviour class their witness failure shows (`mechanism`, recorded per case from the failing witness output; absent =
 * no class link). Two promoted cases of one repository, or of one behaviour class, are one family (distinct issues alone do not
 * establish distinct families); links are transitive.
 */
export function families(cases: readonly CaseCalibration[]): { family: string; cases: string[] }[] {
  const members = cases.filter(promoted);
  const parent = members.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!, b = members[j]!;
      if (a.repo.toLowerCase() === b.repo.toLowerCase() || (a.mechanism !== undefined && a.mechanism === b.mechanism)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, CaseCalibration[]>();
  members.forEach((c, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), c]));
  return [...groups.values()].map(group => ({ family: [...new Set(group.map(c => c.mechanism ?? `repo:${c.repo.toLowerCase()}`))].sort().join(" | "), cases: group.map(c => c.case) }));
}

/** The stop rule after a pool's calibration: enough families, or pool B (once), or the end with a negative result. */
export function stopDecision(pool: PoolName, promotedFamilies: number): "done" | "pool-B" | "negative" {
  if (promotedFamilies >= MIN_FAMILIES) return "done";
  return pool === "A" ? "pool-B" : "negative";
}

// ---------------------------------------------------------------------------------------------------------------------------
// Uncertainty

function lnGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const y = x - 1;
  let a = 0.99999999999980993;
  const t = y + 7.5;
  for (let i = 0; i < 8; i++) a += g[i]! / (y + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}
/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.exp(lnGamma(n + 1) - lnGamma(i + 1) - lnGamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, sum);
}
/** Root of an increasing function on [0, 1] by bisection. */
function rootIncreasing(f: (p: number) => number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** Exact two-sided Clopper-Pearson interval for k events in n trials ([0, 1] for n = 0). */
export function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [0, 1];
  const lower = k === 0 ? 0 : rootIncreasing(p => 1 - binomCdf(k - 1, n, p) - alpha / 2);
  const upper = k === n ? 1 : rootIncreasing(p => alpha / 2 - binomCdf(k, n, p));
  return [lower, upper];
}
