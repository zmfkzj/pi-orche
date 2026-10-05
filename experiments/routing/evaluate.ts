// Offline routing evaluation (G-R, docs/specialist-orchestration.md 10.1): how well a model picks the work type of a user message.
// Any classifier or chat model can be an arm, so another router candidate is one flag away.
//
// Usage: npx --no-install tsx experiments/routing/evaluate.ts [--arm SPEC]... [--label NAME] [--concurrency 8] [--provider-extension SRC]... [--limit N]
// Arm specs:
//   majority | rules
//   classifier:<provider>/<model>                      e.g. classifier:typesafe/jev-latest (reported gated, as designed, and raw)
//   llm:<provider>/<model>[:<thinking>][:<prompt>]     e.g. llm:cliproxyapi/claude-opus-5-5:high
//     prompt: front (default: the product's work-type rule, src/single/work-types.ts), v1 (the pre-registered prompt), omorche
// Default arms: majority, rules, classifier:typesafe/jev-latest, llm:cliproxyapi/gpt-6.1-sol:high:front
// Providers come from Pi's credentials; a cliproxyapi arm loads its provider extension automatically.
// Data and outputs stay in the local, unversioned results/routing-eval/ (the labelled requests are the user's own sessions):
// each run writes runs/<stamp>-<label>/{report.md,report.json,raw.json}, and runs/index.md compares every run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { loadProviderExtensions } from "../../src/pi/provider-extensions.ts";
import { WORK_TYPES } from "../../src/single/work-types.ts";
import {
  classifierOutcome, classifierState, descriptorOf, readAnswers, ROUTER_QUESTIONS, rulesDescriptor, topologyOf, TOPOLOGIES,
  type Descriptor, type RouterInput, type Topology, type Turn,
} from "./router.ts";

type Row = Record<string, any>;
const data = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../results/routing-eval");
const argv = process.argv.slice(2);
const values = (name: string) => argv.flatMap((arg, index) => arg === name && argv[index + 1] ? [argv[index + 1]!] : []);
const value = (name: string, fallback: string) => values(name).at(-1) ?? fallback;
const DEFAULT_ARMS = ["majority", "rules", "classifier:typesafe/jev-latest", "llm:cliproxyapi/gpt-6.1-sol:high:front"];
const specs = values("--arm").length ? values("--arm") : DEFAULT_ARMS;
const concurrency = Number(value("--concurrency", "8"));
const limit = Number(value("--limit", "0"));
const label = value("--label", "run").replace(/[^A-Za-z0-9._-]+/g, "-");
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLIPROXY = "npm:@router-for-me/pi-cliproxyapi-provider";

