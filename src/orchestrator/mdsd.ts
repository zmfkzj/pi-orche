/**
 * MDSD — Multi-Dimensional Search Diversification (docs/mdsd.md): an opt-in search policy for intellectual exploration (cause
 * analysis, solution search, technology choice, design, research, idea generation), run by an orche orchestrator in mode `mdsd`
 * (`/orche mdsd <PROMPT>`, `/orche mode mdsd`, `mainMode: "mdsd"`) on the strong model tiers. Default, single and strong are untouched.
 *
 * The idea (the user's specification): diversify the SEARCH PATHS, not the outputs. Under one common objective and the mandatory
 * constraints, strategies differ in ① problem interpretation, ② hypothesis space, ③ information space, ④ reasoning method,
 * ⑤ search direction and ⑥ validation criteria, using six combinable operators (EXPAND, DECOMPOSE, INVERT, TRANSFER, CHALLENGE,
 * VALIDATE). The flow is independent exploration → evidence integration (dedup, conflicts, gaps) → adaptive strategy/target selection
 * when it pays → verification and final judgment. A simple task stays a single path (no search round).
 *
 * What the runtime enforces (this module, spawn.ts, sub-worker.ts, specialists/session.ts):
 *  - the strategy spec of every explorer (TypeBox schema), with the plan's objective and mandatory constraints copied verbatim into
 *    each explorer's brief, and the same plan in every round (a changed objective or constraint list is refused as task drift);
 *  - no label-only diversity: two strategies of a round with the same structural signature (operators, direction, reasoning kinds,
 *    validation kinds) must differ in hypothesis space or evidence scope (token overlap below DIVERSITY_OVERLAP), else refused;
 *  - the first search round has 2+ strategies; adaptive rounds need `adapt.basis` citing ids of the runtime's aggregation, exploit
 *    strategies target such ids, and a round of 2+ strategies keeps at least one `explore` strategy with new hypotheses or sources;
 *  - search workers are read-only (role answer) and report the output contract (findings with evidence, counter-evidence and
 *    uncertainty; evidence; counter_evidence; uncertainty; explored_scope; unexplored_scope; sources_used; procedures);
 *  - budgets: a strategy's allocation is clamped to `mdsd.explorerMax`, a round must fit the remaining `mdsd.total`, rounds are capped
 *    (`mdsd.maxRounds`); each explorer session gets a wrap-up notice at `wrapUpAt` of its allocation and is stopped at `hardStopAt`;
 *  - measurement independent of self-reports: what each explorer actually read, searched and ran (its tool calls), pairwise overlap
 *    of the files it read (redundancy), files new to the run (new information), declared-vs-actual evidence scope, allocated vs
 *    actual requests/cost/time/output tokens per explorer, the orchestrator's own usage per phase window;
 *  - the report gate (`data.mdsd`): every explorer finding accounted for (kept in a final finding's provenance or dropped with a
 *    reason), confirmed/refuted findings backed by the orchestrator's own tool calls ([orche ref Tn]) or a verifier, never by
 *    agreement alone, disputed findings with their dissent, explored and unexplored scope, and the stop reason.
 * Experiment settings of one run, absent by default (docs/mdsd.md "Replication"): `mdsd.replication` runs every strategy once per
 * listed model (the replicates of a strategy are one search path on different models: the label-only check applies to the strategies
 * before they are replicated, and the summary counts strategies and explorer cells apart) and may pin the first search round to a
 * recorded call; `mdsd.explorerScratch` gives every explorer a private scratch directory (the write root every orche worker has).
 * Prompt-based (the model's judgment): whether diversification pays, which operators and dimensions fit, the semantic quality of
 * strategies and integration, the merge of duplicates, conflict resolution. The duplicate/conflict/gap lists are lexical heuristics
 * (shared file and nearby lines, token overlap) offered as candidates, not verdicts. Utility − λ·Redundancy − μ·Cost is the design
 * objective the instructions state; the runtime measures redundancy and cost but computes no utility and no weighted score.
 */
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RouteSettings } from "../orchestration/routing.js";
import { ensureScratchDir } from "../orchestration/scratch.js";
import { formatSchemaErrors } from "../orchestration/schema-errors.js";
import { BOOKKEEPING_TOOLS, type EvidenceLedger } from "../pi/tool-evidence.js";
import { MAX_SUB_WORKERS, MAX_VERIFICATION_ROUNDS } from "./instructions.js";
import { DEFAULT_MDSD, type MdsdBudget, type MdsdSeed, type MdsdSettings } from "./mdsd-config.js";
import type { PlannedWorker, SpawnCall, SpawnReason, SpawnStageHooks, SubWorkerOutcome } from "./spawn.js";
import { REPORT_EXEMPTIONS } from "../specialists/session.js";

export const MDSD_OPERATORS = ["EXPAND", "DECOMPOSE", "INVERT", "TRANSFER", "CHALLENGE", "VALIDATE"] as const;
export const MDSD_REASONING = ["deduction", "induction", "abduction", "backtracking", "comparison", "experiment"] as const;
export const MDSD_DIRECTIONS = ["bottom-up", "top-down", "backward", "cross-cutting"] as const;
export const MDSD_VALIDATION = ["falsification", "reproduction", "comparison", "constraint-check"] as const;
export const MDSD_PURPOSES = ["explore", "exploit"] as const;
export const MDSD_STATUSES = ["confirmed", "refuted", "unverified", "disputed"] as const;
export const MDSD_STOPS = ["sufficient", "budget", "round-cap", "no-progress", "blocked"] as const;
export type MdsdOperator = (typeof MDSD_OPERATORS)[number];
/** Two strategies with the same signature whose hypothesis spaces AND evidence scopes overlap at least this much are one path. */
export const DIVERSITY_OVERLAP = 0.5;
/** An item of an explore strategy counts as new when its overlap with every earlier strategy item is below this. */
export const NOVELTY_OVERLAP = 0.5;
/** Claim token overlap from which two findings of different explorers are listed as likely duplicates (next to shared locations). */
export const DUPLICATE_OVERLAP = 0.45;

const OPERATOR_QUESTIONS: Record<MdsdOperator, string> = {
  EXPAND: "discover possibilities and alternatives outside the current search range — what has not been considered yet?",
  DECOMPOSE: "split the problem into elements, layers or stages and analyse each — which part contributes to the overall result?",
  INVERT: "trace back from the result to its causes, or from the goal to its preconditions — what must precede this result?",
  TRANSFER: "apply structures, principles or cases from other domains — how was this problem solved elsewhere?",
  CHALLENGE: "attack the current assumptions and the leading explanation, look for counterexamples — what evidence would appear if it were wrong?",
  VALIDATE: "test hypotheses against reality by measurement, execution, experiment or comparison — how can true and false be told apart?",
};

const short = (max: number) => Type.String({ minLength: 1, maxLength: max });
const lit = <T extends string>(values: readonly T[]) => Type.Union(values.map(value => Type.Literal(value)));
const items = (maxItems: number, len: number, minItems = 1) => Type.Array(short(len), { minItems, maxItems });
const budgetSchema = Type.Object({
  requests: Type.Optional(Type.Integer({ minimum: 3, maximum: 1000 })),
  minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
  costUSD: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1000 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 10_000_000 })),
}, { additionalProperties: false });

/** One explorer's strategy (orche_spawn reason "search", per worker). The objective and constraints come from the plan. */
export const strategySchema = Type.Object({
  framing: short(800),
  operators: Type.Array(lit(MDSD_OPERATORS), { minItems: 1, maxItems: 3 }),
  hypothesis_space: items(12, 400),
  evidence_scope: items(12, 400),
  method: items(12, 400),
  reasoning: Type.Array(lit(MDSD_REASONING), { minItems: 1, maxItems: 3 }),
  direction: lit(MDSD_DIRECTIONS),
  validation: Type.Array(lit(MDSD_VALIDATION), { minItems: 1, maxItems: 3 }),
  purpose: Type.Optional(lit(MDSD_PURPOSES)),
  targets: Type.Optional(Type.Array(short(24), { maxItems: 12 })),
  budget: Type.Optional(budgetSchema),
}, { additionalProperties: false });
/** The plan of a search run (the first search call; later calls repeat it unchanged or omit it). */
export const planSchema = Type.Object({
  objective: short(3000),
  constraints: items(24, 800),
  success: items(12, 800),
  rationale: short(3000),
}, { additionalProperties: false });
/** Why an adaptive round runs: the aggregation ids it acts on and the reason. */
export const adaptSchema = Type.Object({ basis: Type.Array(short(24), { minItems: 1, maxItems: 40 }), reason: short(3000) }, { additionalProperties: false });

export interface MdsdStrategy {
  framing: string; operators: MdsdOperator[]; hypothesis_space: string[]; evidence_scope: string[]; method: string[];
  reasoning: string[]; direction: string; validation: string[]; purpose?: "explore" | "exploit"; targets?: string[]; budget?: Partial<MdsdBudget>;
}
export interface MdsdPlan { objective: string; constraints: string[]; success: string[]; rationale: string }
export interface MdsdAdapt { basis: string[]; reason: string }

/** `data` of a search worker's report (the MDSD output contract, next to the answer role's own). */
export const explorerDataSchema = Type.Object({
  findings: Type.Array(Type.Object({
    id: short(24),
    claim: short(3000),
    location: Type.Optional(Type.Array(short(400), { maxItems: 12 })),
    evidence: items(16, 1200),
    counter_evidence: Type.Array(short(1200), { maxItems: 16 }),
    uncertainty: lit(["low", "medium", "high"] as const),
  }), { maxItems: 40 }),
  evidence: Type.Array(short(1200), { maxItems: 40 }),
  counter_evidence: Type.Array(short(1200), { maxItems: 40 }),
  uncertainty: short(3000),
  explored_scope: items(40, 800),
  unexplored_scope: Type.Array(short(800), { maxItems: 40 }),
  sources_used: items(80, 600),
  procedures: items(40, 600),
});
interface ExplorerFinding { id: string; claim: string; location?: string[]; evidence: string[]; counter_evidence: string[]; uncertainty: "low" | "medium" | "high" }
interface ExplorerData { findings: ExplorerFinding[]; evidence: string[]; counter_evidence: string[]; uncertainty: string; explored_scope: string[]; unexplored_scope: string[]; sources_used: string[]; procedures: string[] }

/** `data.mdsd` of the orchestrator's report. */
export const mdsdReportSchema = Type.Object({
  decision: lit(["single-path", "diversified"] as const),
  reason: short(3000),
  objective: short(3000),
  findings: Type.Array(Type.Object({
    id: short(24),
    claim: short(3000),
    status: lit(MDSD_STATUSES),
    provenance: Type.Array(short(48), { maxItems: 30 }),
    evidence: Type.Array(short(1200), { maxItems: 30 }),
    counter_evidence: Type.Array(short(1200), { maxItems: 30 }),
    uncertainty: lit(["low", "medium", "high"] as const),
    dissent: Type.Optional(short(3000)),
  }), { maxItems: 80 }),
  dropped: Type.Optional(Type.Array(Type.Object({ refs: Type.Array(short(48), { minItems: 1, maxItems: 40 }), reason: short(1500) }), { maxItems: 80 })),
  explored_scope: items(40, 800),
  unexplored_scope: Type.Array(short(800), { maxItems: 40 }),
  stop: Type.Object({ reason: lit(MDSD_STOPS), basis: short(3000) }),
  rounds: Type.Optional(Type.Array(Type.Object({ round: Type.Integer({ minimum: 1, maximum: 10 }), decision: short(3000) }), { maxItems: 10 })),
});
interface FinalFinding { id: string; claim: string; status: (typeof MDSD_STATUSES)[number]; provenance: string[]; evidence: string[]; counter_evidence: string[]; uncertainty: string; dissent?: string }
interface MdsdReport { decision: "single-path" | "diversified"; reason: string; objective: string; findings: FinalFinding[]; dropped?: { refs: string[]; reason: string }[]; explored_scope: string[]; unexplored_scope: string[]; stop: { reason: string; basis: string }; rounds?: { round: number; decision: string }[] }
const REPORT_FORMAT = 'mdsd:{decision:"diversified"|"single-path",reason,objective,findings:[{id,claim,status:"confirmed"|"refuted"|"unverified"|"disputed",provenance:["W1.2:f1",…],evidence:["[orche ref T7] …" or a verifier id],counter_evidence:[…],uncertainty:"low"|"medium"|"high",dissent?}],dropped:[{refs:["W1.3:f2"],reason}],explored_scope:[…],unexplored_scope:[…],stop:{reason:"sufficient"|"budget"|"round-cap"|"no-progress"|"blocked",basis},rounds:[{round,decision}]}';

