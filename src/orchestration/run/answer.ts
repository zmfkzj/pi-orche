import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { READ_ONLY_TOOL_NAMES } from "../../tools/index.js";
import { resolveRoute } from "../routing.js";
import { cycled } from "../team.js";
import { answerPrompt, workerInstructions } from "../prompts.js";
import { apply, spawnWorker, waitOutcomes } from "./context.js";
import { decide } from "./decisions.js";
import { auditWorkspace } from "./audit.js";
import type { RunContext } from "./types.js";

/** `answer` class: read-only analysts, then an approved evidence-backed answer. */
export async function runAnswer(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  for (const id of ctx.workerIds) {
    await spawnWorker(ctx, {
      id, role: "analyst", cwd: ctx.options.cwd,
      route: resolveRoute(ctx.options.routes, "analyst"), modelRuntime: runtime,
      tools: [...READ_ONLY_TOOL_NAMES], baseSystemPrompt: ctx.options.baseSystemPrompt,
      instructions: `${workerInstructions}\nYour id is ${id}. This is a strictly read-only request. Never modify or create files, including scratch files. Reply in the user's language (${ctx.state.language}; Korean requests require Korean answers).`,
    });
  }
  for (const [index, id] of ctx.workerIds.entries()) {
    ctx.manager.assign(id, "answer", answerPrompt(ctx.options.problem, cycled(ctx.team.answerAngles, index), ctx.workerIds.filter(peer => peer !== id), ctx.state.language!));
  }
  const outcomes = await waitOutcomes(ctx, "answer", new Set(ctx.workerIds));
  // Analysts hold read-only tools only: a change not traceable to a worker tool call is external
  // (another session, the user, a commit elsewhere), never a violation that would discard the answer.
  await auditWorkspace(ctx, ctx.workerIds, () => false, { readOnly: true });
  for (const outcome of outcomes) {
    if (outcome.result?.summary.trim()) ctx.workerAnswers.set(outcome.agentId, outcome.result.summary);
  }
  const decision = await decide(ctx, {
    problem: ctx.options.problem,
    evidence: outcomes.map(outcome => ({ agentId: outcome.agentId, result: outcome.result })),
    requirement: "Approve an evidence-backed full user-facing answer in the user's language. When one worker already supplied a complete answer, prefer type answer_from_worker with sourceAgentId and a concise summary; its full text is passed through unchanged without regenerating it in the tool arguments. Use type answer with the full text only when substantive edits or synthesis across workers are needed. Preserve concrete file references and relevant caveats. Do not propose or perform implementation; no file changes are authorized.",
  });
  apply(ctx, decision);
}
