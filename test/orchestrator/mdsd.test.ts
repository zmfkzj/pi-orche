import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MDSD, parseMdsdConfig, type MdsdSettings } from "../../src/orchestrator/mdsd-config.js";
import { ensureScratchDir } from "../../src/orchestration/scratch.js";
import { DIVERSITY_OVERLAP, explorerBrief, explorerReportError, footprintOf, jaccard, MDSD_OPERATORS, MdsdRun, mdsdSection, signatureOf, tokensOf, type MdsdStrategy } from "../../src/orchestrator/mdsd.js";
import type { PlannedWorker, SubWorkerOutcome } from "../../src/orchestrator/spawn.js";
import type { EvidenceLedger, ToolRecord } from "../../src/pi/tool-evidence.js";

/**
 * The MDSD search policy (src/orchestrator/mdsd.ts) on its own: deterministic, no model. What the runtime enforces (plan and
 * strategy specs, no label-only diversity, adaptive rounds acting on results with an exploration reserve, all-stage budget,
 * measured footprints and redundancy, persisted round data, the report gate) and what it only offers as heuristics.
 * The examples are deliberately not bug hunts: technology choice, product ideation and a research survey.
 */
const temp: string[] = [];
afterEach(async () => { for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true }); });

// ---- fixtures -------------------------------------------------------------------------------------------------------------
const techPlan = {
  objective: "Choose the message broker for the order-events pipeline that meets the requirements in docs/requirements.md.",
  constraints: ["Keep per-order ordering of events.", "Self-hosted only; no managed cloud service.", "Do not change production configuration."],
  success: ["A recommendation with the conditions under which it would change.", "Each rejected candidate has a stated failure condition."],
  rationale: "Three plausible candidates, conflicting vendor claims and real failure modes: independent paths can find different disqualifiers.",
};
const invertRequirements: MdsdStrategy = {
  framing: "Work backward from the hard requirements to the capabilities a broker must have.",
  operators: ["INVERT"], hypothesis_space: ["per-key ordering needs partitioned logs", "exactly-once delivery is not required"],
  evidence_scope: ["docs/requirements.md", "docs/architecture/events.md"], method: ["list each requirement", "derive the capability it implies"],
  reasoning: ["deduction"], direction: "backward", validation: ["constraint-check"],
};
const challengeFavourite: MdsdStrategy = {
  framing: "Assume the team's favourite (Kafka) is wrong for this load and look for the evidence that would show it.",
  operators: ["CHALLENGE", "VALIDATE"], hypothesis_space: ["operational cost of ZooKeeper-less clusters at small scale", "rebalancing storms break latency targets"],
  evidence_scope: ["postmortems and incident reports of small Kafka deployments", "benchmarks/broker-latency.csv"], method: ["collect failure conditions", "check each against our load profile"],
  reasoning: ["abduction", "comparison"], direction: "cross-cutting", validation: ["falsification"],
};
const ideationPlan = {
  objective: "Find new product ideas for the habit-tracking app that raise week-4 retention.",
  constraints: ["Use only the anonymised analytics export.", "No dark patterns."],
  success: ["Ideas with the user need they address and how to test them cheaply."],
  rationale: "Open-ended ideation where analogies and unexplored needs matter.",
};
const expandNeeds: MdsdStrategy = {
  framing: "Which user needs has the product never addressed?", operators: ["EXPAND"],
  hypothesis_space: ["social accountability", "habit stacking around existing routines"], evidence_scope: ["support tickets 2025", "app-store reviews"],
  method: ["cluster complaints by unmet need"], reasoning: ["induction"], direction: "bottom-up", validation: ["comparison"],
};
const transferDomains: MdsdStrategy = {
  framing: "How do fitness and language-learning products keep users past week 4?", operators: ["TRANSFER", "EXPAND"],
  hypothesis_space: ["streak repair mechanics", "cohort challenges"], evidence_scope: ["published case studies of Duolingo and Strava", "behavioural science literature on implementation intentions"],
  method: ["extract the mechanism of each case", "map it to our product"], reasoning: ["comparison", "abduction"], direction: "top-down", validation: ["comparison"],
};
const researchDecompose: MdsdStrategy = {
  framing: "Decompose the claim 'retrieval augmentation reduces hallucination' into retrieval, grounding and evaluation stages.",
  operators: ["DECOMPOSE", "VALIDATE"], hypothesis_space: ["gains come from the evaluation protocol, not the model"], evidence_scope: ["papers 2023-2026 with released evaluation code"],
  method: ["rerun the released evaluation scripts on one benchmark"], reasoning: ["experiment"], direction: "bottom-up", validation: ["reproduction"],
};
const researchInvert: MdsdStrategy = {
  framing: "What mechanism must hold if the reported gains are real?", operators: ["INVERT", "CHALLENGE"],
  hypothesis_space: ["retrieved passages must be cited by the answer", "gains vanish on out-of-distribution questions"], evidence_scope: ["ablation sections of the surveyed papers", "replication reports"],
  method: ["state the required mechanism", "look for ablations that contradict it"], reasoning: ["backtracking", "deduction"], direction: "backward", validation: ["falsification"],
};

function ledger(calls: Partial<ToolRecord>[] = []): () => EvidenceLedger {
  const records = calls.map((call, index) => ({ ref: `T${index + 1}`, toolCallId: `c${index}`, name: "bash", isError: false, request: 1, atBaseline: true, timestamp: 0, ...call })) as ToolRecord[];
  return () => ({ calls: records, checks: records.length, bookkeeping: 0, tag: true });
}
function run(options: { settings?: MdsdSettings; readOnly?: boolean; calls?: Partial<ToolRecord>[]; scratch?: string; cwd?: string; maxSubWorkers?: number } = {}) {
  const events: Record<string, unknown>[] = [];
  let clock = 1_000_000;
  const mdsd = new MdsdRun({ orchestrator: "W1", cwd: options.cwd ?? "/repo", readOnly: options.readOnly ?? true, ...(options.settings ? { settings: options.settings } : {}), ledger: ledger(options.calls), ...(options.scratch ? { scratch: options.scratch } : {}), ...(options.maxSubWorkers ? { maxSubWorkers: options.maxSubWorkers } : {}), onEvent: event => events.push(event), now: () => (clock += 1000) });
  return { mdsd, events };
}
let serial = 0;
const explorer = (name: string, strategy: MdsdStrategy, role = "answer"): PlannedWorker => ({ id: `W1.${++serial}`, name, role: role as PlannedWorker["role"], request: `Investigate: ${name}`, reason: "search", strategy });
const answerOf = (findings: { id: string; claim: string; location?: string[]; evidence?: string[]; counter_evidence?: string[]; uncertainty?: "low" | "medium" | "high" }[], extra: Record<string, unknown> = {}) => ({
  findings: findings.map(item => ({ evidence: ["seen in the source"], counter_evidence: [], uncertainty: "medium" as const, ...item })),
  evidence: ["read the documents"], counter_evidence: [], uncertainty: "moderate", explored_scope: ["the declared sources"], unexplored_scope: [],
  sources_used: ["docs/requirements.md"], procedures: ["read", "compare"], ...extra,
});
function outcome(worker: PlannedWorker, fields: Partial<SubWorkerOutcome> = {}): SubWorkerOutcome {
  return { id: worker.id, name: worker.name, role: worker.role, reason: worker.reason, status: "done", summary: "done", model: "p/m", modelSource: "orchestrator", requests: 10, models: { "p/m": 10 }, startedAt: 0, durationMs: 60_000, costUSD: 1, changes: [], usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 }, ...fields } as SubWorkerOutcome;
}
const signal = new AbortController().signal;

// ---- tests ----------------------------------------------------------------------------------------------------------------
describe("mdsd config", () => {
  it("defaults, partial overrides and refusals (unknown keys, out-of-range values, a default above the per-strategy maximum)", () => {
    expect(parseMdsdConfig({})).toEqual(DEFAULT_MDSD);
    expect(parseMdsdConfig({ maxRounds: 2, explorer: { costUSD: 3 }, total: { costUSD: 30 }, reserve: 0 })).toMatchObject({ maxRounds: 2, explorer: { ...DEFAULT_MDSD.explorer, costUSD: 3 }, total: { costUSD: 30, requests: DEFAULT_MDSD.total.requests }, reserve: 0 });
    expect(() => parseMdsdConfig({ workers: 5 })).toThrow("config.mdsd: unknown field workers");
    expect(() => parseMdsdConfig({ maxRounds: 7 })).toThrow("at most 6 search rounds");
    expect(() => parseMdsdConfig({ explorer: { max_tokens: 20000 } })).toThrow("config.mdsd.explorer: unknown field max_tokens");
    expect(() => parseMdsdConfig({ explorer: { requests: 500 } })).toThrow("config.mdsd.explorer.requests (500) exceeds config.mdsd.explorerMax.requests (120)");
    expect(() => parseMdsdConfig({ reserve: 1 })).toThrow("config.mdsd.reserve");
    expect(() => parseMdsdConfig({ wrapUpAt: 1 })).toThrow("config.mdsd.wrapUpAt");
    expect(() => parseMdsdConfig({ hardStopAt: 0.9 })).toThrow("config.mdsd.hardStopAt");
    expect(() => parseMdsdConfig([])).toThrow("config.mdsd: expected object");
  });
});

