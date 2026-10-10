/**
 * Analysis of the ultra-vs-single study (experiments/ultra-ab): primary success per condition, task-level paired B−A and B−C with a
 * task bootstrap, strata and task types, terminal statuses, transitions, model/route evidence, usage, timing and integrity.
 *
 *   npx tsx experiments/ultra-ab/analyze.ts --study <out dir> --phase <phase>   (re-grade first: regrade.ts)
 *
 * Every planned unit counts: a planned unit without a completed result is reported as NOT RUN (never as a pass or a fail), and the
 * paired comparison uses only (task, condition) cells with at least one completed run.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONDITIONS, THINKING, paired, summarizeWire, taskRates, verdict, type Condition, type Paired, type Row, type WireEntry } from "./protocol.js";

/** The wire summary recomputed from the raw wire log with the current definitions (one definition across phases). */
function wireOf(dir: string, selector: boolean, mainSession?: string) {
  const file = join(dir, "wire.jsonl");
  if (!existsSync(file)) return undefined;
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as WireEntry]; } catch { return []; } });
  return summarizeWire(entries, selector ? { selector: THINKING.selector } : { main: THINKING.main, worker: THINKING.orchestrator, ...(mainSession ? { mainSession } : {}) });
}

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };

export interface UnitRow extends Row { kind: string; attempt?: number; wallMs?: number; wire?: any; grade?: any; integrity?: any; infra?: string; leakHits: number; selection?: any; oraclePass?: boolean; tasks?: any[] }

/** Rows of every completed top-level result: A and B solo units, C select units (C attempts separately). */
export function collectRows(study: string, phase: string): { plan: any; rows: UnitRow[]; attempts: UnitRow[]; notRun: string[]; kept: string[] } {
  const plan = readJson(join(study, `plan-${phase}.json`));
  const strata = new Map<string, string>(plan.tasks.map((item: any) => [item.task, item.stratum]));
  const rows: UnitRow[] = [], attempts: UnitRow[] = [], notRun: string[] = [], kept: string[] = [];
  for (const { id } of plan.order as { id: string }[]) {
    const [task, condition, rep, part] = id.split("/");
    const dir = join(study, "runs", id);
    const meta = readJson(join(dir, "meta.json"));
    const parent = join(dir, "..");
    if (existsSync(parent)) for (const name of readdirSync(parent)) if (name.startsWith(`${dir.split("/").at(-1)}.`)) kept.push(`${id}.${name.split(".").slice(1).join(".")}`);
    if (meta?.status !== "completed") { notRun.push(id); continue; }
    const row: UnitRow = {
      task: task!, condition: condition as Condition, repeat: Number(rep!.slice(1)), pass: meta.primaryPass === true, terminal: meta.terminal, stratum: strata.get(task!),
      kind: part === "select" ? "select" : "solo", ...(part?.startsWith("a") ? { attempt: Number(part.slice(1)) } : {}),
      wallMs: meta.wallMs ?? meta.selectionMs, wire: wireOf(dir, part === "select", meta.sessionId) ?? meta.wire, grade: meta.grade, integrity: meta.integrity, infra: meta.infra, leakHits: meta.leakAudit?.hits?.length ?? 0,
      selection: meta.selection, oraclePass: meta.oraclePass, tasks: meta.tasks,
    };
    if (part?.startsWith("a")) attempts.push(row); else rows.push(row);
  }
  return { plan, rows, attempts, notRun, kept };
}

