// G-R offline routing evaluation (docs/specialist-orchestration.md 10.1). One run, no tuning on its results.
// Arms: rules-only, Jev+rules (gated, the design), Jev raw (ungated), an LLM with our definitions (front decides),
// an LLM with om-orche's Judgment/Production policy (main self-choice), and the majority baseline.
// Usage: npx --no-install tsx experiments/routing/evaluate.ts [--llm-model cliproxyapi/gpt-6.1-sol] [--concurrency 6] [--skip-llm]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { loadProviderExtensions } from "../../src/pi/provider-extensions.ts";
import {
  classifierOutcome, classifierState, descriptorOf, readAnswers, ROUTER_QUESTIONS, rulesDescriptor, topologyOf, TOPOLOGIES,
  type Descriptor, type RouterInput, type Topology, type Turn,
} from "./router.ts";

type Row = Record<string, any>;
// Data and outputs stay in the local, unversioned results/routing-eval/ (the labelled requests are the user's own sessions).
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../results/routing-eval");
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1]! : fallback; };
const llmModel = flag("--llm-model", "cliproxyapi/gpt-6.1-sol");
const concurrency = Number(flag("--concurrency", "6"));
const skipLlm = args.includes("--skip-llm");
const readJsonl = (file: string): Row[] => fs.readFileSync(path.join(here, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

// ---- the labelled set: 100 sampled requests (this machine) + 23 creation-set requests (imported sessions) ----
const sample = new Map(readJsonl("sample.jsonl").map(row => [row.id, row]));
const items = [
  ...readJsonl("labels.confirmed.jsonl").map((label): Row => ({ ...sample.get(label.id)!, label })),
  ...readJsonl("creation.confirmed.jsonl"),
].map(row => ({ id: row.id as string, set: row.id.startsWith("m") ? "creation" : "sample", text: row.text as string, firstTurn: row.firstTurn as boolean,
  previous: row.firstTurn ? undefined : (row.prevAssistant as string) || "(previous reply not captured)", label: row.label as Row }));
const truth = (item: typeof items[number]) => item.label.topology as Topology;

// ---- LLM arms ----
const OURS = `You route one user message for a coding assistant. Classify it by these definitions and answer with JSON only.
- respond: the message only asks to restate or reformat the assistant's previous reply (translate, rewrite, summarize it) without new work.
- investigation: the user wants information only (an explanation, analysis, review, evaluation, comparison, opinion, proposal, plan, search or the location of something) and has not asked for or authorized any change.
- execution: the user asks for or authorizes a change to code, files, documents, configuration, a repository or a running system, including "fix it if needed", "review and rewrite", or approving what the previous reply proposed. A bare bug report (an error, a log or "it does not work" without an instruction) is also execution: the assistant will diagnose and fix it.
- creation: the user asks to make an open-ended creative artifact (an image, icon, thumbnail, cover, skin, visual theme, effect, UI look, name or slogan) where several distinct candidates would be worth producing and comparing.
Also classify "turn", how the message relates to the previous reply: new (always when there is no previous reply), approval, correction, constraint, report (the previous result is wrong or does not work), question, reformat.
Answer exactly: {"topology":"respond|investigation|execution|creation","turn":"new|approval|correction|constraint|report|question|reformat"}`;
const OMORCHE = `You are the main agent of a coding assistant with two execution policies.
- Judgment delivers an explanation, analysis, judgment, proposal or design. It never changes the product: analysis-only is not permission to change code, config or assets.
- Production delivers a real change to code, files, features, assets or state.
Choosing: ask what the user must receive for the request to be done. Explanation, analysis, judgment, proposal or design alone -> Judgment. A real change to code, files, features, assets or state -> Production. Both -> a Judgment -> Production transition; if the user already asked for both, the request needs Production. Analysis or proposal only -> Judgment, even when the fix becomes clear; if permission to change the product is unclear, give the result and the decision needed. Saving findings as a Markdown file or writing a throwaway experiment script does not make it Production.
Decide which policy the user's message needs overall. Answer exactly: {"policy":"Judgment|Production"}`;
const prompt = (item: typeof items[number]) => {
  const state = classifierState({ request: item.text, ...(item.previous ? { previous: item.previous } : {}) });
  return `Previous assistant reply (end): ${state.previous ?? "(none: this is the first message)"}\n\nUser message:\n${state.request}`;
};
function parseJson(text: string): Row | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  try { return match ? JSON.parse(match[0]) : undefined; } catch { return undefined; }
}

async function pool<T, R>(list: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, width) }, async () => { while (next < list.length) { const index = next++; out[index] = await run(list[index]!); } }));
  return out;
}

