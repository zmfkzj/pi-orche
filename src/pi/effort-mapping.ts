/**
 * Effective thinking levels (docs/thinking-policy.md "Effective effort"): which of Pi's level names reach the model as the SAME
 * effort, so that the phase policy's step level S and the output-limit recovery's step-down are a real step down.
 *
 * Two sources, applied in this order:
 * 1. the model's own `thinkingLevelMap` (Pi metadata: the provider string a level is sent as; two levels sent as the same string are
 *    one effective level);
 * 2. aliases of what a proxy does with that string further on, which Pi cannot know: the built-in rule below, replaced by the first
 *    matching `thinkingPolicy.effortAliases` entry of orche.config.json (an entry with `aliases: {}` switches the built-in rule off).
 *
 * Built-in rule (observed, not assumed for every model): CLIProxyAPI translates the Responses `reasoning.effort` of a Claude model
 * into Claude's `output_config.effort`, and maps BOTH `xhigh` and `max` to `max` (CLIProxyAPI 8.0.16 a2976eb8 and 8.0.20,
 * internal/thinking/convert.go; offline probe in docs/thinking-policy.md). It applies only to models Pi sends through that proxy's
 * Responses path (api `cliproxyapi-codex-responses`) whose id names a Claude model; any other provider or model keeps distinct
 * levels (the safe fallback: a name is its own effective level), and the record says which mapping was used.
 */
import { THINKING_LEVELS } from "./thinking-levels.js";

/** The api id under which @router-for-me/pi-cliproxyapi-provider sends requests to CLIProxyAPI's Responses endpoint. */
export const CLIPROXY_RESPONSES_API = "cliproxyapi-codex-responses";

/** Model metadata this module reads (a Pi `Model` fits). */
export interface EffortModel {
  provider?: string;
  id?: string;
  api?: string;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** One `thinkingPolicy.effortAliases` entry: `model` is `provider/id` with `*` wildcards; `aliases` maps a sent effort to the one the model gets. */
export interface EffortAliasRule {
  model: string;
  aliases: Record<string, string>;
}

export interface EffortMapping {
  /** Pi level name → the effort the model actually runs at (itself when nothing maps it). */
  names: Record<string, string>;
  /** Where the proxy aliases came from: "builtin:cliproxyapi-claude", "config:<pattern>" or "none". */
  source: string;
  /** The non-identity entries of `names` (records). */
  aliases: Record<string, string>;
}

const isClaude = (id: string | undefined) => !!id && /(^|\/)claude-/i.test(id);

/** Whether `model` is a Claude model sent through CLIProxyAPI's Responses path (the scope of the built-in rule and the output cap). */
export function isCliproxyClaude(model: EffortModel | undefined): boolean {
  return !!model && model.api === CLIPROXY_RESPONSES_API && isClaude(model.id);
}

const BUILTIN_CLIPROXY_CLAUDE: Readonly<Record<string, string>> = { xhigh: "max" };

const globToRegExp = (pattern: string) => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

/** Whether `provider/id` of `model` matches `pattern` (`*` wildcards, case-insensitive). */
export function modelMatches(model: EffortModel | undefined, pattern: string): boolean {
  return !!model && globToRegExp(pattern).test(`${model.provider ?? ""}/${model.id ?? ""}`);
}

/** The first rule whose `model` pattern matches `provider/id`. */
export function matchEffortRule(model: EffortModel | undefined, rules: readonly EffortAliasRule[] | undefined): EffortAliasRule | undefined {
  return rules?.find(rule => modelMatches(model, rule.model));
}

/** The effective level of every Pi level name for `model` (see the module comment). */
export function effortMappingFor(model: EffortModel | undefined, rules?: readonly EffortAliasRule[]): EffortMapping {
  const rule = matchEffortRule(model, rules);
  const proxy = rule ? rule.aliases : isCliproxyClaude(model) ? BUILTIN_CLIPROXY_CLAUDE : {};
  const source = rule ? `config:${rule.model}` : isCliproxyClaude(model) ? "builtin:cliproxyapi-claude" : "none";
  const names: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  for (const level of THINKING_LEVELS) {
    const sent = model?.thinkingLevelMap?.[level];
    const wire = typeof sent === "string" && sent ? sent : level;
    const effective = proxy[wire] ?? wire;
    names[level] = effective;
    if (effective !== level) aliases[level] = effective;
  }
  return { names, source, aliases };
}

/** Rank of a level's effective effort on the {@link THINKING_LEVELS} scale (its own rank when the effective name is not a Pi level). */
export function effectiveRank(level: string | undefined, names?: Readonly<Record<string, string>>): number {
  if (level === undefined) return -1;
  const own = (THINKING_LEVELS as readonly string[]).indexOf(level);
  const mapped = names?.[level];
  const rank = mapped === undefined ? -1 : (THINKING_LEVELS as readonly string[]).indexOf(mapped);
  return rank >= 0 ? rank : own;
}
