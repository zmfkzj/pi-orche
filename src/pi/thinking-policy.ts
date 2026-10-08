/**
 * Task-DAG thinking policy (docs/thinking-policy.md): the effort a worker reasons at follows the node it works on.
 *
 * Purpose: fewer answers lost to the per-response output limit (a long reasoning cut off before any text or tool call) while keeping
 * answer quality and requirement coverage. Not cost: the baseline B keeps every judgement that decides correctness.
 *
 * With `mode: "phase"`:
 * - B (the assignment's level) for the initial analysis and plan, integration (`phase: "integrate"`), final verification, the
 *   report, hard steps (`hard: true`), rework (a node reopened after it was finished, a node whose checkpoint says its verification
 *   failed, and a NEW node that redoes failed or integrated work: see {@link onTaskPlan}) and every re-plan (an invalid task_plan
 *   call, a message from main). The split nodes of a node that ran at B stay at B.
 * - S (the highest level whose EFFECTIVE effort is below B's, computed once per assignment; src/pi/thinking-state.ts) for an ordinary
 *   step node while it runs, and between two ordinary steps (no switch back to B just to start the next step).
 * - The report phase: from the first report_result call or a report prompt of the runtime, B for every further request. A report
 *   whose request ran below B is discarded and written again at B (reportRewriteReason), never accepted.
 * Level changes apply from the next request; task_plan calls, report_result calls and the runtime's report prompts are the
 * boundaries the runtime sees.
 *
 * The runtime gate (`gate`, phase mode; {@link checkPolicyPlan}, {@link reportGateError}) makes the B parts real instead of labels:
 * - the plan keeps at least one integration node; an integration node is never dropped, turned into a step or skipped unless other
 *   integration nodes take over its requirements (the per-requirement split of the output-limit recovery);
 * - an integration or hard node goes to done only after it was set running in an EARLIER response (a plan that sets it running and
 *   done in one response, or a pending → done jump, ran at whatever level that response had), in a response at B, and an integration
 *   node only with checkpoint evidence that cites a successful check it ran at B while it was running (src/pi/tool-evidence.ts);
 * - a success report (implement `status: "done"`, answer with every checklist item met) needs every requirement of the plan covered
 *   by a finished integration node; a partial, blocked or failed report always passes, so the gate never traps a worker.
 * When S equals B (the model has no lower effective level) the request-level checks are moot and skipped; the structure and
 * evidence rules stay.
 *
 * It also keeps what the output-limit recovery (src/pi/length-recovery.ts) needs to stay bounded without lowering the effort: the
 * re-decomposition it asked for (accepted only for two or more new child nodes with `parent` = the split node, distinct titles, the
 * node's requirements and nothing else, the node itself skipped or done, at most MAX_SPLIT_DEPTH levels deep), and a progress count
 * that only real progress raises (a node newly done whose checkpoint cites a verified call, or after a check ran when checkpoints are
 * off; an accepted split), never a mere tool call or a checkpoint that proves nothing.
 */
import type { TaskPlan } from "../tools/task-plan.js";
import type { EffortAliasRule } from "./effort-mapping.js";
import { atEffectiveBaseline, beginThinking, hasLowerStep, setThinkingPhase, THINKING_LEVELS, thinkingStateOf, type ThinkingSession } from "./thinking-state.js";
import { checkCalls, classifyEvidence, evidenceLedgerOf, resetEvidence, type EvidenceCheck } from "./tool-evidence.js";

export type ThinkingPolicyMode = "fixed" | "phase";
/** off: no linkage; warn: notes only (unverified evidence still never counts as progress); strict: false references are rejected. */
export type EvidencePolicy = "off" | "warn" | "strict";
export interface ThinkingPolicySettings {
  /** fixed: B for the whole assignment (the behaviour before this policy); phase: S for ordinary DAG steps, B for everything else. */
  mode: ThinkingPolicyMode;
  /** A node newly marked done needs a checkpoint (result, evidence, verification, open doubts); integration needs "passed". */
  checkpoints: boolean;
  /** Hard steps and rework run at B (phase mode). false: only integration and planning do (the plain S/B split). */
  escalation: boolean;
  /** Output-limit recovery: "redecompose" (next-step nudge, then split the running node, effort unchanged) or "step-down" (the
   * earlier next-step nudges with one supported level lower for the last attempt). */
  lengthRecovery: "redecompose" | "step-down";
  /** orche_spawn sub-workers (phase mode): standard implement/answer at S of the orchestrator's B, verify at B. */
  subWorkers: boolean;
  /** The runtime gate of the phase mode (module comment): integration and hard nodes really run at B, success reports need them. */
  gate: boolean;
  /** Checkpoint evidence linked to the tool-call ledger (tool results get `[orche ref T<n>]`). */
  evidence: EvidencePolicy;
  /** Proxy effort aliases (`thinkingPolicy.effortAliases`; src/pi/effort-mapping.ts); absent: the built-in rule only. */
  effortAliases?: EffortAliasRule[];
}

