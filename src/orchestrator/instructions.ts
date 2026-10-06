/**
 * What the orchestrator (the single workflow's implement/answer worker, docs/orchestrator.md) is told about splitting.
 *
 * `SPLIT_JUDGMENT` is the `checklist` variant of experiments/judgment/variants.ts (= variants-v2.ts `checklist`), chosen by both
 * pre-registered evaluations (docs/orchestrator.md 5 and 8): v1 one-turn, claude-opus-5-5 98.9% with 0% unnecessary splits (the three
 * questions alone split 24% of the tasks that should not be split); v2, judged after reading the repository with labels by measured
 * work size, tied with `checklist-sized` and kept as the incumbent. End to end (docs/orchestrator.md 9) `checklist` declined to split
 * p4 (three independent ports of 15-25 minutes each); `checklist-sized` split it and finished 11% sooner at 1.6x the cost, which is
 * the trade the checklist's cost sentence describes, so the checklist stays. test/orchestrator/spawn.test.ts keeps the texts identical.
 */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const SPLIT_JUDGMENT = `Not splitting is the default: do the task yourself unless one of the three criteria below clearly holds. Every sub-worker starts cold and re-reads what it needs, and you still integrate and check its work. On this code base a multi-worker split measured about twice the cost of one worker for about 10% less wall time; splitting coupled work costs more and breaks more.
1. Parallelism: split only when ALL hold: (a) two or more parts need none of each other's results (no part uses an interface, data or decision that another part creates); (b) the parts write disjoint files (no shared file, registry, schema, config or doc edited by two parts); (c) each part is substantial on its own, roughly ten minutes or more of reading, implementing and testing; (d) the context a worker must load is small compared with its part. Not parallelism: several small edits; a rename or another mechanical change across many files; one bug or feature that spans modules through shared contracts; parts that depend on an interface still to be designed; steps that must run in order; a question that one investigation answers.
2. Isolation: split off a part only when it needs a different environment or tool set: game-asset or video production (specialists with their own tools and models), or a separate checkout or worktree whose state must not mix with this one. Wanting a clean context is not isolation; read selectively instead.
3. Independent verification: add a fresh verifier only when the user explicitly asks for an independent review or verification, or when a wrong result would be irreversible or costly (production data, money, security) and the project's own tests cannot establish correctness. Ordinary changes covered by tests are verified by you running the checks.
Units: one unit per independent part with the files or directories it owns; two units never own the same file.`;

/**
 * The orchestrator's line in place of "You work alone; there are no peers or backlog." (which gpt-6.1-sol read as a ban on
 * sub-workers in evaluation v2: docs/orchestrator.md 9).
 */
export const ORCHESTRATOR_TEAM_LINE = "There are no peers or backlog; the only other workers are the sub-workers you start with orche_spawn.";

/** Sub-workers one orche_spawn call may start (they run at the same time). */
export const MAX_SUB_WORKERS = 4;

/** How the orchestrator uses orche_spawn and what it owes afterwards. */
export const SPAWN_USAGE = `orche_spawn {reason, workers:[{name, role, request, files}]} starts up to ${MAX_SUB_WORKERS} sub-workers in fresh sessions at the same time and returns when all of them have reported. They see only their own request: make each one self-contained (goal, acceptance criteria, constraints, file references, and the user's original wording where it matters) and never paste your reasoning. Sub-workers cannot spawn workers. reason "parallelism": two or more workers; every writing worker (implement, game-asset, video) names the files or directories it owns, no two own the same file, and writes outside a worker's own files are blocked. reason "isolation": a game-asset or video specialist (its own model route and image tools), or a worker that must run apart from this context. reason "verification": role verify only; give the fresh verifier the original request, the acceptance criteria and the changed paths, not how you built it, and let it run its own checks. Call orche_spawn again for another reason (one call at a time). After sub-workers report you own the result: read their reports, check what they changed, run the project checks yourself, fix or finish what is missing, and report one result for the whole task.`;

/**
 * The orchestrator part of an implement/answer assignment prompt in the single workflow. `judgment` exists for the split-judgment
 * evaluation (experiments/judgment/run-v2.ts), which renders this exact section with each instruction variant.
 */
export function orchestratorSection(judgment: string = SPLIT_JUDGMENT): string {
  return `Orchestration: you are the orchestrator of this task. Before you start working, decide whether to split it.\n${judgment}\n${SPAWN_USAGE}\nReport the decision in data.split: {decision:"none" or "split",criteria:[the criteria that applied: "parallelism", "isolation", "verification"],reason:"one or two sentences"}.`;
}

/** The `split` field the orchestrator's report_result data carries. */
export const SPLIT_FORMAT = 'split:{decision:"none" or "split",criteria:["parallelism"|"isolation"|"verification"],reason:"one or two sentences"}';

export const splitSchema = Type.Object({
  decision: Type.Union([Type.Literal("none"), Type.Literal("split")]),
  criteria: Type.Optional(Type.Array(Type.Union([Type.Literal("parallelism"), Type.Literal("isolation"), Type.Literal("verification")]), { maxItems: 3 })),
  reason: Type.String({ minLength: 1, maxLength: 600 }),
});
export interface SplitDecision { decision: "none" | "split"; criteria?: ("parallelism" | "isolation" | "verification")[]; reason: string }

/**
 * Validation of the orchestrator's report: `data.split` must say whether it split and why, and must say "split" (naming each reason
 * it used) once it ran sub-workers. Undefined: valid.
 */
export function splitError(data: unknown, spawnedReasons: ReadonlySet<string>): string | undefined {
  const split = data && typeof data === "object" && !Array.isArray(data) ? (data as { split?: unknown }).split : undefined;
  // Not splitting is the default: a report without data.split is accepted unless sub-workers ran (then the decision must name them).
  if (split === undefined) return spawnedReasons.size ? `data.split is required after orche_spawn: ${SPLIT_FORMAT}.` : undefined;
  if (!Value.Check(splitSchema, split)) return `Invalid data.split: ${[...Value.Errors(splitSchema, split)].slice(0, 4).map(error => `${error.path || "/"}: ${error.message}`).join("; ")}. Expected ${SPLIT_FORMAT}.`;
  if (split.decision === "split" && !split.criteria?.length) return "data.split.criteria must name the criteria that applied when decision is \"split\".";
  if (spawnedReasons.size) {
    if (split.decision !== "split") return `data.split.decision must be "split": you ran sub-workers with orche_spawn (${[...spawnedReasons].join(", ")}).`;
    const missing = [...spawnedReasons].filter(reason => !split.criteria?.includes(reason as never));
    if (missing.length) return `data.split.criteria must include ${missing.join(", ")}: you ran orche_spawn for ${missing.length === 1 ? "it" : "them"}.`;
  }
  return undefined;
}

export function splitOf(data: unknown): SplitDecision | undefined {
  const split = data && typeof data === "object" && !Array.isArray(data) ? (data as { split?: unknown }).split : undefined;
  return Value.Check(splitSchema, split) ? structuredClone(split) as SplitDecision : undefined;
}
