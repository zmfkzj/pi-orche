import type { CoordinatorDecision, Phase } from "../orchestration/phases.js";

export const BUILTIN_DOMAINS = ["plan", "verification", "correctness", "security", "performance", "tests", "scope", "docs"] as const;
export type BuiltinDomain = (typeof BUILTIN_DOMAINS)[number];
export type AdvisorDomain = BuiltinDomain | { id: string; instructions: string };
export type AdvisorTarget = "coordinator" | "workers" | `role:${string}` | `agent:${string}`;
export type AdvisorTrigger =
  | { on: "coordinator_decision"; decisions?: string[]; phases?: string[]; await?: boolean }
  | { on: "assignment_started" | "assignment_result"; kinds?: string[] }
  | { on: "turn_end"; every: number }
  | { on: "tool_error" }
  | { on: "interval"; ms: number }
  | { on: "before_complete" };
export type AdvisorTriggerKind = AdvisorTrigger["on"];

export interface AdvisorConfig {
  name: string;
  enabled?: boolean;
  /** Route role resolved through the routing config; default "advisor". */
  route?: string;
  domains: AdvisorDomain[];
  /** Who receives the advice. */
  targets: AdvisorTarget[];
  triggers: AdvisorTrigger[];
  cooldownMs?: number;
  maxCallsPerRun?: number;
  maxCallsPerTarget?: number;
  /** Wall-clock bound of one advisor call. */
  timeoutMs?: number;
}
/** Config with every default applied; what the engine consumes. */
export interface ResolvedAdvisor {
  readonly name: string;
  readonly route: string;
  readonly domains: readonly { id: string; instructions: string }[];
  readonly targets: readonly AdvisorTarget[];
  readonly triggers: readonly AdvisorTrigger[];
  readonly cooldownMs: number;
  readonly maxCallsPerRun: number;
  readonly maxCallsPerTarget: number;
  readonly timeoutMs: number;
}

export const advisorDefaults = { route: "advisor", cooldownMs: 30_000, maxCallsPerRun: 6, maxCallsPerTarget: 3, timeoutMs: 90_000 } as const;
export const MAX_ADVISORS = 8;
export const MIN_INTERVAL_MS = 100;

export const domainInstructions: Readonly<Record<BuiltinDomain, string>> = {
  plan: "Review decomposition, ownership and scope of the plan or classification: is the work split into the minimal tasks, are file ownerships disjoint and complete for what the request needs, are dependencies explicit, is the task class and worker count proportionate, is anything requested missing or anything unrequested included?",
  verification: "Audit claims against evidence: does each claim of success (tests passing, behavior fixed, requirement met) have concrete supporting evidence in the transcript or the workspace diff? Re-run cheap read-only checks where needed. Flag unsupported approvals, tests that do not exercise the change, missed requirements and regressions.",
  correctness: "Look for logic errors, wrong boundary conditions, unhandled cases and behavior that contradicts the stated requirement.",
  security: "Look for injection, unsafe file/command handling, secrets exposure, missing validation at trust boundaries and permission mistakes introduced by the change.",
  performance: "Look for avoidable complexity, repeated work, unbounded growth and blocking calls introduced by the change.",
  tests: "Judge whether tests exist for the change, would fail without it, and assert behavior rather than implementation details.",
  scope: "Check the change stays inside the request: flag unrelated edits, speculative features and missing parts of what was asked.",
  docs: "Check that documentation and user-facing messages match the behavior the change introduces.",
};

export const advisorPresets = {
  /** Ex orche-advisor: plan review before the coordinator applies classification / backlog decisions. */
  "plan-review": {
    name: "plan-review",
    route: "advisor",
    domains: ["plan"],
    targets: ["coordinator"],
    triggers: [{ on: "coordinator_decision", decisions: ["classify", "assign"], await: true }],
    cooldownMs: 0,
    maxCallsPerRun: 4,
    maxCallsPerTarget: 4,
  },
  /** Ex verification-auditor: claims-versus-evidence audit of every finished implementation or verification. */
  "verification-audit": {
    name: "verification-audit",
    route: "advisor",
    domains: ["verification"],
    targets: ["coordinator"],
    triggers: [{ on: "assignment_result", kinds: ["implement", "fix", "verify"] }],
    cooldownMs: 0,
    maxCallsPerRun: 6,
    maxCallsPerTarget: 6,
  },
} as const satisfies Record<string, AdvisorConfig>;
export type AdvisorPresetName = keyof typeof advisorPresets;

export class AdvisorConfigError extends Error {
  override readonly name = "AdvisorConfigError";
}

