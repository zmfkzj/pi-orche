/**
 * Stage 1 of the 2026-10-24 program: does MDSD's contract-backward (INVERT+VALIDATE, backward) search mechanism help ordinary strong
 * mode find real defects? Pure, model-free parts of the predeclared protocol (results/cb-ab/PROTOCOL.md quotes this file by sha256).
 *
 * Arms (identical prompt, target, model, effort, tools, permissions and limits; only the appended analysis step differs):
 *  - A  ordinary `/orche strong <prompt>`.
 *  - B  the same + a required read-only explorer sub-worker with the CONTRACT-BACKWARD brief before the final answer.
 *  - C  the same + a required read-only explorer sub-worker with a GENERIC brief (explicit compute control: the same extra worker,
 *       the same position and limits, without the contract-backward method).
 * One final defect report per run (the strong worker's report), scored against a rubric frozen before any measured run.
 */
import { rng, shuffle } from "../ultra-ab/protocol.js";

export const ARMS = ["A", "B", "C"] as const;
export type Arm = typeof ARMS[number];

/** Every role (main, strong orchestrator, explorer and any other sub-worker, advisor if it ever ran) on one route and one effort. */
export const MODEL = { provider: "cliproxyapi", id: "gpt-6.1-sol" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
export const THINKING = "high" as const;

export const SEED = "cb-ab-2026-10-24";
export const REPEATS = 2;

/** Limits, identical for every arm (the explorer runs inside the same orche assignment). */
export const LIMITS = {
  orche: { overallMs: 60 * 60_000, assignmentMs: 60 * 60_000, extensionMs: 15 * 60_000, extensionStepMs: 0, maxExtensions: 2, assignmentRequests: 300 },
  /** Hard kill of one run's Pi process group (main + every orche task it starts). */
  piGuardMs: 150 * 60_000,
  /** Infrastructure retries per unit: only a run without one successful model request; the failed attempt is kept. */
  infraRetries: 1,
} as const;

/**
 * The run's private orche config. Every model tier pinned to Sol/high; no advisor; fixed thinking policy whose output-limit recovery
 * never lowers effort; no Bash review (a classifier model outside the pinned route); no concurrent-session prompts; ledger off as in
 * the earlier studies.
 */
export function orcheConfig(): Record<string, unknown> {
  const tier = { model: MODEL_REF, thinking: THINKING };
  return {
    mainMode: "single",
    routes: {},
    default: tier,
    models: { main: tier, orchestrator: tier, worker: tier, "strong-orchestrator": tier, "strong-worker": tier, advisor: tier },
    single: { ledger: false, spawn: true, advisor: false, maxSubWorkers: 8 },
    thinkingPolicy: { mode: "fixed", lengthRecovery: "redecompose" },
    limits: { ...LIMITS.orche },
    concurrentSessions: { enabled: false },
    bashReview: { enabled: false },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Case selection (predeclared before any case was looked at for this study)

/** Tasks of fixtures/advisor-bench/swe already used by earlier strong / ultra / MDSD / strong-reflection studies (exposed). */
export const EXPOSED = [
  "holoviz__param-1117", "marshmallow-code__marshmallow-2925_interface", "nesquena__hermes-webui-2056", "pycqa__isort-2491",
  "pypa__build-1027", "python-scim__scim2-models-126", "scientific-python__docstub-123", "sqlfluff__sqlfluff-7615",
  "stravalib__stravalib-709_interface", "tobymao__sqlglot-7187", "tox-dev__tox-3904", "youssofal__mtplx-21",
  "nolar__kopf-1225", "pallets-eco__wtforms-892_interface", "pypa__twine-1309", "python-scim__scim2-models-120",
] as const;

/** Pool: validated SWE tasks with a prepared environment, not exposed, not an `_interface` (feature/API-shape) task; screening order. */
export function screeningOrder(tasks: readonly { id: string; valid: boolean; ready: boolean }[]): string[] {
  const pool = tasks.filter(task => task.valid && task.ready && !task.id.endsWith("_interface") && !(EXPOSED as readonly string[]).includes(task.id)).map(task => task.id).sort();
  return shuffle(pool, rng(`${SEED}/cases`));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Prompts

/** The model-visible task, identical in every arm (the isort diagnosis framing of results/quality-validation, generalized). */
export function diagnosisPrompt(task: { repo: string; baseCommit: string; problemStatement: string }): string {
  return [
    `Read-only investigation of a bug report against the Python project in the current directory (the ${task.repo} repository at commit ${task.baseCommit}; no git history is available). Bug report, verbatim:`,
    "",
    task.problemStatement.replace(/\r\n/g, "\n").trim(),
    "",
    "Your task:",
    "1. Determine the root cause(s) in the code, with file:line evidence.",
    "2. Determine every code path and condition under which the reported misbehaviour, or the same underlying defect, occurs — including related variants that a complete fix must also handle — and similar-looking paths or conditions that are not affected.",
    "3. State precisely what a correct fix must change (the required behaviour and the code locations), without modifying the repository.",
    "4. Support every claim with evidence: code reading, and running the project's code on example inputs where possible. `python` and `pytest` on PATH run the code of the project in the current directory with its dependencies preinstalled (read-only; no network, no pip). Use your scratch directory for temporary files; do not modify the repository.",
    "",
    "Final answer: a defect report listing each defect with (1) the mechanism, (2) the location (file:line), (3) a concrete failing scenario (input or steps → observed vs expected; reproduce it when you can), (4) the evidence and your confidence; then what you checked and found correct, and what you could not check.",
  ].join("\n");
}

/** Contract-backward brief (B): generalizes the r1 INVERT+VALIDATE "ultra-contracts" strategy (results/mdsd-ab/r2/pinned/r1-call.json) and MDSD's operator definitions (src/orchestrator/mdsd.ts INVERT, VALIDATE); case-independent. */
export const CB_BRIEF = [
  "Search method for this explorer: contract-backward (operators INVERT and VALIDATE, direction backward).",
  "1. Contracts: from the bug report and from what the code itself promises (documentation, docstrings, type hints, configuration schemas, existing tests, names), write down the contracts the reported behaviour must satisfy: for each, the guaranteed outcome and the inputs or states it covers.",
  "2. Invert: for each contract, start from the outcome it guarantees and work backward through the code to every place that produces or influences that outcome — every entry point, code path, input format or configuration source, sibling or parallel implementation of the same behaviour, and state transition — and to the preconditions each one needs.",
  "3. Validate: for each such place, ask which input or state would violate the contract there, then test it: reproduce it with a minimal probe that runs the project's code (scratch files only), or show by a precise code trace or constraint check that it cannot occur. A suspicion without a reproduction or a precise trace is reported as unconfirmed.",
  "4. Report every violation as a finding with the file:line, the mechanism, the concrete failing scenario (input → observed vs expected), the contract it violates and the evidence (command and output, or the code trace); then the places you checked and found correct, and what you could not check. Do not modify the repository.",
].join("\n");

/** Generic brief (C, compute control): the same report format and evidence norm, no prescribed search method. */
export const GENERIC_BRIEF = [
  "Search method for this explorer: an independent investigation of the task below, in whatever way you judge best.",
  "Report every defect you find as a finding with the file:line, the mechanism, the concrete failing scenario (input → observed vs expected) and the evidence (command and output, or the code trace); a suspicion without a reproduction or a precise trace is reported as unconfirmed. Then list the places you checked and found correct, and what you could not check. Do not modify the repository.",
].join("\n");

export const EXPLORER_NAME: Record<Exclude<Arm, "A">, string> = { B: "contract-backward", C: "independent-explorer" };

/** The analysis step appended to B's and C's prompt (A: none). */
export function armSuffix(arm: Arm): string {
  if (arm === "A") return "";
  const brief = arm === "B" ? CB_BRIEF : GENERIC_BRIEF;
  return [
    "",
    "Required analysis step for this request: before your final answer, run one read-only explorer sub-worker, exactly once: orche_spawn with reason \"isolation\" and one worker {name: \"" + EXPLORER_NAME[arm] + "\", role: \"answer\", request: R}, where R is the text between the lines BEGIN BRIEF and END BRIEF below, verbatim, followed by a blank line and the complete request text above this paragraph (the bug report and the task), verbatim. Add none of your own hypotheses, findings or conclusions to R. This explorer is in addition to whatever else you decide to do. Check its findings yourself before you rely on them; your final answer remains the single defect report the task asks for.",
    "BEGIN BRIEF",
    brief,
    "END BRIEF",
  ].join("\n");
}

/** The one-shot command main receives in one run. */
export function oneShot(arm: Arm, prompt: string): string {
  return `/orche strong ${prompt}${armSuffix(arm)}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Schedule

export interface UnitSpec { id: string; caseId: string; caseOrder: number; arm: Arm; repeat: number }

/** Units of one batch: case-major, repeat-major, the arm order inside each (case, repeat) block shuffled by the seed. */
export function units(cases: readonly { id: string; order: number }[], repeats = REPEATS): UnitSpec[] {
  const out: UnitSpec[] = [];
  for (const item of [...cases].sort((a, b) => a.order - b.order)) for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const arm of shuffle(ARMS, rng(`${SEED}/${item.id}/r${repeat}`))) out.push({ id: `${item.id}/${arm}/r${repeat}`, caseId: item.id, caseOrder: item.order, arm, repeat });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Scoring and decision rules (applied to scorer outputs; see PROTOCOL.md for the scorer procedure)

/** One known defect of one run: mechanism, location, scenario points (0/1 each). Found = mechanism AND location. */
export interface KScore { k: string; m: 0 | 1; l: 0 | 1; s: 0 | 1 }
export const found = (score: KScore): boolean => score.m === 1 && score.l === 1;

export interface RunScore { unit: string; caseId: string; arm: Arm; repeat: number; k: KScore[]; v: number; f: number; u: number }

export interface CaseSummary {
  caseId: string; kItems: string[];
  foundBy: Record<Arm, string[]>;
  bUniqueVsA: string[]; aUniqueVsB: string[]; bUniqueVsC: string[];
  saturated: boolean;
  meanF: Record<Arm, number>; meanV: Record<Arm, number>; meanKPoints: Record<Arm, number>;
}

/** Per case: known defects found by >= 1 repeat of each arm (union over repeats), uniques, saturation (both A repeats found every K). */
export function summarizeCase(caseId: string, kItems: readonly string[], runs: readonly RunScore[]): CaseSummary {
  const of = (arm: Arm) => runs.filter(run => run.caseId === caseId && run.arm === arm);
  const foundSet = (arm: Arm) => [...new Set(of(arm).flatMap(run => run.k.filter(found).map(item => item.k)))].sort();
  const foundBy = { A: foundSet("A"), B: foundSet("B"), C: foundSet("C") };
  const minus = (x: string[], y: string[]) => x.filter(item => !y.includes(item));
  const mean = (arm: Arm, pick: (run: RunScore) => number) => { const list = of(arm); return list.length ? list.reduce((sum, run) => sum + pick(run), 0) / list.length : NaN; };
  const aRuns = of("A");
  const saturated = aRuns.length > 0 && aRuns.every(run => kItems.every(k => run.k.some(item => item.k === k && found(item))));
  const per = (pick: (run: RunScore) => number) => ({ A: mean("A", pick), B: mean("B", pick), C: mean("C", pick) });
  return {
    caseId, kItems: [...kItems], foundBy,
    bUniqueVsA: minus(foundBy.B, foundBy.A), aUniqueVsB: minus(foundBy.A, foundBy.B), bUniqueVsC: minus(foundBy.B, foundBy.C),
    saturated,
    meanF: per(run => run.f), meanV: per(run => run.v), meanKPoints: per(run => run.k.reduce((sum, item) => sum + item.m + item.l + item.s, 0)),
  };
}

/**
 * Predeclared stopping rule after cases 1-2: stop (case 3 is not run) when B found no known defect that A missed in either case,
 * unless BOTH cases were saturated (B had no opportunity at all; then case 3 runs).
 */
export function stopAfterTwo(first: CaseSummary, second: CaseSummary): boolean {
  if (first.saturated && second.saturated) return false;
  return first.bUniqueVsA.length + second.bUniqueVsA.length === 0;
}

export type Verdict = "supported-cb-specific" | "supported-not-isolated-from-compute" | "regression" | "not-supported";

/**
 * Predeclared verdict over the cases that ran (3 planned):
 *  - regression: B lost more known defects than it added vs A (sum of A-unique > sum of B-unique), or B's mean false/out-of-scope
 *    claims per run exceed A's by more than 1 (pooled over cases);
 *  - supported: B found >= 1 known defect A missed in >= 2 cases, sum B-unique > sum A-unique, and the F condition holds;
 *    cb-specific when additionally B found >= 1 known defect C missed in >= 2 cases, else not isolated from the extra compute;
 *  - not-supported: everything else (including a stop after case 2).
 */
export function verdict(cases: readonly CaseSummary[], runs: readonly RunScore[]): { verdict: Verdict; details: Record<string, number> } {
  const sum = (pick: (item: CaseSummary) => number) => cases.reduce((total, item) => total + pick(item), 0);
  const bUnique = sum(item => item.bUniqueVsA.length), aUnique = sum(item => item.aUniqueVsB.length);
  const casesWithB = cases.filter(item => item.bUniqueVsA.length > 0).length, casesWithBvsC = cases.filter(item => item.bUniqueVsC.length > 0).length;
  const meanF = (arm: Arm) => { const list = runs.filter(run => run.arm === arm); return list.length ? list.reduce((total, run) => total + run.f, 0) / list.length : 0; };
  const fWorse = meanF("B") > meanF("A") + 1;
  const details = { cases: cases.length, bUnique, aUnique, casesWithB, casesWithBvsC, meanFA: meanF("A"), meanFB: meanF("B"), meanFC: meanF("C") };
  if (aUnique > bUnique || fWorse) return { verdict: "regression", details };
  if (casesWithB >= 2 && bUnique > aUnique) return { verdict: casesWithBvsC >= 2 ? "supported-cb-specific" : "supported-not-isolated-from-compute", details };
  return { verdict: "not-supported", details };
}
