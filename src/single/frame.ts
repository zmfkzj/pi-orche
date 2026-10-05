/**
 * The Framer (docs/specialist-orchestration.md 5.1; the research's Issue Analyzer): a one-shot read-only session that turns the
 * main session's request into the implementer's contract before the Primary starts: testable requirements (including the edge
 * cases the tests must cover), ambiguous wording with its readings and the recommended one, invariants and where to look. It never
 * proposes a solution. The rendered contract goes first in the Primary's hand-off, so its `R…:` lines are the requirement ids the
 * checklist reports on, and it survives compaction with the hand-off.
 */
import { Type, type Static } from "@sinclair/typebox";
import { requirementIds } from "../orchestration/result-schemas.js";

const text = (max: number) => Type.String({ minLength: 1, maxLength: max });
export const FRAME_LIMITS = { requirements: 24, ambiguities: 6, invariants: 8, locations: 12, renderedChars: 8_000 } as const;
export const frameSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 600, description: "What the change must achieve, in one or two sentences." }),
  requirements: Type.Array(Type.Object({
    id: Type.String({ pattern: "^R[1-9][0-9]*$" }),
    kind: Type.Union([Type.Literal("explicit"), Type.Literal("implied"), Type.Literal("edge")], { description: "explicit: stated in the request; implied: follows necessarily from it or from the code (e.g. existing tests keep passing); edge: a boundary case the tests must cover." }),
    text: text(600),
    acceptance: Type.String({ minLength: 1, maxLength: 600, description: "How a test or command shows it holds; for edge: input → expected result." }),
    quote: Type.Optional(Type.String({ maxLength: 400, description: "The request's own words this comes from (explicit requirements)." })),
  }), { minItems: 1, maxItems: FRAME_LIMITS.requirements }),
  ambiguities: Type.Array(Type.Object({
    id: Type.String({ pattern: "^A[1-9][0-9]*$" }),
    quote: Type.String({ minLength: 1, maxLength: 400, description: "The ambiguous words of the request, verbatim." }),
    readings: Type.Array(text(400), { minItems: 2, maxItems: 4 }),
    observableDifference: Type.String({ minLength: 1, maxLength: 500, description: "A concrete input or scenario where the readings give different results." }),
    recommended: Type.Integer({ minimum: 1, maximum: 4, description: "1-based index of the reading to implement." }),
    why: Type.String({ minLength: 1, maxLength: 500, description: "Why that reading: the request's wording first, then the existing code, tests and docs." }),
    askUser: Type.Boolean({ description: "true only for a product decision that neither the wording nor the code settles." }),
    affects: Type.Optional(Type.Array(Type.String({ pattern: "^R[1-9][0-9]*$" }), { maxItems: 24 })),
  }), { maxItems: FRAME_LIMITS.ambiguities }),
  invariants: Type.Array(text(300), { maxItems: FRAME_LIMITS.invariants, description: "Behaviour and interfaces that must not change." }),
  locations: Type.Optional(Type.Array(Type.Object({ path: text(300), why: text(300) }), { maxItems: FRAME_LIMITS.locations, description: "Files (path or path:line) the implementer will need, and why." })),
});
export type Frame = Static<typeof frameSchema>;

export const FRAMER_INSTRUCTIONS = `You are the Framer of a coding task. You do not implement it and never modify files: you turn the request into a precise, testable contract for the engineer who will. Read the repository with the read-only tools only as far as needed to ground the contract in the code (current behaviour, interfaces, existing tests and docs), then stop. Separate facts (path:line, quoted words) from judgement. Never write a solution, a design or code. Finish by calling report_frame exactly once; do not answer in plain text. Write in the language of the request.`;

export interface FramerInput {
  /** The main session's request (with its Original request section) and context, verbatim. */
  request: string;
  /** Present for a follow-up of an earlier assignment of the same task: that assignment's rendered contract and outcome. */
  previous?: { contract: string; outcome?: string };
  grounded: boolean;
}

export function framerPrompt(input: FramerInput): string {
  const ids = requirementIds(input.request);
  return [
    "Frame this request for the engineer who will implement it.",
    "",
    "## Request from the main session (verbatim)",
    input.request.trim(),
    ...(input.previous ? ["", "## Earlier assignment of this task (its contract and outcome)", input.previous.contract.trim(), ...(input.previous.outcome ? [`Outcome: ${input.previous.outcome}`] : []),
      "This request continues that task: write the complete contract for this round. Carry over the earlier requirements that still apply with their ids, revise those the new request changes, add new ones after the highest id, and drop the ones that no longer apply."] : []),
    "",
    "## report_frame",
    `- requirements: every explicit requirement (kind "explicit", with the request's words in quote), what follows necessarily from the request or the code (kind "implied", e.g. existing tests keep passing, exported interfaces keep their shape), and the boundary cases the tests must cover (kind "edge": empty, single, equal or duplicate keys, ordering ties, concurrency, failure then retry, limits; acceptance = input → expected result). Each acceptance must be checkable by a test or a command. At most ${FRAME_LIMITS.requirements}; prefer fewer, sharper ones.${ids.length ? ` Keep the request's own ids ${ids.join(", ")} with the same meaning; number new ones after them.` : " Number them R1, R2, … in order."}`,
    `- ambiguities: wording a careful engineer could implement in observably different ways. Quote it, give the readings, a concrete input where they differ, the reading to implement and why (the request's literal wording first, then the existing code, tests and docs), and askUser true only when it is a product decision the wording and code cannot settle. Write the requirements according to the recommended reading and list them in affects. Only real ambiguities; none is fine. At most ${FRAME_LIMITS.ambiguities}.`,
    `- invariants: behaviour and interfaces that must not change (at most ${FRAME_LIMITS.invariants}).`,
    input.grounded ? "- locations: the files (path or path:line) the implementer will need, and why." : "- locations: omit (you have no repository access).",
  ].join("\n");
}

