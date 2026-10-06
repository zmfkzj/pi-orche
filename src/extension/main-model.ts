/**
 * `models.main` (docs/orchestrator.md 12): the Pi session's own model and thinking, applied when a fresh session starts.
 *
 * Pi's extension API sets them for the current session without changing the configured default (`pi.setModel`, which returns
 * false when the provider has no credentials, and `pi.setThinkingLevel`, clamped to the model; ExtensionAPI in Pi's
 * `core/extensions/types.d.ts`, used the same way by Pi's `examples/extensions/preset.ts`). The model comes from the session's own
 * registry (`ctx.modelRegistry.find`), so a provider that another Pi extension registers is found too.
 *
 * Applied only at `session_start` with reason `startup` (Pi started) or `new` (`/new`; Pi itself then starts from the default
 * model again), only on a session without messages or model/thinking changes of its own, and not when the command line chose
 * the model (`--model`, `--models`, `--provider`, `--thinking`). A resumed, forked or reloaded session keeps its model, and
 * nothing re-applies it later: a model or thinking level the user picks during the session (`/model`, the cycle keys) stays.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inheritsMain, type ModelTiers, type RouteSettings } from "../orchestration/routing.js";
import { withExtendedContext } from "../pi/extended-context.js";

export const MAIN_MODEL_START_REASONS: readonly string[] = ["startup", "new"];
/** Pi's command-line flags that choose the session's model or thinking (Pi's `cli/args.js`). */
export const MODEL_CLI_FLAGS: readonly string[] = ["--model", "--models", "--provider", "--thinking"];

export interface MainModelResult {
  /** What was applied, when it was. */
  applied?: { model: string; thinking?: string; contextWindow?: number };
  /** Why nothing was applied although `models.main` is set. */
  skipped?: string;
  /** Warnings for the user (ctx.ui.notify). */
  warnings: string[];
}

export async function applyMainModel(
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel" | "getThinkingLevel">,
  ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">,
  reason: string,
  tier: RouteSettings | undefined,
  argv: readonly string[] = process.argv,
): Promise<MainModelResult> {
  if (!tier) return { warnings: [] };
  if (!MAIN_MODEL_START_REASONS.includes(reason)) return { skipped: `the session was ${reason === "reload" ? "reloaded" : reason === "resume" ? "resumed" : reason === "fork" ? "forked" : reason} and keeps its own model`, warnings: [] };
  const flag = argv.find(arg => MODEL_CLI_FLAGS.includes(arg));
  if (flag) return { skipped: `the command line chose the model (${flag})`, warnings: [] };
  // A fresh session holds only Pi's initial model and thinking entries (one each); more, or any message, is the session's own.
  const branch = ctx.sessionManager.getBranch();
  const count = (type: string) => branch.filter(entry => entry.type === type).length;
  if (count("message") > 0 || count("model_change") > 1 || count("thinking_level_change") > 1) return { skipped: "the session already has its own history or model choice", warnings: [] };
  const slash = tier.model.indexOf("/");
  const found = ctx.modelRegistry.find(tier.model.slice(0, slash), tier.model.slice(slash + 1));
  if (!found) return { skipped: `${tier.model} is not in Pi's model list`, warnings: [`orche: models.main ${tier.model} is not in Pi's model list (see /model); keeping the session's model.`] };
  // extendedContext: the same larger window orche gives its workers (src/pi/extended-context.ts); off: the model's own window.
  const model = withExtendedContext(found, tier.extendedContext).model;
  if (!await pi.setModel(model)) return { skipped: `${tier.model} has no credentials`, warnings: [`orche: models.main ${tier.model} has no configured credentials; keeping the session's model.`] };
  if (tier.thinking) pi.setThinkingLevel(tier.thinking);
  return { applied: { model: tier.model, thinking: pi.getThinkingLevel(), contextWindow: model.contextWindow }, warnings: [] };
}

/** A configured orchestrator or worker tier: its own model, or main's model when it says `"main"` (INHERIT_MAIN). */
const describe = (route: RouteSettings, inherited: string, main: { model?: string; current: string }) => inheritsMain(route)
  ? route.thinking ? `main's model (${main.model ?? "no model selected"}) with thinking ${route.thinking}` : `main's model and thinking (${main.current})`
  : `${route.model} ${route.thinking ?? `(thinking: ${inherited})`}${route.extendedContext ? ", extended context" : ""}`;
const tierSource = (tier: string, route: RouteSettings) => `config models.${tier}${inheritsMain(route) ? ' "main"' : ""}`;

/** What `/orche models` shows: the main session now, the config tiers, and what happened to `models.main` at session start. */
export interface ModelTiersView {
  /** The main session's model now (`provider/id`) and thinking. */
  main?: string;
  thinking?: string;
  mode: string;
  path?: string;
  error?: string;
  tiers?: ModelTiers;
  atStart: { configured?: RouteSettings; applied?: MainModelResult["applied"]; skipped?: string };
}

/** The text of `/orche models`: each tier's model and where it comes from (config, inherited, Pi). */
export function formatModelTiers(view: ModelTiersView): string {
  const current = view.main ? `${view.main} ${view.thinking ?? "off"}` : "no model selected";
  const configuredMain = view.tiers?.main;
  const applied = view.atStart.applied;
  const mainSource = applied
    ? applied.model === view.main ? "config models.main (applied at session start)" : `Pi: chosen during the session (models.main ${applied.model} was applied at start)`
    : configuredMain
      ? `Pi (models.main ${configuredMain.model} not applied: ${view.atStart.configured ? view.atStart.skipped ?? "not applied" : "set after this session started; applies from the next new session"})`
      : "Pi (no models.main)";
  const orchestrator = view.tiers?.orchestrator;
  const worker = view.tiers?.worker;
  const main = { ...(view.main ? { model: view.main } : {}), current };
  return [
    `orche models (${view.path ?? "no orche config file"}${view.error ? `; config error: ${view.error}` : ""}; mode ${view.mode}):`,
    `- main: ${current} — ${mainSource}`,
    `- orchestrator (orche_task explore/answer/implement/verify): ${orchestrator ? `${describe(orchestrator, "main's", main)} — ${tierSource("orchestrator", orchestrator)}` : `inherited from main (${current})`}`,
    `- worker (orche_spawn sub-workers, the fresh verifier included): ${worker ? `${describe(worker, "the orchestrator's", main)} — ${tierSource("worker", worker)}` : `inherited from the orchestrator (${orchestrator && !inheritsMain(orchestrator) ? orchestrator.model : view.main ?? "main's model"})`}`,
    "- game-asset, video: their own routes (models does not apply)",
    ...(orchestrator || worker ? ["A configured model that orche's runtime cannot resolve is replaced by the inherited one, with a warning in the task result."] : []),
    ...(view.mode === "direct" ? ["Direct mode: main does the work itself; only models.main applies."] : []),
  ].join("\n");
}
