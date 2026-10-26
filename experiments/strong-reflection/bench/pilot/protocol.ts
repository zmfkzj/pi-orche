/**
 * Decision-audit rescue pilot on the strong-reflection hard-task bench (pilot/PREREGISTRATION.md, docs/strong-reflection.md):
 * the pure, frozen parts — arms and their texts, units, clusters, seeded order, budget rules and the pre-declared read-out.
 *
 * Every arm continues a recorded checkpoint of `results/strong-reflection/bench-2026-10-19` (the source bench): O's recorded model
 * responses are replayed up to the reflection point (the start of the integration node), then the pinned benchmark model goes live.
 * - A  (audit): the structured decision audit alone at the reflection point.
 * - B  (four lines + audit): the user's four-line prompt, verbatim and unchanged, followed by the SAME audit.
 * - C0 (contemporaneous control, tox units only): no text, the R0 configuration (no `strongReflection` key).
 * This is a rescue-among-known-failures mechanism pilot, not an efficacy benchmark; historical O/R0/R1 are comparators only.
 */
import { createHash } from "node:crypto";
import { costOf } from "../protocol.js";

export const PILOT_ID = "decision-audit-pilot-2026-10-23";
export const PILOT_ARMS = ["A", "B", "C0"] as const;
export type PilotArm = typeof PILOT_ARMS[number];
export const isPilotArm = (arm: string): arm is PilotArm => (PILOT_ARMS as readonly string[]).includes(arm);
/** The source bench's configuration each pilot arm runs with: A/B have `strongReflection: true` (hooks run, texts patched), C0 is R0. */
export const configArmOf = (arm: PilotArm): "R0" | "R1" => arm === "C0" ? "R0" : "R1";

/** The benchmark's model identity (source bench `protocol.ts` MODEL_REF/THINKING), as it appears on the wire. Anything else is refused. */
export const WIRE_MODEL = "gpt-6-astra";
export const WIRE_EFFORT = "high";

/**
 * Root of the source bench's live paths (its driver.ts BENCH_SCRATCH default; replayed tool calls and responses carry these absolute
 * paths) and the pilot's root, of the same length inside this worker's own scratch directory (the source root lies outside the
 * pilot's write scope). A pilot arm runs at its unit's recorded `O/meta.json` `live` path moved to PILOT_LIVE_ROOT; the proxy
 * rewrites the root in every replayed response (wire.ts rewriteSse) and the fidelity gate applies the same mapping to O's request.
 */
export const SOURCE_LIVE_ROOT = "/tmp/pi-orche/01a152d6-1832-7291-b05c-3e9a404e5ca3/W1/srb";
export const PILOT_LIVE_ROOT = "/tmp/pi-orche/01a152d6-1832-7291-b05c-3e9a404e5ca3/W4/srb";
export const PATH_MAP = { from: SOURCE_LIVE_ROOT, to: PILOT_LIVE_ROOT };
/** The pilot live path of a unit whose O ran at `recordedLive`. */
export function pilotLivePath(recordedLive: string): string {
  if (!recordedLive.startsWith(`${SOURCE_LIVE_ROOT}/`)) throw new Error(`${recordedLive} is not under ${SOURCE_LIVE_ROOT}`);
  return `${PILOT_LIVE_ROOT}${recordedLive.slice(SOURCE_LIVE_ROOT.length)}`;
}

/** The user's four lines, verbatim (identical to `src/single/reflection.ts` STRONG_REFLECTION_PROMPT; tests compare both copies). */
export const FOUR_LINES = [
  "지금까지의 대화를 한 걸음 떨어져 바라보라.",
  "기존 판단을 옹호하거나 부정하려는 목적 없이, 대화에 드러난 전제와 판단 경향을 살펴보라.",
  "무엇을 충분히 살폈고 무엇을 당연하게 넘겼는지 돌아보되, 장점이나 단점을 억지로 만들어내지 마라.",
  "그 관찰에서 실제로 판단을 바꿀 이유가 발견되면 결과에 반영하라.",
].join("\n");