export const FIXED_THINKING_POLICY: Readonly<ThinkingPolicySettings> = { mode: "fixed", checkpoints: false, escalation: false, lengthRecovery: "step-down", subWorkers: false, gate: false, evidence: "off" };
export const PHASE_THINKING_POLICY: Readonly<ThinkingPolicySettings> = { mode: "phase", checkpoints: true, escalation: true, lengthRecovery: "redecompose", subWorkers: true, gate: true, evidence: "strict" };
/** The repository default: fixed (opt in with `"thinkingPolicy": "phase"`; real-model quality of the phase policy is unproven). */
export const DEFAULT_THINKING_POLICY = FIXED_THINKING_POLICY;

/** Settings from a mode and explicit overrides: unset fields take the mode's defaults. */
export function resolveThinkingPolicy(value: Partial<ThinkingPolicySettings> = {}): ThinkingPolicySettings {
  const base = value.mode === "phase" ? PHASE_THINKING_POLICY : FIXED_THINKING_POLICY;
  return {
    mode: value.mode ?? base.mode,
    checkpoints: value.checkpoints ?? base.checkpoints,
    escalation: value.escalation ?? base.escalation,
    lengthRecovery: value.lengthRecovery ?? base.lengthRecovery,
    subWorkers: value.subWorkers ?? base.subWorkers,
    gate: value.gate ?? base.gate,
    evidence: value.evidence ?? base.evidence,
    ...(value.effortAliases ? { effortAliases: value.effortAliases.map(rule => ({ model: rule.model, aliases: { ...rule.aliases } })) } : {}),
  };
}

/** Re-decompositions accepted per assignment before the output-limit recovery gives up (forced report). */
export const MAX_REDECOMPOSITIONS = 3;
/** How deep splits may nest (a split of a split of a node is depth 2). */
export const MAX_SPLIT_DEPTH = 2;

type PlanNode = TaskPlan["nodes"][number];
const FINISHED = new Set(["done", "skipped", "blocked"]);

export interface PolicyState {
  settings: ThinkingPolicySettings;
  /** The assignment kind (implement, answer, ...): the report gate and the pure-answer exception. */
  kind?: string;
  /** The last accepted plan of this assignment. */
  plan?: TaskPlan;
  /** Every node id of an accepted plan of this assignment: a node not in it is new. */
  everSeen: Set<string>;
  /** Nodes finished (done/skipped/blocked) at some point of this assignment: reopening one is rework. */
  everFinished: Set<string>;
  /** Nodes that run at B whatever their phase, with the reason. */
  escalated: Map<string, string>;
  /** The request (thinking-state requestSeq) at which a node was last set running by an accepted plan. */
  runningSince: Map<string, number>;
  /** An integration node was running or done in an accepted plan: new nodes from then on are rework. */
  integrationStarted: boolean;
  /** Requirement ids whose node failed its verification or was blocked: a new node for one of them is rework. */
  failedCovers: Set<string>;
  /** Split lineage of this assignment: child → parent. */
  lineage: Map<string, string>;
  /** B until the next valid task_plan: a rejected task_plan call or a message from main. */
  replan: boolean;
  /** A re-decomposition the output-limit recovery asked for, judged at the next accepted plan. */
  redecompose?: { node?: string; ids: string[]; baseline: boolean; covers: string[]; title?: string };
  redecompositions: number;
  /** Plans after a re-decomposition request that did not split anything. */
  falseRedecompositions: number;
  /** Progress evidence: raised by a node newly done with verified evidence or an accepted split, never by a plain tool call. */
  progress: number;
  /** The request of the last progress (checks after it can make a checkpoint-less node count). */
  progressRequest: number;
  /**
   * The report phase: set by the first report_result call or a report prompt of the runtime (request budget, exhausted output-limit
   * recovery, missing-result nudge). From then on every request of the assignment runs at B, whatever the plan says, so a report
   * sent back for its effort is rewritten at B and can never fall back to S (no rejection loop).
   */
  reporting: boolean;
  /** Reports sent back because their response ran below B (rewritten at B; not counted against the result retries). */
  reportRewrites: number;
  /** task_plan calls rejected by the gate, and success reports it sent back (records). */
  gateRejections: number;
  /** Checkpoint evidence items by verdict (records). */
  evidenceVerdicts: Record<string, number>;
}