// ---------------------------------------------------------------------------------------------------------------------------
// Text, paths and footprints

const STOP = new Set("the and for with from that this into onto over under than then when what which where while whose about after before between through without within does doing done have has had was were are is be been being not nor but any all each every some such only also very more most less least other others same can could should would will shall may might must its it's their there these those them they our ours your yours his her him she you we who whom how why use used using via per of to in on at by as or an a".split(" "));
/** Lower-case word and path tokens (3+ chars, stop words dropped) of some texts. */
export function tokensOf(...texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) for (const token of text.toLowerCase().split(/[^\p{L}\p{N}_./-]+/u)) {
    const clean = token.replace(/^[./-]+|[./-]+$/g, "");
    if (clean.length >= 3 && !STOP.has(clean)) out.add(clean);
  }
  return out;
}
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const item of a) if (b.has(item)) both++;
  return both / (a.size + b.size - both);
}
const round2 = (value: number) => Math.round(value * 100) / 100;
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`; };

/** `path:line` or `path:start-end` references in some texts (the file part must look like a path with an extension). */
export function locationsOf(texts: readonly string[]): { file: string; start: number; end: number }[] {
  const out: { file: string; start: number; end: number }[] = [];
  const pattern = /([A-Za-z0-9_@~.\-/]+\.[A-Za-z0-9]{1,8}):(\d+)(?:\s*[-–]\s*(\d+))?/g;
  for (const text of texts) for (const match of text.matchAll(pattern)) {
    const start = Number(match[2]); const end = match[3] ? Math.max(start, Number(match[3])) : start;
    out.push({ file: match[1]!.replace(/^\.\//, ""), start, end });
  }
  return out;
}

/** One source an explorer actually used: a file it read, a place it searched, a command it ran, another tool. */
export interface FootprintEntry { kind: "file" | "search" | "dir" | "command" | "url" | "tool"; key: string }
const PATH_TOKEN = /(?:^|[\s'"=(])((?:\.{0,2}\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s'"):;,])/g;
/** The footprint entries of one tool call (paths made relative to `cwd`; outside paths stay absolute). */
export function footprintOf(cwd: string, toolName: string, args: unknown): FootprintEntry[] {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const rel = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) return ".";
    const absolute = resolve(cwd, value.trim());
    const inside = relative(cwd, absolute);
    return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : inside === "" ? "." : absolute;
  };
  switch (toolName) {
    case "read": return [{ kind: "file", key: rel(input.path) }];
    case "grep": return [{ kind: "search", key: `grep ${String(input.pattern ?? "")} @ ${rel(input.path)}` }, { kind: "dir", key: rel(input.path) }];
    case "find": return [{ kind: "search", key: `find ${String(input.pattern ?? "")} @ ${rel(input.path)}` }, { kind: "dir", key: rel(input.path) }];
    case "ls": return [{ kind: "dir", key: rel(input.path) }];
    case "ast_search": return [{ kind: "search", key: `ast ${String(input.pattern ?? "")} @ ${rel(input.path)}` }];
    case "browser_fetch": return [{ kind: "url", key: String(input.url ?? "") }];
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      const files = [...command.matchAll(PATH_TOKEN)].map(match => match[1]!).filter(path => !/^\d+(\.\d+)*$/.test(path)).map(path => ({ kind: "file" as const, key: rel(path) }));
      return [{ kind: "command", key: clip(command, 240) }, ...files];
    }
    default: return BOOKKEEPING_TOOLS.has(toolName) ? [] : [{ kind: "tool", key: toolName }];
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// State

/** One explorer of the run: its strategy, allocation, what it did and what it reported. */
export interface MdsdExplorer {
  id: string; name: string; round: number; strategy: MdsdStrategy; signature: string; allocated: MdsdBudget;
  /** mdsd.replication: the model this explorer cell ran on, and its strategy's group (the id of the strategy's first cell). */
  model?: string; group?: string;
  /** mdsd.explorerScratch: its private scratch directory. */
  scratch?: string;
  status: string; error?: string;
  findings: ExplorerFinding[]; exploredScope: string[]; unexploredScope: string[]; sourcesUsed: string[]; procedures: string[]; uncertainty?: string;
  /** Files it read (read tool, or named in its shell commands), places it searched, commands it ran: from its tool calls. */
  files: string[]; searches: string[]; commands: string[]; toolCalls: number;
  /** Every read call with its range (`path@offset+limit`), in order: what exactly it looked at. */
  reads: string[];
  /** No valid report (failed, cancelled, stopped): its last text, kept so the partial work is not lost (not a finding). */
  partial?: string;
  actual?: { requests: number; costUSD: number; durationMs: number; outputTokens?: number; inputTokens?: number; cacheReadTokens?: number };
  /** Budget dimensions where actual use exceeded the allocation (the overshoot of a response in flight, or a stop). */
  overshoot: string[]; wrapUp?: string; stoppedBy?: string;
  /** It ended by a cancellation with a response in flight or cut short: that response's usage is unknown (not counted as zero). */
  inFlightUnknown?: boolean;
  /** Files no explorer of an earlier round read; files no other explorer of the same round read. */
  newFiles?: number; uniqueFiles?: number;
  /** Declared evidence_scope items its actual footprint touched (lexical/path match). */
  scopeTouched?: number;
}
interface RegisteredFinding { gid: string; ref: string; worker: string; round: number; finding: ExplorerFinding; locations: { file: string; start: number; end: number }[] }
interface Aggregation { duplicates: { id: string; members: string[]; why: string }[]; conflicts: { id: string; members: string[]; why: string }[]; gaps: { id: string; worker: string; text: string; coveredBy: string[] }[]; uncertain: string[] }
export interface MdsdRound { round: number; spawnedAt: number; endedAt?: number; workers: string[]; adapt?: MdsdAdapt; redundancy?: number; pairs?: { a: string; b: string; files: number }[]; models?: string[]; pinned?: boolean }
/** A verifier or other non-search sub-worker of an MDSD run: allocation, then what it used. */
interface StageWorker { id: string; status: string; requests: number; costUSD: number; durationMs: number; outputTokens?: number; allocated?: MdsdBudget; stoppedBy?: string; inFlightUnknown?: boolean }
interface PhaseWindow { phase: string; requests: number; costUSD: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; startedAt: number; lastAt?: number }
export interface MdsdState {
  plan?: MdsdPlan;
  rounds: MdsdRound[];
  explorers: MdsdExplorer[];
  findings: RegisteredFinding[];
  aggregation: Aggregation;
  verifications: { round: number; workers: StageWorker[] }[];
  /** Sub-workers of the other spawn reasons (parallelism, isolation): admitted, budgeted and charged like verifiers. */
  others: { reason: string; workers: StageWorker[] }[];
  /** The orchestrator's budget steps (mdsd.total): the notice (no further stage admitted) and the stop (forced report). */
  orchestrator: { noticed?: string; stopped?: string };
  /** Orchestrator responses without a reported cost: their spend is unknown (not counted as zero; see summary().budget). */
  unpriced: number;
  /** Allocated budget of all strategies so far (every round). */
  allocated: { costUSD: number; requests: number };
  /** A search call refused because the total budget or the round cap was used up. */
  exhausted?: string;
  phases: PhaseWindow[];
}

export interface MdsdSummary {
  /** `strategies`: distinct strategy specs (a replicated strategy counts once); the explorer cells are `explorers`. */
  decision?: string; rounds: number; maxRounds: number; strategies: number; distinctSignatures: number;
  explorers: { id: string; round: number; signature: string; status: string; findings: number; files: number; newFiles?: number; uniqueFiles?: number; scopeTouched?: string; allocated: MdsdBudget; actual?: MdsdExplorer["actual"]; overshoot?: string[]; wrapUp?: string; stoppedBy?: string; model?: string; group?: string }[];
  /** mdsd.replication: the models every strategy ran on, the explorer cells, and whether the first round was the pinned one. */
  replication?: { models: string[]; cells: number; pinned: boolean };
  redundancy: (number | null)[];
  findings: { explorers: number; final?: number; byStatus?: Record<string, number>; dropped?: number; firstRoundOnly?: number; adaptiveOnly?: number; both?: number; orchestratorOnly?: number; seeded?: number; seededKept?: number };
  budget: {
    allocatedUSD: number; spentExplorersUSD: number; spentVerifiersUSD: number; spentOtherUSD: number; spentOrchestratorUSD: number; spentUSD: number; totalUSD: number;
    /** Admission limits: search rounds up to searchLimit, other stages up to stageLimit; total - stageLimit is the final-report allowance. */
    searchLimitUSD: number; stageLimitUSD: number; finalAllowanceUSD: number;
    allocatedRequests: number; spentRequests: number; totalRequests: number;
    /** Responses whose usage is unknown: cut in flight by a cancellation (sub-workers), or reported without cost (orchestrator). */
    inFlightUnknown: number; unpricedResponses: number;
    noticed?: string; stopped?: string; overTotal?: string; exhausted?: string;
  };
  phases: PhaseWindow[];
  verificationRounds: number;
  gate?: string;
}

export interface MdsdRunOptions {
  orchestrator: string;
  cwd: string;
  readOnly: boolean;
  settings?: MdsdSettings;
  /** The orchestrator session's tool-call ledger: cited [orche ref Tn] are checked against it. */
  ledger(): EvidenceLedger;
  maxSubWorkers?: number;
  onEvent?(event: Record<string, unknown>): void;
  /** Where the complete data of each search round is written (the orchestrator's scratch directory); absent: kept inline. */
  scratch?: string;
  now?(): number;
}

const dataOf = (data: unknown): Record<string, unknown> => data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export const signatureOf = (strategy: Pick<MdsdStrategy, "operators" | "direction" | "reasoning" | "validation">): string =>
  `${[...new Set(strategy.operators)].sort().join("+")}|${strategy.direction}|${[...new Set(strategy.reasoning)].sort().join("+")}|${[...new Set(strategy.validation)].sort().join("+")}`;

/** The search run of one MDSD orchestrator assignment: spawn hooks, measurement, aggregation, report gate. */
export class MdsdRun implements SpawnStageHooks {
  readonly state: MdsdState;
  readonly settings: MdsdSettings;
  private gateResult?: string;
  private decision?: string;
  private final?: { findings: FinalFinding[]; dropped: number };
  /** Explorer findings a report after the budget stop left unaccounted (allowed then, and recorded). */
  private unaccounted = 0;
  /** Tool calls of each explorer session, by worker id, as they run. */
  private readonly live = new Map<string, { files: Set<string>; searches: Set<string>; commands: Set<string>; reads: string[]; toolCalls: number; lastText?: string }>();
  private readonly startedAt: number;
  /** The next search round is the pinned one (set by resolve, used by prepare). */
  private pinnedNext = false;

  constructor(readonly options: MdsdRunOptions) {
    this.settings = options.settings ?? DEFAULT_MDSD;
    const now = this.now();
    this.startedAt = now;
    this.state = { rounds: [], explorers: [], findings: [], aggregation: { duplicates: [], conflicts: [], gaps: [], uncertain: [] }, verifications: [], others: [], orchestrator: {}, unpriced: 0, allocated: { costUSD: 0, requests: 0 }, phases: [{ phase: "planning", requests: 0, costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, startedAt: now }] };
    const pin = this.settings.replication?.round;
    if (pin) this.checkPin(pin);
    if (this.settings.seed) this.registerSeeds(this.settings.seed);
  }

  /**
   * A pinned round (mdsd.replication.round) must be a valid first round by the same rules as any other: plan and strategy schemas,
   * 2+ strategies with unique names, no label-only diversity, and its explorer cells within the session's cap. Throws at the start.
   */
  private checkPin(pin: NonNullable<NonNullable<MdsdSettings["replication"]>["round"]>): void {
    if (!Value.Check(planSchema, pin.plan)) throw new Error(`mdsd.replication.round: invalid plan: ${formatSchemaErrors(planSchema as TSchema, pin.plan, 4)}`);
    if (pin.workers.length < 2) throw new Error("mdsd.replication.round: a first search round has two or more strategies");
    const names = pin.workers.map(worker => worker.name);
    if (new Set(names).size !== names.length) throw new Error("mdsd.replication.round: worker names must be unique");
    for (const worker of pin.workers) if (!Value.Check(strategySchema, worker.strategy)) throw new Error(`mdsd.replication.round: ${worker.name}: invalid strategy: ${formatSchemaErrors(strategySchema as TSchema, worker.strategy, 6)}`);
    this.checkDiversity(names, pin.workers.map(worker => worker.strategy as MdsdStrategy));
    const cells = pin.workers.length * (this.settings.replication?.models.length ?? 1), cap = this.options.maxSubWorkers ?? MAX_SUB_WORKERS;
    if (cells > cap) throw new Error(`mdsd.replication.round: ${pin.workers.length} strategies on ${this.settings.replication!.models.length} models are ${cells} explorers, above the cap of ${cap} sub-workers per call (single.maxSubWorkers)`);
  }

  /**
   * mdsd.seed: the registered claims of earlier, frozen analyses become round-0 findings under their namespaced refs (P1:c3) and enter
   * the aggregation, so the report gate makes the orchestrator account for every one of them like an explorer finding, and the first
   * search round is a follow-up on them (adaptive rules). A registered claim is a claim, not evidence (uncertainty medium, or high
   * when its source left it uncertain or rejected it).
   */
  private registerSeeds(seed: MdsdSeed): void {
    for (const claim of seed.claims) {
      const [source, id] = claim.ref.split(":") as [string, string];
      const finding = { id, claim: claim.claim, location: claim.locations ?? [], evidence: [claim.quote ? `registered prior claim (unverified), its source says: ${claim.quote}` : "registered prior claim (unverified)"], counter_evidence: [], uncertainty: claim.stance === "uncertain" || claim.stance === "rejected" ? "high" : "medium" } as unknown as ExplorerFinding;
      this.state.findings.push({ gid: `F${this.state.findings.length + 1}`, ref: claim.ref, worker: source, round: 0, finding, locations: locationsOf([...(claim.locations ?? []), claim.claim]) });
    }
    this.state.aggregation = aggregate(this.state);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private event(fields: Record<string, unknown>): void { try { this.options.onEvent?.({ type: "mdsd", timestamp: this.now(), worker: this.options.orchestrator, ...fields }); } catch { /* records are best effort */ } }
  private openPhase(phase: string): void { this.state.phases.push({ phase, requests: 0, costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, startedAt: this.now() }); }

  // ---- measurement ----
  /** One response of the orchestrator's own session (its usage), attributed to the phase window open now. */
  observeOrchestrator(usage: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } | undefined): void {
    const window = this.state.phases.at(-1)!;
    window.requests++;
    if (typeof usage?.cost?.total !== "number") this.state.unpriced++;
    window.costUSD += usage?.cost?.total ?? 0;
    window.inputTokens += usage?.input ?? 0;
    window.outputTokens += usage?.output ?? 0;
    window.cacheReadTokens += usage?.cacheRead ?? 0;
    window.lastAt = this.now();
  }

  /** Every session event of a sub-worker (workers.ts onSessionEvent): the tool calls of explorers make their footprint. */
  observe(workerId: string, event: { type: string; [key: string]: unknown }): void {
    const trace = this.live.get(workerId);
    if (!trace) return;
    if (event.type === "message_end") {
      const message = event.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        const text = message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("").trim();
        if (text) trace.lastText = text.slice(-4000);
      }
      return;
    }
    if (event.type !== "tool_execution_start") return;
    trace.toolCalls++;
    const name = String(event.toolName ?? "");
    const entries = footprintOf(this.options.cwd, name, event.args);
    if (name === "read") {
      const args = event.args as { offset?: unknown; limit?: unknown } | undefined;
      trace.reads.push(`${entries[0]?.key ?? "?"}${typeof args?.offset === "number" ? `@${args.offset}` : ""}${typeof args?.limit === "number" ? `+${args.limit}` : ""}`);
    }
    for (const entry of entries) {
      if (entry.kind === "file") trace.files.add(entry.key);
      else if (entry.kind === "search" || entry.kind === "dir" || entry.kind === "url") trace.searches.add(`${entry.kind}:${entry.key}`);
      else if (entry.kind === "command") trace.commands.add(entry.key);
      else trace.searches.add(`tool:${entry.key}`);
    }
  }

  /** What every stage spent so far: the orchestrator's own responses, finished explorers, finished verifiers. */
  spent(): { costUSD: number; requests: number; orchestratorUSD: number; explorersUSD: number; verifiersUSD: number; otherUSD: number } {
    const state = this.state;
    const orchestratorUSD = state.phases.reduce((sum, item) => sum + item.costUSD, 0);
    const orchestratorRequests = state.phases.reduce((sum, item) => sum + item.requests, 0);
    const explorersUSD = state.explorers.reduce((sum, item) => sum + (item.actual?.costUSD ?? 0), 0);
    const explorerRequests = state.explorers.reduce((sum, item) => sum + (item.actual?.requests ?? 0), 0);
    const verifiersUSD = state.verifications.reduce((sum, round) => sum + round.workers.reduce((total, worker) => total + worker.costUSD, 0), 0);
    const verifierRequests = state.verifications.reduce((sum, round) => sum + round.workers.reduce((total, worker) => total + worker.requests, 0), 0);
    const otherUSD = state.others.reduce((sum, stage) => sum + stage.workers.reduce((total, worker) => total + worker.costUSD, 0), 0);
    const otherRequests = state.others.reduce((sum, stage) => sum + stage.workers.reduce((total, worker) => total + worker.requests, 0), 0);
    return { costUSD: orchestratorUSD + explorersUSD + verifiersUSD + otherUSD, requests: orchestratorRequests + explorerRequests + verifierRequests + otherRequests, orchestratorUSD, explorersUSD, verifiersUSD, otherUSD };
  }

  // ---- all-stage budget ----
  /** A sub-worker's worst case: its allocation x hardStopAt (requests rounded up, plus the report responses a stop lets through). */
  worstCase(allocation: MdsdBudget): { costUSD: number; requests: number } {
    return { costUSD: allocation.costUSD * this.settings.hardStopAt, requests: Math.ceil(allocation.requests * this.settings.hardStopAt) + REPORT_EXEMPTIONS };
  }
  /** The worst case of the sub-workers still running (reserved at prepare, released when they finish). */
  committed(): { costUSD: number; requests: number } {
    const running = [
      ...this.state.explorers.filter(item => item.status === "running").map(item => item.allocated),
      ...[...this.state.verifications, ...this.state.others].flatMap(stage => stage.workers).filter(item => item.status === "running" && item.allocated).map(item => item.allocated!),
    ].map(item => this.worstCase(item));
    return { costUSD: running.reduce((sum, item) => sum + item.costUSD, 0), requests: running.reduce((sum, item) => sum + item.requests, 0) };
  }
  /**
   * Admission of an orche_spawn call: spent by every stage + running worst cases + the new workers' worst cases must fit the
   * stage's share of mdsd.total (search: 1 - reserve; every other reason: 1 - final). Throws with the figures and the way out.
   */
  private admit(reason: SpawnReason, allocations: readonly MdsdBudget[]): void {
    const { total, reserve, final, hardStopAt } = this.settings;
    const search = reason === "search";
    const spent = this.spent();
    const running = this.committed();
    const share = search ? 1 - reserve : 1 - final;
    const limitUSD = total.costUSD * share, limitRequests = Math.floor(total.requests * share);
    const worst = allocations.map(item => this.worstCase(item));
    const cost = worst.reduce((sum, item) => sum + item.costUSD, 0), requests = worst.reduce((sum, item) => sum + item.requests, 0);
    const leftCost = limitUSD - spent.costUSD - running.costUSD, leftRequests = limitRequests - spent.requests - running.requests;
    const noticed = this.state.orchestrator.noticed;
    if (!noticed && cost <= leftCost + 1e-9 && requests <= leftRequests) return;
    const smallest = worst.length ? Math.min(...worst.map(item => item.costUSD)) : 0;
    if (noticed) this.state.exhausted ??= `final-report allowance reached (${noticed})`;
    else if (leftCost < smallest || leftRequests < Math.min(...worst.map(item => item.requests))) this.state.exhausted ??= `${search ? "search" : "stage"} share of mdsd.total ($${round2(spent.costUSD)} spent, $${round2(running.costUSD)} running, of $${round2(limitUSD)}; ${spent.requests} + ${running.requests} of ${limitRequests} requests)`;
    this.event({ stage: "admission", reason, refused: true, worstUSD: round2(cost), worstRequests: requests, leftUSD: round2(leftCost), leftRequests });
    const way = search ? 'Use fewer or smaller strategies (strategy.budget), or integrate, verify and report with data.mdsd.stop.reason "budget".' : 'Check fewer things yourself, or report with data.mdsd.stop.reason "budget" (unchecked findings stay unverified).';
    throw new Error(`Refused (MDSD budget): ${noticed ? `the run reached its final-report allowance (${noticed}); no further stage is admitted. ` : ""}this ${reason} call's worst case is $${round2(cost)} and ${requests} requests (${allocations.length} worker(s): allocation x ${hardStopAt} hard stop, + ${REPORT_EXEMPTIONS} report responses each), but the ${search ? "search" : "stage"} share of mdsd.total has $${round2(Math.max(0, leftCost))} and ${Math.max(0, leftRequests)} requests left (all stages spent $${round2(spent.costUSD)} / ${spent.requests} requests, still running $${round2(running.costUSD)}; mdsd.total $${total.costUSD} / ${total.requests} requests: search up to ${Math.round((1 - reserve) * 100)}%, other stages up to ${Math.round((1 - final) * 100)}%, the rest is the final-report allowance). ${way}`);
  }
  /**
   * After each orchestrator response: at (1 - final) of mdsd.total a notice (no further stage; report now), at mdsd.total the stop
   * (its turn ends, one forced report). `apply` performs them (workers.ts: AgentManager.budgetAction) and says whether it acted.
   */
  enforceOrchestrator(apply: (action: "notice" | "stop", text: string) => boolean): void {
    const { total, final } = this.settings;
    const spent = this.spent();
    const at = `$${round2(spent.costUSD)} / ${spent.requests} requests of $${total.costUSD} / ${total.requests}`;
    const state = this.state.orchestrator;
    if (!state.stopped && (spent.costUSD >= total.costUSD || spent.requests >= total.requests)) {
      const text = `The MDSD total budget is used up (${at}) and your turn was stopped. Call report_result alone now with what you have: data.mdsd with stop.reason "budget", every explorer finding kept or dropped where you can (unaccounted ones are recorded as such), findings you could not check marked unverified, explored and unexplored scope${this.options.readOnly ? "" : '; data.status "blocked" with data.reason if the work is unfinished'}.`;
      if (apply("stop", text)) { state.stopped = at; this.state.exhausted ??= `mdsd.total (${at})`; this.event({ stage: "budget", action: "stop", at }); }
    } else if (!state.noticed && !state.stopped && (spent.costUSD >= total.costUSD * (1 - final) || spent.requests >= total.requests * (1 - final))) {
      const text = `MDSD budget: all stages spent ${at}; the final-report allowance (the last ${Math.round(final * 100)}%) has begun. No further orche_spawn call is admitted. Integrate what you have and call report_result now with data.mdsd.stop.reason "budget" (unchecked findings stay unverified; unexplored scope stays listed). At the total your turn is stopped and you get one forced report prompt.`;
      if (apply("notice", text)) { state.noticed = at; this.event({ stage: "budget", action: "notice", at }); }
    }
  }

  // ---- orche_spawn hooks ----
  /**
   * The call that runs. With a pinned first round (mdsd.replication.round) the orchestrator's first search call names the pinned
   * workers in order, and the pinned plan, requests and strategies run, not the text of the call: a recorded round is rerun exactly,
   * without depending on the orchestrator to copy it. Every other call runs as it is.
   */
  resolve(call: SpawnCall): SpawnCall {
    const pin = this.settings.replication?.round;
    if (!pin || call.reason !== "search" || this.state.rounds.length) return call;
    const expected = pin.workers.map(worker => worker.name);
    const names = call.workers.map(worker => worker.name);
    if (names.join("\n") !== expected.join("\n"))
      throw new Error(`Refused: this run's first search round is pinned by the experiment (mdsd.replication.round): call orche_spawn with reason "search" and the workers ${expected.map(name => JSON.stringify(name)).join(", ")} in this order, each role "answer" (request "pinned" is enough: the pinned plan, requests and strategies run); got ${names.map(name => JSON.stringify(name)).join(", ") || "none"}.`);
    this.pinnedNext = true;
    return { reason: "search", plan: pin.plan, workers: pin.workers.map(worker => ({ name: worker.name, role: "answer" as const, request: worker.request, strategy: worker.strategy })) };
  }

  /** Checks the call before any id is given out (a refused call uses none); throws with what to change. */
  validate(reason: SpawnReason, workers: readonly { role: string; name: string; strategy?: unknown }[], call?: SpawnCall): void {
    if (reason !== "search") {
      if (workers.some(worker => worker.strategy !== undefined)) throw new Error(`strategy belongs to reason "search" (MDSD exploration paths), not "${reason}".`);
      if (call?.plan !== undefined || call?.adapt !== undefined) throw new Error(`plan and adapt belong to reason "search", not "${reason}".`);
      this.admit(reason, workers.map(() => this.allocation({})));
      return;
    }
    const state = this.state;
    if (state.rounds.length >= this.settings.maxRounds) {
      state.exhausted = `round cap ${this.settings.maxRounds}`;
      throw new Error(`Refused: ${state.rounds.length} search rounds ran (cap mdsd.maxRounds ${this.settings.maxRounds}). Integrate what you have, verify it, and report with data.mdsd.stop.reason "round-cap".`);
    }
    if (workers.some(worker => worker.role !== "answer")) throw new Error('reason "search" takes read-only explorers only (role answer): exploration proposes, it does not change files.');
    const first = state.rounds.length === 0;
    // mdsd.seed: the registered prior claims are round 0, so the first search round is already a follow-up (adaptive rules below).
    const initial = first && !this.settings.seed;
    if (initial && workers.length < 2) throw new Error('the first search round takes two or more strategies: one path is no diversification. When diversification does not pay, work as a single path yourself (no search round) and report data.mdsd.decision "single-path".');
    // The plan: required first, unchanged afterwards (task drift is not diversification).
    const plan = call?.plan;
    if (first) {
      if (!plan) throw new Error(`the first search call needs plan {objective, constraints, success, rationale}: the common objective and mandatory constraints every path keeps.`);
      if (!Value.Check(planSchema, plan)) throw new Error(`Invalid plan: ${formatSchemaErrors(planSchema as TSchema, plan, 4)}`);
    } else if (plan !== undefined) {
      if (!Value.Check(planSchema, plan)) throw new Error(`Invalid plan: ${formatSchemaErrors(planSchema as TSchema, plan, 4)}`);
      const earlier = state.plan!;
      if (normalize(plan.objective) !== normalize(earlier.objective) || plan.constraints.map(normalize).join("\n") !== earlier.constraints.map(normalize).join("\n"))
        throw new Error("Refused: the plan's objective and mandatory constraints are fixed by the first search round; another objective is task drift, not search diversification. Omit plan (the first one applies) or repeat it unchanged.");
    }
    // Strategies: schema, then substance.
    const strategies: MdsdStrategy[] = [];
    for (const worker of workers) {
      if (worker.strategy === undefined) throw new Error(`${worker.name}: reason "search" needs a strategy spec per explorer (framing, operators, hypothesis_space, evidence_scope, method, reasoning, direction, validation).`);
      if (!Value.Check(strategySchema, worker.strategy)) throw new Error(`${worker.name}: invalid strategy: ${formatSchemaErrors(strategySchema as TSchema, worker.strategy, 6)}`);
      strategies.push(worker.strategy as MdsdStrategy);
    }
    this.checkDiversity(workers.map(worker => worker.name), strategies);
    if (initial) {
      if (call?.adapt !== undefined) throw new Error("adapt is for later search rounds: it cites the aggregation of an earlier round.");
      if (strategies.some(strategy => strategy.targets?.length)) throw new Error("targets are for adaptive rounds (ids of the aggregation of an earlier round).");
    } else this.checkAdaptive(workers.map(worker => worker.name), strategies, call?.adapt);
    // mdsd.replication: every strategy runs once per model, so the round has that many explorer cells (within the session's cap).
    const copies = this.settings.replication?.models.length ?? 1;
    const cap = this.options.maxSubWorkers ?? MAX_SUB_WORKERS;
    if (copies > 1 && workers.length * copies > cap) throw new Error(`Refused: mdsd.replication runs every strategy once per model (${copies} models): ${workers.length} strategies are ${workers.length * copies} explorers, above this session's cap of ${cap} sub-workers per call. Use at most ${Math.floor(cap / copies)} strategies in a round.`);
    // All stages are charged (orchestrator, explorers, verifiers, others); the round's worst case must fit the search share.
    this.admit("search", strategies.flatMap(strategy => Array.from({ length: copies }, () => this.allocation(strategy))));
  }

  /** Label-only diversity is refused: a pair with the same signature must differ in hypothesis space or evidence scope. */
  private checkDiversity(names: readonly string[], strategies: readonly MdsdStrategy[]): void {
    for (let i = 0; i < strategies.length; i++) for (let j = i + 1; j < strategies.length; j++) {
      const a = strategies[i]!, b = strategies[j]!;
      if (signatureOf(a) !== signatureOf(b)) continue;
      const hypotheses = jaccard(tokensOf(...a.hypothesis_space), tokensOf(...b.hypothesis_space));
      const scope = jaccard(tokensOf(...a.evidence_scope), tokensOf(...b.evidence_scope));
      if (hypotheses >= DIVERSITY_OVERLAP && scope >= DIVERSITY_OVERLAP)
        throw new Error(`Refused: ${names[i]} and ${names[j]} are one search path: the same operators, direction, reasoning and validation (${signatureOf(a)}) and overlapping hypothesis spaces (${round2(hypotheses)}) and evidence scopes (${round2(scope)}). Different names or wording are not diversification: change how one of them searches (operators, direction, reasoning, validation) or what it searches (hypotheses, information sources), or drop it.`);
    }
  }

  /** Adaptive rounds act on results: a basis of aggregation ids, targeted exploit strategies, and an exploration reserve. */
  private checkAdaptive(names: readonly string[], strategies: readonly MdsdStrategy[], adapt: unknown): void {
    if (adapt === undefined) throw new Error('a later search round needs adapt {basis: ids from the aggregation of earlier rounds (F…, D…, C…, G…), reason}: adaptive search follows results and uncertainty, not a fixed second round.');
    if (!Value.Check(adaptSchema, adapt)) throw new Error(`Invalid adapt: ${formatSchemaErrors(adaptSchema as TSchema, adapt, 4)}`);
    const known = this.knownIds();
    const unknown = (adapt as MdsdAdapt).basis.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`adapt.basis names unknown ids ${unknown.join(", ")}; known: ${[...known].slice(0, 40).join(", ") || "none"}.`);
    const earlier = this.state.explorers.flatMap(explorer => [...explorer.strategy.hypothesis_space, ...explorer.strategy.evidence_scope]).map(item => tokensOf(item));
    let explore = 0;
    strategies.forEach((strategy, index) => {
      if (!strategy.purpose) throw new Error(`${names[index]}: an adaptive strategy states its purpose: "exploit" (it targets ids of the aggregation) or "explore" (new hypotheses or information sources).`);
      if (strategy.purpose === "exploit") {
        const targets = strategy.targets ?? [];
        if (!targets.length) throw new Error(`${names[index]}: an exploit strategy targets ids of the aggregation (targets: ["G2", "C1", …]).`);
        const bad = targets.filter(id => !known.has(id));
        if (bad.length) throw new Error(`${names[index]}: unknown targets ${bad.join(", ")}.`);
        return;
      }
      explore++;
      const fresh = [...strategy.hypothesis_space, ...strategy.evidence_scope].filter(item => earlier.every(seen => jaccard(tokensOf(item), seen) < NOVELTY_OVERLAP));
      if (!fresh.length) throw new Error(`${names[index]}: an explore strategy opens hypotheses or information sources no earlier strategy had; every item of its hypothesis_space and evidence_scope repeats an earlier one.`);
    });
    if (strategies.length >= 2 && !explore) throw new Error('Refused: an adaptive round of two or more strategies keeps at least one purpose "explore" strategy (new hypotheses or information sources), so the search does not only amplify an early explanation.');
  }

  private knownIds(): Set<string> {
    const { findings, aggregation } = this.state;
    return new Set([...findings.map(item => item.gid), ...findings.map(item => item.ref), ...aggregation.duplicates.map(item => item.id), ...aggregation.conflicts.map(item => item.id), ...aggregation.gaps.map(item => item.id)]);
  }

  /** A strategy's allocation: its own budget, else the default, each dimension clamped to explorerMax. */
  allocation(strategy: Pick<MdsdStrategy, "budget">): MdsdBudget {
    const own = strategy.budget ?? {};
    const pick = (key: keyof MdsdBudget) => Math.min(this.settings.explorerMax[key], own[key] ?? this.settings.explorer[key]);
    return { requests: pick("requests"), minutes: pick("minutes"), costUSD: pick("costUSD"), outputTokens: pick("outputTokens") };
  }

  async prepare(reason: SpawnReason, workers: PlannedWorker[], _signal: AbortSignal, call?: SpawnCall, nextId?: () => string): Promise<PlannedWorker[]> {
    this.validate(reason, workers, call);
    if (reason !== "search") {
      // Verifiers and other sub-workers get the default allocation, reserved now (admitted in validate) and enforced per session.
      const allocated = this.allocation({});
      const entries = workers.map(worker => ({ id: worker.id, status: "running", requests: 0, costUSD: 0, durationMs: 0, allocated }));
      if (reason === "verification") {
        this.state.verifications.push({ round: this.state.verifications.length + 1, workers: entries });
        this.openPhase(`verification-${this.state.verifications.length}`);
      } else {
        this.state.others.push({ reason, workers: entries });
        this.openPhase(`${reason}-${this.state.others.length}`);
      }
      this.event({ stage: reason, workers: workers.map(worker => worker.id), allocated });
      const notice = reason === "verification"
        ? "Finish the check in progress and call report_result alone with your verdict on what you checked; name what you did not get to check."
        : 'Finish the current step, run the check you can, and call report_result alone; use data.status "blocked" with what is unfinished.';
      return workers.map(worker => ({ ...worker, budget: { ...allocated, wrapUpAt: this.settings.wrapUpAt, hardStopAt: this.settings.hardStopAt, notice } }));
    }
    const state = this.state;
    // mdsd.replication: the strategies on the first model keep their ids, every further model gets the same strategies again (in
    // the same order, fresh ids); `group` is the strategy's identity, the id of its first cell. Without replication: one cell each.
    const models: (RouteSettings | undefined)[] = this.settings.replication?.models ?? [undefined];
    if (models.length > 1 && !nextId) throw new Error("MDSD replication: orche_spawn gave no sub-worker ids for the replicates");
    const cells = models.flatMap((route, index) => workers.map(worker => ({ worker: index === 0 ? worker : { ...worker, id: nextId!() }, route, group: worker.id })));
    // mdsd.explorerScratch: every cell's private scratch directory next to the orchestrator's (<base>/<session>/<id>), before any state changes.
    const scratchOf = new Map<string, string>();
    if (this.settings.explorerScratch) {
      const own = this.options.scratch;
      if (!own) throw new Error("mdsd.explorerScratch: the orchestrator has no scratch directory, so its explorers cannot get one either");
      for (const { worker } of cells) scratchOf.set(worker.id, await ensureScratchDir({ base: dirname(dirname(own)), session: basename(dirname(own)), worker: worker.id }));
    }
    if (!state.plan) state.plan = { ...(call!.plan as MdsdPlan) };
    const round = state.rounds.length + 1;
    const pinned = this.pinnedNext;
    this.pinnedNext = false;
    const prepared = cells.map(({ worker, route, group }) => {
      const strategy = worker.strategy as MdsdStrategy;
      const allocated = this.allocation(strategy);
      const scratch = scratchOf.get(worker.id);
      state.allocated.costUSD += allocated.costUSD;
      state.allocated.requests += allocated.requests;
      state.explorers.push({ id: worker.id, name: worker.name, round, strategy, signature: signatureOf(strategy), allocated, ...(route ? { model: route.model, group } : {}), ...(scratch ? { scratch } : {}), status: "running", findings: [], exploredScope: [], unexploredScope: [], sourcesUsed: [], procedures: [], files: [], searches: [], commands: [], reads: [], toolCalls: 0, overshoot: [] });
      this.live.set(worker.id, { files: new Set(), searches: new Set(), commands: new Set(), reads: [], toolCalls: 0 });
      return {
        ...worker,
        brief: explorerBrief(state.plan!, strategy, allocated, round, this.settings.hardStopAt),
        budget: { ...allocated, wrapUpAt: this.settings.wrapUpAt, hardStopAt: this.settings.hardStopAt },
        check: (data: unknown) => explorerReportError(data),
        ...(route ? { route } : {}),
        ...(scratch ? { scratch } : {}),
      } satisfies PlannedWorker;
    });
    const replicated = models.length > 1 ? { models: models.map(route => route!.model) } : {};
    state.rounds.push({ round, spawnedAt: this.now(), workers: prepared.map(worker => worker.id), ...(call?.adapt ? { adapt: { ...(call.adapt as MdsdAdapt) } } : {}), ...replicated, ...(pinned ? { pinned: true } : {}) });
    this.openPhase(`search-${round}`);
    this.event({ stage: "search", round, ...(round === 1 ? { plan: state.plan } : {}), ...(call?.adapt ? { adapt: call.adapt } : {}), ...replicated, ...(pinned ? { pinned: true } : {}), workers: prepared.map(worker => { const item = state.explorers.find(entry => entry.id === worker.id)!; return { id: worker.id, name: worker.name, strategy: worker.strategy, allocated: item.allocated, ...(item.model ? { model: item.model, group: item.group } : {}), ...(item.scratch ? { scratch: item.scratch } : {}) }; }) });
    return prepared;
  }

  async finish(reason: SpawnReason, workers: readonly PlannedWorker[], outcomes: SubWorkerOutcome[]): Promise<string[]> {
    if (reason !== "search") {
      const stage = reason === "verification" ? this.state.verifications.at(-1) : this.state.others.at(-1);
      if (stage) stage.workers = stage.workers.map(entry => {
        const outcome = outcomes.find(item => item.id === entry.id);
        // A worker without an outcome released its reservation as failed; its spend is unknown (not counted as zero).
        if (!outcome) return { ...entry, status: "failed", inFlightUnknown: true };
        return { ...entry, status: outcome.status, requests: outcome.requests, costUSD: outcome.costUSD, durationMs: outcome.durationMs, ...(outcome.usage ? { outputTokens: outcome.usage.output } : {}), ...(outcome.budget?.stoppedBy ? { stoppedBy: outcome.budget.stoppedBy } : {}), ...(outcome.budget?.inFlightUnknown ? { inFlightUnknown: true } : {}) };
      });
      if (reason !== "verification") { this.openPhase(`after-${reason}-${this.state.others.length}`); return []; }
      this.openPhase(`after-verification-${this.state.verifications.length}`);
      return [`MDSD verification round ${this.state.verifications.length}: ${outcomes.map(outcome => `${outcome.id} ${outcome.status}`).join(", ")}. Cite a verifier's id (e.g. ${outcomes[0]?.id ?? "W1.9"}) as evidence of the findings it checked; reproduce or refute what it reports yourself.`];
    }
    if (reason !== "search") return [];
    const state = this.state;
    const round = state.rounds.at(-1)!;
    round.endedAt = this.now();
    const earlierFiles = new Set(state.explorers.filter(item => item.round < round.round).flatMap(item => item.files));
    const members = workers.map(worker => state.explorers.find(item => item.id === worker.id)!).filter(Boolean);
    for (const explorer of members) {
      const outcome = outcomes.find(item => item.id === explorer.id);
      const trace = this.live.get(explorer.id);
      this.live.delete(explorer.id);
      explorer.files = [...(trace?.files ?? [])].sort();
      explorer.searches = [...(trace?.searches ?? [])].sort();
      explorer.commands = [...(trace?.commands ?? [])];
      explorer.reads = [...(trace?.reads ?? [])];
      explorer.toolCalls = trace?.toolCalls ?? 0;
      explorer.status = outcome?.status ?? "failed";
      if (outcome?.error) explorer.error = clip(outcome.error, 600);
      if (explorer.status !== "done" && explorer.status !== "blocked" && trace?.lastText) explorer.partial = trace.lastText;
      if (outcome) {
        explorer.actual = { requests: outcome.requests, costUSD: round2(outcome.costUSD * 10000) / 10000, durationMs: outcome.durationMs, ...(outcome.usage ? { outputTokens: outcome.usage.output, inputTokens: outcome.usage.input, cacheReadTokens: outcome.usage.cacheRead } : {}) };
        const over: string[] = [];
        if (outcome.requests > explorer.allocated.requests) over.push(`requests ${outcome.requests}/${explorer.allocated.requests}`);
        if (outcome.costUSD > explorer.allocated.costUSD) over.push(`cost $${round2(outcome.costUSD)}/$${explorer.allocated.costUSD}`);
        if (outcome.durationMs > explorer.allocated.minutes * 60_000) over.push(`time ${round2(outcome.durationMs / 60_000)}/${explorer.allocated.minutes} min`);
        if (outcome.usage && outcome.usage.output > explorer.allocated.outputTokens) over.push(`output tokens ${outcome.usage.output}/${explorer.allocated.outputTokens}`);
        explorer.overshoot = over;
        if (outcome.budget?.wrapUp) explorer.wrapUp = outcome.budget.wrapUp;
        if (outcome.budget?.stoppedBy) explorer.stoppedBy = outcome.budget.stoppedBy;
        if (outcome.budget?.inFlightUnknown) explorer.inFlightUnknown = true;
      } else explorer.inFlightUnknown = true;
      const data = outcome && (outcome.status === "done" || outcome.status === "blocked") ? dataOf(outcome.data) as Partial<ExplorerData> : undefined;
      if (data && Value.Check(explorerDataSchema, data)) {
        explorer.findings = (data.findings ?? []).map(item => ({ ...item }));
        explorer.exploredScope = [...(data.explored_scope ?? [])];
        explorer.unexploredScope = [...(data.unexplored_scope ?? [])];
        explorer.sourcesUsed = [...(data.sources_used ?? [])];
        explorer.procedures = [...(data.procedures ?? [])];
        explorer.uncertainty = data.uncertainty;
      } else if (outcome && (outcome.status === "done" || outcome.status === "blocked")) {
        // A report outside the output contract (the report check normally prevents it): nothing is registered as a finding,
        // and what it said is kept as partial text, so it is visible rather than silently lost.
        explorer.error = "its report did not match the MDSD output contract; nothing registered";
        explorer.partial = clip(`${outcome.summary} ${JSON.stringify(outcome.data ?? null)}`, 4000);
      }
      explorer.newFiles = explorer.files.filter(file => !earlierFiles.has(file)).length;
      const scopeTokens = explorer.strategy.evidence_scope.map(item => ({ item, tokens: tokensOf(item), paths: [...item.matchAll(/[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.*-]+)+\/?|[A-Za-z0-9_@-]+\.[A-Za-z0-9]{1,8}/g)].map(match => match[0].replace(/\*.*$/, "").replace(/\/$/, "")) }));
      const footprint = [...explorer.files, ...explorer.searches, ...explorer.commands].join("\n").toLowerCase();
      explorer.scopeTouched = scopeTokens.filter(({ tokens, paths }) => paths.some(path => path && footprint.includes(path.toLowerCase())) || [...tokens].some(token => token.length >= 5 && footprint.includes(token))).length;
    }
    for (const explorer of members) explorer.uniqueFiles = explorer.files.filter(file => !members.some(other => other !== explorer && other.files.includes(file))).length;
    // Redundancy: pairwise overlap of the files the finished explorers of this round read.
    const finished = members.filter(item => item.status === "done" || item.status === "blocked");
    const pairs: { a: string; b: string; files: number }[] = [];
    for (let i = 0; i < finished.length; i++) for (let j = i + 1; j < finished.length; j++) pairs.push({ a: finished[i]!.id, b: finished[j]!.id, files: round2(jaccard(new Set(finished[i]!.files), new Set(finished[j]!.files))) });
    round.pairs = pairs;
    if (pairs.length) round.redundancy = round2(pairs.reduce((sum, pair) => sum + pair.files, 0) / pairs.length);
    // Register the round's findings and aggregate the whole run.
    for (const explorer of members) for (const finding of explorer.findings) {
      state.findings.push({ gid: `F${state.findings.length + 1}`, ref: `${explorer.id}:${finding.id}`, worker: explorer.id, round: round.round, finding, locations: locationsOf([...(finding.location ?? []), finding.claim, ...finding.evidence]) });
    }
    state.aggregation = aggregate(state);
    this.openPhase(`integration-${round.round}`);
    const persisted = await this.persistRound(round, members).catch(() => undefined);
    const file = persisted?.file;
    this.event({
      stage: "search-end", round: round.round, redundancy: round.redundancy ?? null, pairs, ...(persisted ? { file: persisted.file, json: persisted.json, sha256: persisted.sha256 } : {}),
      explorers: members.map(explorer => ({ id: explorer.id, ...(explorer.model ? { model: explorer.model, group: explorer.group } : {}), status: explorer.status, ...(explorer.error ? { error: explorer.error } : {}), findings: explorer.findings, exploredScope: explorer.exploredScope, unexploredScope: explorer.unexploredScope, sourcesUsed: explorer.sourcesUsed, procedures: explorer.procedures, ...(explorer.uncertainty ? { uncertainty: explorer.uncertainty } : {}), ...(explorer.partial ? { partial: explorer.partial } : {}), files: explorer.files.length, newFiles: explorer.newFiles, uniqueFiles: explorer.uniqueFiles, scopeTouched: `${explorer.scopeTouched}/${explorer.strategy.evidence_scope.length}`, toolCalls: explorer.toolCalls, allocated: explorer.allocated, actual: explorer.actual, overshoot: explorer.overshoot, ...(explorer.wrapUp ? { wrapUp: explorer.wrapUp } : {}), ...(explorer.stoppedBy ? { stoppedBy: explorer.stoppedBy } : {}), filesRead: explorer.files.slice(0, 600), reads: explorer.reads.slice(0, 600), searches: explorer.searches.slice(0, 300), commands: explorer.commands.slice(0, 200) })),
      aggregation: state.aggregation,
    });
    return this.roundLines(round, members, file);
  }

  /**
   * The complete data of a search round (every explorer's strategy, report fields and footprint, the aggregation), written next to
   * the orchestrator's scratch so integration never depends on the clipped tool result (tool results above 12,000 characters are
   * cut to a preview by orche's output spill). Markdown for reading, JSON for records and analysis; the JSON's sha256 goes into the
   * search-end event, so the explorers' outputs as they were before integration can be told from any later copy.
   */
  private async persistRound(round: MdsdRound, members: readonly MdsdExplorer[]): Promise<{ file: string; json: string; sha256: string } | undefined> {
    const dir = this.options.scratch;
    if (!dir) return undefined;
    await mkdir(dir, { recursive: true });
    const base = join(dir, `mdsd-${this.options.orchestrator}-round-${round.round}`);
    const state = this.state;
    const md: string[] = [`# MDSD search round ${round.round} (${this.options.orchestrator})`, "", `Objective: ${state.plan?.objective ?? ""}`, "", `Redundancy (mean pairwise overlap of files read): ${round.redundancy ?? "n/a"}`, ""];
    for (const explorer of members) {
      md.push(`## ${explorer.id} ${explorer.name}${explorer.model ? ` on ${explorer.model} (strategy ${explorer.group})` : ""} — ${explorer.status}`, `strategy: ${JSON.stringify(explorer.strategy)}`, `allocated: ${JSON.stringify(explorer.allocated)}; actual: ${JSON.stringify(explorer.actual ?? null)}${explorer.overshoot.length ? `; over: ${explorer.overshoot.join(", ")}` : ""}${explorer.wrapUp ? `; wrap-up: ${explorer.wrapUp}` : ""}${explorer.stoppedBy ? `; stopped: ${explorer.stoppedBy}` : ""}${explorer.scratch ? `; scratch: ${explorer.scratch}` : ""}`);
      if (explorer.error) md.push(`error: ${explorer.error}`);
      if (explorer.partial) md.push("partial (no valid report; its last text, not a finding):", explorer.partial);
      for (const finding of explorer.findings) {
        const gid = state.findings.find(item => item.ref === `${explorer.id}:${finding.id}`)?.gid;
        md.push(`### ${gid ?? "?"} = ${explorer.id}:${finding.id} [uncertainty ${finding.uncertainty}]`, finding.claim, ...(finding.location?.length ? [`location: ${finding.location.join("; ")}`] : []), ...finding.evidence.map(item => `- evidence: ${item}`), ...finding.counter_evidence.map(item => `- counter-evidence: ${item}`));
      }
      md.push(`uncertainty: ${explorer.uncertainty ?? ""}`, ...explorer.exploredScope.map(item => `- explored: ${item}`), ...explorer.unexploredScope.map(item => `- unexplored: ${item}`), ...explorer.sourcesUsed.map(item => `- source used (reported): ${item}`), ...explorer.procedures.map(item => `- procedure (reported): ${item}`));
      md.push(`footprint (measured from its tool calls): ${explorer.toolCalls} calls; files read ${explorer.files.length}: ${explorer.files.join(", ")}`, `reads: ${explorer.reads.join(", ")}`, `searches: ${explorer.searches.join(" | ")}`, `commands: ${explorer.commands.join(" | ")}`, "");
    }
    md.push("## Aggregation (heuristic candidates)", `duplicates: ${JSON.stringify(state.aggregation.duplicates)}`, `conflicts: ${JSON.stringify(state.aggregation.conflicts)}`, `gaps: ${JSON.stringify(state.aggregation.gaps)}`, `high uncertainty: ${state.aggregation.uncertain.join(", ")}`);
    await writeFile(`${base}.md`, `${md.join("\n")}\n`);
    const json = JSON.stringify({ round, plan: state.plan, explorers: members, findings: state.findings.filter(item => item.round === round.round), aggregation: state.aggregation }, null, 1);
    await writeFile(`${base}.json`, json);
    // file: the Markdown for reading; json and sha256: the JSON record and the hash of exactly its bytes.
    return { file: `${base}.md`, json: `${base}.json`, sha256: createHash("sha256").update(json).digest("hex") };
  }

  /** The spawn result's MDSD part (kept under orche's 12,000-character spill): per explorer, findings, aggregation, what is left. */
  private roundLines(round: MdsdRound, members: readonly MdsdExplorer[], file?: string): string[] {
    const state = this.state;
    const groups = new Set(members.map(explorer => explorer.group ?? explorer.id)).size;
    const lines = [`MDSD search round ${round.round}/${this.settings.maxRounds}: ${groups} strateg${groups === 1 ? "y" : "ies"}${round.models ? ` x ${round.models.length} models = ${members.length} explorer cells` : ""}, redundancy (mean pairwise overlap of files read) ${round.redundancy ?? "n/a"}${round.pairs?.length ? ` [${round.pairs.map(pair => `${pair.a}~${pair.b} ${pair.files}`).join(", ")}]` : ""}.${file ? ` Complete round data (every finding with its evidence, counter-evidence and uncertainty, scopes, sources, procedures, footprints): ${file} — read it before you integrate; the lines below are clipped.` : ""}`];
    if (round.models) lines.push(`Replication (mdsd.replication${round.pinned ? ", the experiment's pinned round" : ""}): every strategy ran once per model (${round.models.join(", ")}) with the same brief and request. The cells of one strategy are the same search path on different models, not distinct paths: their agreement is a replication, not independent proof. Strategies: ${[...new Set(members.map(explorer => explorer.group ?? explorer.id))].map(group => `${group} = ${members.filter(explorer => (explorer.group ?? explorer.id) === group).map(explorer => `${explorer.id} on ${explorer.model}`).join(" / ")}`).join("; ")}.`);
    for (const explorer of members) {
      const actual = explorer.actual;
      lines.push(`- ${explorer.id} ${explorer.name} [${explorer.signature}]${explorer.model ? ` on ${explorer.model}` : ""} ${explorer.status}${explorer.error ? ` (${clip(explorer.error, 160)})` : ""}: ${explorer.findings.length} finding(s); read ${explorer.files.length} file(s) (${explorer.newFiles ?? 0} new to the run, ${explorer.uniqueFiles ?? 0} no sibling read), ${explorer.searches.length} search/list call(s), ${explorer.commands.length} command(s); declared scope touched ${explorer.scopeTouched ?? 0}/${explorer.strategy.evidence_scope.length}; budget ${actual ? `${actual.requests}/${explorer.allocated.requests} req, $${round2(actual.costUSD)}/$${explorer.allocated.costUSD}, ${round2(actual.durationMs / 60_000)}/${explorer.allocated.minutes} min${actual.outputTokens !== undefined ? `, ${actual.outputTokens}/${explorer.allocated.outputTokens} out tok` : ""}` : "not measured"}${explorer.overshoot.length ? `; OVER: ${explorer.overshoot.join(", ")}` : ""}${explorer.stoppedBy ? `; stopped: ${explorer.stoppedBy}` : explorer.wrapUp ? `; wrap-up notice at ${explorer.wrapUp}` : ""}${explorer.partial ? "; partial text kept in the round data (no valid report)" : ""}.`);
    }
    const roundFindings = state.findings.filter(item => item.round === round.round);
    const budget = file ? 7_000 : 10_000;
    let used = lines.join("\n").length;
    if (roundFindings.length) {
      lines.push("Findings (proposals, not verdicts):");
      let shown = 0;
      for (const item of roundFindings) {
        const line = `  ${item.gid} = ${item.ref} [${item.finding.uncertainty}]${item.locations.length ? ` ${item.locations.slice(0, 3).map(loc => `${loc.file}:${loc.start}${loc.end !== loc.start ? `-${loc.end}` : ""}`).join(", ")}` : ""}: ${clip(item.finding.claim, 200)}${item.finding.counter_evidence.length ? ` (counter-evidence: ${clip(item.finding.counter_evidence.join("; "), 120)})` : ""}`;
        if (used + line.length > budget) break;
        lines.push(line); used += line.length + 1; shown++;
      }
      if (shown < roundFindings.length) lines.push(`  … ${roundFindings.length - shown} more finding(s)${file ? ` in ${file}` : " (see the explorers' reports above)"}`);
    } else lines.push("Findings: none reported in this round.");
    const { duplicates, conflicts, gaps, uncertain } = state.aggregation;
    if (duplicates.length) lines.push(`Likely duplicates (heuristic: shared file and nearby lines, or similar claims): ${clip(duplicates.map(item => `${item.id} = ${item.members.join(", ")} (${item.why})`).join("; "), 1200)}`);
    if (conflicts.length) lines.push(`Conflict candidates: ${clip(conflicts.map(item => `${item.id} = ${item.members.join(", ")} (${item.why})`).join("; "), 800)}`);
    const open = gaps.filter(gap => !gap.coveredBy.length);
    if (gaps.length) lines.push(`Gaps (unexplored scope): ${clip(gaps.map(gap => `${gap.id} ${gap.worker}: ${clip(gap.text, 90)}${gap.coveredBy.length ? ` [possibly covered by ${gap.coveredBy.join(", ")}]` : " [uncovered]"}`).join("; "), 1500)}${open.length ? `; ${open.length} uncovered` : ""}`);
    if (uncertain.length) lines.push(`High uncertainty: ${uncertain.join(", ")}`);
    const spent = this.spent();
    const limitUSD = this.settings.total.costUSD * (1 - this.settings.reserve);
    lines.push(`Next: integrate (merge duplicates, resolve conflicts with evidence, decide what stays uncertain). Another search round only when it pays: adapt.basis cites these ids, exploit strategies target them, and with 2+ strategies at least one explores new hypotheses or sources. Rounds left ${this.settings.maxRounds - state.rounds.length}; all stages spent $${round2(spent.costUSD)} of the run's $${this.settings.total.costUSD} (search rounds may use up to $${round2(limitUSD)}; the rest is reserved for integration, verification and synthesis). Then verify what you keep (your own checks or reason "verification"); agreement is not proof.`);
    return lines;
  }

  // ---- the report gate ----
  /** Validation of the orchestrator's report (`validateResult`); undefined: accepted. */
  gateError(kind: string, data: unknown): string | undefined {
    if (kind !== (this.options.readOnly ? "answer" : "implement")) return undefined;
    const record = dataOf(data);
    const error = this.check(record);
    this.gateResult = error ? `rejected: ${clip(error, 300)}` : `${record.status === "blocked" ? "accepted as blocked" : "passed"}${this.state.orchestrator.stopped ? ` after the budget stop${this.unaccounted ? ` (${this.unaccounted} explorer finding(s) left unaccounted)` : ""}` : ""}`;
    if (error) this.event({ stage: "gate", rejected: error.slice(0, 2000) });
    else this.event({ stage: "gate", passed: true, summary: this.summary() });
    return error;
  }

  private check(record: Record<string, unknown>): string | undefined {
    const mdsd = record.mdsd;
    if (!Value.Check(mdsdReportSchema, mdsd)) return `data.mdsd is required in mdsd mode${mdsd === undefined ? "" : `: ${formatSchemaErrors(mdsdReportSchema as TSchema, mdsd, 4)}`}. Expected ${REPORT_FORMAT}.`;
    const report = mdsd as MdsdReport;
    const state = this.state;
    const problems: string[] = [];
    const blocked = record.status === "blocked" || report.stop.reason === "blocked";
    if (blocked) {
      if (!this.options.readOnly && record.status !== "blocked") return 'data.mdsd.stop.reason "blocked" needs status "blocked" and data.reason.';
      if (!this.options.readOnly && !(typeof record.reason === "string" && record.reason.trim())) return "A blocked MDSD report needs data.reason: where it stopped, why, and what was found so far.";
      if (this.options.readOnly && !(Array.isArray(record.unresolved) && record.unresolved.length)) return "A blocked MDSD answer lists what is missing in data.unresolved.";
    }
    if (report.decision === "single-path" && state.rounds.length) problems.push(`decision "single-path" but ${state.rounds.length} search round(s) ran: report "diversified"`);
    if (report.decision === "diversified" && !state.rounds.length) problems.push('decision "diversified" but no search round ran: run orche_spawn reason "search", or report "single-path" with why one path sufficed');
    if (this.settings.seed && !state.rounds.length && !blocked) problems.push('registered prior claims (mdsd.seed) need the follow-up first: orche_spawn reason "search" with adapt.basis citing the claim ids and gaps it follows up, then verification, then this report');
    if (state.plan && normalize(report.objective) !== normalize(state.plan.objective)) problems.push("data.mdsd.objective must be the plan's objective, unchanged (the common goal every path kept)");
    // Every explorer finding accounted for: kept (provenance) or dropped with a reason.
    const byGid = new Map(state.findings.map(item => [item.gid, item.ref]));
    const refs = new Set(state.findings.map(item => item.ref));
    const resolveRef = (ref: string) => byGid.get(ref.trim()) ?? ref.trim();
    const kept = new Set<string>();
    const unknown = new Set<string>();
    for (const finding of report.findings) for (const ref of finding.provenance) { const id = resolveRef(ref); if (refs.has(id)) kept.add(id); else unknown.add(ref); }
    const dropped = new Set<string>();
    for (const item of report.dropped ?? []) for (const ref of item.refs) { const id = resolveRef(ref); if (refs.has(id)) dropped.add(id); else unknown.add(ref); }
    if (unknown.size) problems.push(`unknown explorer finding refs ${[...unknown].slice(0, 12).join(", ")} (use the refs of the search results, e.g. ${state.findings[0]?.ref ?? "W1.2:f1"} or ${state.findings[0]?.gid ?? "F1"})`);
    const missing = state.findings.filter(item => !kept.has(item.ref) && !dropped.has(item.ref)).map(item => `${item.gid}=${item.ref}`);
    // After the budget stop, the forced report may leave explorer findings unaccounted (recorded); a usable result beats a rejected one.
    const budgetStop = !!state.orchestrator.stopped && report.stop.reason === "budget";
    this.unaccounted = budgetStop ? missing.length : 0;
    if (missing.length && !budgetStop) problems.push(`every explorer finding is kept (in a final finding's provenance) or dropped with a reason (data.mdsd.dropped); unaccounted: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` … ${missing.length - 20} more` : ""}`);
    // Verdicts need evidence beyond agreement.
    const calls = new Map(this.options.ledger().calls.filter(call => !BOOKKEEPING_TOOLS.has(call.name)).map(call => [call.ref, call]));
    const verifiers = new Set(state.verifications.flatMap(round => round.workers.filter(worker => worker.status === "passed" || worker.status === "not passed").map(worker => worker.id)));
    const ids = new Set<string>();
    for (const finding of report.findings) {
      if (ids.has(finding.id)) problems.push(`final finding id ${finding.id} is used twice`);
      ids.add(finding.id);
      if (finding.status === "disputed" && !finding.dissent?.trim()) problems.push(`${finding.id} is disputed: name the dissent (who disagrees, on what evidence)`);
      if (finding.status !== "confirmed" && finding.status !== "refuted") continue;
      const backed = finding.evidence.some(item => [...item.matchAll(/\[?orche ref (T\d+)\]?|\b(T\d+)\b/g)].some(match => calls.has(match[1] ?? match[2]!)) || [...verifiers].some(id => new RegExp(`(^|[^\\w.])${id.replace(".", "\\.")}(?![\\w.])`).test(item)));
      if (!backed) problems.push(`${finding.id} is ${finding.status} without evidence of your own checks: cite the [orche ref Tn] of the calls that showed it (or a verifier id); explorers agreeing is not proof — or mark it unverified`);
    }
    if (problems.length) return `MDSD report gate: ${problems.join("; ")}.`;
    this.decision = report.decision;
    this.final = { findings: report.findings, dropped: dropped.size };
    return undefined;
  }

  // ---- reporting ----
  summary(): MdsdSummary {
    const state = this.state;
    const explorers = state.explorers;
    const spent = this.spent();
    const final = this.final;
    const roundOf = new Map(state.findings.map(item => [item.ref, item.round]));
    const byGid = new Map(state.findings.map(item => [item.gid, item.ref]));
    let firstRoundOnly = 0, adaptiveOnly = 0, both = 0, orchestratorOnly = 0, seededKept = 0;
    const byStatus: Record<string, number> = {};
    if (final) for (const finding of final.findings) {
      byStatus[finding.status] = (byStatus[finding.status] ?? 0) + 1;
      const rounds = new Set(finding.provenance.map(ref => roundOf.get(byGid.get(ref.trim()) ?? ref.trim())).filter((value): value is number => value !== undefined));
      // Round 0: registered prior claims (mdsd.seed), counted apart from the search rounds.
      const seeded = rounds.delete(0);
      if (seeded) seededKept++;
      if (!rounds.size) { if (!seeded) orchestratorOnly++; }
      else if ([...rounds].every(value => value === 1)) firstRoundOnly++;
      else if (!rounds.has(1)) adaptiveOnly++;
      else both++;
    }
    return {
      ...(this.decision ? { decision: this.decision } : {}),
      // A replicated strategy counts once (its cells share a group); without replication every explorer is its own strategy.
      rounds: state.rounds.length, maxRounds: this.settings.maxRounds, strategies: new Set(explorers.map(item => item.group ?? item.id)).size, distinctSignatures: new Set(explorers.map(item => item.signature)).size,
      explorers: explorers.map(item => ({ id: item.id, round: item.round, signature: item.signature, ...(item.model ? { model: item.model, group: item.group } : {}), status: item.status, findings: item.findings.length, files: item.files.length, ...(item.newFiles !== undefined ? { newFiles: item.newFiles } : {}), ...(item.uniqueFiles !== undefined ? { uniqueFiles: item.uniqueFiles } : {}), ...(item.scopeTouched !== undefined ? { scopeTouched: `${item.scopeTouched}/${item.strategy.evidence_scope.length}` } : {}), allocated: item.allocated, ...(item.actual ? { actual: item.actual } : {}), ...(item.overshoot.length ? { overshoot: item.overshoot } : {}), ...(item.wrapUp ? { wrapUp: item.wrapUp } : {}), ...(item.stoppedBy ? { stoppedBy: item.stoppedBy } : {}) })),
      ...(this.settings.replication ? { replication: { models: this.settings.replication.models.map(route => route.model), cells: explorers.filter(item => item.group).length, pinned: state.rounds.some(item => item.pinned) } } : {}),
      redundancy: state.rounds.map(item => item.redundancy ?? null),
      findings: { explorers: state.findings.length, ...(final ? { final: final.findings.length, byStatus, dropped: final.dropped, firstRoundOnly, adaptiveOnly, both, orchestratorOnly } : {}), ...(this.settings.seed ? { seeded: this.settings.seed.claims.length, ...(final ? { seededKept } : {}) } : {}) },
      budget: {
        allocatedUSD: round2(state.allocated.costUSD), spentExplorersUSD: round2(spent.explorersUSD), spentVerifiersUSD: round2(spent.verifiersUSD), spentOtherUSD: round2(spent.otherUSD), spentOrchestratorUSD: round2(spent.orchestratorUSD), spentUSD: round2(spent.costUSD),
        totalUSD: this.settings.total.costUSD, searchLimitUSD: round2(this.settings.total.costUSD * (1 - this.settings.reserve)), stageLimitUSD: round2(this.settings.total.costUSD * (1 - this.settings.final)), finalAllowanceUSD: round2(this.settings.total.costUSD * this.settings.final),
        allocatedRequests: state.allocated.requests, spentRequests: spent.requests, totalRequests: this.settings.total.requests,
        inFlightUnknown: explorers.filter(item => item.inFlightUnknown).length + [...state.verifications, ...state.others].flatMap(stage => stage.workers).filter(item => item.inFlightUnknown).length,
        unpricedResponses: state.unpriced,
        ...(state.orchestrator.noticed ? { noticed: state.orchestrator.noticed } : {}),
        ...(state.orchestrator.stopped ? { stopped: state.orchestrator.stopped } : {}),
        ...(spent.costUSD > this.settings.total.costUSD || spent.requests > this.settings.total.requests ? { overTotal: `spent $${round2(spent.costUSD)} / ${spent.requests} requests of $${this.settings.total.costUSD} / ${this.settings.total.requests}: the response that crossed it, report responses after a stop, the forced report` } : {}),
        ...(state.exhausted ? { exhausted: state.exhausted } : {}),
      },
      phases: state.phases.map(item => ({ ...item, costUSD: round2(item.costUSD * 10000) / 10000 })),
      verificationRounds: state.verifications.length,
      ...(this.gateResult ? { gate: this.gateResult } : {}),
    };
  }

  /** The `MDSD:` lines of the task result (in place of the Split line). */
  lines(): string[] {
    const summary = this.summary();
    const findings = summary.findings;
    return [
      `MDSD: ${summary.decision ?? (summary.rounds ? "diversified" : "single path (no search round)")}; ${summary.rounds}/${summary.maxRounds} search round(s), ${summary.strategies} strateg${summary.strategies === 1 ? "y" : "ies"} (${summary.distinctSignatures} distinct signature${summary.distinctSignatures === 1 ? "" : "s"})${summary.replication ? `, each on ${summary.replication.models.length} models: ${summary.replication.cells} explorer cells${summary.replication.pinned ? " (pinned first round)" : ""}` : ""}, redundancy per round ${summary.redundancy.map(value => value ?? "n/a").join(" / ") || "n/a"}; findings ${findings.explorers} proposed${findings.final !== undefined ? ` → ${findings.final} final (${Object.entries(findings.byStatus ?? {}).map(([status, count]) => `${count} ${status}`).join(", ") || "none"}; ${findings.dropped ?? 0} dropped; provenance: first round only ${findings.firstRoundOnly}, adaptive rounds only ${findings.adaptiveOnly}, both ${findings.both}, orchestrator only ${findings.orchestratorOnly})` : ""}; verification ${summary.verificationRounds}/${MAX_VERIFICATION_ROUNDS} round(s); report gate ${summary.gate ?? "not reached"}`,
      `MDSD budget: spent $${summary.budget.spentUSD} of $${summary.budget.totalUSD} (${summary.budget.spentRequests}/${summary.budget.totalRequests} requests): orchestrator $${summary.budget.spentOrchestratorUSD}, explorers $${summary.budget.spentExplorersUSD} (allocated $${summary.budget.allocatedUSD}, ${summary.budget.allocatedRequests} requests), verifiers $${summary.budget.spentVerifiersUSD}${summary.budget.spentOtherUSD ? `, other sub-workers $${summary.budget.spentOtherUSD}` : ""}; final-report allowance $${summary.budget.finalAllowanceUSD}${summary.budget.noticed ? `; notice at ${summary.budget.noticed}` : ""}${summary.budget.stopped ? `; STOPPED at ${summary.budget.stopped}` : ""}${summary.budget.inFlightUnknown || summary.budget.unpricedResponses ? `; usage unknown for ${summary.budget.inFlightUnknown} cancelled worker response(s) and ${summary.budget.unpricedResponses} unpriced orchestrator response(s)` : ""}${summary.budget.overTotal ? `; OVER TOTAL: ${summary.budget.overTotal}` : ""}${summary.budget.exhausted ? `; exhausted: ${summary.budget.exhausted}` : ""}; orchestrator per phase: ${summary.phases.filter(item => item.requests).map(item => `${item.phase} ${item.requests} req $${round2(item.costUSD)}`).join(", ") || "none"}`,
    ];
  }
}

