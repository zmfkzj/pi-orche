// Post-hoc diagnostic (docs/orchestrator.md 9, not pre-registered): checklist-sized on the one-turn synthetic items with the
// orchestrator text of the main v2 runs ("You work alone ...") against the corrected product text (ORCHESTRATOR_TEAM_LINE).
// Usage (from the orche root): npx --no-install tsx experiments/judgment/compare-teamline.ts
import fs from "node:fs";
import path from "node:path";
import { HERE, metrics } from "./eval.ts";
import { loadItemsV2, type RawCallV2 } from "./run-v2.ts";

const runs = fs.readdirSync(path.join(HERE, "runs-v2"));
const read = (pattern: RegExp) => runs.filter(name => pattern.test(name)).flatMap(name => fs.readFileSync(path.join(HERE, "runs-v2", name, "raw.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as RawCallV2));
const items = loadItemsV2().filter(item => !item.fixture).map(item => ({ ...item, condition: "one-turn" as const }));
const ids = new Set(items.map(item => item.id));
for (const [label, pattern] of [["main (You work alone)", /-main-/], ["teamline (corrected)", /-teamline-/]] as const) {
  const calls = read(pattern).filter(call => call.variant === "checklist-sized" && ids.has(call.item));
  for (const model of [...new Set(calls.map(call => call.model))].sort()) {
    const mine = calls.filter(call => call.model === model);
    const m = metrics(items, mine, model, "checklist-sized", 0);
    const alone = mine.filter(call => /work(ing)? alone|no peer/i.test(call.text ?? "")).map(call => `${call.item}#${call.rep}`);
    console.log(`${label} | ${model.split("/").at(-1)} | n=${m.calls} | accuracy ${(100 * m.accuracy).toFixed(1)}% | false split ${(100 * m.falseSplit).toFixed(1)}% | missed parallel ${(100 * m.missedParallel).toFixed(1)}% | missed isolation ${(100 * m.missedIsolation).toFixed(1)}% | "alone" cited: ${alone.join(", ") || "none"} | wrong: ${m.errors.join(", ") || "none"}`);
  }
}
