/**
 * `mdsd` in orche.config.json: the bounds of the MDSD search policy (src/orchestrator/mdsd.ts, docs/mdsd.md). Every key is
 * optional; a file without `mdsd` gets DEFAULT_MDSD. Validated like the other extension-only settings (config.ts).
 *
 * The defaults are practical limits for one orchestrator assignment, not tuned or validated values: up to 3 search rounds, a
 * per-strategy budget a strategy may lower (or raise up to `explorerMax`), and a total budget of the whole MDSD assignment — the
 * orchestrator's own responses (planning, integration, synthesis), every explorer, verifier and other sub-worker.
 *
 * Admission (src/orchestrator/mdsd.ts admit): every orche_spawn call is admitted only if what all stages spent, plus the worst case
 * of the sub-workers still running, plus the worst case of the new ones fits: search rounds within (1 - reserve) of `total`, every
 * other stage within (1 - final); the last `final` share is the orchestrator's final-report allowance. A sub-worker's worst case is
 * its allocation x `hardStopAt` (requests: rounded up, plus REPORT_EXEMPTIONS report responses).
 * Sub-workers are enforced per session: a wrap-up notice at `wrapUpAt` of any allocated dimension and an explicit stop at
 * `hardStopAt` (checked after each response, plus a timer for time that also cancels a response in flight).
 * The orchestrator: at (1 - final) of `total` it is told that no further stage is admitted and to report; at `total` its turn is
 * stopped and it gets one forced report prompt (the request budget's ladder, src/agent/agent-manager.ts budgetAction), which has
 * BUDGET_GRACE_REQUESTS more responses before the assignment fails with its partial MDSD record.
 * Not bounded in advance, measured and recorded: the response that crosses a line (cost and tokens are known only after it), the
 * report responses let through after a stop, and responses cancelled in flight (their usage is unknown; marked, never zero).
 */
import { parseSettings, RouteConfigError, type RouteSettings } from "../orchestration/routing.js";

export interface MdsdBudget {
  /** Model responses (requests) of one explorer session. */
  requests: number;
  /** Wall-clock minutes of one explorer session. */
  minutes: number;
  /** List-price cost estimate in USD (the provider catalog's prices, as Pi's usage reports it); not a bill. */
  costUSD: number;
  /** Generated tokens (output, including reasoning tokens as the provider counts them). */
  outputTokens: number;
}
/**
 * Explicit cross-model replication of search strategies: an experiment setting of one run (absent by default; docs/mdsd.md
 * "Replication"). Every search strategy runs once per model of `models`, with the same brief, request and allocation: the replicates
 * of one strategy are the SAME search path on different models, so the label-only check still applies to the strategies themselves
 * and replicates never count as distinct paths. `round` pins the first search round to a recorded call (plan and workers): the
 * runtime runs that call's plan, requests and strategies, whatever text the orchestrator's first search call carries (it names the
 * pinned workers). Checked here for structure; plan and strategy schemas when the run starts (src/orchestrator/mdsd.ts).
 */
export interface MdsdReplication {
  models: RouteSettings[];
  round?: { plan: unknown; workers: { name: string; role: string; request: string; strategy: unknown }[] };
}
export interface MdsdSettings {
  /** Search rounds (orche_spawn reason "search") per assignment: the first one plus adaptive rounds. */
  maxRounds: number;
  /** Default allocation of a strategy that sets no budget of its own. */
  explorer: MdsdBudget;
  /** The most one strategy may be allocated (a strategy's own budget is clamped to it). */
  explorerMax: MdsdBudget;
  /** Budget of the whole MDSD run (orchestrator, explorers, verifiers); search rounds may allocate only up to (1 - reserve) of it. */
  total: { costUSD: number; requests: number };
  /** Fraction of `total` kept for integration, verification and the final synthesis (search rounds cannot allocate it). */
  reserve: number;
  /** Fraction of `total` kept for the orchestrator's final report: no stage is admitted into it; reaching it, the orchestrator is told to report. */
  final: number;
  /** Fraction of a strategy's budget at which the explorer is told once to wrap up and report. */
  wrapUpAt: number;
  /** Multiple of a strategy's budget at which its session is stopped (checked between responses; see the module comment). */
  hardStopAt: number;
  /**
   * Every search worker gets a private scratch directory (`<scratch base>/<session>/<its id>`, the same kind of write root every
   * orche worker has: its file tools may write there, read-only or not) and the usual scratch sentence in its prompt. Absent or
   * false: explorers have no write root (the default).
   */
  explorerScratch?: boolean;
  /** Cross-model replication of the search strategies (an experiment setting; see {@link MdsdReplication}). */
  replication?: MdsdReplication;
  /** Registered claims of earlier, frozen analyses the run must account for (an experiment setting; see {@link MdsdSeed}). */
  seed?: MdsdSeed;
}

