/**
 * Creation policy with divergence (docs/workflow-policy.md): the same creation worker first makes N candidates in deliberately
 * different directions (divergent exploration, not resampling) in a scratch directory; a one-shot Critic that made none of them scores
 * them blind (neutral labels, shuffled order) against the brief and selects one with concrete refinements; the same worker then refines
 * the selected candidate into the deliverable at the requested location. With one candidate the policy is the existing single
 * creation assignment, unchanged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { SCRATCH_ROOT } from "../single/check.js";

export interface Direction { id: string; name: string; brief: string }
/** The directions, in order; N candidates use the first N. Candidate A is the conventional one (divergence_yield counts non-A picks). */
export const DIRECTIONS: readonly Direction[] = [
  { id: "A", name: "minimal / safe", brief: "the most conventional, lowest-risk interpretation that plainly satisfies the brief and fits the project's existing style" },
  { id: "B", name: "distinctive / experimental", brief: "a bold, memorable departure (unexpected concept, composition, palette or tone) that still meets every hard constraint" },
  { id: "C", name: "target-audience optimized", brief: "what the intended audience or players would respond to most, using what the project and request say about them" },
];

export const scratchFor = (id: string): string => `${SCRATCH_ROOT}/${id}`;
/** The creation scratch directory (ignored by git, rg/fd and the workspace audit), created with its ignore files. */
export async function ensureScratch(cwd: string, scratch: string): Promise<void> {
  await mkdir(join(cwd, scratch), { recursive: true, mode: 0o700 });
  for (const name of [".gitignore", ".ignore"]) await writeFile(join(cwd, SCRATCH_ROOT, name), "*\n", { flag: "wx" }).catch(() => undefined);
}

/** Appended to the creation request in the candidate round. */
export function candidatesSection(count: number, scratch: string): string {
  const directions = DIRECTIONS.slice(0, count);
  return [
    "",
    "## Divergent candidates (orche creation policy: this round)",
    `This round produces ${count} candidates, not the final deliverable. Make them genuinely different, one per direction:`,
    ...directions.map(item => `- ${item.id}: ${item.name}: ${item.brief}.`),
    "Interpret each direction for this brief. Every candidate must still meet every hard constraint of the request (format, size, count, style rules, names it must contain).",
    `Put each candidate's files only in ${scratch}/<id>/ (e.g. ${scratch}/A/): not at the final location, and change nothing else in the workspace this round. Make each candidate complete enough to judge (a real, inspectable artifact), without final polish.`,
    `Report data.candidates: [{"id":"A","direction":"how you interpreted it","summary":"what it is","outputs":["${scratch}/A/…"],"content":"the text itself, when the deliverable is text"}], one entry per direction (${directions.map(item => item.id).join(", ")}), each with outputs or content. If your role's report also lists outputs, list the candidate files there.`,
    "Next, an independent critic compares the candidates and selects one, and you refine it into the final deliverable in a second round.",
  ].join("\n");
}

export interface Candidate { id: string; direction: string; summary: string; outputs: string[]; content?: string }
const dataOf = (data: unknown): Record<string, unknown> => data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};

export function candidatesOf(data: unknown): Candidate[] {
  const list = dataOf(data).candidates;
  if (!Array.isArray(list)) return [];
  return list.map(dataOf).flatMap((item): Candidate[] => typeof item.id === "string" ? [{
    id: item.id, direction: typeof item.direction === "string" ? item.direction : "", summary: typeof item.summary === "string" ? item.summary : "",
    outputs: Array.isArray(item.outputs) ? item.outputs.filter((path): path is string => typeof path === "string" && !!path.trim()) : [],
    ...(typeof item.content === "string" && item.content.trim() ? { content: item.content } : {}),
  }] : []);
}

