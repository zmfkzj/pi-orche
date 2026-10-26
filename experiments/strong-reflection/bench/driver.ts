/**
 * Driver of the strong-reflection hard-task bench (PREREGISTRATION.md): freezes the orche runtime once, then runs the units
 * (task × repeat) CONCURRENCY at a time. A unit runs its arms one after another at the same live path: O, then R0/R1 in the unit's
 * seeded order. Infra rule: an O whose wire has no successful upstream response is retried once (the failed attempt is kept as
 * O.infra-1). No new unit starts once the billed cost reaches BUDGET_USD. Resumable: finished arms (meta.json) are skipped.
 *
 *   node --import tsx experiments/strong-reflection/bench/driver.ts <bench dir> [unit ...]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freezeRuntime } from "../../ultra-ab/env.js";
import { BUDGET_USD, CONCURRENCY, REPEATS, TASKS, orderOf, type Arm } from "./protocol.js";

const bench = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: driver.ts <bench dir> [unit ...]");
const SCRATCH = process.env.BENCH_SCRATCH ?? "/tmp/pi-orche/01a152d6-1832-7291-b05c-3e9a404e5ca3/W1/srb";
const HARD_KILL_MS = 170 * 60_000;
const log = (line: string) => { console.log(line); return appendFile(join(bench, "driver.log"), `${new Date().toISOString()} ${line}\n`); };

const shortName = (task: string) => task.replace(/^.*__/, "").replace(/[^a-z0-9-]/gi, "").slice(0, 16);
const allUnits = TASKS.flatMap(task => Array.from({ length: REPEATS }, (_, i) => ({ id: `${shortName(task)}-r${i + 1}`, task })));
const wanted = process.argv.slice(3);
// `smoke-<task short name>`: a harness smoke unit (excluded from the analysis; PREREGISTRATION.md).
const smoke = wanted.filter(id => id.startsWith("smoke-")).map(id => ({ id, task: TASKS.find(task => shortName(task) === id.slice(6))! })).filter(unit => unit.task);
const units = wanted.length ? [...smoke, ...allUnits.filter(unit => wanted.includes(unit.id))] : allUnits;

function spentUsd(): number {
  let total = 0;
  const root = join(bench, "units");
  if (!existsSync(root)) return 0;
  for (const unit of readdirSync(root)) for (const arm of readdirSync(join(root, unit))) {
    const file = join(root, unit, arm, "meta.json");
    if (existsSync(file)) { try { total += JSON.parse(readFileSync(file, "utf8")).wire?.liveCostUsd ?? 0; } catch { /* partial */ } }
  }
  return total;
}

function runArm(unit: string, task: string, arm: Arm): Promise<number | null> {
  const live = join(SCRATCH, unit, "live");
  return new Promise(done => {
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "run-arm.ts"), bench, unit, task, arm, live], { cwd: resolve(import.meta.dirname, "../../.."), detached: true, stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(PI_|CLIPROXYAPI_|ORCHE_)/.test(name))) });
    const out = join(bench, "units", unit, `${arm}.log`);
    child.stdout.on("data", chunk => void appendFile(out, chunk));
    child.stderr.on("data", chunk => void appendFile(out, chunk));
    const timer = setTimeout(() => { void log(`${unit}/${arm}: hard kill after ${HARD_KILL_MS / 60000} min`); try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, HARD_KILL_MS);
    child.once("close", code => {
      clearTimeout(timer);
      // Background processes the arm left behind (servers started by tests, shells) die with its process group.
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* none left */ }
      done(code);
    });
  });
}

const okWire = (file: string): boolean => existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).some(line => { try { const entry = JSON.parse(line); return entry.status === 200 && entry.usage; } catch { return false; } });

async function runUnit(unit: { id: string; task: string }): Promise<void> {
  const dir = join(bench, "units", unit.id);
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, "O/meta.json"))) {
    if (spentUsd() >= BUDGET_USD) { await log(`${unit.id}: not started (budget ${BUDGET_USD} USD reached)`); return; }
    await log(`${unit.id}/O start`);
    let code = await runArm(unit.id, unit.task, "O");
    if (!okWire(join(dir, "O/wire.jsonl"))) {
      await log(`${unit.id}/O: no successful upstream response (exit ${code}); infra retry`);
      if (existsSync(join(dir, "O"))) await rename(join(dir, "O"), join(dir, "O.infra-1"));
      code = await runArm(unit.id, unit.task, "O");
    }
    await log(`${unit.id}/O exit ${code}`);
  }
  const metaFile = join(dir, "O/meta.json");
  if (!existsSync(metaFile)) { await log(`${unit.id}: O has no meta.json; no replays`); return; }
  const o = JSON.parse(readFileSync(metaFile, "utf8"));
  if (!o.checkpoint) { await log(`${unit.id}: O reached no reflection point (${o.terminal}); no replays`); return; }
  for (const arm of orderOf(unit.id)) {
    if (existsSync(join(dir, arm, "meta.json"))) continue;
    await log(`${unit.id}/${arm} start`);
    const code = await runArm(unit.id, unit.task, arm);
    await log(`${unit.id}/${arm} exit ${code}`);
  }
}

async function main() {
  await mkdir(bench, { recursive: true });
  const rt = await freezeRuntime(bench);
  await log(`runtime ${rt.digest.slice(0, 16)}; units ${units.map(unit => unit.id).join(",")}`);
  const queue = [...units];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let unit = queue.shift(); unit; unit = queue.shift()) {
      try { await runUnit(unit); } catch (error) { await log(`${unit.id}: driver error ${String(error).slice(0, 300)}`); }
    }
  }));
  await log(`done; billed ${spentUsd().toFixed(2)} USD`);
}
await main();