const policies = new WeakMap<object, PolicyState>();

export function thinkingPolicyOf(session: object): PolicyState | undefined {
  return policies.get(session);
}

/**
 * Assignment start: fix B and S (src/pi/thinking-state.ts), forget the previous assignment's plan state and tool ledger.
 * `kind`: the assignment kind (the report gate applies to implement and answer).
 */
export function beginThinkingPolicy(session: ThinkingSession, settings: ThinkingPolicySettings, baseline?: string, kind?: string): PolicyState {
  beginThinking(session, baseline, settings.effortAliases ?? []);
  resetEvidence(session, settings.evidence !== "off");
  const state: PolicyState = {
    settings: { ...settings }, ...(kind ? { kind } : {}), everSeen: new Set(), everFinished: new Set(), escalated: new Map(), runningSince: new Map(),
    integrationStarted: false, failedCovers: new Set(), lineage: new Map(), replan: false, redecompositions: 0, falseRedecompositions: 0,
    progress: 0, progressRequest: 0, reporting: false, reportRewrites: 0, gateRejections: 0, evidenceVerdicts: {},
  };
  policies.set(session, state);
  return state;
}

export interface PhaseTarget { phase: "baseline" | "step"; reason: string; node?: string }

const atBaseline = (node: PlanNode, settings: ThinkingPolicySettings, escalated: ReadonlyMap<string, string>): string | undefined =>
  node.phase === "integrate" ? `integration node ${node.id}`
    : settings.escalation && node.hard ? `hard node ${node.id}`
    : settings.escalation && escalated.has(node.id) ? `node ${node.id}: ${escalated.get(node.id)}`
    : undefined;

/** The phase the next request should run in (pure; see the module comment). `current`: the phase the session is in now. */
export function phaseTarget(settings: ThinkingPolicySettings, plan: TaskPlan | undefined, context: { escalated: ReadonlyMap<string, string>; replan: boolean; current: "baseline" | "step"; reporting?: boolean }): PhaseTarget {
  if (settings.mode !== "phase") return { phase: "baseline", reason: "fixed policy" };
  if (context.reporting) return { phase: "baseline", reason: "report" };
  if (context.replan) return { phase: "baseline", reason: "re-plan" };
  if (!plan) return { phase: "baseline", reason: "planning" };
  const running = plan.nodes.find(node => node.status === "running");
  if (running) {
    const why = atBaseline(running, settings, context.escalated);
    return why ? { phase: "baseline", reason: why, node: running.id } : { phase: "step", reason: `step node ${running.id}`, node: running.id };
  }
  const finished = new Set(plan.nodes.filter(node => node.status === "done" || node.status === "skipped").map(node => node.id));
  const next = plan.nodes.find(node => node.status === "pending" && node.dependsOn.every(id => finished.has(id)));
  if (!next) return { phase: "baseline", reason: "integration and report" };
  // Between two ordinary steps: stay at S rather than switching to B and back for the next one.
  if (context.current === "step" && !atBaseline(next, settings, context.escalated)) return { phase: "step", reason: `between steps (next: ${next.id})`, node: next.id };
  return { phase: "baseline", reason: `no node running (next: ${next.id})` };
}

function escalate(state: PolicyState, id: string, reason: string): void {
  if (state.settings.escalation && !state.escalated.has(id)) state.escalated.set(id, reason);
}

