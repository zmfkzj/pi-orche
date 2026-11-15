/**
 * The protocol of the decision-memory A/B (README.md), fixed before any run: model, window, compaction settings, limits, the arms
 * (identical orche.config.json except `workerCompaction.decisionMemory`), the pre-randomized schedule, the retry rule and the budget.
 */
import type { TaskId } from "./project.js";

export type Arm = "off" | "on";
export const ARMS: readonly Arm[] = ["off", "on"];

/** The user's default worker route (orche.config.json `default`): Claude Opus 5.5 at high thinking through CLIProxyAPI. */
export const MODEL = { provider: "cliproxyapi", id: "claude-opus-5-5", thinking: "high" } as const;
/**
 * The window the private provider config declares for the model (pi-cliproxyapi-provider `modelOverrides`, its smallest preset). It
 * only sets where the STABLE policy would compact (64k) after a refused early compaction; the model itself is unchanged.
 */
export const WINDOW_TOKENS = 128_000;
/**
 * The compaction trigger of both arms: orche's `absolute` worker policy at 28k tokens (an EARLY trigger: orche's preflight, loop
 * guard and fallback apply and are recorded). Pilot 1 (stable 50% of the 128k window = 64k) never compacted: the worker finished
 * both tasks within 36-48k tokens. 28k with 3k recent tokens kept makes the compaction land in the middle of an ordinary task.
 */
export const TRIGGER_TOKENS = 28_000;
export const KEEP_RECENT_TOKENS = 3_000;

export const LIMITS = {
  /** orche limits.assignmentMs (no extension). */
  assignmentMs: 30 * 60_000,
  /** The harness abort if orche's own deadline did not end the run. */
  harnessMs: 35 * 60_000,
  /** orche's per-assignment request checkpoint (a progress notice, never a stop). */
  assignmentRequests: 150,
  /** The study stops launching runs once the summed estimated cost (catalog prices) passes this many USD. */
  studyCostCapUsd: 80,
} as const;

/**
 * Evidence linkage (`thinkingPolicy.evidence`): "off" is the default of the fixed thinking policy and the user's configuration (no
 * `thinkingPolicy` key): tool results carry no `[orche ref T<n>]`, so checkpoints cannot cite calls by reference. "warn" turns the
 * references on (notes only, nothing rejected), the condition decision memory's checkpoint-citation selection is written for.
 */
export type Linkage = "off" | "warn";

/** orche.config.json of an arm: everything equal except `decisionMemory` (the linkage condition is the same for both arms of a study). */
export function ARM_CONFIG(arm: Arm, linkage: Linkage = "off") {
  return {
    mainMode: "single",
    default: { model: `${MODEL.provider}/${MODEL.id}`, thinking: MODEL.thinking },
    routes: {},
    limits: { overallMs: LIMITS.assignmentMs, assignmentMs: LIMITS.assignmentMs, maxExtensions: 0, assignmentRequests: LIMITS.assignmentRequests },
    single: { ledger: false, spawn: false, advisor: false },
    thinkingPolicy: linkage === "off" ? "fixed" : { mode: "fixed", evidence: linkage },
    concurrentSessions: { enabled: false },
    workerCompaction: { policy: "absolute", triggerTokens: TRIGGER_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS, essentials: "extended", decisionMemory: arm === "on" },
  };
}

export interface Cell { task: TaskId; arm: Arm; repeat: number; pair: string; order: number }
export const cellId = (cell: Pick<Cell, "task" | "arm" | "repeat">) => `${cell.task}/${cell.arm}/r${cell.repeat}`;

/** Pairs (task, repeat) in repeat-major order; the arm order inside each pair from a seeded coin, recorded in the plan. */
export function schedule(tasks: readonly TaskId[], repeats: number, seed: number): Cell[] {
  let state = seed >>> 0;
  const coin = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 31; };
  const cells: Cell[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of tasks) {
      const arms: Arm[] = coin() ? ["on", "off"] : ["off", "on"];
      for (const arm of arms) cells.push({ task, arm, repeat, pair: `${task}/r${repeat}`, order: cells.length + 1 });
    }
  }
  return cells;
}

/** A run is retried once only when it is infrastructure (harness/provider error or no successful model response); never for a timeout or a failed grade. */
export const RETRY_RULE = "infra only, once; the failed attempt is kept as <cell>-infra-1";
