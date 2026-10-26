/**
 * Calibration driver of one frozen pool (experiments/headroom-pool/README.md "Calibration"): runs the frozen schedule with bounded
 * concurrency, scores each attempt model-free, reruns an invalid attempt at most MAX_RERUNS times (a valid attempt, miss or not, is
 * never rerun), then derives the confirmation units from the screening outcomes (protocol.ts needsConfirmation) and runs them.
 * Resume: completed attempts are reused; an attempt directory without a completed meta.json is archived as `.interrupted-<n>` and
 * counts as an invalid attempt of its slot. One driver per pool (lock file with the driver's pid); SIGINT/SIGTERM stop every live
 * proxy and sandbox before the driver exits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { graderDir, readJsonFile, type StudyPaths } from "./cases.js";
import type { FrozenCalibration } from "./freeze.js";
import { MAX_RERUNS, needsConfirmation, unitsOf, type CalUnit, type Outcome, type PoolName } from "./protocol.js";
import { scoreAttempt, type Score } from "./score.js";
import { liveChildren, runAttempt, type FrozenCase } from "./unit.js";
import { fileSha256 } from "../witness-replay/witness-run.js";

export const calibrationDir = (paths: StudyPaths, pool: PoolName) => join(paths.out, "calibration", pool);
export const unitDir = (paths: StudyPaths, pool: PoolName, unit: string) => join(calibrationDir(paths, pool), "units", unit);

export interface SlotState { unit: string; case: string; phase: string; slot: number; attempts: { n: number; dir: string; completed: boolean; valid?: boolean; outcome?: Outcome | "interrupted"; interrupted?: boolean }[]; outcome: Outcome | "missing" | "pending" }

/** Attempts of a unit directory (attempt-<n> and archived .interrupted-<n>), in order. */
export function attemptsOf(dir: string): SlotState["attempts"] {
  if (!existsSync(dir)) return [];
  const out: SlotState["attempts"] = [];
  for (const name of readdirSync(dir)) {
    const match = /^(?:attempt-(\d+)|\.interrupted-(\d+))$/.exec(name);
    if (!match) continue;
    const n = Number(match[1] ?? match[2]);
    const path = join(dir, name);
    if (match[2]) { out.push({ n, dir: path, completed: false, interrupted: true, outcome: "interrupted" }); continue; }
    const meta = existsSync(join(path, "meta.json")) ? readJsonFile(join(path, "meta.json")) : undefined;
    const completed = meta?.status === "completed";
    const score: Score | undefined = existsSync(join(path, "score.json")) ? readJsonFile(join(path, "score.json")) : undefined;
    out.push({ n, dir: path, completed, ...(completed ? { valid: meta.valid === true } : {}), ...(completed ? { outcome: meta.valid === true ? score?.outcome : "invalid" } : {}) });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The slot's state from its attempts (pure over attemptsOf). */
export function slotState(unit: CalUnit, attempts: SlotState["attempts"]): SlotState {
  const last = attempts.at(-1);
  let outcome: SlotState["outcome"] = "pending";
  if (last?.completed && last.outcome && last.outcome !== "invalid" && last.outcome !== "interrupted") outcome = last.outcome;
  else if (attempts.length > MAX_RERUNS && attempts.every(item => item.outcome === "invalid" || item.outcome === "interrupted")) outcome = "missing";
  return { unit: unit.name, case: unit.case, phase: unit.phase, slot: unit.slot, attempts, outcome };
}

async function forEachConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const item = items[next++]!; await work(item); } }));
}

let stopping = false;
function installSignalHandlers(lock: string): void {
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`driver: ${signal}; stopping ${liveChildren.size} live process group(s)`);
    for (const kill of liveChildren.values()) { try { kill(); } catch { /* gone */ } }
    try { unlinkSync(lock); } catch { /* gone */ }
    process.exit(130);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => { /* detached drivers ignore hangups */ });
}

