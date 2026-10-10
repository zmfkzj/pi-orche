/**
 * Model-free validation of the ultra-vs-single grader and environment, for every pilot and main task (experiments/ultra-ab/tasks.json):
 * - the starting snapshot must FAIL the grade (the task is not already solved) with no integrity finding;
 * - the reference solution must PASS with no integrity violation;
 * - the reference plus a weakened original test (a removed assertion line) must be flagged as an integrity violation;
 * - SWE: the Python wrapper must import the code of the project the shell is in (two copies with different code → different
 *   `__file__`), so ultra's candidate copies test their own code.
 *
 *   npx tsx experiments/ultra-ab/validate.ts <out.json> [task ...]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execIn, gradeWorkspace, loadTask, protectedFiles, pythonWrappers, type Task } from "./env.js";
import { isTestFile } from "./protocol.js";
import { pythonWrappers as legacyWrappers } from "../advisor-reviewer/tasks.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function withReference(task: Task, dir: string): Promise<void> {
  if (task.kind === "suite") await cp(join(task.dir, "reference"), dir, { recursive: true });
  else execFileSync("git", ["apply", "--whitespace=nowarn", join(task.dir, "reference/fix.patch")], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

async function validate(id: string): Promise<Record<string, unknown>> {
  const task = await loadTask(id);
  const root = await mkdtemp(join(tmpdir(), "ultra-ab-validate-"));
  const result: Record<string, unknown> = { task: id, kind: task.kind };
  try {
    const start = join(root, "start"); await cp(task.source, start, { recursive: true, filter: path => !path.endsWith("/.git") });
    const initial = await gradeWorkspace(task, start);
    result.initialFails = !initial.grade.passed && !initial.grade.error;
    result.initialDetail = Object.fromEntries(Object.entries(initial.grade.checks).map(([name, check]) => [name, check.passed]));
    result.initialIntegrityClean = initial.integrity.violations.length === 0;
    const ref = join(root, "ref"); await cp(start, ref, { recursive: true }); await withReference(task, ref);
    const reference = await gradeWorkspace(task, ref);
    result.referencePasses = reference.grade.passed;
    result.referenceDetail = reference.grade.error ?? Object.fromEntries(Object.entries(reference.grade.checks).map(([name, check]) => [name, check.passed ? true : check.detail.slice(0, 300)]));
    result.referenceIntegrityClean = reference.integrity.violations.length === 0;
    // Tamper: remove one assertion line from the first original test file that has one.
    const tamper = join(root, "tamper"); await cp(ref, tamper, { recursive: true });
    const victim = [...protectedFiles(task.source)].find(([path, text]) => isTestFile(path) && /assert/.test(text));
    if (victim) {
      const lines = victim[1].split("\n"); const index = lines.findIndex(line => /assert/.test(line));
      lines.splice(index, 1); await writeFile(join(tamper, victim[0]), lines.join("\n"));
      const tampered = await gradeWorkspace(task, tamper);
      result.tamperFlagged = tampered.integrity.violations.length > 0;
    } else result.tamperFlagged = "no test file with an assertion";
    if (task.kind === "swe") {
      // Two copies, the second with a marker in its package: the wrapper must import each copy's own package.
      const a = join(root, "copy-a"), b = join(root, "copy-b");
      await cp(start, a, { recursive: true }); await cp(start, b, { recursive: true });
      const bin = join(root, "bin"); await pythonWrappers(task, start, bin);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      const sub = task.manifest.pythonPath && task.manifest.pythonPath !== "." ? task.manifest.pythonPath : ".";
      await writeFile(join(a, sub, "_abprobe.py"), "print('copy-a')\n"); await writeFile(join(b, sub, "_abprobe.py"), "print('copy-b')\n");
      // Probe from a subdirectory: Python puts the current directory first on sys.path, so only PYTHONPATH can find the copy's package.
      await mkdir(join(a, "_abdir"), { recursive: true }); await mkdir(join(b, "_abdir"), { recursive: true });
      const runA = await execIn("python", ["-c", "import _abprobe"], join(a, "_abdir"), env, 60_000);
      const runB = await execIn("pytest", ["--version"], b, env, 60_000);
      const runB2 = await execIn("python", ["-c", "import _abprobe"], join(b, "_abdir"), env, 60_000);
      result.wrapperFollowsCwd = runA.text.trim() === "copy-a" && runB2.text.trim() === "copy-b" && runB.code === 0;
      // The earlier harness's wrapper (experiments/advisor-reviewer/tasks.ts) pins the first workspace: copy b would import copy a.
      const legacyBin = join(root, "legacy-bin"); await legacyWrappers({ id: task.id, pythonPath: task.manifest.pythonPath }, a, legacyBin);
      const legacy = await execIn("python", ["-c", "import _abprobe"], join(b, "_abdir"), { ...process.env, PATH: `${legacyBin}:${process.env.PATH}` }, 60_000);
      result.legacyWrapperImportedFromCopyB = legacy.text.trim();
      result.wrapperPaths = [runA.text.trim(), runB2.text.trim(), runB.text.trim().slice(0, 80)];
    }
  } catch (error) { result.error = String(error instanceof Error ? error.stack : error).slice(0, 1500); }
  finally { await rm(root, { recursive: true, force: true }); }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2]!;
  const tasks = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf8"));
  const ids: string[] = process.argv.length > 3 ? process.argv.slice(3) : [...tasks.pilot, ...tasks.main].map((item: any) => item.task);
  const results = [];
  for (const id of ids) { const result = await validate(id); results.push(result); console.log(JSON.stringify(result)); }
  const ok = results.every(item => item.initialFails === true && item.initialIntegrityClean === true && item.referencePasses === true && item.referenceIntegrityClean === true && item.tamperFlagged !== false && item.wrapperFollowsCwd !== false && !item.error);
  await writeFile(out, `${JSON.stringify({ ok, at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(ok ? "VALIDATION OK" : "VALIDATION FAILED");
  void readFile;
}
