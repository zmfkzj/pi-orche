/**
 * Offline diagnostics of the decision-audit pilot (PREREGISTRATION.md "Grading and diagnostics"; never model-visible). The objective
 * verdict stays `gradeWorkspace`; this re-runs the same hidden-test command on a saved patch with tracebacks (`--tb=short` instead
 * of `--tb=line`) and keeps every test status, so a grade flip or a newly failing check can be traced to its assertion:
 * the pre-review state (the source bench's O checkpoint patch) and each pilot arm's checkpoint and final patches.
 *
 *   TMPDIR=<scratch> node --import tsx experiments/strong-reflection/bench/pilot/diagnose.ts <pilot dir> [unit ...]
 *
 * Writes <pilot>/diagnostics/<unit>/<label>.json (statuses, F2P/P2P outcome, failure excerpts) and <label>.txt (runner output).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execIn, gradeWorkspace, loadTask, protectedFiles, pythonWrappers, type Task } from "../../../ultra-ab/env.js";
import { statusOf } from "../../../ultra-ab/protocol.js";
import { JOBS } from "./protocol.js";

export interface Diagnosis { label: string; patch: string; statuses: Record<string, string>; failToPass: { id: string; status: string }[]; passToPassFailing: { id: string; status: string }[]; exit: number | null; failures: Record<string, string>; detail?: string }

/** The `____ name ____` sections of pytest's FAILURES/ERRORS output, each cut to `lines` lines. */
export function failureSections(text: string, lines = 60): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = [...text.matchAll(/^=+ (.+?) =+$/gm)];
  headers.forEach((header, index) => {
    if (!/^(FAILURES|ERRORS)$/.test(header[1]!)) return;
    const block = text.slice(header.index! + header[0].length, index + 1 < headers.length ? headers[index + 1]!.index! : text.length);
    const parts = [...block.matchAll(/^_{3,} (.+?) _{3,}$/gm)];
    parts.forEach((part, i) => { out[part[1]!] = block.slice(part.index!, i + 1 < parts.length ? parts[i + 1]!.index! : block.length).split("\n").slice(0, lines).join("\n").trimEnd(); });
  });
  return out;
}

async function copyWithPatch(task: Task, patch: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "srb-diag-"));
  await cp(task.source, dir, { recursive: true, filter: path => !path.endsWith("/.git") });
  if (existsSync(patch) && readFileSync(patch, "utf8").trim()) {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", patch], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    await rm(join(dir, ".git"), { recursive: true, force: true });
  }
  return dir;
}

