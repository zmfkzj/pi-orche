/**
 * Driver of the stage evaluation (experiments/stage-eval, docs/stage-eval.md).
 *
 *   npx tsx experiments/stage-eval/driver.ts freeze <out> <label>     # freeze the working tree's orche as runtime <label>
 *   npx tsx experiments/stage-eval/driver.ts run <plan.json>          # run (or resume) a plan
 *
 * plan.json: { out, phase, tasks: [ids], arms: [{name, kind, runtime?}], repeats, firstRepeat?, seed, concurrency, scratch, sweCache,
 *              maxRuns, budgetUsd }
 * - Runtimes must be frozen before a plan uses them; the harness is frozen once per out directory (harness/), later launches with a
 *   changed harness are refused.
 * - Every planned unit is listed in manifest-<phase>.json before anything runs; a lock refuses a second driver of the same phase.
 * - Resume: a completed unit is reused; an unfinished unit directory is kept as `<dir>.interrupted-<n>` and runs again.
 * - Infra retry: a run whose terminal is `infra` runs again at most LIMITS.infraRetries times; failed attempts are kept as
 *   `<dir>.infra-<n>` and counted in the accounting. Timeouts, failures and failed grades are never retried.
 * - Budget stop: no new unit starts once the catalog-priced cost of the completed units of this phase (kept attempts included)
 *   reaches budgetUsd, or once maxRuns attempts were started.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, freezeRuntime, frozenRuntime } from "./env.js";
import { LIMITS, schedule, type Arm, type Unit } from "./protocol.js";

export interface Plan {
  out: string; phase: string; tasks: string[]; arms: Arm[]; repeats: number; firstRepeat?: number; seed: string; concurrency: number;
  scratch: string; sweCache: string; maxRuns: number; budgetUsd: number;
  /** Absolute path of the Pi CLI under test (the installed one). */
  piBin: string;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function freezeHarness(out: string): Promise<string> {
  const sources = [
    // The files a run executes (run-one.ts runs from this frozen copy). Analysis tools, the env builder and the driver itself are
    // not part of a run and may evolve (the driver records its plan, order and runtimes in plan-<phase>.json).
    { dir: HERE, name: "stage-eval", files: ["run-one.ts", "protocol.ts", "env.ts", "proxy.mjs", "image-task.ts"] },
    { dir: join(HERE, "../ultra-ab"), name: "ultra-ab", files: ["env.ts", "protocol.ts"] },
    { dir: join(HERE, "../advisor-reviewer"), name: "advisor-reviewer", files: ["tasks.ts", "protocol.ts"] },
  ];
  const root = join(out, "harness");
  const fresh = !existsSync(root);
  const changed: string[] = [];
  for (const source of sources) {
    await mkdir(join(root, source.name), { recursive: true });
    for (const name of source.files.sort()) {
      const target = join(root, source.name, name);
      if (!fresh) { if (!existsSync(target) || readFileSync(target, "utf8") !== readFileSync(join(source.dir, name), "utf8")) changed.push(`${source.name}/${name}`); continue; }
      await copyFile(join(source.dir, name), target);
    }
  }
  if (changed.length) throw new Error(`Harness changed since this study was launched (${changed.join(", ")}): use a fresh out directory`);
  return join(root, "stage-eval");
}

const children = new Set<import("node:child_process").ChildProcess>();
/** Set by a stop signal: no new attempt starts and a run cut by the stop is not retried (it resumes as interrupted). */
let stopping = false;
const stopChildren = () => { for (const child of children) child.kill("SIGTERM"); };
process.once("exit", stopChildren);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; stopChildren(); setTimeout(() => process.exit(143), 5000); });

const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };
let tempSeq = 0;
export async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${++tempSeq}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}
export async function lock(file: string): Promise<() => Promise<void>> {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; }
    if (alive) throw new Error(`Another driver (pid ${pid}) holds ${file}`);
  }
  await writeFile(file, `${process.pid}\n`);
  return async () => { await rm(file, { force: true }); };
}
const keepAs = (dir: string, label: string) => { let n = 1; while (existsSync(`${dir}.${label}-${n}`)) n++; return `${dir}.${label}-${n}`; };

