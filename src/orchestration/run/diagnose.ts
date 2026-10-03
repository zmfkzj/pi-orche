import { expiry, runDeadline } from "./deadline.js";
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { WORKER_TOOL_NAMES } from "../../tools/index.js";
import type { CoordinatorEffect } from "../phases.js";
import type { BacklogProposal } from "../backlog.js";
import { resolveRoute } from "../routing.js";
import { explorationPrompt, proposalPrompt, workerInstructions } from "../prompts.js";
import { proposalSchema } from "../result-schemas.js";
import { apply, assignWorker, bounded, emit, spawnWorker, waitOutcomes, workerAssignment } from "./context.js";
import { decide, explorationPlanProblem } from "./decisions.js";
import { explorerRolesFor } from "../team.js";
import { auditWorkspace } from "./audit.js";
import type { RootCauseClaim, RunContext } from "./types.js";

/** `diagnose_fix` class: planned explorers, early root-cause acceptance, convergence and proposals. */
export async function planAndSpawnExplorers(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  const roles = explorerRolesFor(ctx.team, ctx.workerIds.length);
  const base = `Plan ${ctx.workerIds.length} distinct explorers for problem: ${ctx.options.problem}. Call plan_exploration alone with explorers matching these route roles in order: ${JSON.stringify(roles)}. Each explorer requires role and a distinct, nonempty angle.`;
  let plan: { explorers: { role: string; angle: string }[] } | undefined;
  let feedback = "";
  for (let attempt = 0; attempt <= ctx.limits.decisionRepairs && !plan; attempt++) {
    if (ctx.cancelled) throw new Error("cancelled");
    ctx.decisionSet = false;
    ctx.decisionValue = undefined;
    await bounded(ctx, ctx.coordinator!.prompt(`${base}${feedback}`), ctx.limits.decisionMs, "Exploration plan");
    const problem = explorationPlanProblem(ctx.decisionSet, ctx.decisionValue, roles);
    if (!problem) plan = ctx.decisionValue as typeof plan;
    else feedback = `\nRepair the invalid exploration plan: ${problem}. Remaining repairs: ${ctx.limits.decisionRepairs - attempt}.`;
  }
  if (!plan) throw new Error("Invalid exploration plan after bounded repairs");
  for (const [index, id] of ctx.workerIds.entries()) {
    const role = roles[index]!;
    await spawnWorker(ctx, {
      id, role, cwd: ctx.options.cwd, baseSystemPrompt: ctx.options.baseSystemPrompt, tools: [...WORKER_TOOL_NAMES],
      route: resolveRoute(ctx.options.routes, role),
      modelRuntime: runtime,
      instructions: `${workerInstructions}\nFor exploration, do not create any files, including /tmp scripts. Use bash node inline or heredoc without redirection.`,
    });
  }
  for (const [index, id] of ctx.workerIds.entries()) {
    const peers = ctx.workerIds.filter(peer => peer !== id);
    assignWorker(ctx, id, "explore", explorationPrompt(ctx.options.problem, plan.explorers[index]!.angle, peers), true);
  }
}
async function converge(ctx: RunContext, cause: string, effects: readonly CoordinatorEffect[]): Promise<void> {
  await Promise.all(effects.map(async effect => {
    if (effect.type === "redirect") {
      emit(ctx, { type: "preempted", timestamp: Date.now(), agentId: effect.agentId, action: "redirect" });
      const redirect = ctx.manager.send({
        id: randomUUID(), type: "redirect", from: "main", to: effect.agentId, kind: "backlog_proposal",
        prompt: workerAssignment(ctx, effect.agentId, proposalPrompt(cause, ctx.workerIds.filter(id => id !== effect.agentId))),
      });
      await bounded(ctx, redirect, ctx.limits.assignmentMs, "Redirect");
    } else if (effect.type === "assign_proposal") {
      assignWorker(ctx, effect.agentId, "backlog_proposal", proposalPrompt(cause, ctx.workerIds.filter(id => id !== effect.agentId)));
    } else if (effect.type === "stop") {
      emit(ctx, { type: "preempted", timestamp: Date.now(), agentId: effect.agentId, action: "stop" });
      await ctx.manager.stop(effect.agentId);
    }
  }));
  apply(ctx, { type: "collect_backlog" });
}
export async function exploreUntilAccepted(ctx: RunContext): Promise<void> {
  const claims: RootCauseClaim[] = [];
  const finished = new Set<string>();
  const stage = "Exploration without accepted cause";
  ctx.stage = stage;
  const phase = runDeadline(ctx).phase(ctx.limits.explorationMs, stage);
  while (ctx.state.phase === "EXPLORE") {
    const event = await ctx.manager.wait("any", phase.remainingMs());
    if (event.type === "timeout") {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (ctx.cancelled) throw new Error("cancelled"); // a closed manager answers at once: never spin on it
      const error = expiry(ctx, stage, phase);
      if (!error) continue; // extended (the run is still active), or not due yet: wait again until the new deadline
      ctx.cancel?.(error);
      throw error;
    }
    let claim: RootCauseClaim | undefined;
    if (event.type === "message" && event.message.signal?.kind === "root_cause_found" && event.message.signal.cause) {
      claim = {
        agentId: event.message.from, cause: event.message.signal.cause,
        evidence: event.message.signal.evidence, via: "note",
      };
    }
    if (event.type === "outcome" && event.outcome.kind === "explore") {
      finished.add(event.outcome.agentId);
      const data = event.outcome.result?.data;
      if (data && typeof data === "object" && "cause" in data && typeof data.cause === "string" && data.cause.trim()) {
        claim = {
          agentId: event.outcome.agentId, cause: data.cause,
          evidence: "evidence" in data ? data.evidence : undefined, via: "result",
        };
      }
    }
    if (claim) claims.push(claim);
    if (!claim && finished.size !== ctx.workerIds.length) continue;
    const decision = await decide(ctx, {
      problem: ctx.options.problem, claims, allExplorersFinished: finished.size === ctx.workerIds.length,
      requirement: "Accept an evidenced strong cause NOW to preempt redundant exploration. Concrete source locations and causal reproduction/log evidence suffice; do not wait for every explorer or duplicate proof. Continue only if evidence is genuinely insufficient.",
    });
    if (decision.type === "continue_exploration" && finished.size === ctx.workerIds.length) {
      throw new Error("All explorers finished without accepted cause");
    }
    const effects = apply(ctx, decision);
    if (decision.type === "root_cause_accepted") {
      emit(ctx, { type: "root_cause_accepted", timestamp: Date.now(), agentId: decision.sourceAgentId, cause: decision.cause });
      await converge(ctx, decision.cause, effects);
    }
  }
  if (ctx.state.phase === "FAILED") throw new Error(ctx.state.failure);
}
/** Proposal data was already validated inside report_result; an invalid one fails its assignment there. */
export async function collectProposals(ctx: RunContext): Promise<BacklogProposal[]> {
  const outcomes = await waitOutcomes(ctx, "backlog_proposal", new Set(ctx.workerIds));
  // Exploration and proposals are read-only: any workspace change since the start is a violation.
  await auditWorkspace(ctx, ctx.workerIds, () => false);
  return outcomes.map(outcome => {
    const data = outcome.result?.data;
    if (!Value.Check(proposalSchema, data)) throw new Error(`Invalid proposal from ${outcome.agentId}`);
    return { ...data, sourceAgentId: outcome.agentId };
  });
}
