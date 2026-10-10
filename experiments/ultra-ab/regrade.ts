/**
 * Sequential re-grade of every completed run of a study phase (A, B and C attempts) from its preserved workspace-final, one at a
 * time (no concurrent load), into grade-final.json; reports agreement with the grade recorded during the study.
 *
 *   npx tsx experiments/ultra-ab/regrade.ts --study <out dir> --phase <phase>
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeWorkspace, loadTask } from "./env.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const study = resolve(arg("--study")!), phase = arg("--phase")!;
  const plan = JSON.parse(readFileSync(join(study, `plan-${phase}.json`), "utf8"));
  const rows: { id: string; recorded?: boolean; regraded: boolean; integrityRecorded: number; integrityNow: number; agree: boolean }[] = [];
  for (const { id } of plan.order as { id: string }[]) {
    if (id.endsWith("/select")) continue;
    const dir = join(study, "runs", id);
    const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : undefined;
    if (meta?.status !== "completed" || !existsSync(join(dir, "workspace-final"))) continue;
    const task = await loadTask(id.split("/")[0]!);
    const { grade, integrity } = await gradeWorkspace(task, join(dir, "workspace-final"));
    await writeFile(join(dir, "grade-final.json"), `${JSON.stringify({ grade, integrity, gradedAt: new Date().toISOString() }, null, 2)}\n`);
    const row = { id, recorded: meta.grade?.passed, regraded: grade.passed, integrityRecorded: meta.integrity?.violations?.length ?? -1, integrityNow: integrity.violations.length, agree: meta.grade?.passed === grade.passed && (meta.integrity?.violations?.length ?? -1) === integrity.violations.length };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const summary = { phase, at: new Date().toISOString(), runs: rows.length, agree: rows.filter(row => row.agree).length, disagreements: rows.filter(row => !row.agree) };
  await writeFile(join(study, `regrade-${phase}.json`), `${JSON.stringify({ ...summary, rows }, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}
