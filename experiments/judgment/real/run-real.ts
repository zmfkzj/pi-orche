// Split-judgment evaluation on real-session requests (docs/orchestrator.md 10): one turn, product prompt path.
//
// Input: results/judgment-real/dataset.json (extract.py; gitignored: it holds request text). For each item the orchestrator's
// first assignment is rendered with the product code (assignmentPrompt + orchestratorSection(<variant>), the orchestrator's
// system instructions) from the request text and the session context BEFORE the request only (earlier requests, files changed
// earlier). Nothing recorded after the request (work, time, outcome) enters the prompt.
//
// Usage: npx --no-install tsx experiments/judgment/real/run-real.ts --model <provider>/<model> [--thinking high] [--reps 2]
//          [--variant NAME]... [--item ID]... [--concurrency 8] [--label NAME] [--dataset results/judgment-real/dataset.json]
// Writes results/judgment-real/runs/<stamp>-<label>/{meta.json,raw.jsonl} (gitignored).
import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadProviderExtensions } from "../../../src/pi/provider-extensions.ts";
import { assignmentPrompt } from "../../../src/extension/workers.ts";
import { orchestratorSection } from "../../../src/orchestrator/instructions.ts";
import { ROOT, sha256 } from "../eval.ts";
import { WORKER_INSTRUCTIONS, type RawCallV2 } from "../run-v2.ts";
import { VARIANTS_V2 } from "../variants-v2.ts";

export interface RealItem {
  id: string; project: string; timestamp: string | null; label: string; noneType?: string | null; units: string[][] | null;
  labelEvidence: string; evidence: Record<string, unknown>; text: string; context: { priorRequests: string[]; priorFiles: string[] };
}
export const DATASET = path.join(ROOT, "results/judgment-real/dataset.json");
export const loadReal = (file = DATASET): RealItem[] => (JSON.parse(fs.readFileSync(file, "utf8")) as { items: RealItem[] }).items;

/** Main's hand-off reduced to what main knew: the request and the session before it. */
export function handoff(item: RealItem): string {
  const earlier = item.context.priorRequests.map(text => `- ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  const files = item.context.priorFiles.slice(-12);
  return [
    "Intent/Purpose: carry out the user's request below.",
    "Requirements: complete everything the Original request asks; run the project's checks where they exist.",
    ...(earlier.length || files.length ? ["Context from the session before this request:", ...(earlier.length ? ["Earlier requests:", ...earlier] : []), ...(files.length ? [`Files changed earlier in this session: ${files.join(", ")}`] : [])] : []),
    "Original request:",
    item.text,
  ].join("\n");
}

const NOTE = `Evaluation run (decision step only, one turn): decide now from this hand-off and the session context, without tools. Reply with JSON only:
{"split": true|false, "criteria": {"parallelism": true|false, "isolation": true|false, "verification": true|false}, "units": [{"name": "short name", "files": ["owned files or directories"]}], "reason": "one or two sentences"}
"units" lists the parallel units when parallelism is true, otherwise []. "split" is true exactly when at least one criterion is true. Include a criterion you would apply later (for example an independent verifier after you implement).`;

export function prompt(item: RealItem, variant: string): string {
  const judgment = VARIANTS_V2[variant];
  if (!judgment) throw new Error(`Unknown variant ${variant}`);
  return `${assignmentPrompt({ role: "implement", request: handoff(item), mainMode: "single", orchestrate: true }, [], false, undefined, orchestratorSection(judgment))}\n\n${NOTE}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const values = (name: string) => argv.flatMap((arg, index) => arg === name && argv[index + 1] ? [argv[index + 1]!] : []);
  const value = (name: string, fallback: string) => values(name).at(-1) ?? fallback;
  const modelSpec = value("--model", "");
  if (!/^[^/]+\/.+$/.test(modelSpec)) throw new Error("--model <provider>/<model> is required");
  const thinking = value("--thinking", "high");
  const reps = Number(value("--reps", "2"));
  const concurrency = Number(value("--concurrency", "8"));
  const datasetFile = path.resolve(value("--dataset", DATASET));
  const variants = values("--variant").length ? values("--variant") : Object.keys(VARIANTS_V2);
  const only = new Set(values("--item"));
  const items = loadReal(datasetFile).filter(item => !only.size || only.has(item.id));
  const label = value("--label", modelSpec.split("/").at(-1)!).replace(/[^A-Za-z0-9._-]+/g, "-");
  const runtime = await ModelRuntime.create();
  if (modelSpec.startsWith("cliproxyapi/")) await loadProviderExtensions(runtime, ["npm:@router-for-me/pi-cliproxyapi-provider"], { cwd: process.cwd() });
  const [provider, ...rest] = modelSpec.split("/");
  const model = runtime.getModel(provider!, rest.join("/"));
  if (!model) throw new Error(`${modelSpec} is not available`);
  const dir = path.join(path.dirname(datasetFile), "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const here = path.dirname(new URL(import.meta.url).pathname);
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify({ startedAt: new Date().toISOString(), model: modelSpec, thinking, reps, variants, items: items.length,
    sha256: { dataset: sha256(datasetFile), "run-real.ts": sha256(path.join(here, "run-real.ts")), "extract.py": sha256(path.join(here, "extract.py")), "variants-v2.ts": sha256(path.join(ROOT, "experiments/judgment/variants-v2.ts")), "src/orchestrator/instructions.ts": sha256(path.join(ROOT, "src/orchestrator/instructions.ts")), "src/extension/workers.ts": sha256(path.join(ROOT, "src/extension/workers.ts")) } }, null, 2)}\n`);
  const jobs = variants.flatMap(variant => Array.from({ length: reps }, (_unused, rep) => items.map(item => ({ item, variant, rep: rep + 1 }))).flat());
  const out = fs.createWriteStream(path.join(dir, "raw.jsonl"));
  let next = 0, done = 0, cost = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < jobs.length) {
      const { item, variant, rep } = jobs[next++]!;
      const started = Date.now();
      let call: RawCallV2 | undefined;
      for (let attempt = 1; attempt <= 2 && !call?.text; attempt++) {
        try {
          const message = await runtime.completeSimple(model, { systemPrompt: WORKER_INSTRUCTIONS, messages: [{ role: "user", content: prompt(item, variant), timestamp: Date.now() }] }, { reasoning: thinking as never, signal: AbortSignal.timeout(300_000) });
          const text = message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
          call = { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, condition: "one-turn", text, usage: message.usage as RawCallV2["usage"], ...(message.stopReason === "error" ? { error: message.errorMessage ?? "error" } : {}) };
        } catch (caught) {
          call = { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, condition: "one-turn", error: caught instanceof Error ? caught.message : String(caught) };
        }
      }
      cost += call!.usage?.cost?.total ?? 0;
      out.write(`${JSON.stringify(call)}\n`);
      if (++done % 25 === 0 || done === jobs.length) console.log(`${done}/${jobs.length} calls, $${cost.toFixed(3)}`);
    }
  }));
  await new Promise<void>(resolve => out.end(resolve));
  console.log(`Wrote ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) await main();