/** The report contract of a search worker; undefined: accepted. */
export function explorerReportError(data: unknown): string | undefined {
  if (Value.Check(explorerDataSchema, data)) {
    const record = data as ExplorerData;
    const ids = record.findings.map(item => item.id);
    const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (twice.length) return `Finding ids must be unique in your report (${[...new Set(twice)].join(", ")} repeated).`;
    return undefined;
  }
  return `Invalid MDSD explorer data: ${formatSchemaErrors(explorerDataSchema as TSchema, data, 6)}. Expected data:{findings:[{id:"f1",claim,location:["path:line"],evidence:[…],counter_evidence:[…],uncertainty:"low"|"medium"|"high"}],evidence:[…],counter_evidence:[…],uncertainty:"…",explored_scope:[…],unexplored_scope:[…],sources_used:[…],procedures:[…]} (findings may be [] when you found nothing; say what you examined in explored_scope).`;
}

/** Duplicates, conflict candidates, gaps and uncertain findings of the whole run (lexical heuristics; see the module comment). */
function aggregate(state: MdsdState): Aggregation {
  const findings = state.findings;
  const parent = findings.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const why = new Map<string, string>();
  const tokens = findings.map(item => tokensOf(item.finding.claim));
  for (let i = 0; i < findings.length; i++) for (let j = i + 1; j < findings.length; j++) {
    const a = findings[i]!, b = findings[j]!;
    if (a.worker === b.worker) continue;
    const near = a.locations.find(x => b.locations.some(y => y.file === x.file || y.file.endsWith(`/${x.file}`) || x.file.endsWith(`/${y.file}`) ? Math.abs(x.start - y.start) <= 15 || (x.start <= y.end && y.start <= x.end) : false));
    const similar = jaccard(tokens[i]!, tokens[j]!);
    if (near || similar >= DUPLICATE_OVERLAP) {
      const root = find(i), other = find(j);
      if (root !== other) parent[other] = root;
      why.set(`${i}-${j}`, near ? `near ${near.file}:${near.start}` : `claim overlap ${round2(similar)}`);
    }
  }
  const groups = new Map<number, number[]>();
  findings.forEach((_, index) => { const root = find(index); groups.set(root, [...(groups.get(root) ?? []), index]); });
  const duplicates: Aggregation["duplicates"] = [];
  const conflicts: Aggregation["conflicts"] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const reasons = [...why.entries()].filter(([key]) => { const [x, y] = key.split("-").map(Number); return members.includes(x!) && members.includes(y!); }).map(([, value]) => value);
    const id = `D${duplicates.length + 1}`;
    duplicates.push({ id, members: members.map(index => findings[index]!.gid), why: [...new Set(reasons)].slice(0, 3).join(", ") });
    const levels = new Set(members.map(index => findings[index]!.finding.uncertainty));
    const countered = members.filter(index => findings[index]!.finding.counter_evidence.length);
    if (levels.has("low") && levels.has("high")) conflicts.push({ id: `C${conflicts.length + 1}`, members: members.map(index => findings[index]!.gid), why: `${id}: uncertainty low vs high` });
    else if (countered.length) conflicts.push({ id: `C${conflicts.length + 1}`, members: members.map(index => findings[index]!.gid), why: `${id}: counter-evidence reported by ${countered.map(index => findings[index]!.ref).join(", ")}` });
  }
  const gaps: Aggregation["gaps"] = [];
  for (const explorer of state.explorers) for (const text of explorer.unexploredScope) {
    const item = tokensOf(text);
    const coveredBy = state.explorers.filter(other => other.id !== explorer.id && (other.exploredScope.some(scope => jaccard(tokensOf(scope), item) >= 0.5) || locationsOf([text]).some(loc => other.files.includes(loc.file)))).map(other => other.id);
    gaps.push({ id: `G${gaps.length + 1}`, worker: explorer.id, text, coveredBy });
  }
  const uncertain = findings.filter(item => item.finding.uncertainty === "high").map(item => item.gid);
  return { duplicates, conflicts, gaps, uncertain };
}

