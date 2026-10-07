/**
 * How orche_task shows the model and thinking (reasoning effort) a worker actually ran on: in the live progress lines, the result text,
 * the sub-worker lines and `/orche workers`.
 *
 *   openai/gpt-5 · thinking high                         the session's model and level; every response came from that model
 *   openai/gpt-5 ×3, openai/gpt-5-mini ×1 · thinking high  responses came from more than one model (requests per model)
 *   openai/gpt-5-mini ×2 (session model openai/gpt-5) · thinking high   the responses named another model than the session's
 *   model unknown · thinking unknown                      nothing says which: never a configured default in its place
 *
 * `model` and `thinking` are read from the worker's session (after Pi resolved the route and clamped the level to the model), not from
 * the configuration; `answered` counts the `provider/model` of each response the provider returned in the span shown.
 */
export interface ModelUse {
  /** `provider/id` of the session's model; undefined when unknown. */
  readonly model?: string | undefined;
  /** The thinking level the session runs on; undefined when unknown. */
  readonly thinking?: string | undefined;
  /** `provider/model` → responses, as answered. */
  readonly answered?: Readonly<Record<string, number>> | undefined;
}

export const UNKNOWN_MODEL = "model unknown";
export const UNKNOWN_THINKING = "thinking unknown";

/** `provider/id · thinking high` (see the module comment for several models and unknown values). */
export function formatModelUse(use: ModelUse): string {
  const answered = Object.entries(use.answered ?? {}).filter(([, count]) => count > 0);
  const model = !answered.length || answered.length === 1 && answered[0]![0] === use.model
    ? use.model || UNKNOWN_MODEL
    : `${answered.map(([name, count]) => `${name} ×${count}`).join(", ")}${use.model && !answered.some(([name]) => name === use.model) ? ` (session model ${use.model})` : ""}`;
  return `${model} · ${use.thinking ? `thinking ${use.thinking}` : UNKNOWN_THINKING}`;
}
