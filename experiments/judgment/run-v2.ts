// Split-judgment evaluation v2 (docs/orchestrator.md 8): the product's orchestrator prompt, two conditions.
//
// - agentic (fixture items marked "agentic" in tasks-v2.json): a real pi session (src/pi/session-factory.ts createSession) in a
//   fresh git copy of the fixture repository, with the read-only tool set, the product's orche_spawn tool description (calling it
//   ends the run) and split_decision. The model looks at the repository and decides, as the orchestrator does before working.
// - one-turn (all other items): one model call, no tools, the hand-off with the repository listing and main's size note.
// Both render the assignment with the product code: assignmentPrompt() (src/extension/workers.ts) with
// orchestratorSection(<variant>) (src/orchestrator/instructions.ts), and the orche_task worker system instructions.
//
// Usage: npx --no-install tsx experiments/judgment/run-v2.ts --model <provider>/<model> [--thinking high] [--reps 2] [--rep-start 1]
//          [--variant NAME]... [--item ID]... [--condition agentic|one-turn] [--agentic-fixtures] [--concurrency 6] [--label NAME]
// Writes experiments/judgment/runs-v2/<stamp>-<label>/{meta.json,raw.jsonl}; score-v2.ts reads them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadProviderExtensions } from "../../src/pi/provider-extensions.ts";
import { createSession } from "../../src/pi/session-factory.ts";
import { READ_ONLY_TOOL_NAMES } from "../../src/tools/index.ts";
import { assignmentPrompt, workerSystemInstructions } from "../../src/extension/workers.ts";
import { orchestratorSection } from "../../src/orchestrator/instructions.ts";
import { createSpawnTool, SPAWN_TOOL } from "../../src/orchestrator/spawn.ts";
import { HERE, ROOT, loadItems, sha256, type Item, type RawCall } from "./eval.ts";
import { VARIANTS_V2 } from "./variants-v2.ts";

export const TASKS_V2 = path.join(HERE, "tasks-v2.json");
export type ItemV2 = Item & { condition: "agentic" | "one-turn"; scope?: string };
export const loadItemsV2 = (): ItemV2[] => loadItems(TASKS_V2) as ItemV2[];
/**
 * The worker system instructions orche_task gives an orchestrator session (src/extension/workers.ts). The pre-registered v2 runs
 * (runs-v2/*-main-*, *-retry-*) used the text of that time, `${taskWorkerInstructions}\nYou work alone: there are no peer workers.
 * Reply in the language of the request.`, and "You work alone; there are no peers or backlog." in the assignment; both were
 * changed after those runs (docs/orchestrator.md 9) and later runs (runs-v2/*-teamline-*) use the product function.
 */
export const WORKER_INSTRUCTIONS = workerSystemInstructions(true);
export const MAX_AGENTIC_TURNS = 30;

/** The request main hands over in the single workflow; one-turn items add the repository listing and main's size note. */
export function handoff(item: ItemV2): string {
  return [
    `Intent/Purpose: ${item.title}.`,
    item.role === "answer" ? "Requirements: answer everything the Original request asks, with evidence; do not change files." : "Requirements: complete everything the Original request asks, with tests and passing project checks.",
    "Original request:",
    item.instruction,
    ...(item.condition === "one-turn" ? ["", "Repository files:", ...item.files.map(file => `- ${file}`), ...(item.scope ? ["", item.scope] : [])] : []),
  ].join("\n");
}

const AGENTIC_NOTE = "Evaluation run (decision step only). Nothing will be implemented in this run: edit, write, bash, task_plan and report_result are not available. Look at the repository with the read-only tools as you would before starting, then call split_decision exactly once with the decision you would act on: split (true when at least one criterion applies), the criteria that apply (including one you would apply later, such as an independent verifier after you implement), the parallel units with the files each would own when parallelism applies, and the reason. Calling orche_spawn also counts as your decision and ends the run.";
const ONE_TURN_NOTE = `Evaluation run (decision step only, one turn): decide now from this hand-off, the repository listing and the size note, without tools. Reply with JSON only:
{"split": true|false, "criteria": {"parallelism": true|false, "isolation": true|false, "verification": true|false}, "units": [{"name": "short name", "files": ["owned files or directories"]}], "reason": "one or two sentences"}
"units" lists the parallel units when parallelism is true, otherwise []. "split" is true exactly when at least one criterion is true. Include a criterion you would apply later (for example an independent verifier after you implement).`;

