/**
 * Thinking-policy comparison harness (docs/thinking-policy.md): the same task and the same Task DAG under four arms of
 * orche.config.json `thinkingPolicy`, through the REAL implementation (WorkerPool.execute → orche's AgentManager and session factory →
 * Pi's AgentSession, task_plan, the report rewrite at B, the output-limit recovery) and a deterministic, scripted faux model. No paid call.
 *
 * What it can show: whether each arm's MECHANICS do what they claim (which effort every request ran at, whether a rework ran at the
 * baseline, whether a premature report was caught, whether an overrun was recovered by splitting or by a step-down, whether a report
 * claimed success for wrong work). What it cannot show: answer quality, how often a real model behaves like any scenario, real token
 * counts or latency. The scenario behaviours below are ASSUMPTIONS written into the script, e.g. "a hard step done at the step effort
 * comes out wrong". A real-model A/B on real tasks is the only evidence for quality (docs/thinking-policy.md, "Evaluation").
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage as reply, fauxProvider, fauxThinking as thinking, fauxToolCall as call,
  InMemoryCredentialStore, type AssistantMessage, type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { OrcheController } from "../../src/extension/controller.js";
import { TaskFailedError, WorkerPool, type TaskDetails } from "../../src/extension/workers.js";

/**
 * The four arms (orche.config.json `thinkingPolicy` values). Checkpoints are required only in c and d; a and b accept plans in the
 * format from before the policy (no phase/hard/checkpoint fields). In every arm a node whose checkpoint says its verification
 * failed cannot be done (a model that sends no checkpoint never meets that rule).
 */
export const ARMS = {
  a_fixed: "fixed",
  b_phase_plain: { mode: "phase", checkpoints: false, escalation: false, lengthRecovery: "step-down", subWorkers: false, gate: false, evidence: "off" },
  c_phase_full: "phase",
  d_fixed_checkpoints: { mode: "fixed", checkpoints: true, lengthRecovery: "redecompose" },
} as const;
export type ArmName = keyof typeof ARMS;

/**
 * Scenario behaviours (assumptions). The DAG is always s1 → s2 → s3 → i (integration of R1-R3, phase "integrate"); each sN writes
 * sN.txt; the truth is "every file right". s2 is flagged hard:true by the model except where noted. An overrun hits the first
 * (working) request of a node. Integration reads the files and reopens a wrong step and everything after it (rework); the model gives
 * a step up as blocked after two failed reworks and then reports honestly (partial).
 * - `plain`: nothing goes wrong at any effort.
 * - `overrun_at_baseline`: s2 (whole) overruns while reasoning at the baseline (high); at the step level, or split, it fits.
 * - `hidden_error`: the model does NOT flag s2 hard; s2 done below the baseline comes out wrong (a subtle bug), done at the baseline
 *   right. Only the integration (at the baseline) notices.
 * - `premature_report`: as hidden_error, and a model working at the step level reports right after the last step instead of
 *   integrating, claiming everything met.
 * - `integration_overrun`: the integration of all three requirements in one node overruns at the baseline; per requirement it fits.
 * - `stubborn`: every working request overruns.
 * - `legacy_plan`: a model that writes plans in the format from before the policy (no phase, hard or checkpoint fields; the
 *   integration node is an ordinary node to the runtime). Where the gate requires an integration node (arm c) task_plan refuses the
 *   first plan and the model marks its integration node from then on; where checkpoints are required (arms c, d) task_plan refuses
 *   the first node marked done without one and the model adds checkpoints from then on; arms a and b accept every plan as before.
 */
export const SCENARIOS = ["plain", "overrun_at_baseline", "hidden_error", "premature_report", "integration_overrun", "stubborn", "legacy_plan"] as const;
export type ScenarioName = typeof SCENARIOS[number];

const BASELINE = "high";
const REQUIREMENTS: Record<string, string> = { s1: "R1", s2: "R2", s3: "R3" };
const REQUEST = "Intent/Purpose: produce three result files\nRequirements:\nR1: s1.txt is right.\nR2: s2.txt is right.\nR3: s3.txt is right.\nConstraints and non-goals: no commits.\nAssumptions: none.\nOriginal request\nmake the three files";
const CAP = 32_000;

