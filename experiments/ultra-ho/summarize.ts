/**
 * Summary of an ultra-ho study directory (experiments/ultra-ho/README.md): per unit the terminal status, grade, primary pass,
 * integrity, requests and list-price USD by role, route violations, and the orche assignments with their carry; totals per arm.
 * Written to `<out>/summary.json` and `<out>/summary.md`. Reads only what run-one.ts wrote (never any model).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOut } from "./driver.js";

export interface UnitSummary {
  id: string; arm: string; task: string; mode?: string; status: string; attempt?: number; kept: string[];
  terminal?: string; grade?: boolean | null; gradeError?: string; checks?: Record<string, boolean>; primary?: boolean;
  integrity?: { violations: string[]; suspicious: string[] };
  requests: number; costUSD: number; byRole: Record<string, { requests: number; costUSD: number }>;
  routeViolations: number; violations: string[]; unattributed: number; providerErrors: number;
  commits?: { head: string | null; count: number }; diffStat?: string;
  assignments: { index: number; worker?: string; task?: string; assignment?: number; passedTask: boolean; carried: boolean; carriedLine: boolean; carriedCandidates: string[]; status?: string; stage?: string; gate?: string; gateRejections: number; adoptions: { candidate: string; check?: string }[]; carriedAdoptions: { candidate: string; freshChecks: string[] }[]; selection?: { chosen: string; evidence: string[] }; stageClaims: string[] }[];
  wallMinutes?: number; runtime?: string; harness?: string; infra?: string; harnessError?: string;
}
export interface ArmTotals { units: number; completed: number; terminals: Record<string, number>; gradePassed: number; primaryPassed: number; requests: number; costUSD: number; routeViolations: number; unattributed: number; assignments: number; continuations: number; carried: number; adoptions: number; unsupportedStageClaims: number }

const round2 = (value: number) => Math.round(value * 100) / 100;
const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };

export function unitSummary(out: string, unit: { id: string; arm: string; task: string; status: string; kept?: string[] }): UnitSummary {
  const dir = join(out, "runs", unit.id);
  const meta = readJson(join(dir, "meta.json")) ?? {};
  const tasks: any[] = readJson(join(dir, "tasks.json")) ?? [];
  const fidelity = readJson(join(dir, "fidelity.json"));
  return {
    id: unit.id, arm: unit.arm, task: unit.task, ...(meta.mode ? { mode: meta.mode } : {}), status: meta.status === "completed" ? "completed" : unit.status, ...(meta.attempt ? { attempt: meta.attempt } : {}), kept: unit.kept ?? [],
    ...(meta.terminal ? { terminal: meta.terminal } : {}), grade: meta.grade ? meta.grade.passed : null, ...(meta.grade?.error ? { gradeError: meta.grade.error } : {}), ...(meta.grade?.checks ? { checks: meta.grade.checks } : {}),
    ...(meta.primaryPass !== undefined ? { primary: meta.primaryPass } : {}), ...(meta.integrity ? { integrity: meta.integrity } : {}),
    requests: meta.wire?.requests ?? 0, costUSD: meta.wire?.costUSD ?? 0,
    byRole: Object.fromEntries(Object.entries(meta.wire?.byRole ?? {}).map(([role, usage]: [string, any]) => [role, { requests: usage.requests, costUSD: usage.costUSD }])),
    routeViolations: meta.wire?.routeViolations ?? fidelity?.violations?.length ?? 0, violations: (fidelity?.violations ?? meta.routeViolations ?? []).slice(0, 50),
    unattributed: meta.wire?.unattributed ?? 0, providerErrors: meta.wire?.providerErrors ?? 0,
    ...(meta.commits ? { commits: meta.commits } : {}), ...(meta.diffStat ? { diffStat: String(meta.diffStat).trim().split("\n").at(-1) } : {}),
    assignments: tasks.map(item => ({
      index: item.index, ...(item.worker ? { worker: item.worker } : {}), ...(item.task ? { task: item.task } : {}), ...(item.assignment ? { assignment: item.assignment } : {}), passedTask: !!item.passedTask, carried: !!item.carried, carriedLine: !!item.carriedLine, carriedCandidates: item.carriedCandidates ?? [],
      ...(item.status ? { status: item.status } : {}), ...(item.ultra?.stage ? { stage: item.ultra.stage } : {}), ...(item.gate?.result ? { gate: item.gate.result } : {}), gateRejections: (item.gate?.events ?? []).filter((event: any) => event.rejected).length,
      adoptions: (item.adoptions ?? []).map((adoption: any) => ({ candidate: adoption.candidate, ...(adoption.check?.ref ? { check: adoption.check.ref } : {}) })),
      carriedAdoptions: (item.carriedAdoptions ?? []).map((adoption: any) => ({ candidate: adoption.candidate, freshChecks: (adoption.freshChecks ?? []).map((check: any) => check.ref ?? "?") })),
      ...(item.finalReport?.selection ? { selection: { chosen: item.finalReport.selection.chosen, evidence: item.finalReport.selection.evidence.map((ref: any) => `${ref.ref}${ref.tool ? ` ${ref.tool}${ref.target ? ` in ${ref.target}` : ""}${ref.isError ? " (failed)" : ""}` : " (not a call of this assignment)"}`) } } : {}),
      stageClaims: [...(item.stageClaims?.report ?? []), ...(item.stageClaims?.line ?? [])],
    })),
    ...(meta.wallMs ? { wallMinutes: round2(meta.wallMs / 60_000) } : {}), ...(meta.runtime?.name ? { runtime: `${meta.runtime.name} ${String(meta.runtime.digest).slice(0, 12)}` } : {}), ...(meta.harness ? { harness: String(meta.harness).slice(0, 12) } : {}),
    ...(meta.infra ? { infra: String(meta.infra).slice(0, 300) } : {}), ...(meta.harnessError ? { harnessError: meta.harnessError } : {}),
  };
}

/** Units of every manifest in `out` (or of runs/ without one) with arm totals. */
export function summarize(outInput: string): { out: string; units: UnitSummary[]; arms: Record<string, ArmTotals> } {
  const out = resolveOut(outInput);
  const units: UnitSummary[] = [];
  for (const name of existsSync(out) ? readdirSync(out).filter(item => /^manifest-.+\.json$/.test(item)).sort() : []) {
    for (const unit of readJson(join(out, name))?.units ?? []) units.push(unitSummary(out, unit));
  }
  const arms: Record<string, ArmTotals> = {};
  for (const unit of units) {
    const total = arms[unit.arm] ??= { units: 0, completed: 0, terminals: {}, gradePassed: 0, primaryPassed: 0, requests: 0, costUSD: 0, routeViolations: 0, unattributed: 0, assignments: 0, continuations: 0, carried: 0, adoptions: 0, unsupportedStageClaims: 0 };
    total.units++;
    if (unit.status === "completed") total.completed++;
    if (unit.terminal) total.terminals[unit.terminal] = (total.terminals[unit.terminal] ?? 0) + 1;
    if (unit.grade === true) total.gradePassed++;
    if (unit.primary === true) total.primaryPassed++;
    total.requests += unit.requests; total.costUSD = round2(total.costUSD + unit.costUSD);
    total.routeViolations += unit.routeViolations; total.unattributed += unit.unattributed;
    total.assignments += unit.assignments.length;
    total.continuations += unit.assignments.filter(item => item.passedTask).length;
    total.carried += unit.assignments.filter(item => item.carried).length;
    total.adoptions += unit.assignments.reduce((sum, item) => sum + item.adoptions.length, 0);
    total.unsupportedStageClaims += unit.assignments.reduce((sum, item) => sum + item.stageClaims.length, 0);
  }
  return { out, units, arms };
}