/** Apply the target phase; returns the line for the task_plan result when the level changes. */
function steer(session: ThinkingSession, state: PolicyState): string[] {
  if (state.settings.mode !== "phase") return [];
  const thinking = thinkingStateOf(session);
  const target = phaseTarget(state.settings, state.plan, { escalated: state.escalated, replan: state.replan, current: thinking.phase, reporting: state.reporting });
  const before = session.thinkingLevel;
  setThinkingPhase(session, target.phase, target.reason, target.node);
  const after = session.thinkingLevel;
  if (before === after) return [];
  return [target.phase === "step"
    ? `Thinking: the next requests run at ${after}, one level below the baseline ${thinking.baseline} (${target.reason}). Mark a node hard:true before it runs if it needs full effort.`
    : `Thinking: the next requests run at the baseline ${after} (${target.reason}).`];
}

const kindOf = (node: PlanNode) => node.phase === "integrate" ? "integration node" : "hard node";
const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Classify a checkpoint's evidence for `node` (window: since it started running; integration and hard nodes: calls at B only). */
function checkEvidence(session: object, state: PolicyState, node: PlanNode, gatedAtB: boolean): EvidenceCheck[] {
  if (state.settings.evidence === "off" || !node.checkpoint) return [];
  const ledger = evidenceLedgerOf(session);
  return node.checkpoint.evidence.map(item => classifyEvidence(item, ledger, { fromRequest: state.runningSince.get(node.id) ?? 0, atBaseline: gatedAtB }));
}

/**
 * The phase policy's checks of a task_plan call before it is accepted (module comment); throws with every problem, returns notes.
 * Fixed mode, or a policy without the gate and evidence linkage: no checks.
 */
export function checkPolicyPlan(session: ThinkingSession, previous: TaskPlan | undefined, plan: TaskPlan): string[] {
  const state = policies.get(session);
  if (!state) return [];
  const phase = state.settings.mode === "phase";
  const gate = phase && state.settings.gate;
  if (!gate && state.settings.evidence === "off") return [];
  const thinking = thinkingStateOf(session);
  const lowerStep = hasLowerStep(thinking);
  const request = thinking.requestSeq;
  const before = new Map((previous?.nodes ?? []).map(node => [node.id, node]));
  const errors: string[] = [];
  const notes: string[] = [];
  const verdicts: string[] = [];
  if (gate) {
    const integrations = plan.nodes.filter(node => node.phase === "integrate");
    if (!integrations.length) errors.push('the plan has no integration node: end the DAG with a node phase "integrate" that compares every requirement with the actual changes and check runs');
    for (const old of previous?.nodes ?? []) {
      if (old.phase !== "integrate") continue;
      const now = plan.nodes.find(node => node.id === old.id);
      if (now?.phase === "step") { errors.push(`${old.id} is an integration node; it cannot become a step (keep phase "integrate")`); continue; }
      if (now && now.status !== "skipped") continue;
      const others = plan.nodes.filter(node => node.phase === "integrate" && node.id !== old.id && node.status !== "skipped");
      const covered = new Set(others.flatMap(node => node.covers));
      const missing = old.covers.filter(id => !covered.has(id));
      if (!others.length || missing.length) errors.push(`integration node ${old.id} cannot be ${now ? "skipped" : "removed"} unless other integration nodes take over its requirements${missing.length ? ` (${missing.join(", ")} would lose their integration)` : ""}; mark it blocked if it cannot finish`);
    }
  }
  for (const node of plan.nodes) {
    const old = before.get(node.id);
    if (node.status !== "done" || old?.status === "done") continue;
    const gated = gate && (node.phase === "integrate" || state.settings.escalation && !!node.hard);
    if (gate && node.phase === "integrate" && node.checkpoint?.verification !== "passed") errors.push(`integration node ${node.id} is done only with a checkpoint whose verification is "passed"; mark it blocked when a requirement fails`);
    const checks = checkEvidence(session, state, node, gated && lowerStep);
    verdicts.push(...checks.map(check => check.verdict));
    const passed = node.checkpoint?.verification === "passed";
    const bad = checks.filter(check => check.verdict === "unknown_ref" || check.verdict === "failed_call");
    if (passed && bad.length) {
      const text = `${node.id}'s checkpoint says "passed" but cites ${bad.map(check => `${JSON.stringify(check.item.slice(0, 60))} (${check.verdict === "unknown_ref" ? "no such tool call" : "a call that failed"})`).join(", ")}`;
      if (state.settings.evidence === "strict") errors.push(`${text}; cite the [orche ref Tn] of calls that ran and succeeded`);
      else notes.push(`Evidence warning: ${text}.`);
    } else if (state.settings.evidence !== "off" && node.checkpoint && !checks.some(check => check.verdict === "verified") && !gated) {
      notes.push(`Evidence note: no evidence item of ${node.id} cites a tool call of this assignment (cite [orche ref Tn]); it does not count as progress.`);
    }
    if (!gated) continue;
    if (lowerStep) {
      const since = state.runningSince.get(node.id);
      if (old?.status !== "running" || since === undefined) { errors.push(`${kindOf(node)} ${node.id} goes to done without having run: set it running with task_plan first (it runs at the baseline effort from the next response), do its work there, then mark it done`); continue; }
      if (since >= request) { errors.push(`${kindOf(node)} ${node.id} was set running in this same response, which ran at ${thinking.requestLevel ?? "an unknown level"}; its work and the done mark belong to a later response at the baseline effort`); continue; }
      if (!atEffectiveBaseline(thinking, thinking.requestLevel)) { errors.push(`this response ran at ${thinking.requestLevel ?? "an unknown level"}, below the baseline ${thinking.baseline}; ${node.id} is marked done in a response at the baseline`); continue; }
    }
    if (node.phase === "integrate") {
      const open = plan.nodes.filter(other => other.phase !== "integrate" && !FINISHED.has(other.status) && other.covers.some(id => node.covers.includes(id)));
      if (open.length) errors.push(`integration node ${node.id} cannot be done while ${open.map(other => `${other.id} (${other.status})`).join(", ")} covering its requirements ${open.length > 1 ? "are" : "is"} not finished`);
      const pureAnswer = state.kind === "answer" && checkCalls(evidenceLedgerOf(session)).length === 0;
      if (!pureAnswer && !checks.some(check => check.verdict === "verified")) errors.push(`integration node ${node.id} needs checkpoint evidence citing a successful check it ran${lowerStep ? " at the baseline effort" : ""} while it was running (a test run, diff or read of the changed code: cite its [orche ref Tn])`);
    }
  }
  if (errors.length) {
    state.gateRejections++;
    throw new Error(`Task DAG gate (thinkingPolicy ${state.settings.mode}): ${errors.join("; ")}.`);
  }
  for (const verdict of verdicts) state.evidenceVerdicts[verdict] = (state.evidenceVerdicts[verdict] ?? 0) + 1;
  return notes;
}

