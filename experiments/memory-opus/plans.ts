/**
 * Plans of the Opus decision-memory study (PREREGISTRATION.md §6, §8). Writes plans/*.json for
 * `npx tsx experiments/decision-memory-b/driver.ts experiments/memory-opus/plans/<phase>.json`.
 *
 *   npx tsx experiments/memory-opus/plans.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../decision-memory-b/driver.js";
import { PILOT_SEEDS, STAGE1_SEEDS, STAGE2_SEEDS } from "./protocol.js";

const SCRATCH = "/var/tmp/pi-arthur/pi-orche/01a1df36-c9c4-72a4-8645-390d5b513adf/W1/memory-opus-scratch";
const common = { concurrency: 8, scratch: SCRATCH, model: "opus" as const, arms: ["K", "M"] as ("K" | "M")[], reservePerRunUsd: 7.5 };

export const PLANS: Record<"pilot" | "stage1" | "stage2", Plan> = {
  pilot: { ...common, out: "../../../results/memory-opus/pilot", seeds: PILOT_SEEDS, seed: 2026111610, phase: "pilot", budgetUsd: 20 },
  stage1: { ...common, out: "../../../results/memory-opus/scored", seeds: STAGE1_SEEDS, seed: 2026111611, phase: "stage1", budgetUsd: 250 },
  stage2: { ...common, out: "../../../results/memory-opus/scored", seeds: STAGE2_SEEDS, seed: 2026111612, phase: "stage2", budgetUsd: 170 },
};

if (process.argv[1]?.endsWith("plans.ts")) {
  const dir = join(import.meta.dirname, "plans");
  mkdirSync(dir, { recursive: true });
  for (const [name, plan] of Object.entries(PLANS)) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`wrote ${Object.keys(PLANS).length} plans to ${dir}`);
}
