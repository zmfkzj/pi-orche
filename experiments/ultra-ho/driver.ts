/**
 * Driver of an ultra-ho plan (experiments/ultra-ho/README.md). Commands: experiments/ultra-ho/cli.ts.
 *
 * - Runtimes are frozen beforehand (`cli.ts freeze <out> <name>`); each arm names one, and every unit runs that frozen copy
 *   (a missing runtime refuses the launch; a modified one fails the unit). The provider package is frozen into `<out>/provider`.
 * - Every planned unit is listed in manifest-<phase>.json (atomic writes, serialized) before anything runs; a lock file refuses a
 *   second driver of the same phase (a stale lock of a dead process is taken over).
 * - Resume: a unit whose meta.json says completed is reused. A unit directory without a completed meta (the driver, the unit or the
 *   machine died) is kept as `<dir>.interrupted-<n>` and the unit runs again; a Pi process group it left alive is killed first.
 * - Infra retry: a run without any successful model request runs again once; the failed attempt is kept as `<dir>.infra-<n>`. A unit
 *   process that died after successful model requests is `harness-error` (never retried; fix the harness, then `--rerun` it).
 * - Unit order: plan.seed (protocol.ts schedule); concurrency: plan.concurrency.
 * - SWE tasks come from the plan's `sweFixtures` and their environments from its `sweCacheSource` (default: the canonical
 *   fixtures/advisor-bench/swe and results/advisor-reviewer/cache/swe); both roots are recorded in plan-<phase>.json and every unit.
 * - Children stop with the driver: SIGTERM/SIGINT stop every unit (each kills its Pi process group); a unit whose driver is gone
 *   (even killed outright) stops by itself. SIGHUP is ignored, so a detached driver (`--detach`) survives its terminal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { HERE, REPO, freezeProvider, isInside, piVersion, readRevision, runtimeDir, sha256, stageSweCache, sweRoots, upstream, type ProviderFreeze } from "./env.js";
import { INFRA_RETRIES, armSettings, parsePlan, planHash, schedule, type Plan, type Unit } from "./protocol.js";
import type { RunInput } from "./run-one.js";

/** Atomic JSON write (temp file + rename). */
let tempSeq = 0;
export async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${++tempSeq}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Exclusive lock (pid file); a stale lock of a dead process is taken over (ultra-ab driver.ts lock). */
export async function lock(file: string): Promise<() => Promise<void>> {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw new Error(`Another driver (pid ${pid}) holds ${file}`);
  }
  await writeFile(file, `${process.pid}\n`);
  return async () => { await rm(file, { force: true }); };
}

/** Next free suffix for a kept attempt directory. */
export const keepAs = (dir: string, label: string): string => { let n = 1; while (existsSync(`${dir}.${label}-${n}`)) n++; return `${dir}.${label}-${n}`; };
const readMeta = (dir: string): any => { try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; } };
export const unitDir = (out: string, unit: Unit): string => join(out, "runs", unit.id);
export const resolveOut = (out: string, repo = REPO): string => isAbsolute(out) ? out : resolve(repo, out);