/** Whether a node newly done counts as progress for the output-limit recovery (module comment). */
function countsAsProgress(session: object, state: PolicyState, node: PlanNode): boolean {
  if (node.status !== "done") return false;
  const ledger = evidenceLedgerOf(session);
  if (state.settings.evidence !== "off" && node.checkpoint) return node.checkpoint.evidence.some(item => classifyEvidence(item, ledger, { fromRequest: state.runningSince.get(node.id) ?? 0 }).verdict === "verified");
  return checkCalls(ledger).some(call => !call.isError && call.request > state.progressRequest);
}

function depthOf(state: PolicyState, id: string): number {
  let depth = 0;
  for (let at = state.lineage.get(id); at !== undefined && depth <= MAX_SPLIT_DEPTH + 1; at = state.lineage.get(at)) depth++;
  return depth;
}

/** Why a plan does not split the requested node (undefined: it does), and the accepted children. */
function judgeSplit(state: PolicyState, request: NonNullable<PolicyState["redecompose"]>, plan: TaskPlan): { problem?: string; children: PlanNode[] } {
  const fresh = plan.nodes.filter(node => !request.ids.includes(node.id));
  const target = request.node ? plan.nodes.find(node => node.id === request.node) : undefined;
  const children = request.node ? fresh.filter(node => node.parent === request.node) : fresh;
  if (request.node && !target) return { problem: `${request.node} was removed; keep it in the plan, marked skipped (or done with its checkpoint for the finished part)`, children };
  if (target?.status === "running") return { problem: `${target.id} is still running`, children };
  if (target && target.status === "pending") return { problem: `${target.id} is still pending; mark it skipped (or done for the finished part)`, children };
  if (children.length < 2) return { problem: request.node ? `two or more new nodes with parent "${request.node}" are needed (${fresh.length ? `new nodes without that parent do not count: ${fresh.map(node => node.id).join(", ")}` : "none was added"})` : "two or more new nodes are needed", children };
  const titles = children.map(node => titleKey(node.title));
  if (new Set(titles).size < titles.length || request.title !== undefined && titles.includes(titleKey(request.title))) return { problem: "the new nodes must name distinct, smaller parts, not repeat a title", children };
  if (request.node && request.covers.length) {
    const covered = new Set(children.flatMap(node => node.covers));
    const missing = request.covers.filter(id => !covered.has(id));
    const foreign = [...covered].filter(id => !request.covers.includes(id));
    if (missing.length) return { problem: `the new nodes must carry ${request.node}'s requirements (missing ${missing.join(", ")})`, children };
    if (foreign.length) return { problem: `the new nodes may cover only ${request.node}'s requirements (${foreign.join(", ")} belong elsewhere)`, children };
  }
  if (request.node && depthOf(state, request.node) + 1 > MAX_SPLIT_DEPTH) return { problem: `splits nest at most ${MAX_SPLIT_DEPTH} levels deep; finish ${request.node}'s part in smaller steps or report what is not done`, children };
  return { children };
}

