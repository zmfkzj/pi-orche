/**
 * Split-judgment instruction variants of evaluation v2 (docs/orchestrator.md 8, pre-registered before any v2 run).
 * `checklist` (the adopted product text, SPLIT_JUDGMENT) and `fewshot` are the v1 texts unchanged; `checklist-sized` is the
 * checklist corrected by what v1 and the end-to-end smoke showed (docs/orchestrator.md 7):
 * - the cost sentence states what was measured (parts of 1–3 minutes: twice the cost, no faster) instead of a bare 2×/10% rule;
 * - (c) says whose time counts and that size is judged from the code and specs read, not from the length of the request (p1);
 * - (e) adds that parts must not disturb each other when run at the same time (n19: concurrent benchmarks).
 * The v2 runs render each variant through the product's orchestratorSection() (src/orchestrator/instructions.ts).
 */
import { VARIANTS } from "./variants.ts";

const CHECKLIST_SIZED = `Not splitting is the default: do the task yourself unless one of the three criteria below clearly holds. Every sub-worker starts cold and re-reads what it needs, and you still integrate and check its work. Measured on this code base: tasks whose parts took one worker 1-3 minutes each cost about twice as much when split and finished no sooner; splitting coupled work costs more and breaks more. A split pays off only when each part is long.
1. Parallelism: split only when ALL hold: (a) two or more parts need none of each other's results (no part uses an interface, data or decision that another part creates); (b) the parts write disjoint files (no shared file, registry, schema, config or doc edited by two parts); (c) each part would take you roughly ten minutes or more on your own (reading, implementing and testing): judge the size from the code and specs you have looked at, not from the length of the request; (d) the context a worker must load is small compared with its part; (e) running the parts at the same time does not disturb them (benchmarks or timing measurements, a shared port, database or build output). Not parallelism: several small edits or tickets of a few minutes each; a rename or another mechanical change across many files; one bug or feature that spans modules through shared contracts; parts that depend on an interface still to be designed; steps that must run in order; a question that one investigation answers.
2. Isolation: split off a part only when it needs a different environment or tool set: game-asset or video production (specialists with their own tools and models), or a separate checkout or worktree whose state must not mix with this one. Wanting a clean context is not isolation; read selectively instead.
3. Independent verification: add a fresh verifier only when the user explicitly asks for an independent review or verification, or when a wrong result would be irreversible or costly (production data, money, security) and the project's own tests cannot establish correctness. Ordinary changes covered by tests are verified by you running the checks.
Units: one unit per independent part with the files or directories it owns; two units never own the same file.`;

export const VARIANTS_V2: Readonly<Record<string, string>> = {
  checklist: VARIANTS.checklist!,
  fewshot: VARIANTS.fewshot!,
  "checklist-sized": CHECKLIST_SIZED,
};

/** The incumbent: the product text when v2 starts (selection-rule tie-break). */
export const INCUMBENT = "checklist";
