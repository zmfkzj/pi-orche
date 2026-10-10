/**
 * Driver of the ultra-vs-single study (experiments/ultra-ab, docs/ultra-ab-bench.md).
 *
 *   npx tsx experiments/ultra-ab/driver.ts <plan.json> [--reuse-frozen]
 *
 * plan.json: { out, phase, tasks: [{task, stratum, kind}], conditions?: ["A","B","C"], repeats, k, seed, concurrency, scratch }
 * - Freezes orche (the working tree at the first launch, rt/REVISION.json) and the harness (harness/) once per out directory;
 *   a later launch with a changed harness is refused, a changed product tree is refused unless --reuse-frozen (then the frozen copy runs).
 * - Every planned unit is listed in manifest-<phase>.json (atomic writes) before anything runs; a lock file refuses a second driver.
 * - Resume: a unit whose meta.json says completed is reused. A unit directory without a completed meta (the process or the machine
 *   died) is kept as `<dir>.interrupted-<n>` and the unit runs again (not an infra retry: the harness, not the run, failed).
 * - Infra retry (pre-registered): a run whose terminal is `infra` (no successful model request, the proxy or harness failed before
 *   the agent could work) runs again at most LIMITS.infraRetries times; every failed attempt is kept as `<dir>.infra-<n>`.
 *   Timeouts, blocked, failed, provider errors during a run and failed grades are never retried.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, freezeRuntime, frozenRuntime } from "./env.js";
import { LIMITS, schedule, type Condition, type Unit } from "./protocol.js";

export interface Plan { out: string; phase: string; prereg?: string; sweCache?: string; tasks: { task: string; stratum: string; kind: string }[]; conditions?: Condition[]; repeats: number; k: number; seed: string; concurrency: number; scratch: string }

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADVISOR = join(HERE, "../advisor-reviewer");

/** Copy the harness into <out>/harness once; refuse a changed harness later. */
export async function freezeHarness(out: string, sources: { dir: string; name: string; files: string[] }[] = [
  { dir: HERE, name: "ultra-ab", files: readdirSync(HERE).filter(name => /\.(ts|mjs)$/.test(name)) },
  { dir: ADVISOR, name: "advisor-reviewer", files: ["tasks.ts", "protocol.ts"] },
]): Promise<string> {
  const root = join(out, "harness");
  const changed: string[] = [];
  const fresh = !existsSync(root);
  for (const source of sources) {
    await mkdir(join(root, source.name), { recursive: true });
    for (const name of source.files.sort()) {
      const target = join(root, source.name, name);
      if (!fresh) { if (!existsSync(target) || readFileSync(target, "utf8") !== readFileSync(join(source.dir, name), "utf8")) changed.push(`${source.name}/${name}`); continue; }
      await copyFile(join(source.dir, name), target);
    }
  }
  if (changed.length) throw new Error(`Harness changed since this study was launched (${changed.join(", ")}): use a fresh out directory`);
  return join(root, "ultra-ab");
}

/** Running unit processes: stopped with the driver (a crash or a signal), so no orphan run continues unrecorded. */
const children = new Set<import("node:child_process").ChildProcess>();
const stopChildren = () => { for (const child of children) child.kill("SIGTERM"); };
process.once("exit", stopChildren);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopChildren(); setTimeout(() => process.exit(143), 3000); });

const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };
export const unitDir = (out: string, unit: Unit) => join(out, "runs", unit.id);

/** Atomic JSON write (temp file + rename). */
let tempSeq = 0;
export async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${++tempSeq}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

/** Exclusive lock (pid file); a stale lock of a dead process is taken over. */
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

/**
 * SWE environments (source snapshot + read-only virtualenv) are copied out of the repository into `plan.sweCache` (scratch), so the
 * paths the agents see (wrappers, venv) do not lead into the repository with its fixtures and earlier results. Re-staged after a
 * reboot cleared the scratch.
 */
