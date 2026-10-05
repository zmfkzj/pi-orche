/**
 * Investigation policy (docs/workflow-policy.md): the answer worker (Primary) answers; a one-shot Critic that did not write the answer
 * looks only for what would change its conclusion (counter-evidence, unsupported claims, logical gaps, an equally good alternative,
 * overclaimed certainty) and never writes a new answer. Material findings go back to the same worker, which accepts or rebuts each
 * one and reports the complete final answer (synthesis). The gate is deterministic: an explicit review/critique request in the user's
 * words, or the Primary's own report of open competing hypotheses or of uncertainty that could change its conclusion.
 */
import { Type, type Static } from "@sinclair/typebox";
import { asksForReview } from "../single/risk.js";

export const CRITIQUE_LIMITS = { findings: 6 } as const;
const text = (max: number) => Type.String({ minLength: 1, maxLength: max });

export const critiqueSchema = Type.Object({
  verdict: Type.Union([Type.Literal("sound"), Type.Literal("revise")], { description: "revise exactly when a finding is material." }),
  findings: Type.Array(Type.Object({
    id: Type.String({ pattern: "^C[1-9][0-9]*$" }),
    kind: Type.Union([
      Type.Literal("counterevidence"), Type.Literal("unsupported"), Type.Literal("logical_gap"),
      Type.Literal("alternative"), Type.Literal("overclaim"), Type.Literal("missed_question"),
    ], { description: "counterevidence: the sources contradict a claim; unsupported: a claim without evidence; logical_gap: the conclusion does not follow; alternative: another explanation fits the evidence as well; overclaim: certainty the evidence does not give; missed_question: part of the question is unanswered." }),
    severity: Type.Union([Type.Literal("material"), Type.Literal("minor")], { description: "material: would change the conclusion or a recommendation if true." }),
    target: Type.String({ minLength: 1, maxLength: 400, description: "The answer's claim this is about, quoted or closely paraphrased." }),
    issue: text(700),
    evidence: Type.String({ minLength: 1, maxLength: 900, description: "What shows it: path:line references you read, or the exact words of the question or answer in quotes." }),
  }), { maxItems: CRITIQUE_LIMITS.findings }),
});
export type Critique = Static<typeof critiqueSchema>;
export type CritiqueFinding = Critique["findings"][number];

const LOCATED = /[\w./-]+\.[A-Za-z0-9]+:\d+|[\w./-]+:\d+(?:-\d+)?|["“„'‘][^"”'’]{3,}["”'’]/;
export function checkCritique(critique: Critique): string | undefined {
  const ids = critique.findings.map(item => item.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) return `Duplicate finding id ${duplicate}.`;
  for (const item of critique.findings) {
    if (item.severity === "material" && !LOCATED.test(item.evidence)) return `${item.id}: a material finding needs located evidence (path:line you read, or quoted words of the question or answer); otherwise make it minor.`;
  }
  const material = critique.findings.some(item => item.severity === "material");
  if (material !== (critique.verdict === "revise")) return material ? "verdict must be revise when a finding is material." : "verdict must be sound when no finding is material.";
  return undefined;
}

export const CRITIC_INSTRUCTIONS = `You are the Critic of an answer you did not write. Find only what would change its conclusion or a recommendation: counter-evidence in the sources, claims without evidence, conclusions that do not follow, an alternative explanation the evidence fits as well, certainty the evidence does not give, a part of the question left unanswered. Check the answer's cited evidence yourself with the read-only tools, and look where it did not. Never write a new answer, never restate what is right, no style or wording remarks. A finding is material only when it would change the conclusion or a recommendation and you show it with located evidence (path:line you read, or the question's or answer's exact words in quotes); everything else is minor or left out. No findings is a fine result. At most six findings. Finish by calling report_critique exactly once; do not answer in plain text. Write in the language of the question.`;

export interface CriticInput {
  /** The user's original request, verbatim (when the hand-off has one). */
  original?: string;
  /** The hand-off the Primary got. */
  question: string;
  /** The Primary's answer (its report summary) and the evidence it listed. */
  answer: string;
  evidence?: unknown;
  /** Why the critic runs (`explicit review request`, `2 open hypotheses`, ...). */
  trigger: string;
}

