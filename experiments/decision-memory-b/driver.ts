/**
 * Driver of the combination-B re-evaluation (README.md).
 *
 *   npx tsx experiments/decision-memory-b/driver.ts <plan.json>
 *
 * plan.json: { out, seeds, concurrency, seed, scratch, phase, budgetUsd }
 * - Freezes the CURRENT WORKING TREE of the orche runtime (src/, package.json, tsconfig.json, uncommitted changes included) and this
 *   harness (plus experiments/decision-memory-ab/analyze.ts) into <out>/frozen, with a SHA-256 per file and one digest; a relaunch
 *   whose working tree or harness digest differs is refused.
 * - Runs protocol.ts `schedule` (one block of four arms per instance) with `concurrency` processes. Budget admission is per block:
 *   a block starts only while the summed estimated cost is below `budgetUsd`; a started block always runs all four arms.
 * - Each run gets a private agent dir (credentials and model files copied), a private HOME (the provider's user config with the
 *   window override and a COPY of its model cache: nothing is written to the user's HOME), private TMPDIR and XDG dirs; no PI_*,
 *   ORCHE_* or XDG_* variable of the calling session is inherited. Retry: protocol.ts RETRY_RULE.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, MODELS, RETRY_RULE, WINDOW_TOKENS, cellId, schedule, type Arm, type Cell, type ModelKey } from "./protocol.js";

export interface Plan { out: string; seeds: number[]; concurrency: number; seed: number; scratch: string; phase: string; budgetUsd: number; model?: ModelKey; arms?: Arm[];
  /** Admission reservation per run (USD): a new block starts only if spent + reserved in-flight runs + this block's reservation
   * stays within budgetUsd (experiments/memory-opus). Without it, the older rule: a block starts while spent < budgetUsd. */
  reservePerRunUsd?: number }

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../..");
const AGENT = join(homedir(), ".pi/agent");
const PROVIDER_DIR = resolve(REPO, "../cliproxyapi");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? listFiles(path) : [path]; });
}
/** The files frozen for a study and their hashes: runtime from the working tree, plus the harness. */
export function frozenManifest(): { files: Record<string, string>; digest: string } {
  const runtime = [...listFiles(join(REPO, "src")), join(REPO, "package.json"), join(REPO, "tsconfig.json")];
  const harness = [...readdirSync(HERE).filter(name => name.endsWith(".ts")).map(name => join(HERE, name)), join(REPO, "experiments/decision-memory-ab/analyze.ts")];
  const files = Object.fromEntries([...runtime, ...harness].map(path => [relative(REPO, path), sha(readFileSync(path))]).sort(([a], [b]) => (a ?? "") < (b ?? "") ? -1 : 1));
  return { files, digest: sha(Object.entries(files).map(([path, hash]) => `${path}\0${hash}\n`).join("")) };
}

