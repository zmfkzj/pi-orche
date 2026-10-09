import { DEFAULT_LIVENESS_WINDOW_MS, formatDuration } from "../agent/liveness.js";

/**
 * Time caps are milliseconds; zero is an immediate cap, not unlimited. `overallMs` is the BASE cap: while a run (or an orche_task
 * assignment) is still actively working when a deadline expires, it is extended, at most `maxExtensions` times in total (see
 * src/orchestration/run/extension.ts). Extension n (1-based) adds `extensionMs + (n - 1) × extensionStepMs`: with the defaults
 * (10 min first, 10 min more each round) the extensions are 10, 20, … 100 minutes, so the hard ceiling is
 * 30 min + (10 + 20 + … + 100) min = 30 min + 550 min = 9 h 40 min ({@link extensionBudgetMs}).
 *
 * Compatibility: a configuration that sets `extensionMs` but not `extensionStepMs` keeps its old meaning, a FIXED extension of
 * `extensionMs` every round (`extensionStepMs` resolves to 0). Only an omitted `extensionMs` takes the linear defaults. All keys can
 * be set in the `limits` object of `orche.config.json` (user: `<agentDir>/orche.config.json`, project: `.pi/orche.config.json`).
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
  /** Length of the FIRST extension of an expired deadline when the run is still active (default 10 minutes). */
  extensionMs: number;
  /** Added to every further extension: extension n is `extensionMs + (n - 1) × extensionStepMs` (default 10 minutes; 0 = fixed). Resolves to 0 when only `extensionMs` is configured. */
  extensionStepMs: number;
  /** Extensions allowed per run / per task assignment, shared by every deadline of it (a non-negative integer; default 10; 0 disables extending). */
  maxExtensions: number;
  /** "Still active" means: some model output, tool event or progressing command within this window before the deadline. */
  activityWindowMs: number;
  /**
   * How often a running orche_task assignment is observed (liveness and recorded progress), independent of the extension
   * lengths (default 5 minutes; 0 turns the observer off). See `waitExtendable` in src/orchestration/run/extension.ts.
   */
  observeMs: number;
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
  extensionMs: 600_000,
  extensionStepMs: 600_000,
  maxExtensions: 10,
  activityWindowMs: DEFAULT_LIVENESS_WINDOW_MS,
  observeMs: 300_000,
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
  // A configured extensionMs without a step keeps its earlier meaning: a fixed extension every round.
  const extensionStepMs = explicit.extensionStepMs ?? (explicit.extensionMs !== undefined ? 0 : defaultRunLimits.extensionStepMs);
  return {
    ...defaultRunLimits,
    ...explicit,
    overallMs,
    extensionStepMs,
    explorationMs: explicit.explorationMs ?? overallMs / 3,
    assignmentMs: explicit.assignmentMs ?? overallMs,
    decisionMs: explicit.decisionMs ?? overallMs / 2,
  };
}

/** The extension schedule of a deadline: the first extension, the step added per round, and how many rounds. */
export interface ExtensionSchedule {
  extensionMs: number;
  /** Absent or 0: every extension is `extensionMs` (fixed). */
  extensionStepMs?: number;
  maxExtensions: number;
}

const stepOf = (schedule: Pick<ExtensionSchedule, "extensionStepMs">): number => typeof schedule.extensionStepMs === "number" && Number.isFinite(schedule.extensionStepMs) && schedule.extensionStepMs > 0 ? schedule.extensionStepMs : 0;

/** Whether extending can happen at all: at least one extension, and a first extension longer than zero. */
export function extensionsEnabled(schedule: ExtensionSchedule): boolean {
  return schedule.maxExtensions > 0 && schedule.extensionMs > 0;
}

/** Length of extension `n` (1-based): `extensionMs + (n - 1) × extensionStepMs`. */
export function extensionLengthMs(schedule: Pick<ExtensionSchedule, "extensionMs" | "extensionStepMs">, n: number): number {
  return schedule.extensionMs + Math.max(0, n - 1) * stepOf(schedule);
}

/** Total of the first `count` extensions (default: the whole budget); 0 when extending is disabled. Defaults: 10 + 20 + … + 100 min = 550 min. */
export function extensionBudgetMs(schedule: ExtensionSchedule, count: number = schedule.maxExtensions): number {
  if (!extensionsEnabled(schedule)) return 0;
  const rounds = Math.max(0, Math.min(count, schedule.maxExtensions));
  return rounds * schedule.extensionMs + stepOf(schedule) * rounds * (rounds - 1) / 2;
}

/** `+30m each` (fixed) or `+10m, +20m … +1h40m` (linear); empty when extending is disabled. */
export function describeExtensionSchedule(schedule: ExtensionSchedule): string {
  if (!extensionsEnabled(schedule)) return "";
  if (!stepOf(schedule) || schedule.maxExtensions === 1) return `+${formatDuration(schedule.extensionMs)} each`;
  const last = formatDuration(extensionLengthMs(schedule, schedule.maxExtensions));
  if (schedule.maxExtensions === 2) return `+${formatDuration(schedule.extensionMs)}, +${last}`;
  return `+${formatDuration(schedule.extensionMs)}, +${formatDuration(extensionLengthMs(schedule, 2))} … +${last}`;
}