/** One registered prior claim: a namespaced ref (`P1:c3`, never resolvable against this run's own `W1.2:f1` refs) and its content. */
export interface MdsdSeedClaim { ref: string; claim: string; quote?: string; locations?: string[]; requirements?: string[]; stance?: "asserted" | "uncertain" | "rejected" }
/**
 * `mdsd.seed` (experiment setting, absent by default): the claims of earlier analyses, frozen before this run, enter it as round-0
 * findings under their refs. The report gate then requires every one of them to be accounted for like an explorer finding (kept in
 * a final finding's provenance, whose confirmed/refuted status needs the orchestrator's own evidence, or dropped with a reason), and
 * the first search round is a follow-up on them (adaptive rules: adapt.basis cites the claims and gaps it follows up). Accounting is
 * not preservation: whether a dropped or corrected claim was right is for an evaluation to judge.
 */
export interface MdsdSeed { claims: MdsdSeedClaim[] }

export const DEFAULT_MDSD: Readonly<MdsdSettings> = {
  maxRounds: 3,
  explorer: { requests: 40, minutes: 25, costUSD: 6, outputTokens: 120_000 },
  explorerMax: { requests: 120, minutes: 60, costUSD: 25, outputTokens: 400_000 },
  total: { costUSD: 80, requests: 600 },
  reserve: 0.3,
  final: 0.1,
  wrapUpAt: 0.8,
  hardStopAt: 1.25,
};

const BUDGET_KEYS = ["requests", "minutes", "costUSD", "outputTokens"] as const;
const KEYS = new Set(["maxRounds", "explorer", "explorerMax", "total", "reserve", "final", "wrapUpAt", "hardStopAt", "explorerScratch", "replication", "seed"]);
const SEED_REF = /^P\d{1,2}:c\d{1,4}$/;
const MAX_SEED_CLAIMS = 400;
/** Models one strategy may be replicated on (each replicate is a full explorer session). */
const MAX_REPLICATION_MODELS = 4;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** `mdsd.replication`: 2-4 distinct model routes and an optional pinned round (structure only; schemas in MdsdRun). */
function replicationOf(value: unknown): MdsdReplication {
  if (!isRecord(value)) throw new RouteConfigError("config.mdsd.replication: expected object { models, round? }");
  const extra = Object.keys(value).filter(key => key !== "models" && key !== "round");
  if (extra.length) throw new RouteConfigError(`config.mdsd.replication: unknown field ${extra.join(", ")} (expected models, round)`);
  const list = value.models;
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_REPLICATION_MODELS) throw new RouteConfigError(`config.mdsd.replication.models: expected 2-${MAX_REPLICATION_MODELS} model routes { model: "provider/id", thinking? }`);
  const models = list.map((item, index) => parseSettings(item, `config.mdsd.replication.models[${index}]`));
  if (new Set(models.map(item => item.model)).size !== models.length) throw new RouteConfigError("config.mdsd.replication.models: every model once (a second session on the same model is a repetition, not a cross-model replicate)");
  if (value.round === undefined) return { models };
  const round = value.round;
  if (!isRecord(round) || !isRecord(round.plan) || !Array.isArray(round.workers) || Object.keys(round).some(key => key !== "plan" && key !== "workers"))
    throw new RouteConfigError("config.mdsd.replication.round: expected { plan, workers } (the recorded first search call)");
  const workers = round.workers.map((worker, index) => {
    const where = `config.mdsd.replication.round.workers[${index}]`;
    if (!isRecord(worker) || Object.keys(worker).some(key => !["name", "role", "request", "strategy"].includes(key))) throw new RouteConfigError(`${where}: expected { name, role, request, strategy }`);
    if (typeof worker.name !== "string" || !worker.name.trim() || typeof worker.request !== "string" || !worker.request.trim() || !isRecord(worker.strategy)) throw new RouteConfigError(`${where}: expected a name, a request and a strategy`);
    if (worker.role !== "answer") throw new RouteConfigError(`${where}.role: search explorers are role answer`);
    return { name: worker.name, role: worker.role, request: worker.request, strategy: worker.strategy };
  });
  return { models, round: { plan: round.plan, workers } };
}

