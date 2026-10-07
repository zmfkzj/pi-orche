/**
 * Task-DAG thinking policy (docs/thinking-policy.md): the effort a worker reasons at follows the node it works on.
 *
 * Purpose: fewer answers lost to the per-response output limit (a long reasoning cut off before any text or tool call) while keeping
 * answer quality and requirement coverage. Not cost: the baseline B keeps every judgement that decides correctness.
 *
 * With `mode: "phase"`:
 * - B (the assignment's level) for the initial analysis and plan, integration (`phase: "integrate"`), final verification, the
 *   report, hard steps (`hard: true`), rework (a node reopened after it was finished, or whose checkpoint says its verification
 *   failed) and every re-plan (an invalid task_plan call, a message from main). The split nodes of a node that ran at B stay at B.
 * - S (the highest level the model supports below B, computed once per assignment) for an ordinary step node while it runs, and
 *   between two ordinary steps (no switch back to B just to start the next step).
 * - The report phase: from the first report_result call or a report prompt of the runtime, B for every further request. A report
 *   whose request ran below B is discarded and written again at B (reportRewriteReason), never accepted.
 * Level changes apply from the next request (src/pi/thinking-state.ts); task_plan calls, report_result calls and the runtime's
 * report prompts are the boundaries the runtime sees.
 *
 * It also keeps what the output-limit recovery (src/pi/length-recovery.ts) needs to stay bounded without lowering the effort: the
 * re-decomposition it asked for (accepted only when the running node is no longer running and two or more new nodes appear), and a
 * progress count that only real progress raises (a node newly finished, an accepted re-decomposition), never a mere tool call.
 */
import type { TaskPlan } from "../tools/task-plan.js";
import { beginThinking, setThinkingPhase, THINKING_LEVELS, thinkingStateOf, type ThinkingSession } from "./thinking-state.js";

export type ThinkingPolicyMode = "fixed" | "phase";
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
}

export const FIXED_THINKING_POLICY: Readonly<ThinkingPolicySettings> = { mode: "fixed", checkpoints: false, escalation: false, lengthRecovery: "step-down", subWorkers: false };
export const PHASE_THINKING_POLICY: Readonly<ThinkingPolicySettings> = { mode: "phase", checkpoints: true, escalation: true, lengthRecovery: "redecompose", subWorkers: true };
/** The repository default: fixed (opt in with `"thinkingPolicy": "phase"`; real-model quality of the phase policy is unmeasured). */
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
  };
}

/** Re-decompositions accepted per assignment before the output-limit recovery gives up (forced report). */
export const MAX_REDECOMPOSITIONS = 3;

type PlanNode = TaskPlan["nodes"][number];
const FINISHED = new Set(["done", "skipped", "blocked"]);

export interface PolicyState {
  settings: ThinkingPolicySettings;
  /** The last accepted plan of this assignment. */
  plan?: TaskPlan;
  /** Nodes finished (done/skipped/blocked) at some point of this assignment: reopening one is rework. */
  everFinished: Set<string>;
  /** Nodes that run at B whatever their phase, with the reason. */
  escalated: Map<string, string>;
  /** B until the next valid task_plan: a rejected task_plan call or a message from main. */
  replan: boolean;
  /** A re-decomposition the output-limit recovery asked for, judged at the next accepted plan. */
  redecompose?: { node?: string; ids: string[]; baseline: boolean };
  redecompositions: number;
  /** Plans after a re-decomposition request that did not split anything. */
  falseRedecompositions: number;
  /** Progress evidence: raised by a newly finished node or an accepted re-decomposition, never by a plain tool call. */
  progress: number;
  /**
   * The report phase: set by the first report_result call or a report prompt of the runtime (request budget, exhausted output-limit
   * recovery, missing-result nudge). From then on every request of the assignment runs at B, whatever the plan says, so a report
   * sent back for its effort is rewritten at B and can never fall back to S (no rejection loop).
   */
  reporting: boolean;
  /** Reports sent back because their response ran below B (rewritten at B; not counted against the result retries). */
  reportRewrites: number;
}

const policies = new WeakMap<object, PolicyState>();

export function thinkingPolicyOf(session: object): PolicyState | undefined {
  return policies.get(session);
}