async function freeze(out: string): Promise<{ root: string; digest: string }> {
  const root = join(out, "frozen");
  const manifest = frozenManifest();
  if (existsSync(join(root, "frozen.json"))) {
    const existing = JSON.parse(readFileSync(join(root, "frozen.json"), "utf8"));
    if (existing.digest !== manifest.digest) throw new Error(`${root} froze ${existing.digest}, the working tree is now ${manifest.digest}: use a fresh out directory`);
    return { root, digest: manifest.digest };
  }
  await mkdir(root, { recursive: true });
  for (const path of Object.keys(manifest.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(REPO, path), join(root, path));
  }
  await symlink(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  const mismatched = verifyFrozen(root, manifest.files);
  if (mismatched.length) throw new Error(`frozen copy differs from the hashed working tree: ${mismatched.join(", ")}`);
  const git = (args: string[], cwd = REPO) => { try { return execFileSync("git", args, { cwd }).toString().trim(); } catch { return undefined; } };
  await writeFile(join(root, "frozen.json"), JSON.stringify({ digest: manifest.digest, head: git(["rev-parse", "HEAD"]), dirtyRuntime: (git(["status", "--porcelain", "--", "src", "package.json", "tsconfig.json"]) ?? "").split("\n").filter(Boolean), files: manifest.files, frozenAt: new Date().toISOString(), providerDir: PROVIDER_DIR, providerRevision: git(["rev-parse", "HEAD"], PROVIDER_DIR), ...externals() }, null, 2));
  return { root, digest: manifest.digest };
}

/** Paths whose frozen copy no longer matches the recorded hash (checked after copying and again after a phase). */
export function verifyFrozen(root: string, files: Record<string, string>): string[] {
  return Object.entries(files).filter(([path, hash]) => { try { return sha(readFileSync(join(root, path))) !== hash; } catch { return true; } }).map(([path]) => path);
}

/** Versions and digests of what the frozen copy references from outside: node_modules (Pi, lockfile) and the provider extension. */
export function externals() {
  const version = (file: string) => { try { return JSON.parse(readFileSync(file, "utf8")).version as string; } catch { return undefined; } };
  const digest = (file: string) => { try { return sha(readFileSync(file)); } catch { return undefined; } };
  const git = (args: string[], cwd: string) => { try { return execFileSync("git", args, { cwd }).toString().trim(); } catch { return undefined; } };
  return {
    node: process.version,
    piCodingAgent: version(join(REPO, "node_modules/@earendil-works/pi-coding-agent/package.json")),
    packageLock: digest(join(REPO, "package-lock.json")),
    provider: { dir: PROVIDER_DIR, revision: git(["rev-parse", "HEAD"], PROVIDER_DIR), dirty: (git(["status", "--porcelain"], PROVIDER_DIR) ?? "").split("\n").filter(Boolean), version: version(join(PROVIDER_DIR, "package.json")), upstream: version(join(PROVIDER_DIR, "node_modules/pi-cliproxyapi-provider/package.json")), lock: digest(join(PROVIDER_DIR, "package-lock.json")) },
  };
}

/** The run's private overlay: agent dir, HOME (provider config with the window override, model cache copy), TMPDIR, XDG dirs. */
async function overlay(temp: string, modelId: string) {
  const agentDir = join(temp, "agent"), home = join(temp, "home");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json", "cliproxyapi.json", "cliproxyapi-models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(agentDir, name));
  const providerConfigDir = join(home, ".pi/agent/pi-cliproxyapi-provider");
  await mkdir(providerConfigDir, { recursive: true, mode: 0o700 });
  const userProvider = join(AGENT, "pi-cliproxyapi-provider/config.json");
  const base = existsSync(userProvider) ? JSON.parse(readFileSync(userProvider, "utf8")) : {};
  await writeFile(join(providerConfigDir, "config.json"), JSON.stringify({ ...base, modelOverrides: { ...(base.modelOverrides ?? {}), [modelId]: { contextWindow: WINDOW_TOKENS } } }, null, 2), { mode: 0o600 });
  const cache = join(homedir(), ".cache/pi-cliproxyapi-provider");
  if (existsSync(cache)) await cp(cache, join(home, ".cache/pi-cliproxyapi-provider"), { recursive: true });
  for (const dir of ["tmp", "xdg/config", "xdg/data", "xdg/state"]) await mkdir(join(temp, dir), { recursive: true });
  await mkdir(join(home, ".cache"), { recursive: true });
  return { agentDir, home };
}

export const cellDir = (out: string, cell: Pick<Cell, "seed" | "arm">) => join(out, "runs", `p${cell.seed}`, cell.arm);
const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };
const runCost = (meta: any) => ((meta?.transcripts ?? []) as any[]).reduce((sum, t) => sum + (t.costEstimate ?? 0), 0);