/** Semantic checks the schema cannot express; a string is sent back to the Framer to fix. */
export function checkFrame(frame: Frame, request: string): string | undefined {
  const ids = frame.requirements.map(item => item.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) return `Duplicate requirement id ${duplicate}.`;
  const missing = requirementIds(request).filter(id => !ids.includes(id));
  if (missing.length) return `The request defines ${missing.join(", ")}; keep each of them as a requirement with the same id.`;
  const ambiguityIds = frame.ambiguities.map(item => item.id);
  const repeated = ambiguityIds.find((id, index) => ambiguityIds.indexOf(id) !== index);
  if (repeated) return `Duplicate ambiguity id ${repeated}.`;
  for (const item of frame.ambiguities) {
    if (item.recommended > item.readings.length) return `${item.id}: recommended ${item.recommended} but only ${item.readings.length} readings.`;
    const unknown = (item.affects ?? []).filter(id => !ids.includes(id));
    if (unknown.length) return `${item.id}: affects unknown requirement ids ${unknown.join(", ")}.`;
  }
  return undefined;
}

const oneLine = (value: string, max = 600): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export const CONTRACT_HEADER = "## Task contract (from orche's Framer; the requirement ids below are what your checklist reports on)";

/**
 * The contract as the first section of the Primary's hand-off. Requirement lines are `R…: [kind] text` with the acceptance on an
 * indented line, the format `requirementDefinitions` reads (an indented line belongs to the requirement above it).
 */
export function renderContract(frame: Frame, options: { maxChars?: number } = {}): string {
  const reading = (item: Frame["ambiguities"][number]) => item.readings[item.recommended - 1] ?? item.readings[0]!;
  const lines = [
    CONTRACT_HEADER,
    `Goal: ${oneLine(frame.goal)}`,
    "Requirements (report every id in data.checklist; a met item needs verifiedBy: a test or check that asserts its acceptance and passed):",
    ...frame.requirements.flatMap(item => [`${item.id}: [${item.kind}] ${oneLine(item.text)}`, `  Acceptance: ${oneLine(item.acceptance)}`]),
    ...(frame.ambiguities.length ? [
      "Ambiguous wording, settled (implement the chosen reading; if the code or tests prove it wrong, implement the request's evident intent and report it in data.ambiguities):",
      ...frame.ambiguities.map(item => `- ${item.id} "${oneLine(item.quote, 200)}": chosen "${oneLine(reading(item), 300)}" over ${item.readings.filter((_, index) => index !== item.recommended - 1).map(other => `"${oneLine(other, 200)}"`).join(", ")}. Differs when: ${oneLine(item.observableDifference, 300)}. Why: ${oneLine(item.why, 300)}${item.affects?.length ? ` (${item.affects.join(", ")})` : ""}`),
    ] : []),
    ...(frame.invariants.length ? ["Invariants (must not change):", ...frame.invariants.map(item => `- ${oneLine(item, 300)}`)] : []),
    ...(frame.locations?.length ? ["Where to look:", ...frame.locations.map(item => `- ${oneLine(item.path, 200)}: ${oneLine(item.why, 200)}`)] : []),
  ];
  const max = options.maxChars ?? FRAME_LIMITS.renderedChars;
  let rendered = lines.join("\n");
  // Locations, then invariants go first when the contract is too long; requirements and readings are the contract.
  if (rendered.length > max && frame.locations?.length) return renderContract({ ...frame, locations: frame.locations.slice(0, -1) }, options);
  if (rendered.length > max && frame.invariants.length) return renderContract({ ...frame, invariants: frame.invariants.slice(0, -1) }, options);
  if (rendered.length > max) rendered = `${rendered.slice(0, max - 1)}…`;
  return rendered;
}

/** The hand-off the Primary gets: the contract first, then the main session's request verbatim. */
export function framedRequest(contract: string, request: string): string {
  return `${contract}\n\n## Request from the main session (verbatim)\n${request}`;
}

/** One line for the main session's result: what the Framer settled. */
export function formatFrame(frame: Frame): string[] {
  const kinds = (["explicit", "implied", "edge"] as const).map(kind => [kind, frame.requirements.filter(item => item.kind === kind).length] as const).filter(([, count]) => count > 0);
  const lines = [`Frame: ${frame.requirements.length} requirements (${kinds.map(([kind, count]) => `${count} ${kind}`).join(", ")})${frame.ambiguities.length ? `, ${frame.ambiguities.length} ambiguit${frame.ambiguities.length === 1 ? "y" : "ies"} settled by the recommended reading` : ", no ambiguities"}.`];
  for (const item of frame.ambiguities) {
    const chosen = item.readings[item.recommended - 1] ?? item.readings[0]!;
    lines.push(`- ${item.id} "${oneLine(item.quote, 160)}": chose "${oneLine(chosen, 200)}" over ${item.readings.filter(other => other !== chosen).map(other => `"${oneLine(other, 160)}"`).join(", ")}${item.askUser ? " — needs the user's decision" : ""}`);
  }
  return lines;
}
