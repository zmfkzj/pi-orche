import type { MainMode } from "../orchestration/routing.js";

/**
 * Advisory for the main session when its context crosses a threshold, in every mode. Direct: the remaining large work can move to
 * `/orche mode single`, where a worker carries the context and the main keeps only the results. Delegating modes (single, strong,
 * ultra): every main request re-sends the whole conversation, so a long session makes main's turns slower and its long responses
 * closer to provider time limits (a 1M-window main at ~59% ran 15-minute responses that were cut off); the remedy is /compact or a
 * new session, both the user's choice: nothing is compacted or deleted here. One warning state for all modes: a level warned in
 * one mode is not repeated after a mode switch; it re-arms when usage drops {@link REARM_MARGIN} points below the lowest threshold.
 */
export interface ContextWarningSettings {
  enabled: boolean;
  /** Ascending percentages of the context window, each warned once until usage drops back below the lowest. */
  thresholds: number[];
}
export const DEFAULT_CONTEXT_WARNING: Readonly<ContextWarningSettings> = { enabled: true, thresholds: [50, 75] };
/** Usage this many points below the lowest threshold (after a compaction or a new session) re-arms the warnings. */
export const REARM_MARGIN = 10;

export interface ContextUsageLike { tokens: number | null; contextWindow: number; percent: number | null }
export interface ContextWarningState { warnedLevel: number }

export function contextWarning(
  mode: MainMode,
  usage: ContextUsageLike | undefined,
  settings: ContextWarningSettings,
  state: ContextWarningState,
): { state: ContextWarningState; message?: string } {
  if (!settings.enabled || !usage || usage.percent === null || !settings.thresholds.length) return { state };
  const percent = usage.percent;
  const lowest = settings.thresholds[0]!;
  if (percent < lowest - REARM_MARGIN) return { state: { warnedLevel: 0 } };
  const level = settings.thresholds.filter(threshold => percent >= threshold).at(-1) ?? 0;
  if (level <= state.warnedLevel) return { state };
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  const amount = usage.tokens === null ? "" : ` (${k(usage.tokens)}/${k(usage.contextWindow)} tokens)`;
  return {
    state: { warnedLevel: level },
    message: mode === "direct"
      ? `orche: main context is at ${Math.round(percent)}% of the window${amount}. For remaining large work, switch with /orche mode single so a worker carries the context and this session keeps only results, or run /compact.`
      : `orche: main context is at ${Math.round(percent)}% of the window${amount} (mode ${mode}). Every main request re-sends this conversation, so main's turns get slower and its long responses come closer to provider time limits; delegating does not shrink the history this session already holds. Run /compact to summarize it, or start the next task in a new session (/new).`,
  };
}
