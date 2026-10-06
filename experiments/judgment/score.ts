// Score split-judgment runs (docs/orchestrator.md §5) and apply the pre-registered selection rule.
//
// Usage: npx --no-install tsx experiments/judgment/score.ts --main <provider>/<model> <run dir>... [--out experiments/judgment/report.md]
// --main names the model whose pooled metrics decide (the current main model); other models are reported descriptively.
import fs from "node:fs";
import path from "node:path";
import { HERE, loadItems, metrics, select, type Metrics, type RawCall } from "./eval.ts";
import { systemPrompt, VARIANTS } from "./variants.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => { const index = argv.indexOf(name); if (index < 0) return undefined; const found = argv[index + 1]; argv.splice(index, 2); return found; };
const mainModel = flag("--main");
const outFile = flag("--out") ?? path.join(HERE, "report.md");
if (!mainModel || !argv.length) throw new Error("usage: score.ts --main <provider>/<model> <run dir>... [--out file]");
const items = loadItems();
const calls: RawCall[] = argv.flatMap(dir => fs.readFileSync(path.join(dir, "raw.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as RawCall));
const models = [...new Set(calls.map(call => call.model))];
const variants = Object.keys(VARIANTS).filter(variant => calls.some(call => call.variant === variant));
const all: Metrics[] = models.flatMap(model => variants.filter(variant => calls.some(call => call.model === model && call.variant === variant)).map(variant => metrics(items, calls, model, variant, VARIANTS[variant]!.length)));
const decisive = all.filter(m => m.model === mainModel);
const selection = select(decisive, items.length);

const pct = (v: number | null) => v === null ? "–" : `${(v * 100).toFixed(1)}%`;
const header = "| Model | Variant | Calls | Accuracy | False split | Unneeded parallel | Missed parallel | Units compatible / exact (n) | Missed / false verification | Missed / false isolation | Consistency | Parse failures | Cost |";
const rows = all.map(m => `| ${m.model} | ${m.variant}${m.model === mainModel && m.variant === selection.winner ? " **(selected)**" : ""} | ${m.calls} | ${pct(m.accuracy)} | ${pct(m.falseSplit)} | ${pct(m.unnecessaryParallel)} | ${pct(m.missedParallel)} | ${pct(m.unitCompatible)} / ${pct(m.unitExact)} (${m.unitCases}) | ${pct(m.missedVerification)} / ${pct(m.falseVerification)} | ${pct(m.missedIsolation)} / ${pct(m.falseIsolation)} | ${pct(m.consistency)} | ${m.parseFailures} | $${m.costUSD.toFixed(2)} |`);
const truth = { none: items.filter(item => !item.labels.length).length, parallelism: items.filter(item => item.labels.includes("parallelism")).length, isolation: items.filter(item => item.labels.includes("isolation")).length, verification: items.filter(item => item.labels.includes("verification")).length };
const lines = [
  "# Split-judgment evaluation results", "",
  `Generated ${new Date().toISOString()} by experiments/judgment/score.ts from ${argv.map(dir => path.relative(path.resolve(HERE, "../.."), path.resolve(dir))).join(", ")}.`,
  `${items.length} items (primary labels: ${JSON.stringify(truth)}). Rates pool all repetitions. Cost is the provider catalog price of the calls.`, "",
  header, "|---|---|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|", ...rows, "",
  `Selection (pre-registered rule, main model ${mainModel}): **${selection.winner}**. Eligible: ${selection.eligible.join(", ") || "none"}. ${selection.reason}.`, "",
  "Errors (item#rep: expected -> predicted):", "",
  ...all.map(m => `- ${m.model} ${m.variant}: ${m.errors.join(", ") || "none"}`), "",
  `System prompt lengths (chars): ${variants.map(variant => `${variant} ${systemPrompt(variant).length}`).join(", ")}.`,
];
fs.writeFileSync(outFile, `${lines.join("\n")}\n`);
fs.writeFileSync(outFile.replace(/\.md$/, ".json"), `${JSON.stringify({ mainModel, selection, metrics: all }, null, 1)}\n`);
console.log(lines.slice(0, 7 + rows.length + 2).join("\n"));
