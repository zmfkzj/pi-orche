/**
 * Decision memory (workerCompaction.decisionMemory) versus the basic work log, measured offline.
 *
 * Both arms run under `essentials: "extended"`; the only difference is the work-log section that orche restores after a compaction
 * (src/extension/workers.ts taskCompactionFor): `renderWorkLog` (control) or `renderDecisionWorkLog` (treatment), each applied to the
 * SAME tool-call ledger and Task DAG. What this measures is the information a compacted worker gets back (which call ids, failures and
 * files are named, and how many bytes that costs). It does not measure model behaviour, task success or tokens of a real compaction:
 * both renderers name a call by id and target only, never its output, so "retained" means "addressable in the transcript", not "content
 * preserved".
 *
 * Two sources:
 * - fixture scenarios with a ground truth fixed before rendering (`needed`), including cases where decision memory is expected to lose;
 * - a replay of real worker transcripts (orche records), cut at their real compactions and at the middle of long assignments, with the
 *   evidence the worker cited AFTER the cut as the independent "needed later" set (classified exactly as orche classifies evidence).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { renderWorkLog } from "../../src/pi/compaction-state.js";
import { renderDecisionWorkLog, DECISION_MEMORY_LIMITS } from "../../src/pi/decision-memory.js";
import { summaryBudgetNote } from "../../src/pi/summary-budget.js";
import { BOOKKEEPING_TOOLS, classifyEvidence, evidenceLedgerOf, recordToolCall, resetEvidence, type EvidenceLedger, type ToolRecord } from "../../src/pi/tool-evidence.js";
import type { TaskPlan } from "../../src/tools/task-plan.js";

export type Arm = "basic" | "decision";
export const ARMS: readonly Arm[] = ["basic", "decision"];

export function render(arm: Arm, ledger: EvidenceLedger, plan: TaskPlan | undefined): string {
  return arm === "decision" ? renderDecisionWorkLog(ledger, plan) : renderWorkLog(ledger);
}

/** Call ids a rendered work log names (both renderers write `(call <id>` ...). */
export function shownCallIds(text: string): Set<string> {
  return new Set([...text.matchAll(/\(call ([^;)]+)[;)]/g)].map(match => match[1]!));
}
/** Call ids a rendered work log names as failed. */
export function shownFailureIds(text: string): Set<string> {
  return new Set([...text.matchAll(/^- FAILED .*\(call ([^;)]+)[;)]/gm)].map(match => match[1]!));
}

/** Facts derived from the ledger alone (independent of either renderer). */
export function ledgerFacts(ledger: EvidenceLedger) {
  const calls = ledger.calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
  const key = (call: ToolRecord) => `${call.name}::${call.target ?? ""}`;
  const latest = new Map<string, ToolRecord>();
  for (const call of calls) latest.set(key(call), call);
  const failures = calls.filter(call => call.isError);
  const unresolved = failures.filter(call => latest.get(key(call)) === call);
  const resolved = failures.filter(call => latest.get(key(call)) !== call && !latest.get(key(call))!.isError);
  const files = [...new Set(calls.filter(call => !call.isError && ["edit", "write", "ast_rewrite"].includes(call.name) && call.target).map(call => call.target!))];
  const position = new Map(calls.map((call, index) => [call.toolCallId, calls.length - index]));
  return { calls, unresolved, resolved, files, position };
}

export interface ArmMetrics {
  bytes: number;
  shownCalls: number;
  neededRetained: number;
  neededTotal: number;
  unresolvedShown: number;
  unresolvedTotal: number;
  /** Failures already superseded by a later success of the same tool and target that are still shown as FAILED. */
  staleFailuresShown: number;
  filesShown: number;
  filesTotal: number;
  /** Shown call ids outside the scenario's needed set (fixtures only; the share of the log a reader does not need). */
  unneededShown: number;
}

