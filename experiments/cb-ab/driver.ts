/**
 * The cb-ab driver (results/cb-ab/PROTOCOL.md "Units and schedule", "Retries"): runs protocol.ts units(cases) N at a time, every unit
 * as its own process of the study's FROZEN harness (`<study>/harness/experiments/cb-ab/run.ts unit …`, cwd = the repository).
 *
 *  - One driver per study: <study>/driver/lock.json (a lock whose process is gone is stale and replaced).
 *  - Unit states in <study>/driver/state.json, replaced atomically (write + rename) on every change; START/END lines (and RESUME,
 *    INFRA, STOP) in <study>/driver/driver.log; each unit's own output in <study>/driver/logs/.
 *  - Resume: a completed unit (meta.json status "completed") is reused; an unfinished unit directory (interrupted, failed) is renamed
 *    `<unit>.interrupted-<n>` and the unit rerun; a directory whose unit process still runs refuses the start.
 *  - Infrastructure retry: a completed unit without one successful model request is kept as `<unit>.infra-<n>` and rerun, at most
 *    LIMITS.infraRetries times. Nothing else is retried (timeouts, failed tasks, provider errors during a run, non-compliance).
 *  - Stopping the driver (SIGTERM, SIGINT) stops every running unit: SIGTERM to its process group (the unit marks itself interrupted,
 *    stops its proxy and its Pi process group), SIGKILL after a grace period; a unit whose driver disappears stops itself.
 *  - Safe to launch detached (`nohup … &`): units write to files, not to the driver's pipes; poll with `run.ts status <study>`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readJsonl } from "../mdsd-ab/run.js";
import { HARNESS_ENTRY, NODE, REPO, liveSecrets, loadCase, readJson, unitDir } from "./env.js";
import { redactTree } from "./evidence.js";
import { LIMITS, units as schedule, type Arm, type UnitSpec } from "./protocol.js";

export type UnitStatus = "pending" | "running" | "completed" | "interrupted" | "failed";
export interface Attempt { n: number; startedAt: string; endedAt?: string; pid?: number; exit?: number | null; signal?: string | null; outcome?: "completed" | "infra" | "interrupted" | "failed"; keptAs?: string; note?: string }
export interface UnitState extends UnitSpec { caseDir: string; dir: string; status: UnitStatus; attempts: Attempt[]; result?: Record<string, unknown> }
export interface DriverState {
  version: 1; study: string; pid: number; startedAt: string; updatedAt: string; endedAt?: string; stopped?: string; preflight: boolean; concurrency: number;
  cases: { id: string; order: number; dir: string; sha256: string; promptSha256: string }[]; units: UnitState[];
}

const now = () => new Date().toISOString();
const safeJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const cmdline = (pid: number): string => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); } catch { return ""; } };

/** Take the study's driver lock (exclusive create); a lock whose process is gone (or is no driver) is stale and replaced. */
export function acquireLock(file: string, log: (line: string) => void): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: now(), argv: process.argv.slice(1) })}\n`);
      closeSync(fd);
      return () => { try { if (safeJson(file)?.pid === process.pid) unlinkSync(file); } catch { /* gone */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = safeJson(file);
      if (holder?.pid && holder.pid !== process.pid && alive(holder.pid) && /\bdriver\b/.test(cmdline(holder.pid))) throw new Error(`another driver runs this study (pid ${holder.pid}, since ${holder.startedAt}; lock ${file})`);
      log(`stale lock of pid ${holder?.pid ?? "?"} replaced`);
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  throw new Error(`could not take ${file}`);
}

/** Atomically replace a JSON file (write a temporary file, then rename). */
export function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

/** What a unit directory holds: nothing, a completed unit, a unit whose process still runs, or an unfinished attempt. */
export function inspectUnit(dir: string): { kind: "absent" | "completed" | "active" | "incomplete"; meta?: any } {
  if (!existsSync(dir)) return { kind: "absent" };
  const meta = safeJson(join(dir, "meta.json"));
  if (meta?.status === "completed") return { kind: "completed", meta };
  if (typeof meta?.pid === "number" && meta.pid !== process.pid && alive(meta.pid) && / unit /.test(cmdline(meta.pid))) return { kind: "active", meta };
  return { kind: "incomplete", meta };
}
/** Next free n of `<dir>.<kind>-<n>`, and how many such attempts exist. */
export const nextSuffix = (dir: string, kind: "interrupted" | "infra"): number => { let n = 1; while (existsSync(`${dir}.${kind}-${n}`)) n++; return n; };
export const countSuffix = (dir: string, kind: "interrupted" | "infra"): number => existsSync(dirname(dir)) ? readdirSync(dirname(dir)).filter(name => name.startsWith(`${basename(dir)}.${kind}-`)).length : 0;
/** Infrastructure failure: the run has no successful model request (HTTP 200 with usage) on its wire. */
export const infraFailure = (dir: string, meta: any): boolean => typeof meta?.successfulRequests === "number" ? meta.successfulRequests === 0
  : !readJsonl(join(dir, "wire.jsonl")).some(entry => entry?.method === "POST" && entry.model && entry.status === 200 && entry.usage);

const resultOf = (meta: any): Record<string, unknown> => ({
  exit: meta?.pi?.code, signal: meta?.pi?.signal ?? undefined, guardFired: meta?.pi?.guardFired, wallMs: meta?.wallMs, requests: meta?.usage?.total?.requests, costUSD: meta?.usage?.total?.costUSD,
  routeViolations: meta?.route?.violations, auditHits: meta?.audit?.hits, report: meta?.final?.report, compliant: meta?.compliance?.explorer?.compliant, infra: meta?.infra,
});
const brief = (result: Record<string, unknown> | undefined) => result ? `exit ${result.exit}${result.guardFired ? " (guard)" : ""}, ${Math.round(Number(result.wallMs ?? 0) / 1000)} s, ${result.requests ?? "?"} requests, $${result.costUSD ?? "?"}, route violations ${result.routeViolations ?? "?"}, audit hits ${result.auditHits ?? "?"}, report ${result.report ? "yes" : "no"}${result.compliant === undefined ? "" : `, compliant ${result.compliant}`}` : "";

export interface DriverOptions {
  study: string; caseDirs: readonly string[]; concurrency: number; preflight: boolean;
  /** Only these arms' units (default: every arm, the round-1 schedule); e.g. ["A"] for the round-2 calibration runs. */
  arms?: readonly Arm[];
  /** Install SIGTERM/SIGINT handlers that stop the driver (the CLI does). */
  signals?: boolean;
  /** The unit process (default: the study's frozen run.ts unit …); tests substitute a stand-in. */
  command?: (unit: UnitState, study: string) => { command: string; args: string[]; cwd?: string };
  killGraceMs?: number;
  onStarted?: (control: { stop: (reason: string) => void; running: () => string[] }) => void;
}
export interface DriverResult { completed: number; failed: number; interrupted: number; pending: number; stopped: boolean; state: DriverState }

export async function runDriver(options: DriverOptions): Promise<DriverResult> {
  const study = resolve(options.study);
  if (!existsSync(join(study, "environment.json"))) throw new Error(`${study} is not prepared (no environment.json)`);
  if (!options.preflight && !existsSync(join(study, "manifest.json"))) throw new Error(`${study}/manifest.json is missing: measured units run only after the task manager wrote it (--preflight is for preflight units only)`);
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("concurrency must be a positive integer");
  const cases = options.caseDirs.map(dir => loadCase(dir));
  if (new Set(cases.map(item => item.id)).size !== cases.length || new Set(cases.map(item => item.order)).size !== cases.length) throw new Error("case ids and orders must be unique");
  const specs = schedule(cases.map(item => ({ id: item.id, order: item.order }))).filter(spec => !options.arms || options.arms.includes(spec.arm));
  const driverDir = join(study, "driver");
  mkdirSync(join(driverDir, "logs"), { recursive: true });
  const log = (line: string) => { const text = `${now()} ${line}`; console.log(text); appendFileSync(join(driverDir, "driver.log"), `${text}\n`); };
  const release = acquireLock(join(driverDir, "lock.json"), log);
  const listeners: [NodeJS.Signals, () => void][] = [];
  try {
    const stateFile = join(driverDir, "state.json");
    const previous = safeJson(stateFile) as DriverState | undefined;
    const state: DriverState = {
      version: 1, study, pid: process.pid, startedAt: now(), updatedAt: now(), preflight: options.preflight, concurrency: options.concurrency,
      cases: cases.map(item => ({ id: item.id, order: item.order, dir: item.dir, sha256: item.sha256, promptSha256: item.promptSha256 })), units: [],
    };
    const save = () => { state.updatedAt = now(); writeAtomic(stateFile, state); };
    /** A completed unit: kept, or (no successful model request, retries left) moved to `.infra-<n>` for a rerun. */
    const settle = (unit: UnitState, meta: any): "completed" | "retry" => {
      if (infraFailure(unit.dir, meta) && countSuffix(unit.dir, "infra") < LIMITS.infraRetries) {
        const kept = `${unit.dir}.infra-${nextSuffix(unit.dir, "infra")}`;
        renameSync(unit.dir, kept);
        log(`INFRA ${unit.id}: no successful model request; attempt kept as ${basename(kept)}; rerun`);
        const last = unit.attempts.at(-1);
        if (last && !last.keptAs) { last.outcome = "infra"; last.keptAs = basename(kept); }
        unit.status = "pending";
        return "retry";
      }
      unit.status = "completed"; unit.result = resultOf(meta);
      return "completed";
    };
    for (const spec of specs) {
      const item = cases.find(entry => entry.id === spec.caseId)!;
      const dir = unitDir(study, spec.caseId, spec.arm, spec.repeat);
      const unit: UnitState = { ...spec, caseDir: item.dir, dir, status: "pending", attempts: previous?.units?.find(entry => entry.id === spec.id)?.attempts ?? [] };
      const seen = inspectUnit(dir);
      if (seen.kind === "active") throw new Error(`${spec.id} is still running (pid ${seen.meta.pid}); stop it before starting a driver`);
      if (seen.kind === "completed") settle(unit, seen.meta);
      if (seen.kind === "incomplete") {
        const kept = `${dir}.interrupted-${nextSuffix(dir, "interrupted")}`;
        renameSync(dir, kept);
        // An unfinished attempt never ran its own redaction to the end: no credential may stay in what is kept.
        redactTree(kept, liveSecrets());
        const last = unit.attempts.at(-1);
        if (last && !last.keptAs && last.outcome !== "completed") { last.outcome ??= "interrupted"; last.keptAs = basename(kept); }
        else unit.attempts.push({ n: unit.attempts.length + 1, startedAt: seen.meta?.startedAt ?? "?", outcome: "interrupted", keptAs: basename(kept), note: `found ${seen.meta?.status ?? "without meta.json"} when the driver started` });
        log(`RESUME ${spec.id}: the unfinished attempt (${seen.meta?.status ?? "no meta.json"}) is kept as ${basename(kept)}; rerun`);
      }
      state.units.push(unit);
    }
    const queue = state.units.filter(unit => unit.status !== "completed");
    save();
    log(`DRIVER pid ${process.pid}: ${state.units.length} units, ${queue.length} to run, ${state.units.length - queue.length} completed; concurrency ${options.concurrency}${options.preflight ? "; preflight" : ""}`);

    const running = new Map<string, ChildProcess>();
    let stopping: string | undefined;
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = reason;
      log(`STOP ${reason}: no new unit starts; stopping ${running.size} running unit(s)`);
      for (const child of running.values()) { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } }
      const timer = setTimeout(() => { for (const child of running.values()) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } } }, options.killGraceMs ?? 30_000);
      timer.unref();
    };
    if (options.signals) for (const signal of ["SIGTERM", "SIGINT"] as const) { const handler = () => stop(signal); listeners.push([signal, handler]); process.on(signal, handler); }
    options.onStarted?.({ stop, running: () => [...running.keys()] });

    const command = options.command ?? ((unit: UnitState) => ({ command: NODE, args: ["--import", "tsx", join(study, "harness", HARNESS_ENTRY), "unit", study, unit.caseDir, unit.arm, String(unit.repeat), ...(options.preflight ? ["--preflight"] : [])], cwd: REPO }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PI_|CLIPROXYAPI_|ORCHE_)/.test(name)));
    const runOnce = (unit: UnitState, attempt: Attempt) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
      const spec = command(unit, study);
      const fd = openSync(join(driverDir, "logs", `${unit.caseId}__${unit.arm}__r${unit.repeat}.log`), "a");
      let child: ChildProcess;
      try { child = spawn(spec.command, spec.args, { cwd: spec.cwd ?? REPO, env: { ...env, CB_AB_DRIVER_PID: String(process.pid) }, detached: true, stdio: ["ignore", fd, fd] }); } finally { closeSync(fd); }
      attempt.pid = child.pid;
      running.set(unit.id, child);
      save();
      child.once("error", error => { running.delete(unit.id); attempt.note = `spawn error: ${String(error).slice(0, 200)}`; done({ code: -1, signal: null }); });
      child.once("exit", (code, signal) => { running.delete(unit.id); done({ code, signal }); });
    });
    const runUnit = async (unit: UnitState) => {
      for (;;) {
        if (stopping) return;
        const attempt: Attempt = { n: unit.attempts.length + 1, startedAt: now() };
        unit.attempts.push(attempt);
        unit.status = "running";
        save();
        log(`START ${unit.id} attempt ${attempt.n}`);
        const { code, signal } = await runOnce(unit, attempt);
        attempt.endedAt = now(); attempt.exit = code; attempt.signal = signal;
        const seen = inspectUnit(unit.dir);
        if (seen.kind === "completed") {
          if (settle(unit, seen.meta) === "retry") { save(); continue; }
          attempt.outcome = "completed"; save();
          log(`END ${unit.id} completed: ${brief(unit.result)}`);
          return;
        }
        attempt.outcome = stopping ? "interrupted" : "failed";
        attempt.note ??= seen.meta?.error ? String(seen.meta.error).split("\n")[0]!.slice(0, 300) : undefined;
        unit.status = stopping ? "interrupted" : "failed";
        save();
        log(`END ${unit.id} ${unit.status} (exit ${code}${signal ? ` ${signal}` : ""}${attempt.note ? `: ${attempt.note}` : ""}); the next driver start keeps this attempt as .interrupted-<n> and reruns the unit`);
        return;
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => { for (let unit = queue.shift(); unit && !stopping; unit = queue.shift()) await runUnit(unit); }));
    for (const unit of state.units) if (unit.status === "running") unit.status = "interrupted";
    state.endedAt = now();
    if (stopping) state.stopped = stopping;
    save();
    const count = (status: UnitStatus) => state.units.filter(unit => unit.status === status).length;
    const cost = state.units.reduce((total, unit) => total + Number(unit.result?.costUSD ?? 0), 0);
    log(`DRIVER END: completed ${count("completed")}, failed ${count("failed")}, interrupted ${count("interrupted")}, pending ${count("pending")}; completed units cost $${cost.toFixed(2)}${stopping ? ` (stopped: ${stopping})` : ""}`);
    return { completed: count("completed"), failed: count("failed"), interrupted: count("interrupted"), pending: count("pending"), stopped: !!stopping, state };
  } finally {
    for (const [signal, handler] of listeners) process.off(signal, handler);
    release();
  }
}

/** Every unit directory of a study: runs/<case>/<arm>/r<n>, and the kept attempts (.infra-<n>, .interrupted-<n>). */
export function scanUnits(studyDir: string): { id: string; dir: string; attempt?: string; meta?: any }[] {
  const root = join(resolve(studyDir), "runs");
  const out: { id: string; dir: string; attempt?: string; meta?: any }[] = [];
  if (!existsSync(root)) return out;
  for (const caseId of readdirSync(root).sort()) for (const arm of existsSync(join(root, caseId)) ? readdirSync(join(root, caseId)).sort() : []) {
    for (const name of readdirSync(join(root, caseId, arm)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
      const match = /^(r\d+)(?:\.((?:infra|interrupted)-\d+))?$/.exec(name);
      if (!match) continue;
      const dir = join(root, caseId, arm, name);
      out.push({ id: `${caseId}/${arm}/${match[1]}`, dir, ...(match[2] ? { attempt: match[2] } : {}), meta: safeJson(join(dir, "meta.json")) });
    }
  }
  return out;
}

/** `status <study>`: the driver (lock), unit counts by state, each unit's last attempt, spent cost, the last log lines. */
export function driverStatus(studyDir: string): string {
  const study = resolve(studyDir), driverDir = join(study, "driver");
  const lines: string[] = [];
  const lock = safeJson(join(driverDir, "lock.json"));
  lines.push(lock ? `driver: pid ${lock.pid} ${alive(lock.pid) ? "running" : "NOT running (stale lock)"} since ${lock.startedAt}` : "driver: not running");
  const state = safeJson(join(driverDir, "state.json")) as DriverState | undefined;
  const found = scanUnits(study);
  const current = new Map(found.filter(item => !item.attempt).map(item => [item.id, item]));
  const ids = state ? state.units.map(unit => unit.id) : [...current.keys()];
  const statusOf = (id: string): string => {
    const meta = current.get(id)?.meta;
    if (meta?.status === "running" && typeof meta.pid === "number" && !alive(meta.pid)) return "dead";
    return meta?.status ?? state?.units.find(unit => unit.id === id)?.status ?? "pending";
  };
  const counts: Record<string, number> = {};
  for (const id of ids) { const status = statusOf(id); counts[status] = (counts[status] ?? 0) + 1; }
  const spent = found.reduce((total, item) => total + Number(item.meta?.usage?.total?.costUSD ?? 0), 0);
  lines.push(`units: ${ids.length} — ${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(", ") || "none"}; kept attempts ${found.filter(item => item.attempt).length}; spent $${spent.toFixed(2)} (completed units and kept attempts)`);
  if (state) lines.push(`state: updated ${state.updatedAt}${state.endedAt ? `, ended ${state.endedAt}` : ""}${state.stopped ? ` (stopped: ${state.stopped})` : ""}; concurrency ${state.concurrency}${state.preflight ? "; preflight" : ""}`);
  for (const id of ids) {
    const meta = current.get(id)?.meta;
    const attempts = found.filter(item => item.id === id && item.attempt).map(item => item.attempt).join(",");
    lines.push(`  ${id.padEnd(28)} ${statusOf(id).padEnd(11)} ${meta?.status === "completed" ? brief(resultOf(meta)) : meta?.startedAt ? `started ${meta.startedAt}` : ""}${attempts ? ` [kept: ${attempts}]` : ""}`);
  }
  if (existsSync(join(driverDir, "driver.log"))) lines.push("log:", ...readFileSync(join(driverDir, "driver.log"), "utf8").trimEnd().split("\n").slice(-6).map(line => `  ${line}`));
  return lines.join("\n");
}