/** An accepted task_plan: escalations, re-decomposition and progress bookkeeping, then the level. Returns lines for the result. */
export function onTaskPlan(session: ThinkingSession, plan: TaskPlan): string[] {
  const state = policies.get(session);
  if (!state) return [];
  const thinking = thinkingStateOf(session);
  const previous = state.plan;
  const before = new Map((previous?.nodes ?? []).map(node => [node.id, node]));
  const notes: string[] = [];
  const integrationBefore = state.integrationStarted;
  for (const node of plan.nodes) {
    if ((node.status === "running" || node.status === "pending") && state.everFinished.has(node.id)) escalate(state, node.id, "reopened after it was finished (rework)");
    if (node.checkpoint?.verification === "failed" && node.status !== "done") escalate(state, node.id, "its verification failed (rework)");
    if (node.checkpoint?.verification === "failed" || node.status === "blocked") for (const id of node.covers) state.failedCovers.add(id);
  }
  // Rework under a new id: a node that did not exist before, added after the integration started, as a child of a finished node,
  // or for a requirement whose node failed or was blocked, runs at B like a reopened node.
  for (const node of plan.nodes) {
    if (!previous || state.everSeen.has(node.id) || node.phase === "integrate") continue;
    const parent = node.parent ? before.get(node.parent) : undefined;
    const why = integrationBefore ? "added after the integration started (rework)"
      : parent && (parent.status === "done" || parent.status === "blocked") ? `child of the finished node ${parent.id} (rework)`
      : node.covers.some(id => state.failedCovers.has(id)) ? `redoes failed requirement ${node.covers.filter(id => state.failedCovers.has(id)).join(", ")} (rework)`
      : undefined;
    if (why) escalate(state, node.id, why);
  }
  const newlyDone = plan.nodes.filter(node => node.status === "done" && before.get(node.id)?.status !== "done");
  let progressed = newlyDone.some(node => countsAsProgress(session, state, node));
  for (const node of plan.nodes) if (FINISHED.has(node.status)) state.everFinished.add(node.id);
  for (const node of plan.nodes) if (node.status === "running" && before.get(node.id)?.status !== "running") state.runningSince.set(node.id, thinking.requestSeq);
  if (plan.nodes.some(node => node.phase === "integrate" && (node.status === "running" || node.status === "done"))) state.integrationStarted = true;
  const request = state.redecompose;
  if (request) {
    state.redecompose = undefined;
    const target = request.node ? plan.nodes.find(node => node.id === request.node) : undefined;
    const { problem, children } = judgeSplit(state, request, plan);
    if (!problem) {
      state.redecompositions++;
      progressed = true;
      for (const child of children) if (request.node) state.lineage.set(child.id, request.node);
      if (request.baseline) for (const child of children) escalate(state, child.id, `split of ${request.node ?? "work that ran at the baseline"}`);
      notes.push(`Re-decomposition accepted: ${request.node ?? "the remaining work"} → ${children.map(node => node.id).join(", ")}.`);
    } else if (!(target && target.status === "done" && children.length === 0)) {
      state.falseRedecompositions++;
      notes.push(`Warning: this plan does not split ${request.node ?? "the remaining work"}: ${problem}. It does not count as progress for the output-limit recovery.`);
    }
  }
  if (progressed) { state.progress++; state.progressRequest = thinking.requestSeq; }
  for (const node of plan.nodes) state.everSeen.add(node.id);
  state.plan = plan;
  state.replan = false;
  return [...notes, ...steer(session, state)];
}