export function measure(text: string, ledger: EvidenceLedger, needed: readonly string[]): ArmMetrics {
  const facts = ledgerFacts(ledger);
  const shown = shownCallIds(text);
  const failed = shownFailureIds(text);
  const fileLine = text.split("\n").find(line => line.startsWith("Files changed")) ?? "";
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    shownCalls: shown.size,
    neededRetained: needed.filter(id => shown.has(id)).length,
    neededTotal: needed.length,
    unresolvedShown: facts.unresolved.filter(call => failed.has(call.toolCallId)).length,
    unresolvedTotal: facts.unresolved.length,
    staleFailuresShown: facts.resolved.filter(call => failed.has(call.toolCallId)).length,
    filesShown: facts.files.filter(file => fileLine.includes(file)).length,
    filesTotal: facts.files.length,
    unneededShown: [...shown].filter(id => !needed.includes(id)).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixture scenarios: the ledger is built with orche's own recordToolCall; `needed` is fixed here, before anything is rendered.

interface Step { id: string; tool: string; input: Record<string, unknown>; node?: string; error?: boolean }
export interface Scenario {
  name: string;
  /** What the scenario probes and which arm the design predicts to keep more; "negative" = decision memory is expected to lose. */
  probe: string;
  expectation: "decision-better" | "basic-better" | "mixed";
  steps: Step[];
  plan?: TaskPlan;
  /** Call ids the next step after the compaction needs (cited checkpoint evidence, unresolved failures, edited files, the last check). */
  needed: string[];
}

const read = (id: string, path: string, node?: string): Step => ({ id, tool: "read", input: { path }, ...(node ? { node } : {}) });
const bash = (id: string, command: string, node?: string, error = false): Step => ({ id, tool: "bash", input: { command }, ...(node ? { node } : {}), ...(error ? { error } : {}) });
const edit = (id: string, path: string, node?: string): Step => ({ id, tool: "edit", input: { path }, ...(node ? { node } : {}) });
const node = (id: string, status: string, evidence?: string[]) => ({ id, title: id, status, dependsOn: [], covers: ["R1"], ...(evidence ? { checkpoint: { result: `${id} done`, evidence, verification: "passed" } } : {}) });
const plan = (...nodes: ReturnType<typeof node>[]) => ({ nodes }) as unknown as TaskPlan;
const range = (n: number, make: (i: number) => Step): Step[] => Array.from({ length: n }, (_, i) => make(i));

export const SCENARIOS: Scenario[] = [
  {
    name: "cited-old-evidence",
    probe: "checkpoint-cited calls older than the basic log's newest 12 commands / 12 other calls",
    expectation: "decision-better",
    steps: [read("spec", "docs/spec.md", "inspect"), bash("baseline", "npm test", "inspect"), edit("fix", "src/a.ts", "implement"),
      ...range(14, i => read(`r${i}`, `src/m${i}.ts`, "implement")), ...range(13, i => bash(`b${i}`, `npx vitest run case${i}`, "implement"))],
    plan: plan(node("inspect", "done", ["T1 read docs/spec.md", "T2 npm test -> 120 pass"]), node("implement", "running"), node("verify", "pending")),
    needed: ["spec", "baseline", "fix", "b12"],
  },
  {
    name: "old-unresolved-failure",
    probe: "NEGATIVE: an unresolved build failure followed by more than 12 calls (outside decision memory's recent-error window)",
    expectation: "basic-better",
    steps: [bash("build", "npm run build", "implement", true), ...range(14, i => read(`r${i}`, `src/m${i}.ts`, "implement"))],
    plan: plan(node("implement", "running"), node("verify", "pending")),
    needed: ["build"],
  },
  {
    name: "resolved-failure-noise",
    probe: "a failed test that a later run of the same command fixed: the basic log still lists it as FAILED",
    expectation: "decision-better",
    steps: [bash("t1", "npm test", "implement", true), edit("fix", "src/a.ts", "implement"), bash("t2", "npm test", "implement"), read("r1", "src/b.ts", "implement")],
    plan: plan(node("implement", "running"), node("verify", "pending")),
    needed: ["fix", "t2"],
  },
  {
    name: "no-task-dag",
    probe: "NEGATIVE: no Task DAG, so decision memory falls back to the newest 4 successful calls",
    expectation: "basic-better",
    steps: [read("spec", "docs/spec.md"), ...range(9, i => read(`r${i}`, `src/m${i}.ts`)), edit("fix", "src/a.ts"), ...range(6, i => bash(`b${i}`, `npx vitest run case${i}`))],
    needed: ["spec", "fix", "b5"],
  },
  {
    name: "active-node-flood",
    probe: "NEGATIVE/mixed: many active-node calls fill the 18-call cap before all 6 cited calls fit",
    expectation: "mixed",
    steps: [...range(6, i => read(`c${i}`, `docs/c${i}.md`, "inspect")), ...range(4, i => bash(`b${i}`, `npx vitest run case${i}`, "implement")),
      ...range(14, i => read(`r${i}`, `src/m${i}.ts`, "implement"))],
    plan: plan(node("inspect", "done", ["T1 T2 T3 T4 T5 T6 read docs"]), node("implement", "running")),
    needed: ["c0", "c1", "c2", "c3", "c4", "c5", "b3"],
  },
];

export function buildLedger(steps: readonly Step[]): EvidenceLedger {
  const session = {};
  resetEvidence(session, true);
  steps.forEach((step, index) => recordToolCall(session, { toolCallId: step.id, toolName: step.tool, input: step.input, isError: step.error === true },
    { request: index + 1, atBaseline: true, ...(step.node ? { node: step.node } : {}) }));
  return evidenceLedgerOf(session);
}

export interface ScenarioResult { name: string; probe: string; expectation: Scenario["expectation"]; arms: Record<Arm, ArmMetrics> }

export function runScenarios(scenarios: readonly Scenario[] = SCENARIOS): ScenarioResult[] {
  return scenarios.map(scenario => {
    const ledger = buildLedger(scenario.steps);
    const arms = Object.fromEntries(ARMS.map(arm => [arm, measure(render(arm, ledger, scenario.plan), ledger, scenario.needed)])) as Record<Arm, ArmMetrics>;
    return { name: scenario.name, probe: scenario.probe, expectation: scenario.expectation, arms };
  });
}

/** The second change decision memory makes: extra lines in the summary request (a real compaction's model prompt). */
export function summaryNoteDelta(tokens = 8000) {
  const off = summaryBudgetNote(tokens, { profile: "compact" });
  const on = summaryBudgetNote(tokens, { profile: "compact", decisionMemory: true });
  return { offBytes: Buffer.byteLength(off), onBytes: Buffer.byteLength(on), addedBytes: Buffer.byteLength(on) - Buffer.byteLength(off) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Replay of real worker transcripts.

interface Entry { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } }
interface ToolCallPart { type: "toolCall"; id: string; name: string; arguments?: unknown }

export interface CutMetrics {
  kind: "real" | "synthetic-mid";
  preCutCalls: number;
  hasPlan: boolean;
  /** Share of pre-cut calls attributed to a Task DAG node (decision memory's "active" selection needs it). */
  nodeLinkedShare: number;
  /** Evidence items written after the cut (task_plan checkpoints, report_result) that resolve to pre-cut calls. */
  laterItems: number;
  arms: Record<Arm, ArmMetrics & { laterItemsResolvable: number }>;
}

const evidenceStrings = (name: string, args: unknown): string[] => {
  if (!args || typeof args !== "object") return [];
  const value = args as Record<string, unknown>;
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  if (name === "task_plan") return (Array.isArray(value.nodes) ? value.nodes : []).flatMap((n: { checkpoint?: { evidence?: unknown } }) => strings(n?.checkpoint?.evidence));
  if (name === "report_result") {
    const data = (value.data ?? {}) as Record<string, unknown>;
    return [...strings(data.evidence), ...(Array.isArray(data.checklist) ? data.checklist : []).flatMap((item: Record<string, unknown>) =>
      [item?.evidence, item?.verifiedBy].filter((text): text is string => typeof text === "string"))];
  }
  return [];
};

interface Snapshot { kind: CutMetrics["kind"]; ledger: EvidenceLedger; plan?: TaskPlan; preIds: Set<string> }

/**
 * Replay one worker transcript. Every user message starts an assignment (orche resets the ledger and the plan); tool calls are
 * recorded with orche's recordToolCall, the running node taken from the latest successful task_plan call; a cut is taken at each
 * real compaction entry and at the middle (by call count) of every assignment with at least `minCallsForMid` calls.
 */
export async function replayTranscript(file: string, options: { minCallsForMid?: number } = {}): Promise<CutMetrics[]> {
  const minMid = options.minCallsForMid ?? 24;
  const out: CutMetrics[] = [];
  type Assignment = { session: object; plan?: TaskPlan; snapshots: Snapshot[]; later: { snapshotIndex: number; items: string[] }[]; checks: number };
  let current: Assignment | undefined;
  const pending = new Map<string, ToolCallPart>();

  const snapshot = (a: Assignment, kind: Snapshot["kind"]): Snapshot => {
    const ledger = evidenceLedgerOf(a.session);
    const copy: EvidenceLedger = { ...ledger, calls: ledger.calls.slice() };
    const plan = a.plan ? (JSON.parse(JSON.stringify(a.plan)) as TaskPlan) : undefined;
    return { kind, ledger: copy, ...(plan ? { plan } : {}), preIds: new Set(copy.calls.map(call => call.toolCallId)) };
  };
  const finish = (a: Assignment | undefined) => {
    if (!a) return;
    // The synthetic middle cut: replay the assignment's calls up to its middle and take the snapshot there.
    const ledger = evidenceLedgerOf(a.session);
    const checks = ledger.calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
    const cuts: { snap: Snapshot; after: string[] }[] = [];
    for (const [index, snap] of a.snapshots.entries()) cuts.push({ snap, after: a.later.filter(l => l.snapshotIndex > index).flatMap(l => l.items) });
    if (checks.length >= minMid) {
      const middle = checks[Math.floor(checks.length / 2) - 1]!;
      const cutAt = ledger.calls.indexOf(middle) + 1;
      const calls = ledger.calls.slice(0, cutAt);
      const snap: Snapshot = { kind: "synthetic-mid", ledger: { ...ledger, calls }, preIds: new Set(calls.map(call => call.toolCallId)), ...(planAt(a, middle) ? { plan: planAt(a, middle)! } : {}) };
      cuts.push({ snap, after: itemsAfter(a, middle.toolCallId) });
    }
    for (const { snap, after } of cuts) out.push(evaluateCut(snap, after));
  };
  // Per assignment: the plan in force after each call and the evidence items with the call they followed.
  const plans = new WeakMap<Assignment, Map<string, TaskPlan | undefined>>();
  const items = new WeakMap<Assignment, { afterCall: string | undefined; items: string[] }[]>();
  const planAt = (a: Assignment, call: ToolRecord) => plans.get(a)?.get(call.toolCallId);
  const itemsAfter = (a: Assignment, callId: string) => {
    const list = items.get(a) ?? [];
    const ids = evidenceLedgerOf(a.session).calls.map(call => call.toolCallId);
    const cut = ids.indexOf(callId);
    return list.filter(entry => entry.afterCall !== undefined && ids.indexOf(entry.afterCall) > cut).flatMap(entry => entry.items);
  };

  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; } catch { continue; }
    if (entry.type === "compaction" && current) {
      current.snapshots.push(snapshot(current, "real"));
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") {
      finish(current);
      const session = {};
      resetEvidence(session, true);
      current = { session, snapshots: [], later: [], checks: 0 };
      plans.set(current, new Map());
      items.set(current, []);
      pending.clear();
      continue;
    }
    if (!current) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ToolCallPart[]) if (part?.type === "toolCall" && part.id) pending.set(part.id, part);
      continue;
    }
    if (message.role === "toolResult" && message.toolCallId) {
      const call = pending.get(message.toolCallId);
      const name = message.toolName ?? call?.name ?? "unknown";
      const input = call?.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : undefined;
      if (name === "task_plan" && !message.isError && input && Array.isArray(input.nodes)) current.plan = { nodes: input.nodes } as unknown as TaskPlan;
      const running = current.plan?.nodes.find(n => n.status === "running")?.id;
      const record = recordToolCall(current.session, { toolCallId: message.toolCallId, toolName: name, ...(input ? { input } : {}), isError: message.isError === true },
        { request: ++current.checks, atBaseline: true, ...(running ? { node: running } : {}) });
      plans.get(current)!.set(record.toolCallId, current.plan ? (JSON.parse(JSON.stringify(current.plan)) as TaskPlan) : undefined);
      const evidence = message.isError ? [] : evidenceStrings(name, input);
      if (evidence.length) {
        items.get(current)!.push({ afterCall: record.toolCallId, items: evidence });
        current.later.push({ snapshotIndex: current.snapshots.length, items: evidence });
      }
    }
  }
  finish(current);
  return out;
}

