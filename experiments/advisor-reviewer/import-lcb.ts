/**
 * Import LiveCodeBench AtCoder problems from the iso-token study's local copy (results/iso-token, not tracked) into
 * fixtures/advisor-bench/lcb/<id>: public/ (problem.md, examples.json: the worker's workspace) and hidden/tests.json (every test of the
 * problem, the grader's only input). Records the source files' SHA-256 so the import can be checked.
 *
 *   npx tsx experiments/advisor-reviewer/import-lcb.ts lcb-atcoder-abc390_f [...]
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LCB_DIR, REPO } from "./tasks.js";

const SOURCE = join(REPO, "results/iso-token");

for (const id of process.argv.slice(2)) {
  const goldFile = join(SOURCE, "gold/coding", `${id}.json`);
  const goldText = await readFile(goldFile, "utf8");
  const gold = JSON.parse(goldText);
  if (gold.platform !== "atcoder" || String(gold.functional).toLowerCase() !== "false") throw new Error(`${id}: only stdin AtCoder problems are supported`);
  const task = JSON.parse(await readFile(join(SOURCE, "tasks/coding", id, "task.json"), "utf8"));
  const problem = await readFile(join(SOURCE, "tasks/coding", id, "public/problem.md"), "utf8");
  const title = /^#\s*(.+)$/m.exec(problem)?.[1]?.trim() ?? id;
  const dir = join(LCB_DIR, id);
  await mkdir(join(dir, "hidden"), { recursive: true });
  await cp(join(SOURCE, "tasks/coding", id, "public"), join(dir, "public"), { recursive: true });
  const tests = (gold.tests as { input: string; output: string; testtype: string }[]).map(test => ({ input: test.input, output: test.output }));
  await writeFile(join(dir, "hidden/tests.json"), JSON.stringify(tests));
  await writeFile(join(dir, "task.json"), `${JSON.stringify({
    id, title, prompt: task.prompt, difficulty: gold.difficulty, contestDate: gold.contest_date, platform: gold.platform, tests: tests.length,
    source: { gold: `results/iso-token/gold/coding/${id}.json`, goldSha256: createHash("sha256").update(goldText).digest("hex"), task: `results/iso-token/tasks/coding/${id}` },
  }, null, 2)}\n`);
  console.log(`${id}: ${title} (${gold.difficulty}, ${tests.length} tests)`);
}