type Status = "pending" | "running" | "done" | "blocked" | "skipped";
interface SimNode { id: string; title: string; dependsOn: string[]; covers: string[]; status: Status; phase?: "integrate"; hard?: boolean; parent?: string; checkpoint?: { result: string; evidence: string[]; verification: "passed" | "failed" | "not_applicable" } }

const lastText = (context: { messages: unknown[] }) => JSON.stringify(context.messages.at(-1) ?? "");
const base = (id: string) => id.replace(/\..*$/, "");

/** The scripted model: one state machine per run, deciding from the request's effort, the last message and its own progress. */
function simulate(scenario: ScenarioName, counters: { output: number; simErrors: string[]; checkpointRejections: number }) {
  let nodes: SimNode[] = [];
  const legacy = scenario === "legacy_plan";
  /** legacy_plan: the model has seen the checkpoint requirement and sends checkpoints from then on. */
  let learned = false;
  /** legacy_plan under the gate: the model has seen the integration-node requirement and marks its integration node from then on. */
  let learnedPhase = false;
  const files: Record<string, "right" | "wrong"> = {};
  const worked = new Set<string>();
  const checked = new Set<string>();
  const reworks: Record<string, number> = {};
  let verified = false;
  const out = (message: AssistantMessage, tokens?: number) => { counters.output += tokens ?? Math.ceil(JSON.stringify(message.content).length / 4); return message; };
  const capped = () => out(reply([thinking("t".repeat(CAP * 4))], { stopReason: "length" }), CAP);
  const tool = (name: string, args: Record<string, unknown>) => out(reply([call(name, args as never)], { stopReason: "toolUse" }));
  const plan = () => tool("task_plan", { nodes: nodes.map(node => {
    if (!legacy) return { ...node };
    const { phase, hard: _hard, checkpoint, ...rest } = node;
    return { ...rest, ...(learnedPhase && phase ? { phase } : {}), ...(learned && checkpoint ? { checkpoint } : {}) };
  }) });
  const running = () => nodes.find(node => node.status === "running");
  const startNext = () => {
    const finished = new Set(nodes.filter(node => node.status === "done" || node.status === "skipped").map(node => node.id));
    const next = nodes.find(node => node.status === "pending" && node.dependsOn.every(id => finished.has(id)));
    if (next) next.status = "running";
  };
  const finish = (node: SimNode, verification: "passed" | "not_applicable" = "passed") => {
    node.status = "done";
    node.checkpoint = { result: `${node.id} finished`, evidence: [node.phase === "integrate" ? "read s1.txt s2.txt s3.txt → compared" : `${base(node.id)}.txt written`], verification };
  };
  const report = (forced: boolean) => {
    const believed = Object.keys(REQUIREMENTS).map(step => ({ step, met: !forced && (verified ? files[step] === "right" : files[step] !== undefined) }));
    const unmet = believed.filter(item => !item.met);
    return tool("report_result", {
      kind: "implement", summary: unmet.length ? "Partial: some requirements are not met" : "Done: all three files written",
      data: {
        status: unmet.length ? "blocked" : "done", reason: unmet.length ? "see checklist" : "all met",
        checklist: believed.map(item => item.met ? { id: REQUIREMENTS[item.step], status: "met", evidence: `${item.step}.txt`, verifiedBy: verified ? "integration read" : "written" } : { id: REQUIREMENTS[item.step], status: "unmet", evidence: `${item.step}.txt` }),
        split: { decision: "none", reason: "one sequential DAG" },
      },
    });
  };
  const overruns = (node: SimNode, level: string) =>
    scenario === "stubborn"
    || scenario === "overrun_at_baseline" && node.id === "s2" && level === BASELINE
    || scenario === "integration_overrun" && node.id === "i" && level === BASELINE;
  return ((context, options) => {
    const level = options?.reasoning ?? "off";
    const last = lastText(context as { messages: unknown[] });
    // The script always sends valid plans; a rejected call would mean the script and the tool disagree: recorded, not hidden.
    const lastMessage = (context as { messages: { role?: string; isError?: boolean; toolName?: string }[] }).messages.at(-1);
    if (legacy && lastMessage?.role === "toolResult" && lastMessage.isError && /Invalid checkpoints: \w+ is marked done without a checkpoint/.test(last)) {
      counters.checkpointRejections++;
      learned = true;
      return plan();
    }
    if (legacy && lastMessage?.role === "toolResult" && lastMessage.isError && /Task DAG gate .*the plan has no integration node/.test(last)) {
      counters.checkpointRejections++;
      learnedPhase = true;
      return plan();
    }
    if (lastMessage?.role === "toolResult" && lastMessage.isError && lastMessage.toolName !== "report_result") counters.simErrors.push(last.slice(0, 200));
    if (/output token limit/.test(last) && /report_result alone immediately/.test(last)) return scenario === "stubborn" ? capped() : report(true);
    if (/report_result was written at the reduced step effort/.test(last)) {
      const node = running();
      if (node) { if (worked.has(node.id)) finish(node, "not_applicable"); else node.status = "pending"; }
      startNext();
      return plan();
    }
    const integrationSplit = /Split the integration now/.test(last);
    const stepSplit = /split (?:the running node )?([\w.]+) into two or more smaller nodes/.exec(last);
    if (integrationSplit || stepSplit) {
      const node = running();
      if (node && (integrationSplit ? node.phase === "integrate" : true)) {
        node.status = "skipped";
        const parts: SimNode[] = integrationSplit
          ? Object.values(REQUIREMENTS).map((requirement, index) => ({ id: `${node.id}.${requirement}`, title: `Verify ${requirement}`, dependsOn: index ? [`${node.id}.${Object.values(REQUIREMENTS)[index - 1]}`] : [], covers: [requirement], status: index ? "pending" : "running", phase: "integrate", parent: node.id }))
          : [{ id: `${node.id}.a`, title: `${node.title} (part a)`, dependsOn: [], covers: node.covers, status: "running", parent: node.id }, { id: `${node.id}.b`, title: `${node.title} (part b)`, dependsOn: [`${node.id}.a`], covers: node.covers, status: "pending", parent: node.id }];
        const index = nodes.indexOf(node);
        const last = parts.at(-1)!.id;
        nodes = [...nodes.slice(0, index + 1), ...parts, ...nodes.slice(index + 1).map(item => item.dependsOn.includes(node.id) ? { ...item, dependsOn: [...item.dependsOn, last] } : item)];
        return plan();
      }
    }
    if (!nodes.length) {
      nodes = [
        { id: "s1", title: "Write s1.txt", dependsOn: [], covers: ["R1"], status: "running" },
        { id: "s2", title: "Write s2.txt", dependsOn: ["s1"], covers: ["R2"], status: "pending", ...(scenario === "hidden_error" || scenario === "premature_report" ? {} : { hard: true }) },
        { id: "s3", title: "Write s3.txt", dependsOn: ["s2"], covers: ["R3"], status: "pending" },
        { id: "i", title: "Integrate: compare R1-R3 with the files", dependsOn: ["s3"], covers: ["R1", "R2", "R3"], status: "pending", phase: "integrate" },
      ];
      return plan();
    }
    const node = running();
    if (!node) return report(false);
    if (overruns(node, level) && !worked.has(node.id) && !checked.has(node.id)) return capped();
    if (node.phase !== "integrate") {
      if (!worked.has(node.id)) {
        worked.add(node.id);
        const wrong = (scenario === "hidden_error" || scenario === "premature_report") && base(node.id) === "s2" && level !== BASELINE;
        files[base(node.id)] = wrong ? "wrong" : files[base(node.id)] === "wrong" && node.id !== base(node.id) ? "wrong" : "right";
        return tool("write", { path: `${base(node.id)}.txt`, content: `${base(node.id)} ${files[base(node.id)]}\n` });
      }
      finish(node, "not_applicable");
      startNext();
      // At the step effort a premature_report model reports right after the last step (believing every file is right).
      if (scenario === "premature_report" && level !== BASELINE && running()?.phase === "integrate") return report(false);
      return plan();
    }
    if (!checked.has(node.id)) { checked.add(node.id); return tool("read", { path: "s2.txt" }); }
    const covered = node.covers.map(requirement => Object.keys(REQUIREMENTS).find(step => REQUIREMENTS[step] === requirement)!);
    const wrong = covered.filter(step => files[step] === "wrong");
    if (wrong.length) {
      const step = wrong[0]!;
      reworks[step] = (reworks[step] ?? 0) + 1;
      checked.delete(node.id);
      const target = nodes.find(item => item.id === step)!;
      if (reworks[step]! > 2) {
        target.status = "blocked";
        // Blocked: the nodes after it cannot be done either.
        for (const item of nodes) if (item.dependsOn.includes(step) && item.phase !== "integrate") { item.status = "skipped"; delete item.checkpoint; }
        finish(node);
        verified = true;
        startNext();
        return plan();
      }
      // Reopen the wrong step (rework) and everything after it; integration waits for them again.
      const after = new Set([step]);
      for (const item of nodes) if (item.dependsOn.some(id => after.has(id)) && item.phase !== "integrate") after.add(item.id);
      for (const item of nodes) {
        if (item.status === "running") item.status = "pending";
        if (after.has(item.id) && item.status !== "skipped") { item.status = item.id === step ? "running" : "pending"; delete item.checkpoint; worked.delete(item.id); }
      }
      return plan();
    }
    finish(node);
    verified = true;
    startNext();
    return plan();
  }) as FauxResponseFactory;
}