/** The structured decision audit (identical in A and B). Generic: no task, domain or hidden-test content. */
export const AUDIT = [
  "Decision audit. Before you review and report, audit the decisions your work rests on, and write the audit down briefly as a list:",
  "1. Decisions. List each point where the request, the code or the existing tests allowed more than one reasonable reading and you chose one, and each behaviour your change newly accepts, rejects, adds or removes compared with the original code. Note the expected value your own tests assert for each.",
  "2. Distinguishing inputs. For each point, name a concrete input on which the competing readings give different results, and run it on the original code (the starting commit, e.g. a copy in your scratch directory; do not stash or reset your own changes) and on your change. Record both results.",
  "3. Independent evidence. Check each expected value against evidence that does not come from tests you wrote: the request's own wording and examples, the original behaviour and the existing tests, the project's documentation, changelog and code comments, and the language, standard library or specification the code relies on. A test you wrote shows that the code does what you decided, not that the decision is right.",
  "4. Requested, necessary or collateral. Classify each behaviour difference between the original code and your change as (a) requested: the problem the request asks to fix, or what its examples need in order to behave as described; (b) necessary: a direct consequence of (a), or the same fix for the same pattern that the request clearly implies; or (c) collateral: neither. Keep (a) and (b). Keep a (c) change only when independent evidence supports it; otherwise restore the original behaviour there.",
  "5. Conflicts. Where the evidence conflicts or is silent on a consequential point, take the reading the evidence supports best (when it is balanced, the one that changes less of the existing behaviour), and name the alternative as an open uncertainty in your result instead of asserting it as settled in your tests.",
  "6. Change your work only for a real reason found in this audit, then re-run the relevant checks; if there is none, keep it as it is. Do not invent problems.",
].join("\n");

/** The arm's instruction body: A the audit; B the four lines, a blank line, then the same audit; C0 nothing. */
export function armBody(arm: PilotArm): string {
  return arm === "A" ? AUDIT : arm === "B" ? `${FOUR_LINES}\n\n${AUDIT}` : "";
}
export const PILOT_HEADER = (node: string): string => `Before your self-review (strong mode; integration node ${node}):`;
export const PILOT_TRAILER = "Then carry out the integration as planned: this assignment's requirements, checks and report format are unchanged.";
/** The text appended to the task_plan result that starts integration node `node` (the reflection point), as R1's text was. */
export function pilotText(arm: PilotArm, node: string): string {
  return arm === "C0" ? "" : `${PILOT_HEADER(node)}\n${armBody(arm)}\n${PILOT_TRAILER}`;
}
/** The fallback when no integration node carried the text (a first report_result is held once), as the original class does. */
export function pilotReportText(arm: PilotArm): string {
  return `Report held once (strong mode): this is not a validation error, and nothing in your report was found wrong. Before your self-review of the result:\n${armBody(arm)}\nThen review the result afresh yourself against every requirement and the actual changes and checks, and call report_result alone again with your complete result (the same result when nothing gives a real reason to change it). This assignment's requirements, checks and report format are unchanged.`;
}
export const PILOT_SAME_RESPONSE = "Report held (strong mode): it was sent in the same response that received the self-review instructions, so it was written before they were read. Read them in this response's tool results, do your self-review, then call report_result alone again with your complete result. This is not a validation error.";
/** Removes a delivered pilot text (any arm, any node) from a string. */
export const PILOT_TEXT_RE = /\n*Before your self-review \(strong mode; integration node [^)]*\):\n[\s\S]*?report format are unchanged\./g;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------------------------------------------------------
// Units, clusters, order