/** `mdsd.seed`: 1-400 registered claims with unique namespaced refs (content checks only; the run registers them). */
function seedOf(value: unknown): MdsdSeed {
  if (!isRecord(value) || Object.keys(value).some(key => key !== "claims") || !Array.isArray(value.claims) || !value.claims.length || value.claims.length > MAX_SEED_CLAIMS)
    throw new RouteConfigError(`config.mdsd.seed: expected { claims: [1-${MAX_SEED_CLAIMS} registered prior claims] }`);
  const refs = new Set<string>();
  const claims = value.claims.map((item, index): MdsdSeedClaim => {
    const where = `config.mdsd.seed.claims[${index}]`;
    if (!isRecord(item) || Object.keys(item).some(key => !["ref", "claim", "quote", "locations", "requirements", "stance"].includes(key))) throw new RouteConfigError(`${where}: expected { ref, claim, quote?, locations?, requirements?, stance? }`);
    if (typeof item.ref !== "string" || !SEED_REF.test(item.ref)) throw new RouteConfigError(`${where}.ref: expected "P<n>:c<n>" (a source label and the claim's id, so a prior analysis's ids never resolve against this run's)`);
    if (refs.has(item.ref)) throw new RouteConfigError(`${where}.ref: ${item.ref} is registered twice`);
    refs.add(item.ref);
    if (typeof item.claim !== "string" || !item.claim.trim() || item.claim.length > 4000) throw new RouteConfigError(`${where}.claim: expected text of at most 4000 characters`);
    if (item.quote !== undefined && (typeof item.quote !== "string" || item.quote.length > 4000)) throw new RouteConfigError(`${where}.quote: expected text of at most 4000 characters`);
    for (const key of ["locations", "requirements"] as const) {
      const list = item[key];
      if (list !== undefined && (!Array.isArray(list) || list.length > 40 || list.some(entry => typeof entry !== "string"))) throw new RouteConfigError(`${where}.${key}: expected at most 40 strings`);
    }
    if (item.stance !== undefined && item.stance !== "asserted" && item.stance !== "uncertain" && item.stance !== "rejected") throw new RouteConfigError(`${where}.stance: expected "asserted", "uncertain" or "rejected"`);
    return { ref: item.ref, claim: item.claim, ...(item.quote !== undefined ? { quote: item.quote as string } : {}), ...(item.locations !== undefined ? { locations: item.locations as string[] } : {}), ...(item.requirements !== undefined ? { requirements: item.requirements as string[] } : {}), ...(item.stance !== undefined ? { stance: item.stance as MdsdSeedClaim["stance"] } : {}) };
  });
  return { claims };
}

function positive(value: unknown, path: string, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) throw new RouteConfigError(`config.mdsd.${path}: expected a positive ${integer ? "integer" : "number"}; got ${JSON.stringify(value)}`);
  return value;
}