/** An attempt whose harness threw: a completed, infrastructure-invalid attempt (wire totals kept when its proxy ran). */
export function markHarnessError(outDir: string, unit: CalUnit, n: number, error: unknown): any {
  const metaPath = join(outDir, "meta.json"), totalsPath = join(outDir, "wire.jsonl.totals.json");
  const previous = existsSync(metaPath) ? readJsonFile(metaPath) : { unit: unit.name, case: unit.case, attempt: n };
  const meta = { ...previous, status: "completed", valid: false, invalid: "infrastructure", invalidDetail: `harness error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`.slice(0, 2000), ...(existsSync(totalsPath) ? { wire: readJsonFile(totalsPath) } : {}), endedAt: new Date().toISOString() };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** Score an attempt; a scoring exception is recorded as an unscored score (re-scorable model-free by deleting score.json). */
async function scoreSafely(paths: StudyPaths, c: FrozenCase, attemptDir: string, unit: string): Promise<{ outcome: string; line: string }> {
  try {
    const score: Score = await scoreAttempt({ c, attemptDir, graderDir: graderDir(paths, c.id), scratch: join(paths.roots.scratch, "score", unit) });
    return { outcome: score.outcome, line: `witness ${score.witness.status}${score.witness.reason ? ` (${score.witness.reason})` : ""}; hidden F2P ${score.hidden.f2pPassed}/${score.hidden.f2pTotal}${score.hidden.error ? " (error)" : ""}; regressions ${score.regressions.nowNotPassing.length}${score.regressions.error ? " (error)" : ""}` };
  } catch (error) {
    const text = (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 3000);
    writeFileSync(join(attemptDir, "score.json"), `${JSON.stringify({ attempt: attemptDir, at: new Date().toISOString(), outcome: "unscored", error: text }, null, 2)}\n`);
    return { outcome: "unscored", line: `scoring error: ${text.split("\n")[0]}` };
  }
}

/** Run one slot to its end (a valid outcome or missing after the rerun bound); returns its state. */
async function runSlot(paths: StudyPaths, plan: FrozenCalibration, c: FrozenCase, unit: CalUnit): Promise<SlotState> {
  const dir = unitDir(paths, plan.pool, unit.name);
  await mkdir(dir, { recursive: true });
  // Archive attempts a dead driver left incomplete (they count as invalid attempts of the slot).
  for (const attempt of attemptsOf(dir)) if (!attempt.completed && !attempt.interrupted) renameSync(attempt.dir, join(dir, `.interrupted-${attempt.n}`));
  for (;;) {
    if (stopping) return slotState(unit, attemptsOf(dir));
    const attempts = attemptsOf(dir);
    // Score completed valid attempts that have no score yet.
    for (const attempt of attempts) if (attempt.completed && attempt.valid && attempt.outcome === undefined) await scoreSafely(paths, c, attempt.dir, unit.name);
    const state = slotState(unit, attemptsOf(dir));
    if (state.outcome !== "pending") return state;
    const n = (attempts.at(-1)?.n ?? 0) + 1;
    if (n > 1 + MAX_RERUNS) throw new Error(`${unit.name}: attempt ${n} would exceed the rerun bound`);
    const outDir = join(dir, `attempt-${n}`);
    console.log(`${new Date().toISOString()} start ${unit.name} attempt ${n}`);
    let meta: any;
    try {
      meta = await runAttempt({ runtime: plan.runtime, c, unit: unit.name, attempt: n, outDir, scratch: join(paths.roots.scratch, "units", `${unit.name}-a${n}`) });
    } catch (error) {
      if (stopping) return slotState(unit, attemptsOf(dir));
      meta = markHarnessError(outDir, unit, n, error);
    }
    console.log(`${new Date().toISOString()} end ${unit.name} attempt ${n}: ${meta.valid ? `valid ${meta.terminal}` : `invalid ${meta.invalid}: ${String(meta.invalidDetail ?? "").split("\n")[0]}`} (${meta.wire?.forwarded ?? 0} requests, ${Math.round((meta.wallMs ?? 0) / 1000)} s)`);
    if (meta.valid) {
      const scored = await scoreSafely(paths, c, outDir, unit.name);
      console.log(`${new Date().toISOString()} scored ${unit.name} attempt ${n}: ${scored.outcome} (${scored.line})`);
    }
  }
}

/** The calibration state of a frozen pool (pure over the unit directories). */
export function calibrationState(paths: StudyPaths, plan: FrozenCalibration): { screen: SlotState[]; confirm: SlotState[]; confirmCases: string[] } {
  const screen = plan.cases.flatMap(c => unitsOf(c.id, "screen")).map(unit => slotState(unit, attemptsOf(unitDir(paths, plan.pool, unit.name))));
  const screenDone = screen.every(slot => slot.outcome !== "pending");
  const confirmCases = screenDone ? plan.cases.map(c => c.id).filter(id => needsConfirmation(screen.filter(slot => slot.case === id).map(slot => slot.outcome as Outcome | "missing"))) : [];
  const confirm = confirmCases.flatMap(id => unitsOf(id, "confirm")).map(unit => slotState(unit, attemptsOf(unitDir(paths, plan.pool, unit.name))));
  return { screen, confirm, confirmCases };
}

/** Harness files whose sha256 differs from the frozen plan (checked before any paid call of a driver start). */
export function harnessDrift(paths: StudyPaths, plan: FrozenCalibration): string[] {
  return Object.entries(plan.harness).filter(([file, sha]) => !existsSync(join(paths.repo, file)) || fileSha256(join(paths.repo, file)) !== sha).map(([file]) => file);
}

/** Drive a frozen pool: screening, then confirmation. */
export async function drive(paths: StudyPaths, pool: PoolName, concurrency: number): Promise<void> {
  const plan = readJsonFile<FrozenCalibration>(join(paths.out, "frozen", pool, "calibration.json"));
  const dir = calibrationDir(paths, pool);
  await mkdir(dir, { recursive: true });
  const drift = harnessDrift(paths, plan);
  if (drift.length) {
    const reason = process.env.HEADROOM_HARNESS_CHANGE;
    if (!reason) throw new Error(`harness files differ from the frozen plan: ${drift.join(", ")} (set HEADROOM_HARNESS_CHANGE=<reason> to record a documented change)`);
    appendFileSync(join(dir, "harness-changes.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), files: drift, reason })}\n`);
  }
  const lock = join(dir, "driver.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
    if (alive) throw new Error(`a driver (pid ${pid}) is running for pool ${pool}`);
  }
  writeFileSync(lock, String(process.pid));
  installSignalHandlers(lock);
  try {
    const byId = new Map(plan.cases.map(c => [c.id, c]));
    const screenUnits = plan.cases.flatMap(c => unitsOf(c.id, "screen"));
    await forEachConcurrent(screenUnits, concurrency, async unit => { await runSlot(paths, plan, byId.get(unit.case)!, unit); });
    if (stopping) return;
    const state = calibrationState(paths, plan);
    console.log(`${new Date().toISOString()} screening done; confirmation cases: ${state.confirmCases.join(", ") || "none"}`);
    const confirmUnits = state.confirmCases.flatMap(id => unitsOf(id, "confirm"));
    await forEachConcurrent(confirmUnits, concurrency, async unit => { await runSlot(paths, plan, byId.get(unit.case)!, unit); });
    console.log(`${new Date().toISOString()} calibration of pool ${pool} done`);
  } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}
