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
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PROFILE, findProfile, INHERIT_MAIN, inheritsMain, inheritsMainThinking, profileNames, profileTiers, tierThinking, type ModelProfile, type ModelTiers, type ProfileTiers, type RouteSettings, type TierSettings } from "../orchestration/routing.js";
import { withExtendedContext } from "../pi/extended-context.js";
import { THINKING_LEVELS } from "../pi/thinking-levels.js";

/**
 * The thinking a tier that sets none of its own inherits from main (docs/orchestrator.md 12): main's current level, but not below
 * `floor` (models.main's thinking, else main's level at the last session start). Lowering main's thinking during the session (for
 * example to make main hand off faster) then does not lower the workers that only inherit it; raising it still raises them. A tier
 * that names main's thinking (`thinking: "main"`, `{ "model": "main" }` without a level) is not floored: it follows main exactly.
 * The worker's model clamps the result like any level.
 */
export function inheritedThinking(current: ThinkingLevel | undefined, floor: ThinkingLevel | undefined): ThinkingLevel | undefined {
  const rank = (level: ThinkingLevel | undefined) => level === undefined ? -1 : (THINKING_LEVELS as readonly string[]).indexOf(level);
  return rank(floor) > rank(current) ? floor : current;
}

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

/**
 * A configured orchestrator or worker tier: its own model, or main's model when it says `"main"` (INHERIT_MAIN); its own thinking
 * level, main's current thinking (`thinking: "main"`, shown with the level main has now), or the inherited one when it sets none.
 */
const describe = (route: TierSettings, inherited: string, main: { model?: string; current: string; thinking: string }) => inheritsMain(route)
  ? tierThinking(route) ? `main's model (${main.model ?? "no model selected"}) with thinking ${route.thinking}` : `main's model and thinking (${main.current})`
  : `${route.model} ${route.thinking === INHERIT_MAIN ? `with main's thinking (${main.thinking})` : route.thinking ?? `(thinking: ${inherited})`}${route.extendedContext ? ", extended context" : ""}`;
/** Where a tier is configured (`models.worker`, `profiles.fast.worker`), and whether it names main's model or thinking. */
const tierSource = (key: string, route: TierSettings) => `config ${key}${inheritsMain(route) ? ' "main"' : route.thinking === INHERIT_MAIN ? ' (thinking "main")' : ""}`;
/**
 * The tiers main's current thinking reaches at the next hand-off: the orchestrator unless it sets a level of its own; the worker
 * directly when it names main's thinking, else through the orchestrator when it sets no level and the orchestrator takes main's.
 * The advisor likewise, when `single.advisor` is on (`advisor`).
 */
export function mainThinkingReach(tiers: ModelTiers | undefined, advisor = false): string[] {
  const orchestrator = !tierThinking(tiers?.orchestrator);
  const reach = (tier: "worker" | "advisor", route: TierSettings | undefined) =>
    inheritsMainThinking(route) ? [tier] : !tierThinking(route) && orchestrator ? [`${tier} (through the orchestrator)`] : [];
  return [
    ...(orchestrator ? ["orchestrator"] : []),
    ...reach("worker", tiers?.worker),
    ...(advisor ? reach("advisor", tiers?.advisor) : []),
  ];
}

