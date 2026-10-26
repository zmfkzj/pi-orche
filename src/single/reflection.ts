/**
 * Strong-mode reflection before the self-review (`single.strongReflection`, off unless set; docs/strong-reflection.md): an
 * experiment that gives the worker of a strong-mode implement/answer assignment one fixed reflection prompt right before it reviews
 * its own work. Nothing else changes: the review itself, its checks, the report gates and the report format stay as they are.
 *
 * Strong is the single workflow on the strong tiers; it has no separate self-review API. The observable self-review boundary is the
 * Task DAG's integration node (`phase: "integrate"`: compare every requirement with the actual changes and checks) before
 * report_result. The prompt is given once per assignment, at the first of:
 * - `integrate`: the first ACCEPTED task_plan (after validation and carry-over) that sets an integration node running; the prompt
 *   is part of that task_plan result, so the model reads it in its next request, before the review's own tool calls;
 * - `report`: the first report_result while no integration node was set running (no integration node at all, or one that went
 *   pending → done in one call, i.e. a review that ran without the prompt). The report was already drafted then, so the call is
 *   held once (a blocked tool call: no validation error, no result retry) with the prompt and the request for a fresh self-review
 *   before it is sent again.
 * A report_result in the same model response as the delivery has not been read with the prompt (a tool result is seen only by the
 * next request): it is held too, which also covers a second report_result in the held one's response. Every later report goes on
 * to the existing gates (report rewrite, data checks, checklist, integration gate, advisor) unchanged.
 */
import type { TaskPlan } from "../tools/task-plan.js";

/** The reflection prompt, verbatim (the user's four lines). */
export const STRONG_REFLECTION_PROMPT = [
  "지금까지의 대화를 한 걸음 떨어져 바라보라.",
  "기존 판단을 옹호하거나 부정하려는 목적 없이, 대화에 드러난 전제와 판단 경향을 살펴보라.",
  "무엇을 충분히 살폈고 무엇을 당연하게 넘겼는지 돌아보되, 장점이나 단점을 억지로 만들어내지 마라.",
  "그 관찰에서 실제로 판단을 바꿀 이유가 발견되면 결과에 반영하라.",
].join("\n");

export interface ReflectionSummary {
  /** Where the prompt was given: at the start of an integration node, at a held first report, or not at all. */
  delivered: "integrate" | "report" | "none";
  /** The integration node whose start carried it (`integrate`). */
  node?: string;
  /** When it was given (epoch ms). */
  at?: number;
  /** report_result calls held because they came in the model response that carried the prompt (before it was read). */
  sameResponseHolds?: number;
}

/** The text that comes with the prompt at the start of integration node `node`. */
export function integrationReflection(node: string): string {
  return `Reflection before your self-review (strong mode, single.strongReflection; integration node ${node}):\n${STRONG_REFLECTION_PROMPT}\nThen carry out the integration as planned: this assignment's requirements, checks and report format are unchanged.`;
}

/** The reason a first report_result is held when no integration node carried the prompt. */
export const REPORT_REFLECTION = `Report held once (strong mode, single.strongReflection): this is not a validation error, and nothing in your report was found wrong. Before your self-review of the result:\n${STRONG_REFLECTION_PROMPT}\nThen review the result afresh yourself against every requirement and the actual changes and checks, and call report_result alone again with your complete result (the same result when nothing gives a real reason to change it). This assignment's requirements, checks and report format are unchanged.`;

/** The reason a report_result is held that was sent in the same response as the prompt (so before it was read). */
export const SAME_RESPONSE_REFLECTION = "Report held (strong mode, single.strongReflection): it was sent in the same response that received the reflection prompt, so it was written before that prompt was read. Read the reflection prompt in this response's tool results, do your self-review, then call report_result alone again with your complete result. This is not a validation error.";

/** One assignment's reflection: given at most once (see the module comment). */
export class StrongReflection {
  private given?: ReflectionSummary & { calls: readonly string[] };
  private holds = 0;
  /**
   * `responseCalls`: the tool call ids of the model response being executed (the latest assistant message), to tell a report_result
   * of the delivering response from a later one.
   */
  constructor(private readonly options: { responseCalls?: () => readonly string[]; onDelivered?: (summary: ReflectionSummary) => void } = {}) {}

  /** Lines for the result of an accepted task_plan: the prompt when this plan starts the first integration node. */
  onPlan(plan: TaskPlan): string[] {
    if (this.given) return [];
    const node = plan.nodes.find(item => item.phase === "integrate" && item.status === "running");
    if (!node) return [];
    this.deliver({ delivered: "integrate", node: node.id, at: Date.now() });
    return [integrationReflection(node.id)];
  }

  /** The reason to hold a report_result call (`toolCallId`: its id); undefined lets it through to the existing gates. */
  beforeReport(toolCallId?: string): string | undefined {
    if (!this.given) {
      this.deliver({ delivered: "report", at: Date.now() });
      return REPORT_REFLECTION;
    }
    if (toolCallId && this.given.calls.includes(toolCallId)) {
      this.holds++;
      return SAME_RESPONSE_REFLECTION;
    }
    return undefined;
  }

  summary(): ReflectionSummary {
    if (!this.given) return { delivered: "none" };
    const { calls: _calls, ...summary } = this.given;
    return { ...summary, ...(this.holds ? { sameResponseHolds: this.holds } : {}) };
  }

  private deliver(summary: ReflectionSummary): void {
    let calls: readonly string[] = [];
    try { calls = [...this.options.responseCalls?.() ?? []]; } catch { /* unknown: later reports pass */ }
    this.given = { ...summary, calls };
    try { this.options.onDelivered?.({ ...summary }); } catch { /* observers cannot change the delivery */ }
  }
}