export async function diagnose(taskId: string, patch: string, label: string): Promise<Diagnosis> {
  const task = await loadTask(taskId);
  const dir = await copyWithPatch(task, patch);
  try {
    if (task.kind === "suite") {
      const { grade } = await gradeWorkspace(task, dir);
      return { label, patch, statuses: {}, failToPass: [], passToPassFailing: [], exit: null, failures: {}, detail: JSON.stringify(grade.checks) };
    }
    // As gradeWorkspace: original tests and runner configs restored, new runner files removed, hidden test patch applied.
    for (const [rel, text] of protectedFiles(task.source)) { await mkdir(join(dir, rel, ".."), { recursive: true }); await writeFile(join(dir, rel), text); }
    for (const rel of protectedFiles(dir).keys()) if (!existsSync(join(task.source, rel)) && ["conftest.py", "pytest.ini", ".pytest.ini", "tox.ini"].includes(rel.split("/").at(-1)!)) await rm(join(dir, rel), { force: true });
    const hidden = join(task.dir, "hidden/test.patch");
    for (const file of [...(await readFile(hidden, "utf8")).matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]!)) {
      if (existsSync(join(task.source, file))) { await mkdir(join(dir, file, ".."), { recursive: true }); await cp(join(task.source, file), join(dir, file)); } else await rm(join(dir, file), { force: true });
    }
    execFileSync("git", ["apply", "--whitespace=nowarn", hidden], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const bin = join(dir, ".bench-bin");
    await pythonWrappers(task, dir, bin);
    const command = String(task.manifest.testCmd).replace(/^pytest\b/, `'${join(bin, "pytest")}'`).replace(/--tb=line/, "--tb=short");
    const run = await execIn("bash", ["-c", command], dir, { ...process.env, PATH: `${bin}:${process.env.PATH}`, PYTHONHASHSEED: "0" }, 900_000);
    const statuses = new Map<string, string>();
    for (const line of run.text.split("\n")) {
      const match = /^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S.*?)(?:\s+-\s+.*)?$/.exec(line.trim());
      if (match && match[2]!.includes("::")) statuses.set(match[2]!.trim(), match[1]!);
    }
    const excluded = new Set<string>(task.manifest.excludedPassToPass ?? []);
    const p2pIds: string[] = Array.isArray(task.manifest.passToPass) ? task.manifest.passToPass : JSON.parse(String(task.manifest.passToPass).replace(/'/g, '"'));
    return {
      label, patch, statuses: Object.fromEntries(statuses), exit: run.code,
      failToPass: (task.manifest.failToPass as string[]).map(id => ({ id, status: statusOf(statuses, id) })),
      passToPassFailing: p2pIds.filter(id => !excluded.has(id)).map(id => ({ id, status: statusOf(statuses, id) })).filter(item => item.status !== "PASSED"),
      failures: failureSections(run.text),
      detail: run.text.slice(-400_000),
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const [pilotArg, ...wanted] = process.argv.slice(2);
  if (!pilotArg) throw new Error("usage: diagnose.ts <pilot dir> [unit ...]");
  const pilot = resolve(pilotArg);
  const source = resolve(pilot, "../bench-2026-10-19");
  const jobs = JOBS.filter(job => !wanted.length || wanted.includes(job.unit));
  const work: { unit: string; task: string; label: string; patch: string }[] = [];
  for (const job of jobs) {
    work.push({ unit: job.unit, task: job.task, label: "pre", patch: join(source, "units", job.unit, "O/checkpoint.diff") });
    for (const arm of job.arms) for (const kind of ["checkpoint", "final"] as const) {
      const armDir = join(pilot, "units", job.unit, arm);
      // An arm's checkpoint with O's work-state hash (fidelity.json sameState) is the pre-review state: "pre" covers it.
      if (kind === "checkpoint" && JSON.parse(existsSync(join(armDir, "fidelity.json")) ? readFileSync(join(armDir, "fidelity.json"), "utf8") : "{}").sameState === true) continue;
      const patch = join(pilot, "units", job.unit, arm, `${kind}.diff`);
      if (existsSync(patch) && existsSync(join(pilot, "units", job.unit, arm, "meta.json"))) work.push({ unit: job.unit, task: job.task, label: `${arm}-${kind}`, patch });
    }
  }
  const queue = [...work];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (existsSync(join(pilot, "diagnostics", item.unit, `${item.label}.json`))) continue; // resumable: done earlier
      const out = join(pilot, "diagnostics", item.unit);
      await mkdir(out, { recursive: true });
      try {
        const result = await diagnose(item.task, item.patch, item.label);
        const { detail, ...rest } = result;
        await writeFile(join(out, `${item.label}.json`), `${JSON.stringify(rest, null, 2)}\n`);
        if (detail) await writeFile(join(out, `${item.label}.txt`), detail);
        console.log(`${item.unit} ${item.label}: F2P ${result.failToPass.filter(test => test.status !== "PASSED").length} failing, P2P ${result.passToPassFailing.length} failing`);
      } catch (error) { console.log(`${item.unit} ${item.label}: error ${String(error).slice(0, 300)}`); }
    }
  }));
}
if (process.argv[1]?.endsWith("pilot/diagnose.ts")) await main();