async function runCell(plan: Plan, frozen: string, cell: Cell, log: (line: string) => Promise<void>) {
  const dir = cellDir(plan.out, cell);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await mkdir(plan.scratch, { recursive: true });
    const temp = await mkdtemp(join(plan.scratch, "run-"));
    const { agentDir, home } = await overlay(temp, MODELS[plan.model ?? "opus"].id);
    await mkdir(dir, { recursive: true });
    const input = { out: dir, seed: cell.seed, arm: cell.arm, temp, providerDir: PROVIDER_DIR, phase: plan.phase, model: plan.model ?? "opus" };
    await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PI_|ORCHE_|XDG_|PARCELKIT_)/.test(name)));
    Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, HOME: home, TMPDIR: join(temp, "tmp"), XDG_CONFIG_HOME: join(temp, "xdg/config"), XDG_DATA_HOME: join(temp, "xdg/data"), XDG_STATE_HOME: join(temp, "xdg/state"), XDG_CACHE_HOME: join(home, ".cache") });
    const started = Date.now();
    await log(`START ${cellId(cell)} attempt ${attempt}`);
    const code = await new Promise<number | null>(done => {
      const child = spawn(process.execPath, ["--import", "tsx", join(frozen, "experiments/decision-memory-b/run-one.ts"), join(dir, "input.json")], { cwd: frozen, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { void appendFile(join(dir, "stdout.txt"), chunk); });
      child.stderr.on("data", chunk => { void appendFile(join(dir, "stderr.txt"), chunk); });
      child.once("close", done);
    });
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    let meta = readMeta(dir);
    if (meta?.status !== "completed") {
      // A process that died after the worker made progress is a FAILED run (counted, cost included, never retried); only a
      // process that died before any model response is infra.
      const transcripts = listFiles(dir).filter(path => /\/workers\/W\d+-[^/]+\.jsonl$/.test(path));
      const progressed = transcripts.some(path => readFileSync(path, "utf8").includes('"role":"assistant"'));
      if (progressed) {
        const { analyzeTranscript } = await import("../decision-memory-ab/analyze.js");
        meta = { ...(meta ?? input), status: "completed", outcome: "fail", harnessFailure: `run process exited ${code} after model progress`, transcripts: await Promise.all(transcripts.map(path => analyzeTranscript(path))) };
      } else meta = { ...(meta ?? input), status: "completed", outcome: "infra", infraError: `run process exited ${code} before completing` };
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    }
    await log(`END ${cellId(cell)} attempt ${attempt}: exit ${code}, ${meta.outcome}, score ${meta.grade?.score?.toFixed?.(3) ?? "-"}, ${Math.round((Date.now() - started) / 1000)}s, $${runCost(meta).toFixed(2)}`);
    if (meta.outcome !== "infra" || attempt === 2) return meta;
    await rename(dir, `${dir}-infra-${attempt}`);
  }
}

export async function drive(plan: Plan) {
  plan.out = resolve(plan.out);
  await mkdir(plan.out, { recursive: true });
  const { root, digest } = await freeze(plan.out);
  const cells = schedule(plan.seeds, plan.seed, plan.arms);
  await writeFile(join(plan.out, `plan-${plan.phase}.json`), JSON.stringify({ ...plan, digest, cells, limits: LIMITS, model: MODELS[plan.model ?? "opus"], windowTokens: WINDOW_TOKENS, retry: RETRY_RULE, launchedAt: new Date().toISOString() }, null, 2));
  const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(join(plan.out, `driver-${plan.phase}.log`), `${text}\n`); };
  const done = (cell: Cell) => readMeta(cellDir(plan.out, cell))?.status === "completed";
  const pending = cells.filter(cell => !done(cell));
  await log(`${cells.length} cells, ${pending.length} to run, concurrency ${plan.concurrency}, budget $${plan.budgetUsd}, frozen ${digest}`);
  const spent = () => {
    let total = 0;
    for (const cell of cells) {
      const dir = cellDir(plan.out, cell);
      total += runCost(readMeta(dir));
      for (let attempt = 1; attempt <= 2; attempt++) total += runCost(readMeta(`${dir}-infra-${attempt}`));
    }
    return total;
  };
  const admitted = new Set<number>(cells.filter(cell => done(cell)).map(cell => cell.block));
  const blockSize = (block: number) => cells.filter(cell => cell.block === block).length;
  let next = 0, stopped = false, inFlight = 0;
  await Promise.all(Array.from({ length: Math.max(1, plan.concurrency) }, async () => {
    while (next < pending.length) {
      const cell = pending[next]!;
      if (!admitted.has(cell.block)) {
        const reserve = plan.reservePerRunUsd ?? 0;
        const needed = spent() + (reserve ? inFlight * reserve + blockSize(cell.block) * reserve : 0);
        const over = reserve ? needed > plan.budgetUsd : spent() >= plan.budgetUsd;
        if (stopped || over) { if (!stopped) await log(`budget $${plan.budgetUsd} reached (spent $${spent().toFixed(2)}, ${inFlight} in flight): no new block`); stopped = true; return; }
        admitted.add(cell.block);
      }
      next++;
      inFlight++;
      try { await runCell(plan, root, cell, log); } finally { inFlight--; }
    }
  }));
  const frozenFiles = JSON.parse(readFileSync(join(root, "frozen.json"), "utf8")).files as Record<string, string>;
  const integrity = { checkedAt: new Date().toISOString(), frozenMismatches: verifyFrozen(root, frozenFiles), externals: externals() };
  await writeFile(join(plan.out, `integrity-${plan.phase}.json`), JSON.stringify(integrity, null, 2));
  await log(`done; estimated spend $${spent().toFixed(2)}; frozen copy ${integrity.frozenMismatches.length ? `CHANGED: ${integrity.frozenMismatches.join(", ")}` : "unchanged"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Plan;
  await drive({ ...plan, out: resolve(dirname(process.argv[2]!), plan.out) });
}