function budget(value: unknown, path: string, base: MdsdBudget): MdsdBudget {
  if (value === undefined) return { ...base };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError(`config.mdsd.${path}: expected object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(key => !(BUDGET_KEYS as readonly string[]).includes(key));
  if (unknown.length) throw new RouteConfigError(`config.mdsd.${path}: unknown field ${unknown.join(", ")} (expected ${BUDGET_KEYS.join(", ")})`);
  const out = { ...base };
  for (const key of BUDGET_KEYS) if (record[key] !== undefined) out[key] = positive(record[key], `${path}.${key}`, key === "requests" || key === "outputTokens");
  return out;
}

/** Parse `mdsd`; unknown keys and invalid values are config errors (like `single`). */
export function parseMdsdConfig(value: unknown): MdsdSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteConfigError("config.mdsd: expected object");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(key => !KEYS.has(key));
  if (unknown.length) throw new RouteConfigError(`config.mdsd: unknown field ${unknown.join(", ")}`);
  const maxRounds = record.maxRounds === undefined ? DEFAULT_MDSD.maxRounds : positive(record.maxRounds, "maxRounds", true);
  if (maxRounds > 6) throw new RouteConfigError("config.mdsd.maxRounds: at most 6 search rounds per assignment");
  const explorerMax = budget(record.explorerMax, "explorerMax", DEFAULT_MDSD.explorerMax);
  const explorer = budget(record.explorer, "explorer", DEFAULT_MDSD.explorer);
  for (const key of BUDGET_KEYS) if (explorer[key] > explorerMax[key]) throw new RouteConfigError(`config.mdsd.explorer.${key} (${explorer[key]}) exceeds config.mdsd.explorerMax.${key} (${explorerMax[key]})`);
  let total = { ...DEFAULT_MDSD.total };
  if (record.total !== undefined) {
    if (!record.total || typeof record.total !== "object" || Array.isArray(record.total)) throw new RouteConfigError("config.mdsd.total: expected object");
    const t = record.total as Record<string, unknown>;
    const extra = Object.keys(t).filter(key => key !== "costUSD" && key !== "requests");
    if (extra.length) throw new RouteConfigError(`config.mdsd.total: unknown field ${extra.join(", ")} (expected costUSD, requests)`);
    total = { costUSD: t.costUSD === undefined ? total.costUSD : positive(t.costUSD, "total.costUSD", false), requests: t.requests === undefined ? total.requests : positive(t.requests, "total.requests", true) };
  }
  const reserve = record.reserve === undefined ? DEFAULT_MDSD.reserve : record.reserve;
  if (typeof reserve !== "number" || !Number.isFinite(reserve) || reserve < 0 || reserve >= 1) throw new RouteConfigError(`config.mdsd.reserve: expected a fraction from 0 to below 1 of mdsd.total kept for the stages after the search; got ${JSON.stringify(reserve)}`);
  const wrapUpAt = record.wrapUpAt === undefined ? DEFAULT_MDSD.wrapUpAt : positive(record.wrapUpAt, "wrapUpAt", false);
  const hardStopAt = record.hardStopAt === undefined ? DEFAULT_MDSD.hardStopAt : positive(record.hardStopAt, "hardStopAt", false);
  if (wrapUpAt >= 1) throw new RouteConfigError("config.mdsd.wrapUpAt: expected a fraction below 1 (the wrap-up notice comes before the budget is used up)");
  if (hardStopAt < 1 || hardStopAt > 3) throw new RouteConfigError("config.mdsd.hardStopAt: expected a multiple from 1 to 3 of a strategy's budget");
  const final = record.final === undefined ? Math.min(DEFAULT_MDSD.final, reserve) : record.final;
  if (typeof final !== "number" || !Number.isFinite(final) || final < 0 || final > reserve) throw new RouteConfigError(`config.mdsd.final: expected a fraction from 0 to mdsd.reserve (${reserve}) of mdsd.total kept for the final report; got ${JSON.stringify(final)}`);
  if (record.explorerScratch !== undefined && typeof record.explorerScratch !== "boolean") throw new RouteConfigError("config.mdsd.explorerScratch: expected boolean");
  const replication = record.replication === undefined ? undefined : replicationOf(record.replication);
  const seed = record.seed === undefined ? undefined : seedOf(record.seed);
  return { maxRounds, explorer, explorerMax, total, reserve, final, wrapUpAt, hardStopAt, ...(record.explorerScratch !== undefined ? { explorerScratch: record.explorerScratch } : {}), ...(replication ? { replication } : {}), ...(seed ? { seed } : {}) };
}
