/**
 * witness-replay pilot commands (experiments/witness-replay/README.md). <out> is results/witness-replay; <scratch> a private
 * directory outside the repository (workspaces, sandboxes, staged venvs).
 *   audit    <out> <scratch>          R1: run every candidate witness against original / reference / archived artifacts
 *   audit-tox-line71 <out> <scratch>  R1: the tox issue's own experiment (prompt.txt:71) on the whole visible test suite
 *   audit-nw-native <out> <scratch> <native env dir>  R9: the Narwhals issue's reproduction on real PySpark (audit-native.ts)
 *   freeze   <out> <scratch>          freeze seeds, witnesses, prompts, environment, budget and schedule (never overwritten)
 *   smoke    <out> <scratch>          harness smoke through proxy + sandbox + Pi with one trivial prompt (NOT a revision session)
 *   smoke-gate <out> <scratch>        both arm paths end to end on a synthetic task (NOT a revision session of the pilot)
 *   run      <out> <scratch>          the frozen schedule: both arms of a seed concurrently, pairs in order, one rerun of an invalid attempt
 *   evaluate <out> <scratch>          model-free evaluation of every unit's counted attempt
 *   decide   <out>                    the preregistered decision over the evaluations (decision.json)
 *   probe    <out> <scratch> <unit> [shell command]   model-free: the unit's staged sandbox runs one command (default: the reproducer as the model would)
 *   status   <out>
 */
import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAudit, runToxLine71 } from "./audit.js";
import { runNwNative } from "./audit-native.js";
import { readJson, writeJson } from "./env.js";
import { evaluateAttempt, outcomeOf } from "./evaluate.js";
import { freeze } from "./freeze.js";
import { decide, digestOf, type Outcome } from "./protocol.js";
import { smoke } from "./smoke.js";
import { smokeGate } from "./smoke-seed.js";
import { attemptsOf, probeUnit, runUnit, type FrozenPlan } from "./unit.js";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function loadPlan(out: string): FrozenPlan {
  const plan = JSON.parse(readFileSync(join(out, "frozen/plan.json"), "utf8")) as FrozenPlan;
  const digest = digestOf({ ...plan, planDigest: undefined, createdAt: undefined });
  if (plan.planDigest !== digest) throw new Error(`frozen plan digest mismatch (${plan.planDigest} vs ${digest})`);
  return plan;
}

/** Attempt bookkeeping of one unit (pure over its attempt metas): the counted attempt, invalid ones, whether another may run. */
export function unitState(metas: { name: string; meta?: any }[], maxReruns: number): { counted?: string; invalid: string[]; interrupted: string[]; next: "run" | "done" | "missing" } {
  const invalid: string[] = [], interrupted: string[] = [];
  let counted: string | undefined;
  for (const { name, meta } of metas) {
    if (!meta || meta.status !== "completed") { interrupted.push(name); continue; }
    if (meta.valid === true && meta.terminal !== "invalid") { counted = name; break; }
    invalid.push(name);
  }
  if (counted) return { counted, invalid, interrupted, next: "done" };
  return { invalid, interrupted, next: invalid.length + interrupted.length > maxReruns ? "missing" : "run" };
}