// ---- the labelled set: sampled requests (this machine) + the creation set (imported sessions) ----
const readJsonl = (file: string): Row[] => fs.readFileSync(path.join(data, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const sample = new Map(readJsonl("sample.jsonl").map(row => [row.id, row]));
const allItems = [
  ...readJsonl("labels.confirmed.jsonl").map((label): Row => ({ ...sample.get(label.id)!, label })),
  ...readJsonl("creation.confirmed.jsonl"),
].map(row => ({ id: row.id as string, set: (row.id as string).startsWith("m") ? "creation" : "sample", text: row.text as string, firstTurn: row.firstTurn as boolean,
  previous: row.firstTurn ? undefined : (row.prevAssistant as string) || "(previous reply not captured)", label: row.label as Row }));
const items = limit > 0 ? allItems.slice(0, limit) : allItems;
type Item = typeof items[number];
const truth = (item: Item) => item.label.topology as Topology;
const inputOf = (item: Item): RouterInput => ({ request: item.text, ...(item.previous ? { previous: item.previous } : {}) });

// ---- prompts of LLM arms ----
const FORMAT = 'Answer exactly: {"topology":"respond|investigation|execution|creation","turn":"new|approval|correction|constraint|report|question|reformat"}. "turn" is how the message relates to the previous reply: new (always when there is none), approval, correction, constraint, report (the previous result is wrong or does not work), question, reformat.';
const PROMPTS: Record<string, string> = {
  // The product text: what the main session reads in single mode.
  front: `You route one user message for a coding assistant. Classify its work type and answer with JSON only.\n${WORK_TYPES}\n${FORMAT}`,
  // The pre-registered G-R prompt (2026-10-04), kept for reproducibility.
  v1: `You route one user message for a coding assistant. Classify it by these definitions and answer with JSON only.
- respond: the message only asks to restate or reformat the assistant's previous reply (translate, rewrite, summarize it) without new work.
- investigation: the user wants information only (an explanation, analysis, review, evaluation, comparison, opinion, proposal, plan, search or the location of something) and has not asked for or authorized any change.
- execution: the user asks for or authorizes a change to code, files, documents, configuration, a repository or a running system, including "fix it if needed", "review and rewrite", or approving what the previous reply proposed. A bare bug report (an error, a log or "it does not work" without an instruction) is also execution: the assistant will diagnose and fix it.
- creation: the user asks to make an open-ended creative artifact (an image, icon, thumbnail, cover, skin, visual theme, effect, UI look, name or slogan) where several distinct candidates would be worth producing and comparing.
Also classify "turn", how the message relates to the previous reply: new (always when there is no previous reply), approval, correction, constraint, report (the previous result is wrong or does not work), question, reformat.
Answer exactly: {"topology":"respond|investigation|execution|creation","turn":"new|approval|correction|constraint|report|question|reformat"}`,
  // om-orche's Judgment/Production policy: the main agent's own choice in that plugin. Judgment -> investigation, Production -> execution.
  omorche: `You are the main agent of a coding assistant with two execution policies.
- Judgment delivers an explanation, analysis, judgment, proposal or design. It never changes the product: analysis-only is not permission to change code, config or assets.
- Production delivers a real change to code, files, features, assets or state.
Choosing: ask what the user must receive for the request to be done. Explanation, analysis, judgment, proposal or design alone -> Judgment. A real change to code, files, features, assets or state -> Production. Both -> a Judgment -> Production transition; if the user already asked for both, the request needs Production. Analysis or proposal only -> Judgment, even when the fix becomes clear; if permission to change the product is unclear, give the result and the decision needed. Saving findings as a Markdown file or writing a throwaway experiment script does not make it Production.
Decide which policy the user's message needs overall. Answer exactly: {"policy":"Judgment|Production"}`,
};
const userMessage = (item: Item) => {
  const state = classifierState(inputOf(item));
  return `Previous assistant reply (end): ${state.previous ?? "(none: this is the first message)"}\n\nUser message:\n${state.request}`;
};
function parseJson(text: string): Row | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  try { return match ? JSON.parse(match[0]) : undefined; } catch { return undefined; }
}
async function pool<T, R>(list: readonly T[], width: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, width) }, async () => { while (next < list.length) { const index = next++; out[index] = await run(list[index]!, index); } }));
  return out;
}

interface Prediction { topology: Topology | null; turn?: Turn | null }
interface ArmRun { name: string; spec: string; predictions: Prediction[]; raw: Row[]; latencyMs: number[]; usage?: Row; failures: string[] }
interface Spec { kind: "majority" | "rules" | "classifier" | "llm"; provider?: string; model?: string; thinking?: string; prompt?: string; raw: string }
function parseSpec(raw: string): Spec {
  if (raw === "majority" || raw === "rules") return { kind: raw, raw };
  const match = /^(classifier|llm):([^/:\s]+)\/([^:\s]+)((?::[A-Za-z0-9_-]+)*)$/.exec(raw);
  if (!match) throw new Error(`Bad arm spec ${raw}; expected majority, rules, classifier:<provider>/<model> or llm:<provider>/<model>[:<thinking>][:<prompt>]`);
  const [, kind, provider, model, suffix] = match;
  const parts = suffix!.split(":").filter(Boolean);
  const thinking = parts.find(part => THINKING.includes(part));
  const prompt = parts.find(part => part in PROMPTS);
  const unknown = parts.filter(part => part !== thinking && part !== prompt);
  if (unknown.length) throw new Error(`Bad arm spec ${raw}: unknown ${unknown.join(", ")} (thinking: ${THINKING.join("|")}; prompt: ${Object.keys(PROMPTS).join("|")})`);
  if (kind === "classifier" && (thinking || prompt)) throw new Error(`Bad arm spec ${raw}: classifiers take no thinking or prompt`);
  return { kind: kind as Spec["kind"], provider: provider!, model: model!, ...(kind === "llm" ? { thinking: thinking ?? "high", prompt: prompt ?? "front" } : {}), raw };
}

