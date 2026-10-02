import type { RunLimits } from '../orchestration/limits.js';

/**
 * Evaluation and benchmark runs keep FIXED budgets. The activity-aware timeout extension of orche_run / orche_task
 * (src/orchestration/run/extension.ts) would give a busy arm up to three more base budgets than an idle one, and a runner whose outer
 * process timeout is `timeoutSec + 30` would kill it anyway, so comparisons stay fair only when nothing extends: `maxExtensions` is 0
 * unless the caller explicitly asks otherwise. Everything else in `limits` is passed through untouched.
 */
export function fixedBudgetLimits(limits: Partial<RunLimits> = {}): Partial<RunLimits> {
  return { ...limits, maxExtensions: limits.maxExtensions ?? 0 };
}

/** The limits of a Pi evaluation run with a `timeoutSec` budget: that overall budget, fixed. */
export function evalRunLimits(timeoutSec: number): Partial<RunLimits> {
  return fixedBudgetLimits({ overallMs: timeoutSec * 1000 });
}
