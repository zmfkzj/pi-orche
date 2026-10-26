/**
 * Analysis of the strong-reflection hard-task bench (PREREGISTRATION.md). Grades each unit's pre-review state (O's checkpoint.diff
 * applied to the pristine snapshot; the same independent grader), checks replay fidelity, and writes summary.json / summary.md.
 *
 *   node --import tsx experiments/strong-reflection/bench/analyze.ts <bench dir> [--include-smoke]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gradeWorkspace, loadTask } from "../../ultra-ab/env.js";
import { STRONG_REFLECTION_PROMPT } from "../../../src/single/reflection.js";
import { loadWire, normalize } from "./wire.js";

const bench = process.argv[2] ? resolve(process.argv[2]) : "";
const includeSmoke = process.argv.includes("--include-smoke");
const read = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

/** Wilson 95% interval. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - r) / d, (c + r) / d];
}
/** Exact two-sided sign test on discordant pairs. */
export function signTest(plus: number, minus: number): number {
  const n = plus + minus;
  if (!n) return 1;
  const k = Math.min(plus, minus);
  let tail = 0;
  for (let i = 0; i <= k; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); tail += c / 2 ** n; }
  return Math.min(1, 2 * tail);
}

/** Pre-review grade: the snapshot plus the checkpoint patch. */
async function gradePatch(taskId: string, patch: string) {
  const task = await loadTask(taskId);
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "srb-cp-"));
  try {
    await cp(task.source, dir, { recursive: true, filter: path => !path.endsWith("/.git") });
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    if (readFileSync(patch, "utf8").trim()) execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", patch], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    await rm(join(dir, ".git"), { recursive: true, force: true });
    const { grade, integrity } = await gradeWorkspace(task, dir);
    return { pass: grade.passed && integrity.violations.length === 0, grade: grade.passed, violations: integrity.violations.length, checks: Object.fromEntries(Object.entries(grade.checks).map(([name, check]) => [name, check.passed])) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The top worker's request at the reflection point, normalized, the reflection text removed (R1). */
const REFLECTION = /\n*Reflection before your self-review \(strong mode, single\.strongReflection; integration node [^)]*\):\n[\s\S]*?report format are unchanged\./g;
const strip = (value: unknown): unknown => typeof value === "string" ? value.replace(REFLECTION, "") : Array.isArray(value) ? value.map(strip) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)])) : value;
/** Tool-output noise of re-executed commands: elapsed times and object addresses (documented in docs/strong-reflection.md). */
export const toolNoise = (text: string): string => text.replace(/0x[0-9a-f]{6,16}/g, "<addr>").replace(/\b\d+(?:\.\d+)?(?:s| seconds?|ms)\b/g, "<dur>").replace(/duration_ms \d+(?:\.\d+)?/g, "duration_ms <dur>").replace(/(localhost|127\.0\.0\.1):\d{2,5}/g, "$1:<port>");
/** The same item up to line order (parallel search tools such as rg print matches in nondeterministic order). */
const lineSet = (text: string): string => text.split("\\n").sort().join("\\n");
function checkpointItems(file: string): string[] | undefined {
  const saved = read(file);
  return saved ? (strip(saved.request.input) as unknown[]).map(item => toolNoise(normalize(JSON.stringify(item)))) : undefined;
}
/** Items that differ between two reflection-point requests: raw (only the reflection removed) and after the tool-noise rule. */
function compareRequests(a: string, b: string): { items: number; raw: number; normalized: number; orderOnly: number } | null {
  const x = read(a), y = read(b);
  if (!x || !y) return null;
  const rx = (strip(x.request.input) as unknown[]).map(item => normalize(JSON.stringify(item))), ry = (strip(y.request.input) as unknown[]).map(item => normalize(JSON.stringify(item)));
  const nx = checkpointItems(a)!, ny = checkpointItems(b)!;
  const diff = (p: string[], q: string[]) => Math.abs(p.length - q.length) + p.filter((item, i) => item !== q[i]).length;
  return { items: rx.length, raw: diff(rx, ry), normalized: diff(nx, ny), orderOnly: diff(nx.map(lineSet), ny.map(lineSet)) };
}
const has = (file: string, text: string) => existsSync(file) && readFileSync(file, "utf8").includes(JSON.stringify(text).slice(1, -1));