describe("mdsd: plan and strategies (first round)", () => {
  it("non-bug tasks: a technology choice, product ideation and a research survey are valid diversified rounds with different operators", async () => {
    for (const [plan, a, b] of [[techPlan, invertRequirements, challengeFavourite], [ideationPlan, expandNeeds, transferDomains], [{ ...techPlan, objective: "Assess whether retrieval augmentation reduces hallucination." }, researchDecompose, researchInvert]] as const) {
      const { mdsd } = run();
      const workers = [explorer("a", a), explorer("b", b)];
      const prepared = await mdsd.prepare("search", workers, signal, { reason: "search", workers, plan });
      expect(prepared.map(worker => worker.brief?.split("\n")[0])).toEqual([expect.stringContaining("MDSD search path (round 1)"), expect.stringContaining("MDSD search path (round 1)")]);
      expect(mdsd.state.plan).toEqual(plan);
    }
  });

  it("the objective and mandatory constraints reach every explorer verbatim, with its own operators, budget and output contract", async () => {
    const { mdsd } = run();
    const workers = [explorer("invert", invertRequirements), explorer("challenge", { ...challengeFavourite, budget: { costUSD: 100, requests: 5 } })];
    const [first, second] = await mdsd.prepare("search", workers, signal, { reason: "search", workers, plan: techPlan });
    for (const worker of [first!, second!]) {
      expect(worker.brief).toContain(`objective: ${JSON.stringify(techPlan.objective)}`);
      for (const constraint of techPlan.constraints) expect(worker.brief).toContain(JSON.stringify(constraint));
      expect(worker.brief).toContain("output: [findings, evidence, counter_evidence, uncertainty, explored_scope, unexplored_scope, sources_used, procedures]");
      expect(worker.check?.({})).toMatch(/^Invalid MDSD explorer data/);
    }
    expect(first!.brief).toContain("operators: [INVERT]");
    expect(first!.brief).toContain("# INVERT: trace back from the result");
    expect(second!.brief).toContain("# CHALLENGE: attack the current assumptions");
    // A strategy's own budget is clamped to explorerMax ($25); requests below the default stay.
    expect(second!.budget).toEqual({ requests: 5, minutes: 25, costUSD: 25, outputTokens: 120_000, wrapUpAt: 0.8, hardStopAt: 1.25 });
    expect(first!.budget).toEqual({ ...DEFAULT_MDSD.explorer, wrapUpAt: 0.8, hardStopAt: 1.25 });
  });

  it("refuses what is not a diversified search: one path, no plan, a writer, a missing or invalid strategy", () => {
    const { mdsd } = run();
    const one = [explorer("a", invertRequirements)];
    expect(() => mdsd.validate("search", one, { reason: "search", workers: one, plan: techPlan })).toThrow(/two or more strategies.*single-path/);
    const two = [explorer("a", invertRequirements), explorer("b", challengeFavourite)];
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two })).toThrow("the first search call needs plan");
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two, plan: { objective: "x" } })).toThrow("Invalid plan");
    const writer = [explorer("a", invertRequirements, "implement"), explorer("b", challengeFavourite)];
    expect(() => mdsd.validate("search", writer, { reason: "search", workers: writer, plan: techPlan })).toThrow("read-only explorers only");
    const bare = [{ ...explorer("a", invertRequirements), strategy: undefined }, explorer("b", challengeFavourite)];
    expect(() => mdsd.validate("search", bare, { reason: "search", workers: bare, plan: techPlan })).toThrow("needs a strategy spec");
    const invalid = [explorer("a", { ...invertRequirements, operators: ["GUESS" as never] }), explorer("b", challengeFavourite)];
    expect(() => mdsd.validate("search", invalid, { reason: "search", workers: invalid, plan: techPlan })).toThrow("invalid strategy");
    expect(() => mdsd.validate("verification", [{ role: "verify", name: "v", strategy: invertRequirements }])).toThrow('strategy belongs to reason "search"');
    expect(() => mdsd.validate("parallelism", [{ role: "implement", name: "w" }], { reason: "parallelism", workers: [], plan: techPlan })).toThrow('plan and adapt belong to reason "search"');
  });

  it("label-only diversity is refused: other names, framing and word order with the same procedure and the same hypotheses and sources", () => {
    const { mdsd } = run();
    const relabelled: MdsdStrategy = { ...invertRequirements, framing: "As the requirements analyst, reason from the needs.", hypothesis_space: ["exactly-once delivery is not required", "per-key ordering needs partitioned logs"], evidence_scope: ["docs/architecture/events.md", "docs/requirements.md"] };
    const workers = [explorer("analyst", invertRequirements), explorer("architect", relabelled)];
    expect(signatureOf(invertRequirements)).toBe(signatureOf(relabelled));
    expect(() => mdsd.validate("search", workers, { reason: "search", workers, plan: techPlan })).toThrow(/are one search path.*Different names or wording are not diversification/);
    // The same procedure on other information sources is a different path (dimension ③); so is another procedure on the same sources.
    const otherSources = [explorer("a", invertRequirements), explorer("b", { ...invertRequirements, evidence_scope: ["vendor documentation of RabbitMQ streams", "NATS JetStream design notes"] })];
    expect(() => mdsd.validate("search", otherSources, { reason: "search", workers: otherSources, plan: techPlan })).not.toThrow();
    const otherProcedure = [explorer("a", invertRequirements), explorer("b", { ...invertRequirements, operators: ["DECOMPOSE"], direction: "bottom-up" })];
    expect(() => mdsd.validate("search", otherProcedure, { reason: "search", workers: otherProcedure, plan: techPlan })).not.toThrow();
    expect(DIVERSITY_OVERLAP).toBe(0.5);
  });
});

