// Scores the real-session split-judgment evaluation (docs/orchestrator.md 10). Writes only aggregates and anonymous ids
// (rNNNN, PNN), so the report may be committed; request text stays in results/judgment-real/.
//
// Usage: npx --no-install tsx experiments/judgment/real/score-real.ts [--main cliproxyapi/claude-opus-5-5] [--out experiments/judgment/report-real] <run dir>...
import fs from "node:fs";
import path from "node:path";
import { metrics, parseAnswer, predictedSet, isCorrect, type Item, type Metrics } from "../eval.ts";
import type { RawCallV2 } from "../run-v2.ts";
import { INCUMBENT, VARIANTS_V2 } from "../variants-v2.ts";
import { loadReal, type RealItem } from "./run-real.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const index = argv.indexOf(name); if (index < 0) return fallback; const found = argv[index + 1]!; argv.splice(index, 2); return found; };
const mainModel = flag("--main", "cliproxyapi/claude-opus-5-5");
const outBase = flag("--out", "experiments/judgment/report-real");
const dirs = argv;
if (!dirs.length) throw new Error("usage: score-real.ts [--main model] [--out base] <run dir>...");

const real = loadReal();
const toItem = (item: RealItem): Item => ({ id: item.id, role: "implement", labels: item.label === "none" ? [] : item.label.split("+") as Item["labels"], ...(item.units ? { units: item.units } : {}), rationale: item.labelEvidence, title: "", instruction: "", files: [] } as unknown as Item);
const certain = real.filter(item => item.label !== "uncertain");
const items = certain.map(toItem);
const byId = new Map(real.map(item => [item.id, item]));
const calls = dirs.flatMap(dir => fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as RawCallV2));
const models = [...new Set(calls.map(call => call.model))].sort((a, b) => Number(b === mainModel) - Number(a === mainModel) || a.localeCompare(b));
const variants = Object.keys(VARIANTS_V2);
const pct = (value: number | null) => value === null ? "–" : `${(100 * value).toFixed(1)}%`;

/** v2's pre-registered selection (docs/orchestrator.md 8.5), unchanged. */
function select(all: readonly Metrics[], itemCount: number): { winner: string; eligible: string[]; reason: string } {
  const incumbentFirst = (a: Metrics, b: Metrics) => Number(b.variant === INCUMBENT) - Number(a.variant === INCUMBENT);
  const eligible = all.filter(m => m.falseSplit <= 0.10 + 1e-9 && m.missedParallel <= 1 / 3 + 1e-9);
  if (eligible.length) {
    const best = Math.max(...eligible.map(m => m.accuracy));
    const tied = eligible.filter(m => best - m.accuracy <= 1 / itemCount + 1e-9).sort((a, b) => a.falseSplit - b.falseSplit || a.missedParallel - b.missedParallel || incumbentFirst(a, b));
    return { winner: tied[0]!.variant, eligible: eligible.map(m => m.variant), reason: tied.length > 1 ? `best accuracy ${best.toFixed(3)}; within one item: ${tied.map(m => m.variant).join(", ")}` : `highest accuracy ${best.toFixed(3)} among eligible` };
  }
  const sorted = [...all].sort((a, b) => (a.falseSplit + a.missedParallel) - (b.falseSplit + b.missedParallel) || b.accuracy - a.accuracy || incumbentFirst(a, b));
  return { winner: sorted[0]!.variant, eligible: [], reason: "no variant met the eligibility bounds; lowest false split + missed parallelism" };
}

/** Why a scored answer is wrong: the criterion it added or missed, crossed with the kind of task the record shows. */
function cause(item: RealItem, set: readonly string[] | undefined): string {
  if (!set) return "parse failure";
  const label = item.label === "none" ? [] : item.label.split("+");
  const added = set.filter(name => !label.includes(name));
  const missed = label.filter(name => !set.includes(name));
  const kind = item.label === "none" ? item.noneType ?? "none" : item.label;
  return [...added.map(name => `false ${name} (${kind})`), ...missed.map(name => `missed ${name}`)].join(" + ");
}

const lines: string[] = ["# Split-judgment evaluation on real-session requests: results", "",
  `Runs: ${dirs.map(dir => path.basename(dir)).join(", ")}. Main model: ${mainModel}. Items: ${real.length} (${certain.length} scored, ${real.length - certain.length} uncertain, excluded from the main metrics). Labels: ${JSON.stringify(Object.fromEntries([...new Set(real.map(i => i.label))].map(l => [l, real.filter(i => i.label === l).length])))}.`, "",
  "## All scored items", "",
  "| Model | Variant | Calls | Parse fail | Accuracy | False split | Unnecessary parallel | False isolation | False / missed verification | Consistency | Provider $ |",
  "|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|"];
