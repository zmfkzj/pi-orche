// Scores split-judgment evaluation v2 (docs/orchestrator.md 8): metrics per model × variant (all items, and per condition), the
// pre-registered selection on the main model, costs (provider-reported and catalog), and the wrong answers.
//
// Usage: npx --no-install tsx experiments/judgment/score-v2.ts [--main cliproxyapi/claude-opus-5-5] [--out report-v2] <run dir>...
import fs from "node:fs";
import path from "node:path";
import { metrics, type Metrics } from "./eval.ts";
import { HERE } from "./eval.ts";
import { loadItemsV2, type RawCallV2 } from "./run-v2.ts";
import { INCUMBENT, VARIANTS_V2 } from "./variants-v2.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const index = argv.indexOf(name); if (index < 0) return fallback; const found = argv[index + 1]!; argv.splice(index, 2); return found; };
const mainModel = flag("--main", "cliproxyapi/claude-opus-5-5");
const outName = flag("--out", "report-v2");
const dirs = argv;
if (!dirs.length) throw new Error("usage: score-v2.ts [--main model] [--out name] <run dir>...");

const read = dirs.flatMap(dir => fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as RawCallV2));
// A transport failure (no answer at all) that a later run of the same model/variant/item/repetition answered is replaced by
// that answer (as v1's run.ts retried transport errors once); everything else counts as it is.
const keyOf = (call: RawCallV2) => `${call.model}|${call.variant}|${call.item}|${call.rep}`;
const answered = new Set(read.filter(call => call.text).map(keyOf));
const replaced = read.filter(call => !call.text && answered.has(keyOf(call)));
const calls = read.filter(call => call.text || !answered.has(keyOf(call)));
// The condition an item ran in comes from its calls (run-v2.ts --agentic-fixtures moves fixture items to agentic).
const agenticIds = new Set(calls.filter(call => call.condition === "agentic").map(call => call.item));
const items = loadItemsV2().map(item => ({ ...item, condition: agenticIds.has(item.id) ? "agentic" as const : "one-turn" as const }));