describe("mdsd: measurement, aggregation and persisted round data", () => {
  async function firstRound(options: Parameters<typeof run>[0] = {}) {
    const ctx = run(options);
    const a = explorer("invert", { ...invertRequirements, evidence_scope: ["src/a.ts and src/b.ts", "the CHANGELOG"] });
    const b = explorer("challenge", challengeFavourite);
    const c = explorer("transfer", { ...transferDomains, framing: "How do payment systems order events?" });
    const workers = [a, b, c];
    await ctx.mdsd.prepare("search", workers, signal, { reason: "search", workers, plan: techPlan });
    // What the explorers actually did (session events, as workers.ts feeds them).
    const tool = (id: string, toolName: string, args: Record<string, unknown>) => ctx.mdsd.observe(id, { type: "tool_execution_start", toolName, args });
    tool(a.id, "read", { path: "src/a.ts", offset: 10, limit: 20 });
    tool(a.id, "grep", { pattern: "ordering", path: "src" });
    tool(a.id, "bash", { command: "cat src/b.ts | head -5" });
    tool(a.id, "task_plan", { nodes: [] });
    tool(b.id, "read", { path: "/repo/src/a.ts" });
    tool(b.id, "read", { path: "docs/x.md" });
    tool(c.id, "read", { path: "/elsewhere/notes.md" });
    ctx.mdsd.observe(c.id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Partial: payment systems use per-account sequencing; not checked yet." }] } });
    const lines = await ctx.mdsd.finish("search", workers, [
      outcome(a, { requests: 50, costUSD: 7.5, durationMs: 30 * 60_000, usage: { input: 1, output: 130_000, cacheRead: 0, cacheWrite: 0 }, budget: { wrapUp: "33/40 requests", stoppedBy: "requests at 50/40 requests (1.25x the allocation)" }, data: answerOf([
        { id: "f1", claim: "Kafka keeps per-key ordering only within a partition; the order router at src/a.ts:12 hashes by customer, not by order.", location: ["src/a.ts:12"], uncertainty: "low" },
        { id: "f2", claim: "Retention settings are undocumented.", uncertainty: "high" },
      ], { unexplored_scope: ["load profile in benchmarks/broker-latency.csv", "the consumer group settings in deploy/kafka.yaml"] }) }),
      outcome(b, { data: answerOf([{ id: "f1", claim: "Ordering breaks: src/a.ts:14 routes by customer id, so two orders of one customer interleave.", location: ["src/a.ts:14"], counter_evidence: ["the docs say customers never have concurrent orders"] }], { explored_scope: ["load profile in benchmarks/broker-latency.csv"] }) }),
      outcome(c, { status: "failed", error: "budget: time at 31.3/25 min (1.25x the allocation)", data: undefined }),
    ]);
    return { ...ctx, a, b, c, lines };
  }

  it("footprints come from the tool calls (not from self-reports): files, ranges, searches, commands; redundancy, new and unique files, declared scope touched", async () => {
    const { mdsd, a, b, c } = await firstRound();
    const [ea, eb, ec] = mdsd.state.explorers;
    expect(ea).toMatchObject({ id: a.id, files: ["src/a.ts", "src/b.ts"], reads: ["src/a.ts@10+20"], searches: ["dir:src", "search:grep ordering @ src"], commands: ["cat src/b.ts | head -5"], toolCalls: 4, newFiles: 2, uniqueFiles: 1, scopeTouched: 1 });
    expect(eb).toMatchObject({ id: b.id, files: ["docs/x.md", "src/a.ts"], newFiles: 2, uniqueFiles: 1 });
    expect(ec).toMatchObject({ id: c.id, status: "failed", files: ["/elsewhere/notes.md"], partial: "Partial: payment systems use per-account sequencing; not checked yet." });
    // Redundancy: the mean pairwise Jaccard overlap of the files the finished explorers read (src/a.ts shared of three files).
    expect(mdsd.state.rounds[0]).toMatchObject({ redundancy: 0.33, pairs: [{ a: a.id, b: b.id, files: 0.33 }] });
    // Allocated vs actual, overshoot and the budget stop are recorded.
    expect(ea!.actual).toMatchObject({ requests: 50, costUSD: 7.5, outputTokens: 130_000 });
    expect(ea!.overshoot).toEqual(["requests 50/40", "cost $7.5/$6", "time 30/25 min", "output tokens 130000/120000"]);
    expect(ea).toMatchObject({ wrapUp: "33/40 requests", stoppedBy: "requests at 50/40 requests (1.25x the allocation)" });
  });

  it("aggregation offers heuristic duplicates, conflicts and gaps with ids; adaptive rounds can only cite those ids", async () => {
    const { mdsd, lines } = await firstRound();
    const { duplicates, conflicts, gaps, uncertain } = mdsd.state.aggregation;
    const [first, second] = mdsd.state.explorers.map(item => item.id);
    expect(mdsd.state.findings.map(item => [item.gid, item.ref])).toEqual([["F1", `${first}:f1`], ["F2", `${first}:f2`], ["F3", `${second}:f1`]]);
    expect(duplicates).toEqual([{ id: "D1", members: ["F1", "F3"], why: "near src/a.ts:12" }]);
    expect(conflicts).toEqual([{ id: "C1", members: ["F1", "F3"], why: `D1: counter-evidence reported by ${mdsd.state.explorers[1]!.id}:f1` }]);
    expect(gaps.map(gap => [gap.id, gap.coveredBy.length])).toEqual([["G1", 1], ["G2", 0]]);
    expect(uncertain).toEqual(["F2"]);
    const text = lines.join("\n");
    expect(text).toContain("redundancy (mean pairwise overlap of files read) 0.33");
    expect(text).toContain("Likely duplicates (heuristic");
    expect(text).toContain("OVER: requests 50/40");
    expect(text).toContain("partial text kept in the round data (no valid report)");
  });

  it("a report outside the output contract registers nothing and is kept visibly as partial text", async () => {
    const { mdsd } = run();
    const a = explorer("a", expandNeeds), b = explorer("b", transferDomains);
    await mdsd.prepare("search", [a, b], signal, { reason: "search", workers: [a, b], plan: ideationPlan });
    const lines = await mdsd.finish("search", [a, b], [outcome(a, { summary: "three ideas", data: { ideas: ["streak repair"] } }), outcome(b, { data: answerOf([]) })]);
    expect(mdsd.state.explorers[0]).toMatchObject({ findings: [], error: "its report did not match the MDSD output contract; nothing registered", partial: 'three ideas {"ideas":["streak repair"]}' });
    expect(lines.join("\n")).toContain("its report did not match the MDSD output contract");
  });

  it("the complete round data is written to the scratch directory (nothing clipped); the spawn result stays under the 12,000-character spill", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "mdsd-")); temp.push(scratch);
    const ctx = run({ scratch });
    const long = "x".repeat(1100);
    const a = explorer("a", expandNeeds), b = explorer("b", transferDomains);
    await ctx.mdsd.prepare("search", [a, b], signal, { reason: "search", workers: [a, b], plan: ideationPlan });
    const many = (prefix: string) => Array.from({ length: 30 }, (_, index) => ({ id: `f${index + 1}`, claim: `${prefix} idea ${index}: ${long}${long}`, evidence: [`ticket ${index}: ${long}`] }));
    const lines = await ctx.mdsd.finish("search", [a, b], [outcome(a, { data: answerOf(many("needs")) }), outcome(b, { data: answerOf(many("transfer")) })]);
    expect(lines.join("\n").length).toBeLessThan(12_000);
    expect(lines.join("\n")).toMatch(/… \d+ more finding\(s\) in .*mdsd-W1-round-1\.md/);
    const md = await readFile(join(scratch, "mdsd-W1-round-1.md"), "utf8");
    const json = JSON.parse(await readFile(join(scratch, "mdsd-W1-round-1.json"), "utf8")) as { findings: { finding: { claim: string; evidence: string[] } }[] };
    expect(json.findings).toHaveLength(60);
    expect(json.findings[59]!.finding.claim).toBe(`transfer idea 29: ${long}${long}`);
    expect(md).toContain(`ticket 29: ${long}`);
    // The event names both files; its sha256 is of the JSON bytes as written (the record the explorers' outputs are frozen in).
    const bytes = await readFile(join(scratch, "mdsd-W1-round-1.json"));
    expect(ctx.events.find(event => event.stage === "search-end")).toMatchObject({ file: join(scratch, "mdsd-W1-round-1.md"), json: join(scratch, "mdsd-W1-round-1.json"), sha256: createHash("sha256").update(bytes).digest("hex") });
  });
});