async function main() {
  const runtime = await ModelRuntime.create();
  const jev = runtime.getModelOfType("classifier", "typesafe", "jev-latest");
  if (!jev) throw new Error("typesafe/jev-latest is not available");
  // ---- Jev: one call per request answers every question ----
  const jevRuns = await pool(items, 4, async item => {
    const input: RouterInput = { request: item.text, ...(item.previous ? { previous: item.previous } : {}) };
    const started = Date.now();
    let outcome: { answers?: Record<string, ClassifierAnswer>; error?: string };
    try { outcome = classifierOutcome(await runtime.classify(jev, { state: classifierState(input), questions: ROUTER_QUESTIONS }, { signal: AbortSignal.timeout(20_000) })); }
    catch (error) { outcome = classifierOutcome(undefined, error); }
    return { id: item.id, ms: Date.now() - started, ...outcome };
  });
  // ---- LLM arms ----
  let llm: { ours: Row[]; omorche: Row[] } | undefined;
  if (!skipLlm) {
    const [provider, ...rest] = llmModel.split("/");
    if (provider === "cliproxyapi") await loadProviderExtensions(runtime, ["npm:@router-for-me/pi-cliproxyapi-provider"], { cwd: process.cwd() });
    const model = runtime.getModel(provider!, rest.join("/"));
    if (!model) throw new Error(`${llmModel} is not available`);
    const ask = async (system: string, item: typeof items[number]) => {
      const started = Date.now();
      try {
        const message = await runtime.completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: prompt(item), timestamp: Date.now() }] }, { reasoning: "high", signal: AbortSignal.timeout(180_000) });
        const text = message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
        return { id: item.id, ms: Date.now() - started, parsed: parseJson(text), text: text.slice(0, 400), usage: message.usage, stopReason: message.stopReason, error: message.errorMessage };
      } catch (error) { return { id: item.id, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }; }
    };
    llm = { ours: await pool(items, concurrency, item => ask(OURS, item)), omorche: await pool(items, concurrency, item => ask(OMORCHE, item)) };
  }

  // ---- predictions ----
  const predictions: Record<string, { topology: Topology | null; turn?: Turn | null }[]> = { majority: [], rules: [], "jev-gated": [], "jev-raw": [], ...(llm ? { "llm-ours": [], "llm-omorche": [] } : {}) };
  items.forEach((item, index) => {
    const input: RouterInput = { request: item.text, ...(item.previous ? { previous: item.previous } : {}) };
    const rules: Descriptor = rulesDescriptor(input);
    predictions.majority!.push({ topology: "execution" });
    predictions.rules!.push({ topology: topologyOf(rules, input), turn: item.previous ? rules.turn : "new" });
    const run = jevRuns[index]!;
    for (const [arm, gated] of [["jev-gated", true], ["jev-raw", false]] as const) {
      // A failed classifier call routes by the rules descriptor, as the product would.
      const descriptor = run.answers ? descriptorOf(readAnswers(run.answers), rules, { gated }) : rules;
      predictions[arm]!.push({ topology: topologyOf(descriptor, input), turn: item.previous ? descriptor.turn : "new" });
    }
    if (llm) {
      const ours = llm.ours[index]!.parsed, omorche = llm.omorche[index]!.parsed;
      predictions["llm-ours"]!.push({ topology: TOPOLOGIES.includes(ours?.topology) ? ours!.topology : null, turn: item.previous ? ours?.turn ?? null : "new" });
      predictions["llm-omorche"]!.push({ topology: omorche?.policy === "Production" ? "execution" : omorche?.policy === "Judgment" ? "investigation" : null });
    }
  });

  // ---- metrics ----
  const changes = (topology: Topology | null) => topology === "execution" || topology === "creation";
  const report: Row = { at: new Date().toISOString(), items: items.length, sets: { sample: items.filter(i => i.set === "sample").length, creation: items.filter(i => i.set === "creation").length },
    truth: Object.fromEntries(TOPOLOGIES.map(t => [t, items.filter(item => truth(item) === t).length])), llmModel: skipLlm ? null : llmModel, arms: {} as Row };
  for (const [arm, list] of Object.entries(predictions)) {
    const correct = items.filter((item, i) => list[i]!.topology === truth(item)).length;
    const recall = Object.fromEntries(TOPOLOGIES.map(t => { const of = items.map((item, i) => [item, i] as const).filter(([item]) => truth(item) === t); return [t, of.length ? of.filter(([, i]) => list[i]!.topology === t).length / of.length : null]; }));
    const predicted = Object.fromEntries([...TOPOLOGIES, null].map(t => [String(t), list.filter(p => p.topology === t).length]));
    const shareGap = Math.max(...TOPOLOGIES.map(t => Math.abs(list.filter(p => p.topology === t).length - items.filter(item => truth(item) === t).length) / items.length));
    // Unauthorized change: the router would change something the user did not ask or authorize (truth plan without a change).
    const unauthorized = items.filter((item, i) => changes(list[i]!.topology) && !changes(truth(item))).map(item => item.id);
    const missedChange = items.filter((item, i) => !changes(list[i]!.topology) && changes(truth(item))).map(item => item.id);
    const followUps = items.map((item, i) => [item, i] as const).filter(([item, i]) => !item.firstTurn && list[i]!.turn !== undefined);
    const turnCorrect = followUps.filter(([item, i]) => list[i]!.turn === item.label.turn).length;
    const errors = items.map((item, i) => [item, i] as const).filter(([item, i]) => list[i]!.topology !== truth(item)).map(([item, i]) => `${item.id}:${truth(item)[0]}->${list[i]!.topology?.[0] ?? "?"}`);
    report.arms[arm] = {
      accuracy: correct / items.length, correct, recall, predicted, maxShareGap: shareGap,
      changeAccuracy: items.filter((item, i) => changes(list[i]!.topology) === changes(truth(item))).length / items.length,
      unauthorizedChange: { rate: unauthorized.length / items.length, ids: unauthorized }, missedChange: { rate: missedChange.length / items.length, ids: missedChange },
      ...(followUps.length ? { turnAccuracy: { correct: turnCorrect, followUps: followUps.length, rate: turnCorrect / followUps.length } } : {}),
      bySet: Object.fromEntries(["sample", "creation"].map(set => { const of = items.map((item, i) => [item, i] as const).filter(([item]) => item.set === set); return [set, of.filter(([item, i]) => list[i]!.topology === truth(item)).length / of.length]; })),
      errors,
    };
  }
  const jevMs = jevRuns.map(run => run.ms).sort((a, b) => a - b);
  report.jev = { calls: jevRuns.length, failed: jevRuns.filter(run => run.error).map(run => `${run.id}: ${run.error}`), medianMs: jevMs[Math.floor(jevMs.length / 2)], p90Ms: jevMs[Math.floor(jevMs.length * 0.9)],
    accepted: Object.fromEntries(Object.keys(ROUTER_QUESTIONS).map(key => [key, jevRuns.filter(run => run.answers && (readAnswers(run.answers) as Row)[key]?.accepted).length])) };
  if (llm) for (const [arm, runs] of Object.entries(llm)) {
    const ms = runs.map(run => run.ms).sort((a, b) => a - b);
    report[`llm-${arm}`] = { calls: runs.length, unparsed: runs.filter(run => !run.parsed).map(run => `${run.id}: ${run.error ?? run.text}`).slice(0, 10), medianMs: ms[Math.floor(ms.length / 2)], p90Ms: ms[Math.floor(ms.length * 0.9)],
      usage: ["input", "output", "cacheRead"].reduce((sum, key) => ({ ...sum, [key]: runs.reduce((n, run) => n + (run.usage?.[key] ?? 0), 0) }), {} as Row) };
  }
  // G-R (10.1): accuracy >= 0.85 and not below other arms; every class recall >= 0.75; biggest share gap <= 0.15; turn >= 0.8; unauthorized change <= 2%.
  const gr = (arm: string) => {
    const a = report.arms[arm]; if (!a) return null;
    const others = Object.entries(report.arms).filter(([name]) => name !== arm && name !== "jev-raw" && name !== "majority").map(([, value]) => (value as Row).accuracy as number);
    return { accuracy: a.accuracy >= 0.85, notBelowOthers: others.every(value => a.accuracy >= value), recall: Object.values(a.recall).every(value => value === null || (value as number) >= 0.75),
      shareGap: a.maxShareGap <= 0.15, turn: a.turnAccuracy ? a.turnAccuracy.rate >= 0.8 : null, unauthorized: a.unauthorizedChange.rate <= 0.02 };
  };
  report.gate = Object.fromEntries(Object.keys(report.arms).filter(arm => arm !== "majority").map(arm => [arm, gr(arm)]));
  const raw = { jev: jevRuns, llm };
  fs.writeFileSync(path.join(here, "eval-raw.json"), JSON.stringify(raw, null, 1)); fs.chmodSync(path.join(here, "eval-raw.json"), 0o600);
  fs.writeFileSync(path.join(here, "eval-report.json"), JSON.stringify(report, null, 1)); fs.chmodSync(path.join(here, "eval-report.json"), 0o600);
  const pct = (value: number | null | undefined) => value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const lines = [`# G-R routing evaluation (${report.at})`, "", `${items.length} requests: truth ${JSON.stringify(report.truth)}. LLM arms: ${report.llmModel ?? "skipped"}.`, "",
    "| Arm | Accuracy | respond / investigation / execution / creation recall | Predicted r/i/e/c/none | Max share gap | Change acc. | Unauthorized change | Missed change | Turn (follow-ups) |",
    "|---|---:|---|---|---:|---:|---:|---:|---|"];
  for (const [arm, a] of Object.entries(report.arms) as [string, Row][]) {
    lines.push(`| ${arm} | ${pct(a.accuracy)} (${a.correct}) | ${TOPOLOGIES.map(t => pct(a.recall[t])).join(" / ")} | ${[...TOPOLOGIES, "null"].map(t => a.predicted[t]).join("/")} | ${pct(a.maxShareGap)} | ${pct(a.changeAccuracy)} | ${pct(a.unauthorizedChange.rate)} (${a.unauthorizedChange.ids.length}) | ${pct(a.missedChange.rate)} (${a.missedChange.ids.length}) | ${a.turnAccuracy ? `${a.turnAccuracy.correct}/${a.turnAccuracy.followUps}` : "n/a"} |`);
  }
  lines.push("", `Jev: ${report.jev.calls} calls, ${report.jev.failed.length} failed, median ${report.jev.medianMs} ms, p90 ${report.jev.p90Ms} ms; answers accepted by the gate: ${JSON.stringify(report.jev.accepted)}.`);
  if (llm) for (const arm of ["llm-ours", "llm-omorche"]) lines.push(`${arm}: ${report[arm].calls} calls, ${report[arm].unparsed.length} unparsed, median ${(report[arm].medianMs / 1000).toFixed(1)} s, usage ${JSON.stringify(report[arm].usage)}.`);
  lines.push("", "G-R checks:", "```", JSON.stringify(report.gate, null, 1), "```");
  fs.writeFileSync(path.join(here, "eval-report.md"), lines.join("\n") + "\n"); fs.chmodSync(path.join(here, "eval-report.md"), 0o600);
  console.log(lines.join("\n"));
}
await main();
