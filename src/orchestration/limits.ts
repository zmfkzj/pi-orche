/** Time caps are milliseconds; zero is an immediate cap, not unlimited. */
export interface RunLimits {
  overallMs: number;
  explorationMs: number;
  assignmentMs: number;
  decisionMs: number;
  maxFixRounds: number;
  decisionRepairs: number;
  /** Soft model-request budget per worker assignment (0 disables). */
  assignmentRequests: number;
}

export const defaultRunLimits: RunLimits = {
  overallMs: 3_600_000,
  explorationMs: 1_200_000,
  assignmentMs: 3_600_000,
  decisionMs: 1_800_000,
  maxFixRounds: 1,
  decisionRepairs: 2,
  assignmentRequests: 150,
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
