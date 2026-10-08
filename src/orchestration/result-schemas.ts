import { Type } from "typebox";
import { Value } from "typebox/value";
import { formatSchemaErrors } from "./schema-errors.js";
import type { ResultDataSchema } from "../agent/agent-handle.js";

/** `data` of a backlog_proposal RESULT. */
export const proposalSchema = Type.Object({
  sourceAgentId: Type.String({ minLength: 1 }),
  items: Type.Array(Type.Object({
    title: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    files: Type.Array(Type.String({ minLength: 1 })),
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    suggestedOwner: Type.Optional(Type.String({ minLength: 1 })),
  })),
});

/** Evidence shape is left to the worker; only the decision-relevant fields are typed. */
const evidence = Type.Optional(Type.Unknown());

export const checklistSchema = Type.Array(Type.Object({
  id: Type.String({ pattern: "^R[1-9][0-9]*$" }),
  status: Type.Union([Type.Literal("met"), Type.Literal("unmet"), Type.Literal("partial")]),
  evidence: Type.String({ minLength: 1 }),
  /** The test or check command that asserts this requirement's acceptance and passed. */
  verifiedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}));
export interface ChecklistItem { id: string; status: "met" | "unmet" | "partial"; evidence: string; verifiedBy?: string }
/** Requirements the worker could read more than one way, with the reading it implemented. */
export const ambiguitiesSchema = Type.Array(Type.Object({
  id: Type.Optional(Type.String({ pattern: "^R[1-9][0-9]*$" })),
  readings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 2, maxItems: 5 }),
  chosen: Type.String({ minLength: 1, maxLength: 500 }),
}), { maxItems: 30 });
export interface Ambiguity { id?: string; readings: string[]; chosen: string }
/** Requirement declarations only; quoted original text and incidental prose are never contracts. */
export function requirementDefinitions(request: string): Map<string, string> {
  const definitions = new Map<string, string>();
  let current: string | undefined;
  for (const line of request.split(/\r?\n/)) {
    if (/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?Original(?:[ \t]+user)?[ \t]+request\b/i.test(line)) break;
    const match = /^[ \t]*(R[1-9]\d*)(?::|[.)]|[ \t]+-)[ \t]*(.*)$/.exec(line);
    if (match) {
      current = match[1]!;
      definitions.set(current, match[2]!.trim());
    } else if (current && /^[ \t]+\S/.test(line)) {
      // Indented acceptance details belong to the preceding requirement for revision detection.
      definitions.set(current, `${definitions.get(current)}\n${line.trim()}`);
    } else current = undefined;
  }
  return definitions;
}
export function requirementIds(request: string): string[] { return [...requirementDefinitions(request).keys()]; }
export function requiredChecklistError(ids: readonly string[], data: unknown, requireVerification = false): string | undefined {
  const checklist = (data as { checklist?: ChecklistItem[] } | undefined)?.checklist;
  if (!Array.isArray(checklist)) return "data.checklist is required: report every requirement id with status met|unmet|partial and evidence.";
  if (!Value.Check(checklistSchema, checklist)) return `Invalid checklist: ${formatSchemaErrors(checklistSchema, checklist)}`;
  const ambiguities = (data as { ambiguities?: unknown } | undefined)?.ambiguities;
  if (ambiguities !== undefined && !Value.Check(ambiguitiesSchema, ambiguities)) return `Invalid ambiguities: ${formatSchemaErrors(ambiguitiesSchema, ambiguities)}`;
  const seen = new Set<string>();
  for (const item of checklist) {
    if (seen.has(item.id)) return `Duplicate checklist id ${item.id}; report each requirement once.`;
    seen.add(item.id);
  }
  const missing = ids.filter(id => !seen.has(id));
  if (missing.length) return `Checklist missing ${missing.join(", ")}; report every requirement with evidence.`;
  if (requireVerification) {
    const unverified = checklist.filter(item => item.status === "met" && !item.verifiedBy?.trim()).map(item => item.id);
    if (unverified.length) return `Checklist items reported met without verifiedBy: ${unverified.join(", ")}. Name the test or check command that asserts each requirement's acceptance and passed, or report the item partial/unmet.`;
  }
  return undefined;
}
/** Findings the worker leaves open on purpose (e.g. after the verification-round cap), one short item each, for main and the user to decide. */
export const unresolvedSchema = Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 30 });
export const answerResultSchema = Type.Object({ evidence, checklist: Type.Optional(checklistSchema), ambiguities: Type.Optional(ambiguitiesSchema), unresolved: Type.Optional(unresolvedSchema) });

/** `data` of an explore RESULT: an optional cause claim with its evidence. */
export const exploreResultSchema = Type.Object({
  cause: Type.Optional(Type.String()),
  evidence,
});

/** `data` of an implement/fix RESULT: anything but "blocked" counts as done. */
export const implementResultSchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("blocked")])),
  reason: Type.Optional(Type.String()),
  evidence,
  checklist: Type.Optional(checklistSchema),
  ambiguities: Type.Optional(ambiguitiesSchema),
  unresolved: Type.Optional(unresolvedSchema),
});

/** Production reports require a verdict and an inventory of delivered outputs. */
export const gameAssetResultSchema = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("blocked")]),
  reason: Type.Optional(Type.String()),
  outputs: Type.Array(Type.Object({
    path: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    spec: Type.String({ minLength: 1 }),
  })),
  evidence,
});
export const videoResultSchema = gameAssetResultSchema;

/** `data` of a verify RESULT: an explicit boolean verdict is required. */
export const verifyResultSchema = Type.Object({
  passed: Type.Boolean(),
  evidence,
  issues: Type.Optional(Type.Unknown()),
});

/**
 * RESULT `data` contracts per assignment kind, checked inside `report_result` so a
 * malformed payload is repaired in the same turn instead of by a new assignment.
 * Kinds without an entry accept any data.
 */
export const orchestrationResultSchemas: Readonly<Record<string, ResultDataSchema>> = {
  explore: { schema: exploreResultSchema, optional: true },
  answer: { schema: answerResultSchema, optional: true },
  backlog_proposal: { schema: proposalSchema },
  implement: { schema: implementResultSchema, optional: true },
  fix: { schema: implementResultSchema, optional: true },
  "game-asset": { schema: gameAssetResultSchema },
  video: { schema: videoResultSchema },
  verify: { schema: verifyResultSchema },
};
