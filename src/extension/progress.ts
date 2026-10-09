import { formatExtensionProgress, type DeadlineExtension, type ExtendableDeadline } from "../orchestration/run/extension.js";
import { extensionBudgetMs } from "../orchestration/limits.js";

/**
 * Timing of a running or finished orche_run / orche_task, for the TUI timer (render.ts). UI-only data: it travels in `details`
 * (partial updates and the final result) and never in the text the model reads.
 */
export interface DeadlineInfo {
  /** The base cap (no extensions), ms. */
  baseMs: number;
  /** The overall cap now: the base plus the extensions granted so far, ms. Shown as `/ 30m`. */
  capMs: number;
  /** The overall deadline now (epoch ms): the clock the cap is counted from, plus {@link DeadlineInfo.capMs}. */
  deadlineAt: number;
  /** Length of the latest extension granted (before any: the first one of the schedule), ms. */
  extensionMs: number;
  /** Added per further extension (0 or absent: fixed extensions). */
  extensionStepMs?: number;
  /** Extensions granted so far / allowed (`limits.maxExtensions`; 0 when extending is off). Shown as `ext 1/10`. */
  extensionsUsed: number;
  maxExtensions: number;
  /** The most the call can last: the base plus the whole extension budget (`overallMs + extensionBudgetMs(schedule)`; defaults 30 min + 550 min), ms. */
  hardLimitMs: number;
}

/** `details.startedAt` / `details.finishedAt` / `details.deadline` of every partial update and of the final result. */
export interface RunTiming {
  /** When execution started (epoch ms): the origin of the timer. */
  startedAt: number;
  /** When it ended (epoch ms); only in the final result. The final duration is `finishedAt - startedAt`. */
  finishedAt?: number;
  /** The deadline as it stands; absent when it is not known. */
  deadline?: DeadlineInfo;
}

/** The deadline of a call that has just started: the base cap, no extension granted yet. `startedAt` is the clock the cap is counted from. */
export function initialDeadline(baseMs: number, policy: { extensionMs: number; extensionStepMs?: number; maxExtensions: number }, startedAt: number): DeadlineInfo {
  return {
    baseMs, capMs: baseMs, deadlineAt: startedAt + baseMs, extensionMs: policy.extensionMs, ...(policy.extensionStepMs ? { extensionStepMs: policy.extensionStepMs } : {}),
    extensionsUsed: 0, maxExtensions: policy.maxExtensions, hardLimitMs: baseMs + extensionBudgetMs(policy),
  };
}

/** What {@link extendDeadline} needs of an extension: a `deadline_extended` event (`extension` is `n`, `maxExtensions` is `max`) or a {@link DeadlineExtension}. */
export type ExtensionStep = Pick<DeadlineExtension, "n" | "max" | "extensionMs" | "scope"> & { overallDeadline?: number | undefined };

/**
 * The deadline after an extension. `overallDeadline` (epoch ms, after the extension) gives the new cap exactly: `overallDeadline - startedAt`
 * (`startedAt`: the clock the deadline runs from). Without it (a hand-made event) the overall and assignment deadlines grow by one extension and
 * a phase cap, which does not move the overall deadline, changes nothing.
 */
export function extendDeadline(deadline: DeadlineInfo, extension: ExtensionStep, startedAt: number): DeadlineInfo {
  const deadlineAt = extension.overallDeadline ?? (extension.scope === "phase" ? deadline.deadlineAt : deadline.deadlineAt + extension.extensionMs);
  return {
    ...deadline, deadlineAt, capMs: deadlineAt - startedAt, extensionMs: extension.extensionMs,
    extensionsUsed: extension.n, maxExtensions: extension.max,
  };
}

/** The deadline of a live {@link ExtendableDeadline} (an orche_task assignment's own deadline): its base, cap and extensions as they stand. */
export function deadlineInfoOf(deadline: Pick<ExtendableDeadline, "baseOverallMs" | "overallCapMs" | "overallDeadline" | "extensionMs" | "used" | "maxExtensions" | "hardLimitMs"> & Partial<Pick<ExtendableDeadline, "extensionStepMs" | "extensions">>): DeadlineInfo {
  const latest = deadline.used > 0 ? deadline.extensions?.at(-1)?.extensionMs : undefined;
  return {
    baseMs: deadline.baseOverallMs, capMs: deadline.overallCapMs, deadlineAt: deadline.overallDeadline, extensionMs: latest ?? deadline.extensionMs, ...(deadline.extensionStepMs ? { extensionStepMs: deadline.extensionStepMs } : {}),
    extensionsUsed: deadline.used, maxExtensions: deadline.maxExtensions, hardLimitMs: deadline.hardLimitMs,
  };
}

/** The `startedAt` / `finishedAt` / `deadline` details keys of `timing` (nothing for undefined). */
export function timingDetails(timing: RunTiming | undefined): Partial<RunTiming> {
  return timing ? { startedAt: timing.startedAt, ...(timing.finishedAt !== undefined ? { finishedAt: timing.finishedAt } : {}), ...(timing.deadline ? { deadline: { ...timing.deadline } } : {}) } : {};
}

/**
 * The tool update for the progress `lines` (newest last): the lines as text and as `details.progress`, plus the timing keys when known. The
 * text is what the TUI and RPC clients show while the call runs; the model only ever sees the final result.
 */
export function partialUpdate(lines: readonly string[], timing?: RunTiming): { content: { type: "text"; text: string }[]; details: { progress: readonly string[] } & Partial<RunTiming> } {
  return { content: [{ type: "text", text: lines.join("\n") }], details: { progress: lines, ...timingDetails(timing) } };
}
