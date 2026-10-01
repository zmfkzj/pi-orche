import { clip, LIMITS } from "./context.js";
import type { AdvisorTriggerKind } from "./config.js";

export interface AdvisorPromptInput {
  advisorName: string;
  trigger: AdvisorTriggerKind;
  /** Agent whose activity fired the trigger: a worker id or "coordinator". */
  subject: string;
  subjectRole: string;
  /** "coordinator" or a worker id: who will receive the NOTE. */
  recipient: string;
  problem: string;
  detail: unknown;
  transcript: string;
  diff: string;
  awaiting: boolean;
}
const triggerSummary: Record<AdvisorTriggerKind, string> = {
  coordinator_decision: "the coordinator is about to apply a decision",
  before_complete: "the coordinator is about to complete the run",
  assignment_started: "an assignment just started",
  assignment_result: "an assignment just finished",
  turn_end: "a periodic turn checkpoint",
  tool_error: "a tool call failed",
  interval: "a periodic time checkpoint",
};
/** User-visible prompt of one advisor call. Total size is bounded by LIMITS. */
export function advisorPrompt(input: AdvisorPromptInput): string {
  const detail = clip(typeof input.detail === "string" ? input.detail : JSON.stringify(input.detail), LIMITS.detailChars);
  return [
    `Advisor review for "${input.advisorName}". Trigger: ${input.trigger} — ${triggerSummary[input.trigger]}.`,
    `Observed agent: ${input.subject} (${input.subjectRole}). Advice will be delivered as a NOTE to: ${input.recipient}.`,
    input.awaiting ? "The coordinator is waiting for your review before applying the decision below, and may reconsider it once." : "The run continues while you review; keep the advice short and actionable.",
    `User request:\n${clip(input.problem, LIMITS.problemChars)}`,
    `Trigger context:\n${detail}`,
    `Observed agent transcript since the last advice:\n${input.transcript || "(nothing new)"}`,
    `Workspace changes (git):\n${input.diff}`,
    "You may inspect files with your read-only tools when the evidence above is insufficient. Then call advisor_verdict once.",
  ].join("\n\n");
}