async function run(out: string, scratch: string): Promise<void> {
  const plan = loadPlan(out);
  const frozenDir = join(out, "frozen");
  const lock = join(out, "driver.lock");
  if (existsSync(lock)) {
    const holder = JSON.parse(readFileSync(lock, "utf8"));
    if (alive(holder.pid)) throw new Error(`a driver (pid ${holder.pid}) is running: never start a second one`);
  }
  await writeJson(lock, { pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const pairs = [...new Set(plan.schedule.map(unit => unit.pair))].sort((a, b) => a - b);
    for (const pair of pairs) {
      const units = plan.schedule.filter(unit => unit.pair === pair).sort((a, b) => a.position - b.position);
      await Promise.all(units.map(async (unit, offset) => {
        const unitDir = join(out, "units", unit.name);
        for (;;) {
          const metaOf = (name: string): any => existsSync(join(unitDir, name, "meta.json")) ? JSON.parse(readFileSync(join(unitDir, name, "meta.json"), "utf8")) : undefined;
          // An attempt a dead driver left behind is kept, renamed, and counts as one invalid attempt.
          for (const name of attemptsOf(unitDir)) if (metaOf(name)?.status !== "completed") renameSync(join(unitDir, name), join(unitDir, `${name}.interrupted`));
          const interrupted = readdirSafe(unitDir).filter(name => name.endsWith(".interrupted"));
          const completed: { name: string; meta?: any }[] = attemptsOf(unitDir).map(name => ({ name, meta: metaOf(name) }));
          const state = unitState([...completed, ...interrupted.map(name => ({ name }))], plan.maxReruns);
          if (state.next !== "run") { console.log(`${unit.name}: ${state.next}${state.counted ? ` (${state.counted})` : ""}`); return; }
          const attempt = completed.length + interrupted.length + 1;
          if (offset > 0) await new Promise(resolve => setTimeout(resolve, 5_000)); // the second arm starts a moment later
          const outDir = join(unitDir, `attempt-${attempt}`);
          const unitScratch = join(scratch, "u", `${unit.name}-a${attempt}`);
          console.log(`${new Date().toISOString()} ${unit.name} attempt ${attempt}: start`);
          try {
            const meta = await runUnit({ plan, frozenDir, unit: unit.name, attempt, outDir, scratch: unitScratch, envRoot: join(scratch, "envs") });
            console.log(`${new Date().toISOString()} ${unit.name} attempt ${attempt}: ${meta.terminal}${meta.invalid ? ` (${meta.invalid})` : ""}, ${meta.wire?.forwarded ?? "?"} requests, $${meta.wire?.costUSD ?? "?"}`);
          } catch (error) {
            const text = error instanceof Error ? error.stack ?? error.message : String(error);
            console.error(`${unit.name} attempt ${attempt}: harness error ${text}`);
            const metaPath = join(outDir, "meta.json");
            const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : { unit: unit.name, attempt };
            await writeJson(metaPath, { ...meta, status: "completed", valid: false, terminal: "invalid", invalid: "infrastructure", error: text.slice(0, 4000) });
          }
        }
      }));
    }
  } finally { await rm(lock, { force: true }); }
}
const readdirSafe = (dir: string): string[] => existsSync(dir) ? readdirSync(dir) : [];

async function evaluateAll(out: string, scratch: string): Promise<void> {
  const plan = loadPlan(out);
  for (const unit of plan.schedule) {
    const unitDir = join(out, "units", unit.name);
    const metas = attemptsOf(unitDir).map(name => ({ name, meta: existsSync(join(unitDir, name, "meta.json")) ? JSON.parse(readFileSync(join(unitDir, name, "meta.json"), "utf8")) : undefined }));
    const state = unitState(metas, plan.maxReruns);
    if (!state.counted) { console.log(`${unit.name}: no counted attempt (${state.next})`); continue; }
    if (existsSync(join(unitDir, state.counted, "evaluation.json"))) { console.log(`${unit.name}: evaluated`); continue; }
    const evaluation = await evaluateAttempt(plan, join(out, "frozen"), join(unitDir, state.counted), join(scratch, "eval", unit.name), join(scratch, "envs"));
    console.log(`${unit.name}: witness ${evaluation.witness.status}, heldout ${evaluation.heldout?.status ?? "-"}, grade ${evaluation.grade?.passed}, new failures ${evaluation.visible?.newFailures?.length ?? "?"}, integrity ${evaluation.integrityOriginal?.violations?.length ?? "?"}, leaks ${evaluation.leaks.length}`);
  }
}

async function decideAll(out: string): Promise<void> {
  const plan = loadPlan(out);
  const outcomes: Outcome[] = [];
  for (const unit of plan.schedule) {
    const seed = plan.seeds.find(item => item.id === unit.seed)!;
    const unitDir = join(out, "units", unit.name);
    const metas = attemptsOf(unitDir).map(name => ({ name, meta: existsSync(join(unitDir, name, "meta.json")) ? JSON.parse(readFileSync(join(unitDir, name, "meta.json"), "utf8")) : undefined }));
    const state = unitState(metas, plan.maxReruns);
    if (!state.counted || !existsSync(join(unitDir, state.counted, "evaluation.json"))) { outcomes.push({ seed: seed.id, arm: unit.arm, role: seed.role, family: seed.family, missing: true }); continue; }
    outcomes.push(outcomeOf(await readJson(join(unitDir, state.counted, "evaluation.json"))));
  }
  const decision = decide(outcomes);
  await writeJson(join(out, "decision.json"), { at: new Date().toISOString(), outcomes, decision });
  console.log(JSON.stringify(decision, null, 2));
}

async function status(out: string): Promise<void> {
  const plan = loadPlan(out);
  for (const unit of plan.schedule) {
    const unitDir = join(out, "units", unit.name);
    const rows = readdirSafe(unitDir).map(name => { const path = join(unitDir, name, "meta.json"); const meta = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; return `${name}:${meta?.status ?? "?"}/${meta?.terminal ?? "-"}${meta?.invalid ? `(${meta.invalid})` : ""}`; });
    console.log(`${unit.name.padEnd(14)} ${rows.join("  ") || "not started"}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
async function main(): Promise<void> {
  const [outArg, scratchArg] = rest;
  const out = outArg ? resolve(outArg) : undefined;
  const scratch = scratchArg ? resolve(scratchArg) : undefined;
  const need = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${command}: missing <${name}>`); return value; };
  switch (command) {
    case "audit": await runAudit(join(need(out, "out"), "audit"), join(need(scratch, "scratch"), "audit")); return;
    case "audit-nw-native": await runNwNative(join(need(out, "out"), "audit", "nw-native"), join(need(scratch, "scratch"), "nw-native-audit"), need(rest[2], "native env dir")); return;
    case "audit-tox-line71": console.log(JSON.stringify(await runToxLine71(join(need(out, "out"), "audit"), join(need(scratch, "scratch"), "audit")), null, 2)); return;
    case "freeze": { const plan = await freeze(need(out, "out"), need(scratch, "scratch")); console.log(`frozen ${plan.seeds.length} seeds, ${plan.schedule.length} units, plan ${plan.planDigest}`); return; }
    case "smoke": await smoke(need(out, "out"), need(scratch, "scratch")); return;
    case "smoke-gate": await smokeGate(need(out, "out"), need(scratch, "scratch")); return;
    case "run": await mkdir(need(out, "out"), { recursive: true }); await run(need(out, "out"), need(scratch, "scratch")); return;
    case "evaluate": await evaluateAll(need(out, "out"), need(scratch, "scratch")); return;
    case "decide": await decideAll(need(out, "out")); return;
    case "status": await status(need(out, "out")); return;
    case "probe": {
      const unit = need(rest[2], "unit");
      const command = rest[3] ?? "python /opt/witness/reproducer.py; echo \"reproducer exit $?\"; git status --short | head -20; git log --oneline | head -3; ls -a /home /tmp | head; python -c 'import sys; print(sys.version)'";
      const plan = loadPlan(need(out, "out"));
      const result = await probeUnit({ plan, frozenDir: join(need(out, "out"), "frozen"), unit, attempt: 0, outDir: join(need(scratch, "scratch"), "probe-out"), scratch: join(need(scratch, "scratch"), "u", `${unit}-probe`), envRoot: join(need(scratch, "scratch"), "envs") }, command);
      console.log(result.text);
      console.log(`probe exit ${result.code}`);
      return;
    }
    default: throw new Error(`unknown command ${command ?? "(none)"}`);
  }
}
if (process.argv[1]?.endsWith("cli.ts")) main().catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1); });
export { writeFile };