const prices = (() => {
  const found = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  const file = path.join(process.env.HOME ?? "", ".pi/agent/cliproxyapi-models.json");
  if (!fs.existsSync(file)) return found;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && record.cost && typeof record.cost === "object") found.set(record.id, record.cost as never);
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(fs.readFileSync(file, "utf8")));
  return found;
})();
const catalog = (list: readonly RawCallV2[]) => list.reduce((sum, call) => {
  const price = prices.get(call.model.split("/").slice(1).join("/"));
  const usage = call.usage;
  return !price || !usage ? sum : sum + (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1e6;
}, 0);

/**
 * The pre-registered v2 selection (docs/orchestrator.md 8.4), on the main model over all items: eligible = false split ≤ 10% and
 * missed parallelism ≤ 1/3; the most accurate eligible variant wins; accuracies within one item (1/items) tie, broken by lower
 * false split, lower missed parallelism, then the incumbent. Without an eligible variant: lowest false split + missed parallelism,
 * then higher accuracy, then the incumbent.
 */
export function selectV2(all: readonly Metrics[], itemCount: number): { winner: string; eligible: string[]; reason: string } {
  const incumbentFirst = (a: Metrics, b: Metrics) => Number(b.variant === INCUMBENT) - Number(a.variant === INCUMBENT);
  const eligible = all.filter(m => m.falseSplit <= 0.10 + 1e-9 && m.missedParallel <= 1 / 3 + 1e-9);
  if (eligible.length) {
    const best = Math.max(...eligible.map(m => m.accuracy));
    const tied = eligible.filter(m => best - m.accuracy <= 1 / itemCount + 1e-9).sort((a, b) => a.falseSplit - b.falseSplit || a.missedParallel - b.missedParallel || incumbentFirst(a, b));
    return { winner: tied[0]!.variant, eligible: eligible.map(m => m.variant), reason: tied.length > 1 ? `best accuracy ${best.toFixed(3)}; within one item: ${tied.map(m => m.variant).join(", ")}; broken by false split / missed parallel / incumbent` : `highest accuracy ${best.toFixed(3)} among eligible` };
  }
  const sorted = [...all].sort((a, b) => (a.falseSplit + a.missedParallel) - (b.falseSplit + b.missedParallel) || b.accuracy - a.accuracy || incumbentFirst(a, b));
  return { winner: sorted[0]!.variant, eligible: [], reason: "no variant met the eligibility bounds; lowest false split + missed parallelism" };
}

const pct = (value: number | null) => value === null ? "–" : `${(100 * value).toFixed(1)}%`;
const models = [...new Set(calls.map(call => call.model))].sort((a, b) => Number(b === mainModel) - Number(a === mainModel) || a.localeCompare(b));
const variants = Object.keys(VARIANTS_V2);
const scopes: { name: string; filter: (call: RawCallV2) => boolean; items: typeof items }[] = [
  { name: "all", filter: () => true, items },
  { name: "agentic", filter: call => call.condition === "agentic", items: items.filter(item => item.condition === "agentic") },
  { name: "one-turn", filter: call => call.condition === "one-turn", items: items.filter(item => item.condition === "one-turn") },
];
const lines: string[] = ["# Split-judgment evaluation v2: results", "", `Runs: ${dirs.map(dir => path.basename(dir)).join(", ")}. Main model: ${mainModel}. Items: ${items.length} (${scopes[1]!.items.length} agentic, ${scopes[2]!.items.length} one-turn).`, ""];
const json: Record<string, unknown> = { runs: dirs.map(dir => path.basename(dir)), mainModel, scopes: {} };
for (const scope of scopes) {
  lines.push(`## ${scope.name}`, "", "| Model | Variant | Calls | Parse fail | Accuracy | False split | Unnecessary parallel | Missed parallel | False / missed isolation | False / missed verification | Units compatible / exact (n) | Consistency | Provider $ | Catalog $ | Turns (median) |", "|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|");
  const table: Metrics[] = [];
  for (const model of models) for (const variant of variants) {
    const mine = calls.filter(call => call.model === model && call.variant === variant && scope.filter(call));
    if (!mine.length) continue;
    const m = metrics(scope.items, mine, model, variant, VARIANTS_V2[variant]!.length);
    table.push(m);
    const turns = mine.map(call => call.turns ?? 1).sort((a, b) => a - b);
    lines.push(`| ${model.split("/").at(-1)} | ${variant} | ${m.calls} | ${m.parseFailures} | ${pct(m.accuracy)} | ${pct(m.falseSplit)} | ${pct(m.unnecessaryParallel)} | ${pct(m.missedParallel)} | ${pct(m.falseIsolation)} / ${pct(m.missedIsolation)} | ${pct(m.falseVerification)} / ${pct(m.missedVerification)} | ${pct(m.unitCompatible)} / ${pct(m.unitExact)} (${m.unitCases}) | ${pct(m.consistency)} | $${m.costUSD.toFixed(2)} | $${catalog(mine).toFixed(2)} | ${turns[Math.floor(turns.length / 2)]} |`);
  }
  (json.scopes as Record<string, unknown>)[scope.name] = table;
  if (scope.name === "all") {
    const main = table.filter(m => m.model === mainModel);
    if (main.length) {
      const selection = selectV2(main, scope.items.length);
      json.selection = selection;
      lines.push("", `**Selection (${mainModel}, all items):** ${selection.winner} — ${selection.reason}. Eligible: ${selection.eligible.join(", ") || "none"}.`);
    }
  }
  lines.push("");
}
lines.push("## Wrong answers (item#rep: label -> answer)", "");
for (const model of models) for (const variant of variants) {
  const mine = calls.filter(call => call.model === model && call.variant === variant);
  if (!mine.length) continue;
  const m = metrics(items, mine, model, variant, 0);
  lines.push(`- ${model.split("/").at(-1)} ${variant}: ${m.errors.join(", ") || "none"}`);
}
lines.push("", `Transport failures replaced by a later answer: ${replaced.map(call => `${call.model.split("/").at(-1)} ${call.variant} ${call.item}#${call.rep}`).join(", ") || "none"}.`);
lines.push("", `Spent (all calls, replaced failures included): provider $${read.reduce((sum, call) => sum + (call.usage?.cost?.total ?? 0), 0).toFixed(2)}, catalog $${catalog(read).toFixed(2)}, ${read.length} calls.`);
lines.push("", `Total (scored calls): provider $${calls.reduce((sum, call) => sum + (call.usage?.cost?.total ?? 0), 0).toFixed(2)}, catalog $${catalog(calls).toFixed(2)}, ${calls.length} calls.`);
fs.writeFileSync(path.join(HERE, `${outName}.md`), `${lines.join("\n")}\n`);
fs.writeFileSync(path.join(HERE, `${outName}.json`), `${JSON.stringify(json, null, 1)}\n`);
console.log(lines.join("\n"));
