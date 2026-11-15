/**
 * Driver of the decision-memory A/B (README.md).
 *
 *   npx tsx experiments/decision-memory-ab/driver.ts <plan.json>
 *
 * plan.json: { out, tasks, repeats, concurrency, seed, scratch, phase }
 * - Freezes orche at HEAD (git archive of src/, package.json, tsconfig.json; node_modules linked) together with this harness into
 *   <out>/frozen, so later edits of the repository cannot change a running study; a relaunch with a different HEAD or harness is refused.
 * - Runs the pre-randomized cells of protocol.ts `schedule` with `concurrency` processes. Each run gets a fresh temp dir under
 *   `scratch` with a private agent dir (credentials and provider settings copied), a private HOME (the provider's user config with
 *   the window override, a copy of its model cache), private TMPDIR and XDG dirs; no PI_* variable of the calling session is inherited.
 * - Resume: a cell whose meta.json says completed is skipped. Retry: protocol.ts RETRY_RULE. Budget: LIMITS.studyCostCapUsd.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, MODEL, WINDOW_TOKENS, cellId, schedule, type Cell, type Linkage } from "./protocol.js";
import type { TaskId } from "./project.js";

export interface Plan { out: string; tasks: TaskId[]; repeats: number; concurrency: number; seed: number; scratch: string; phase: string; linkage?: Linkage }

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../..");
const AGENT = join(homedir(), ".pi/agent");
/** The CLIProxyAPI provider bundle as the umbrella package ships it (development checkout). */
const PROVIDER_DIR = resolve(REPO, "../cliproxyapi");

async function freeze(out: string): Promise<{ root: string; sha: string }> {
  const root = join(out, "frozen");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
  const harness = readdirSync(HERE).filter(name => name.endsWith(".ts")).sort();
  if (existsSync(join(root, "REVISION"))) {
    const existing = readFileSync(join(root, "REVISION"), "utf8").trim();
    if (existing !== sha) throw new Error(`${root} froze ${existing}, HEAD is ${sha}: use a fresh out directory`);
    const changed = harness.filter(name => readFileSync(join(root, "experiments/decision-memory-ab", name), "utf8") !== readFileSync(join(HERE, name), "utf8"));
    if (changed.length) throw new Error(`harness changed since launch (${changed.join(", ")}): use a fresh out directory`);
    return { root, sha };
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src", "package.json", "tsconfig.json"], { cwd: REPO }).toString().trim();
  await mkdir(root, { recursive: true });
  execFileSync("tar", ["-x", "-C", root], { input: execFileSync("git", ["archive", sha, "src", "package.json", "tsconfig.json"], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 }) });
  await symlink(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  await mkdir(join(root, "experiments/decision-memory-ab"), { recursive: true });
  for (const name of harness) await copyFile(join(HERE, name), join(root, "experiments/decision-memory-ab", name));
  await writeFile(join(root, "REVISION"), `${sha}\n`);
  await writeFile(join(root, "frozen.json"), JSON.stringify({ sha, repoDirtyRuntimeFiles: dirty ? dirty.split("\n") : [], harness, frozenAt: new Date().toISOString(), providerDir: PROVIDER_DIR, providerRevision: gitRev(PROVIDER_DIR) }, null, 2));
  return { root, sha };
}
const gitRev = (dir: string) => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim(); } catch { return undefined; } };

/** The run's private overlay: agent dir, HOME (provider config with the window override, model cache copy), TMPDIR, XDG dirs. */
async function overlay(temp: string) {
  const agentDir = join(temp, "agent"), home = join(temp, "home");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json", "cliproxyapi.json", "cliproxyapi-models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(agentDir, name));
  const providerConfigDir = join(home, ".pi/agent/pi-cliproxyapi-provider");
  await mkdir(providerConfigDir, { recursive: true, mode: 0o700 });
  const userProvider = join(AGENT, "pi-cliproxyapi-provider/config.json");
  const base = existsSync(userProvider) ? JSON.parse(readFileSync(userProvider, "utf8")) : {};
  await writeFile(join(providerConfigDir, "config.json"), JSON.stringify({ ...base, modelOverrides: { ...(base.modelOverrides ?? {}), [MODEL.id]: { contextWindow: WINDOW_TOKENS } } }, null, 2), { mode: 0o600 });
  const cache = join(homedir(), ".cache/pi-cliproxyapi-provider");
  if (existsSync(cache)) await cp(cache, join(home, ".cache/pi-cliproxyapi-provider"), { recursive: true });
  for (const dir of ["tmp", "xdg/config", "xdg/data", "xdg/state", ".cache"]) await mkdir(join(dir.startsWith("x") || dir === "tmp" ? temp : home, dir), { recursive: true });
  return { agentDir, home };
}