/** The orchestrator's first assignment exactly as the product renders it, with `variant` as the split instruction, plus the evaluation note. */
export function prompt(item: ItemV2, variant: string): string {
  const judgment = VARIANTS_V2[variant];
  if (!judgment) throw new Error(`Unknown variant ${variant}; known: ${Object.keys(VARIANTS_V2).join(", ")}`);
  const assignment = assignmentPrompt({ role: item.role, request: handoff(item), mainMode: "single", orchestrate: true }, [], false, undefined, orchestratorSection(judgment));
  return `${assignment}\n\n${item.condition === "agentic" ? AGENTIC_NOTE : ONE_TURN_NOTE}`;
}

const decisionParameters = Type.Object({
  split: Type.Boolean(),
  criteria: Type.Object({ parallelism: Type.Boolean(), isolation: Type.Boolean(), verification: Type.Boolean() }),
  units: Type.Array(Type.Object({ name: Type.String(), files: Type.Array(Type.String()) })),
  reason: Type.String(),
});

/** Copy of the fixture repository in a fresh git work tree (as the e2e driver prepares it). */
function workspace(item: ItemV2): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `judgment-v2-${item.id}-`));
  fs.cpSync(path.join(ROOT, "fixtures", item.fixture!, "repo"), dir, { recursive: true });
  for (const args of [["init", "--quiet"], ["add", "--force", "."], ["-c", "user.name=judgment", "-c", "user.email=judgment@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Initial task"]]) execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  return dir;
}

type Usage = NonNullable<RawCall["usage"]>;
const addUsage = (total: Usage, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } }) => {
  total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite;
  total.cost = { total: (total.cost?.total ?? 0) + (usage.cost?.total ?? 0) };
};

export interface RawCallV2 extends RawCall { condition: "agentic" | "one-turn"; turns?: number; tools?: Record<string, number>; decidedVia?: string }

async function agentic(runtime: ModelRuntime, modelSpec: string, thinking: string, item: ItemV2, variant: string, rep: number): Promise<RawCallV2> {
  const started = Date.now();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
  const tools: Record<string, number> = {};
  let decision: { text: string; via: string } | undefined;
  let turns = 0;
  const cwd = workspace(item);
  const decide: ToolDefinition = {
    name: "split_decision", label: "Split decision", description: "Record your split decision (evaluation run). Ends the run.",
    parameters: decisionParameters,
    execute: async (_id, args) => {
      decision ??= { text: JSON.stringify(args), via: "split_decision" };
      return { content: [{ type: "text", text: "Decision recorded." }], details: {}, terminate: true };
    },
  };
  const product = createSpawnTool(() => "unused");
  const spawn: ToolDefinition = {
    ...product,
    execute: async (_id, args) => {
      const params = args as { reason: string; workers: { name: string; role: string; files?: string[] }[] };
      const criteria = { parallelism: params.reason === "parallelism", isolation: params.reason === "isolation", verification: params.reason === "verification" };
      decision ??= { text: JSON.stringify({ split: true, criteria, units: params.reason === "parallelism" ? params.workers.map(worker => ({ name: worker.name, files: worker.files ?? [] })) : [], reason: `orche_spawn ${params.reason}` }), via: SPAWN_TOOL };
      return { content: [{ type: "text", text: "Evaluation run: decision recorded; no sub-worker was started." }], details: undefined, terminate: true };
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), 600_000);
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let error: string | undefined;
  try {
    session = await createSession({ route: { role: item.role, model: modelSpec, thinking: thinking as never }, cwd, modelRuntime: runtime,
      tools: [...READ_ONLY_TOOL_NAMES, "split_decision", SPAWN_TOOL], customTools: [decide, spawn], instructions: WORKER_INSTRUCTIONS });
    const active = session;
    controller.signal.addEventListener("abort", () => { void active.abort(); }, { once: true });
    session.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        addUsage(usage, event.message.usage);
        for (const part of event.message.content) if (part.type === "toolCall") tools[part.name] = (tools[part.name] ?? 0) + 1;
        if (event.message.stopReason === "error") error = event.message.errorMessage ?? "model error";
      }
      if (event.type === "turn_end" && ++turns >= MAX_AGENTIC_TURNS && !decision) controller.abort(new Error(`no decision within ${MAX_AGENTIC_TURNS} turns`));
    });
    await session.prompt(prompt(item, variant));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
    session?.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (controller.signal.aborted && !decision) error = String((controller.signal.reason as Error)?.message ?? "aborted");
  return { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, condition: "agentic", turns, tools, usage,
    ...(decision ? { text: decision.text, decidedVia: decision.via } : { error: error ?? "no decision" }) };
}