export function criticPrompt(input: CriticInput): string {
  const evidence = input.evidence === undefined ? "" : typeof input.evidence === "string" ? input.evidence : JSON.stringify(input.evidence, null, 1);
  return [
    "Critique this answer.",
    "",
    "## The question (the answering worker's hand-off, verbatim)",
    input.question.trim(),
    ...(input.original && !input.question.includes(input.original.trim()) ? ["", "## The user's original request", input.original.trim()] : []),
    "",
    "## The answer under review",
    input.answer.trim(),
    ...(evidence.trim() ? ["", "## Evidence the answer lists", evidence.length > 6_000 ? `${evidence.slice(0, 6_000)}…` : evidence] : []),
    "",
    `Why you were called: ${input.trigger}.`,
    "Read the cited evidence first, then search for what would contradict the conclusion.",
  ].join("\n");
}

const CRITIQUE_REQUEST = /\b(critique|critici[sz]e|counter-?argument|devil'?s advocate|stress[- ]test|poke holes|sanity[- ]check|second opinion)\b|반론|반례|비판|허점|반박|다른\s*관점/i;
/** An explicit request for a review, verification or critique in the user's words. */
export const asksForCritique = (text: string | undefined): boolean => !!text && (asksForReview(text) || CRITIQUE_REQUEST.test(text));

const dataOf = (data: unknown): Record<string, unknown> => data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};

/** The Primary's open competing hypotheses and stated uncertainties (critic gate `auto` reads them). */
export function uncertaintyOf(data: unknown): { openHypotheses: number; uncertainties: number; lowConfidence: boolean } {
  const fields = dataOf(data);
  const hypotheses = Array.isArray(fields.hypotheses) ? fields.hypotheses.map(dataOf) : [];
  const open = hypotheses.filter(item => item.status !== "rejected" && item.status !== "refuted").length;
  const uncertainties = Array.isArray(fields.uncertainties) ? fields.uncertainties.filter(item => typeof item === "string" ? item.trim() : !!item).length : 0;
  return { openHypotheses: open >= 2 ? open : 0, uncertainties, lowConfidence: fields.confidence === "low" };
}

export interface CriticTrigger { run: boolean; reason: string }
/** Whether the critic runs for this answer. `always`: every answer; `auto`: explicit request, ≥2 open hypotheses, uncertainty, low confidence. */
export function criticTrigger(gate: "off" | "auto" | "always" | "review" | undefined, original: string | undefined, data: unknown): CriticTrigger {
  if (!gate || gate === "off") return { run: false, reason: "gate off" };
  if (gate === "always") return { run: true, reason: "gate always" };
  if (asksForCritique(original)) return { run: true, reason: "explicit review request" };
  if (gate === "review") return { run: false, reason: "no review requested" };
  const found = uncertaintyOf(data);
  const reasons = [
    ...(found.openHypotheses ? [`${found.openHypotheses} open hypotheses`] : []),
    ...(found.uncertainties ? [`${found.uncertainties} stated uncertainties`] : []),
    ...(found.lowConfidence ? ["low confidence"] : []),
  ];
  return reasons.length ? { run: true, reason: reasons.join(", ") } : { run: false, reason: "no open hypotheses or uncertainty reported" };
}

/** Added to the answer instructions while the critic gate is `auto`/`always`: what the gate reads. */
export const ANSWER_UNCERTAINTY_INSTRUCTIONS = "When competing explanations remain plausible after your investigation, list them in data.hypotheses as [{statement, status: \"supported\" or \"open\" or \"rejected\", evidence}]; list open questions that could still change your conclusion in data.uncertainties (strings); set data.confidence to \"high\", \"medium\" or \"low\". Omit hypotheses and uncertainties when there are none.";

export function synthesisPrompt(critique: Critique): string {
  const material = critique.findings.filter(item => item.severity === "material");
  const minor = critique.findings.filter(item => item.severity === "minor");
  return [
    "Assignment: answer (synthesis round). An independent Critic reviewed your answer and reports findings that would change its conclusion if they hold. Check each material finding yourself against the sources: accept it and revise the answer, or rebut it with evidence. Use your judgment on the minor ones.",
    ...material.map(item => `- ${item.id} (${item.kind}) on "${item.target}": ${item.issue}\n  Evidence: ${item.evidence}`),
    ...(minor.length ? ["Minor:", ...minor.map(item => `- ${item.id} (${item.kind}) on "${item.target}": ${item.issue}`)] : []),
    `Finish with report_result again, following the earlier instructions (including the checklist when the request has R-ids). Its summary replaces your previous answer: give the complete final answer, not only the changes. Add data.critique: [{"id":"C1","response":"accepted" or "rebutted" or "partly","reason":"…"}] for every material finding (${material.map(item => item.id).join(", ")}), and data.conclusionChanged: true when your main conclusion or a recommendation changed, false otherwise.`,
  ].join("\n");
}