/** A rejected task_plan call or a message from main: plan again at B until the next accepted plan. */
export function requireReplan(session: ThinkingSession, reason: string): void {
  const state = policies.get(session);
  if (!state || state.settings.mode !== "phase") return;
  state.replan = true;
  setThinkingPhase(session, "baseline", reason);
}

export type RedecomposeRequest =
  | { kind: "step"; node?: string }
  | { kind: "integrate"; node?: string }
  | { kind: "no-plan" }
  | { kind: "exhausted" };

/** The output-limit recovery asks for a smaller scope: what to ask the model, recorded for judging the next plan. */
export function requestRedecompose(session: object): RedecomposeRequest {
  const state = policies.get(session);
  if (!state) return { kind: "no-plan" };
  if (state.redecompositions >= MAX_REDECOMPOSITIONS) return { kind: "exhausted" };
  const atB = thinkingStateOf(session).phase === "baseline";
  if (!state.plan) {
    state.redecompose = { ids: [], baseline: atB, covers: [] };
    return { kind: "no-plan" };
  }
  const running = state.plan.nodes.find(node => node.status === "running");
  if (running && depthOf(state, running.id) + 1 > MAX_SPLIT_DEPTH) return { kind: "exhausted" };
  state.redecompose = { ...(running ? { node: running.id, title: running.title } : {}), ids: state.plan.nodes.map(node => node.id), baseline: atB, covers: running ? [...running.covers] : [] };
  const integrating = running ? running.phase === "integrate" : !state.plan.nodes.some(node => node.status === "pending");
  return integrating ? { kind: "integrate", ...(running ? { node: running.id } : {}) } : { kind: "step", ...(running ? { node: running.id } : {}) };
}

/** Whether the running node of the session's plan is an integration node (the output-limit recovery never lowers the effort there). */
export function integrationRunning(session: object): boolean {
  return !!policies.get(session)?.plan?.nodes.some(node => node.status === "running" && node.phase === "integrate");
}

/**
 * The report phase starts (phase policy): every further request of this assignment runs at B (see `PolicyState.reporting`).
 * Called by the runtime BEFORE the model request of a report prompt (request budget, exhausted output-limit recovery, missing-result
 * nudge), and when a report written below B is sent back. Without a policy (or with the fixed one) a recovery step-down is cleared,
 * so a report prompt never runs below the assignment's level either. Returns the level the next request runs at.
 */
export function beginReportPhase(session: ThinkingSession, reason: string): string | undefined {
  const state = policies.get(session);
  if (state?.settings.mode === "phase") state.reporting = true;
  setThinkingPhase(session, "baseline", reason);
  return session.thinkingLevel;
}

/**
 * The report must be written at B (phase policy). A report_result whose response ran below B's effective effort (an ordinary step,
 * between steps, a recovery step-down) is not accepted: the report phase starts (B for every further request) and the returned text
 * asks for the report again, written in the next request at B. The S report is never re-labelled: it is discarded and rewritten.
 * Undefined when the report may stand: the fixed policy, no policy, or a response at B.
 */
export function reportRewriteReason(session: object): string | undefined {
  const state = policies.get(session);
  if (!state || state.settings.mode !== "phase") return undefined;
  const thinking = thinkingStateOf(session);
  const level = thinking.requestLevel;
  if (level === undefined || atEffectiveBaseline(thinking, level) || !THINKING_LEVELS.includes(level as never)) return undefined;
  state.reportRewrites++;
  beginReportPhase(session as ThinkingSession, "report rewrite");
  const running = state.plan?.nodes.find(node => node.status === "running");
  return `This report_result was written at the reduced step effort (${level})${running ? ` while node ${running.id} is still running` : ""}; the final report is written at the baseline effort (${thinking.baseline}), which applies from your next request. It is not counted as a failed attempt. Check the integration against every requirement (finish or block the running node with task_plan if needed), then call report_result alone again`;
}