async function runArms(parsed: Spec[]): Promise<ArmRun[]> {
  const runtime = await ModelRuntime.create();
  const extensions = new Set([...values("--provider-extension"), ...(parsed.some(spec => spec.provider === "cliproxyapi") ? [CLIPROXY] : [])]);
  if (extensions.size) await loadProviderExtensions(runtime, [...extensions], { cwd: process.cwd() });
  const runs: ArmRun[] = [];
  for (const spec of parsed) {
    if (spec.kind === "majority") { runs.push({ name: "majority", spec: spec.raw, predictions: items.map(() => ({ topology: "execution" })), raw: [], latencyMs: [], failures: [] }); continue; }
    if (spec.kind === "rules") {
      runs.push({ name: "rules", spec: spec.raw, raw: [], latencyMs: [], failures: [], predictions: items.map(item => { const d = rulesDescriptor(inputOf(item)); return { topology: topologyOf(d, inputOf(item)), turn: item.previous ? d.turn : "new" }; }) });
      continue;
    }
    if (spec.kind === "classifier") {
      const model = runtime.getModelOfType("classifier", spec.provider!, spec.model!);
      if (!model) throw new Error(`${spec.provider}/${spec.model} is not a classifier in Pi's catalog`);
      const raw = await pool(items, 4, async item => {
        const started = Date.now();
        let outcome: { answers?: Record<string, ClassifierAnswer>; error?: string };
        try { outcome = classifierOutcome(await runtime.classify(model, { state: classifierState(inputOf(item)), questions: ROUTER_QUESTIONS }, { signal: AbortSignal.timeout(20_000) })); }
        catch (error) { outcome = classifierOutcome(undefined, error); }
        return { id: item.id, ms: Date.now() - started, ...outcome };
      });
      for (const gated of [true, false]) {
        runs.push({ name: `${spec.provider}/${spec.model}${gated ? "" : " (raw)"}`, spec: spec.raw, raw: gated ? raw : [], latencyMs: raw.map(run => run.ms), failures: raw.filter(run => run.error).map(run => `${run.id}: ${run.error}`),
          predictions: items.map((item, index) => {
            const rules: Descriptor = rulesDescriptor(inputOf(item));
            // A failed call routes by the rules descriptor, as a product would.
            const answers = raw[index]!.answers;
            const d = answers ? descriptorOf(readAnswers(answers), rules, { gated }) : rules;
            return { topology: topologyOf(d, inputOf(item)), turn: item.previous ? d.turn : "new" };
          }) });
      }
      continue;
    }
    const model = runtime.getModel(spec.provider!, spec.model!);
    if (!model) throw new Error(`${spec.provider}/${spec.model} is not available (credentials or provider extension missing?)`);
    const raw = await pool(items, concurrency, async item => {
      const started = Date.now();
      try {
        const message = await runtime.completeSimple(model, { systemPrompt: PROMPTS[spec.prompt!]!, messages: [{ role: "user", content: userMessage(item), timestamp: Date.now() }] },
          { reasoning: spec.thinking as never, signal: AbortSignal.timeout(240_000) });
        const text = message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
        return { id: item.id, ms: Date.now() - started, parsed: parseJson(text), text: text.slice(0, 400), usage: message.usage, error: message.stopReason === "error" ? message.errorMessage : undefined };
      } catch (error) { return { id: item.id, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }; }
    });
    const usage = (["input", "output", "cacheRead", "cacheWrite"] as const).reduce((sum, key) => ({ ...sum, [key]: raw.reduce((n, run) => n + (run.usage?.[key] ?? 0), 0) }), {} as Row);
    usage.costUSD = raw.reduce((n, run) => n + (run.usage?.cost?.total ?? 0), 0);
    runs.push({ name: `${spec.provider}/${spec.model}:${spec.thinking} ${spec.prompt}`, spec: spec.raw, raw, latencyMs: raw.map(run => run.ms), usage,
      failures: raw.filter(run => !run.parsed).map(run => `${run.id}: ${run.error ?? run.text}`),
      predictions: items.map((item, index) => {
        const parsed = raw[index]!.parsed;
        if (spec.prompt === "omorche") return { topology: parsed?.policy === "Production" ? "execution" : parsed?.policy === "Judgment" ? "investigation" : null };
        return { topology: TOPOLOGIES.includes(parsed?.topology) ? parsed!.topology : null, turn: item.previous ? parsed?.turn ?? null : "new" };
      }) });
  }
  return runs;
}

