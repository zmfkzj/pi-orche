/**
 * Analysis of one synergy study (PREREGISTRATION.md §4-§6): reads the stage-eval run records of `<study dir>/runs/<task>/<arm>/r<n>`
 * and prints the factorial contrasts, intervals, verdicts, cost, latency and activation checks as JSON (aggregates only).
 *
 *   npx tsx experiments/synergy/analyze.ts <study dir> S1|S2 [--out summary.json]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CELLS, S1, S2, bootstrap, cellMeans, contrasts, interactionVerdict, practicallyUseful, signFlipP, type Factorial, type RunRow } from "./protocol.js";

export function loadRows(study: string, factorial: Factorial): { rows: RunRow[]; metas: any[] } {
  const rows: RunRow[] = [], metas: any[] = [];
  const runs = join(study, "runs");
  if (!existsSync(runs)) return { rows, metas };
  const arms = new Set(CELLS.map(cell => factorial.arms[cell].name));
  for (const task of readdirSync(runs)) for (const arm of readdirSync(join(runs, task))) {
    if (!arms.has(arm)) continue;
    for (const rep of readdirSync(join(runs, task, arm))) {
      const file = join(runs, task, arm, rep, "meta.json");
      if (!/^r\d+$/.test(rep) || !existsSync(file)) continue;
      const meta = JSON.parse(readFileSync(file, "utf8"));
      if (meta.status !== "completed") continue;
      metas.push(meta);
      rows.push({ task, arm, repeat: Number(rep.slice(1)), terminal: meta.terminal, gradePass: meta.terminal === "done" && meta.grade?.passed === true && !meta.grade?.error, primaryPass: meta.primaryPass === true, costUsd: Number(meta.wire?.total?.costUsd ?? 0), wallMs: Number(meta.wallMs ?? 0), infra: meta.terminal === "infra" });
    }
  }
  return { rows, metas };
}

/** Kept infra attempts (`<rep>.infra-n` / `.interrupted-n` directories) and their cost: reported, never scored. */
function keptAttempts(study: string): { attempts: number; costUsd: number } {
  let attempts = 0, costUsd = 0;
  const runs = join(study, "runs");
  if (!existsSync(runs)) return { attempts, costUsd };
  for (const task of readdirSync(runs)) for (const arm of readdirSync(join(runs, task))) for (const rep of readdirSync(join(runs, task, arm))) {
    if (/^r\d+$/.test(rep)) continue;
    attempts++;
    try { costUsd += Number(JSON.parse(readFileSync(join(runs, task, arm, rep, "meta.json"), "utf8")).wire?.total?.costUsd ?? 0); } catch { /* none */ }
  }
  return { attempts, costUsd };
}

/**
 * Evidence linkage in the worker transcripts of each run: `linked` = some tool RESULT carries an `[orche ref T<n>]` reference
 * (the tool schemas quote `[orche ref T12]` as an example, so the raw text is not enough); `cited` = some task_plan checkpoint
 * evidence item starts with `T<n>`; `decision` = a compaction summary carries decision memory's work-log heading.
 */
function linkage(metas: readonly any[]): { linkedRuns: number; citedRuns: number; decisionMemoryRuns: number } {
  let linkedRuns = 0, citedRuns = 0, decisionMemoryRuns = 0;
  for (const meta of metas) {
    let linked = false, cited = false, decision = false;
    for (const entry of meta.transcripts ?? []) {
      if (!/\/workers\//.test(entry.file ?? "")) continue;
      let text = "";
      try { text = readFileSync(join(meta.out, entry.file), "utf8"); } catch { continue; }
      if (text.includes("Decision-linked work evidence (recorded observations")) decision = true;
      for (const line of text.split("\n")) {
        if (!line.includes("orche ref T") && !line.includes("task_plan")) continue;
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        const message = record?.message;
        if (message?.role === "toolResult" && /\[orche ref T\d+\]/.test(JSON.stringify(message.content ?? ""))) linked = true;
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part?.type !== "toolCall" || part.name !== "task_plan") continue;
            const nodes = Array.isArray(part.arguments?.nodes) ? part.arguments.nodes : [];
            if (nodes.some((node: any) => (Array.isArray(node?.checkpoint?.evidence) ? node.checkpoint.evidence : []).some((item: unknown) => typeof item === "string" && /^T\d+\b/.test(item)))) cited = true;
          }
        }
      }
    }
    if (linked) linkedRuns++;
    if (cited) citedRuns++;
    if (decision) decisionMemoryRuns++;
  }
  return { linkedRuns, citedRuns, decisionMemoryRuns };
}