function evaluateCut(snap: Snapshot, laterItems: string[]): CutMetrics {
  const pre = snap.ledger;
  // task_plan re-sends the whole DAG: evidence already in the plan at the cut is restored verbatim with the plan, so only items
  // first written after the cut count (each distinct string once).
  const known = new Set((snap.plan?.nodes ?? []).flatMap(n => n.checkpoint?.evidence ?? []));
  const fresh = [...new Set(laterItems)].filter(item => !known.has(item));
  const resolvedItems = fresh
    .map(item => classifyEvidence(item, pre, { fromRequest: 0 }))
    .filter(check => check.calls.length > 0 && check.calls.every(call => snap.preIds.has(call.toolCallId)));
  const neededIds = [...new Set(resolvedItems.flatMap(check => check.calls.map(call => call.toolCallId)))];
  const checks = pre.calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name));
  const arms = Object.fromEntries(ARMS.map(arm => {
    const text = render(arm, pre, snap.plan);
    const shown = shownCallIds(text);
    return [arm, { ...measure(text, pre, neededIds), laterItemsResolvable: resolvedItems.filter(check => check.calls.some(call => shown.has(call.toolCallId))).length }];
  })) as CutMetrics["arms"];
  return {
    kind: snap.kind,
    preCutCalls: checks.length,
    hasPlan: !!snap.plan?.nodes?.length,
    nodeLinkedShare: checks.length ? checks.filter(call => call.node).length / checks.length : 0,
    laterItems: resolvedItems.length,
    arms,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Aggregation.

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]!;
};
const ratio = (num: number, den: number) => den ? Math.round((num / den) * 1000) / 1000 : null;