/** Assignment start: fix B and S (src/pi/thinking-state.ts), forget the previous assignment's plan state. */
export function beginThinkingPolicy(session: ThinkingSession, settings: ThinkingPolicySettings, baseline?: string): PolicyState {
  beginThinking(session, baseline);
  const state: PolicyState = { settings: { ...settings }, everFinished: new Set(), escalated: new Map(), replan: false, redecompositions: 0, falseRedecompositions: 0, progress: 0, reporting: false, reportRewrites: 0 };
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

/** An accepted task_plan: escalations, re-decomposition and progress bookkeeping, then the level. Returns lines for the result. */
export function onTaskPlan(session: ThinkingSession, plan: TaskPlan): string[] {
  const state = policies.get(session);
  if (!state) return [];
  const previous = state.plan;
  const before = new Map((previous?.nodes ?? []).map(node => [node.id, node]));
  const notes: string[] = [];
  for (const node of plan.nodes) {
    if ((node.status === "running" || node.status === "pending") && state.everFinished.has(node.id)) escalate(state, node.id, "reopened after it was finished (rework)");
    if (node.checkpoint?.verification === "failed" && node.status !== "done") escalate(state, node.id, "its verification failed (rework)");
  }
  const newlyFinished = plan.nodes.filter(node => FINISHED.has(node.status) && !FINISHED.has(before.get(node.id)?.status ?? "pending"));
  for (const node of plan.nodes) if (FINISHED.has(node.status)) state.everFinished.add(node.id);
  let progressed = newlyFinished.length > 0;
  const request = state.redecompose;
  if (request) {
    state.redecompose = undefined;
    const newIds = plan.nodes.map(node => node.id).filter(id => !request.ids.includes(id));
    const target = request.node ? plan.nodes.find(node => node.id === request.node) : undefined;
    if (target?.status !== "running" && newIds.length >= 2) {
      state.redecompositions++;
      progressed = true;
      if (request.baseline) for (const id of newIds) escalate(state, id, `split of ${request.node ?? "work that ran at the baseline"}`);
      notes.push(`Re-decomposition accepted: ${request.node ?? "the remaining work"} → ${newIds.join(", ")}.`);
    } else if (!(target && FINISHED.has(target.status))) {
      state.falseRedecompositions++;
      notes.push(`Warning: this plan does not split ${request.node ?? "the remaining work"} into two or more new, smaller nodes${target?.status === "running" ? ` (${target.id} is still running)` : ""}; it does not count as progress for the output-limit recovery.`);
    }
  }
  if (progressed) state.progress++;
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
    state.redecompose = { ids: [], baseline: atB };
    return { kind: "no-plan" };
  }
  const running = state.plan.nodes.find(node => node.status === "running");
  state.redecompose = { ...(running ? { node: running.id } : {}), ids: state.plan.nodes.map(node => node.id), baseline: atB };
  const integrating = running ? running.phase === "integrate" : !state.plan.nodes.some(node => node.status === "pending");
  return integrating ? { kind: "integrate", ...(running ? { node: running.id } : {}) } : { kind: "step", ...(running ? { node: running.id } : {}) };
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

const below = (level: string | undefined, than: string | undefined) =>
  level !== undefined && than !== undefined && THINKING_LEVELS.indexOf(level as never) < THINKING_LEVELS.indexOf(than as never);

/**
 * The report must be written at B (phase policy). A report_result whose response ran below B (an ordinary step, between steps, a
 * recovery step-down) is not accepted: the report phase starts (B for every further request) and the returned text asks for the
 * report again, written in the next request at B. The S report is never re-labelled: it is discarded and rewritten.
 * Undefined when the report may stand: the fixed policy, no policy, or a response at B.
 */
export function reportRewriteReason(session: object): string | undefined {
  const state = policies.get(session);
  if (!state || state.settings.mode !== "phase") return undefined;
  const thinking = thinkingStateOf(session);
  const level = thinking.requestLevel;
  if (!below(level, thinking.baseline)) return undefined;
  state.reportRewrites++;
  beginReportPhase(session as ThinkingSession, "report rewrite");
  const running = state.plan?.nodes.find(node => node.status === "running");
  return `This report_result was written at the reduced step effort (${level})${running ? ` while node ${running.id} is still running` : ""}; the final report is written at the baseline effort (${thinking.baseline}), which applies from your next request. It is not counted as a failed attempt. Check the integration against every requirement (finish or block the running node with task_plan if needed), then call report_result alone again`;
}

export interface ThinkingPolicySummary {
  mode: ThinkingPolicyMode;
  baseline?: string;
  step?: string;
  switches: number;
  escalated?: { node: string; reason: string }[];
  redecompositions?: number;
  falseRedecompositions?: number;
  reportRewrites?: number;
}

/** What the result and the record show about the policy. */
export function thinkingPolicySummary(session: object): ThinkingPolicySummary | undefined {
  const state = policies.get(session);
  if (!state) return undefined;
  const thinking = thinkingStateOf(session);
  return {
    mode: state.settings.mode,
    ...(thinking.baseline ? { baseline: thinking.baseline } : {}),
    ...(thinking.step ? { step: thinking.step } : {}),
    switches: thinking.switches.filter(change => change.reason !== "assignment start").length,
    ...(state.escalated.size ? { escalated: [...state.escalated].map(([node, reason]) => ({ node, reason })) } : {}),
    ...(state.redecompositions ? { redecompositions: state.redecompositions } : {}),
    ...(state.falseRedecompositions ? { falseRedecompositions: state.falseRedecompositions } : {}),
    ...(state.reportRewrites ? { reportRewrites: state.reportRewrites } : {}),
  };
}