const decisionTypes: Record<CoordinatorDecision["type"], true> = {
  classify: true, answer: true, answer_from_worker: true, continue_exploration: true, root_cause_accepted: true,
  collect_backlog: true, assign: true, verify: true, verification_failed: true, replan: true, complete: true, fail: true,
};
const phaseNames: Record<Phase, true> = { EXPLORE: true, CONVERGE: true, BACKLOG: true, EXECUTE: true, VERIFY: true, DONE: true, FAILED: true };
/** Assignment kinds issued by the orchestrator or single-worker tool. */
export const ASSIGNMENT_KINDS = ["explore", "backlog_proposal", "implement", "fix", "verify", "answer", "game-asset", "video"] as const;
/** Decisions that end the run (checked by before_complete). */
export const COMPLETING_DECISIONS: readonly string[] = ["complete", "answer", "answer_from_worker"];

const fieldsOf = ["preset", "name", "enabled", "route", "domains", "targets", "triggers", "cooldownMs", "maxCallsPerRun", "maxCallsPerTarget", "timeoutMs"];
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

function fail(location: string, message: string): never {
  throw new AdvisorConfigError(`${location}: ${message}`);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function rejectUnknown(object: Record<string, unknown>, allowed: readonly string[], location: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(location, `unknown field "${key}" (allowed: ${allowed.join(", ")})`);
}
function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) fail(location, "expected non-empty string");
  return value;
}
function stringList(value: unknown, location: string, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.length) fail(location, "expected non-empty array of strings");
  return value.map((item, index) => {
    const text = nonEmptyString(item, `${location}[${index}]`);
    if (allowed && !allowed.includes(text)) fail(`${location}[${index}]`, `unknown value "${text}" (expected one of ${allowed.join(", ")})`);
    return text;
  });
}
function boundedInteger(value: unknown, location: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail(location, `expected integer >= ${min}`);
  return value;
}