const cellDir = (out: string, cell: Pick<Cell, "task" | "arm" | "repeat">) => join(out, "runs", cell.task, cell.arm, `r${cell.repeat}`);
const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };

async function runCell(plan: Plan, frozen: string, cell: Cell, log: (line: string) => Promise<void>) {
  const dir = cellDir(plan.out, cell);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await mkdir(plan.scratch, { recursive: true });
    const temp = await mkdtemp(join(plan.scratch, "run-"));
    const { agentDir, home } = await overlay(temp);
    await mkdir(dir, { recursive: true });
    const input = { out: dir, task: cell.task, arm: cell.arm, repeat: cell.repeat, temp, providerDir: PROVIDER_DIR, linkage: plan.linkage ?? "off" };
    await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PI_|ORCHE_|XDG_)/.test(name)));
    Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, HOME: home, TMPDIR: join(temp, "tmp"), XDG_CONFIG_HOME: join(temp, "xdg/config"), XDG_DATA_HOME: join(temp, "xdg/data"), XDG_STATE_HOME: join(temp, "xdg/state"), XDG_CACHE_HOME: join(home, ".cache") });
    const started = Date.now();
    await log(`START ${cellId(cell)} attempt ${attempt}`);
    const code = await new Promise<number | null>(done => {
      const child = spawn(process.execPath, ["--import", "tsx", join(frozen, "experiments/decision-memory-ab/run-one.ts"), join(dir, "input.json")], { cwd: frozen, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { void appendFile(join(dir, "stdout.txt"), chunk); });
      child.stderr.on("data", chunk => { void appendFile(join(dir, "stderr.txt"), chunk); });
      child.once("close", done);
    });
    await rm(temp, { recursive: true, force: true }).catch(() => undefined); // credentials copies, workspace and caches go with it
    let meta = readMeta(dir);
    if (meta?.status !== "completed") {
      meta = { ...(meta ?? input), status: "completed", outcome: "infra", infraError: `run process exited ${code} before completing` };
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    }
    await log(`END ${cellId(cell)} attempt ${attempt}: exit ${code}, ${meta.outcome}, ${Math.round((Date.now() - started) / 1000)}s`);
    if (meta.outcome !== "infra" || attempt === 2) return meta;
    await rename(dir, `${dir}-infra-${attempt}`);
  }
}

export async function drive(plan: Plan) {
  plan.out = resolve(plan.out);
  await mkdir(plan.out, { recursive: true });
  const { root, sha } = await freeze(plan.out);
  const cells = schedule(plan.tasks, plan.repeats, plan.seed);
  await writeFile(join(plan.out, `plan-${plan.phase}.json`), JSON.stringify({ ...plan, sha, cells, limits: LIMITS, model: MODEL, windowTokens: WINDOW_TOKENS, launchedAt: new Date().toISOString() }, null, 2));
  const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(join(plan.out, `driver-${plan.phase}.log`), `${text}\n`); };
  const pending = cells.filter(cell => readMeta(cellDir(plan.out, cell))?.status !== "completed");
  await log(`${cells.length} cells, ${pending.length} to run, concurrency ${plan.concurrency}, frozen ${sha}`);
  const spent = () => cells.reduce((total, cell) => total + ((readMeta(cellDir(plan.out, cell))?.transcripts ?? []) as any[]).reduce((sum, t) => sum + (t.costEstimate ?? 0), 0), 0);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, plan.concurrency) }, async () => {
    while (next < pending.length) {
      if (spent() > LIMITS.studyCostCapUsd) { await log(`budget cap ${LIMITS.studyCostCapUsd} USD reached (${spent().toFixed(2)}): no new runs`); return; }
      await runCell(plan, root, pending[next++]!, log);
    }
  }));
  await log(`done; estimated spend ${spent().toFixed(2)} USD`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Plan;
  await drive({ ...plan, out: resolve(dirname(process.argv[2]!), plan.out) });
}