/** Failure-deciding decision clusters (analysis labels only; never model-visible). Reachable vs policy/disputed is pre-declared. */
export const CLUSTERS = {
  C1: { family: "tox", reachable: true, label: "tox: implicit host-ISA factor removed (P2P), r2 also TOML scope (F2P)" },
  C2: { family: "docstub", reachable: true, label: "docstub: extra Callable arity accepted" },
  C3: { family: "docstub", reachable: false, label: "docstub: Callback[...] scope (disputed hidden scope)" },
  C4: { family: "isort", reachable: false, label: "isort: short-line comment merge/directive format (unstated policy)" },
  C5: { family: "isort", reachable: true, label: "isort: comment scope limited to directives" },
  D: { family: "d1", reachable: false, label: "d1: passing pre-review state (no-harm control)" },
} as const;
export type Cluster = keyof typeof CLUSTERS;
export const REACHABLE: readonly Cluster[] = ["C1", "C2", "C5"];

export interface Job { unit: string; task: string; tier: 1 | 2; cluster: Cluster; arms: PilotArm[] }

const TASK_OF: Record<string, string> = { tox: "tox-dev__tox-3904", d1: "d1-transactional-outbox", docstub: "scientific-python__docstub-123", isort: "pycqa__isort-2491" };
export function clusterOf(unit: string): Cluster {
  const [, family, repeat] = /^(tox|d1|docstub|isort)-[\w-]+-r(\d+)$/.exec(unit) ?? [];
  if (family === "tox") return "C1";
  if (family === "d1") return "D";
  if (family === "docstub") return repeat === "1" ? "C2" : "C3";
  if (family === "isort") return repeat === "4" ? "C5" : "C4";
  throw new Error(`unknown unit ${unit}`);
}

/** Seeded permutation (string hash → mulberry32 → Fisher–Yates): the arm order within a unit. */
export function pilotOrder(unit: string, arms: readonly PilotArm[]): PilotArm[] {
  let h = 1779033703;
  for (const ch of `${PILOT_ID}:${unit}`) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), h = h << 13 | h >>> 19;
  let seed = h >>> 0;
  const random = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const out = [...arms];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

/**
 * The pre-declared schedule in priority order. Tier 1: the reachable clusters (tox ×4 with C0, docstub-r1, isort-r4) and the four d1
 * no-harm controls, interleaved; tier 2: the policy/disputed clusters, alternating families. A job (one unit, its arms one after
 * another at the unit's recorded live path) starts only when its reserved cost fits the budget; jobs never start out of order.
 */
const ORDER: [string, 1 | 2][] = [
  ["tox-3904-r1", 1], ["d1-transactional-r1", 1], ["docstub-123-r1", 1], ["isort-2491-r4", 1], ["tox-3904-r2", 1], ["d1-transactional-r2", 1],
  ["tox-3904-r3", 1], ["d1-transactional-r3", 1], ["tox-3904-r4", 1], ["d1-transactional-r4", 1],
  ["isort-2491-r1", 2], ["docstub-123-r2", 2], ["isort-2491-r2", 2], ["docstub-123-r3", 2], ["isort-2491-r3", 2], ["docstub-123-r4", 2],
];
export const JOBS: Job[] = ORDER.map(([unit, tier]) => {
  const family = unit.split("-")[0]!;
  const arms: PilotArm[] = family === "tox" ? ["A", "B", "C0"] : ["A", "B"];
  return { unit, task: TASK_OF[family]!, tier, cluster: clusterOf(unit), arms: pilotOrder(unit, arms) };
});
/** Zero-cost dry replays (offline proxy, stop at the reflection point): one per family plus the C0 configuration. */
export const DRY: [string, PilotArm][] = [["d1-transactional-r1", "A"], ["docstub-123-r1", "B"], ["isort-2491-r4", "A"], ["tox-3904-r1", "C0"], ["tox-3904-r2", "B"]];

// ---------------------------------------------------------------------------------------------------------------------------
// Budget (token-priced estimates at the gpt-6-astra list price of the source bench; the provider reports tokens, not charges)