export interface UnitState { id: string; task: string; arm: string; repeat: number; status: "pending" | "running" | "completed" | "skipped"; terminal?: string; primaryPass?: boolean; costUsd?: number; kept: string[] }

export async function drive(plan: Plan, options: { runner?: (unit: Unit, input: any, harness: string) => Promise<number | null> } = {}): Promise<UnitState[]> {
  plan.out = resolve(plan.out);
  await mkdir(plan.out, { recursive: true });
  const release = await lock(join(plan.out, `driver-${plan.phase}.lock`));
  try {
    const runtimes = new Map<string, { dir: string; digest: string }>();
    for (const arm of plan.arms) if (arm.runtime && !runtimes.has(arm.runtime)) runtimes.set(arm.runtime, frozenRuntime(plan.out, arm.runtime));
    const harness = await freezeHarness(plan.out);
    const units = schedule(plan.tasks, plan.arms, plan.repeats, plan.seed, plan.firstRepeat ?? 1);
    const planHash = createHash("sha256").update(JSON.stringify({ ...plan, out: undefined, concurrency: undefined, scratch: undefined, budgetUsd: undefined, maxRuns: undefined })).digest("hex");
    const planFile = join(plan.out, `plan-${plan.phase}.json`);
    if (existsSync(planFile)) {
      const existing = JSON.parse(readFileSync(planFile, "utf8"));
      if (existing.planHash !== planHash) throw new Error(`plan-${plan.phase}.json differs from this plan: use a fresh phase`);
    } else await writeAtomic(planFile, { ...plan, planHash, runtimes: Object.fromEntries([...runtimes].map(([label, rt]) => [label, rt.digest])), order: units.map(unit => unit.id), launchedAt: new Date().toISOString() });
    const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(join(plan.out, `driver-${plan.phase}.log`), `${text}\n`); };
    const states = new Map<string, UnitState>(units.map(unit => [unit.id, { id: unit.id, task: unit.task, arm: unit.arm.name, repeat: unit.repeat, status: "pending", kept: [] }]));
    const manifestFile = join(plan.out, `manifest-${plan.phase}.json`);
    let spent = 0, started = 0;
    let saving = Promise.resolve();
    const count = () => { const c: Record<string, number> = {}; for (const state of states.values()) c[state.status] = (c[state.status] ?? 0) + 1; return c; };
    const saveManifest = () => (saving = saving.then(() => writeAtomic(manifestFile, { planHash, updatedAt: new Date().toISOString(), counts: count(), spentUsd: spent, startedAttempts: started, units: [...states.values()] })));
    const unitDir = (unit: Unit) => join(plan.out, "runs", unit.id);
    const costOf = (dir: string) => Number(readMeta(dir)?.wire?.total?.costUsd ?? 0);
    for (const unit of units) {
      const dir = unitDir(unit), state = states.get(unit.id)!;
      const parent = join(dir, "..");
      for (const name of existsSync(parent) ? readdirSync(parent) : []) if (name.startsWith(`${dir.split("/").at(-1)}.`)) { state.kept.push(name); spent += costOf(join(parent, name)); started++; }
      const meta = readMeta(dir);
      if (meta?.status === "completed") { state.status = "completed"; state.terminal = meta.terminal; state.primaryPass = meta.primaryPass; state.costUsd = costOf(dir); spent += state.costUsd; started++; continue; }
      if (existsSync(dir)) { const kept = keepAs(dir, "interrupted"); await rename(dir, kept); state.kept.push(kept.split("/").at(-1)!); await log(`INTERRUPTED ${unit.id}: kept as ${kept.split("/").at(-1)}, will run again`); }
    }
    await saveManifest();
    await log(`${units.length} units, ${count().completed ?? 0} completed, spent $${spent.toFixed(2)}, concurrency ${plan.concurrency}, budget $${plan.budgetUsd}, maxRuns ${plan.maxRuns}`);
    const env = { ...process.env, STAGE_EVAL_REPO: REPO, ULTRA_AB_REPO: REPO, ADVISOR_BENCH_REPO: REPO, ADVISOR_BENCH_SWE_CACHE: plan.sweCache, TMPDIR: plan.scratch, STAGE_EVAL_PI: plan.piBin };

    const runUnit = async (unit: Unit): Promise<void> => {
      const dir = unitDir(unit), state = states.get(unit.id)!;
      for (let attempt = 1; attempt <= 1 + LIMITS.infraRetries; attempt++) {
        if (stopping) return;
        if (spent >= plan.budgetUsd || started >= plan.maxRuns) { state.status = "skipped"; await log(`SKIP ${unit.id}: budget/maxRuns reached ($${spent.toFixed(2)}, ${started} attempts)`); await saveManifest(); return; }
        started++;
        await mkdir(plan.scratch, { recursive: true });
        const temp = await mkdtemp(join(plan.scratch, "run-"));
        await mkdir(dir, { recursive: true });
        const runtime = unit.arm.runtime ? runtimes.get(unit.arm.runtime)!.dir : undefined;
        const input = { out: dir, ...(runtime ? { runtime, runtimeLabel: unit.arm.runtime } : {}), task: unit.task, arm: unit.arm, repeat: unit.repeat, temp, unit: unit.id };
        await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));
        state.status = "running"; await saveManifest();
        const t0 = Date.now();
        await log(`START ${unit.id} try ${attempt}`);
        const code = options.runner ? await options.runner(unit, input, harness) : await new Promise<number | null>(done => {
          const child = spawn(process.execPath, ["--import", "tsx", join(harness, "run-one.ts"), join(dir, "input.json")], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
          children.add(child); child.once("close", () => children.delete(child));
          child.stdout.on("data", chunk => { void appendFile(join(dir, "driver-stdout.txt"), chunk); });
          child.stderr.on("data", chunk => { void appendFile(join(dir, "driver-stderr.txt"), chunk); });
          child.once("close", done);
        });
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        // Cut by our own stop: leave the directory unfinished, so the next launch keeps it as interrupted and runs it again.
        if (stopping) return;
        let meta = readMeta(dir);
        if (meta?.status !== "completed") {
          meta = { ...(meta ?? input), status: "completed", terminal: "infra", infra: `run process exited ${code} before completing`, primaryPass: false };
          await writeAtomic(join(dir, "meta.json"), meta);
        }
        const cost = costOf(dir);
        spent += cost;
        await log(`END ${unit.id} try ${attempt}: exit ${code}, ${meta.terminal}, grade ${meta.grade?.passed}, primary ${meta.primaryPass}, ${Math.round((Date.now() - t0) / 1000)}s, $${cost.toFixed(3)} (phase $${spent.toFixed(2)})`);
        if (meta.terminal !== "infra" || attempt === 1 + LIMITS.infraRetries) {
          state.status = "completed"; state.terminal = meta.terminal; state.primaryPass = meta.primaryPass; state.costUsd = cost; await saveManifest(); return;
        }
        const kept = keepAs(dir, "infra"); await rename(dir, kept); state.kept.push(kept.split("/").at(-1)!);
      }
    };

    const pending = units.filter(unit => states.get(unit.id)!.status !== "completed");
    const running = new Set<string>();
    await new Promise<void>((resolveAll, rejectAll) => {
      const pump = () => {
        if (!pending.length && !running.size) { resolveAll(); return; }
        while (running.size < Math.max(1, plan.concurrency) && pending.length) {
          const unit = pending.shift()!;
          running.add(unit.id);
          runUnit(unit).then(() => { running.delete(unit.id); pump(); }, rejectAll);
        }
      };
      pump();
    });
    await log(`done: ${JSON.stringify(count())}, spent $${spent.toFixed(2)}`);
    return [...states.values()];
  } finally { await release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "freeze") {
    const result = await freezeRuntime(resolve(rest[0]!), rest[1]!);
    console.log(`frozen ${rest[1]}: ${result.dir} digest ${result.digest}`);
  } else if (command === "run") {
    const plan: Plan = JSON.parse(await readFile(rest[0]!, "utf8"));
    await drive(plan);
  } else {
    console.error("usage: driver.ts freeze <out> <label> | run <plan.json>");
    process.exit(2);
  }
}