const pct = (value: number) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
const pp = (value: number) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp` : "n/a";

export function summarize(study: string, phase: string) {
  const { plan, rows, attempts, notRun, kept } = collectRows(study, phase);
  const conditions = (plan.conditions ?? CONDITIONS) as Condition[];
  const byCondition = Object.fromEntries(conditions.map(condition => {
    const items = rows.filter(row => row.condition === condition);
    const terminals: Record<string, number> = {};
    for (const row of items) terminals[row.terminal] = (terminals[row.terminal] ?? 0) + 1;
    const gradePass = items.filter(row => row.grade?.passed).length;
    const integrityFail = items.filter(row => row.integrity?.violations?.length).length;
    return [condition, { runs: items.length, pass: items.filter(row => row.pass).length, rate: items.length ? items.filter(row => row.pass).length / items.length : NaN, gradePassAnyStatus: gradePass, integrityViolations: integrityFail, terminals, gradeErrors: items.filter(row => row.grade?.error).length, leakFlagged: items.filter(row => row.leakHits).length }];
  }));
  const ba: Paired | undefined = conditions.includes("A") && conditions.includes("B") ? paired(rows, "A", "B", { seed: `${plan.seed}/BA` }) : undefined;
  const bc: Paired | undefined = conditions.includes("C") && conditions.includes("B") ? paired(rows, "C", "B", { seed: `${plan.seed}/BC` }) : undefined;
  const ca: Paired | undefined = conditions.includes("C") && conditions.includes("A") ? paired(rows, "A", "C", { seed: `${plan.seed}/CA` }) : undefined;
  const strata: Record<string, any> = {};
  for (const stratum of [...new Set(plan.tasks.map((item: any) => item.stratum))] as string[]) {
    const subset = rows.filter(row => row.stratum === stratum);
    strata[stratum] = Object.fromEntries(conditions.map(condition => { const items = subset.filter(row => row.condition === condition); return [condition, `${items.filter(row => row.pass).length}/${items.length}`]; }));
  }
  const kinds: Record<string, any> = {};
  for (const kind of [...new Set(plan.tasks.map((item: any) => item.kind))] as string[]) {
    const tasks = new Set(plan.tasks.filter((item: any) => item.kind === kind).map((item: any) => item.task));
    const subset = rows.filter(row => tasks.has(row.task));
    kinds[kind] = Object.fromEntries(conditions.map(condition => { const items = subset.filter(row => row.condition === condition); return [condition, `${items.filter(row => row.pass).length}/${items.length}`]; }));
  }
  const perTask = plan.tasks.map((item: any) => ({
    task: item.task, stratum: item.stratum, kind: item.kind,
    ...Object.fromEntries(conditions.map(condition => [condition, rows.filter(row => row.task === item.task && row.condition === condition).sort((a, b) => a.repeat - b.repeat).map(row => `${row.pass ? "P" : "F"}(${row.terminal}${row.grade && !row.grade.passed ? ",grade-fail" : ""}${row.integrity?.violations?.length ? ",integrity" : ""})`).join(" ")])),
    ...(conditions.includes("C") ? { cOracle: rows.filter(row => row.task === item.task && row.condition === "C").map(row => row.oraclePass ? "P" : "F").join(" ") } : {}),
  }));
  // Usage: wire totals per condition (C = its k attempts + the selection).
  const usage = Object.fromEntries(conditions.map(condition => {
    const units = condition === "C" ? [...attempts.filter(row => row.condition === "C"), ...rows.filter(row => row.condition === "C")] : rows.filter(row => row.condition === condition);
    const tops = rows.filter(row => row.condition === condition).length || 1;
    const sum = (key: string) => units.reduce((total, row) => total + (row.wire?.[key] ?? 0), 0);
    const selection = rows.filter(row => row.condition === "C").reduce((total, row) => total + (row.wire?.output ?? 0), 0);
    return [condition, {
      requestsPerRun: sum("requests") / tops, outputTokensPerRun: sum("output") / tops, reasoningTokensPerRun: sum("reasoning") / tops, inputTokensPerRun: sum("input") / tops, cachedTokensPerRun: sum("cached") / tops,
      usageMissing: sum("usageMissing"), non200: sum("non200"), transportErrors: sum("errors"), streamErrors: sum("streamErrors"), errorRate: sum("requests") ? (sum("non200") + sum("errors") + sum("streamErrors")) / sum("requests") : NaN,
      meanLatencyMs: sum("requests") ? sum("latencyMsTotal") / sum("requests") : NaN,
      wallMinPerRun: units.reduce((total, row) => total + (row.wallMs ?? 0), 0) / tops / 60_000,
      ...(condition === "C" ? { selectionOutputTokensPerRun: selection / tops, attempts: attempts.filter(row => row.condition === "C").length } : {}),
    }];
  }));
  const routes: Record<string, number> = {};
  const unexpected: string[] = [];
  for (const row of [...rows, ...attempts]) {
    for (const [key, value] of Object.entries(row.wire?.byRoute ?? {})) routes[`${row.condition}|${key}`] = (routes[`${row.condition}|${key}`] ?? 0) + (value as number);
    for (const item of row.wire?.unexpected ?? []) unexpected.push(`${row.task}/${row.condition}/r${row.repeat}${row.attempt ? `/a${row.attempt}` : ""}: ${item}`);
  }
  const orcheModes: Record<string, number> = {};
  for (const row of [...rows, ...attempts]) for (const task of row.tasks ?? []) { const key = `${row.condition}|mode ${task.mode}|tier ${task.tier}|${task.model}|${task.thinking}|${task.status}`; orcheModes[key] = (orcheModes[key] ?? 0) + 1; }
  const selections = rows.filter(row => row.condition === "C").map(row => ({ task: row.task, repeat: row.repeat, choice: row.selection?.choice, source: row.selection?.source, pass: row.pass, oracle: row.oraclePass }));
  const planned = (plan.order as unknown[]).length;
  return {
    phase, planned, completedUnits: planned - notRun.length, notRun, kept,
    k: plan.k, tasks: plan.tasks.length, repeats: plan.repeats, byCondition, paired: { BminusA: ba, BminusC: bc, CminusA: ca },
    verdict: ba ? verdict(ba, bc) : undefined, strata, kinds, perTask, usage, routes, unexpected, orcheModes, selections,
    integrity: [...rows, ...attempts].filter(row => row.integrity?.violations?.length || row.integrity?.suspicious?.length).map(row => ({ id: `${row.task}/${row.condition}/r${row.repeat}${row.attempt ? `/a${row.attempt}` : ""}`, violations: row.integrity.violations, suspicious: row.integrity.suspicious })),
    leaks: [...rows, ...attempts].filter(row => row.leakHits).map(row => `${row.task}/${row.condition}/r${row.repeat}${row.attempt ? `/a${row.attempt}` : ""}: ${row.leakHits}`),
    infra: [...rows, ...attempts].filter(row => row.infra).map(row => `${row.task}/${row.condition}/r${row.repeat}${row.attempt ? `/a${row.attempt}` : ""}: ${String(row.infra).slice(0, 200)}`),
    taskRates: Object.fromEntries(conditions.map(condition => [condition, Object.fromEntries(taskRates(rows, condition))])),
  };
}

export function markdown(summary: ReturnType<typeof summarize>): string {
  const lines: string[] = [];
  lines.push(`# ultra A/B/C — ${summary.phase}`, "", `planned units ${summary.planned}, completed ${summary.completedUnits}, not run ${summary.notRun.length}; tasks ${summary.tasks} × repeats ${summary.repeats}; C k=${summary.k}`, "");
  lines.push("| condition | primary pass | rate | grade pass (any status) | integrity violations | terminal statuses |", "|---|---:|---:|---:|---:|---|");
  for (const [condition, value] of Object.entries(summary.byCondition) as [string, any][]) lines.push(`| ${condition} | ${value.pass}/${value.runs} | ${pct(value.rate)} | ${value.gradePassAnyStatus} | ${value.integrityViolations} | ${JSON.stringify(value.terminals)} |`);
  lines.push("", "| comparison | tasks | mean diff | 95% task bootstrap | better/worse/same | sign test p | X fail→Y pass | X pass→Y fail |", "|---|---:|---:|---|---|---:|---:|---:|");
  for (const [name, value] of Object.entries(summary.paired) as [string, Paired | undefined][]) if (value) lines.push(`| ${name} | ${value.tasks} | ${pp(value.meanDiff)} | [${pp(value.ci95[0])}, ${pp(value.ci95[1])}] | ${value.better}/${value.worse}/${value.same} | ${value.signTestP.toFixed(3)} | ${value.xFailYPass.toFixed(2)} | ${value.xPassYFail.toFixed(2)} |`);
  lines.push("", `verdict (pre-registered rule): ${summary.verdict ?? "n/a"}`, "", "## per task", "", `| task | stratum | kind | ${Object.keys(summary.byCondition).join(" | ")} |${summary.perTask[0]?.cOracle !== undefined ? " C oracle |" : ""}`, `|---|---|---|${Object.keys(summary.byCondition).map(() => "---").join("|")}|${summary.perTask[0]?.cOracle !== undefined ? "---|" : ""}`);
  for (const row of summary.perTask) lines.push(`| ${row.task} | ${row.stratum} | ${row.kind} | ${Object.keys(summary.byCondition).map(condition => row[condition] || "not run").join(" | ")} |${row.cOracle !== undefined ? ` ${row.cOracle} |` : ""}`);
  lines.push("", "## strata", "", "```json", JSON.stringify({ strata: summary.strata, kinds: summary.kinds }, null, 1), "```", "", "## usage per top-level run (wire)", "", "```json", JSON.stringify(summary.usage, null, 1), "```");
  lines.push("", "## routes (condition|role|model|response model|effort|status)", "", "```json", JSON.stringify(summary.routes, null, 1), "```", "", `unexpected route/effort entries: ${summary.unexpected.length}`, ...summary.unexpected.slice(0, 30).map(item => `- ${item}`));
  lines.push("", "## orche task records (condition|mode|tier|model|thinking|status)", "", "```json", JSON.stringify(summary.orcheModes, null, 1), "```");
  if (summary.selections.length) lines.push("", "## C selections", "", ...summary.selections.map(item => `- ${item.task} r${item.repeat}: choice ${item.choice} (${item.source}), primary ${item.pass}, oracle ${item.oracle}`));
  lines.push("", "## integrity", "", ...(summary.integrity.length ? summary.integrity.map(item => `- ${item.id}: violations ${JSON.stringify(item.violations)}; suspicious ${JSON.stringify(item.suspicious)}`) : ["- none"]));
  lines.push("", "## leak audit (pattern hits, review manually)", "", ...(summary.leaks.length ? summary.leaks.map(item => `- ${item}`) : ["- none"]));
  lines.push("", "## infra", "", ...(summary.infra.length ? summary.infra.map(item => `- ${item}`) : ["- none"]), "", `kept attempts (interrupted/infra): ${summary.kept.length ? summary.kept.join(", ") : "none"}`, "", `not run: ${summary.notRun.length ? summary.notRun.join(", ") : "none"}`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const study = resolve(arg("--study")!), phase = arg("--phase")!;
  const summary = summarize(study, phase);
  await writeFile(join(study, `summary-${phase}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(study, `summary-${phase}.md`), markdown(summary));
  console.log(markdown(summary));
}