/** The harness files (this directory and what it reuses from ultra-ab and advisor-reviewer) and their digest. */
export function harnessDigest(): { digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const add = (dir: string, names: string[]) => { for (const name of names) { const path = join(dir, name); if (existsSync(path)) files[`${basename(dir)}/${name}`] = sha256(readFileSync(path)); } };
  add(HERE, readdirSync(HERE).filter(name => /\.(ts|mts|mjs)$/.test(name)).sort());
  add(join(HERE, "../ultra-ab"), ["protocol.ts", "env.ts", "run-one.ts"]);
  add(join(HERE, "../advisor-reviewer"), ["tasks.ts", "protocol.ts"]);
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\n`);
  return { digest: hash.digest("hex"), files };
}

/**
 * The environment of a unit process: the repository for every harness module, the staged SWE cache, and the plan's SWE fixture root
 * (ADVISOR_BENCH_SWE_DIR, only when the plan names one; otherwise the canonical root, whatever `base` says).
 */
export function unitEnv(plan: Pick<Plan, "sweCache" | "sweFixtures" | "sweCacheSource">, repo: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ADVISOR_BENCH_SWE_DIR: _inherited, ...inherited } = base;
  return { ...inherited, ULTRA_HO_REPO: repo, ULTRA_AB_REPO: repo, ADVISOR_BENCH_REPO: repo, ...(plan.sweCache ? { ADVISOR_BENCH_SWE_CACHE: plan.sweCache } : {}), ...(plan.sweFixtures ? { ADVISOR_BENCH_SWE_DIR: sweRoots(plan, repo).fixtures } : {}) };
}

/** The Pi process group a dead unit left behind (meta.piPid, its command line naming the unit's session): killed before a rerun. */
function killLeftover(meta: any): string | undefined {
  const pid = Number(meta?.piPid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid) || !meta?.sessionId) return undefined;
  let cmdline = "";
  try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return undefined; }
  if (!cmdline.includes(String(meta.sessionId))) return undefined;
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  return `killed the Pi process group ${pid} it left running`;
}

export interface UnitState { id: string; task: string; arm: string; repeat: number; status: "pending" | "running" | "completed"; attempt?: number; terminal?: string; primaryPass?: boolean; kept: string[] }
export interface DriveOptions {
  /** Test seam: run a unit without a process (returns its exit code). */
  runner?: (unit: Unit, input: RunInput) => Promise<number | null>;
  /** Test seam: the provider freeze (default: copy the provider package into `<out>/provider`). */
  provider?: ProviderFreeze;
  /** Completed units to run again (their directories are kept as `<dir>.rerun-<n>`). */
  rerun?: string[];
  repo?: string;
  /** Log to the driver log file only (not to stdout). */
  quiet?: boolean;
}

/** Run a plan (a plan.json path, or the plan itself: validated by parsePlan) to completion (resumable). Returns the final unit states. */
export async function drive(planInput: string | Plan | Record<string, unknown>, options: DriveOptions = {}): Promise<UnitState[]> {
  const plan = parsePlan(typeof planInput === "string" ? JSON.parse(readFileSync(planInput, "utf8")) : planInput);
  const repo = resolve(options.repo ?? REPO);
  const out = resolveOut(plan.out, repo);
  for (const [key, path] of [["scratch", plan.scratch], ["sweCache", plan.sweCache]] as const) if (path && isInside(repo, path)) throw new Error(`plan.${key} ${path} is inside the repository: agents would see its fixtures and results; use a directory outside it`);
  await mkdir(out, { recursive: true });
  const release = await lock(join(out, `driver-${plan.phase}.lock`));
  const logFile = join(out, `driver-${plan.phase}.log`);
  const log = async (line: string) => { const text = `${new Date().toISOString()} ${line}`; if (!options.quiet) console.log(text); await appendFile(logFile, `${text}\n`); };

  // Children stop with the driver.
  const children = new Set<ChildProcess>();
  let stopping = false;
  const stopChildren = () => { for (const child of children) { try { child.kill("SIGTERM"); } catch { /* gone */ } } };
  const onSignal = (signal: NodeJS.Signals) => { stopping = true; void log(`${signal}: stopping ${children.size} unit(s)`).catch(() => undefined); stopChildren(); setTimeout(() => process.exit(143), 5_000).unref(); };
  const onHup = () => { void log("SIGHUP ignored (detached-safe)").catch(() => undefined); };
  const onTerm = () => onSignal("SIGTERM"), onInt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt); process.on("SIGHUP", onHup); process.on("exit", stopChildren);

  try {
    const runtimes: Record<string, { name: string; dir: string; digest: string }> = {};
    for (const arm of plan.arms) {
      const dir = runtimeDir(out, arm.runtime);
      if (!existsSync(join(dir, "REVISION.json"))) throw new Error(`arm ${arm.name}: runtime ${arm.runtime} is not frozen (${dir}); run: npx tsx experiments/ultra-ho/cli.ts freeze ${plan.out} ${arm.runtime}`);
      runtimes[arm.runtime] = { name: arm.runtime, dir, digest: readRevision(dir).digest };
    }
    const provider = options.provider ?? await freezeProvider(out);
    const swe = await stageSweCache(plan, repo);
    // Where the SWE tasks and their environments come from (the plan's roots, else the canonical ones): recorded with the plan and every unit.
    const roots = sweRoots(plan, repo);
    const items = schedule(plan);
    const units = items.map(item => item.unit);
    const hash = planHash(plan);
    const harness = harnessDigest();
    const planFile = join(out, `plan-${plan.phase}.json`);
    if (existsSync(planFile)) {
      const existing = JSON.parse(readFileSync(planFile, "utf8"));
      if (existing.planHash !== hash) throw new Error(`plan-${plan.phase}.json differs from this plan (hash ${String(existing.planHash).slice(0, 12)} vs ${hash.slice(0, 12)}): use a fresh out directory or phase`);
      if (existing.harness?.digest !== harness.digest) await log(`NOTE harness changed since launch (${String(existing.harness?.digest).slice(0, 12)} → ${harness.digest.slice(0, 12)}): each unit's meta.json records the harness it ran with`);
      if (existing.upstream !== undefined && existing.upstream !== upstream()) throw new Error(`plan-${plan.phase}.json was launched against upstream ${existing.upstream}, this launch would use ${upstream()} (ULTRA_HO_UPSTREAM): one phase never mixes them`);
    } else {
      await writeAtomic(planFile, { plan, planHash: hash, runtimes, provider, harness, upstream: upstream(), pi: piVersion(), node: process.version, swe, sweRoots: roots, launchedAt: new Date().toISOString(), order: items.map(item => ({ id: item.unit.id, armOrder: item.order })) });
    }

    const states = new Map<string, UnitState>(units.map(unit => [unit.id, { id: unit.id, task: unit.task, arm: unit.arm, repeat: unit.repeat, status: "pending", kept: [] }]));
    const manifestFile = join(out, `manifest-${plan.phase}.json`);
    const count = () => { const counts: Record<string, number> = {}; for (const state of states.values()) counts[state.status] = (counts[state.status] ?? 0) + 1; return counts; };
    let saving = Promise.resolve();
    const saveManifest = () => (saving = saving.then(() => writeAtomic(manifestFile, { planHash: hash, phase: plan.phase, driverPid: process.pid, updatedAt: new Date().toISOString(), counts: count(), units: [...states.values()] })));
    const rerun = new Set(options.rerun ?? []);
    for (const id of rerun) if (!states.has(id)) throw new Error(`--rerun ${id}: not a unit of this plan (${units.map(unit => unit.id).join(", ")})`);
    for (const unit of units) {
      const dir = unitDir(out, unit), state = states.get(unit.id)!;
      if (rerun.has(unit.id) && existsSync(dir)) { const kept = keepAs(dir, "rerun"); await rename(dir, kept); await log(`RERUN ${unit.id}: kept as ${basename(kept)}`); }
      const parent = join(dir, "..");
      for (const name of existsSync(parent) ? readdirSync(parent).sort() : []) if (name.startsWith(`${basename(dir)}.`)) state.kept.push(name);
      const meta = readMeta(dir);
      if (meta?.status === "completed") { Object.assign(state, { status: "completed", terminal: meta.terminal, primaryPass: meta.primaryPass, attempt: meta.attempt }); continue; }
      if (existsSync(dir)) {
        const killed = killLeftover(meta);
        const kept = keepAs(dir, "interrupted"); await rename(dir, kept); state.kept.push(basename(kept));
        await log(`INTERRUPTED ${unit.id}: kept as ${basename(kept)}${killed ? `; ${killed}` : ""}; will run again`);
      }
    }
    await saveManifest();
    await log(`${units.length} unit(s), ${count().completed ?? 0} completed, concurrency ${plan.concurrency}, runtimes ${Object.values(runtimes).map(item => `${item.name} ${item.digest.slice(0, 12)}`).join(", ")}, provider ${provider.version ?? "?"} ${provider.digest.slice(0, 12)}, harness ${harness.digest.slice(0, 12)}`);

    const env = unitEnv(plan, repo);
    const spawnUnit = (dir: string, input: RunInput) => new Promise<number | null>(done => {
      const stdout = openSync(join(dir, "driver-stdout.txt"), "a"), stderr = openSync(join(dir, "driver-stderr.txt"), "a");
      const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "run-one.ts"), join(dir, "input.json")], {
        cwd: repo, stdio: ["ignore", stdout, stderr], env,
      });
      closeSync(stdout); closeSync(stderr);
      children.add(child);
      child.once("error", () => { children.delete(child); done(-1); });
      child.once("close", code => { children.delete(child); done(code); });
    });

    const runUnit = async (unit: Unit): Promise<void> => {
      const dir = unitDir(out, unit), state = states.get(unit.id)!;
      const arm = plan.arms.find(item => item.name === unit.arm)!;
      const { limits, piGuardMs } = armSettings(arm);
      for (let attempt = 1; attempt <= 1 + INFRA_RETRIES; attempt++) {
        if (stopping) return;
        await mkdir(plan.scratch, { recursive: true });
        const temp = await mkdtemp(join(plan.scratch, "run-"));
        await mkdir(dir, { recursive: true });
        const input: RunInput = { out: dir, unit: unit.id, task: unit.task, arm, runtime: runtimes[arm.runtime]!, provider: { dir: provider.dir, digest: provider.digest, ...(provider.version ? { version: provider.version } : {}) }, limits, piGuardMs, temp, attempt, driverPid: process.pid, harness: harness.digest, sweFixtures: roots.fixtures, sweCacheSource: roots.cacheSource };
        await writeFile(join(dir, "input.json"), `${JSON.stringify(input, null, 2)}\n`);
        Object.assign(state, { status: "running", attempt }); await saveManifest();
        const started = Date.now();
        await log(`START ${unit.id} attempt ${attempt}`);
        const code = options.runner ? await options.runner(unit, input) : await spawnUnit(dir, input);
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        // A unit stopped because the driver is stopping stays incomplete: the next launch keeps it as interrupted and runs it again.
        if (stopping) return;
        let meta = readMeta(dir);
        if (meta?.status !== "completed") {
          const wire = existsSync(join(dir, "wire.jsonl")) ? readFileSync(join(dir, "wire.jsonl"), "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
          const ok = wire.filter(entry => entry.method === "POST" && entry.model && entry.status === 200).length;
          meta = { ...(meta ?? { unit: unit.id, task: unit.task, arm: unit.arm, attempt }), status: "completed", terminal: ok ? "harness-error" : "infra", ...(ok ? { harnessError: `unit process exited ${code} before completing, after ${ok} successful model request(s)` } : { infra: `unit process exited ${code} before completing` }), primaryPass: false };
          await writeAtomic(join(dir, "meta.json"), meta);
        }
        await log(`END ${unit.id} attempt ${attempt}: exit ${code}, ${meta.terminal}, grade ${meta.grade?.passed ?? "-"}, primary ${meta.primaryPass ?? "-"}, ${meta.wire?.requests ?? "?"} requests, $${meta.wire?.costUSD ?? "?"}, route violations ${meta.wire?.routeViolations ?? "?"}, ${Math.round((Date.now() - started) / 1000)}s`);
        if (meta.terminal !== "infra" || attempt === 1 + INFRA_RETRIES) {
          Object.assign(state, { status: "completed", terminal: meta.terminal, primaryPass: meta.primaryPass }); await saveManifest(); return;
        }
        const kept = keepAs(dir, "infra"); await rename(dir, kept); state.kept.push(basename(kept));
        await log(`INFRA ${unit.id}: kept as ${basename(kept)}; one retry`);
      }
    };

    const pending = units.filter(unit => states.get(unit.id)!.status !== "completed");
    const running = new Set<string>();
    await new Promise<void>((resolveAll, rejectAll) => {
      const pump = () => {
        if (stopping && !running.size) { resolveAll(); return; }
        if (!pending.length && !running.size) { resolveAll(); return; }
        while (!stopping && pending.length && running.size < plan.concurrency) {
          const unit = pending.shift()!;
          running.add(unit.id);
          runUnit(unit).then(() => { running.delete(unit.id); pump(); }, rejectAll);
        }
      };
      pump();
    });
    await saveManifest();
    await log(stopping ? `stopped: ${JSON.stringify(count())}` : `done: ${JSON.stringify(count())}`);
    return [...states.values()];
  } finally {
    process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); process.off("SIGHUP", onHup); process.off("exit", stopChildren);
    await release();
  }
}

