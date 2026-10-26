/**
 * Model-free grading of one final workspace, run as its own process INSIDE the sandbox (evaluate.ts): the ultra-ab
 * `gradeWorkspace` (original tests and runner config restored, hidden test patch applied, the manifest's F2P/P2P ids) and the
 * graded visible test files WITHOUT hidden tests for the final and for the seed (new failures = failing in the final but not in
 * the seed), plus protected-file integrity original→final and seed→final. ADVISOR_BENCH_SWE_DIR / ADVISOR_BENCH_SWE_CACHE name
 * the task's fixture root and cache (read at import by the ultra-ab code).
 *   node --import tsx experiments/witness-replay/grade-child.ts <task> <final workspace> <seed tree> <out.json>
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readable } from "../advisor-reviewer/tasks.js";
import { execIn, gradeWorkspace, loadTask, protectedFiles, pythonWrappers } from "../ultra-ab/env.js";
import { integrity } from "../ultra-ab/protocol.js";

const SKIP = /\/(\.git|\.orche|node_modules|__pycache__|\.pytest_cache|\.bench-bin|\.hypothesis)$/;

/** Statuses of the task's graded visible test files on a restored copy (no hidden patch). */
async function visibleStatuses(task: Awaited<ReturnType<typeof loadTask>>, workspace: string): Promise<{ statuses: Record<string, string>; exit: number | null; tail: string }> {
  const copy = await mkdtemp(join(tmpdir(), "wr-visible-"));
  try {
    await cp(workspace, copy, { recursive: true, filter: path => !SKIP.test(path) && readable(path) });
    for (const [rel, text] of protectedFiles(task.source)) { await mkdir(join(copy, rel, ".."), { recursive: true }); await writeFile(join(copy, rel), text); }
    for (const rel of protectedFiles(copy).keys()) {
      const name = rel.split("/").at(-1)!;
      if (!existsSync(join(task.source, rel)) && ["conftest.py", "pytest.ini", ".pytest.ini", "tox.ini"].includes(name)) await rm(join(copy, rel), { force: true });
    }
    const bin = join(copy, ".bench-bin");
    await pythonWrappers(task, copy, bin);
    const command = String(task.manifest.testCmd).replace(/^pytest\b/, `'${join(bin, "pytest")}'`);
    const run = await execIn("bash", ["-c", command], copy, { ...process.env, PATH: `${bin}:${process.env.PATH}`, PYTHONHASHSEED: "0" }, 900_000);
    const statuses: Record<string, string> = {};
    for (const line of run.text.split("\n")) {
      const match = /^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S.*?)(?:\s+-\s+.*)?$/.exec(line.trim());
      if (match && match[2]!.includes("::")) statuses[match[2]!.trim()] = match[1]!;
    }
    return { statuses, exit: run.code, tail: run.text.slice(-3000) };
  } finally { await rm(copy, { recursive: true, force: true }); }
}

const failing = (statuses: Record<string, string>): string[] => Object.entries(statuses).filter(([, status]) => status === "FAILED" || status === "ERROR").map(([id]) => id).sort();

async function main(): Promise<void> {
  const [taskId, final, seed, out] = process.argv.slice(2);
  if (!taskId || !final || !seed || !out) throw new Error("usage: grade-child.ts <task> <final> <seed> <out.json>");
  const task = await loadTask(taskId);
  const graded = await gradeWorkspace(task, final);
  const visibleFinal = await visibleStatuses(task, final);
  const visibleSeed = await visibleStatuses(task, seed);
  const seedFailing = new Set(failing(visibleSeed.statuses));
  const result = {
    task: taskId, grade: graded.grade, integrityOriginal: graded.integrity, integritySeed: integrity(protectedFiles(seed), protectedFiles(final)),
    visible: {
      final: { exit: visibleFinal.exit, counts: countOf(visibleFinal.statuses), failing: failing(visibleFinal.statuses), tail: visibleFinal.tail },
      seed: { exit: visibleSeed.exit, counts: countOf(visibleSeed.statuses), failing: [...seedFailing] },
      newFailures: failing(visibleFinal.statuses).filter(id => !seedFailing.has(id)),
      fixed: [...seedFailing].filter(id => visibleFinal.statuses[id] === "PASSED"),
    },
  };
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
}
const countOf = (statuses: Record<string, string>): Record<string, number> => { const out: Record<string, number> = {}; for (const status of Object.values(statuses)) out[status] = (out[status] ?? 0) + 1; return out; };
main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1); });