/** Per-arm activation evidence from orche's task records (run.json) of each run's worker. */
function activation(metas: readonly any[], arm: string) {
  const own = metas.filter(meta => meta.arm?.name === arm);
  const workers = own.flatMap(meta => (meta.tasks ?? []).filter((task: any) => task.role));
  const count = (pick: (task: any) => boolean) => workers.filter(pick).length;
  return {
    runs: own.length, workerTasks: workers.length,
    advisorProcessed: count(task => task.advisor?.status === "processed"),
    advisorOther: count(task => task.advisor && task.advisor.status !== "processed"),
    phasePolicy: count(task => task.thinkingPolicy?.mode === "phase"),
    belowBaselineRequests: workers.reduce((sum: number, task: any) => sum + Number(task.thinkingPolicy?.requests?.belowBaseline ?? 0), 0),
    compactions: workers.reduce((sum: number, task: any) => sum + Number(task.compactions?.count ?? 0), 0),
    ...linkage(own),
    withCompaction: count(task => Number(task.compactions?.count ?? 0) > 0),
    noTask: own.filter(meta => !(meta.tasks ?? []).length).length,
    leakHits: own.reduce((sum, meta) => sum + (meta.leakAudit?.hits?.length ?? 0), 0),
    unexpectedWire: own.reduce((sum, meta) => sum + (meta.wire?.unexpected?.length ?? 0), 0),
    integrityViolations: own.reduce((sum, meta) => sum + (meta.integrity?.violations?.length ?? 0), 0),
  };
}

export function summarize(study: string, factorial: Factorial) {
  const { rows, metas } = loadRows(study, factorial);
  const success = cellMeans(rows, factorial, row => row.gradePass ? 1 : 0);
  const strict = cellMeans(rows, factorial, row => row.primaryPass ? 1 : 0);
  const cs = contrasts(strict);
  const cost = cellMeans(rows, factorial, row => row.costUsd);
  const wall = cellMeans(rows, factorial, row => row.wallMs / 1000);
  const c = contrasts(success), k = contrasts(cost), w = contrasts(wall);
  const interaction = bootstrap(success, x => x.interaction);
  const xyMinusBase = bootstrap(success, x => x.xyMinusBase);
  const perTask = (means: typeof success, pick: (cell: Record<"base" | "x" | "y" | "xy", number>) => number) => [...means.values()].map(pick);
  const arms = Object.fromEntries(CELLS.map(cell => {
    const name = factorial.arms[cell].name;
    const own = rows.filter(row => row.arm === name);
    const scored = own.filter(row => !row.infra);
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const median = (values: number[]) => { const s = sorted(values); return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : NaN; };
    const passes = scored.filter(row => row.gradePass).length;
    const strictPasses = scored.filter(row => row.primaryPass).length;
    const costTotal = own.reduce((sum, row) => sum + row.costUsd, 0);
    return [cell, {
      arm: name, runs: own.length, scored: scored.length, gradePass: passes, strictPass: strictPasses, terminals: Object.fromEntries([...new Set(own.map(row => row.terminal))].map(t => [t, own.filter(row => row.terminal === t).length])),
      costUsd: costTotal, costPerRunUsd: own.length ? costTotal / own.length : NaN, costPerSuccessUsd: passes ? costTotal / passes : null, medianWallS: median(own.map(row => row.wallMs / 1000)),
      activation: activation(metas, name),
    }];
  }));
  const costRatio = k.base ? k.xy / k.base : NaN;
  return {
    study: factorial.study, factors: { x: factorial.x, y: factorial.y }, tasks: success.size, runs: rows.length,
    success: {
      cells: { base: c.base, x: c.x, y: c.y, xy: c.xy },
      mainX: bootstrap(success, x => x.mainX), mainY: bootstrap(success, x => x.mainY), interaction, xyMinusBase,
      xyMinusBestSingle: c.xyMinusBestSingle,
      signFlipP: { interaction: signFlipP(perTask(success, cell => cell.xy - cell.x - cell.y + cell.base)), xyMinusBase: signFlipP(perTask(success, cell => cell.xy - cell.base)) },
    },
    strictSensitivity: {
      cells: { base: cs.base, x: cs.x, y: cs.y, xy: cs.xy }, interaction: bootstrap(strict, x => x.interaction), xyMinusBase: bootstrap(strict, x => x.xyMinusBase),
      xyMinusBestSingle: cs.xyMinusBestSingle, verdict: interactionVerdict(bootstrap(strict, x => x.interaction)),
    },
    cost: { cells: { base: k.base, x: k.x, y: k.y, xy: k.xy }, interaction: bootstrap(cost, x => x.interaction), mainX: bootstrap(cost, x => x.mainX), mainY: bootstrap(cost, x => x.mainY), ratioXyToBase: costRatio },
    wallS: { cells: { base: w.base, x: w.x, y: w.y, xy: w.xy }, interaction: bootstrap(wall, x => x.interaction) },
    verdicts: { interaction: interactionVerdict(interaction), practicallyUseful: practicallyUseful({ xyMinusBase, xyMinusBestSingle: c.xyMinusBestSingle }, costRatio) },
    arms, keptAttempts: keptAttempts(study),
    perTask: Object.fromEntries([...success.entries()].map(([task, cell]) => [task, { success: cell, strict: strict.get(task), costUsd: cost.get(task) }])),
  };
}

if (process.argv[1]?.endsWith("analyze.ts")) {
  const [study, which] = process.argv.slice(2);
  const factorial = which === "S2" ? S2 : S1;
  const summary = summarize(study!, factorial);
  const json = JSON.stringify(summary, null, 2);
  const outAt = process.argv.indexOf("--out");
  if (outAt > 0) writeFileSync(process.argv[outAt + 1]!, `${json}\n`);
  console.log(json);
}
