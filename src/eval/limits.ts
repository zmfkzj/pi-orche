import type { RunLimits } from '../orchestration/limits.js';

/**
 * Evaluation and benchmark runs keep FIXED budgets. The activity-aware timeout extension of orche_run / orche_task
 * (src/orchestration/run/extension.ts; product default `maxExtensions` 10 × `extensionMs` 30 min, a 5 h 30 min ceiling) would give a
 * busy arm far more time than an idle one, and a runner whose outer process timeout is `timeoutSec + 30` would kill it anyway, so
 * comparisons stay fair only when nothing extends: `maxExtensions` is 0 unless the caller explicitly asks otherwise (a `maxExtensions` in
 * the user's orche.config.json does not count: the caller's `limits` rank above the config). Everything else in `limits` is passed
 * through untouched.
 */
export function fixedBudgetLimits(limits: Partial<RunLimits> = {}): Partial<RunLimits> {
  return { ...limits, maxExtensions: limits.maxExtensions ?? 0 };
}

/** The limits of a Pi evaluation run with a `timeoutSec` budget: that overall budget, fixed. */
export function evalRunLimits(timeoutSec: number): Partial<RunLimits> {
  return fixedBudgetLimits({ overallMs: timeoutSec * 1000 });
}