export const BUDGET = {
  /** Hard cap of all live spend of this pilot (smoke included). */
  capUsd: 50,
  /** Per-request gate: committed (settled + outstanding reservations) + this request's reservation must stay ≤ cap − margin. */
  gateMarginUsd: 1,
  /** Job admission: committed + the remaining reservations of running jobs + the new job's reservation ≤ cap − headroom. */
  admissionHeadroomUsd: 5,
  /** An arm whose own committed spend would pass this is censored (further requests refused); counted as not rescued. */
  armCapUsd: 6,
  /** Reserved cost of an arm = factor × the larger historical R0/R1 live cost of the same unit. */
  reserveFactor: { A: 2, B: 2, C0: 1.3 } as Record<PilotArm, number>,
  /** Lowest request-bytes per input token seen in the source bench (3.31): an upper bound of a request's input tokens. */
  bytesPerToken: 3.3,
  /** USD per million input tokens assumed for a later request of a session (≥ 80% cache reads); a session's first is uncached. */
  laterInputPerM: 2.8,
  /** Output tokens reserved per request (largest seen in the source bench: 4609). */
  outputReserveTokens: 8000,
};
const PRICE_INPUT = 10, PRICE_OUTPUT = 50;

/** Reservation of one upstream request before it is forwarded. */
export function requestReservationUsd(bytes: number, firstOfSession: boolean): number {
  const tokens = Math.ceil(bytes / BUDGET.bytesPerToken);
  return Number((tokens * (firstOfSession ? PRICE_INPUT : BUDGET.laterInputPerM) / 1e6 + BUDGET.outputReserveTokens * PRICE_OUTPUT / 1e6).toFixed(6));
}
/** What a finished request settles at: its usage price; an upstream error status with no usage 0 (nothing generated); else (an interrupted stream) the reservation. */
export function settlementUsd(usage: { input: number; cached: number; output: number } | undefined, status: number, reservedUsd: number): number {
  if (usage) return costOf(usage);
  return status !== 200 ? 0 : reservedUsd;
}
export function armReservationUsd(arm: PilotArm, historicalMaxUsd: number): number {
  return Number((BUDGET.reserveFactor[arm] * historicalMaxUsd).toFixed(4));
}
/** Job admission (strict order: the caller never skips ahead). */
export function admits(committedUsd: number, runningRemainingUsd: number, jobUsd: number): boolean {
  return committedUsd + runningRemainingUsd + jobUsd <= BUDGET.capUsd - BUDGET.admissionHeadroomUsd;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Pre-declared read-out (PREREGISTRATION.md "Read-out"): cluster-level, descriptive, per arm; never a significance test.

export interface Outcome {
  unit: string;
  arm: PilotArm;
  /** Replay valid (fidelity gate passed, no refusal) and the arm ran to a terminal state (not censored). */
  valid: boolean;
  /** primaryPass of the final state (terminal done, grade passed, no integrity violation). */
  pass: boolean;
  /** primaryPass of the recorded pre-review state (O's checkpoint). */
  prePass: boolean;
  /** Manual adjudication (adjudication.json): the audit trace shows the mechanism for the decisive change. */
  mechanism?: boolean;
  /** Manual adjudication: how much of the audit the arm visibly carried out. */
  adherence?: "full" | "partial" | "none";
}
export interface ArmReadout {
  arm: "A" | "B";
  coverage: { reachable: number; reachableOf: number; d1: number; d1Of: number; complete: boolean };
  rescues: Record<string, string[]>;
  unexplainedPasses: string[];
  policyPasses: string[];
  rescuedReachableClusters: Cluster[];
  c1Rescues: number;
  d1Regressions: string[];
  adherentReachable: number;
  go: boolean;
  stop: boolean;
  reasons: string[];
}
export interface Readout { perArm: Record<"A" | "B", ArmReadout>; c0: { tox: number; valid: number; passes: string[] }; overall: "go" | "stop" | "inconclusive"; reasons: string[] }

export function readout(outcomes: readonly Outcome[]): Readout {
  const c0 = outcomes.filter(item => item.arm === "C0" && clusterOf(item.unit) === "C1");
  const c0Passes = c0.filter(item => item.valid && item.pass).map(item => item.unit);
  const d1Harm = (arm: "A" | "B") => outcomes.filter(item => item.arm === arm && clusterOf(item.unit) === "D" && item.valid && item.prePass && !item.pass).map(item => item.unit);
  const reachableUnits = JOBS.filter(job => REACHABLE.includes(job.cluster)).map(job => job.unit);
  const d1Units = JOBS.filter(job => job.cluster === "D").map(job => job.unit);
  const harmAny = [...d1Harm("A"), ...d1Harm("B")];
  const perArm = {} as Record<"A" | "B", ArmReadout>;
  for (const arm of ["A", "B"] as const) {
    const mine = outcomes.filter(item => item.arm === arm);
    const valid = (unit: string) => mine.some(item => item.unit === unit && item.valid);
    const coverage = { reachable: reachableUnits.filter(valid).length, reachableOf: reachableUnits.length, d1: d1Units.filter(valid).length, d1Of: d1Units.length, complete: false };
    coverage.complete = coverage.reachable === coverage.reachableOf && coverage.d1 === coverage.d1Of && c0.filter(item => item.valid).length === 4;
    const flips = mine.filter(item => item.valid && !item.prePass && item.pass && clusterOf(item.unit) !== "D");
    const rescued = flips.filter(item => item.mechanism === true && REACHABLE.includes(clusterOf(item.unit)));
    const rescues: Record<string, string[]> = {};
    for (const item of rescued) (rescues[clusterOf(item.unit)] ??= []).push(item.unit);
    const rescuedReachableClusters = REACHABLE.filter(cluster => rescues[cluster]?.length);
    const c1Rescues = rescues.C1?.length ?? 0;
    const unexplainedPasses = flips.filter(item => REACHABLE.includes(clusterOf(item.unit)) && item.mechanism !== true).map(item => item.unit);
    const policyPasses = flips.filter(item => !REACHABLE.includes(clusterOf(item.unit))).map(item => item.unit);
    const adherentReachable = mine.filter(item => item.valid && REACHABLE.includes(clusterOf(item.unit)) && (item.adherence === "full" || item.adherence === "partial")).length;
    const reasons: string[] = [];
    if (!coverage.complete) reasons.push(`tier-1 coverage incomplete (reachable ${coverage.reachable}/${coverage.reachableOf}, d1 ${coverage.d1}/${coverage.d1Of}, C0 ${c0.filter(item => item.valid).length}/4): neither go nor stop`);
    if (harmAny.length) reasons.push(`d1 regression observed (${harmAny.join(", ")}): not go`);
    if (c1Rescues && c1Rescues <= c0Passes.length) reasons.push(`C1 rescues (${c1Rescues}) do not exceed contemporaneous C0 passes (${c0Passes.length})`);
    const go = coverage.complete && !harmAny.length && rescuedReachableClusters.length >= 2 && c1Rescues >= 2 && c1Rescues > c0Passes.length;
    const reachablePasses = flips.filter(item => REACHABLE.includes(clusterOf(item.unit))).length;
    const stop = coverage.complete && reachablePasses === 0 && adherentReachable >= 4;
    if (!go && !stop && coverage.complete) reasons.push(`rescued reachable clusters ${rescuedReachableClusters.join("+") || "none"}, C1 rescues ${c1Rescues}, reachable grade flips ${reachablePasses}, audit carried out in ${adherentReachable}/6 reachable units`);
    perArm[arm] = { arm, coverage, rescues, unexplainedPasses, policyPasses, rescuedReachableClusters, c1Rescues, d1Regressions: d1Harm(arm), adherentReachable, go, stop, reasons };
  }
  const overall = perArm.A.go || perArm.B.go ? "go" : perArm.A.stop && perArm.B.stop ? "stop" : "inconclusive";
  const reasons = [
    ...(["A", "B"] as const).filter(arm => perArm[arm].go).map(arm => `arm ${arm} meets go`),
    ...(overall === "stop" ? ["both arms meet stop"] : []),
    ...(overall === "inconclusive" ? ["neither arm meets go and not both meet stop"] : []),
  ];
  return { perArm, c0: { tox: c0Passes.length, valid: c0.filter(item => item.valid).length, passes: c0Passes }, overall, reasons };
}