/** What `/orche models` shows: the main session now, the config tiers, and what happened to `models.main` at session start. */
export interface ModelTiersView {
  /** The main session's model now (`provider/id`) and thinking. */
  main?: string;
  thinking?: string;
  /** The floor of implicit thinking inheritance ({@link inheritedThinking}) and where it comes from. */
  thinkingFloor?: { level: string; source: "models.main" | "session start" };
  mode: string;
  /** The profile in force (`--profile`; default `default`) and the config's profiles (routing.ts profileTiers). */
  profile?: string;
  profiles?: Readonly<Record<string, ModelProfile>>;
  path?: string;
  error?: string;
  tiers?: ModelTiers;
  /** `single.advisor` of the config file (default off). */
  advisor?: boolean;
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
  const main = { ...(view.main ? { model: view.main } : {}), current, thinking: view.thinking ?? "off" };
  // The tiers of the profile in force, by the resolver orche_task uses (routing.ts profileTiers): its own tier, then the
  // top-level models tier, then inheritance. A profile the config does not define is shown as such; orche_task refuses it.
  const profile = view.profile ?? DEFAULT_PROFILE;
  let tiers: ProfileTiers;
  let unknownProfile: string | undefined;
  try { tiers = profileTiers(view.tiers, view.profiles, profile); }
  catch (error) { unknownProfile = error instanceof Error ? error.message : String(error); tiers = profileTiers(view.tiers, view.profiles); }
  const orchestrator = tiers.orchestrators[0];
  const worker = tiers.worker;
  const advisor = tiers.advisors[0];
  const reach = mainThinkingReach({ ...view.tiers, orchestrator: orchestrator?.tier, worker: worker?.tier, advisor: advisor?.tier } as ModelTiers, !!view.advisor);
  const modelOf = (tier: TierSettings | undefined) => tier && !inheritsMain(tier) ? tier.model : view.main ?? "main's model";
  const orchestratorModel = modelOf(orchestrator?.tier);
  const fallback = (candidates: ProfileTiers["orchestrators"]) => candidates.length > 1 ? `; unresolvable: ${candidates[1]!.key}` : "";
  const names = profileNames(view.profiles);
  const describeProfile = (name: string) => {
    if (name === DEFAULT_PROFILE) return `${name} (the top-level models)`;
    const own = findProfile(view.profiles, name);
    const keys = [...(["orchestrator", "worker", "advisor"] as const).filter(key => own && Object.hasOwn(own, key)).map(key => own![key] === null ? `${key}: unset` : `${key}: ${own![key]!.model}`), ...(own?.routes && Object.keys(own.routes).length ? [`routes: ${Object.keys(own.routes).join(", ")}`] : [])];
    return `${name} (${keys.join(", ") || "no overrides"}${own?.legacy ? "; from the former models.strong-* tiers" : ""})`;
  };
  return [
    `orche models (${view.path ?? "no orche config file"}${view.error ? `; config error: ${view.error}` : ""}; mode ${view.mode}; profile ${profile}):`,
    `- main: ${current} — ${mainSource}`,
    `- orchestrator (orche_task explore/answer/implement/verify): ${orchestrator ? `${describe(orchestrator.tier, "main's", main)} — ${tierSource(orchestrator.key, orchestrator.tier)}${fallback(tiers.orchestrators)}` : `inherited from main (${current})`}`,
    `- worker (orche_spawn sub-workers, the fresh verifier included): ${worker ? `${describe(worker.tier, "the orchestrator's", main)} — ${tierSource(worker.key, worker.tier)}` : `inherited from the orchestrator (${orchestratorModel})`}`,
    `- advisor (single.advisor ${view.advisor ? "on" : "off"}: one read-only plan review per orche_task explore/answer/implement/verify assignment): ${advisor ? `${describe(advisor.tier, "the orchestrator's", main)} — ${tierSource(advisor.key, advisor.tier)}${fallback(tiers.advisors)}` : `inherited from the orchestrator (${orchestratorModel})`}${view.advisor ? "" : "; turn it on with \"single\": { \"advisor\": true }"}`,
    ...(view.mode === "direct" ? [] : [`- main's thinking (${view.thinking ?? "off"}) reaches at each hand-off: ${reach.length ? reach.join(", ") : "no tier (each sets its own level)"}${reach.length ? "; a model that lacks the level runs the nearest one it supports (Pi's clamp; the task result and run.json record the level used)" : ""}`]),
    ...(view.mode === "direct" || !view.thinkingFloor ? [] : [`- thinking floor ${view.thinkingFloor.level} (${view.thinkingFloor.source === "models.main" ? "models.main's thinking" : "main's level at session start"}): a tier that sets no thinking of its own takes main's current thinking but not below it, so lowering main's thinking does not lower it; thinking "main" (or { "model": "main" } without a level) follows main exactly; give a tier its own level (e.g. "thinking": "high") to keep it independent of main`]),
    `- game-asset, video: their own routes${profile !== DEFAULT_PROFILE && findProfile(view.profiles, profile)?.routes ? ` (profiles.${profile}.routes over the top-level routes)` : " (models does not apply)"}`,
    `- profiles (select with --profile <name>; omitted: ${DEFAULT_PROFILE}): ${names.map(describeProfile).join("; ")}`,
    ...(unknownProfile ? [`Profile ${profile} is not defined: orche_task refuses it until it is defined or another profile is selected (/orche mode <mode> --profile <name>). ${unknownProfile}`] : []),
    ...(tiers.orchestrators.length || worker || tiers.advisors.length ? ["A configured model that orche's runtime cannot resolve is replaced by the inherited one, with a warning in the task result."] : []),
    ...(view.mode === "direct" ? ["Direct mode: main does the work itself; only models.main applies."] : []),
  ].join("\n");
}
