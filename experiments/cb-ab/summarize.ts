/**
 * `summarize <study>` (results/cb-ab/PROTOCOL.md "Records"): per unit its terminal status, wall time, requests and list-price USD by
 * role, route violations, compliance (B/C), audit hits and the frozen final report; totals per arm and per case. Writes
 * <study>/summary.json and <study>/summary.md. Reads only what the units wrote (meta.json); kept attempts (.infra-<n>,
 * .interrupted-<n>) are counted per unit and their cost is reported apart.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanUnits } from "./driver.js";
import { ROLES, round6 } from "./evidence.js";
import { writeJson } from "./env.js";
import { ARMS, type Arm } from "./protocol.js";

export interface RoleUse { requests: number; costUSD: number }
export interface UnitRow {
  unit: string; caseId: string; arm: Arm; repeat: number; preflight: boolean; status: string; terminal: string;
  wallMs?: number; exit?: number | null; guardFired?: boolean; requests: number; costUSD: number; byRole: Record<string, RoleUse>;
  route: { ok?: boolean; violations?: number; byKind?: Record<string, number> };
  compliance: { spawnCalls: number; explorer?: { compliant: boolean; ran: boolean; verbatim: boolean; form: boolean; calls: number; accepted: number; briefVerbatim: boolean; promptVerbatim: boolean; status?: string; requests: number; costUSD: number } };
  audit: { calls?: number; hits?: number; byRule?: Record<string, number> };
  final: { report: boolean; reportChars: number; textChars: number; reportSha256?: string | null };
  target: { unchanged?: boolean; changed?: number; removed?: number; added?: number };
  tasks: { worker?: string; status?: string; outcome?: string }[];
  attempts: { infra: number; interrupted: number; costUSD: number };
  evidenceErrors: number;
}

/** ok: a final report, Pi exited 0, no guard; otherwise why not (infra = no successful model request). */
export function terminalOf(meta: any): string {
  if (meta?.status !== "completed") return String(meta?.status ?? "missing");
  if (meta.infra) return "infra";
  if (meta.pi?.guardFired) return "guard";
  if (!meta.final?.report) return "no-report";
  if (meta.pi?.code !== 0) return `exit-${meta.pi?.code}`;
  return "ok";
}

export function unitRow(meta: any, kept: { infra: number; interrupted: number; costUSD: number }): UnitRow {
  const usage = meta?.usage ?? {};
  const byRole: Record<string, RoleUse> = {};
  for (const role of ROLES) if (usage[role]) byRole[role] = { requests: usage[role].requests, costUSD: usage[role].costUSD };
  const explorer = meta?.compliance?.explorer;
  return {
    unit: meta.unit, caseId: meta.caseId, arm: meta.arm, repeat: meta.repeat, preflight: !!meta.preflight, status: meta.status, terminal: terminalOf(meta),
    wallMs: meta.wallMs, exit: meta.pi?.code, guardFired: meta.pi?.guardFired, requests: usage.total?.requests ?? 0, costUSD: usage.total?.costUSD ?? 0, byRole,
    route: { ok: meta.route?.ok, violations: meta.route?.violations, byKind: meta.route?.byKind },
    compliance: {
      spawnCalls: meta.compliance?.spawns?.length ?? 0,
      ...(explorer ? { explorer: { compliant: explorer.compliant, ran: explorer.ran, verbatim: explorer.verbatim, form: explorer.form, calls: explorer.calls, accepted: explorer.accepted, briefVerbatim: explorer.briefVerbatim, promptVerbatim: explorer.promptVerbatim, status: explorer.status, requests: explorer.wireRequests, costUSD: explorer.listCostUSD } } : {}),
    },
    audit: { calls: meta.audit?.calls, hits: meta.audit?.hits, byRule: meta.audit?.byRule },
    final: { report: !!meta.final?.report, reportChars: meta.final?.reportChars ?? 0, textChars: meta.final?.textChars ?? 0, reportSha256: meta.final?.reportSha256 },
    target: { unchanged: meta.targetCheck?.unchanged, changed: meta.targetCheck?.changed?.length, removed: meta.targetCheck?.removed?.length, added: meta.targetCheck?.added?.length },
    tasks: (meta.tasks ?? []).map((task: any) => ({ worker: task.worker, status: task.status, outcome: task.outcome })),
    attempts: kept, evidenceErrors: meta.evidenceErrors?.length ?? 0,
  };
}

export function totals(rows: readonly UnitRow[]) {
  const sum = (pick: (row: UnitRow) => number | undefined) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const walls = rows.map(row => row.wallMs).filter((value): value is number => typeof value === "number");
  const byRole: Record<string, RoleUse> = {};
  for (const row of rows) for (const [role, use] of Object.entries(row.byRole)) { byRole[role] ??= { requests: 0, costUSD: 0 }; byRole[role]!.requests += use.requests; byRole[role]!.costUSD = round6(byRole[role]!.costUSD + use.costUSD); }
  const explorers = rows.filter(row => row.compliance.explorer);
  return {
    units: rows.length, completed: rows.filter(row => row.status === "completed").length, ok: rows.filter(row => row.terminal === "ok").length,
    requests: sum(row => row.requests), costUSD: round6(sum(row => row.costUSD)), keptAttemptsCostUSD: round6(sum(row => row.attempts.costUSD)),
    meanWallMs: walls.length ? Math.round(walls.reduce((a, b) => a + b, 0) / walls.length) : undefined, maxWallMs: walls.length ? Math.max(...walls) : undefined,
    routeViolations: sum(row => row.route.violations), auditHits: sum(row => row.audit.hits), reports: rows.filter(row => row.final.report).length,
    ...(explorers.length ? { compliant: explorers.filter(row => row.compliance.explorer!.compliant).length, explorerRan: explorers.filter(row => row.compliance.explorer!.ran).length } : {}),
    byRole,
  };
}

