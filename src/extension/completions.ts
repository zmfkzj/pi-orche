/**
 * Argument completions for `/orche`. Pi passes everything after `/orche ` and replaces it with the chosen value, so every candidate is a
 * whole argument string that parseOrcheCommand accepts; the prompt modes end with a space so the prompt can be typed right away.
 */
import { MAIN_MODES, type MainMode } from "../orchestration/routing.js";

export interface CommandCompletion { value: string; label: string; description?: string }

/** One-shot modes: the request runs in the mode, the session's own mode stays (index.ts, docs/orchestrator.md 14.5). */
const MODE_DESCRIPTIONS: Partial<Record<string, string>> = {
  single: "Delegate this request to one worker (session mode unchanged)",
  strong: "This request on the strong model tiers (session mode unchanged)",
  ultra: "This request with quality-first ultra orchestration (session mode unchanged)",
  direct: "Edit directly for one turn",
};
const describeMode = (mode: MainMode) => MODE_DESCRIPTIONS[mode] ?? `${mode} for one turn`;

/** The static candidates, in menu order; `stop <id>` entries for live workers are added by {@link completeOrcheArguments}. */
export function orcheCompletions(workerIds: readonly string[] = []): CommandCompletion[] {
  const items: CommandCompletion[] = [
    ...MAIN_MODES.map(mode => ({ value: `${mode} `, label: `${mode} <prompt>`, description: describeMode(mode) })),
    { value: "mode", label: "mode", description: "Show the session's delegation mode" },
    ...MAIN_MODES.map(mode => ({ value: `mode ${mode}`, label: `mode ${mode}`, description: `Set the session's delegation mode to ${mode}` })),
    { value: "workers", label: "workers", description: "List workers" },
    { value: "stop all", label: "stop all", description: "Dispose every worker" },
    ...workerIds.filter(id => id !== "all" && /^\S+$/.test(id)).map(id => ({ value: `stop ${id}`, label: `stop ${id}`, description: `Dispose worker ${id}` })),
    { value: "records", label: "records", description: "This session's recent task records" },
    { value: "splits", label: "splits", description: "Split decisions over all sessions (optionally: splits <days>)" },
    { value: "models", label: "models", description: "Model tiers and where each comes from" },
    { value: "cancel", label: "cancel", description: "Stop the active task" },
    { value: "detach", label: "detach", description: "Stop waiting for the background task" },
  ];
  const seen = new Set<string>();
  return items.filter(item => !seen.has(item.value) && !!seen.add(item.value));
}

/** Candidates starting with the typed text; a lone exact match is dropped so Enter submits the command instead of re-applying it. */
export function completeOrcheArguments(prefix: string, workerIds: readonly string[] = []): CommandCompletion[] | null {
  const typed = prefix.trimStart();
  const items = orcheCompletions(workerIds).filter(item => item.value.startsWith(typed));
  if (items.length === 0 || (items.length === 1 && items[0]!.value === typed)) return null;
  return items;
}
