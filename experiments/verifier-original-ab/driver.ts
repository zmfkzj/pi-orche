/**
 * Driver of the verifier original-evidence A/B (README.md).
 *
 *   npx tsx experiments/verifier-original-ab/driver.ts <plan.json>
 *
 * plan.json: { out, phase: "pilot" | "main", replicate, concurrency, scratch, set?: "s1" | "s2" }
 * - Freezes the WORKING TREE's src/ (the uncommitted production change under test), package.json, tsconfig.json and this harness
 *   into <out>/frozen with their hashes (frozen.json); a relaunch whose harness or frozen production files differ is refused.
 * - Runs one replicate of every case (pilot: the pilot-only cases) in the seeded order of protocol.ts `schedule`, `concurrency`
 *   processes at a time. Each run gets a fresh temp dir under `scratch` with a private agent dir (credentials and provider files
 *   copied), private HOME (provider config and model cache copied), TMPDIR and XDG dirs; no PI_*, ORCHE_* or XDG_* variable is
 *   inherited. Resume: a completed cell is skipped. Retry: infrastructure only, once; the first attempt is kept as <cell>-infra-1.
 * - Budget: no new run once the study's estimated cost (sum of every attempt's costUSD) passes the cap of protocol.ts LIMITS.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, PILOT_CASES } from "./cases.js";
import { CASES_2 } from "./cases-2.js";
import { LIMITS, MODEL, SEED, cellId, schedule, type Cell } from "./protocol.js";

export interface Plan { out: string; phase: "pilot" | "main"; replicate: number; concurrency: number; scratch: string; /** "s2": study 2's cases (PREREGISTRATION-2.md); default: study 1. */ set?: "s1" | "s2" }

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../..");
const AGENT = join(homedir(), ".pi/agent");
const PROVIDER_DIR = resolve(REPO, "../cliproxyapi");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
  });
}
/** A digest of a directory tree: sorted relative paths with the sha256 of each file. */
export const treeDigest = (dir: string) => sha(filesBelow(dir).map(file => relative(dir, file)).sort().map(path => `${path}\0${sha(readFileSync(join(dir, path)))}\n`).join(""));
const harnessFiles = () => readdirSync(HERE).filter(name => name.endsWith(".ts") || name.endsWith(".md")).sort();
const INTERVENTION = ["src/orchestration/handoff-evidence.ts", "src/extension/workers.ts", "src/single/ledger.ts", "src/orchestrator/sub-worker.ts"];

async function freeze(out: string): Promise<string> {
  const root = join(out, "frozen");
  if (existsSync(join(root, "frozen.json"))) {
    const recorded = JSON.parse(readFileSync(join(root, "frozen.json"), "utf8"));
    const changed = harnessFiles().filter(name => name.endsWith(".ts") && recorded.harness[name] !== sha(readFileSync(join(HERE, name))));
    if (changed.length) throw new Error(`harness changed since launch (${changed.join(", ")}): use a fresh out directory`);
    const drift = INTERVENTION.filter(path => recorded.intervention[path] !== sha(readFileSync(join(REPO, path))));
    if (drift.length) throw new Error(`production files changed since launch (${drift.join(", ")}): the intervention must stay fixed`);
    return root;
  }
  await mkdir(root, { recursive: true });
  for (const name of ["src", "package.json", "tsconfig.json"]) await cp(join(REPO, name), join(root, name), { recursive: true });
  await symlink(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  await mkdir(join(root, "experiments/verifier-original-ab"), { recursive: true });
  const harness: Record<string, string> = {};
  for (const name of harnessFiles()) { await copyFile(join(HERE, name), join(root, "experiments/verifier-original-ab", name)); harness[name] = sha(readFileSync(join(HERE, name))); }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: REPO }).toString().trim().split("\n").filter(Boolean);
  const intervention = Object.fromEntries(INTERVENTION.map(path => [path, sha(readFileSync(join(REPO, path)))]));
  const srcDigest = treeDigest(join(root, "src"));
  await writeFile(join(root, "REVISION"), `${head}+worktree-src:${srcDigest.slice(0, 12)}\n`);
  await writeFile(join(root, "frozen.json"), JSON.stringify({ head, gitStatus: status, srcDigest, intervention, harness, frozenAt: new Date().toISOString(), providerDir: PROVIDER_DIR, providerRevision: gitRev(PROVIDER_DIR) }, null, 2));
  return root;
}
const gitRev = (dir: string) => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim(); } catch { return undefined; } };

async function overlay(temp: string) {
  const agentDir = join(temp, "agent"), home = join(temp, "home");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json", "cliproxyapi.json", "cliproxyapi-models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(agentDir, name));
  const providerConfig = join(AGENT, "pi-cliproxyapi-provider/config.json");
  if (existsSync(providerConfig)) { await mkdir(join(home, ".pi/agent/pi-cliproxyapi-provider"), { recursive: true, mode: 0o700 }); await copyFile(providerConfig, join(home, ".pi/agent/pi-cliproxyapi-provider/config.json")); }
  const cache = join(homedir(), ".cache/pi-cliproxyapi-provider");
  if (existsSync(cache)) await cp(cache, join(home, ".cache/pi-cliproxyapi-provider"), { recursive: true });
  for (const dir of ["tmp", "xdg/config", "xdg/data", "xdg/state"]) await mkdir(join(temp, dir), { recursive: true });
  await mkdir(join(home, ".cache"), { recursive: true });
  return { agentDir, home };
}

