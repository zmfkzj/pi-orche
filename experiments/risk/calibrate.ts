// Risk-score calibration on stored single-workflow runs (docs/specialist-orchestration.md 5.3, Phase 0 item "위험 점수 보정").
// For every graded task of the stored runs: the worker's change (final package vs the fixture starter), its last checklist from the
// task records, and the hidden-test grade. Prints how many results each threshold would verify, and how many of the failed ones.
// v1 runs have no Framer contract, so the "edge cases without a passing test" and "ambiguities settled by recommendation" signals are
// 0 here: v2 scores are higher by up to 5 points.
//
// Usage: npx --no-install tsx experiments/risk/calibrate.ts   (writes results/risk-calibration/{calibration.json,calibration.md}, local)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessRisk } from "./risk.ts";
import type { ChecklistItem } from "../../src/orchestration/result-schemas.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compare = path.join(root, "results/compare");
const out = path.join(root, "results/risk-calibration");

interface Case { set: string; run: string; task: string; passed: boolean | null; starter: string; final: string; records: string[] }
const cases: Case[] = [];
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const records = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).flatMap(session => fs.readdirSync(path.join(dir, session)).filter(name => name.includes("_task-")).map(name => path.join(dir, session, name, "run.json"))).filter(file => fs.existsSync(file)) : [];

// Long sessions: one monorepo per repeat, one package per task.
for (const [set, base] of [["longsession", "longsession-2026-10-04/runs/longsession/orche-single"], ["ledger-S0", "ledger-2026-10-04/runs/longsession/orche-single"], ["ledger-S0+L", "ledger-2026-10-04/runs/longsession/orche-single-ledger"]] as const) {
  for (const repeat of ["r1", "r2", "r3"]) {
    const dir = path.join(compare, base, repeat);
    if (!fs.existsSync(path.join(dir, "turns"))) continue;
    for (const task of fs.readdirSync(path.join(dir, "turns"))) {
      const grade = path.join(dir, "turns", task, "grade.json");
      cases.push({ set, run: `${set}/${repeat}`, task, passed: fs.existsSync(grade) ? json(grade).passed === true : null, starter: path.join(root, "fixtures/suite", task, "repo"),
        final: path.join(dir, "workspace-final/packages", task), records: records(path.join(dir, "orche-records")).filter(file => String(json(file).request ?? "").includes(`packages/${task}`)) });
    }
  }
}
// Single-task runs.
const mvs = path.join(compare, "multi-vs-single-2026-10-04/runs");
for (const task of fs.existsSync(mvs) ? fs.readdirSync(mvs).filter(name => fs.existsSync(path.join(mvs, name, "orche-single"))) : []) {
  for (const repeat of fs.readdirSync(path.join(mvs, task, "orche-single"))) {
    const dir = path.join(mvs, task, "orche-single", repeat);
    const grade = path.join(dir, "grade.json");
    cases.push({ set: "multi-vs-single", run: `multi-vs-single/${task}/${repeat}`, task, passed: fs.existsSync(grade) ? json(grade).passed === true : null, starter: path.join(root, "fixtures/suite", task, "repo"), final: path.join(dir, "workspace-final"), records: records(path.join(dir, "orche-records")) });
  }
}

/** The change as git sees it: the starter committed, the final tree copied over it. */
function change(starter: string, final: string): { files: { path: string; added: number; removed: number }[]; diff: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "risk-cal-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    git("init", "-q");
    execFileSync("rsync", ["-a", "--exclude", "node_modules", "--exclude", ".orche", "--exclude", ".git", `${starter}/`, `${tmp}/`]);
    git("add", "-A"); git("-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "starter", "--allow-empty");
    execFileSync("rsync", ["-a", "--delete", "--exclude", "node_modules", "--exclude", ".orche", "--exclude", ".git", `${final}/`, `${tmp}/`]);
    git("add", "-A");
    const files = git("diff", "--cached", "--numstat", "--no-renames").split("\n").filter(Boolean).map(line => { const [a, r, ...p] = line.split("\t"); return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 }; });
    return { files, diff: git("diff", "--cached", "--no-renames", "-U3") };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const thresholds = [3, 4, 5, 6, 7, 8, 9];
const rows = cases.filter(item => fs.existsSync(item.final) && fs.existsSync(item.starter)).map(item => {
  const last = item.records.map(file => json(file)).sort((a, b) => String(a.start).localeCompare(String(b.start))).at(-1);
  const checklist = (last?.outcome?.checklist ?? []) as ChecklistItem[];
  const original = /Original (?:user )?request[^\n]*\n([\s\S]*)$/i.exec(String(last?.request ?? ""))?.[1] ?? "";
  const { files, diff } = change(item.starter, item.final);
  const risk = assessRisk({ files, diff, checklist, original }, { threshold: 5, gate: "auto" });
  return { ...item, records: item.records.length, files: files.length, lines: files.reduce((sum, file) => sum + file.added + file.removed, 0), score: risk.score, reason: risk.reason, signals: risk.signals.map(signal => `${signal.name} +${signal.points}`) };
});
const graded = rows.filter(row => row.passed !== null);
const failed = graded.filter(row => !row.passed);
const table = thresholds.map(threshold => {
  const verify = (row: typeof rows[number]) => row.reason.startsWith("forced") || (!row.reason.startsWith("skipped") && row.score >= threshold);
  return { threshold, verified: graded.filter(verify).length, graded: graded.length, failedVerified: failed.filter(verify).length, failed: failed.length };
});
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(out, "calibration.json"), JSON.stringify({ at: new Date().toISOString(), table, rows }, null, 1), { mode: 0o600 });
const md = [
  "# Risk-score calibration (stored v1 single runs)", "",
  `${graded.length} graded task results (${failed.length} failed) from ${new Set(rows.map(row => row.run.split("/").slice(0, 2).join("/"))).size} runs. v1 has no Framer contract: edge-case and recommended-reading signals are 0 here.`, "",
  "| threshold | verified | failed results verified |", "|---:|---:|---:|",
  ...table.map(row => `| ${row.threshold} | ${row.verified}/${row.graded} (${Math.round(100 * row.verified / Math.max(1, row.graded))}%) | ${row.failedVerified}/${row.failed} |`), "",
  "| run | task | passed | score | signals |", "|---|---|---|---:|---|",
  ...rows.map(row => `| ${row.run} | ${row.task} | ${row.passed === null ? "?" : row.passed ? "yes" : "**no**"} | ${row.score} | ${row.signals.join(", ") || "-"}${row.reason.startsWith("skipped") || row.reason.startsWith("forced") ? ` (${row.reason})` : ""} |`),
];
fs.writeFileSync(path.join(out, "calibration.md"), md.join("\n") + "\n", { mode: 0o600 });
console.log(md.slice(0, 6 + table.length).join("\n"));
const byTask = new Map<string, number[]>();
for (const row of rows) byTask.set(row.task, [...byTask.get(row.task) ?? [], row.score]);
console.log("\nScores by task:", [...byTask].map(([task, scores]) => `${task}: ${scores.join(",")}`).join("; "));
console.log("Failed:", failed.map(row => `${row.run} ${row.task} score ${row.score} (${row.signals.join(", ")})`).join("\n  "));