export function aggregateCuts(cuts: readonly CutMetrics[]) {
  const group = (filter: (cut: CutMetrics) => boolean) => {
    const list = cuts.filter(filter);
    const arm = (a: Arm) => {
      const sum = (pick: (m: CutMetrics["arms"][Arm]) => number) => list.reduce((total, cut) => total + pick(cut.arms[a]), 0);
      return {
        bytesMedian: quantile(list.map(cut => cut.arms[a].bytes), 0.5),
        bytesP95: quantile(list.map(cut => cut.arms[a].bytes), 0.95),
        shownCallsMedian: quantile(list.map(cut => cut.arms[a].shownCalls), 0.5),
        laterItemsResolvable: sum(m => m.laterItemsResolvable),
        laterItemRecall: ratio(sum(m => m.laterItemsResolvable), list.reduce((total, cut) => total + cut.laterItems, 0)),
        neededCallRecall: ratio(sum(m => m.neededRetained), sum(m => m.neededTotal)),
        unresolvedFailureRecall: ratio(sum(m => m.unresolvedShown), sum(m => m.unresolvedTotal)),
        staleFailuresShown: sum(m => m.staleFailuresShown),
        fileRecall: ratio(sum(m => m.filesShown), sum(m => m.filesTotal)),
      };
    };
    const paired = list.filter(cut => cut.laterItems > 0);
    return {
      cuts: list.length,
      withPlan: list.filter(cut => cut.hasPlan).length,
      nodeLinkedShareMedian: quantile(list.map(cut => cut.nodeLinkedShare), 0.5),
      preCutCallsMedian: quantile(list.map(cut => cut.preCutCalls), 0.5),
      cutsWithLaterEvidence: paired.length,
      laterItems: list.reduce((total, cut) => total + cut.laterItems, 0),
      unresolvedFailures: list.reduce((total, cut) => total + cut.arms.basic.unresolvedTotal, 0),
      // Paired per cut: how often each arm resolves more of the later-cited items.
      pairedLaterRecall: {
        decisionMore: paired.filter(cut => cut.arms.decision.laterItemsResolvable > cut.arms.basic.laterItemsResolvable).length,
        basicMore: paired.filter(cut => cut.arms.basic.laterItemsResolvable > cut.arms.decision.laterItemsResolvable).length,
        tie: paired.filter(cut => cut.arms.basic.laterItemsResolvable === cut.arms.decision.laterItemsResolvable).length,
      },
      arms: { basic: arm("basic"), decision: arm("decision") },
    };
  };
  return {
    real: group(cut => cut.kind === "real"),
    syntheticMid: group(cut => cut.kind === "synthetic-mid"),
    realWithPlan: group(cut => cut.kind === "real" && cut.hasPlan),
    syntheticMidWithPlan: group(cut => cut.kind === "synthetic-mid" && cut.hasPlan),
  };
}

export const LIMITS = { decision: DECISION_MEMORY_LIMITS };
