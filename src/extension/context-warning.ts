import type { MainMode } from "../orchestration/routing.js";

/**
 * Advisory for the main session in `direct` mode: when its context crosses a threshold, tell the user that
 * the remaining large work can move to `/orche mode single`, where a worker carries the context and the main
 * keeps only the results. Benchmarks showed direct matching delegated quality at lower cost, so direct stays
 * the default; the risk it leaves is a single large instruction filling the main window.
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
  if (!settings.enabled || mode !== "direct" || !usage || usage.percent === null || !settings.thresholds.length) return { state };
  const percent = usage.percent;
  const lowest = settings.thresholds[0]!;
  if (percent < lowest - REARM_MARGIN) return { state: { warnedLevel: 0 } };
  const level = settings.thresholds.filter(threshold => percent >= threshold).at(-1) ?? 0;
  if (level <= state.warnedLevel) return { state };
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  const amount = usage.tokens === null ? "" : ` (${k(usage.tokens)}/${k(usage.contextWindow)} tokens)`;
  return {
    state: { warnedLevel: level },
    message: `orche: main context is at ${Math.round(percent)}% of the window${amount}. For remaining large work, switch with /orche mode single so a worker carries the context and this session keeps only results, or run /compact.`,
  };
}
