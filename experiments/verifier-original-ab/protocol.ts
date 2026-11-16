/**
 * Protocol of the verifier original-evidence A/B (PREREGISTRATION.md), fixed before the main runs: model, arms, prompt builder,
 * limits, schedule, sequential stages, decision rule and budget.
 */
import { subWorkerPrompt } from "../../src/extension/workers.js";
import { originalRequestOf } from "../../src/single/ledger.js";
import type { PlannedWorker } from "../../src/orchestrator/spawn.js";
import type { Case } from "./cases.js";

export type Arm = "off" | "on";
export const ARMS: readonly Arm[] = ["off", "on"];

/**
 * The user's verifier route: verify sub-workers inherit the orchestrator's route (no models.worker in the user's orche.config.json),
 * which is models.orchestrator = cliproxyapi/claude-opus-5-5 with thinking "main" (the user's default thinking: high).
 */
export const MODEL = { provider: "cliproxyapi", id: "claude-opus-5-5", thinking: "high" } as const;

export const LIMITS = {
  /** Fixed time cap of one verifier session (the sub-worker runner's timeoutMs). */
  verifierMs: 15 * 60_000,
  /** The harness abort if the session did not end on its own. */
  harnessMs: 18 * 60_000,
  /** No new run is launched once the study's summed estimated cost (catalog prices) passes this many USD. */
  studyCostCapUsd: 150,
  /** The pilot's own cap. */
  pilotCostCapUsd: 10,
  /** Study 2's own cap (PREREGISTRATION-2.md §3). */
  study2CostCapUsd: 60,
} as const;

/** The planned verify sub-worker of a case: neutral name and id (nothing reveals the case, its stratum or its label). */
export const plannedVerifier = (item: Pick<Case, "request">): PlannedWorker => ({ id: "W1.1", name: "verify", role: "verify", reason: "verification", request: item.request });

/**
 * The verifier prompt of an arm, built by the production code under test: OFF passes no original (the behaviour before the change),
 * ON passes the orchestrator assignment's Original request exactly as the runtime extracts it (workers.ts: originalRequestOf).
 */
export function promptFor(item: Pick<Case, "request" | "assignment">, arm: Arm): string {
  return subWorkerPrompt(plannedVerifier(item), "W1", [], false, false, arm === "on" ? originalRequestOf(item.assignment) : undefined);
}

export interface Cell { caseId: string; arm: Arm; replicate: number; pair: string; order: number }
export const cellId = (cell: Pick<Cell, "caseId" | "arm" | "replicate">) => `${cell.caseId}/${cell.arm}/r${cell.replicate}`;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

/**
 * The cells of one replicate: every case's pair in a seeded random order, the two arms of a pair adjacent in a seeded random order
 * (with concurrent workers both arms of a pair run at about the same time).
 */
export function schedule(caseIds: readonly string[], replicate: number, seed: number): Cell[] {
  const random = rng(seed + replicate * 7919);
  const order = [...caseIds];
  for (let index = order.length - 1; index > 0; index--) { const pick = Math.floor(random() * (index + 1)); [order[index], order[pick]] = [order[pick]!, order[index]!]; }
  const cells: Cell[] = [];
  for (const caseId of order) {
    const arms: Arm[] = random() < 0.5 ? ["off", "on"] : ["on", "off"];
    for (const arm of arms) cells.push({ caseId, arm, replicate, pair: `${caseId}/r${replicate}`, order: cells.length + 1 });
  }
  return cells;
}

/** Sequential stages: one replicate of every case per stage, at most three; a look after each (PREREGISTRATION.md §6). */
export const MAX_REPLICATES = 3;
export const SEED = 20261115;

export const DECISION = {
  /** Two-sided interval level at every look (≈ Pocock-adjusted for three looks at overall α 0.05). */
  level: 0.98,
  /** The practical margin: a difference smaller than 10 percentage points is not material. */
  margin: 0.10,
  bootstrap: 20_000,
  signFlips: 200_000,
} as const;

export type Verdict = "IMPROVES" | "HARMS" | "TRADE-OFF" | "NO MATERIAL DIFFERENCE" | "INCONCLUSIVE";
export interface Interval { point: number; lower: number; upper: number }

/**
 * The preregistered decision. M1: missed-violation reduction on evidence-gain violation cases (OFF miss − ON miss). M2: false-rejection
 * change on compliant cases (ON − OFF). M3: balanced-accuracy change (ON − OFF). Checked in this order.
 */
export function decide(m1: Interval, m2: Interval, m3: Interval, margin = DECISION.margin): Verdict {
  if (m1.lower > 0 && m2.lower > 0) return "TRADE-OFF";
  if (m3.lower > 0 && m2.upper <= margin) return "IMPROVES";
  if (m3.upper < 0 || (m2.lower > 0 && m2.point >= margin)) return "HARMS";
  if (m3.lower >= -margin && m3.upper <= margin && m2.upper <= margin) return "NO MATERIAL DIFFERENCE";
  return "INCONCLUSIVE";
}

/** Run outcome classes (PREREGISTRATION.md §5). */
export type RunClass = "verdict" | "no-verdict" | "infra";
/** A provider/harness failure (retried once), told from a model that ran but gave no verdict (scored as incorrect). */
export function classify(outcome: { status?: string; data?: unknown; requests?: number; notStarted?: boolean; error?: string } | undefined): RunClass {
  if (!outcome) return "infra";
  const passed = (outcome.data as { passed?: unknown } | undefined)?.passed;
  if ((outcome.status === "passed" || outcome.status === "not passed") && typeof passed === "boolean") return "verdict";
  if (outcome.notStarted || !outcome.requests) return "infra";
  if (/ECONN|ETIMEDOUT|fetch failed|socket|overloaded|rate.?limit|\b5\d\d\b|provider|network|unavailable/i.test(outcome.error ?? "")) return "infra";
  return "no-verdict";
}