const usd = (value: number | undefined) => value === undefined ? "–" : `$${value.toFixed(2)}`;
const minutes = (ms: number | undefined) => ms === undefined ? "–" : `${(ms / 60_000).toFixed(1)} min`;
const cell = (use: RoleUse | undefined) => use ? `${use.requests} / ${usd(use.costUSD)}` : "–";
const yes = (value: boolean | undefined) => value === undefined ? "–" : value ? "yes" : "no";

export function summarize(studyDir: string): { json: Record<string, unknown>; markdown: string } {
  const study = resolve(studyDir);
  const found = scanUnits(study);
  const rows: UnitRow[] = [];
  for (const item of found.filter(entry => !entry.attempt)) {
    if (!item.meta) continue;
    const kept = found.filter(entry => entry.id === item.id && entry.attempt);
    rows.push(unitRow(item.meta, { infra: kept.filter(entry => entry.attempt!.startsWith("infra")).length, interrupted: kept.filter(entry => entry.attempt!.startsWith("interrupted")).length, costUSD: round6(kept.reduce((total, entry) => total + Number(entry.meta?.usage?.total?.costUSD ?? 0), 0)) }));
  }
  rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat || a.arm.localeCompare(b.arm));
  const byArm = Object.fromEntries(ARMS.map(arm => [arm, totals(rows.filter(row => row.arm === arm))]));
  const caseIds = [...new Set(rows.map(row => row.caseId))];
  const byCase = Object.fromEntries(caseIds.map(id => [id, totals(rows.filter(row => row.caseId === id))]));
  const json = { study, generatedAt: new Date().toISOString(), units: rows, byArm, byCase, total: totals(rows) };
  const lines = [
    `# cb-ab summary`, "", `Study \`${study}\`, generated ${json.generatedAt}. Units ${rows.length} (completed ${json.total.completed}, ok ${json.total.ok}); ${json.total.requests} model requests, ${usd(json.total.costUSD)} at list prices${json.total.keptAttemptsCostUSD ? ` (+ ${usd(json.total.keptAttemptsCostUSD)} in kept infra/interrupted attempts)` : ""}.`, "",
    "## Units", "",
    "| unit | terminal | wall | requests / USD | main | orchestrator | explorer | other sub-workers | unattributed | route violations | compliance | audit hits | final report | target unchanged |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(row => {
      const explorer = row.compliance.explorer;
      const compliance = explorer ? `${explorer.compliant ? "compliant" : "NOT compliant"} (spawns ${explorer.accepted}/${explorer.calls}, brief ${yes(explorer.briefVerbatim)}, prompt ${yes(explorer.promptVerbatim)}, ${explorer.status ?? "?"})` : `spawn calls ${row.compliance.spawnCalls}`;
      return `| ${row.unit}${row.preflight ? " (preflight)" : ""}${row.attempts.infra || row.attempts.interrupted ? ` [kept ${row.attempts.infra} infra, ${row.attempts.interrupted} interrupted]` : ""} | ${row.terminal} | ${minutes(row.wallMs)} | ${row.requests} / ${usd(row.costUSD)} | ${cell(row.byRole.main)} | ${cell(row.byRole.orchestrator)} | ${cell(row.byRole.explorer)} | ${cell(row.byRole["sub-worker"])} | ${cell(row.byRole.unattributed)} | ${row.route.violations ?? "?"}${row.route.byKind && Object.keys(row.route.byKind).length ? ` (${Object.entries(row.route.byKind).map(([kind, n]) => `${kind} ${n}`).join(", ")})` : ""} | ${compliance} | ${row.audit.hits ?? "?"} | ${row.final.report ? `yes (${row.final.reportChars} chars)` : "no"} | ${yes(row.target.unchanged)} |`;
    }),
    "", "## By arm", "", "| arm | units | completed | ok | requests | USD | mean wall | route violations | audit hits | final reports | compliant |", "|---|---|---|---|---|---|---|---|---|---|---|",
    ...ARMS.map(arm => { const t = byArm[arm]!; return `| ${arm} | ${t.units} | ${t.completed} | ${t.ok} | ${t.requests} | ${usd(t.costUSD)} | ${minutes(t.meanWallMs)} | ${t.routeViolations} | ${t.auditHits} | ${t.reports} | ${"compliant" in t ? `${t.compliant}/${t.units}` : "–"} |`; }),
    "", "## By case", "", "| case | units | completed | ok | requests | USD | mean wall | route violations | audit hits | final reports |", "|---|---|---|---|---|---|---|---|---|---|",
    ...caseIds.map(id => { const t = byCase[id]!; return `| ${id} | ${t.units} | ${t.completed} | ${t.ok} | ${t.requests} | ${usd(t.costUSD)} | ${minutes(t.meanWallMs)} | ${t.routeViolations} | ${t.auditHits} | ${t.reports} |`; }),
    "", "## Usage by role (all units)", "", "| role | requests | USD |", "|---|---|---|",
    ...Object.entries(json.total.byRole).map(([role, use]) => `| ${role} | ${use.requests} | ${usd(use.costUSD)} |`),
    "",
  ];
  const markdown = lines.join("\n");
  writeJson(join(study, "summary.json"), json);
  writeFileSync(join(study, "summary.md"), markdown);
  return { json, markdown };
}
