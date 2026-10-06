// Post-hoc (NOT pre-registered) rescoring for docs/orchestrator.md 7: p1 relabeled "none" after the end-to-end smoke.
// Usage (from the orche root): npx --no-install tsx experiments/judgment/rescore-p1-none.ts
import fs from "node:fs";
import { loadItems, parseAnswer, predictedSet, isCorrect, type RawCall } from "./eval.ts";
const runs = ["2026-10-05T14-10-07-384Z-opus-main", "2026-10-05T14-10-07-387Z-sol-second", "2026-10-06T10-13-52-443Z-sol-rep2"];
const items = loadItems();
const relabeled = items.map(item => item.id === "p1" ? { ...item, labels: [] as never[], alsoAccept: undefined } : item);
const byId = (list: typeof items) => new Map(list.map(item => [item.id, item]));
const orig = byId(items), alt = byId(relabeled);
const tally: Record<string, { n: number; orig: number; alt: number }> = {};
for (const run of runs) for (const line of fs.readFileSync(`experiments/judgment/runs/${run}/raw.jsonl`, "utf8").split("\n").filter(Boolean)) {
  const call = JSON.parse(line) as RawCall;
  const set = predictedSet(parseAnswer(call.text ?? ""));
  const key = `${call.model} ${call.variant}`;
  const t = (tally[key] ??= { n: 0, orig: 0, alt: 0 });
  t.n++;
  if (set && isCorrect(orig.get(call.item)!, set)) t.orig++;
  if (set && isCorrect(alt.get(call.item)!, set)) t.alt++;
}
for (const [key, t] of Object.entries(tally)) console.log(key, `${t.orig}/${t.n} -> ${t.alt}/${t.n}`, (100 * t.alt / t.n).toFixed(1) + "%");