/** Validation of the candidate round's report (sent back to the worker to repair). */
export function candidatesError(data: unknown, count: number, scratch: string): string | undefined {
  const candidates = candidatesOf(data);
  const expected = DIRECTIONS.slice(0, count).map(item => item.id);
  const ids = candidates.map(item => item.id);
  const missing = expected.filter(id => !ids.includes(id));
  if (missing.length || ids.length !== expected.length) return `data.candidates must have exactly one entry per direction ${expected.join(", ")}${missing.length ? ` (missing ${missing.join(", ")})` : ""}.`;
  for (const item of candidates) {
    if (!item.outputs.length && !item.content) return `data.candidates ${item.id}: give its outputs (files in ${scratch}/${item.id}/) or its content (text deliverables).`;
    const outside = item.outputs.find(path => !path.replace(/^\.\//, "").startsWith(`${scratch}/`));
    if (outside) return `data.candidates ${item.id}: ${outside} is outside ${scratch}/; candidates live only in the scratch directory this round.`;
  }
  return undefined;
}

/** Blind presentation: neutral labels 1..N in a shuffled order (Fisher-Yates over `random`). `order[label - 1]` is the candidate id. */
export function blindOrder(ids: readonly string[], random: () => number = Math.random): string[] {
  const order = [...ids];
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  return order;
}

const score = (description: string) => Type.Integer({ minimum: 1, maximum: 5, description });
export const selectionSchema = Type.Object({
  candidates: Type.Array(Type.Object({
    label: Type.Integer({ minimum: 1, maximum: 3 }),
    compliance: score("Meets the request's hard constraints and instructions (5: all, 1: misses the point)."),
    quality: score("Craft and execution."),
    fit: score("Fit with the project, its style and its audience."),
    strengths: Type.String({ minLength: 1, maxLength: 500 }),
    weaknesses: Type.String({ minLength: 1, maxLength: 500 }),
  }), { minItems: 1, maxItems: 3 }),
  selected: Type.Integer({ minimum: 1, maximum: 3, description: "The label of the candidate to refine into the deliverable." }),
  rationale: Type.String({ minLength: 1, maxLength: 900 }),
  refinements: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 6, description: "Concrete changes for the selected candidate, most important first; fixes of unmet constraints come first." }),
  borrow: Type.Optional(Type.Array(Type.Object({ from: Type.Integer({ minimum: 1, maximum: 3 }), what: Type.String({ minLength: 1, maxLength: 300 }) }), { maxItems: 3 })),
  acceptable: Type.Boolean({ description: "false when no candidate meets the hard constraints even after refinement." }),
});
export type Selection = Static<typeof selectionSchema>;

export function checkSelection(selection: Selection, count: number): string | undefined {
  const labels = selection.candidates.map(item => item.label);
  const expected = Array.from({ length: count }, (_, index) => index + 1);
  if (labels.length !== count || expected.some(label => !labels.includes(label))) return `Score every candidate exactly once: labels ${expected.join(", ")}.`;
  if (!expected.includes(selection.selected)) return `selected must be one of ${expected.join(", ")}.`;
  const bad = (selection.borrow ?? []).find(item => !expected.includes(item.from) || item.from === selection.selected);
  if (bad) return `borrow.from ${bad.from} must name another candidate's label.`;
  return undefined;
}

export const SELECTOR_INSTRUCTIONS = `You are the Critic of creative candidates you did not make. Compare them against the brief, in this order: the request's hard constraints and instructions, then craft, then fit with the project and its audience. Inspect every candidate yourself: open each output (the read tool shows images) or read its text. Do not prefer a candidate for its position or label. Never make or change artifacts. Score each candidate, select the one to refine into the deliverable, and list the concrete refinements it needs (unmet constraints first), plus what to borrow from another candidate if anything. Finish by calling report_selection exactly once; do not answer in plain text. Write in the language of the request.`;

export interface SelectorInput {
  brief: string;
  original?: string;
  /** Candidates in presentation order (label = index + 1). */
  presented: readonly Candidate[];
}

export function selectorPrompt(input: SelectorInput): string {
  return [
    `Compare these ${input.presented.length} candidates and select one.`,
    "",
    "## The brief (the creation worker's hand-off, verbatim)",
    input.brief.trim(),
    ...(input.original && !input.brief.includes(input.original.trim()) ? ["", "## The user's original request", input.original.trim()] : []),
    "",
    "## Candidates (neutral labels; the order is random)",
    ...input.presented.flatMap((item, index) => [
      `### Candidate ${index + 1}`,
      `Summary: ${item.summary || "(none)"}`,
      ...(item.outputs.length ? [`Files: ${item.outputs.join(", ")}`] : []),
      ...(item.content ? ["Content:", item.content.length > 4_000 ? `${item.content.slice(0, 4_000)}…` : item.content] : []),
    ]),
  ].join("\n");
}