/** Whether a report claims full success: implement `status: "done"`, or an answer whose checklist items are all met. */
export function claimsSuccess(kind: string, data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as { status?: unknown; checklist?: unknown };
  if (kind === "implement") return record.status === "done";
  if (kind === "answer") return Array.isArray(record.checklist) && record.checklist.length > 0 && record.checklist.every(item => !!item && typeof item === "object" && (item as { status?: unknown }).status === "met");
  return false;
}

/**
 * The report gate (phase mode with the gate, an assignment with a plan): a success claim needs every requirement of the plan covered by
 * a finished integration node and no node left running or pending. A partial, blocked or unmet report always passes. Undefined: accept.
 */
export function reportGateError(session: object, kind: string, data: unknown): string | undefined {
  const state = policies.get(session);
  if (!state || state.settings.mode !== "phase" || !state.settings.gate || !state.plan) return undefined;
  if (kind !== "implement" && kind !== "answer") return undefined;
  if (!claimsSuccess(kind, data)) return undefined;
  const nodes = state.plan.nodes;
  const integrated = new Set(nodes.filter(node => node.phase === "integrate" && node.status === "done").flatMap(node => node.covers));
  const required = [...new Set(nodes.flatMap(node => node.covers))];
  const missing = required.filter(id => !integrated.has(id));
  const open = nodes.filter(node => node.status === "running" || node.status === "pending");
  if (!missing.length && !open.length && nodes.some(node => node.phase === "integrate" && node.status === "done")) return undefined;
  state.gateRejections++;
  const problems = [
    ...(open.length ? [`node${open.length > 1 ? "s" : ""} ${open.map(node => `${node.id} (${node.status})`).join(", ")} ${open.length > 1 ? "are" : "is"} not finished`] : []),
    ...(missing.length ? [`requirement${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "have" : "has"} no finished integration node`] : !nodes.some(node => node.phase === "integrate" && node.status === "done") ? ["no integration node is done"] : []),
  ];
  return `A success report needs the Task DAG's integration done at the baseline effort: ${problems.join("; ")}. Run the integration node (set it running with task_plan, check every requirement against the actual changes and checks, mark it done citing the [orche ref Tn] of those checks), or report what is unverified as partial/unmet${kind === "implement" ? ' (data.status "blocked" with the reason)' : ""}`;
}

export interface ThinkingPolicySummary {
  mode: ThinkingPolicyMode;
  baseline?: string;
  step?: string;
  /** The effort B and S reach the model as, and where that mapping came from (src/pi/effort-mapping.ts). */
  effective?: { baseline?: string; step?: string; source: string; aliases?: Record<string, string> };
  switches: number;
  escalated?: { node: string; reason: string }[];
  redecompositions?: number;
  falseRedecompositions?: number;
  reportRewrites?: number;
  gateRejections?: number;
  evidence?: Record<string, number>;
}

/** What the result and the record show about the policy. */
export function thinkingPolicySummary(session: object): ThinkingPolicySummary | undefined {
  const state = policies.get(session);
  if (!state) return undefined;
  const thinking = thinkingStateOf(session);
  const names = thinking.effort?.names;
  return {
    mode: state.settings.mode,
    ...(thinking.baseline ? { baseline: thinking.baseline } : {}),
    ...(thinking.step ? { step: thinking.step } : {}),
    ...(thinking.effort ? { effective: { ...(thinking.baseline ? { baseline: names?.[thinking.baseline] ?? thinking.baseline } : {}), ...(thinking.step ? { step: names?.[thinking.step] ?? thinking.step } : {}), source: thinking.effort.source, ...(Object.keys(thinking.effort.aliases).length ? { aliases: thinking.effort.aliases } : {}) } } : {}),
    switches: thinking.switches.filter(change => change.reason !== "assignment start").length,
    ...(state.escalated.size ? { escalated: [...state.escalated].map(([node, reason]) => ({ node, reason })) } : {}),
    ...(state.redecompositions ? { redecompositions: state.redecompositions } : {}),
    ...(state.falseRedecompositions ? { falseRedecompositions: state.falseRedecompositions } : {}),
    ...(state.reportRewrites ? { reportRewrites: state.reportRewrites } : {}),
    ...(state.gateRejections ? { gateRejections: state.gateRejections } : {}),
    ...(Object.keys(state.evidenceVerdicts).length ? { evidence: { ...state.evidenceVerdicts } } : {}),
  };
}