/** The brief every explorer gets in front of its request: its strategy spec, the plan's objective and constraints verbatim. */
export function explorerBrief(plan: MdsdPlan, strategy: MdsdStrategy, allocated: MdsdBudget, round: number, hardStopAt: number = DEFAULT_MDSD.hardStopAt): string {
  const list = (values: readonly string[]) => values.map(value => `\n    - ${JSON.stringify(value)}`).join("");
  return [
    `MDSD search path (round ${round}): you are one of several independent explorers of the SAME objective; each follows a different strategy on purpose. You cannot see the others and must not guess their conclusions. Follow YOUR strategy below: how you search (operators, direction, reasoning, validation) and what you search (hypotheses, information sources) are the point; do not drift to another objective.`,
    "strategy:",
    `  objective: ${JSON.stringify(plan.objective)}   # common to every path; do not change it`,
    `  framing: ${JSON.stringify(strategy.framing)}`,
    `  operators: [${strategy.operators.join(", ")}]`,
    ...strategy.operators.map(operator => `    # ${operator}: ${OPERATOR_QUESTIONS[operator]}`),
    `  hypothesis_space:${list(strategy.hypothesis_space)}`,
    `  evidence_scope:${list(strategy.evidence_scope)}`,
    `  method:${list(strategy.method)}`,
    `  reasoning: [${strategy.reasoning.join(", ")}]`,
    `  direction: ${strategy.direction}`,
    `  validation: [${strategy.validation.join(", ")}]`,
    ...(strategy.purpose ? [`  purpose: ${strategy.purpose}${strategy.targets?.length ? ` (targets ${strategy.targets.join(", ")} of the earlier rounds' aggregation)` : ""}`] : []),
    `  constraints:${list(plan.constraints)}   # mandatory`,
    `  success:${list(plan.success)}`,
    `  budget: at most ${allocated.requests} model responses, about ${allocated.minutes} minutes, about $${allocated.costUSD} (list price), ${allocated.outputTokens} output tokens. Near the limit you get a wrap-up notice: then report at once; past ${Math.round(hardStopAt * 100)}% of a limit your session is stopped and its findings are lost.`,
    "  output: [findings, evidence, counter_evidence, uncertainty, explored_scope, unexplored_scope, sources_used, procedures]",
    'Report: report_result {kind:"answer", summary, data:{findings:[{id:"f1",claim,location:["path:line"],evidence:[what you saw: file:line, command and outcome],counter_evidence:[what speaks against it],uncertainty:"low"|"medium"|"high"}], evidence:[…], counter_evidence:[…], uncertainty:"what remains uncertain overall", explored_scope:[what you examined and how], unexplored_scope:[what you did NOT get to or could not check], sources_used:[files, commands, documents you actually used], procedures:[the steps you actually ran]}}. Your findings are proposals: the orchestrator validates them. Mark what you could not verify; never present a guess as a checked fact; keep unexplored_scope honest — it decides what is searched next.',
  ].join("\n");
}

/** The MDSD part of an implement/answer orchestrator's prompt (prompt-based guidance next to the enforced contract above). */
export function mdsdSection(readOnly: boolean, maxSubWorkers: number = MAX_SUB_WORKERS, settings: MdsdSettings = DEFAULT_MDSD): string {
  return [
    `MDSD search policy (multi-dimensional search diversification; the runtime enforces the strategy specs, the plan, the budget and the report gate). You are the strategy planner, the evidence integrator, the adaptive selector and the final judge: explorers search, you validate.${readOnly ? " This task is read-only: explorers and verifiers are read-only too." : " Explorers only search (read-only); you implement and check after the judgment (yourself, or with reason \"parallelism\" writers)."}`,
    "0. Decide first whether diversification pays. When the path to the answer is clear and checking it is simple, work as a single path yourself (no search round) and report data.mdsd.decision \"single-path\" with why. Diversify only when the search space is wide, uncertainty is high and independent approaches can find different things. Design objective (guidance, not a formula the runtime computes): maximise Utility − λ·Redundancy − μ·Cost; do not add strategies just because they are different.",
    `1. Plan: the first orche_spawn reason "search" carries plan {objective: the user's goal unchanged, constraints: the mandatory constraints verbatim, success: success criteria, rationale: why diversifying is worth its cost here}. The runtime copies objective and constraints into every explorer's brief and keeps them fixed for the run: reinterpreting the problem is allowed, changing the goal is task drift.`,
    `2. Strategies (2-${maxSubWorkers} explorers in the first round, role answer, each with strategy {framing, operators, hypothesis_space, evidence_scope, method, reasoning, direction, validation, budget?}). Vary HOW and WHERE they search along the six dimensions only where this problem needs it: ① framing (problem interpretation, abstraction level), ② hypothesis_space, ③ evidence_scope (information sources, data, observation range), ④ method + reasoning (deduction, induction, abduction, backtracking, comparison, experiment), ⑤ direction (bottom-up, top-down, backward, cross-cutting), ⑥ validation (falsification, reproduction, comparison, constraint-check). Operators (1-3 per strategy, combinable): EXPAND (what has not been considered?), DECOMPOSE (which part contributes?), INVERT (what must precede this result or goal?), TRANSFER (how do other domains solve it?), CHALLENGE (what evidence would show the leading explanation wrong?), VALIDATE (how to tell true from false by measurement, execution, experiment?). Pick the operators that fit (e.g. TRANSFER rarely helps a clear cause analysis; EXPAND and TRANSFER matter for new ideas); never run all of them by default or a fixed number of workers. Names and wording are not diversity: two strategies with the same operators, direction, reasoning and validation must differ in hypothesis space or evidence scope, or the call is refused. Each request is self-contained (the task, references) but never contains another path's conclusions.`,
    "3. Integration (yours, after each round): the result lists every finding (F…, with the explorer ref W….:f…), likely duplicates (D…), conflict candidates (C…), gaps from unexplored scope (G…) and high-uncertainty findings, plus the measured redundancy (overlap of the files explorers actually read) and the files new to the run per explorer. The lists are heuristics: merge real duplicates, resolve conflicts with evidence, and decide what remains uncertain or unexplored.",
    `4. Adaptive selection: only when another round is worth its cost, call reason "search" again with adapt {basis: the F/D/C/G ids that justify it, reason}. Each strategy states purpose "exploit" (targets: those ids) or "explore" (hypotheses or information sources no earlier strategy had); a round of 2+ strategies keeps at least one explore strategy, so an early explanation is not just amplified. Stop when the evidence suffices, progress stalls, or the round cap or budget is reached (stop.reason).`,
    "5. Verification and final judgment (separate from search): check every finding you keep yourself (read, grep, bash; cite the [orche ref Tn] of those calls) or with fresh verifiers (reason \"verification\", then cite the verifier's id). Explorers agreeing is not proof; a finding you could not check stays \"unverified\". Keep dissent: a finding with credible counter-evidence is \"disputed\" with its dissent. Account for every explorer finding: kept in a final finding's provenance, or in data.mdsd.dropped with the reason (duplicate of …, refuted by …, out of scope).",
    `Report data.mdsd: ${REPORT_FORMAT}${readOnly ? "" : " (next to status, checklist and the other implement fields)"}. Caps: ${settings.maxRounds} search rounds; per strategy by default ${settings.explorer.requests} requests, ${settings.explorer.minutes} min, $${settings.explorer.costUSD}, ${settings.explorer.outputTokens} output tokens (strategy.budget may set its own up to ${settings.explorerMax.requests} requests, ${settings.explorerMax.minutes} min, $${settings.explorerMax.costUSD}); the whole run (your own responses, every explorer and verifier) $${settings.total.costUSD} and ${settings.total.requests} requests, of which search rounds may allocate up to ${Math.round((1 - settings.reserve) * 100)}% (the rest is kept for integration, verification and synthesis) and other stages up to ${Math.round((1 - settings.final) * 100)}%; every orche_spawn is admitted only if its worst case fits; at ${Math.round((1 - settings.final) * 100)}% you are told to report (no further stage), at 100% your turn is stopped and you get one forced report prompt (report data.mdsd.stop.reason "budget"); verification ${MAX_VERIFICATION_ROUNDS} rounds; ${maxSubWorkers} workers per orche_spawn call; sub-workers cannot spawn. If the work cannot be completed, report ${readOnly ? "data.unresolved" : "status \"blocked\" with data.reason"} and data.mdsd.stop.reason "blocked" with what was found so far.`,
    ...replicationSection(settings),
    ...seedSection(settings),
  ].join("\n");
}

/** The orchestrator's part of mdsd.replication (an experiment setting): what runs, how to read the cells, the pinned round. */
function replicationSection(settings: MdsdSettings): string[] {
  const replication = settings.replication;
  if (!replication) return [];
  const models = replication.models.map(route => `${route.model}${route.thinking ? ` (thinking ${route.thinking})` : ""}`).join(", ");
  const pin = replication.round;
  return [
    `Replication experiment (mdsd.replication, set for this run): every search strategy runs once per model — ${models} — as separate explorers with the same brief, request and allocation (ids: the strategies in order on the first model, then again on each further model). The cells of one strategy are the same search path on different models, not distinct paths: integrate them like any explorers (merge duplicates, keep dissent) and treat their agreement as replication, not independent proof.${pin ? ` The first search round is pinned by the experiment: call orche_spawn once with reason "search" and the workers ${pin.workers.map(worker => JSON.stringify(worker.name)).join(", ")} in this order, each role "answer" with request "pinned" (no plan or strategy needed): the runtime runs the pinned plan, requests and strategies below unchanged. Do not design other strategies for that round. Then integrate, verify and report as usual; data.mdsd.objective is the pinned plan's objective. Pinned round: ${JSON.stringify({ plan: pin.plan, workers: pin.workers })}` : ""}`,
  ];
}

/** The orchestrator's part of mdsd.seed (an experiment setting): the registered prior claims and how the run treats them. */
function seedSection(settings: MdsdSettings): string[] {
  const seed = settings.seed;
  if (!seed) return [];
  const sources = [...new Set(seed.claims.map(claim => claim.ref.split(":")[0]))].join(", ");
  const list = seed.claims.map((claim, index) => `F${index + 1} = ${claim.ref}${claim.stance && claim.stance !== "asserted" ? ` [${claim.stance} in its source]` : ""}: ${claim.claim}${claim.locations?.length ? ` (${claim.locations.join("; ")})` : ""}`).join("\n");
  return [
    `Registered prior claims (mdsd.seed, set for this run): ${seed.claims.length} claims from earlier independent analyses (sources ${sources}) are in the runtime's aggregation as round-0 findings F1-F${seed.claims.length} under their refs. They are claims, not evidence: none is verified, and agreement between sources is not proof. Account for every one like an explorer finding: keep it in a final finding's provenance (confirmed or refuted only with your own checks or a verifier's), correct it in a final finding with the evidence that corrects it, keep it unverified or disputed when it stays open, or put it in data.mdsd.dropped with the evidenced reason. The first search round is the follow-up: orche_spawn reason "search" with the plan and adapt {basis: the F/D/C ids or refs of the claims and gaps it follows up, reason}; each strategy states purpose "exploit" (targets: those ids) or "explore" (requirements and scope no claim covers). The report gate refuses a seeded run without a search round.`,
    `Registered claims:\n${list}`,
  ];
}