async function oneTurn(runtime: ModelRuntime, modelSpec: string, thinking: string, item: ItemV2, variant: string, rep: number): Promise<RawCallV2> {
  const [provider, ...rest] = modelSpec.split("/");
  const model = runtime.getModel(provider!, rest.join("/"))!;
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const message = await runtime.completeSimple(model, { systemPrompt: WORKER_INSTRUCTIONS, messages: [{ role: "user", content: prompt(item, variant), timestamp: Date.now() }] },
        { reasoning: thinking as never, signal: AbortSignal.timeout(300_000) });
      const text = message.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
      const call: RawCallV2 = { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, condition: "one-turn", text, usage: message.usage as RawCall["usage"], ...(message.stopReason === "error" ? { error: message.errorMessage ?? "error" } : {}) };
      if (!call.error || call.text || attempt >= 2) return call;
    } catch (caught) {
      if (attempt >= 2) return { item: item.id, variant, rep, model: modelSpec, thinking, ms: Date.now() - started, condition: "one-turn", error: caught instanceof Error ? caught.message : String(caught) };
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const values = (name: string) => argv.flatMap((arg, index) => arg === name && argv[index + 1] ? [argv[index + 1]!] : []);
  const value = (name: string, fallback: string) => values(name).at(-1) ?? fallback;
  const modelSpec = value("--model", "");
  if (!/^[^/]+\/.+$/.test(modelSpec)) throw new Error("--model <provider>/<model> is required");
  const thinking = value("--thinking", "high");
  const reps = Number(value("--reps", "2"));
  const repStart = Number(value("--rep-start", "1"));
  const concurrency = Number(value("--concurrency", "6"));
  const variants = values("--variant").length ? values("--variant") : Object.keys(VARIANTS_V2);
  const conditions = new Set(values("--condition").length ? values("--condition") : ["agentic", "one-turn"]);
  const onlyItems = new Set(values("--item"));
  const label = value("--label", modelSpec.split("/").at(-1)!).replace(/[^A-Za-z0-9._-]+/g, "-");
  // --agentic-fixtures: the pre-registered extension (docs/orchestrator.md 8.3): every fixture item is judged in the agentic condition.
  const agenticFixtures = argv.includes("--agentic-fixtures");
  const items = loadItemsV2().map(item => agenticFixtures && item.fixture ? { ...item, condition: "agentic" as const } : item)
    .filter(item => conditions.has(item.condition) && (!onlyItems.size || onlyItems.has(item.id)));
  const runtime = await ModelRuntime.create();
  if (modelSpec.startsWith("cliproxyapi/")) await loadProviderExtensions(runtime, ["npm:@router-for-me/pi-cliproxyapi-provider"], { cwd: process.cwd() });
  if (!runtime.getModel(modelSpec.split("/")[0]!, modelSpec.split("/").slice(1).join("/"))) throw new Error(`${modelSpec} is not available`);
  const dir = path.join(HERE, "runs-v2", `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const hashed = ["tasks-v2.json", "variants-v2.ts", "variants.ts", "eval.ts", "run-v2.ts"];
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify({ startedAt: new Date().toISOString(), model: modelSpec, thinking, reps, repStart, variants, conditions: [...conditions], agenticFixtures, items: items.map(item => `${item.id}:${item.condition}`),
    sha256: Object.fromEntries([...hashed.map(file => [file, sha256(path.join(HERE, file))]), ["src/orchestrator/instructions.ts", sha256(path.join(ROOT, "src/orchestrator/instructions.ts"))], ["src/extension/workers.ts", sha256(path.join(ROOT, "src/extension/workers.ts"))]]) }, null, 2)}\n`);
  const jobs = variants.flatMap(variant => Array.from({ length: reps }, (_unused, rep) => items.map(item => ({ item, variant, rep: repStart + rep }))).flat())
    .sort((a, b) => Number(b.item.condition === "agentic") - Number(a.item.condition === "agentic"));
  const out = fs.createWriteStream(path.join(dir, "raw.jsonl"));
  let done = 0;
  let cost = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < jobs.length) {
      const { item, variant, rep } = jobs[next++]!;
      const call = item.condition === "agentic" ? await agentic(runtime, modelSpec, thinking, item, variant, rep) : await oneTurn(runtime, modelSpec, thinking, item, variant, rep);
      cost += call.usage?.cost?.total ?? 0;
      out.write(`${JSON.stringify(call)}\n`);
      if (++done % 10 === 0 || done === jobs.length) console.log(`${done}/${jobs.length} calls, $${cost.toFixed(3)}`);
    }
  }));
  await new Promise<void>(resolve => out.end(resolve));
  console.log(`Wrote ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) await main();