describe("mdsd: adaptive rounds", () => {
  async function afterFirst(settings?: MdsdSettings) {
    const ctx = run(settings ? { settings } : {});
    const a = explorer("invert", invertRequirements), b = explorer("challenge", challengeFavourite);
    await ctx.mdsd.prepare("search", [a, b], signal, { reason: "search", workers: [a, b], plan: techPlan });
    await ctx.mdsd.finish("search", [a, b], [
      outcome(a, { data: answerOf([{ id: "f1", claim: "Ordering is per partition only.", uncertainty: "high" }], { unexplored_scope: ["consumer rebalancing under load"] }) }),
      outcome(b, { data: answerOf([{ id: "f1", claim: "Small clusters cost two engineers of operations." }]) }),
    ]);
    return ctx;
  }
  const exploit: MdsdStrategy = { ...challengeFavourite, purpose: "exploit", targets: ["G1"], framing: "Settle G1: does rebalancing break the latency target?", operators: ["VALIDATE"], reasoning: ["experiment"], validation: ["reproduction"], direction: "bottom-up" };
  const explore: MdsdStrategy = { ...expandNeeds, purpose: "explore", framing: "Which candidate did nobody consider?", hypothesis_space: ["Redis Streams or Postgres logical replication suffice at this scale"], evidence_scope: ["vendor documentation of Redis Streams", "Postgres logical decoding docs"] };

  it("needs results as its basis: adapt with known ids, exploit targets, and an explore strategy with new hypotheses or sources", async () => {
    const { mdsd } = await afterFirst();
    const two = [explorer("exploit", exploit), explorer("explore", explore)];
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two })).toThrow("a later search round needs adapt");
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two, adapt: { basis: ["G9"], reason: "x" } })).toThrow("adapt.basis names unknown ids G9");
    const untargeted = [explorer("exploit", { ...exploit, targets: [] }), explorer("explore", explore)];
    expect(() => mdsd.validate("search", untargeted, { reason: "search", workers: untargeted, adapt: { basis: ["G1"], reason: "x" } })).toThrow("an exploit strategy targets ids");
    const noPurpose = [explorer("exploit", { ...exploit, purpose: undefined }), explorer("explore", explore)];
    expect(() => mdsd.validate("search", noPurpose, { reason: "search", workers: noPurpose, adapt: { basis: ["G1"], reason: "x" } })).toThrow("states its purpose");
    // Only amplifying the early explanation is refused for a round of 2+: one strategy must explore.
    const onlyExploit = [explorer("e1", exploit), explorer("e2", { ...exploit, targets: ["F1"], operators: ["CHALLENGE"], direction: "backward" })];
    expect(() => mdsd.validate("search", onlyExploit, { reason: "search", workers: onlyExploit, adapt: { basis: ["G1", "F1"], reason: "x" } })).toThrow(/keeps at least one purpose "explore" strategy/);
    // An explore strategy that repeats earlier hypotheses and sources is not exploration.
    const stale = [explorer("exploit", exploit), explorer("explore", { ...invertRequirements, purpose: "explore", operators: ["EXPAND"], direction: "top-down" })];
    expect(() => mdsd.validate("search", stale, { reason: "search", workers: stale, adapt: { basis: ["G1"], reason: "x" } })).toThrow("opens hypotheses or information sources no earlier strategy had");
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two, adapt: { basis: ["G1", "F1"], reason: "G1 is uncovered and F1 is high-uncertainty" } })).not.toThrow();
    // A focused single exploit round is allowed (no forced breadth); stopping without another round is always allowed.
    const single = [explorer("exploit", exploit)];
    expect(() => mdsd.validate("search", single, { reason: "search", workers: single, adapt: { basis: ["G1"], reason: "settle G1" } })).not.toThrow();
  });

  it("the objective and constraints are fixed for the run (task drift is refused); the round cap ends the search", async () => {
    const { mdsd } = await afterFirst({ ...DEFAULT_MDSD, maxRounds: 2 });
    const two = [explorer("exploit", exploit), explorer("explore", explore)];
    const adapt = { basis: ["G1"], reason: "G1 is uncovered" };
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two, adapt, plan: { ...techPlan, objective: "Choose a database instead." } })).toThrow(/task drift/);
    expect(() => mdsd.validate("search", two, { reason: "search", workers: two, adapt, plan: { ...techPlan, constraints: techPlan.constraints.slice(1) } })).toThrow(/task drift/);
    await mdsd.prepare("search", two, signal, { reason: "search", workers: two, adapt, plan: { ...techPlan, objective: `  ${techPlan.objective}  ` } });
    expect(mdsd.state.rounds[1]).toMatchObject({ round: 2, adapt });
    expect(two.map(worker => mdsd.state.explorers.find(item => item.id === worker.id)?.round)).toEqual([2, 2]);
    await mdsd.finish("search", two, two.map(worker => outcome(worker, { data: answerOf([]) })));
    const three = [explorer("x", { ...explore, evidence_scope: ["Pulsar docs"] })];
    expect(() => mdsd.validate("search", three, { reason: "search", workers: three, adapt })).toThrow(/2 search rounds ran \(cap mdsd.maxRounds 2\).*round-cap/);
    expect(mdsd.summary().budget.exhausted).toBe("round cap 2");
  });
});

