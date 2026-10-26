/**
 * witness-replay pilot (experiments/witness-replay/README.md): does keeping an executable, unadapted public reproducer through
 * candidate acceptance repair bugs that an ordinary bounded revision does not?
 *
 * Pure parts, unit-tested without any model (test/experiments/witness-replay.test.ts): the pinned route, the seeds and their
 * public witnesses, the ONE prompt both arms receive, the gate message only arm T can receive, the finite budget, the frozen
 * schedule, the attempt classification (valid outcome vs. infrastructure/capacity/off-route invalid) and the preregistered
 * stop/go decision.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------------------------------------------
// The one route

/** Every model request of every arm (and any model-based role): this model at this effort. Never xhigh or max, no fallback. */
export const MODEL = { provider: "cliproxyapi", id: "gpt-6.1-sol" } as const;
export const MODEL_REF = `${MODEL.provider}/${MODEL.id}`;
export const EFFORT = "high" as const;
/** Pi settings of every session: the same model and effort as the CLI flags; SSE so the proxy can read every stream. */
export const piSettings = (): Record<string, unknown> => ({ defaultProvider: MODEL.provider, defaultModel: MODEL.id, defaultThinkingLevel: EFFORT, quietStartup: true, transport: "sse" });

// ---------------------------------------------------------------------------------------------------------------------------
// Arms and the finite repair opportunity (identical for both arms)

export const ARMS = ["C", "T"] as const;
export type Arm = typeof ARMS[number];
/**
 * One revision session: at most `maxRequests` model requests (the unit proxy refuses the next one, across every Pi invocation of
 * the unit) and `wallMs` of wall time from the session's start; arm T additionally stops after `maxGateRounds` failed gate runs.
 */
export const BUDGET = { maxRequests: 60, wallMs: 40 * 60_000, maxGateRounds: 3 } as const;
/** At most one rerun of an invalid attempt (infrastructure, provider capacity, off-route); a valid outcome is never rerun. */
export const MAX_RERUNS = 1;
export const MAX_SEEDS = 5;
export const MAX_COUNTED_SESSIONS = 10;

// ---------------------------------------------------------------------------------------------------------------------------
// Seeds

export type SeedRole = "failure" | "control";
export interface Seed {
  /** Unit-name stem. */
  id: string;
  role: SeedRole;
  /** Failure family (one per independent mechanism) or "control". */
  family: string;
  task: string;
  /** Fixture root of the task (repository-relative) and the environment cache its source and venv come from. */
  fixtures: string; cache: string;
  /** The archived artifact this seed starts from (repository-relative unit directory with workspace-final/ and final.diff). */
  artifact: string;
  /** Model-visible reproducer and the evaluation-only held-out check (repository-relative). */
  witness: string; heldout?: string;
  /** Pre-final, model-visible diagnostic the witness is derived from: verbatim excerpt and where it was recorded. */
  diagnostic: { source: string; text: string };
}

const V = "results/ultra-ho/stage3-r2/validation/runs";

/**
 * R1 outcome per failure family (results/witness-replay/AUDIT.md): true only when the family's public witness qualified.
 * masked-compatibility (HF) qualified; compatibility-retraction (tox) did not (its discriminating case is not sufficiently
 * justified by public evidence); Narwhals F/r1 has no entry: its seed already passes the issue's native PySpark reproduction.
 */
export const R1_QUALIFIED: Readonly<Record<string, boolean>> = { "masked-compatibility": true, "compatibility-retraction": false };

/** The R1 stop rule: a pilot needs at least two distinct qualified failure families and no unqualified failure seed. */
export function r1Gate(seeds: readonly Seed[], qualified: Readonly<Record<string, boolean>> = R1_QUALIFIED): { ok: boolean; families: string[]; excluded: string[] } {
  const failures = seeds.filter(seed => seed.role === "failure");
  const families = [...new Set(failures.filter(seed => qualified[seed.family] === true).map(seed => seed.family))];
  const excluded = failures.filter(seed => qualified[seed.family] !== true).map(seed => seed.id);
  return { ok: families.length >= 2 && excluded.length === 0, families, excluded };
}