export async function stageSweCache(plan: Plan): Promise<void> {
  const from = join(REPO, "results/advisor-reviewer/cache/swe");
  for (const item of plan.tasks) {
    if (item.kind !== "swe" || existsSync(join(plan.sweCache!, item.task, "venv/.ready"))) continue;
    await mkdir(plan.sweCache!, { recursive: true });
    execFileSync("cp", ["-a", join(from, item.task), plan.sweCache!]);
  }
}

/** Next free suffix for a kept attempt directory. */
const keepAs = (dir: string, label: string) => { let n = 1; while (existsSync(`${dir}.${label}-${n}`)) n++; return `${dir}.${label}-${n}`; };

export interface UnitState { id: string; kind: string; condition: Condition; task: string; repeat: number; attempt?: number; status: "pending" | "running" | "completed"; terminal?: string; primaryPass?: boolean; kept: string[] }

export async function drive(plan: Plan, options: { reuseFrozen?: boolean; runner?: (unit: Unit, input: any, harness: string) => Promise<number | null> } = {}): Promise<UnitState[]> {
  plan.out = resolve(plan.out);
  await mkdir(plan.out, { recursive: true });
  const release = await lock(join(plan.out, `driver-${plan.phase}.lock`));
  try {
    const rt = options.reuseFrozen && existsSync(join(plan.out, "rt/REVISION.json")) ? frozenRuntime(plan.out) : await freezeRuntime(plan.out);
    const harness = await freezeHarness(plan.out);
    if (plan.sweCache) await stageSweCache(plan);
    const items = schedule(plan.tasks.map(item => item.task), plan.repeats, plan.k, plan.seed).filter(item => !plan.conditions || plan.conditions.includes(item.unit.condition));
    const units = items.map(item => item.unit);
    const planHash = createHash("sha256").update(JSON.stringify({ ...plan, out: undefined, concurrency: undefined, scratch: undefined })).digest("hex");
    const planFile = join(plan.out, `plan-${plan.phase}.json`);
    if (existsSync(planFile)) {
      const existing = JSON.parse(readFileSync(planFile, "utf8"));
      if (existing.planHash !== planHash) throw new Error(`plan-${plan.phase}.json differs from this plan (hash ${existing.planHash.slice(0, 12)} vs ${planHash.slice(0, 12)}): use a fresh out directory or phase`);
    } else await writeAtomic(planFile, { ...plan, planHash, runtimeDigest: rt.digest, ...(plan.prereg ? { preregSha256: createHash("sha256").update(readFileSync(resolve(REPO, plan.prereg))).digest("hex") } : {}), order: items.map(item => ({ id: item.unit.id, blockOrder: item.order.join("") })), launchedAt: new Date().toISOString() });
    const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; console.log(text); await appendFile(join(plan.out, `driver-${plan.phase}.log`), `${text}\n`); };

    const states = new Map<string, UnitState>(units.map(unit => [unit.id, { id: unit.id, kind: unit.kind, condition: unit.condition, task: unit.task, repeat: unit.repeat, ...(unit.attempt ? { attempt: unit.attempt } : {}), status: "pending", kept: [] }]));
    const manifestFile = join(plan.out, `manifest-${plan.phase}.json`);
    // Saves are serialized: concurrent units finish at any time, the manifest file always holds one complete snapshot.
    let saving = Promise.resolve();
    const saveManifest = () => (saving = saving.then(() => writeAtomic(manifestFile, { planHash, updatedAt: new Date().toISOString(), counts: count(), units: [...states.values()] })));
    const count = () => { const c: Record<string, number> = {}; for (const state of states.values()) c[state.status] = (c[state.status] ?? 0) + 1; return c; };
    for (const unit of units) {
      const dir = unitDir(plan.out, unit), state = states.get(unit.id)!;
      for (const parent of [dir]) for (const name of existsSync(join(parent, "..")) ? readdirSync(join(parent, "..")) : []) if (name.startsWith(`${dir.split("/").at(-1)}.`)) state.kept.push(name);
      const meta = readMeta(dir);
      if (meta?.status === "completed") { state.status = "completed"; state.terminal = meta.terminal; state.primaryPass = meta.primaryPass; continue; }
      if (existsSync(dir)) { const kept = keepAs(dir, "interrupted"); await rename(dir, kept); state.kept.push(kept.split("/").at(-1)!); await log(`INTERRUPTED ${unit.id}: kept as ${kept.split("/").at(-1)}, will run again`); }
    }
    await saveManifest();
    await log(`${units.length} units, ${count().completed ?? 0} completed, concurrency ${plan.concurrency}, k ${plan.k}, runtime ${rt.digest.slice(0, 12)}`);

    const runUnit = async (unit: Unit): Promise<void> => {
      const dir = unitDir(plan.out, unit), state = states.get(unit.id)!;
      for (let attempt = 1; attempt <= 1 + LIMITS.infraRetries; attempt++) {
        await mkdir(plan.scratch, { recursive: true });
        const temp = await mkdtemp(join(plan.scratch, "run-"));
        await mkdir(dir, { recursive: true });
        const input = unit.kind === "select"
          ? { out: dir, task: unit.task, repeat: unit.repeat, attempts: unit.needs!.map(id => join(plan.out, "runs", id)), temp, unit: unit.id }
          : { out: dir, runtime: rt.dir, task: unit.task, condition: unit.condition, repeat: unit.repeat, ...(unit.attempt ? { attempt: unit.attempt, deferGrade: true } : {}), temp, unit: unit.id };
        await writeFile(join(dir, "input.json"), JSON.stringify(input, null, 2));
        state.status = "running"; await saveManifest();
        const started = Date.now();
        await log(`START ${unit.id} try ${attempt}`);
        const code = options.runner ? await options.runner(unit, input, harness) : await new Promise<number | null>(done => {
          const child = spawn(process.execPath, ["--import", "tsx", join(harness, unit.kind === "select" ? "select.ts" : "run-one.ts"), join(dir, "input.json")], { cwd: REPO, env: { ...process.env, ULTRA_AB_REPO: REPO, ADVISOR_BENCH_REPO: REPO, ...(plan.sweCache ? { ADVISOR_BENCH_SWE_CACHE: plan.sweCache } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
          children.add(child); child.once("close", () => children.delete(child));
          child.stdout.on("data", chunk => { void appendFile(join(dir, "driver-stdout.txt"), chunk); });
          child.stderr.on("data", chunk => { void appendFile(join(dir, "driver-stderr.txt"), chunk); });
          child.once("close", done);
        });
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        let meta = readMeta(dir);
        if (meta?.status !== "completed") {
          meta = { ...(meta ?? input), status: "completed", terminal: "infra", infra: `${unit.kind} process exited ${code} before completing`, primaryPass: false };
          await writeAtomic(join(dir, "meta.json"), meta);
        }
        await log(`END ${unit.id} try ${attempt}: exit ${code}, ${meta.terminal}, primary ${meta.primaryPass ?? "-"}, ${Math.round((Date.now() - started) / 1000)}s`);
        if (meta.terminal !== "infra" || attempt === 1 + LIMITS.infraRetries || unit.kind === "select") {
          state.status = "completed"; state.terminal = meta.terminal; state.primaryPass = meta.primaryPass; await saveManifest(); return;
        }
        const kept = keepAs(dir, "infra"); await rename(dir, kept); state.kept.push(kept.split("/").at(-1)!);
      }
    };

    const pending = units.filter(unit => states.get(unit.id)!.status !== "completed");
    const running = new Set<string>();
    await new Promise<void>((resolveAll, rejectAll) => {
      const pump = () => {
        if (!pending.length && !running.size) { resolveAll(); return; }
        while (running.size < Math.max(1, plan.concurrency)) {
          const index = pending.findIndex(unit => (unit.needs ?? []).every(id => states.get(id)!.status === "completed"));
          if (index < 0) break;
          const [unit] = pending.splice(index, 1);
          running.add(unit!.id);
          runUnit(unit!).then(() => { running.delete(unit!.id); pump(); }, rejectAll);
        }
      };
      pump();
    });
    await log(`done: ${JSON.stringify(count())}`);
    return [...states.values()];
  } finally { await release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const plan: Plan = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  await drive(plan, { reuseFrozen: process.argv.includes("--reuse-frozen") });
}