describe("mdsd: budget across all stages", () => {
  it("every stage is admitted on its worst case (allocation x hardStopAt + report responses): search up to 1 - reserve, other stages up to 1 - final", async () => {
    const settings: MdsdSettings = { ...DEFAULT_MDSD, total: { costUSD: 30, requests: 300 }, reserve: 0.3, final: 0.1 };
    const { mdsd, events } = run({ settings });
    mdsd.observeOrchestrator({ input: 10_000, output: 2_000, cacheRead: 50_000, cost: { total: 3 } });
    const three = [explorer("a", invertRequirements), explorer("b", challengeFavourite), explorer("c", transferDomains)];
    // $3 spent + 3 x ($6 x 1.25) = $25.5 > $21 (70% of $30): refused with the figures and the way out.
    expect(() => mdsd.validate("search", three, { reason: "search", workers: three, plan: techPlan })).toThrow("Refused (MDSD budget): this search call's worst case is $22.5 and 156 requests (3 worker(s): allocation x 1.25 hard stop, + 2 report responses each), but the search share of mdsd.total has $18 and 209 requests left");
    const smaller = [explorer("a", { ...invertRequirements, budget: { costUSD: 4 } }), explorer("b", { ...challengeFavourite, budget: { costUSD: 4 } })];
    await mdsd.prepare("search", smaller, signal, { reason: "search", workers: smaller, plan: techPlan });
    // While they run, their worst case is reserved: a verifier is not admitted on top of it ($3 + $10 running + $7.5 > $27? no: fits).
    expect(mdsd.committed()).toEqual({ costUSD: 10, requests: 104 });
    mdsd.observeOrchestrator({ cost: { total: 0.5 } });
    await mdsd.finish("search", smaller, smaller.map(worker => outcome(worker, { costUSD: 4.5, requests: 30, data: answerOf([]) })));
    expect(mdsd.committed()).toEqual({ costUSD: 0, requests: 0 });
    mdsd.observeOrchestrator({ cost: { total: 0.25 } });
    // Verifiers get the default allocation, enforced per session with their own notice.
    const verifier: PlannedWorker = { id: "W1.99", name: "check", role: "verify", request: "Check F1", reason: "verification" };
    const [budgeted] = await mdsd.prepare("verification", [verifier], signal);
    expect(budgeted!.budget).toMatchObject({ ...DEFAULT_MDSD.explorer, wrapUpAt: 0.8, hardStopAt: 1.25, notice: expect.stringContaining("your verdict on what you checked") });
    const verification = await mdsd.finish("verification", [verifier], [outcome(verifier, { status: "passed", costUSD: 2, requests: 12, budget: { inFlightUnknown: true } })]);
    expect(verification[0]).toContain("Cite a verifier's id (e.g. W1.99)");
    // $14.75 spent; two more verifiers ($15 worst) exceed the stage share ($27): refused.
    const two: PlannedWorker[] = [{ ...verifier, id: "W1.100" }, { ...verifier, id: "W1.101" }];
    expect(() => mdsd.validate("verification", two)).toThrow(/^Refused \(MDSD budget\): this verification call's worst case is \$15 and 104 requests .* the stage share of mdsd.total has \$12.25 and 195 requests left/);
    const summary = mdsd.summary();
    expect(summary.budget).toMatchObject({ spentOrchestratorUSD: 3.75, spentExplorersUSD: 9, spentVerifiersUSD: 2, spentUSD: 14.75, totalUSD: 30, searchLimitUSD: 21, stageLimitUSD: 27, finalAllowanceUSD: 3, allocatedUSD: 8, inFlightUnknown: 1, unpricedResponses: 0 });
    expect(summary.phases.map(item => [item.phase, item.requests, item.costUSD])).toEqual([["planning", 1, 3], ["search-1", 1, 0.5], ["integration-1", 1, 0.25], ["verification-1", 0, 0], ["after-verification-1", 0, 0]]);
    expect(events.filter(event => event.stage === "admission").map(event => event.reason)).toEqual(["search", "verification"]);
  });

  it("the orchestrator: a notice at the final-report allowance (every spawn reason refused after it), the stop at the total, once each", () => {
    const { mdsd, events } = run({ settings: { ...DEFAULT_MDSD, total: { costUSD: 10, requests: 100 }, final: 0.1 } });
    const actions: [string, string][] = [];
    let accept = true;
    const apply = (action: "notice" | "stop", text: string) => { actions.push([action, text]); return accept; };
    mdsd.observeOrchestrator({ cost: { total: 8.9 } }); mdsd.enforceOrchestrator(apply);
    expect(actions).toEqual([]);
    mdsd.observeOrchestrator({ cost: { total: 0.2 } }); mdsd.enforceOrchestrator(apply);
    expect(actions.map(item => item[0])).toEqual(["notice"]);
    expect(actions[0]![1]).toContain("No further orche_spawn call is admitted");
    for (const reason of ["search", "verification", "parallelism", "isolation"] as const) {
      const workers = reason === "search" ? [explorer("a", invertRequirements), explorer("b", challengeFavourite)] : [{ role: reason === "verification" ? "verify" : "implement", name: "w" }];
      expect(() => mdsd.validate(reason, workers, reason === "search" ? { reason, workers: workers as PlannedWorker[], plan: techPlan } : undefined)).toThrow(/^Refused \(MDSD budget\): the run reached its final-report allowance/);
    }
    mdsd.observeOrchestrator({ cost: { total: 0.5 } }); mdsd.enforceOrchestrator(apply);
    expect(actions.map(item => item[0])).toEqual(["notice"]);
    // A response that calls report_result is let land (apply returns false): the stop is tried again after the next response.
    accept = false;
    mdsd.observeOrchestrator({ cost: { total: 0.5 } }); mdsd.enforceOrchestrator(apply);
    accept = true;
    mdsd.observeOrchestrator({}); mdsd.enforceOrchestrator(apply);
    mdsd.observeOrchestrator({ cost: { total: 0.1 } }); mdsd.enforceOrchestrator(apply);
    expect(actions.map(item => item[0])).toEqual(["notice", "stop", "stop"]);
    expect(actions[2]![1]).toMatch(/^The MDSD total budget is used up \(\$10\.1 \/ 5 requests of \$10 \/ 100\) and your turn was stopped\. Call report_result alone now/);
    const summary = mdsd.summary();
    expect(summary.budget).toMatchObject({ noticed: "$9.1 / 2 requests of $10 / 100", stopped: "$10.1 / 5 requests of $10 / 100", unpricedResponses: 1, exhausted: expect.stringContaining("final-report allowance") });
    expect(summary.budget.overTotal).toMatch(/^spent \$10\.2 \/ 6 requests of \$10 \/ 100/);
    expect(mdsd.lines()[1]).toMatch(/final-report allowance \$1; notice at \$9\.1 .*; STOPPED at \$10\.1 .*usage unknown for 0 cancelled worker response\(s\) and 1 unpriced orchestrator response\(s\); OVER TOTAL/);
    expect(events.filter(event => event.stage === "budget").map(event => event.action)).toEqual(["notice", "stop"]);
  });

  it("after the budget stop the forced report may leave explorer findings unaccounted (recorded), but not claim unchecked verdicts", async () => {
    const { mdsd } = run({ settings: { ...DEFAULT_MDSD, total: { costUSD: 40, requests: 400 } } });
    const a = explorer("a", expandNeeds), b = explorer("b", transferDomains);
    await mdsd.prepare("search", [a, b], signal, { reason: "search", workers: [a, b], plan: ideationPlan });
    await mdsd.finish("search", [a, b], [outcome(a, { data: answerOf([{ id: "f1", claim: "Streak repair." }, { id: "f2", claim: "Cohorts." }]) }), outcome(b, { status: "failed", error: "budget: time at 31.3/25 min (1.25x the allocation)" })]);
    const report = (findings: unknown[], stop = "budget") => ({ evidence: [], unresolved: ["F2 unchecked"], mdsd: { decision: "diversified", reason: "wide", objective: ideationPlan.objective, findings, explored_scope: ["tickets"], unexplored_scope: ["reviews"], stop: { reason: stop, basis: "budget stop" } } });
    const kept = { id: "M1", claim: "Streak repair", status: "unverified", provenance: ["F1"], evidence: [], counter_evidence: [], uncertainty: "high" };
    expect(mdsd.gateError("answer", report([kept]))).toContain("unaccounted: F2=");
    mdsd.observeOrchestrator({ cost: { total: 45 } }); mdsd.enforceOrchestrator(() => true);
    expect(mdsd.gateError("answer", report([kept], "sufficient"))).toContain("unaccounted: F2=");
    expect(mdsd.gateError("answer", report([{ ...kept, status: "confirmed", evidence: ["both agree"] }]))).toContain("M1 is confirmed without evidence");
    expect(mdsd.gateError("answer", report([kept]))).toBeUndefined();
    expect(mdsd.summary().gate).toBe("passed after the budget stop (1 explorer finding(s) left unaccounted)");
    expect(mdsd.lines()[0]).toContain("report gate passed after the budget stop (1 explorer finding(s) left unaccounted)");
  });

  it("an overrun of the total (the orchestrator is bounded by its assignment, not stopped by mdsd.total) is recorded, never hidden", () => {
    const { mdsd } = run({ settings: { ...DEFAULT_MDSD, total: { costUSD: 1, requests: 10 } } });
    for (let i = 0; i < 12; i++) mdsd.observeOrchestrator({ cost: { total: 0.25 } });
    expect(mdsd.summary().budget.overTotal).toMatch(/^spent \$3 \/ 12 requests of \$1 \/ 10/);
    expect(mdsd.lines()[1]).toContain("OVER TOTAL");
  });
});

describe("mdsd: the report gate (separate judgment, evidence beyond agreement, dissent kept)", () => {
  async function judged(calls: Partial<ToolRecord>[] = [{ name: "bash", target: "node probe.js" }, { name: "read" }]) {
    const ctx = run({ calls });
    const a = explorer("a", researchDecompose), b = explorer("b", researchInvert);
    await ctx.mdsd.prepare("search", [a, b], signal, { reason: "search", workers: [a, b], plan: { ...techPlan, objective: "Assess the claim." } });
    await ctx.mdsd.finish("search", [a, b], [
      outcome(a, { data: answerOf([{ id: "f1", claim: "Gains disappear when the evaluation script is fixed." }, { id: "f2", claim: "Benchmark leakage in two papers." }]) }),
      outcome(b, { data: answerOf([{ id: "f1", claim: "Answers cite retrieved passages in 40% of cases." }]) }),
    ]);
    const report = (findings: unknown[], extra: Record<string, unknown> = {}) => ({ evidence: ["see mdsd"], mdsd: { decision: "diversified", reason: "wide search space", objective: "Assess the claim.", findings, dropped: [{ refs: [`${b.id}:f1`], reason: "out of scope: citation rate is not the claim" }], explored_scope: ["four papers"], unexplored_scope: ["closed models"], stop: { reason: "sufficient", basis: "both stages checked" }, ...extra } });
    const finding = (fields: Record<string, unknown>) => ({ id: "M1", claim: "c", status: "unverified", provenance: ["F1"], evidence: [], counter_evidence: [], uncertainty: "medium", ...fields });
    return { ...ctx, a, b, report, finding };
  }

  it("rejects: no data.mdsd, an unaccounted explorer finding, unknown refs, a verdict backed only by agreement, disputed without dissent, a changed objective", async () => {
    const { mdsd, a, report, finding } = await judged();
    expect(mdsd.gateError("answer", { evidence: [] })).toMatch(/^data.mdsd is required in mdsd mode/);
    expect(mdsd.gateError("answer", report([finding({})]))).toContain(`unaccounted: F2=${a.id}:f2`);
    expect(mdsd.gateError("answer", report([finding({ provenance: ["F1", "F2", "W9.9:f1"] })]))).toContain("unknown explorer finding refs W9.9:f1");
    expect(mdsd.gateError("answer", report([finding({ provenance: ["F1", "F2"], status: "confirmed", evidence: ["both explorers agree"] })]))).toContain("M1 is confirmed without evidence of your own checks");
    expect(mdsd.gateError("answer", report([finding({ provenance: ["F1", "F2"], status: "confirmed", evidence: ["[orche ref T7] ran it"] })]))).toContain("M1 is confirmed without evidence");
    expect(mdsd.gateError("answer", report([finding({ provenance: ["F1", "F2"], status: "disputed" })]))).toContain("M1 is disputed: name the dissent");
    expect(mdsd.gateError("answer", { ...report([finding({ provenance: ["F1", "F2"] })]), mdsd: { ...report([finding({ provenance: ["F1", "F2"] })]).mdsd, objective: "Prove the claim." } })).toContain("must be the plan's objective, unchanged");
    expect(mdsd.gateError("answer", { ...report([finding({ provenance: ["F1", "F2"] })]), mdsd: { ...report([]).mdsd, findings: [finding({ provenance: ["F1", "F2"] })], decision: "single-path" } })).toContain('decision "single-path" but 1 search round(s) ran');
    expect(mdsd.summary().gate).toMatch(/^rejected: /);
  });

  it("accepts own checks ([orche ref Tn] of real calls) or a verifier's id; keeps unverified and disputed findings with their dissent; counts provenance", async () => {
    const { mdsd, report, finding } = await judged();
    const verifier: PlannedWorker = { id: "W1.50", name: "check", role: "verify", request: "Re-run the evaluation", reason: "verification" };
    await mdsd.prepare("verification", [verifier], signal);
    await mdsd.finish("verification", [verifier], [outcome(verifier, { status: "passed", costUSD: 0.5 })]);
    const accepted = report([
      finding({ id: "M1", provenance: ["F1"], status: "confirmed", evidence: ["[orche ref T1] node probe.js: gains vanish with the fixed script"] }),
      finding({ id: "M2", provenance: ["F2"], status: "refuted", evidence: ["W1.50 reproduced the split: no overlap"] }),
      finding({ id: "M3", provenance: [], status: "disputed", dissent: "explorer b's ablation reading disagrees; not reproduced", claim: "my own" }),
    ]);
    expect(mdsd.gateError("answer", accepted)).toBeUndefined();
    const summary = mdsd.summary();
    expect(summary.gate).toBe("passed");
    expect(summary.findings).toEqual({ explorers: 3, final: 3, byStatus: { confirmed: 1, refuted: 1, disputed: 1 }, dropped: 1, firstRoundOnly: 2, adaptiveOnly: 0, both: 0, orchestratorOnly: 1 });
    expect(mdsd.lines()[0]).toMatch(/^MDSD: diversified; 1\/3 search round\(s\), 2 strategies \(2 distinct signatures\).*3 proposed → 3 final \(1 confirmed, 1 refuted, 1 disputed; 1 dropped; provenance: first round only 2, adaptive rounds only 0, both 0, orchestrator only 1\).*report gate passed$/);
  });

  it("single path: no search round, decision single-path, the gate needs only the mdsd report (implement: next to status)", () => {
    const { mdsd } = run({ readOnly: false });
    const report = { decision: "single-path", reason: "One config value to change; the check is one test.", objective: "Set the retry limit to 5.", findings: [], explored_scope: ["src/config.ts"], unexplored_scope: [], stop: { reason: "sufficient", basis: "test passes" } };
    expect(mdsd.gateError("implement", { status: "done", mdsd: { ...report, decision: "diversified" } })).toContain('decision "diversified" but no search round ran');
    expect(mdsd.gateError("implement", { status: "done", mdsd: report })).toBeUndefined();
    expect(mdsd.gateError("answer", {})).toBeUndefined(); // not this assignment's kind
    expect(mdsd.lines()[0]).toMatch(/^MDSD: single-path; 0\/3 search round\(s\), 0 strategies/);
    expect(mdsd.gateError("implement", { status: "blocked", mdsd: { ...report, stop: { reason: "blocked", basis: "no access" } } })).toContain("needs data.reason");
  });
});

describe("mdsd: texts and helpers", () => {
  it("the orchestrator's section names all six dimensions and operators, single-path first, the caps from the settings", () => {
    const text = mdsdSection(true, 8, { ...DEFAULT_MDSD, maxRounds: 2 });
    for (const operator of MDSD_OPERATORS) expect(text).toContain(operator);
    for (const dimension of ["① framing", "② hypothesis_space", "③ evidence_scope", "④ method + reasoning", "⑤ direction", "⑥ validation"]) expect(text).toContain(dimension);
    expect(text).toContain('report data.mdsd.decision "single-path"');
    expect(text).toContain("guidance, not a formula the runtime computes");
    expect(text).toContain("Caps: 2 search rounds");
    expect(text).toContain("never run all of them by default or a fixed number of workers");
  });

  it("the brief states the hard stop of the run's settings; footprints keep outside paths absolute; tokens and overlap", () => {
    expect(explorerBrief(techPlan, invertRequirements, DEFAULT_MDSD.explorer, 1, 1.5)).toContain("past 150% of a limit your session is stopped");
    expect(footprintOf("/repo", "bash", { command: "node scripts/run.mjs --in /data/x.json 2>&1 | tail -3" })).toEqual([{ kind: "command", key: "node scripts/run.mjs --in /data/x.json 2>&1 | tail -3" }, { kind: "file", key: "scripts/run.mjs" }, { kind: "file", key: "/data/x.json" }]);
    expect(footprintOf("/repo", "report_result", {})).toEqual([]);
    expect(footprintOf("/repo", "browser_fetch", { url: "https://example.com/a" })).toEqual([{ kind: "url", key: "https://example.com/a" }]);
    expect([...tokensOf("The order router hashes by customer")]).toEqual(["order", "router", "hashes", "customer"]);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(explorerReportError(answerOf([{ id: "f1", claim: "a" }, { id: "f1", claim: "b" }]))).toContain("f1 repeated");
    expect(explorerReportError(answerOf([]))).toBeUndefined();
  });
});

// ---- cross-model replication (an experiment setting; docs/mdsd.md "Replication") -----------------------------------------------
describe("mdsd: cross-model replication and explorer scratch (experiment settings, absent by default)", () => {
  const models = [{ model: "p1/m1", thinking: "max" as const }, { model: "p2/m2", thinking: "max" as const }];
  const replicated: MdsdSettings = { ...DEFAULT_MDSD, replication: { models } };
  const pinned = (workers: { name: string; role: string; request: string; strategy: unknown }[], extra: Partial<MdsdSettings> = {}): MdsdSettings => ({ ...replicated, ...extra, replication: { models, round: { plan: techPlan, workers } } });
  const pinnedWorkers = [
    { name: "invert", role: "answer", request: "Recorded request: derive the capabilities from docs/requirements.md.", strategy: invertRequirements },
    { name: "challenge", role: "answer", request: "Recorded request: attack the favourite.", strategy: challengeFavourite },
  ];
  let serialId = 100;
  const nextId = () => `W1.${++serialId}`;

  it("config: 2-4 distinct model routes and a pinned round of answer explorers; explorerScratch is a boolean; neither is set by default", () => {
    expect(parseMdsdConfig({})).toEqual(DEFAULT_MDSD);
    expect("replication" in parseMdsdConfig({ maxRounds: 1 })).toBe(false);
    const parsed = parseMdsdConfig({ explorerScratch: true, replication: { models: [{ model: "a/x", thinking: "max" }, { model: "b/y" }], round: { plan: techPlan, workers: pinnedWorkers } } });
    expect(parsed).toMatchObject({ explorerScratch: true, replication: { models: [{ model: "a/x", thinking: "max" }, { model: "b/y" }], round: { plan: techPlan, workers: pinnedWorkers } } });
    const two = [{ model: "a/x" }, { model: "b/y" }];
    expect(() => parseMdsdConfig({ replication: { models: [{ model: "a/x" }] } })).toThrow("expected 2-4 model routes");
    expect(() => parseMdsdConfig({ replication: { models: [{ model: "a/x" }, { model: "a/x" }] } })).toThrow("every model once");
    expect(() => parseMdsdConfig({ replication: { models: [{ model: "ax" }, { model: "b/y" }] } })).toThrow("expected provider/modelId");
    expect(() => parseMdsdConfig({ replication: { models: [{ model: "a/x" }, { model: "b/y", thinking: "loud" }] } })).toThrow("thinking: expected");
    expect(() => parseMdsdConfig({ replication: { models: two, copies: 2 } })).toThrow("config.mdsd.replication: unknown field copies");
    expect(() => parseMdsdConfig({ replication: { models: two, round: { plan: techPlan, workers: [{ ...pinnedWorkers[0], role: "implement" }] } } })).toThrow("search explorers are role answer");
    expect(() => parseMdsdConfig({ replication: { models: two, round: { workers: [] } } })).toThrow("expected { plan, workers }");
    expect(() => parseMdsdConfig({ explorerScratch: "yes" })).toThrow("config.mdsd.explorerScratch: expected boolean");
  });

  it("a pinned round must be a valid first round when the run starts: plan and strategy schemas, two or more, no label-only duplicates, cells within the cap", () => {
    expect(() => run({ settings: pinned(pinnedWorkers) })).not.toThrow();
    expect(() => run({ settings: pinned(pinnedWorkers.slice(0, 1)) })).toThrow("two or more strategies");
    expect(() => run({ settings: { ...replicated, replication: { models, round: { plan: { objective: "x" }, workers: pinnedWorkers } } } })).toThrow("mdsd.replication.round: invalid plan");
    expect(() => run({ settings: pinned([pinnedWorkers[0]!, { ...pinnedWorkers[1]!, strategy: { ...challengeFavourite, operators: ["GUESS"] } }]) })).toThrow("challenge: invalid strategy");
    // The pinned strategies pass the same label-only check as any first round: replication does not exempt them.
    const relabelled = { ...invertRequirements, framing: "As the analyst, reason from the needs.", hypothesis_space: [...invertRequirements.hypothesis_space].reverse() };
    expect(() => run({ settings: pinned([pinnedWorkers[0]!, { ...pinnedWorkers[1]!, strategy: relabelled }]) })).toThrow(/are one search path/);
    expect(() => run({ settings: pinned([...pinnedWorkers, { ...pinnedWorkers[0]!, name: "transfer", strategy: transferDomains }]), maxSubWorkers: 4 })).toThrow("3 strategies on 2 models are 6 explorers, above the cap of 4");
  });

  it("the pinned round runs whatever text the first search call carries, which must name the pinned workers in order; other calls run as they are", () => {
    const { mdsd } = run({ settings: pinned(pinnedWorkers) });
    expect(() => mdsd.resolve({ reason: "search", workers: [{ name: "challenge", role: "answer", request: "pinned" }, { name: "invert", role: "answer", request: "pinned" }] })).toThrow(/pinned by the experiment .*"invert", "challenge" in this order/);
    const call = mdsd.resolve({ reason: "search", plan: { ...techPlan, objective: "Another goal." }, workers: [{ name: "invert", role: "answer", request: "pinned" }, { name: "challenge", role: "answer", request: "my own words", strategy: expandNeeds }] });
    expect(call).toEqual({ reason: "search", plan: techPlan, workers: pinnedWorkers });
    const verification = { reason: "verification" as const, workers: [{ name: "v", role: "verify" as const, request: "check" }] };
    expect(mdsd.resolve(verification)).toBe(verification);
    // Without a pin nothing is replaced.
    const plain = { reason: "search" as const, plan: techPlan, workers: [{ name: "a", role: "answer" as const, request: "r", strategy: invertRequirements }] };
    expect(run({ settings: replicated }).mdsd.resolve(plain)).toBe(plain);
  });

  it("the label-only check still applies with replication; admission and the cap count every explorer cell, before any id", () => {
    const { mdsd } = run({ settings: replicated });
    const relabelled: MdsdStrategy = { ...invertRequirements, framing: "As the requirements analyst, reason from the needs.", hypothesis_space: [...invertRequirements.hypothesis_space].reverse(), evidence_scope: [...invertRequirements.evidence_scope].reverse() };
    const duplicates = [explorer("analyst", invertRequirements), explorer("architect", relabelled)];
    expect(() => mdsd.validate("search", duplicates, { reason: "search", workers: duplicates, plan: techPlan })).toThrow(/are one search path/);
    const two = [explorer("a", invertRequirements), explorer("b", challengeFavourite)];
    // Default explorer $6 / 40 requests: worst case $7.5 / 52 requests per cell. $40 total: the search share is $28.
    const tight = { total: { costUSD: 40, requests: 600 } };
    expect(() => run({ settings: { ...DEFAULT_MDSD, ...tight } }).mdsd.validate("search", two, { reason: "search", workers: two, plan: techPlan })).not.toThrow();
    expect(() => run({ settings: { ...replicated, ...tight } }).mdsd.validate("search", two, { reason: "search", workers: two, plan: techPlan })).toThrow(/worst case is \$30 and 208 requests \(4 worker\(s\)/);
    const three = [...two, explorer("c", transferDomains)];
    expect(() => run({ settings: replicated, maxSubWorkers: 4 }).mdsd.validate("search", three, { reason: "search", workers: three, plan: techPlan })).toThrow("3 strategies are 6 explorers, above this session's cap of 4 sub-workers per call");
    expect(() => run({ settings: replicated, maxSubWorkers: 6 }).mdsd.validate("search", three, { reason: "search", workers: three, plan: techPlan })).not.toThrow();
  });

  it("fan-out: every strategy once per model, fresh ids, the same brief and request, its own route; strategies and cells are counted apart; maxRounds 1 ends the search", async () => {
    const { mdsd, events } = run({ settings: pinned(pinnedWorkers, { maxRounds: 1 }) });
    const call = mdsd.resolve({ reason: "search", workers: [{ name: "invert", role: "answer", request: "pinned" }, { name: "challenge", role: "answer", request: "pinned" }] });
    const base = call.workers.map(worker => ({ id: nextId(), name: worker.name, role: worker.role, request: worker.request, reason: "search" as const, strategy: worker.strategy }));
    const prepared = await mdsd.prepare("search", base, signal, call, nextId);
    const [a, b] = base;
    expect(prepared.map(worker => [worker.id, worker.name, worker.route?.model, worker.route?.thinking])).toEqual([[a!.id, "invert", "p1/m1", "max"], [b!.id, "challenge", "p1/m1", "max"], [`W1.${serialId - 1}`, "invert", "p2/m2", "max"], [`W1.${serialId}`, "challenge", "p2/m2", "max"]]);
    // The two cells of a strategy get the same request and brief (the pinned request, not the call's "pinned").
    expect(prepared[2]!.request).toBe(pinnedWorkers[0]!.request);
    expect(prepared[2]!.brief).toBe(prepared[0]!.brief);
    expect(prepared[3]!.brief).toBe(prepared[1]!.brief);
    expect(prepared[0]!.brief).toContain(`objective: ${JSON.stringify(techPlan.objective)}`);
    expect(mdsd.state.allocated).toEqual({ costUSD: 24, requests: 160 });
    expect(events.find(event => event.stage === "search")).toMatchObject({ round: 1, models: ["p1/m1", "p2/m2"], pinned: true, workers: [{ id: a!.id, model: "p1/m1", group: a!.id }, { id: b!.id, model: "p1/m1", group: b!.id }, { model: "p2/m2", group: a!.id }, { model: "p2/m2", group: b!.id }] });
    const lines = (await mdsd.finish("search", prepared, prepared.map(worker => outcome(worker, { model: worker.route!.model, data: answerOf([{ id: "f1", claim: `${worker.name} as seen on ${worker.route!.model}` }]) })))).join("\n");
    expect(lines).toContain("2 strategies x 2 models = 4 explorer cells");
    expect(lines).toContain("the experiment's pinned round");
    expect(lines).toContain(`${a!.id} = ${a!.id} on p1/m1 / ${prepared[2]!.id} on p2/m2`);
    expect(lines).toContain(`- ${prepared[3]!.id} challenge [${signatureOf(challengeFavourite)}] on p2/m2 done`);
    expect(mdsd.state.findings.map(item => item.ref)).toEqual(prepared.map(worker => `${worker.id}:f1`));
    const summary = mdsd.summary();
    expect(summary).toMatchObject({ rounds: 1, strategies: 2, distinctSignatures: 2, replication: { models: ["p1/m1", "p2/m2"], cells: 4, pinned: true } });
    expect(summary.explorers.map(item => [item.id, item.model, item.group])).toEqual(prepared.map((worker, index) => [worker.id, worker.route!.model, base[index % 2]!.id]));
    expect(mdsd.lines()[0]).toContain("2 strategies (2 distinct signatures), each on 2 models: 4 explorer cells (pinned first round)");
    // One measured search round only: a second one is refused before anything runs.
    expect(() => mdsd.validate("search", base, { reason: "search", workers: base })).toThrow(/round cap mdsd.maxRounds 1|cap mdsd.maxRounds 1/);
    // Without replication the counts are unchanged: every explorer is its own strategy.
    const plain = run();
    const x = explorer("x", invertRequirements), y = explorer("y", challengeFavourite);
    await plain.mdsd.prepare("search", [x, y], signal, { reason: "search", workers: [x, y], plan: techPlan }, nextId);
    expect(plain.mdsd.summary()).toMatchObject({ strategies: 2 });
    expect(plain.mdsd.summary().replication).toBeUndefined();
    expect(plain.mdsd.state.explorers.map(item => [item.model, item.group, item.scratch])).toEqual([[undefined, undefined, undefined], [undefined, undefined, undefined]]);
  });

  it("explorerScratch: every cell gets a private 0700 directory next to the orchestrator's; none without the setting; none without an orchestrator scratch", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdsd-scratch-")); temp.push(root);
    const own = await ensureScratchDir({ base: root, session: "s1", worker: "W1" });
    const { mdsd } = run({ settings: { ...replicated, explorerScratch: true }, scratch: own });
    const a = explorer("a", invertRequirements), b = explorer("b", challengeFavourite);
    const prepared = await mdsd.prepare("search", [a, b], signal, { reason: "search", workers: [a, b], plan: techPlan }, nextId);
    const real = await realpath(root);
    expect(prepared.map(worker => worker.scratch)).toEqual(prepared.map(worker => join(real, "s1", worker.id)));
    for (const worker of prepared) expect((await stat(worker.scratch!)).mode & 0o777).toBe(0o700);
    expect(mdsd.state.explorers.map(item => item.scratch)).toEqual(prepared.map(worker => worker.scratch));
    const without = run({ settings: replicated, scratch: own });
    const c = explorer("c", invertRequirements), d = explorer("d", challengeFavourite);
    expect((await without.mdsd.prepare("search", [c, d], signal, { reason: "search", workers: [c, d], plan: techPlan }, nextId)).map(worker => worker.scratch)).toEqual([undefined, undefined, undefined, undefined]);
    const orphan = run({ settings: { ...DEFAULT_MDSD, explorerScratch: true } });
    const e = explorer("e", invertRequirements), f = explorer("f", challengeFavourite);
    await expect(orphan.mdsd.prepare("search", [e, f], signal, { reason: "search", workers: [e, f], plan: techPlan })).rejects.toThrow("the orchestrator has no scratch directory");
    expect(orphan.mdsd.state.explorers).toEqual([]);
  });

  it("the orchestrator's section explains replication and the pinned call; without replication it says nothing about it", () => {
    const text = mdsdSection(true, 8, pinned(pinnedWorkers));
    expect(text).toContain("Replication experiment (mdsd.replication, set for this run): every search strategy runs once per model — p1/m1 (thinking max), p2/m2 (thinking max)");
    expect(text).toContain('the workers "invert", "challenge" in this order, each role "answer" with request "pinned"');
    expect(text).toContain(JSON.stringify(techPlan.objective));
    expect(text).toContain("their agreement as replication, not independent proof");
    expect(mdsdSection(true, 8, replicated)).not.toContain("The first search round is pinned");
    expect(mdsdSection(true, 8, DEFAULT_MDSD)).not.toContain("Replication experiment");
  });
});

// ---- registered prior claims (an experiment setting; docs/mdsd.md "Experiment settings") ------------------------------------------
describe("mdsd: registered prior claims (mdsd.seed, absent by default)", () => {
  const claims = [
    { ref: "P1:c1", claim: "src/app.ts:10 drops the retry count", quote: "the retry count is dropped at src/app.ts:10", locations: ["src/app.ts:10"] },
    { ref: "P2:c1", claim: "Retries are reset at src/app.ts:12", locations: ["src/app.ts:12"] },
    { ref: "P2:c2", claim: "The cache is never invalidated", stance: "uncertain" as const },
  ];
  const seeded: MdsdSettings = { ...DEFAULT_MDSD, seed: { claims } };
  const exploitOf = (targets: string[]) => explorer("settle", { ...invertRequirements, purpose: "exploit", targets } as MdsdStrategy);

  it("config: unique namespaced refs and bounded content; absent by default", () => {
    expect("seed" in parseMdsdConfig({})).toBe(false);
    expect(parseMdsdConfig({ seed: { claims } }).seed).toEqual({ claims });
    expect(() => parseMdsdConfig({ seed: { claims: [claims[0], { ...claims[1], ref: "P1:c1" }] } })).toThrow("P1:c1 is registered twice");
    expect(() => parseMdsdConfig({ seed: { claims: [{ ...claims[0], ref: "W1.2:f1" }] } })).toThrow('expected "P<n>:c<n>"');
    expect(() => parseMdsdConfig({ seed: { claims: [] } })).toThrow("expected { claims: [1-400");
    expect(() => parseMdsdConfig({ seed: { claims: [{ ...claims[0], verdict: "true" }] } })).toThrow("expected { ref, claim");
    expect(() => parseMdsdConfig({ seed: { claims: [{ ...claims[0], stance: "proven" }] } })).toThrow("stance");
    expect(() => parseMdsdConfig({ seed: { claims: [{ ref: "P1:c9", claim: " " }] } })).toThrow("claim: expected text");
  });

  it("registered claims are round-0 findings in the aggregation; the first search round follows them up (adapt.basis), the section lists them", () => {
    const { mdsd } = run({ settings: seeded });
    expect(mdsd.state.findings.map(item => [item.gid, item.ref, item.round, item.finding.uncertainty])).toEqual([["F1", "P1:c1", 0, "medium"], ["F2", "P2:c1", 0, "medium"], ["F3", "P2:c2", 0, "high"]]);
    expect(mdsd.state.aggregation.duplicates.map(item => item.members)).toEqual([["F1", "F2"]]);
    const exploit = exploitOf(["F1", "P2:c1"]), fresh = explorer("unseen", { ...challengeFavourite, purpose: "explore" } as MdsdStrategy);
    expect(() => mdsd.validate("search", [exploit, fresh], { reason: "search", workers: [exploit, fresh], plan: techPlan })).toThrow("a later search round needs adapt");
    expect(() => mdsd.validate("search", [exploit, fresh], { reason: "search", workers: [exploit, fresh], plan: techPlan, adapt: { basis: ["W1.9:f1"], reason: "x" } })).toThrow("adapt.basis names unknown ids W1.9:f1");
    expect(() => mdsd.validate("search", [exploit, fresh], { reason: "search", workers: [exploit, fresh], adapt: { basis: ["D1", "F3"], reason: "settle the duplicate" } })).toThrow("the first search call needs plan");
    expect(() => mdsd.validate("search", [exploit, fresh], { reason: "search", workers: [exploit, fresh], plan: techPlan, adapt: { basis: ["D1", "F3"], reason: "settle the duplicate, check the open claim" } })).not.toThrow();
    // One targeted strategy is a valid follow-up round (the 2+ rule is for a first, unseeded round).
    expect(() => mdsd.validate("search", [exploit], { reason: "search", workers: [exploit], plan: techPlan, adapt: { basis: ["F1"], reason: "settle" } })).not.toThrow();
    expect(mdsdSection(true, 8, seeded)).toContain("F2 = P2:c1: Retries are reset at src/app.ts:12 (src/app.ts:12)");
    expect(mdsdSection(true, 8, seeded)).toContain("F3 = P2:c2 [uncertain in its source]: The cache is never invalidated");
    expect(mdsdSection(true, 8, seeded)).toContain("The report gate refuses a seeded run without a search round");
    expect(mdsdSection(true, 8, DEFAULT_MDSD)).not.toContain("Registered prior claims");
    // Without seeds the first round keeps its rules.
    expect(() => run().mdsd.validate("search", [exploit], { reason: "search", workers: [exploit], plan: techPlan })).toThrow("the first search round takes two or more strategies");
  });

  it("gate: a seeded run needs its follow-up round; every registered claim is accounted for; confirmed needs own evidence; summary counts seeds apart", async () => {
    const { mdsd } = run({ settings: seeded, calls: [{ ref: "T7", name: "read" }] });
    const final = (findings: unknown[], dropped: unknown[]) => ({ evidence: ["see mdsd"], mdsd: { decision: "diversified", reason: "follow-up", objective: techPlan.objective, findings, dropped, explored_scope: ["src"], unexplored_scope: [], stop: { reason: "sufficient", basis: "checked" } } });
    const kept = { id: "M1", claim: "The retry count is dropped at src/app.ts:10", status: "confirmed", provenance: ["P1:c1", "F2"], evidence: ["[orche ref T7] src/app.ts:10 assigns 0"], counter_evidence: [], uncertainty: "low" };
    const open = { id: "M2", claim: "The cache may never be invalidated", status: "unverified", provenance: ["P2:c2"], evidence: [], counter_evidence: [], uncertainty: "high" };
    expect(mdsd.gateError("answer", final([kept, open], []))).toContain("registered prior claims (mdsd.seed) need the follow-up first");
    const exploit = exploitOf(["F1"]);
    const call = { reason: "search" as const, workers: [exploit], plan: techPlan, adapt: { basis: ["F1"], reason: "settle" } };
    mdsd.validate("search", [exploit], call);
    const prepared = await mdsd.prepare("search", [exploit], signal, call);
    await mdsd.finish("search", prepared, prepared.map(worker => outcome(worker, { data: answerOf([{ id: "f1", claim: "src/app.ts:10 drops the count" }]) })));
    const fresh = `${prepared[0]!.id}:f1`;
    expect(mdsd.gateError("answer", final([kept], [{ refs: [fresh], reason: "duplicate of M1" }]))).toContain("unaccounted: F3=P2:c2");
    expect(mdsd.gateError("answer", final([{ ...kept, evidence: ["src/app.ts:10"] }, open], [{ refs: [fresh], reason: "duplicate of M1" }]))).toContain("M1 is confirmed without evidence of your own checks");
    expect(mdsd.gateError("answer", final([kept, open], [{ refs: [fresh], reason: "duplicate of M1" }]))).toBeUndefined();
    expect(mdsd.summary().findings).toMatchObject({ explorers: 4, final: 2, dropped: 1, seeded: 3, seededKept: 2, orchestratorOnly: 0 });
    expect(run().mdsd.summary().findings.seeded).toBeUndefined();
  });
});
