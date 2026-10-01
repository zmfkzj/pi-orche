import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Curated maximum input windows for models whose provider accepts more than the window the catalog advertises
 * (the advertised value is the standard-price threshold; input above it is billed at the premium long-context tier,
 * 2x input for these models). Keyed by exact model id. Source: OpenAI documents 1.05M total context with at most
 * 922K input for the GPT-6 Sol/Astra family; the same figures are what omp's `extendedContext` policy uses.
 * Models without an entry (gpt-6-luna, gpt-6-sol, Claude, ...) are never changed.
 */
export const EXTENDED_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "gpt-6.1-sol": 922_000,
  "gpt-6-astra": 922_000,
};

export interface ContextWindowInfo {
  /** `provider/id`. */
  model: string;
  /** The window the session works with. */
  contextWindow: number;
  /** The window the catalog advertises for the model. */
  advertisedContextWindow: number;
  /** `contextWindow` was raised above the advertised window. */
  extended: boolean;
}

/**
 * A copy of the model whose `contextWindow` is the curated maximum when `enabled` and the model has one
 * (never lowered). Pi derives its output clamp (`contextWindow - input - 4096`), overflow detection and
 * compaction thresholds from this metadata; nothing is sent to the provider differently.
 */
export function withExtendedContext(model: Model<Api>, enabled: boolean | undefined): { model: Model<Api>; info: ContextWindowInfo } {
  const maximum = enabled && Object.hasOwn(EXTENDED_CONTEXT_WINDOWS, model.id) ? EXTENDED_CONTEXT_WINDOWS[model.id] : undefined;
  const extended = maximum !== undefined && maximum > model.contextWindow;
  const effective = extended ? { ...model, contextWindow: maximum } : model;
  return {
    model: effective,
    info: { model: `${model.provider}/${model.id}`, contextWindow: effective.contextWindow, advertisedContextWindow: model.contextWindow, extended },
  };
}
