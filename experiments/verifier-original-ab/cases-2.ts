/**
 * Study 2's cases (PREREGISTRATION-2.md): the scenarios of cases-2a.ts and cases-2b.ts, written by two fresh sessions without
 * access to study-1 results. Ids and scenario names are prefixed "s2-" so that the pooled analysis can tell the studies apart.
 */
import { casesOf, type Case } from "./cases.js";
import { SCENARIOS_2A, TYPES_2A } from "./cases-2a.js";
import { SCENARIOS_2B, TYPES_2B } from "./cases-2b.js";

export const SCENARIOS_2 = [...SCENARIOS_2A, ...SCENARIOS_2B];
export const CASES_2: readonly Case[] = SCENARIOS_2.flatMap(casesOf).map(item => ({ ...item, id: `s2-${item.id}`, scenario: `s2-${item.scenario}` }));
/** Violation type of each study-2 scenario with a violating variant (keyed by its s2- scenario name). */
export const VIOLATION_TYPES_2: Record<string, "regression" | "new-code"> = Object.fromEntries(Object.entries({ ...TYPES_2A, ...TYPES_2B }).map(([id, type]) => [`s2-${id}`, type]));