function parseDomain(value: unknown, location: string): AdvisorDomain {
  if (typeof value === "string") {
    if (!(BUILTIN_DOMAINS as readonly string[]).includes(value)) fail(location, `unknown domain "${value}" (builtin: ${BUILTIN_DOMAINS.join(", ")}; or {id, instructions})`);
    return value as BuiltinDomain;
  }
  if (!isObject(value)) fail(location, "expected builtin domain name or {id, instructions}");
  rejectUnknown(value, ["id", "instructions"], location);
  const id = nonEmptyString(value.id, `${location}.id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(id)) fail(`${location}.id`, "expected letters, digits, '_', '.', '-' (max 32)");
  if ((BUILTIN_DOMAINS as readonly string[]).includes(id)) fail(`${location}.id`, `"${id}" is a builtin domain; use the bare name`);
  const instructions = nonEmptyString(value.instructions, `${location}.instructions`);
  if (instructions.length > 4000) fail(`${location}.instructions`, "at most 4000 characters");
  return { id, instructions };
}
function parseTarget(value: unknown, location: string): AdvisorTarget {
  if (value === "coordinator" || value === "workers") return value;
  if (typeof value === "string") {
    const match = /^(role|agent):(.+)$/.exec(value);
    if (match && match[2]!.trim() === match[2] && !/\s/.test(match[2]!)) return value as AdvisorTarget;
  }
  return fail(location, `expected "coordinator", "workers", "role:<role>" or "agent:<id>", received ${JSON.stringify(value)}`);
}
function parseTrigger(value: unknown, location: string): AdvisorTrigger {
  if (!isObject(value)) fail(location, "expected trigger object");
  const on = value.on;
  switch (on) {
    case "coordinator_decision": {
      rejectUnknown(value, ["on", "decisions", "phases", "await"], location);
      if (value.await !== undefined && typeof value.await !== "boolean") fail(`${location}.await`, "expected boolean");
      return {
        on,
        ...(value.decisions !== undefined ? { decisions: stringList(value.decisions, `${location}.decisions`, Object.keys(decisionTypes)) } : {}),
        ...(value.phases !== undefined ? { phases: stringList(value.phases, `${location}.phases`, Object.keys(phaseNames)) } : {}),
        ...(value.await !== undefined ? { await: value.await } : {}),
      };
    }
    case "assignment_started":
    case "assignment_result":
      rejectUnknown(value, ["on", "kinds"], location);
      return { on, ...(value.kinds !== undefined ? { kinds: stringList(value.kinds, `${location}.kinds`, ASSIGNMENT_KINDS) } : {}) };
    case "turn_end":
      rejectUnknown(value, ["on", "every"], location);
      return { on, every: boundedInteger(value.every, `${location}.every`, 1) };
    case "tool_error":
    case "before_complete":
      rejectUnknown(value, ["on"], location);
      return { on };
    case "interval":
      rejectUnknown(value, ["on", "ms"], location);
      return { on, ms: boundedInteger(value.ms, `${location}.ms`, MIN_INTERVAL_MS) };
    default:
      return fail(`${location}.on`, `unknown trigger ${JSON.stringify(on)} (expected coordinator_decision, assignment_started, assignment_result, turn_end, tool_error, interval, before_complete)`);
  }
}

/** Validate one advisors[] entry (with `preset` expansion). Returns the explicit config. */
function parseEntry(value: unknown, location: string): AdvisorConfig {
  if (!isObject(value)) fail(location, "expected advisor object");
  rejectUnknown(value, fieldsOf, location);
  let base: Record<string, unknown> = {};
  if (value.preset !== undefined) {
    if (typeof value.preset !== "string" || !Object.hasOwn(advisorPresets, value.preset))
      fail(`${location}.preset`, `unknown preset ${JSON.stringify(value.preset)} (available: ${Object.keys(advisorPresets).join(", ")})`);
    base = structuredClone(advisorPresets[value.preset as AdvisorPresetName]) as unknown as Record<string, unknown>;
  }
  const merged: Record<string, unknown> = { ...base, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "preset")) };
  const name = nonEmptyString(merged.name, `${location}.name`);
  if (!namePattern.test(name)) fail(`${location}.name`, `${JSON.stringify(name)} must match ${namePattern} (it becomes the NOTE sender advisor:<name>)`);
  if (merged.enabled !== undefined && typeof merged.enabled !== "boolean") fail(`${location}.enabled`, "expected boolean");
  if (!Array.isArray(merged.domains) || !merged.domains.length) fail(`${location}.domains`, "expected non-empty array");
  if (!Array.isArray(merged.targets) || !merged.targets.length) fail(`${location}.targets`, "expected non-empty array");
  if (!Array.isArray(merged.triggers) || !merged.triggers.length) fail(`${location}.triggers`, "expected non-empty array");
  const domains = merged.domains.map((domain, index) => parseDomain(domain, `${location}.domains[${index}]`));
  const ids = domains.map(domain => typeof domain === "string" ? domain : domain.id);
  if (new Set(ids).size !== ids.length) fail(`${location}.domains`, "duplicate domain");
  const targets = [...new Set(merged.targets.map((target, index) => parseTarget(target, `${location}.targets[${index}]`)))];
  const triggers = merged.triggers.map((trigger, index) => parseTrigger(trigger, `${location}.triggers[${index}]`));
  const onlyCoordinator = triggers.findIndex(trigger => trigger.on === "coordinator_decision" || trigger.on === "before_complete");
  if (onlyCoordinator >= 0 && targets.some(target => target !== "coordinator"))
    fail(`${location}.targets`, `trigger ${triggers[onlyCoordinator]!.on} observes the coordinator, so advice can only go to target "coordinator"`);
  const config: AdvisorConfig = { name, domains, targets, triggers };
  if (merged.enabled !== undefined) config.enabled = merged.enabled as boolean;
  if (merged.route !== undefined) config.route = nonEmptyString(merged.route, `${location}.route`);
  if (merged.cooldownMs !== undefined) config.cooldownMs = boundedInteger(merged.cooldownMs, `${location}.cooldownMs`, 0);
  if (merged.maxCallsPerRun !== undefined) config.maxCallsPerRun = boundedInteger(merged.maxCallsPerRun, `${location}.maxCallsPerRun`, 1);
  if (merged.maxCallsPerTarget !== undefined) config.maxCallsPerTarget = boundedInteger(merged.maxCallsPerTarget, `${location}.maxCallsPerTarget`, 1);
  if (merged.timeoutMs !== undefined) config.timeoutMs = boundedInteger(merged.timeoutMs, `${location}.timeoutMs`, 1000);
  return config;
}

export function parseAdvisorConfigs(value: unknown, location = "config.advisors"): AdvisorConfig[] {
  if (!Array.isArray(value)) fail(location, "expected array");
  if (value.length > MAX_ADVISORS) fail(location, `at most ${MAX_ADVISORS} advisors`);
  const configs = value.map((entry, index) => parseEntry(entry, `${location}[${index}]`));
  const names = new Set<string>();
  for (const [index, config] of configs.entries()) {
    if (names.has(config.name)) fail(`${location}[${index}].name`, `duplicate advisor name ${JSON.stringify(config.name)}`);
    names.add(config.name);
  }
  return configs;
}

export function resolveAdvisor(config: AdvisorConfig): ResolvedAdvisor {
  return {
    name: config.name,
    route: config.route ?? advisorDefaults.route,
    domains: config.domains.map(domain => typeof domain === "string" ? { id: domain, instructions: domainInstructions[domain] } : domain),
    targets: config.targets,
    triggers: config.triggers,
    cooldownMs: config.cooldownMs ?? advisorDefaults.cooldownMs,
    maxCallsPerRun: config.maxCallsPerRun ?? advisorDefaults.maxCallsPerRun,
    maxCallsPerTarget: config.maxCallsPerTarget ?? advisorDefaults.maxCallsPerTarget,
    timeoutMs: config.timeoutMs ?? advisorDefaults.timeoutMs,
  };
}
