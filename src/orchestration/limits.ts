import { DEFAULT_LIVENESS_WINDOW_MS } from "../agent/liveness.js";

/**
 * Time caps are milliseconds; zero is an immediate cap, not unlimited. `overallMs` is the BASE cap: while a run (or an orche_task
 * assignment) is still actively working when a deadline expires, it is extended by `extensionMs`, at most `maxExtensions` times in
 * total (see src/orchestration/run/extension.ts), so the hard ceiling is `overallMs + maxExtensions * extensionMs`.
 */
export interface RunLimits {
  overallMs: number;
  explorationMs: number;
  assignmentMs: number;
  decisionMs: number;
  maxFixRounds: number;
  decisionRepairs: number;
  /** Soft model-request budget per worker assignment (0 disables). */
  assignmentRequests: number;
  /** How far an expired deadline is pushed out when the run is still active. */
  extensionMs: number;
  /** Extensions allowed per run / per task assignment, shared by every deadline of it (a non-negative integer; 0 disables extending). */
  maxExtensions: number;
  /** "Still active" means: some model output, tool event or progressing command within this window before the deadline. */
  activityWindowMs: number;
}

/** The derived phase caps are computed from the base overall cap as in {@link resolveRunLimits}: exploration = overall / 3, assignment = overall, decision = overall / 2. */
export const defaultRunLimits: RunLimits = {
  overallMs: 1_800_000,
  explorationMs: 600_000,
  assignmentMs: 1_800_000,
  decisionMs: 900_000,
  maxFixRounds: 1,
  decisionRepairs: 2,
  assignmentRequests: 150,
  extensionMs: 1_800_000,
  maxExtensions: 3,
  activityWindowMs: DEFAULT_LIVENESS_WINDOW_MS,
};

export class RunLimitsError extends Error {
  override readonly name = "RunLimitsError";
}

/** Validate explicit values without filling defaults (which would hide derived caps). */
export function parseRunLimits(value: unknown, location = "limits"): Partial<RunLimits> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RunLimitsError(`${location}: expected object`);
  const limits: Partial<RunLimits> = {};
  for (const [key, number] of Object.entries(value)) {
    if (!Object.hasOwn(defaultRunLimits, key)) throw new RunLimitsError(`${location}.${key}: unknown limit`);
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
      throw new RunLimitsError(`${location}.${key}: expected a finite non-negative number`);
    if ((key === "maxFixRounds" || key === "decisionRepairs") && !Number.isInteger(number))
      throw new RunLimitsError(`${location}.${key}: expected a non-negative integer`);
    if (key === "decisionRepairs" && number > 2)
      throw new RunLimitsError(`${location}.${key}: expected an integer 0-2`);
    if (key === "assignmentRequests" && !Number.isSafeInteger(number))
      throw new RunLimitsError(`${location}.${key}: expected a non-negative safe integer (0 disables)`);
    if (key === "maxExtensions" && !Number.isSafeInteger(number))
      throw new RunLimitsError(`${location}.${key}: expected a non-negative integer (0 disables extensions)`);
    limits[key as keyof RunLimits] = number;
  }
  return limits;
}

/** Defaults < config < API; derive only missing phase caps after merging explicit values. */
export function resolveRunLimits(config?: Partial<RunLimits>, overrides?: Partial<RunLimits>): RunLimits {
  const explicit = {
    ...(config === undefined ? {} : parseRunLimits(config, "config.limits")),
    ...(overrides === undefined ? {} : parseRunLimits(overrides, "options.limits")),
  };
  const overallMs = explicit.overallMs ?? defaultRunLimits.overallMs;
  return {
    ...defaultRunLimits,
    ...explicit,
    overallMs,
    explorationMs: explicit.explorationMs ?? overallMs / 3,
    assignmentMs: explicit.assignmentMs ?? overallMs,
    decisionMs: explicit.decisionMs ?? overallMs / 2,
  };
}