function metrics(run: ArmRun): Row {
  const list = run.predictions;
  const changes = (topology: Topology | null) => topology === "execution" || topology === "creation";
  const indexed = items.map((item, i) => [item, i] as const);
  const recall = Object.fromEntries(TOPOLOGIES.map(t => { const of = indexed.filter(([item]) => truth(item) === t); return [t, of.length ? of.filter(([, i]) => list[i]!.topology === t).length / of.length : null]; }));
  const predicted = Object.fromEntries([...TOPOLOGIES, null].map(t => [String(t), list.filter(p => p.topology === t).length]));
  // Unauthorized change: the router would change something the user did not ask or authorize.
  const unauthorized = indexed.filter(([item, i]) => changes(list[i]!.topology) && !changes(truth(item))).map(([item]) => item.id);
  const missedChange = indexed.filter(([item, i]) => !changes(list[i]!.topology) && changes(truth(item))).map(([item]) => item.id);
  const followUps = indexed.filter(([item, i]) => !item.firstTurn && list[i]!.turn !== undefined);
  const sorted = [...run.latencyMs].sort((a, b) => a - b);
  return {
    name: run.name, spec: run.spec, accuracy: indexed.filter(([item, i]) => list[i]!.topology === truth(item)).length / items.length, recall, predicted,
    maxShareGap: Math.max(...TOPOLOGIES.map(t => Math.abs(list.filter(p => p.topology === t).length - items.filter(item => truth(item) === t).length) / items.length)),
    changeAccuracy: indexed.filter(([item, i]) => changes(list[i]!.topology) === changes(truth(item))).length / items.length,
    unauthorizedChange: { rate: unauthorized.length / items.length, ids: unauthorized }, missedChange: { rate: missedChange.length / items.length, ids: missedChange },
    ...(followUps.length ? { turnAccuracy: { correct: followUps.filter(([item, i]) => list[i]!.turn === item.label.turn).length, followUps: followUps.length } } : {}),
    latency: sorted.length ? { medianMs: sorted[Math.floor(sorted.length / 2)], p90Ms: sorted[Math.floor(sorted.length * 0.9)] } : null,
    ...(run.usage ? { usage: run.usage } : {}), failures: run.failures.slice(0, 10), failureCount: run.failures.length,
    errors: indexed.filter(([item, i]) => list[i]!.topology !== truth(item)).map(([item, i]) => `${item.id}:${truth(item)[0]}->${list[i]!.topology?.[0] ?? "?"}`),
  };
}

// G-R (10.1): accuracy >= 85% and not below the other model arms; every class recall >= 0.75; share gap <= 15 points; turn >= 80%; unauthorized change <= 2%.
function gate(all: Row[], arm: Row): Row {
  const peers = all.filter(other => other !== arm && other.name !== "majority" && !String(other.name).endsWith("(raw)"));
  return { accuracy: arm.accuracy >= 0.85, notBelowOthers: peers.every(other => arm.accuracy >= other.accuracy), recall: Object.values(arm.recall).every(v => v === null || (v as number) >= 0.75),
    shareGap: arm.maxShareGap <= 0.15, turn: arm.turnAccuracy ? arm.turnAccuracy.correct / arm.turnAccuracy.followUps >= 0.8 : null, unauthorized: arm.unauthorizedChange.rate <= 0.02 };
}

