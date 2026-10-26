/**
 * Fixed protocol of the strong-reflection hard-task bench (PREREGISTRATION.md next to this file): tasks, repeats, the hand-off
 * request, the orche configuration of every arm, and the scoring rule. Arms:
 * - O  (record): unmodified strong mode run to its end. `single.strongReflection` is on but its hooks are patched to observe only
 *   (they return nothing to the model; they only mark the reflection point), so the worker sees exactly what it sees without the key.
 * - R0 (control): O's recorded model responses replayed up to the reflection point, then live; no `strongReflection` key.
 * - R1 (reflection): the same replay, then live; `strongReflection: true` (the user's four-line prompt at the reflection point).
 */
import type { TaskSpec } from "../../ultra-ab/protocol.js";

export const TASKS = ["pycqa__isort-2491", "scientific-python__docstub-123", "tox-dev__tox-3904", "d1-transactional-outbox"] as const;
export const REPEATS = 4;
export const ARMS = ["O", "R0", "R1"] as const;
export type Arm = typeof ARMS[number];

/** The user's strong tier (~/.pi/agent/orche.config.json) with thinking high (the user's explicit instruction, 2026-10-19). */
export const MODEL_REF = "cliproxyapi/gpt-6-astra";
export const THINKING = "high";
/** Hard stop: no new unit starts once the billed (live) cost of the bench reaches this. */
export const BUDGET_USD = 180;
export const CONCURRENCY = 8;
/** Price of gpt-6-astra per million tokens (~/.pi/agent/cliproxyapi-models.json, base tier below 272k input). */
export const PRICE = { input: 10, cacheRead: 1, output: 50 };

export function orcheConfig(arm: Arm, recordsDir: string): Record<string, unknown> {
  return {
    mainMode: "single",
    providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"],
    // The user's tiers (models.orchestrator is consulted only when the strong orchestrator cannot be resolved).
    models: {
      orchestrator: { model: "cliproxyapi/claude-opus-5-5", thinking: "main" },
      "strong-orchestrator": { model: MODEL_REF, thinking: THINKING },
      advisor: { model: MODEL_REF, thinking: "main" },
    },
    default: { model: "cliproxyapi/claude-opus-5-5", thinking: "high", extendedContext: true },
    routes: {},
    // The user's single settings (advisor on, maxSubWorkers 8; spawn default on); only strongReflection differs per arm.
    single: { advisor: true, maxSubWorkers: 8, ...(arm === "R0" ? {} : { strongReflection: true }) },
    records: { enabled: true, dir: recordsDir },
    // The user's Bash safety review calls an external classifier (typesafe/jev-latest) that is not in this harness's agent dir and that
    // a replay cannot reproduce: with it every reviewed command (node --test, pytest) was blocked in the smoke unit. Off in every arm.
    bashReview: { enabled: false },
  };
}

const CONSTRAINTS = "Work only inside this workspace (the current directory; temporary files in your scratch directory are fine); no git commits; no network access is needed or available; do not weaken, skip or delete existing tests. The result is graded afterwards by tests you do not see.";

/** The hand-off request (main's part, fixed so that every arm and repeat gets the same text). */
export function handoff(task: TaskSpec): string {
  const swe = task.kind === "swe";
  return [
    "Intent/Purpose",
    swe ? `Fix the reported problem in this repository: ${task.title}.` : `Implement the requested change in this repository: ${task.title}.`,
    "",
    "Requirements",
    swe ? "R1: Resolve the issue in the Original request so that the project behaves as the issue expects; hidden tests written by the project's maintainers will check the fix." : "R1: Implement every contract in the Original request; hidden tests will check them.",
    "R2: The existing tests keep passing.",
    "R3: Add regression tests for the change.",
    "",
    "Constraints and non-goals",
    CONSTRAINTS,
    "",
    "Assumptions",
    swe ? "`python` and `pytest` on PATH run this project with its dependencies preinstalled (read-only; no pip, no network)." : "Node.js is available; keep zero dependencies.",
    "",
    "Original request",
    task.instruction.trim(),
  ].join("\n");
}

export interface ArmOutcome { terminal: string; gradePassed: boolean; violations: number }
/** Primary pass (as experiments/ultra-ab): terminal done AND independent grade passed AND no integrity violation. */
export const primaryPass = (outcome: ArmOutcome): boolean => outcome.terminal === "done" && outcome.gradePassed && outcome.violations === 0;

/** Deterministic PRNG (mulberry32) seeded by a string: the R0/R1 order of each unit. */
export function orderOf(unit: string): [Arm, Arm] {
  let h = 1779033703;
  for (const ch of `strong-reflection-bench:${unit}`) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), h = h << 13 | h >>> 19;
  h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909);
  return ((h ^ h >>> 16) >>> 0) % 2 === 0 ? ["R0", "R1"] : ["R1", "R0"];
}

/** Cost in USD of upstream (live) usage. */
export const costOf = (usage: { input: number; cached: number; output: number }): number => ((usage.input - usage.cached) * PRICE.input + usage.cached * PRICE.cacheRead + usage.output * PRICE.output) / 1e6;
