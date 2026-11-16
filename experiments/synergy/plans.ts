/**
 * Writes the stage-eval driver plans of the synergy studies (PREREGISTRATION.md §6) into experiments/synergy/plans/.
 *
 *   npx tsx experiments/synergy/plans.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADVERSE_TASKS, S1, S2, SEED, STAGE_TASKS, armsOf } from "./protocol.js";

const SCRATCH = "/var/tmp/pi-arthur/pi-orche/01a1df36-c9c4-72a4-8645-390d5b513adf/W1/synergy-scratch";
/** The prepared SWE environments of the stage evaluation (VALIDATION OK: results/synergy/validation-stage8.json). */
const SWE_CACHE = "/var/tmp/pi-arthur/pi-orche/01a1cdc1-73e0-7158-af61-a2b9df812464/W2/swe-cache";
const PI = "/home/arthur/.bun/bin/pi";
const common = { seed: SEED, scratch: SCRATCH, sweCache: SWE_CACHE, piBin: PI };

export const PLANS = {
  "pilot-s1": { out: "results/synergy/pilot", phase: "pilot-s1", tasks: ["e2-changed-default-ko", "d8-build-graph"], arms: armsOf(S1), repeats: 1, concurrency: 8, maxRuns: 10, budgetUsd: 15, ...common },
  "pilot-s2": { out: "results/synergy/pilot-s2", phase: "pilot-s2", tasks: ["pypa__build-1027"], arms: armsOf(S2), repeats: 1, concurrency: 4, maxRuns: 6, budgetUsd: 10, ...common },
  s1: { out: "results/synergy/s1", phase: "s1", tasks: [...STAGE_TASKS, ...ADVERSE_TASKS], arms: armsOf(S1), repeats: 3, concurrency: 8, maxRuns: 135, budgetUsd: 150, ...common },
  s2: { out: "results/synergy/s2", phase: "s2", tasks: [...STAGE_TASKS], arms: armsOf(S2), repeats: 2, concurrency: 6, maxRuns: 75, budgetUsd: 110, ...common },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, plan] of Object.entries(PLANS)) writeFileSync(join(fileURLToPath(new URL("./plans/", import.meta.url)), `${name}.json`), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(Object.keys(PLANS).join(" "));
}
