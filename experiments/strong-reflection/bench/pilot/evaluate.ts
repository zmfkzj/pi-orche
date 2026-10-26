/**
 * Read-out of the decision-audit pilot (PREREGISTRATION.md "Read-out"). Per unit and arm: validity (fidelity gate, refusals,
 * censoring), the objective grade and its per-check transitions from the pre-review state, the per-test transitions of the hidden
 * tests (pilot/diagnose.ts results, when present), the arm's own review change and the files it touched, live cost (token-priced
 * estimate), delivery persistence, automatic text signals (not adjudication) and the manual adjudication (`<pilot>/adjudication.json`);
 * then clusters, A vs B (descriptive), C0, the historical comparators, the spend reconciliation (ledger vs every recorded request,
 * including incomplete arms and infra retries) and the pre-declared verdict (protocol.ts `readout`, unchanged).
 * Writes <pilot>/summary.json and summary.md.
 *
 *   node --import tsx experiments/strong-reflection/bench/pilot/evaluate.ts <pilot dir>
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { costOf } from "../protocol.js";
import { loadWire } from "../wire.js";
import { BUDGET, CLUSTERS, JOBS, PILOT_HEADER, readout, type Cluster, type Outcome, type PilotArm } from "./protocol.js";

const readJson = (file: string): any => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

/** Per-file sections of a git diff. */
export function diffFiles(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^(?=diff --git )/m).filter(part => part.startsWith("diff --git "));
  for (const part of parts) out.set(/^diff --git a\/(\S+) b\//.exec(part)?.[1] ?? part.slice(0, 80), part);
  return out;
}
/** Files whose patch differs between two diffs of the same base. */
export function changedFiles(before: string, after: string): string[] {
  const a = diffFiles(before), b = diffFiles(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(file => a.get(file) !== b.get(file)).sort();
}

export interface TestTransitions { newlyFailing: string[]; newlyPassing: string[]; f2pFailing: string[]; p2pFailing: string[] }
interface Diagnosed { statuses: Record<string, string>; failToPass: { id: string; status: string }[]; passToPassFailing: { id: string; status: string }[] }
/** Per-test transitions of the hidden-test run between the pre-review state and a final state (diagnose.ts results). */
export function testTransitions(pre: Diagnosed, final: Diagnosed): TestTransitions {
  const bad = (status: string | undefined) => status === "FAILED" || status === "ERROR" || status === undefined;
  const ids = [...new Set([...Object.keys(pre.statuses), ...Object.keys(final.statuses)])].sort();
  return {
    newlyFailing: ids.filter(id => pre.statuses[id] === "PASSED" && bad(final.statuses[id])).map(id => final.statuses[id] ? id : `${id} (missing)`),
    newlyPassing: ids.filter(id => bad(pre.statuses[id]) && final.statuses[id] === "PASSED"),
    f2pFailing: final.failToPass.filter(test => test.status !== "PASSED").map(test => test.id),
    p2pFailing: final.passToPassFailing.map(test => test.id),
  };
}

export interface Reconciliation {
  ledger: { reservations: number; settlements: number; refusals: number; reservedUsd: number; settledUsd: number; outstandingUsd: number; committedUsd: number };
  wire: { files: number; live: number; withUsage: number; withoutUsage: number; usageUsd: number; refused: number; infraDirs: string[] };
  perArm: Record<string, { requests: number; live: number; withoutUsage: number; wireUsd: number; settledUsd: number; outstandingUsd: number; differenceUsd: number }>;
  differenceUsd: number;
}
/**
 * The ledger (every reservation, settlement and refusal) against every request recorded in the arms' wires, including arms without
 * meta.json and archived infra attempts (`<arm>.infra-N`). A live request without usage is settled at its reservation (interrupted)
 * or at 0 (an upstream error status); outstanding reservations stay committed.
 */
export function reconcile(pilot: string): Reconciliation {
  const reserved = new Map<string, { usd: number; key: string }>(), settled = new Map<string, number>();
  let refusals = 0;
  const ledgerFile = join(pilot, "budget/ledger.jsonl");
  if (existsSync(ledgerFile)) for (const line of readFileSync(ledgerFile, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.k === "r") reserved.set(entry.id, { usd: entry.usd, key: `${entry.unit}/${entry.arm}` });
    else if (entry.k === "s") settled.set(entry.id, entry.usd);
    else if (entry.k === "x") refusals++;
  }
  const perArm: Reconciliation["perArm"] = {};
  const arm = (key: string) => perArm[key] ??= { requests: 0, live: 0, withoutUsage: 0, wireUsd: 0, settledUsd: 0, outstandingUsd: 0, differenceUsd: 0 };
  let reservedUsd = 0, settledUsd = 0, outstandingUsd = 0;
  for (const [id, item] of reserved) {
    reservedUsd += item.usd;
    const row = arm(item.key);
    row.requests++;
    if (settled.has(id)) { settledUsd += settled.get(id)!; row.settledUsd += settled.get(id)!; } else { outstandingUsd += item.usd; row.outstandingUsd += item.usd; }
  }
  const wire = { files: 0, live: 0, withUsage: 0, withoutUsage: 0, usageUsd: 0, refused: 0, infraDirs: [] as string[] };
  const unitsDir = join(pilot, "units");
  for (const unit of existsSync(unitsDir) ? readdirSync(unitsDir) : []) {
    for (const dir of readdirSync(join(unitsDir, unit))) {
      const file = join(unitsDir, unit, dir, "wire.jsonl");
      if (!existsSync(file)) continue;
      if (dir.includes(".infra-")) wire.infraDirs.push(`${unit}/${dir}`);
      wire.files++;
      const row = arm(`${unit}/${dir.replace(/\.infra-\d+$/, "")}`);
      for (const entry of loadWire(file)) {
        if (entry.mode === "refused") { wire.refused++; continue; }
        if (entry.mode !== "live") continue;
        wire.live++; row.live++;
        if (entry.usage) { const usd = costOf(entry.usage); wire.withUsage++; wire.usageUsd += usd; row.wireUsd += usd; } else { wire.withoutUsage++; row.withoutUsage++; }
      }
    }
  }
  const round = (value: number) => Number(value.toFixed(4));
  for (const row of Object.values(perArm)) { row.differenceUsd = round(row.settledUsd + row.outstandingUsd - row.wireUsd); row.wireUsd = round(row.wireUsd); row.settledUsd = round(row.settledUsd); row.outstandingUsd = round(row.outstandingUsd); }
  return {
    ledger: { reservations: reserved.size, settlements: settled.size, refusals, reservedUsd: round(reservedUsd), settledUsd: round(settledUsd), outstandingUsd: round(outstandingUsd), committedUsd: round(settledUsd + outstandingUsd) },
    wire: { ...wire, usageUsd: round(wire.usageUsd) },
    perArm,
    differenceUsd: round(settledUsd + outstandingUsd - wire.usageUsd),
  };
}

/** Output items of the live top-worker responses: messages and tool calls. */
function liveItems(wireFile: string) {
  const live = existsSync(wireFile) ? loadWire(wireFile).filter(entry => entry.mode === "live" && entry.top) : [];
  const items = live.flatMap(entry => entry.response.split("\n").filter(line => line.startsWith("data: ") && line.includes('"response.output_item.done"')).flatMap(line => { try { return [JSON.parse(line.slice(6)).item]; } catch { return []; } }));
  return { live, items };
}

export interface ArmRow {
  unit: string; arm: PilotArm; cluster: Cluster; tier: number;
  status: "valid" | "gate-failed" | "censored" | "incomplete" | "not run";
  reason?: string;
  terminal?: string; pass?: boolean; grade?: boolean; violations?: number;
  checks?: Record<string, boolean>; newlyBroken?: string[]; newlyFixed?: string[]; failingDetail?: Record<string, string>;
  tests?: TestTransitions;
  reviewChanged?: boolean; changedFiles?: string[];
  costUsd?: number; liveRequests?: number; outputTokens?: number; toolCalls?: number; edits?: number; minutes?: number;
  fidelity?: { ok: boolean; sameState: boolean; problems: string[]; outputs: { raw: number; normalized: number; orderOnly: number } };
  delivery?: { liveTopRequests: number; withText: number };
  requested?: string[]; leaks?: number;
  signals?: { auditWords: boolean; ranOriginal: boolean; uncertainty: boolean };
  adjudication?: { adherence?: "full" | "partial" | "none"; mechanism?: boolean; decisionSurfaced?: boolean; decisionChanged?: boolean; evidence?: string; notes?: string };
}

export function armRow(pilot: string, unit: string, arm: PilotArm, preChecks: Record<string, boolean> | undefined, adjudication: any): ArmRow {
  const job = JOBS.find(item => item.unit === unit)!;
  const dir = join(pilot, "units", unit, arm);
  const base = { unit, arm, cluster: job.cluster, tier: job.tier };
  const meta = readJson(join(dir, "meta.json"));
  const fidelity = readJson(join(dir, "fidelity.json"));
  if (!meta) {
    if (existsSync(join(dir, "gate-failed.json"))) return { ...base, status: "gate-failed", reason: (readJson(join(dir, "gate-failed.json"))?.problems ?? []).join("; ") };
    return { ...base, status: existsSync(dir) ? "incomplete" : "not run" };
  }
  const checks = Object.fromEntries(Object.entries(meta.grade?.checks ?? {}).map(([name, check]: [string, any]) => [name, !!check.passed]));
  const failingDetail = Object.fromEntries(Object.entries(meta.grade?.checks ?? {}).filter(([, check]: [string, any]) => !check.passed).map(([name, check]: [string, any]) => [name, String(check.detail).slice(0, 600)]));
  const before = existsSync(join(dir, "checkpoint.diff")) ? readFileSync(join(dir, "checkpoint.diff"), "utf8") : undefined;
  const after = existsSync(join(dir, "final.diff")) ? readFileSync(join(dir, "final.diff"), "utf8") : undefined;
  const { live, items } = liveItems(join(dir, "wire.jsonl"));
  const calls = items.filter((item: any) => item?.type === "function_call");
  const texts = items.filter((item: any) => item?.type === "message").map((item: any) => (item.content ?? []).map((part: any) => part?.text ?? "").join("")).join("\n");
  const header = PILOT_HEADER(meta.checkpoint?.node ?? "verify");
  const censored = !!meta.proxyHalted;
  const valid = !!meta.fidelity?.ok && !censored;
  const pre = readJson(join(pilot, "diagnostics", unit, "pre.json")), final = readJson(join(pilot, "diagnostics", unit, `${arm}-final.json`));
  return {
    ...base,
    status: valid ? "valid" : censored ? "censored" : "gate-failed",
    ...(censored ? { reason: meta.proxyHalted } : !meta.fidelity?.ok ? { reason: (meta.fidelity?.problems ?? ["no fidelity record"]).join("; ") } : {}),
    terminal: meta.terminal, pass: !!meta.primaryPass, grade: !!meta.grade?.passed, violations: meta.integrity?.violations?.length ?? 0,
    checks, failingDetail,
    newlyBroken: preChecks ? Object.keys(checks).filter(name => preChecks[name] === true && !checks[name]) : [],
    newlyFixed: preChecks ? Object.keys(checks).filter(name => preChecks[name] === false && checks[name]) : [],
    ...(pre?.statuses && final?.statuses && Object.keys(pre.statuses).length ? { tests: testTransitions(pre, final) } : {}),
    reviewChanged: before !== undefined && after !== undefined ? before !== after : undefined,
    changedFiles: before !== undefined && after !== undefined ? changedFiles(before, after) : undefined,
    costUsd: meta.wire?.liveCostUsd ?? 0, liveRequests: meta.wire?.live ?? 0, outputTokens: meta.wire?.liveUsage?.output ?? 0,
    toolCalls: calls.length, edits: calls.filter((item: any) => item.name === "edit" || item.name === "write").length, minutes: Math.round((meta.durationMs ?? 0) / 600) / 100,
    fidelity: fidelity ? { ok: !!fidelity.ok, sameState: !!fidelity.sameState, problems: fidelity.problems ?? [], outputs: { raw: fidelity.outputs?.raw ?? 0, normalized: fidelity.outputs?.normalized ?? 0, orderOnly: fidelity.outputs?.orderOnly ?? 0 } } : undefined,
    delivery: { liveTopRequests: live.length, withText: arm === "C0" ? 0 : live.filter(entry => JSON.stringify(entry.request?.input ?? []).includes(header)).length },
    requested: meta.wire?.requested, leaks: meta.leaks?.length ?? 0,
    signals: {
      auditWords: /decision audit|\b(requested|necessary|collateral)\b/i.test(texts),
      ranOriginal: calls.some((item: any) => /git (show|stash|worktree|archive)|HEAD:|pristine|baseline/i.test(String(item.arguments ?? ""))),
      uncertainty: /uncertain|open question|ambigu/i.test(String(meta.resultText ?? "")),
    },
    adjudication: adjudication?.[`${unit}/${arm}`],
  };
}

async function main(): Promise<void> {
  const pilot = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("usage: evaluate.ts <pilot dir>");
  const source = resolve(pilot, "../bench-2026-10-19");
  const sourceRows = new Map<string, any>((readJson(join(source, "summary.json"))?.rows ?? []).map((row: any) => [row.unit, row]));
  const adjudication = readJson(join(pilot, "adjudication.json")) ?? {};
  const rows: ArmRow[] = [];
  const units = JOBS.map(job => {
    const src = sourceRows.get(job.unit);
    const hist = Object.fromEntries(["O", "R0", "R1"].map(arm => { const meta = readJson(join(source, "units", job.unit, arm, "meta.json")); return [arm, meta ? { pass: !!meta.primaryPass, costUsd: meta.wire?.liveCostUsd ?? 0 } : undefined]; }));
    const arms = job.arms.map(arm => armRow(pilot, job.unit, arm, src?.pre?.checks, adjudication));
    rows.push(...arms);
    return { unit: job.unit, cluster: job.cluster, tier: job.tier, order: job.arms, pre: src?.pre, hist, arms: Object.fromEntries(arms.map(row => [row.arm, row])) };
  });
  const outcomes: Outcome[] = rows.map(row => ({ unit: row.unit, arm: row.arm, valid: row.status === "valid", pass: !!row.pass, prePass: !!units.find(unit => unit.unit === row.unit)?.pre?.pass, mechanism: row.adjudication?.mechanism, adherence: row.adjudication?.adherence }));
  const verdict = readout(outcomes);
  const count = (arm: PilotArm, status: ArmRow["status"]) => rows.filter(row => row.arm === arm && row.status === status).length;
  const coverage = Object.fromEntries((["A", "B", "C0"] as const).map(arm => [arm, { planned: rows.filter(row => row.arm === arm).length, valid: count(arm, "valid"), gateFailed: count(arm, "gate-failed"), censored: count(arm, "censored"), incomplete: count(arm, "incomplete"), notRun: count(arm, "not run") }]));
  const transitions = Object.fromEntries((["A", "B", "C0"] as const).map(arm => {
    const valid = rows.filter(row => row.arm === arm && row.status === "valid");
    const pre = (row: ArmRow) => !!units.find(unit => unit.unit === row.unit)?.pre?.pass;
    return [arm, { n: valid.length, wrongToRight: valid.filter(row => !pre(row) && row.pass).length, rightToWrong: valid.filter(row => pre(row) && !row.pass).length, stayedWrong: valid.filter(row => !pre(row) && !row.pass).length, stayedRight: valid.filter(row => pre(row) && row.pass).length, newlyBrokenChecks: valid.reduce((sum, row) => sum + (row.newlyBroken?.length ?? 0), 0), newlyFailingHiddenTests: valid.reduce((sum, row) => sum + (row.tests?.newlyFailing.length ?? 0), 0), newlyPassingHiddenTests: valid.reduce((sum, row) => sum + (row.tests?.newlyPassing.length ?? 0), 0), reviewChangedWork: valid.filter(row => row.reviewChanged).length }];
  }));
  const clusters = Object.fromEntries((Object.keys(CLUSTERS) as Cluster[]).map(cluster => [cluster, Object.fromEntries((["A", "B", "C0"] as const).map(arm => {
    const items = rows.filter(row => row.cluster === cluster && row.arm === arm);
    return [arm, { valid: items.filter(row => row.status === "valid").length, of: items.length, passes: items.filter(row => row.status === "valid" && row.pass).map(row => row.unit) }];
  }))]));
  const failing = units.filter(unit => unit.pre && !unit.pre.pass);
  const concordance = { both: 0, aOnly: 0, bOnly: 0, neither: 0, incomplete: 0 };
  for (const unit of failing) {
    const a = unit.arms.A, b = unit.arms.B;
    if (a?.status !== "valid" || b?.status !== "valid") { concordance.incomplete++; continue; }
    if (a.pass && b.pass) concordance.both++; else if (a.pass) concordance.aOnly++; else if (b.pass) concordance.bOnly++; else concordance.neither++;
  }
  const cost = Object.fromEntries((["A", "B", "C0"] as const).map(arm => [arm, Number(rows.filter(row => row.arm === arm).reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(4))]));
  const reconciliation = reconcile(pilot);
  const truncation = readJson(join(pilot, "truncation.json"));
  const summary = { coverage, transitions, clusters, concordance, verdict, cost: { ...cost, total: Number(Object.values(cost).reduce((sum, value) => sum + value, 0).toFixed(4)), capUsd: BUDGET.capUsd, basis: "token-priced estimate at the gpt-6-astra list price (input 10, cache read 1, output 50 USD per million tokens); the provider reports tokens, not charges" }, reconciliation, truncation, leaks: rows.reduce((sum, row) => sum + (row.leaks ?? 0), 0), requested: [...new Set(rows.flatMap(row => row.requested ?? []))] };
  await writeFile(join(pilot, "summary.json"), `${JSON.stringify({ summary, units }, null, 2)}\n`);

  const cell = (row: ArmRow | undefined) => !row ? "-" : row.status !== "valid" ? row.status : `${row.pass ? "P" : "F"}${row.newlyBroken?.length ? ` broke ${row.newlyBroken.join("+")}` : ""}${row.newlyFixed?.length ? ` fixed ${row.newlyFixed.join("+")}` : ""}${row.reviewChanged ? " Δ" : ""} $${row.costUsd?.toFixed(2)}`;
  const list = (items: string[] | undefined) => items?.length ? items.join(", ") : "none";
  const md = [
    `# Decision-audit rescue pilot — read-out (${new Date().toISOString()})`,
    "",
    `Verdict (pre-declared, per arm): **${verdict.overall}** — ${verdict.reasons.join("; ")}`,
    ...(["A", "B"] as const).map(arm => `- ${arm}: go ${verdict.perArm[arm].go}, stop ${verdict.perArm[arm].stop}; rescues ${JSON.stringify(verdict.perArm[arm].rescues)}; unexplained passes ${list(verdict.perArm[arm].unexplainedPasses)}; policy passes ${list(verdict.perArm[arm].policyPasses)}; d1 regressions ${list(verdict.perArm[arm].d1Regressions)}; audit carried out in ${verdict.perArm[arm].adherentReachable}/6 reachable units${verdict.perArm[arm].reasons.length ? `; ${verdict.perArm[arm].reasons.join("; ")}` : ""}`),
    `- C0 (contemporaneous, tox): ${verdict.c0.tox}/${verdict.c0.valid} passes${verdict.c0.passes.length ? ` (${verdict.c0.passes.join(", ")})` : ""}`,
    "",
    `Coverage: ${JSON.stringify(coverage)}${truncation?.truncated?.length ? `; not run (budget): ${truncation.truncated.join(", ")}` : ""}`,
    `Transitions from the pre-review state (valid arms): ${JSON.stringify(transitions)}`,
    `A vs B on the failing units (descriptive): ${JSON.stringify(concordance)}`,
    `Live cost USD (${summary.cost.basis}): A ${cost.A}, B ${cost.B}, C0 ${cost.C0}, total ${summary.cost.total} of the ${BUDGET.capUsd} cap; leaks ${summary.leaks}; models/efforts requested ${summary.requested.join(", ")}`,
    `Spend reconciliation: ledger ${reconciliation.ledger.reservations} reservations (${reconciliation.ledger.reservedUsd} USD reserved), ${reconciliation.ledger.settlements} settled at ${reconciliation.ledger.settledUsd}, outstanding ${reconciliation.ledger.outstandingUsd}, committed ${reconciliation.ledger.committedUsd}, ${reconciliation.ledger.refusals} refusals; wires ${reconciliation.wire.files} files, ${reconciliation.wire.live} live requests (${reconciliation.wire.withUsage} with usage = ${reconciliation.wire.usageUsd} USD, ${reconciliation.wire.withoutUsage} without usage), ${reconciliation.wire.refused} refused, infra archives ${list(reconciliation.wire.infraDirs)}; committed − wire usage = ${reconciliation.differenceUsd} USD`,
    "",
    "| unit | cluster | pre | O / R0 / R1 (2026-10-19) | order | A | B | C0 |", "|---|---|---|---|---|---|---|---|",
    ...units.map(unit => `| ${unit.unit} | ${unit.cluster} | ${unit.pre ? (unit.pre.pass ? "P" : "F") : "-"} | ${["O", "R0", "R1"].map(arm => unit.hist[arm] ? (unit.hist[arm].pass ? "P" : "F") : "-").join(" / ")} | ${unit.order.join(">")} | ${cell(unit.arms.A)} | ${cell(unit.arms.B)} | ${cell(unit.arms.C0)} |`),
    "",
    "| unit | arm | status | fidelity (same state; tool outputs differing raw→noise rule→order) | text in live requests | live req / out tok / calls / edits / min | files changed in review | hidden tests: F2P failing / P2P failing / newly failing / newly passing | text signals (audit words, ran original, uncertainty; not adjudication) | adjudication |", "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(row => `| ${row.unit} | ${row.arm} | ${row.status}${row.reason ? ` (${row.reason.slice(0, 120)})` : ""} | ${row.fidelity ? `${row.fidelity.ok ? "ok" : "FAIL"}; ${row.fidelity.sameState}; ${row.fidelity.outputs.raw}→${row.fidelity.outputs.normalized}→${row.fidelity.outputs.orderOnly}` : "-"} | ${row.delivery ? `${row.delivery.withText}/${row.delivery.liveTopRequests}` : "-"} | ${row.liveRequests ?? "-"} / ${row.outputTokens ?? "-"} / ${row.toolCalls ?? "-"} / ${row.edits ?? "-"} / ${row.minutes ?? "-"} | ${row.changedFiles?.join(", ") || "-"} | ${row.tests ? `${row.tests.f2pFailing.length} / ${row.tests.p2pFailing.length} / ${list(row.tests.newlyFailing)} / ${list(row.tests.newlyPassing)}` : "-"} | ${row.signals ? [row.signals.auditWords, row.signals.ranOriginal, row.signals.uncertainty].map(value => value ? "y" : "n").join("") : "-"} | ${row.adjudication ? `${row.adjudication.adherence ?? "n/a"}; mechanism ${row.adjudication.mechanism ?? "n/a"}` : "-"} |`),
  ].join("\n");
  await writeFile(join(pilot, "summary.md"), `${md}\n`);
  console.log(md);
}
if (process.argv[1]?.endsWith("pilot/evaluate.ts")) await main();