/** Start the driver detached (own session, no terminal; output to `<out>/driver-<phase>.out`); returns its pid. */
export async function detach(planPath: string, extra: string[] = []): Promise<{ pid: number; output: string }> {
  const plan = parsePlan(JSON.parse(readFileSync(planPath, "utf8")));
  const out = resolveOut(plan.out);
  await mkdir(out, { recursive: true });
  const output = join(out, `driver-${plan.phase}.out`);
  const fd = openSync(output, "a");
  const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "cli.ts"), "driver", resolve(planPath), ...extra], { cwd: REPO, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  closeSync(fd);
  child.unref();
  return { pid: child.pid!, output };
}

/** A readable status of every phase in `out`: counts, the driver, and per unit its state (running units: elapsed, requests, cost so far). */
export function status(outInput: string): string {
  const out = resolveOut(outInput);
  const lines: string[] = [];
  const manifests = existsSync(out) ? readdirSync(out).filter(name => /^manifest-.+\.json$/.test(name)).sort() : [];
  if (!manifests.length) return `${out}: no manifest (nothing launched)`;
  for (const name of manifests) {
    const manifest = JSON.parse(readFileSync(join(out, name), "utf8"));
    const phase = manifest.phase ?? name.slice("manifest-".length, -".json".length);
    const lockFile = join(out, `driver-${phase}.lock`);
    const pid = existsSync(lockFile) ? Number(readFileSync(lockFile, "utf8").trim()) : undefined;
    lines.push(`phase ${phase}: ${JSON.stringify(manifest.counts)} (updated ${manifest.updatedAt}); driver ${pid ? `pid ${pid} ${alive(pid) ? "running" : "DEAD (stale lock: relaunch to resume)"}` : "not running"}`);
    for (const unit of manifest.units ?? []) {
      const meta = readMeta(join(out, "runs", unit.id));
      let extra = "";
      if (unit.status === "running" && meta) {
        let requests = 0, cost: number | undefined;
        try { requests = readFileSync(join(out, "runs", unit.id, "wire.jsonl"), "utf8").split("\n").filter(line => line.includes('"method":"POST"') && line.includes('"model"')).length; } catch { /* none yet */ }
        try { cost = JSON.parse(readFileSync(join(out, "runs", unit.id, "wire.jsonl.totals.json"), "utf8")).costUSD; } catch { /* none yet */ }
        extra = ` · attempt ${meta.attempt ?? unit.attempt ?? "?"}, ${Math.round((Date.now() - meta.startedAt) / 60_000)} min, ${requests} requests, $${cost ?? 0}${meta.piPid ? `, pi ${meta.piPid} ${alive(meta.piPid) ? "alive" : "gone"}` : ""}`;
      } else if (unit.status === "completed" && meta) {
        extra = ` · ${meta.terminal}, grade ${meta.grade?.passed ?? "-"}, primary ${meta.primaryPass ?? "-"}, ${meta.wire?.requests ?? "?"} requests, $${meta.wire?.costUSD ?? "?"}, route violations ${meta.wire?.routeViolations ?? "?"}`;
      }
      lines.push(`  ${unit.id}: ${unit.status}${extra}${unit.kept?.length ? ` (kept: ${unit.kept.join(", ")})` : ""}`);
    }
  }
  return lines.join("\n");
}