export function formatSummary(summary: ReturnType<typeof summarize>): string {
  const lines = [`# ultra-ho summary: ${summary.out}`, "", "## Units", ""];
  for (const unit of summary.units) {
    lines.push(`### ${unit.id} (${unit.mode ?? "?"}, ${unit.status}${unit.attempt ? `, attempt ${unit.attempt}` : ""}${unit.kept.length ? `; kept ${unit.kept.join(", ")}` : ""})`);
    lines.push(`- terminal ${unit.terminal ?? "-"} · grade ${unit.grade ?? "-"}${unit.checks ? ` (${Object.entries(unit.checks).map(([name, passed]) => `${name} ${passed}`).join(", ")})` : ""}${unit.gradeError ? ` (error: ${unit.gradeError})` : ""} · primary ${unit.primary ?? "-"} · integrity violations ${unit.integrity?.violations.length ?? "-"}${unit.integrity?.violations.length ? `: ${unit.integrity.violations.join("; ")}` : ""}`);
    lines.push(`- ${unit.requests} requests, $${round2(unit.costUSD)} (${Object.entries(unit.byRole).map(([role, usage]) => `${role} ${usage.requests} req $${round2(usage.costUSD)}`).join(", ") || "none"}) · route violations ${unit.routeViolations} · unattributed ${unit.unattributed} · provider errors ${unit.providerErrors}${unit.wallMinutes !== undefined ? ` · ${unit.wallMinutes} min` : ""}`);
    if (unit.violations.length) lines.push(`- violations: ${unit.violations.slice(0, 10).join("; ")}${unit.violations.length > 10 ? "; …" : ""}`);
    if (unit.commits) lines.push(`- workspace commits: ${unit.commits.count} (HEAD ${unit.commits.head ?? "unborn"})${unit.diffStat ? ` · diff: ${unit.diffStat}` : ""}`);
    for (const item of unit.assignments) {
      lines.push(`- assignment #${item.index}: ${item.worker ?? "?"} ${item.task ?? "no task"}${item.assignment ? ` (ledger assignment ${item.assignment})` : ""} · main passed task: ${item.passedTask ? "yes" : "no"} · carried: ${item.carried ? `yes${item.carriedCandidates.length ? ` [${item.carriedCandidates.join(", ")}]` : ""}` : "no"}${item.carried !== item.carriedLine ? ` (Ultra line ${item.carriedLine ? "says carried" : "does not say carried"})` : ""} · ${item.status ?? "?"} · stage ${item.stage ?? "-"} · gate ${item.gate ?? "not reached"}${item.gateRejections ? ` (after ${item.gateRejections} rejected report${item.gateRejections === 1 ? "" : "s"})` : ""}${item.adoptions.length ? ` · adopted ${item.adoptions.map(adoption => `${adoption.candidate}${adoption.check ? ` after ${adoption.check}` : ""}`).join(", ")}` : ""}${item.carriedAdoptions.length ? ` · carried adoption ${item.carriedAdoptions.map(adoption => `${adoption.candidate}${adoption.freshChecks.length ? ` (fresh checks of its copy: ${adoption.freshChecks.join(", ")})` : " (no fresh check of its copy)"}`).join(", ")}` : ""}${item.selection ? ` · selection ${item.selection.chosen}: ${item.selection.evidence.join(", ") || "no evidence"}` : ""}${item.stageClaims.length ? ` · UNSUPPORTED STAGE CLAIMS: ${item.stageClaims.join("; ")}` : ""}`);
    }
    if (unit.infra) lines.push(`- infra: ${unit.infra}`);
    if (unit.harnessError) lines.push(`- harness error: ${unit.harnessError}`);
    lines.push("");
  }
  lines.push("## Arms", "", "| arm | units | completed | terminals | grade pass | primary pass | requests | USD | route violations | unattributed | assignments | continuations (task passed) | carried | adoptions | unsupported stage claims |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [arm, total] of Object.entries(summary.arms)) lines.push(`| ${arm} | ${total.units} | ${total.completed} | ${Object.entries(total.terminals).map(([name, n]) => `${name} ${n}`).join(", ")} | ${total.gradePassed} | ${total.primaryPassed} | ${total.requests} | ${total.costUSD} | ${total.routeViolations} | ${total.unattributed} | ${total.assignments} | ${total.continuations} | ${total.carried} | ${total.adoptions} | ${total.unsupportedStageClaims} |`);
  return lines.join("\n");
}

export async function writeSummary(outInput: string): Promise<string> {
  const summary = summarize(outInput);
  const text = formatSummary(summary);
  await writeFile(join(summary.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(summary.out, "summary.md"), `${text}\n`);
  return text;
}