const pct = (v: number | null | undefined) => v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`;
const tableRow = (run: string, a: Row) => `| ${run}${a.name} | ${pct(a.accuracy)} | ${pct(a.changeAccuracy)} | ${pct(a.unauthorizedChange.rate)} (${a.unauthorizedChange.ids.length}) | ${pct(a.missedChange.rate)} | ${TOPOLOGIES.map(t => pct(a.recall[t])).join(" / ")} | ${a.turnAccuracy ? `${a.turnAccuracy.correct}/${a.turnAccuracy.followUps}` : "n/a"} | ${a.latency ? `${(a.latency.medianMs / 1000).toFixed(2)} s` : "-"} | ${typeof a.usage?.costUSD === "number" ? `$${a.usage.costUSD.toFixed(3)}` : "-"} |`;
const HEADER = ["| Arm | Accuracy | Change acc. | Unauthorized change | Missed change | respond / investigation / execution / creation recall | Turn | Median latency | Catalog cost |", "|---|---:|---:|---:|---:|---|---|---:|---:|"];

function writeIndex() {
  const dir = path.join(data, "runs");
  const reports = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "report.json"))).map(entry => entry.name).sort();
  const lines = ["# Routing evaluation runs", "", "Every run of experiments/routing/evaluate.ts over the local labelled set, oldest first. Catalog cost is the provider catalog price; subscription and proxy billing differ.", "", ...HEADER];
  for (const name of reports) {
    const report = JSON.parse(fs.readFileSync(path.join(dir, name, "report.json"), "utf8"));
    for (const arm of report.arms) lines.push(tableRow(`${name} · `, arm));
  }
  fs.writeFileSync(path.join(dir, "index.md"), lines.join("\n") + "\n"); fs.chmodSync(path.join(dir, "index.md"), 0o600);
}

async function main() {
  const parsed = specs.map(parseSpec);
  const runs = await runArms(parsed);
  const arms = runs.map(metrics);
  for (const arm of arms) if (arm.name !== "majority") arm.gate = gate(arms, arm);
  const at = new Date().toISOString();
  const dir = path.join(data, "runs", `${at.replace(/[:.]/g, "-")}-${label}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const report = { at, items: items.length, truth: Object.fromEntries(TOPOLOGIES.map(t => [t, items.filter(item => truth(item) === t).length])), specs, arms };
  const write = (file: string, text: string) => { fs.writeFileSync(path.join(dir, file), text); fs.chmodSync(path.join(dir, file), 0o600); };
  write("report.json", JSON.stringify(report, null, 1));
  write("raw.json", JSON.stringify(runs.map(run => ({ name: run.name, spec: run.spec, raw: run.raw })), null, 1));
  const lines = [`# Routing evaluation ${at} (${label})`, "", `${items.length} requests, truth ${JSON.stringify(report.truth)}.`, "", ...HEADER, ...arms.map(arm => tableRow("", arm)), "",
    "G-R checks (accuracy >= 85% and not below other model arms, class recall >= 0.75, share gap <= 15 points, turn >= 80%, unauthorized change <= 2%):", "", "```",
    ...arms.filter(arm => arm.gate).map(arm => `${arm.name}: ${JSON.stringify(arm.gate)}`), "```", "", "Errors (id:truth->predicted):", "",
    ...arms.filter(arm => arm.name !== "majority").map(arm => `- ${arm.name}: ${arm.errors.join(", ") || "none"}${arm.failureCount ? `; ${arm.failureCount} failed calls` : ""}`)];
  write("report.md", lines.join("\n") + "\n");
  writeIndex();
  console.log(lines.slice(0, 6 + arms.length).join("\n"));
  console.log(`\nWrote ${dir}`);
}
await main();
