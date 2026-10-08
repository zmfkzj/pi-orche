/**
 * Driver of the advisor/reviewer benchmark (docs/advisor-reviewer-bench.md).
 *
 *   npx tsx experiments/advisor-reviewer/driver.ts <plan.json>
 *
 * plan.json: { out, revision, tasks: [ids], arms: ["baseline", ...], repeats, concurrency, phase, scratch? }
 * - Freezes orche at `revision` (git archive of src/, package.json, tsconfig.json into <out>/rt, node_modules linked) so later edits of
 *   the repository cannot change a running study.
 * - Runs the cells of protocol.ts `schedule` (repeat-major, arm order rotated per task) with `concurrency` processes, each run in a
 *   fresh temp dir with a private agent dir (credentials and provider catalog copied, the provider package linked; the user's
 *   settings and orche.config.json are never read or written).
 * - Resume: a cell whose meta.json says completed is skipped. Retry policy: a run classified `infra` (harness error or no successful
 *   worker request) is retried ONCE; the failed attempt is kept as `<cell>-infra-1`. Timeouts and failed grades are never retried.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, cellId, schedule, type Arm, type Cell } from "./protocol.js";
import { REPO } from "./tasks.js";

export interface Plan { out: string; revision: string; tasks: string[]; arms: Arm[]; repeats: number; concurrency: number; phase: string; scratch?: string }

const AGENT = join(homedir(), ".pi/agent");
const HERE = fileURLToPath(new URL(".", import.meta.url));

async function snapshot(out: string, revision: string): Promise<string> {
  const rt = join(out, "rt");
  const sha = execFileSync("git", ["rev-parse", revision], { cwd: REPO }).toString().trim();
  if (existsSync(join(rt, "REVISION"))) {
    const existing = readFileSync(join(rt, "REVISION"), "utf8").trim();
    if (existing !== sha) throw new Error(`Snapshot ${rt} is ${existing}, plan asks ${sha}: use a fresh out directory`);
    return rt;
  }
  await mkdir(rt, { recursive: true });
  const archive = execFileSync("git", ["archive", sha, "src", "package.json", "tsconfig.json"], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", rt], { input: archive });
  await symlink(join(REPO, "node_modules"), join(rt, "node_modules"), "dir");
  await writeFile(join(rt, "REVISION"), `${sha}\n`);
  return rt;
}

/**
 * Freeze the harness too: its .ts files are copied into <out>/harness once and every run of this study executes that copy, so editing
 * experiments/advisor-reviewer while a study runs cannot change it. A later launch with different harness files is refused.
 */
async function freezeHarness(out: string): Promise<string> {
  const dir = join(out, "harness");
  const files = readdirSync(HERE).filter(name => name.endsWith(".ts")).sort();
  if (existsSync(dir)) {
    const changed = files.filter(name => !existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== readFileSync(join(HERE, name), "utf8"));
    if (changed.length) throw new Error(`Harness changed since this study was launched (${changed.join(", ")}): use a fresh out directory`);
    return dir;
  }
  await mkdir(dir, { recursive: true });
  for (const name of files) await copyFile(join(HERE, name), join(dir, name));
  return dir;
}

async function overlay(temp: string): Promise<string> {
  const dir = join(temp, "agent");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "cliproxyapi.json", "cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(dir, name));
  await symlink(join(AGENT, "npm"), join(dir, "npm"), "dir");
  return dir;
}

const cellDir = (out: string, cell: Cell) => join(out, "runs", cell.task, cell.arm, `r${cell.repeat}`);
const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };

async function runCell(plan: Plan, rt: string, harness: string, cell: Cell, log: (line: string) => Promise<void>): Promise<any> {
  const dir = cellDir(plan.out, cell);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const scratch = plan.scratch ?? join(tmpdir(), "advisor-bench");
    await mkdir(scratch, { recursive: true });
    const temp = await mkdtemp(join(scratch, "run-"));
    const agentDir = await overlay(temp);
    await mkdir(dir, { recursive: true });
    const input = { out: dir, runtime: rt, task: cell.task, arm: cell.arm, repeat: cell.repeat, temp, phase: plan.phase };
    await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temp, ADVISOR_BENCH_REPO: REPO };
    for (const name of Object.keys(env)) if (/^PI_(SESSION|PROVIDER|MODEL|REASONING|CODING_AGENT$)/.test(name)) delete env[name];
    env.PI_CODING_AGENT_DIR = agentDir;
    const started = Date.now();
    await log(`START ${cellId(cell)} attempt ${attempt}`);
    const code = await new Promise<number | null>(done => {
      const child = spawn(process.execPath, ["--import", "tsx", join(harness, "run-one.ts"), join(dir, "input.json")], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { void appendFile(join(dir, "stdout.txt"), chunk); });
      child.stderr.on("data", chunk => { void appendFile(join(dir, "stderr.txt"), chunk); });
      child.once("close", done);
    });
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    const meta = readMeta(dir);
    const outcome = meta?.status === "completed" ? meta.outcome : "infra";
    await log(`END ${cellId(cell)} attempt ${attempt}: exit ${code}, ${outcome}, ${Math.round((Date.now() - started) / 1000)}s`);
    if (meta?.status !== "completed") {
      // The process died before finishing (guard, crash): record it as an infrastructure failure of this attempt.
      await writeFile(join(dir, "meta.json"), JSON.stringify({ ...(meta ?? input), status: "completed", outcome: "infra", infraError: `run process exited ${code} before completing` }, null, 2));
    }
    if (outcome !== "infra" || attempt === 2) return readMeta(dir);
    await rename(dir, `${dir}-infra-${attempt}`);
  }
}

export async function drive(plan: Plan): Promise<void> {
  plan.out = resolve(plan.out);
  await mkdir(plan.out, { recursive: true });
  for (const arm of plan.arms) if (!ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`);
  const rt = await snapshot(plan.out, plan.revision);
  const harness = await freezeHarness(plan.out);
  const cells = schedule(plan.tasks, plan.arms, plan.repeats);
  await writeFile(join(plan.out, `plan-${plan.phase}.json`), JSON.stringify({ ...plan, revisionSha: readFileSync(join(rt, "REVISION"), "utf8").trim(), cells, launchedAt: new Date().toISOString() }, null, 2));
  const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(join(plan.out, `driver-${plan.phase}.log`), `${text}\n`); };
  const pending = cells.filter(cell => readMeta(cellDir(plan.out, cell))?.status !== "completed");
  await log(`${cells.length} cells, ${cells.length - pending.length} already completed, ${pending.length} to run, concurrency ${plan.concurrency}`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, plan.concurrency) }, async () => {
    while (next < pending.length) await runCell(plan, rt, harness, pending[next++]!, log);
  }));
  await log("done");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await drive(JSON.parse(readFileSync(process.argv[2]!, "utf8")));
}