export function refinePrompt(role: string, chosen: Candidate, selection: Selection | undefined, labelOf: (id: string) => number, idOf: (label: number) => string): string {
  if (!selection) {
    return `Assignment: ${role} (refine round). The independent critic could not compare your candidates. Choose the candidate that best meets the brief yourself and refine it into the final deliverable exactly where and in the form the request asks (not in the scratch directory). Keep every hard constraint of the request; leave the other candidates in the scratch directory. Finish with report_result as before (your role's format); its summary replaces your previous one and describes the final deliverable. Add data.selected with the candidate id you refined.`;
  }
  const borrow = (selection.borrow ?? []).map(item => `- from candidate ${idOf(item.from)}: ${item.what}`);
  return [
    `Assignment: ${role} (refine round). An independent critic compared your candidates and selected ${chosen.id} (${chosen.direction || "its direction"}): ${selection.rationale}`,
    ...(selection.acceptable ? [] : ["The critic found that no candidate meets every hard constraint yet: fixing that comes first."]),
    ...(selection.refinements.length ? ["Refinements, most important first:", ...selection.refinements.map(item => `- ${item}`)] : []),
    ...(borrow.length ? ["Borrow:", ...borrow] : []),
    `Turn candidate ${chosen.id} into the final deliverable exactly where and in the form the request asks (not in the scratch directory). Keep every hard constraint of the request; leave the other candidates in the scratch directory and copy nothing else into the workspace. Finish with report_result as before (your role's format); its summary replaces your previous one and describes the final deliverable. Add data.selected: "${chosen.id}".`,
    `(Critic's scores, label ${labelOf(chosen.id)} = ${chosen.id}: ${selection.candidates.map(item => `${idOf(item.label)} ${item.compliance}/${item.quality}/${item.fit}`).join(", ")} for compliance/quality/fit.)`,
  ].join("\n");
}

/** What the creation policy did, for details, records and the yield metrics (docs/workflow-policy.md 4). */
export interface DivergenceOutcome {
  candidates: number;
  scratch: string;
  /** Candidate ids in the order the critic saw them (label = index + 1). */
  order?: string[];
  generated?: Candidate[];
  selection?: Selection;
  /** The candidate id refined into the deliverable (`self` when the critic failed and the worker chose). */
  selected?: string;
  refineRounds: number;
}

/** divergence_yield numerator: the deliverable is not candidate A (the conventional direction). */
export const divergenceYielded = (outcome: DivergenceOutcome): boolean => !!outcome.selected && outcome.selected !== "A" && outcome.selected !== "self";

export function formatDivergence(outcome: DivergenceOutcome): string[] {
  const lines = [`Creation: ${outcome.candidates} divergent candidates in ${outcome.scratch}/ (${(outcome.generated ?? []).map(item => `${item.id} ${item.direction ? item.direction.replace(/\s+/g, " ").slice(0, 60) : ""}`.trim()).join("; ") || "none reported"}).`];
  if (outcome.selection && outcome.order) {
    const idOf = (label: number) => outcome.order![label - 1] ?? `#${label}`;
    lines.push(`Critic selected ${idOf(outcome.selection.selected)}${outcome.selection.acceptable ? "" : " (no candidate met every hard constraint)"}: ${outcome.selection.rationale.replace(/\s+/g, " ").slice(0, 300)}`);
    lines.push(`Scores (compliance/quality/fit): ${outcome.selection.candidates.map(item => `${idOf(item.label)} ${item.compliance}/${item.quality}/${item.fit}`).join(", ")}`);
  } else if (outcome.selected === "self") lines.push("Critic: no selection; the worker chose the candidate itself.");
  if (outcome.refineRounds) lines.push(`Refined ${outcome.selected ?? "?"} into the deliverable (same worker).`);
  return lines;
}