async function main() {
  if (!bench) throw new Error("usage: analyze.ts <bench dir> [--include-smoke]");
  const root = join(bench, "units");
  const rows: any[] = [];
  for (const unit of readdirSync(root).sort()) {
    if (unit.startsWith("smoke-") && !includeSmoke) continue;
    const dir = join(root, unit);
    const o = read(join(dir, "O/meta.json"));
    if (!o) { rows.push({ unit, missing: "O" }); continue; }
    const r0 = read(join(dir, "R0/meta.json")), r1 = read(join(dir, "R1/meta.json"));
    // Pre-review state: O's checkpoint patch; a report-point O that ended at its report has no next request, so its final state is it.
    const patch = existsSync(join(dir, "O/checkpoint.diff")) ? join(dir, "O/checkpoint.diff") : o.checkpoint?.kind === "report" ? join(dir, "O/final.diff") : undefined;
    const pre = patch ? await gradePatch(o.task, patch) : undefined;
    const oHash = o.checkpointState?.hash ?? (o.checkpoint?.kind === "report" ? o.finalState?.hash : undefined);
    const armHash = (m: any) => m?.checkpointState?.hash ?? (m?.checkpoint?.kind === "report" && !m?.replay?.switched ? m?.finalState?.hash : undefined);
    const topDivergence = (m: any) => (m?.replay?.events ?? []).filter((event: any) => event.type === "divergence" && event.detail.startsWith("TOP")).length;
    const fidelity = r0 && r1 ? {
      sameState: !!oHash && armHash(r0) === oHash && armHash(r1) === oHash,
      states: { O: oHash?.slice(0, 12), R0: armHash(r0)?.slice(0, 12), R1: armHash(r1)?.slice(0, 12) },
      topDivergences: { R0: topDivergence(r0), R1: topDivergence(r1) },
      otherDivergences: { R0: (r0.replay?.events ?? []).filter((e: any) => e.type === "divergence").length - topDivergence(r0), R1: (r1.replay?.events ?? []).filter((e: any) => e.type === "divergence").length - topDivergence(r1) },
      requestR0R1: compareRequests(join(dir, "R0/checkpoint-request.json"), join(dir, "R1/checkpoint-request.json")),
      requestOR0: compareRequests(join(dir, "O/checkpoint-request.json"), join(dir, "R0/checkpoint-request.json")),
      sameRequest: compareRequests(join(dir, "R0/checkpoint-request.json"), join(dir, "R1/checkpoint-request.json"))?.normalized === 0,
      r1HasPrompt: has(join(dir, "R1/checkpoint-request.json"), STRONG_REFLECTION_PROMPT),
      r0HasPrompt: has(join(dir, "R0/checkpoint-request.json"), STRONG_REFLECTION_PROMPT),
    } : undefined;
    const valid = !!fidelity && fidelity.sameState && !fidelity.topDivergences.R0 && !fidelity.topDivergences.R1 && !fidelity.r0HasPrompt && (fidelity.r1HasPrompt || o.checkpoint?.kind === "report");
    const arm = (m: any) => m && { pass: m.primaryPass, terminal: m.terminal, grade: m.grade?.passed, violations: m.integrity?.violations?.length ?? 0, costUsd: m.wire?.liveCostUsd ?? 0, live: m.wire?.live, replayed: m.wire?.replayed, minutes: Math.round((m.durationMs ?? 0) / 600) / 100, requested: m.wire?.requested, reflection: m.reflection, leaks: m.leaks?.length ?? 0, finalHash: m.finalState?.hash?.slice(0, 12) };
    // Did the review (after the reflection point) change the work? The arm's own checkpoint.diff vs its final.diff (same format).
    const changed = (name: string) => { const a = join(dir, name, "checkpoint.diff"), b = join(dir, name, "final.diff"); return existsSync(a) && existsSync(b) ? readFileSync(a, "utf8") !== readFileSync(b, "utf8") : undefined; };
    const reviewChanged = { O: changed("O"), R0: changed("R0"), R1: changed("R1") };
    // The live review stage of the top worker in R0/R1: requests, output tokens, tool calls (from the SSE output items).
    const stage = (name: string) => {
      const file = join(dir, name, "wire.jsonl");
      if (!existsSync(file)) return undefined;
      const live = loadWire(file).filter(entry => entry.mode === "live" && entry.top);
      const calls = live.flatMap(entry => entry.response.split("\n").filter(line => line.startsWith("data: ") && line.includes('"response.output_item.done"')).flatMap(line => { try { const item = JSON.parse(line.slice(6)).item; return item?.type === "function_call" ? [item.name as string] : []; } catch { return []; } }));
      return { requests: live.length, output: live.reduce((sum, entry) => sum + (entry.usage?.output ?? 0), 0), toolCalls: calls.length, edits: calls.filter(name => name === "edit" || name === "write").length };
    };
    const reviewStage = { R0: stage("R0"), R1: stage("R1") };
    rows.push({ unit, task: o.task, checkpoint: o.checkpoint, pre, O: arm(o), R0: arm(r0), R1: arm(r1), fidelity, valid, reviewChanged, reviewStage });
  }
  const units = rows.filter(row => row.O);
  const tasks = [...new Set(units.map(row => row.task))];
  const count = (items: any[], pick: (row: any) => boolean) => items.filter(pick).length;
  const baseline = { pass: count(units, row => row.O.pass), n: units.length };
  const valid = units.filter(row => row.valid);
  const pairs = {
    n: valid.length,
    R0: count(valid, row => row.R0.pass), R1: count(valid, row => row.R1.pass),
    bothPass: count(valid, row => row.R0.pass && row.R1.pass), neither: count(valid, row => !row.R0.pass && !row.R1.pass),
    r1Only: count(valid, row => !row.R0.pass && row.R1.pass), r0Only: count(valid, row => row.R0.pass && !row.R1.pass),
  };
  const transitions = (key: "O" | "R0" | "R1", items: any[]) => ({
    n: items.length,
    wrongToRight: count(items, row => row.pre && !row.pre.pass && row[key]?.pass),
    rightToWrong: count(items, row => row.pre && row.pre.pass && !row[key]?.pass),
    stayedWrong: count(items, row => row.pre && !row.pre.pass && !row[key]?.pass),
    stayedRight: count(items, row => row.pre && row.pre.pass && row[key]?.pass),
    reviewChangedWork: count(items, row => row.reviewChanged?.[key] === true),
  });
  const cost = (key: "O" | "R0" | "R1") => Number(units.reduce((sum, row) => sum + (row[key]?.costUsd ?? 0), 0).toFixed(2));
  const summary = {
    baseline: { ...baseline, rate: baseline.n ? baseline.pass / baseline.n : 0, wilson95: wilson(baseline.pass, baseline.n), below60: baseline.n > 0 && baseline.pass / baseline.n < 0.6 },
    preReview: { pass: count(units, row => row.pre?.pass), n: count(units, row => !!row.pre) },
    perTask: Object.fromEntries(tasks.map(task => { const items = units.filter(row => row.task === task); return [task, { O: `${count(items, row => row.O.pass)}/${items.length}`, pre: `${count(items, row => row.pre?.pass)}/${count(items, row => !!row.pre)}`, R0: `${count(items, row => row.valid && row.R0.pass)}/${count(items, row => row.valid)}`, R1: `${count(items, row => row.valid && row.R1.pass)}/${count(items, row => row.valid)}` }]; })),
    pairs: { ...pairs, signTestP: signTest(pairs.r1Only, pairs.r0Only) },
    transitions: { O: transitions("O", units), R0: transitions("R0", valid), R1: transitions("R1", valid) },
    invalid: units.filter(row => !row.valid).map(row => ({ unit: row.unit, reason: !row.fidelity ? "no replays" : JSON.stringify({ sameState: row.fidelity.sameState, top: row.fidelity.topDivergences, r1HasPrompt: row.fidelity.r1HasPrompt }) })),
    costUsd: { O: cost("O"), R0: cost("R0"), R1: cost("R1"), total: Number((cost("O") + cost("R0") + cost("R1")).toFixed(2)) },
    reviewStage: Object.fromEntries((["R0", "R1"] as const).map(name => [name, valid.reduce((acc, row) => { const st = row.reviewStage?.[name]; return st ? { requests: acc.requests + st.requests, output: acc.output + st.output, toolCalls: acc.toolCalls + st.toolCalls, edits: acc.edits + st.edits } : acc; }, { requests: 0, output: 0, toolCalls: 0, edits: 0 })])),
    leaks: units.reduce((sum, row) => sum + (row.O.leaks ?? 0) + (row.R0?.leaks ?? 0) + (row.R1?.leaks ?? 0), 0),
  };
  await writeFile(join(bench, "summary.json"), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const md = [
    `# strong-reflection hard-task bench — ${new Date().toISOString()}`,
    "",
    `Baseline (O, unmodified strong): **${baseline.pass}/${baseline.n}** = ${pct(summary.baseline.rate)} (Wilson 95% ${pct(summary.baseline.wilson95[0])}–${pct(summary.baseline.wilson95[1])}); below 60%: ${summary.baseline.below60}`,
    `Pre-review state (O at the reflection point): ${summary.preReview.pass}/${summary.preReview.n}`,
    `Paired (valid units ${pairs.n}): R0 ${pairs.R0}/${pairs.n}, R1 ${pairs.R1}/${pairs.n}; R1-only ${pairs.r1Only}, R0-only ${pairs.r0Only}, both ${pairs.bothPass}, neither ${pairs.neither}; sign test p = ${summary.pairs.signTestP.toFixed(3)}`,
    "",
    "| task | O | pre-review | R0 | R1 |", "|---|---|---|---|---|",
    ...Object.entries(summary.perTask).map(([task, v]: any) => `| ${task} | ${v.O} | ${v.pre} | ${v.R0} | ${v.R1} |`),
    "",
    "| unit | point | pre | O | R0 | R1 | fidelity (same state, top divergences R0/R1, differing request items: raw → after the tool-noise rule → also ignoring line order) | review changed work O/R0/R1 | R1 delivered | live $ O/R0/R1 |", "|---|---|---|---|---|---|---|---|---|---|",
    ...units.map(row => `| ${row.unit} | ${row.checkpoint?.kind ?? "-"}${row.checkpoint?.node ? ` ${row.checkpoint.node}` : ""} #${row.checkpoint?.ordinal ?? "-"} | ${row.pre ? (row.pre.pass ? "P" : "F") : "-"} | ${row.O.pass ? "P" : "F"} (${row.O.terminal}) | ${row.R0 ? `${row.R0.pass ? "P" : "F"} (${row.R0.terminal})` : "-"} | ${row.R1 ? `${row.R1.pass ? "P" : "F"} (${row.R1.terminal})` : "-"} | ${row.fidelity ? `${row.fidelity.sameState}, ${row.fidelity.topDivergences.R0}/${row.fidelity.topDivergences.R1}, R0≠R1 ${row.fidelity.requestR0R1?.raw}→${row.fidelity.requestR0R1?.normalized}→${row.fidelity.requestR0R1?.orderOnly} of ${row.fidelity.requestR0R1?.items}, O≠R0 ${row.fidelity.requestOR0?.raw}→${row.fidelity.requestOR0?.normalized}→${row.fidelity.requestOR0?.orderOnly}` : "-"}${row.valid ? "" : " INVALID"} | ${["O", "R0", "R1"].map(name => row.reviewChanged?.[name] === undefined ? "-" : row.reviewChanged[name] ? "y" : "n").join("/")} | ${row.R1?.reflection?.delivered ?? "-"} | ${row.O.costUsd}/${row.R0?.costUsd ?? "-"}/${row.R1?.costUsd ?? "-"} |`),
    "",
    `Transitions from the pre-review state: ${JSON.stringify(summary.transitions)}`,
    `Live review stage of the top worker (valid units): ${JSON.stringify(summary.reviewStage)}`,
    `Billed (live) cost USD: ${JSON.stringify(summary.costUsd)}; leak hits: ${summary.leaks}`,
    `Invalid units: ${JSON.stringify(summary.invalid)}`,
  ].join("\n");
  await writeFile(join(bench, "summary.md"), `${md}\n`);
  console.log(md);
}
if (process.argv[1]?.endsWith("analyze.ts")) await main();