export interface ArmResult {
  arm: ArmName;
  scenario: ScenarioName;
  /** The worker delivered a report (any status). */
  completed: boolean;
  /** Every requirement is really met at the end (ground truth of the script). */
  correct: boolean;
  /** Requirements really met. */
  requirementsMet: number;
  /** The report claims a requirement met that is not, or reports done while something is wrong. */
  falseSuccess: boolean;
  status: string;
  error?: string;
  requests: number;
  lengthStops: number;
  /** Length stops recovered (the report came after them). */
  recovered: boolean;
  /** The effort of every request, in order. */
  efforts: string[];
  /** The lowest effort any integration request ran at (undefined without one). */
  integrationEffort?: string;
  switches: number;
  redecompositions: number;
  /** Output tokens as counted by the script (32000 per overrun, ~4 characters per token otherwise): not a real tokenizer. */
  outputTokens: number;
  /** Tool errors the script did not expect (should be none: the script and the tools agree). */
  simErrors: string[];
  /** task_plan calls refused for a node marked done without a checkpoint (legacy_plan). */
  checkpointRejections: number;
}

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** One arm × scenario through WorkerPool.execute. */
export async function runArm(arm: ArmName, scenario: ScenarioName): Promise<ArmResult> {
  const root = await mkdtemp(join(tmpdir(), "orche-thinking-bench-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({ provider: `tp-${arm}-${scenario}-${Math.random().toString(36).slice(2, 6)}`, models: [{ id: "model", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 }] });
  const counters = { output: 0, simErrors: [] as string[], checkpointRejections: 0 };
  const efforts: string[] = [];
  const script = simulate(scenario, counters);
  faux.setResponses(Array.from({ length: 80 }, () => ((context, options, state, model) => {
    efforts.push(options?.reasoning ?? "off");
    return script(context, options, state, model);
  }) as FauxResponseFactory));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await writeFile(join(agentDir, "orche.config.json"), JSON.stringify({ routes: {}, default: { model: `${faux.provider.id}/model` }, records: { enabled: false }, mainMode: "single", thinkingPolicy: ARMS[arm] }));
  const controller = new OrcheController({ agentDir, createRuntime: async () => runtime });
  const pool = new WorkerPool({ controller, agentDir });
  let details: TaskDetails | undefined;
  let error: string | undefined;
  try {
    const result = await pool.execute({ role: "implement", request: REQUEST, cwd, projectTrusted: false, mainMode: "single", model: faux.getModel(), thinking: BASELINE as never });
    details = result.details;
  } catch (thrown) {
    if (thrown instanceof TaskFailedError) { details = thrown.details; error = thrown.message.split("\n")[0]; } else error = String(thrown);
  } finally {
    await pool.dispose();
  }
  const truth: Record<string, boolean> = {};
  for (const step of Object.keys(REQUIREMENTS)) truth[REQUIREMENTS[step]!] = (await readFile(join(cwd, `${step}.txt`), "utf8").catch(() => "")).includes("right");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  const checklist = details?.checklist ?? [];
  const correct = Object.values(truth).every(Boolean);
  const falseSuccess = (details?.status === "done" && !correct) || checklist.some(item => item.status === "met" && !truth[item.id]);
  const lengthStops = details?.lengthStops?.count ?? 0;
  const completed = !error && !!details && details.status !== undefined;
  return {
    arm, scenario, completed, correct, requirementsMet: Object.values(truth).filter(Boolean).length, falseSuccess,
    status: error ? "failed" : details?.status ?? "unknown", ...(error ? { error: error.slice(0, 160) } : {}),
    requests: efforts.length, lengthStops, recovered: lengthStops > 0 && completed,
    efforts, ...(minIntegration(efforts, scenario) ? { integrationEffort: minIntegration(efforts, scenario) } : {}),
    switches: details?.thinkingPolicy?.switches ?? 0, redecompositions: details?.thinkingPolicy?.redecompositions ?? 0, outputTokens: counters.output, simErrors: counters.simErrors, checkpointRejections: counters.checkpointRejections,
  };
}

/** The lowest effort of the last three requests (integration and report), a coarse view of the integration effort. */
function minIntegration(efforts: readonly string[], scenario: ScenarioName): string | undefined {
  if (scenario === "stubborn" || efforts.length < 3) return undefined;
  return efforts.slice(-3).reduce((low, effort) => ORDER.indexOf(effort) < ORDER.indexOf(low) ? effort : low);
}

export async function runMatrix(options: { arms?: readonly ArmName[]; scenarios?: readonly ScenarioName[]; repeat?: number } = {}): Promise<ArmResult[]> {
  const results: ArmResult[] = [];
  for (let round = 0; round < (options.repeat ?? 1); round++) {
    for (const arm of options.arms ?? Object.keys(ARMS) as ArmName[]) {
      for (const scenario of options.scenarios ?? SCENARIOS) results.push(await runArm(arm, scenario));
    }
  }
  return results;
}

/** Markdown: primary metrics first (correctness, false success, completion, length stops, recovery), secondary after. */
export function formatMatrix(results: readonly ArmResult[]): string {
  const rows = results.map(r => `| ${r.arm} | ${r.scenario} | ${r.correct ? "yes" : "no"} | ${r.requirementsMet}/3 | ${r.falseSuccess ? "**yes**" : "no"} | ${r.completed ? "yes" : "no"} (${r.status}${r.error ? `: ${r.error.slice(0, 50)}` : ""}) | ${r.lengthStops} | ${r.lengthStops ? (r.recovered ? "yes" : "no") : "-"} | ${r.integrationEffort ?? "-"} | ${r.requests} | ${r.switches} | ${r.redecompositions} | ${r.checkpointRejections} | ${r.outputTokens} | ${r.efforts.join(" ")} |`);
  const arms = [...new Set(results.map(r => r.arm))];
  const totals = arms.map(arm => {
    const mine = results.filter(r => r.arm === arm);
    return `| ${arm} | ${mine.filter(r => r.correct).length}/${mine.length} | ${mine.reduce((sum, r) => sum + r.requirementsMet, 0)}/${mine.length * 3} | ${mine.filter(r => r.falseSuccess).length} | ${mine.filter(r => r.completed).length}/${mine.length} | ${mine.reduce((sum, r) => sum + r.lengthStops, 0)} | ${mine.filter(r => r.recovered).length}/${mine.filter(r => r.lengthStops).length} | ${mine.reduce((sum, r) => sum + r.requests, 0)} | ${mine.reduce((sum, r) => sum + r.outputTokens, 0)} |`;
  });
  return [
    "| arm | scenario | correct | requirements met | false success | completed (status) | length stops | recovered | lowest effort, last 3 requests | requests | level switches | splits | checkpoint refusals | output tok (script) | effort per request |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "| arm | correct | requirements met | false successes | completed | length stops | recovered | requests | output tok (script) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...totals,
  ].join("\n");
}
