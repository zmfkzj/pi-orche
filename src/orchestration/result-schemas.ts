import { Type } from "@sinclair/typebox";
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
});

/** `data` of a verify RESULT: an explicit boolean verdict is required. */
export const verifyResultSchema = Type.Object({
  passed: Type.Boolean(),
  evidence,
  issues: Type.Optional(Type.Unknown()),
});

/**
 * RESULT `data` contracts per assignment kind, checked inside `report_result` so a
 * malformed payload is repaired in the same turn instead of by a new assignment.
 * Kinds without an entry (e.g. answer) accept any data.
 */
export const orchestrationResultSchemas: Readonly<Record<string, ResultDataSchema>> = {
  explore: { schema: exploreResultSchema, optional: true },
  backlog_proposal: { schema: proposalSchema },
  implement: { schema: implementResultSchema, optional: true },
  fix: { schema: implementResultSchema, optional: true },
  verify: { schema: verifyResultSchema },
};