const json: Record<string, unknown> = { runs: dirs.map(dir => path.basename(dir)), mainModel, table: [] as Metrics[] };
const table: Metrics[] = [];
for (const model of models) for (const variant of variants) {
  const mine = calls.filter(call => call.model === model && call.variant === variant);
  if (!mine.length) continue;
  const m = metrics(items, mine, model, variant, VARIANTS_V2[variant]!.length);
  table.push(m);
  lines.push(`| ${model.split("/").at(-1)} | ${variant} | ${m.calls} | ${m.parseFailures} | ${pct(m.accuracy)} | ${pct(m.falseSplit)} | ${pct(m.unnecessaryParallel)} | ${pct(m.falseIsolation)} | ${pct(m.falseVerification)} / ${pct(m.missedVerification)} | ${pct(m.consistency)} | $${m.costUSD.toFixed(2)} |`);
}
json.table = table;
const main = table.filter(m => m.model === mainModel);
if (main.length) { const selection = select(main, items.length); json.selection = selection; lines.push("", `**Selection (${mainModel}):** ${selection.winner} — ${selection.reason}. Eligible: ${selection.eligible.join(", ") || "none"}.`); }

// Splits by task kind (the record's none subtypes and the labels) and by project, per model × variant.
const groups: { title: string; key: (item: RealItem) => string }[] = [
  { title: "By kind (split rate on none = false split; on verification = hit rate)", key: item => item.label === "none" ? `none/${item.noneType}` : item.label },
  { title: "By project (anonymous ids; false split on none items)", key: item => item.project },
];
const splitRate = (rows: RawCallV2[]) => { const parsed = rows.map(call => predictedSet(call.text ? parseAnswer(call.text) : undefined)); const ok = parsed.filter(Boolean) as string[][]; return ok.length ? ok.filter(set => set.length).length / ok.length : null; };
for (const group of groups) {
  const keys = [...new Set(certain.map(group.key))].sort();
  lines.push("", `## ${group.title}`, "", `| Model | Variant | ${keys.map(k => `${k} (n=${certain.filter(i => group.key(i) === k).length})`).join(" | ")} |`, `|---|---|${keys.map(() => "---:").join("|")}|`);
  for (const model of models) for (const variant of variants) {
    const mine = calls.filter(call => call.model === model && call.variant === variant && byId.get(call.item)?.label !== "uncertain");
    if (!mine.length) continue;
    lines.push(`| ${model.split("/").at(-1)} | ${variant} | ${keys.map(k => pct(splitRate(mine.filter(call => group.key(byId.get(call.item)!) === k)))).join(" | ")} |`);
  }
}
// Uncertain items: what the models did (no correctness).
lines.push("", "## Uncertain items (not scored): split rate", "", "| Model | Variant | Split rate | Criteria named |", "|---|---|---:|---|");
for (const model of models) for (const variant of variants) {
  const mine = calls.filter(call => call.model === model && call.variant === variant && byId.get(call.item)?.label === "uncertain");
  if (!mine.length) continue;
  const named = new Map<string, number>();
  for (const call of mine) for (const name of predictedSet(call.text ? parseAnswer(call.text) : undefined) ?? []) named.set(name, (named.get(name) ?? 0) + 1);
  lines.push(`| ${model.split("/").at(-1)} | ${variant} | ${pct(splitRate(mine))} | ${[...named].map(([k, v]) => `${k} ${v}`).join(", ") || "–"} |`);
}
// Wrong answers by cause.
lines.push("", "## Wrong answers by cause (calls)", "", "| Model | Variant | Causes |", "|---|---|---|");
const causes: Record<string, Record<string, number>> = {};
for (const model of models) for (const variant of variants) {
  const counts = new Map<string, number>();
  for (const call of calls.filter(c => c.model === model && c.variant === variant)) {
    const item = byId.get(call.item)!;
    if (item.label === "uncertain") continue;
    const set = predictedSet(call.text ? parseAnswer(call.text) : undefined);
    if (set && isCorrect(toItem(item), set)) continue;
    const why = cause(item, set);
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  causes[`${model} ${variant}`] = Object.fromEntries(counts);
  lines.push(`| ${model.split("/").at(-1)} | ${variant} | ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("; ") || "none"} |`);
}
json.causes = causes;
lines.push("", `Total: provider $${calls.reduce((sum, call) => sum + (call.usage?.cost?.total ?? 0), 0).toFixed(2)}, ${calls.length} calls, ${calls.filter(call => !call.text).length} without an answer.`);
fs.writeFileSync(`${outBase}.md`, `${lines.join("\n")}\n`);
fs.writeFileSync(`${outBase}.json`, `${JSON.stringify(json, null, 1)}\n`);
console.log(lines.join("\n"));