/** The approved candidate seeds with a model-facing witness; freeze() admits them only through r1Gate (tox is unqualified). */
export const SEEDS: readonly Seed[] = [
  {
    id: "hf", role: "failure", family: "masked-compatibility", task: "huggingface__huggingface_hub-4056",
    fixtures: "fixtures/advisor-bench/swe-r2", cache: "results/advisor-reviewer/cache/swe-r2", artifact: `${V}/huggingface__huggingface_hub-4056/H2/r2`,
    witness: "experiments/witness-replay/witnesses/hf-4056.py", heldout: "experiments/witness-replay/heldout/hf-4056.py",
    diagnostic: {
      source: `${V}/huggingface__huggingface_hub-4056/H2/r2/records/uho-huggingface-huggingface-hub-4056-H2-r2/workers/W1.2-2026-10-24T14-00-43-482Z.jsonl:54,56`,
      text: [
        "Probe on the unmodified code (stderr patched to io.StringIO, TQDM_POSITION unset, then '-1'):",
        "  from tqdm.auto import tqdm as base",
        "  with module._get_progress_bar_context(desc='compatibility', log_level=logging.WARNING, total=5, tqdm_class=base) as bar:",
        "      bar.update(5)",
        "Output:",
        "  raw tqdm class position= None n= 0",
        "  raw tqdm class position= -1 error= TqdmKeyError \"Unknown argument(s): {'name': None}\"",
      ].join("\n"),
    },
  },
  {
    id: "tox", role: "failure", family: "compatibility-retraction", task: "tox-dev__tox-3904",
    fixtures: "fixtures/advisor-bench/swe", cache: "results/advisor-reviewer/cache/swe", artifact: `${V}/tox-dev__tox-3904/H2/r1`,
    witness: "experiments/witness-replay/witnesses/tox-3904.py", heldout: "experiments/witness-replay/heldout/tox-3904.py",
    diagnostic: {
      source: `${V}/tox-dev__tox-3904/H2/r1/records/uho-tox-dev-tox-3904-H2-r1/workers/W1.2-2026-10-24T13-33-30-898Z.jsonl:87`,
      text: [
        "Read-only reproduction outcomes (an earlier analysis, before any fix):",
        "- Executed the actual in-memory `ToxIni` → `Config` → `IniLoader` → reference replacer → `list[Command]` path. Used registered constant stand-ins for `base_python` and `env_python`, avoiding interpreter discovery and environment creation.",
        "- With mocked `linux-x86_64`, `py39-x86_64` produced one correct command, while `py39-arm64` substituted `x86_64\\narm64` and became two malformed commands. With mocked `macosx-14.0-arm64`, the failing environment reversed: `py39-x86_64` failed and `py39-arm64` worked.",
        "- A separate direct matcher/converter matrix included `env_name=None`, an architecture-free `py39`, and a platform string without a hyphen. Results followed exactly the host-factor insertion rule. Thus the leading blank INI line, Python 3.9 availability, and the command's two other substitutions are not necessary causes.",
      ].join("\n"),
    },
  },
  {
    id: "sqlglot", role: "control", family: "control", task: "tobymao__sqlglot-7187",
    fixtures: "fixtures/advisor-bench/swe", cache: "results/advisor-reviewer/cache/swe", artifact: `${V}/tobymao__sqlglot-7187/H2/r1`,
    witness: "experiments/witness-replay/witnesses/sqlglot-7187.py", heldout: "experiments/witness-replay/heldout/sqlglot-7187.py",
    diagnostic: {
      source: `${V}/tobymao__sqlglot-7187/H2/r1/records/uho-tobymao-sqlglot-7187-H2-r1/workers/W1.2-2026-10-24T14-06-01-721Z.jsonl:54`,
      text: [
        "From an earlier analysis, before any fix:",
        "- Baseline Python reproductions: `LAST_VALUE(value ORDER BY idx IGNORE NULLS)` and the RESPECT variant fail with `ParseError: Expecting )`. Argument ORDER BY alone and null treatment alone both parse and roundtrip successfully.",
        "- DuckDB 1.5.6 is already installed. Native execution accepts ORDER BY followed by either IGNORE or RESPECT NULLS, including multiple sort keys and explicit NULLS FIRST/LAST. It rejects the reverse ordering, `value IGNORE NULLS ORDER BY idx`, and its RESPECT counterpart.",
      ].join("\n"),
    },
  },
  {
    id: "stravalib", role: "control", family: "control", task: "stravalib__stravalib-709_interface",
    fixtures: "fixtures/advisor-bench/swe", cache: "results/advisor-reviewer/cache/swe", artifact: `${V}/stravalib__stravalib-709_interface/H2/r1`,
    witness: "experiments/witness-replay/witnesses/stravalib-709.py",
    diagnostic: {
      source: `${V}/stravalib__stravalib-709_interface/H2/r1/records/uho-stravalib-stravalib-709-interface-H2-r1/workers/W1.2-2026-10-24T13-34-49-595Z.jsonl:30`,
      text: [
        "From an earlier analysis, before any fix (100 seconds until short reset and 1,000 seconds until daily reset; tuple order short usage, daily usage, short limit, daily limit):",
        "- Low, rates `(9, 1, 10, 101)`: current wait **10**, required **100**. Short pacing is 100; daily pacing is 10.",
        "- Medium, rates `(1, 50, 11, 100)`: current **10**, required **20**. This demonstrates the inclusive half-usage boundary.",
        "- Medium, rates `(1, 60, 11, 100)`: current **10**, required **25**.",
      ].join("\n"),
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------------
// The prompt (identical for both arms) and the gate message (arm T only, only after a failed gate run)

export interface PromptTask { problemStatement: string; interface?: string; repo?: string }

/** The one revision prompt of a seed. It takes NO arm: C and T receive byte-identical text. */
export function revisionPrompt(seed: Pick<Seed, "diagnostic">, task: PromptTask, mount: string): string {
  return [
    "Revise an existing candidate fix in this repository (a snapshot of the project at the time of the GitHub issue below, without git history). An earlier attempt left its changes uncommitted in the working tree: `git status` and `git diff` show them against the original snapshot. Resolve the issue: keep what is right in the candidate and change what is not. Hidden tests written by the maintainers will check the result; the existing tests must keep passing.",
    "Python environment: `python` and `pytest` on PATH run the code of the project you are in (the nearest directory with pyproject.toml/setup.py/setup.cfg above the current directory) with the project's dependencies preinstalled (read-only; no pip, no network).",
    `Budget: this revision session has at most ${BUDGET.maxRequests} model requests and ${BUDGET.wallMs / 60_000} minutes.`,
    "",
    "## Issue",
    task.problemStatement.trim(),
    ...(task.interface?.trim() ? ["", task.interface.trim()] : []),
    "",
    "## Earlier diagnostic (recorded before the candidate was written)",
    seed.diagnostic.text.trim(),
    "",
    "## Retained public reproducer",
    `A reproducer built only from the public issue text and the diagnostic above is available read-only at \`${mount}\`. From the project root, \`python ${mount}\` runs it against the code in this workspace; it exits 0 when the reproduced behaviour is the one the issue expects, and its last line is a JSON summary.`,
    "",
    "Constraints: work only inside this workspace (the current directory; temporary files in $TMPDIR are fine); no git commits; no network access is needed or available; do not weaken, skip or delete existing tests. When you are done, end your turn with a short summary of what you changed and why.",
  ].join("\n");
}

/** What arm T receives when the automatic acceptance run of the retained reproducer fails (the output tail, nothing else). */
export function gateMessage(mount: string, run: { exit: number | null; status: string; reason?: string; output: string }, maxChars = 6000): string {
  const tail = run.output.length > maxChars ? `…${run.output.slice(-maxChars)}` : run.output;
  return [
    `Acceptance check (run automatically by the harness, not by you): \`python ${mount}\` was executed unchanged against the current workspace and did not pass (exit ${run.exit ?? "none"}${run.status === "fail" ? "" : `, ${run.status}${run.reason ? `: ${run.reason}` : ""}`}). The candidate is not accepted. Its output:`,
    "",
    "```",
    tail.trimEnd(),
    "```",
    "",
    "Continue revising; end your turn when you are done.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Schedule

export interface Unit { name: string; seed: string; arm: Arm; pair: number; position: number }
/** Frozen order: seeds in SEEDS order, both arms of a seed as one concurrent pair, which arm starts first alternating per seed. */
export function schedule(seeds: readonly Pick<Seed, "id">[]): Unit[] {
  if (seeds.length > MAX_SEEDS) throw new Error(`at most ${MAX_SEEDS} seeds`);
  const units: Unit[] = [];
  seeds.forEach((seed, pair) => {
    const arms: Arm[] = pair % 2 === 0 ? ["C", "T"] : ["T", "C"];
    arms.forEach(arm => units.push({ name: `${seed.id}-${arm}`, seed: seed.id, arm, pair, position: units.length }));
  });
  if (units.length > MAX_COUNTED_SESSIONS) throw new Error(`at most ${MAX_COUNTED_SESSIONS} counted sessions`);
  return units;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Attempts

/** How one Pi invocation ended, from its JSON events and the proxy log. */
export type StopKind = "turn-end" | "budget" | "provider-error" | "route-refused" | "time" | "no-model" | "crash";
export type Terminal = "accepted" | "gate-exhausted" | "budget-exhausted" | "time-exhausted" | "invalid";
export type InvalidClass = "infrastructure" | "capacity" | "off-route";

/** Whether an attempt is a valid outcome or an invalid attempt that the frozen policy reruns (at most once). */
export function classifyAttempt(stops: readonly StopKind[], counts: { forwarded: number; refusedRoute: number; offRouteResponses: number }): { valid: boolean; invalid?: InvalidClass } {
  if (counts.refusedRoute > 0 || counts.offRouteResponses > 0 || stops.includes("route-refused")) return { valid: false, invalid: "off-route" };
  if (stops.includes("provider-error")) return { valid: false, invalid: "capacity" };
  if (stops.includes("crash") || stops.includes("no-model") || counts.forwarded === 0) return { valid: false, invalid: "infrastructure" };
  return { valid: true };
}

/**
 * What happens after the model ended its turn (pure; the only place the arms differ). C: accept the workspace as it is. T: accept
 * only when the harness's own run of the unchanged reproducer passed on this exact workspace; otherwise continue in the same
 * session with the run's output, unless the gate rounds, the request budget or the wall time are spent.
 */
export function afterTurnEnd(arm: Arm, state: { gate?: { status: string }; gateRounds: number; forwarded: number; remainingMs: number }, budget: { maxRequests: number; maxGateRounds: number } = BUDGET): "accept" | "continue" | "gate-exhausted" | "budget-exhausted" | "time-exhausted" {
  if (arm === "C") return "accept";
  if (!state.gate) throw new Error("arm T needs the gate run of this turn end");
  if (state.gate.status === "pass") return "accept";
  if (state.gateRounds >= budget.maxGateRounds) return "gate-exhausted";
  if (state.forwarded >= budget.maxRequests) return "budget-exhausted";
  if (state.remainingMs <= 0) return "time-exhausted";
  return "continue";
}

/** An acceptance holds only for the exact candidate it refers to: the final workspace must have the accepted digest. */
export const acceptanceHolds = (acceptedDigest: string | undefined, finalDigest: string): boolean => acceptedDigest !== undefined && acceptedDigest === finalDigest;

// ---------------------------------------------------------------------------------------------------------------------------
// Outcomes and the preregistered decision

export interface Outcome {
  seed: string; arm: Arm; role: SeedRole; family: string;
  /** Missing: no valid attempt within the rerun bound (never counted as a failure). */
  missing?: boolean;
  terminal?: Terminal;
  /** The retained witness on the final workspace (harness-run, sandboxed) and the held-out public check. */
  witnessPass?: boolean; heldoutPass?: boolean;
  /** Graded visible test files without hidden tests: tests failing in the final but not in the seed. */
  newFailures?: string[];
  /** Original fixture protected files → final. */
  integrityViolations?: string[];
  gradePass?: boolean;
  leakHits?: string[];
}

/** Public-behaviour repair of a failure seed (the decision metric; the hidden grade is reported separately). */
export const repaired = (o: Outcome): boolean => !o.missing && o.witnessPass === true && o.heldoutPass !== false && (o.newFailures?.length ?? 0) === 0 && (o.integrityViolations?.length ?? 0) === 0 && (o.leakHits?.length ?? 0) === 0;
/** A control stays public-correct after revision. */
export const controlKept = (o: Outcome): boolean => !o.missing && o.witnessPass === true && (o.newFailures?.length ?? 0) === 0 && (o.integrityViolations?.length ?? 0) === 0 && (o.leakHits?.length ?? 0) === 0;

export type Verdict = "go" | "prefer-C" | "no-go" | "not-supported" | "inconclusive";
export interface Decision { verdict: Verdict; reasons: string[]; perFamily: Record<string, { C?: boolean; T?: boolean; addedByT?: boolean }> }

/**
 * The preregistered stop/go rule (results/witness-replay/PREREGISTRATION.md "Decision"): GO (a separately authorized larger study
 * is warranted, NOT a rollout) only when T repairs every qualified failure family while C does not, no T control or integrity
 * regression, no leak; NO-GO when T fails the HF witness, regresses a control/integrity, or a leak occurred; PREFER-C when C
 * repairs every family T repairs; NOT-SUPPORTED otherwise (mixed); INCONCLUSIVE when a missing unit could change the verdict.
 */
export function decide(outcomes: readonly Outcome[], firstFamily = "masked-compatibility"): Decision {
  const reasons: string[] = [];
  const failures = outcomes.filter(o => o.role === "failure");
  const families = [...new Set(failures.map(o => o.family))];
  const perFamily: Decision["perFamily"] = {};
  for (const family of families) {
    const of = (arm: Arm) => failures.find(o => o.family === family && o.arm === arm);
    const c = of("C"), t = of("T");
    perFamily[family] = { ...(c && !c.missing ? { C: repaired(c) } : {}), ...(t && !t.missing ? { T: repaired(t) } : {}) };
    perFamily[family]!.addedByT = perFamily[family]!.T === true && perFamily[family]!.C === false;
  }
  const leaks = outcomes.filter(o => (o.leakHits?.length ?? 0) > 0);
  if (leaks.length) reasons.push(`leak or network hits in ${leaks.map(o => `${o.seed}-${o.arm}`).join(", ")}`);
  const tControls = outcomes.filter(o => o.role === "control" && o.arm === "T" && !o.missing);
  const tControlRegress = tControls.filter(o => !controlKept(o));
  if (tControlRegress.length) reasons.push(`T control regression: ${tControlRegress.map(o => o.seed).join(", ")}`);
  const tIntegrity = outcomes.filter(o => o.arm === "T" && (o.integrityViolations?.length ?? 0) > 0);
  if (tIntegrity.length) reasons.push(`T integrity violation: ${tIntegrity.map(o => o.seed).join(", ")}`);
  const first = perFamily[firstFamily];
  if (first?.T === false) reasons.push(`T did not repair the ${firstFamily} family`);
  if (reasons.length) return { verdict: "no-go", reasons, perFamily };
  const missing = outcomes.filter(o => o.missing);
  if (missing.length) {
    reasons.push(`missing units: ${missing.map(o => `${o.seed}-${o.arm}`).join(", ")}`);
    return { verdict: "inconclusive", reasons, perFamily };
  }
  const added = families.filter(family => perFamily[family]!.addedByT);
  const tRepairs = families.filter(family => perFamily[family]!.T);
  const cAlso = tRepairs.filter(family => perFamily[family]!.C);
  if (families.length >= 2 && added.length === families.length) { reasons.push(`T repaired every qualified family (${added.join(", ")}) that C did not`); return { verdict: "go", reasons, perFamily }; }
  if (tRepairs.length > 0 && cAlso.length === tRepairs.length) { reasons.push(`C also repaired every family T repaired (${cAlso.join(", ")}): prefer the simpler C`); return { verdict: "prefer-C", reasons, perFamily }; }
  reasons.push(`T added value on ${added.length ? added.join(", ") : "no family"} of ${families.length}; the rule needs every qualified family`);
  return { verdict: "not-supported", reasons, perFamily };
}

export const digestOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