export interface CritiqueResponse { id: string; response: "accepted" | "rebutted" | "partly"; reason: string }
/** Validation of the synthesis report (sent back to the worker to repair). */
export function synthesisError(critique: Critique, data: unknown): string | undefined {
  const fields = dataOf(data);
  const ids = critique.findings.filter(item => item.severity === "material").map(item => item.id);
  const responses = Array.isArray(fields.critique) ? fields.critique.map(dataOf) : undefined;
  if (!responses) return `data.critique is required: one {id, response: "accepted"|"rebutted"|"partly", reason} for each of ${ids.join(", ")}.`;
  for (const id of ids) {
    const entry = responses.find(item => item.id === id);
    if (!entry) return `data.critique misses ${id}; answer every material finding.`;
    if (!["accepted", "rebutted", "partly"].includes(entry.response as string)) return `data.critique ${id}: response must be "accepted", "rebutted" or "partly".`;
    if (typeof entry.reason !== "string" || !entry.reason.trim()) return `data.critique ${id}: give the reason (the evidence you checked).`;
  }
  if (typeof fields.conclusionChanged !== "boolean") return "data.conclusionChanged is required: true when your main conclusion or a recommendation changed.";
  return undefined;
}
export function responsesOf(data: unknown): { responses: CritiqueResponse[]; conclusionChanged?: boolean } {
  const fields = dataOf(data);
  const responses = (Array.isArray(fields.critique) ? fields.critique.map(dataOf) : []).flatMap((item): CritiqueResponse[] =>
    typeof item.id === "string" && ["accepted", "rebutted", "partly"].includes(item.response as string)
      ? [{ id: item.id, response: item.response as CritiqueResponse["response"], reason: typeof item.reason === "string" ? item.reason.trim().slice(0, 400) : "" }] : []);
  return { responses, ...(typeof fields.conclusionChanged === "boolean" ? { conclusionChanged: fields.conclusionChanged } : {}) };
}

/** What the investigation policy did, for details, records and the yield metrics (docs/workflow-policy.md 4). */
export interface CritiqueOutcome {
  trigger: CriticTrigger;
  critique?: Critique;
  /** The Primary's responses to the material findings (synthesis round). */
  responses?: CritiqueResponse[];
  conclusionChanged?: boolean;
  synthesisRounds: number;
}

/** critic_yield numerator: a material finding the Primary accepted (fully or partly). */
export const critiqueYielded = (outcome: CritiqueOutcome): boolean => !!outcome.responses?.some(item => item.response !== "rebutted");

export function formatCritique(outcome: CritiqueOutcome): string[] {
  if (!outcome.trigger.run) return [`Critic: not run (${outcome.trigger.reason}).`];
  if (!outcome.critique) return [`Critic: called (${outcome.trigger.reason}) but produced no critique.`];
  const material = outcome.critique.findings.filter(item => item.severity === "material");
  const minor = outcome.critique.findings.length - material.length;
  const lines = [`Critic (${outcome.trigger.reason}): ${outcome.critique.verdict}${material.length ? `, ${material.length} material` : ""}${minor ? `, ${minor} minor` : ""}${outcome.synthesisRounds ? `; synthesis round: conclusion ${outcome.conclusionChanged ? "changed" : "unchanged"}` : ""}.`];
  for (const item of outcome.critique.findings) {
    const response = outcome.responses?.find(entry => entry.id === item.id);
    lines.push(`- ${item.id} ${item.severity} (${item.kind}): ${item.issue.replace(/\s+/g, " ").slice(0, 240)}${response ? ` → ${response.response}${response.reason ? `: ${response.reason.replace(/\s+/g, " ").slice(0, 200)}` : ""}` : ""}`);
  }
  return lines;
}