const cellDir = (out: string, phase: string, cell: Pick<Cell, "caseId" | "arm" | "replicate">) => join(out, "runs", phase, cell.caseId, cell.arm, `r${cell.replicate}`);
const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };

/** Estimated spend of a study: every attempt's costUSD (catalog prices), infra attempts included. */
export function spent(out: string): number {
  const runs = join(out, "runs");
  if (!existsSync(runs)) return 0;
  return filesBelow(runs).filter(file => file.endsWith("meta.json")).reduce((sum, file) => { try { return sum + (JSON.parse(readFileSync(file, "utf8")).outcome?.costUSD ?? 0); } catch { return sum; } }, 0);
}

async function runCell(plan: Plan, frozen: string, cell: Cell, log: (line: string) => Promise<void>) {
  const dir = cellDir(plan.out, plan.phase, cell);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await mkdir(plan.scratch, { recursive: true });
    const temp = await mkdtemp(join(plan.scratch, "run-"));
    const { agentDir, home } = await overlay(temp);
    await mkdir(dir, { recursive: true });
    const input = { out: dir, caseId: cell.caseId, arm: cell.arm, replicate: cell.replicate, temp, providerDir: PROVIDER_DIR, attempt };
    await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PI_|ORCHE_|XDG_)/.test(name)));
    Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, HOME: home, TMPDIR: join(temp, "tmp"), XDG_CONFIG_HOME: join(temp, "xdg/config"), XDG_DATA_HOME: join(temp, "xdg/data"), XDG_STATE_HOME: join(temp, "xdg/state"), XDG_CACHE_HOME: join(home, ".cache") });
    const started = Date.now();
    await log(`START ${cellId(cell)} attempt ${attempt}`);
    const code = await new Promise<number | null>(done => {
      const child = spawn(process.execPath, ["--import", "tsx", join(frozen, "experiments/verifier-original-ab/run-one.ts"), join(dir, "input.json")], { cwd: frozen, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { void appendFile(join(dir, "stdout.txt"), chunk); });
      child.stderr.on("data", chunk => { void appendFile(join(dir, "stderr.txt"), chunk); });
      child.once("close", done);
    });
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    let meta = readMeta(dir);
    if (meta?.status !== "completed") {
      meta = { ...(meta ?? input), status: "completed", class: "infra", infraError: `run process exited ${code} before completing` };
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    }
    await log(`END ${cellId(cell)} attempt ${attempt}: exit ${code}, ${meta.class}${meta.verdict ? ` ${meta.verdict}` : ""}, ${Math.round((Date.now() - started) / 1000)}s, $${(meta.outcome?.costUSD ?? 0).toFixed(3)}`);
    if (meta.class !== "infra" || attempt === 2) return meta;
    await rename(dir, `${dir}-infra-1`);
  }
}

export async function drive(plan: Plan) {
  plan.out = resolve(plan.out);
  await mkdir(plan.out, { recursive: true });
  const frozen = await freeze(plan.out);
  const cases = plan.phase === "pilot" ? PILOT_CASES : plan.set === "s2" ? CASES_2 : CASES;
  const cap = plan.phase === "pilot" ? LIMITS.pilotCostCapUsd : plan.set === "s2" ? LIMITS.study2CostCapUsd : LIMITS.studyCostCapUsd;
  const cells = schedule(cases.map(item => item.id), plan.replicate, SEED);
  const planFile = join(plan.out, `plan-${plan.phase}-r${plan.replicate}.json`);
  if (!existsSync(planFile)) await writeFile(planFile, JSON.stringify({ ...plan, seed: SEED, cells, limits: LIMITS, model: MODEL, launchedAt: new Date().toISOString() }, null, 2));
  const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(join(plan.out, `driver-${plan.phase}.log`), `${text}\n`); };
  const pending = cells.filter(cell => readMeta(cellDir(plan.out, plan.phase, cell))?.status !== "completed");
  await log(`${plan.phase} r${plan.replicate}: ${cells.length} cells, ${pending.length} to run, concurrency ${plan.concurrency}, spent so far $${spent(plan.out).toFixed(2)}`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, plan.concurrency) }, async () => {
    while (next < pending.length) {
      if (spent(plan.out) > cap) { await log(`budget cap ${cap} USD reached ($${spent(plan.out).toFixed(2)}): no new runs`); return; }
      await runCell(plan, frozen, pending[next++]!, log);
    }
  }));
  await log(`done ${plan.phase} r${plan.replicate}; estimated spend $${spent(plan.out).toFixed(2)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(process.argv[2]!);
  const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
  await drive({ ...plan, out: resolve(dirname(file), plan.out), scratch: resolve(dirname(file), plan.scratch) });
}
