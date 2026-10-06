// One-turn split-judgment runs (docs/orchestrator.md §5): one model call per (item, variant, repetition), no tools.
//
// Usage: npx --no-install tsx experiments/judgment/run.ts --model <provider>/<model> [--thinking high] [--reps 2] [--rep-start 1]
//          [--variant NAME]... [--item ID]... [--concurrency 6] [--label NAME]
// Writes experiments/judgment/runs/<stamp>-<label>/{meta.json,raw.jsonl}; score.ts reads them.
// --rep-start numbers the repetitions of this run from N (e.g. a later second repetition of a one-repetition run: --reps 1 --rep-start 2),
// so score.ts pools both runs as two repetitions.
import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadProviderExtensions } from "../../src/pi/provider-extensions.ts";
import { HERE, loadItems, sha256, userMessage, type RawCall } from "./eval.ts";
import { systemPrompt, VARIANTS } from "./variants.ts";

const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((arg, index) => arg === name && argv[index + 1] ? [argv[index + 1]!] : []);
const value = (name: string, fallback: string) => values(name).at(-1) ?? fallback;
const modelSpec = value("--model", "");
if (!/^[^/]+\/.+$/.test(modelSpec)) throw new Error("--model <provider>/<model> is required");
const [provider, ...rest] = modelSpec.split("/");
const modelId = rest.join("/");
const thinking = value("--thinking", "high");
const reps = Number(value("--reps", "2"));
const repStart = Number(value("--rep-start", "1"));
if (!Number.isInteger(repStart) || repStart < 1) throw new Error("--rep-start must be a positive integer");
const concurrency = Number(value("--concurrency", "6"));
const variants = values("--variant").length ? values("--variant") : Object.keys(VARIANTS);
const label = value("--label", modelId).replace(/[^A-Za-z0-9._-]+/g, "-");
const onlyItems = new Set(values("--item"));
const items = loadItems().filter(item => !onlyItems.size || onlyItems.has(item.id));

async function pool<T>(list: readonly T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, width) }, async () => { while (next < list.length) await run(list[next++]!); }));
}

const runtime = await ModelRuntime.create();
if (provider === "cliproxyapi") await loadProviderExtensions(runtime, ["npm:@router-for-me/pi-cliproxyapi-provider"], { cwd: process.cwd() });
const model = runtime.getModel(provider!, modelId);
if (!model) throw new Error(`${modelSpec} is not available`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(HERE, "runs", `${stamp}-${label}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify({ startedAt: new Date().toISOString(), model: modelSpec, thinking, reps, ...(repStart !== 1 ? { repStart } : {}), variants, items: items.map(item => item.id),
  sha256: { "tasks.json": sha256(path.join(HERE, "tasks.json")), "variants.ts": sha256(path.join(HERE, "variants.ts")), "eval.ts": sha256(path.join(HERE, "eval.ts")) } }, null, 2)}\n`);
const jobs = variants.flatMap(variant => Array.from({ length: reps }, (_unused, rep) => items.map(item => ({ item, variant, rep: repStart + rep }))).flat());
const out = fs.createWriteStream(path.join(dir, "raw.jsonl"));
let done = 0;
let cost = 0;
await pool(jobs, concurrency, async ({ item, variant, rep }) => {
  const started = Date.now();
  let call: RawCall;
  for (let attempt = 1; ; attempt++) {
    try {
      const message = await runtime.completeSimple(model, { systemPrompt: systemPrompt(variant), messages: [{ role: "user", content: userMessage(item), timestamp: Date.now() }] },
        { reasoning: thinking as never, signal: AbortSignal.timeout(300_000) });
      const text = message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
      call = { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, text, usage: message.usage as RawCall["usage"], ...(message.stopReason === "error" ? { error: message.errorMessage ?? "error" } : {}) };
    } catch (error) {
      call = { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
    // One retry for transport errors only (no text); a parsed or unparsable answer is kept as it is.
    if (!call.error || call.text || attempt >= 2) break;
  }
  cost += call.usage?.cost?.total ?? 0;
  out.write(`${JSON.stringify(call)}\n`);
  if (++done % 20 === 0 || done === jobs.length) console.log(`${done}/${jobs.length} calls, $${cost.toFixed(3)}`);
});
await new Promise<void>(resolve => out.end(resolve));
console.log(`Wrote ${dir}`);
