/**
 * Stage 3 round 2, model-free (results/ultra-ho/stage3-r2/PREREGISTRATION.md "Calibration", "Validation units", "Decision rules",
 * amendments H2-A1 item 5 and H2-A2). Reads only what run-one.ts and the driver wrote; never a model, never a unit directory change.
 *
 *   npx tsx experiments/ultra-ho/r2.ts attempts <out>
 *       every unit of every manifest in <out> with its kept attempts, classified by H2-A2 (outcome, capacity stop, provider stop,
 *       harness, interrupted), and the units to rerun (`--rerun` list)
 *   npx tsx experiments/ultra-ho/r2.ts select <calibration out> <plan.json> [--write]
 *       H2-A1 item 5 on each pool task's calibration unit, in the plan's (pool) order, and the selection: the first three qualifying
 *       tasks; final only when no task before the third qualifier still needs a run. --write: <out>/selection.{json,md}
 *   npx tsx experiments/ultra-ho/r2.ts decide <validation out> <selection.json> [--write]
 *       the decision rules on the validation units: efficacy on the headroom tasks, the tox mechanism, the regression flag.
 *       --write: <out>/decision.{json,md}
 *
 * The H2-A2 class of an attempt comes from its meta.json, its wire log and its last orche task's failure text only, before any
 * grade is read. Qualification and the decision rules then read the grade (grade.json), final.diff, the reference fix (gold,
 * analysis only, under the unit's own fixture root) and, for the mechanism and the regression flag, the hand-off chain (chain.ts).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../ultra-ab/run-one.js";
import { HANDOFF_REFUSAL, diffFiles, isAccepted, referenceOf, unitChain, unitTask, type UnitChain } from "./chain.js";
import { resolveOut } from "./driver.js";
import { parsePlan } from "./protocol.js";

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

// ---------------------------------------------------------------------------------------------------------------------------
// H2-A2: attempts

/** H2-A2 item 1: a capacity error's message (also used on an orche task's failure text). */
export const CAPACITY = /auth_unavailable|no auth available|overloaded|rate.?limit/i;
/** Reruns of one unit after provider-capacity stops (H2-A2 item 3); a unit still stopped after them is MISSING. */
export const MAX_CAPACITY_RERUNS = 2;

/** H2-A2 item 1: a model request whose provider error has HTTP status 429 or 5xx, or a message naming a capacity condition. */
export function isCapacityError(entry: any): boolean {
  if (entry?.method !== "POST" || !entry?.providerError) return false;
  const status = Number(entry.status);
  const text = [entry.providerError.type, entry.providerError.code, entry.providerError.message].filter(item => typeof item === "string").join(" ");
  return status === 429 || status >= 500 || CAPACITY.test(text);
}

export type AttemptClass = "outcome" | "capacity-stop" | "provider-stop" | "harness" | "interrupted";
export interface Attempt {
  /** The directory name: r<n> (the unit's current attempt) or a kept one (r<n>.rerun-<k>, .infra-<k>, .interrupted-<k>). */
  name: string; dir: string; class: AttemptClass; reason: string;
  terminal?: string; startedAt?: number; requests: number; okRequests: number; providerErrors: number; costUSD: number;
}

/** The failure text of a unit's last orche task (records/<task dir>/run.json of meta.tasks, latest start). */
export function lastTaskFailure(dir: string, meta: any): string | undefined {
  const tasks = (Array.isArray(meta?.tasks) ? meta.tasks : []).filter((task: any) => typeof task?.dir === "string");
  const last = [...tasks].sort((a: any, b: any) => (Number(a.start) || 0) - (Number(b.start) || 0)).at(-1);
  if (!last) return undefined;
  const run = readJson(join(dir, "records", last.dir, "run.json"));
  return typeof run?.failure === "string" && run.failure ? run.failure : undefined;
}

/** A model request off the pinned route: a model other than gpt-6.1-sol, an effort other than high, or another response model. */
export const isOffRoute = (entry: any): boolean => entry?.method === "POST" && !!entry.model && (entry.model !== "gpt-6.1-sol" || entry.effort !== "high" || (entry.respModel !== undefined && entry.respModel !== "gpt-6.1-sol"));

/**
 * H2-A2 items 1-2 on one attempt directory: from meta.json, the wire log and the last orche task's failure text only. An attempt with
 * any off-route request is void (class harness: the route is fixed in the harness, then the unit reruns); it is never an outcome.
 */
export function classifyAttempt(dir: string): Attempt {
  const name = basename(dir);
  const meta = readJson(join(dir, "meta.json"));
  const posts = readJsonl<any>(join(dir, "wire.jsonl")).filter(entry => entry?.method === "POST" && entry.model);
  const base = {
    name, dir, ...(typeof meta?.terminal === "string" ? { terminal: meta.terminal } : {}), ...(typeof meta?.startedAt === "number" ? { startedAt: meta.startedAt } : {}),
    requests: posts.length, okRequests: posts.filter(entry => entry.status === 200 && !entry.providerError).length, providerErrors: posts.filter(entry => entry.providerError).length,
    costUSD: typeof meta?.wire?.costUSD === "number" ? meta.wire.costUSD : 0,
  };
  const offRoute = posts.filter(isOffRoute);
  if (offRoute.length) return { ...base, class: "harness", reason: `void: ${offRoute.length} off-route request(s) (${[...new Set(offRoute.map(entry => `${entry.model}/${entry.effort}`))].join(", ")})` };
  if (!meta || meta.status !== "completed") return { ...base, class: "interrupted", reason: "no completed meta.json (the unit, its driver or the machine stopped)" };
  if (meta.terminal === "infra" || meta.terminal === "harness-error") return { ...base, class: "harness", reason: clip(String(meta.infra ?? meta.harnessError ?? meta.terminal), 300) };
  if (meta.terminal !== "done") {
    const last = posts.at(-1);
    const failure = lastTaskFailure(dir, meta);
    if (last && isCapacityError(last)) return { ...base, class: "capacity-stop", reason: `last model request: ${last.status} ${clip(String(last.providerError?.message ?? last.providerError?.type ?? ""), 200)}` };
    if (failure && CAPACITY.test(failure)) return { ...base, class: "capacity-stop", reason: `last orche task failed: ${clip(failure, 200)}` };
    if (last?.providerError) return { ...base, class: "provider-stop", reason: `last model request: ${last.status} ${clip(String(last.providerError.message ?? last.providerError.type ?? ""), 200)}` };
  }
  return { ...base, class: "outcome", reason: `terminal ${meta.terminal}` };
}

export interface UnitAttempts {
  unit: string; task: string; arm: string; repeat: number;
  /**
   * outcome: the current attempt is an outcome; running: its attempt is unfinished and the phase's driver is alive (never rerun);
   * rerun: it must run (again); missing: provider stop, or capacity stops beyond the bound; pending: never run.
   */
  status: "outcome" | "running" | "rerun" | "missing" | "pending";
  current?: Attempt; attempts: Attempt[]; capacityStops: number; note: string;
}

/**
 * A unit's attempts (runs/<task>/<arm>/r<n> and its kept siblings) and its H2-A2 status. Capacity stops are counted by class, never
 * by `.rerun-<n>` suffix (zero-request harness attempts also carry suffixes). `live`: the phase's driver is alive, so an unfinished
 * current attempt is running, not interrupted.
 */
export function unitAttempts(out: string, unit: { id: string; task: string; arm: string; repeat: number }, live = false): UnitAttempts {
  const dir = join(out, "runs", unit.id);
  const parent = join(dir, "..");
  const own = basename(dir);
  const names = existsSync(parent) ? readdirSync(parent).filter(name => name === own || name.startsWith(`${own}.`)).sort() : [];
  const attempts = names.map(name => classifyAttempt(join(parent, name))).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.name.localeCompare(b.name));
  const current = attempts.find(item => item.name === own);
  const capacityStops = attempts.filter(item => item.class === "capacity-stop").length;
  // H2-A3: void attempts (off-route requests) count toward the same bound as provider-capacity stops.
  const voids = attempts.filter(item => item.class === "harness" && item.reason.startsWith("void:")).length;
  const stops = capacityStops + voids;
  const base = { unit: unit.id, task: unit.task, arm: unit.arm, repeat: unit.repeat, ...(current ? { current } : {}), attempts, capacityStops };
  if (!current) return { ...base, status: "pending", note: "not run yet" };
  if (current.class === "interrupted" && live) return { ...base, status: "running", note: "running (its driver is alive)" };
  switch (current.class) {
    case "outcome": return { ...base, status: "outcome", note: current.reason };
    case "capacity-stop": return stops > MAX_CAPACITY_RERUNS
      ? { ...base, status: "missing", note: `${capacityStops} provider-capacity stop(s) and ${voids} void attempt(s) (the bound is ${MAX_CAPACITY_RERUNS} reruns): MISSING` }
      : { ...base, status: "rerun", note: `provider-capacity stop (${stops} of at most ${1 + MAX_CAPACITY_RERUNS} stops and voids): rerun (H2-A2)` };
    case "provider-stop": return { ...base, status: "missing", note: `provider stop that is not a capacity error (never rerun): ${current.reason}` };
    case "harness": return current.reason.startsWith("void:")
      ? stops > MAX_CAPACITY_RERUNS
        ? { ...base, status: "missing", note: `${capacityStops} provider-capacity stop(s) and ${voids} void attempt(s) (the bound is ${MAX_CAPACITY_RERUNS} reruns): MISSING` }
        : { ...base, status: "rerun", note: `${current.reason} (${stops} of at most ${1 + MAX_CAPACITY_RERUNS} stops and voids): rerun with the route guard (H2-A3)` }
      : { ...base, status: "rerun", note: `harness failure (${current.reason}): fix the harness, then rerun` };
    default: return { ...base, status: "rerun", note: current.reason };
  }
}

/** Whether the driver of `phase` in `out` is alive: its lock file (driver-<phase>.lock) names a live pid. */
export function driverAlive(out: string, phase: string): boolean {
  const file = join(out, `driver-${phase}.lock`);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Every unit of every manifest-<phase>.json in `out`, with its attempts; an unfinished attempt under a live driver is running. */
export function studyAttempts(outInput: string): UnitAttempts[] {
  const out = resolveOut(outInput);
  const units: UnitAttempts[] = [];
  for (const name of existsSync(out) ? readdirSync(out).filter(item => /^manifest-.+\.json$/.test(item)).sort() : []) {
    const live = driverAlive(out, name.slice("manifest-".length, -".json".length));
    for (const unit of readJson(join(out, name))?.units ?? []) units.push(unitAttempts(out, unit, live));
  }
  return units;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Calibration: H2-A1 item 5 and the selection

export interface Qualification {
  task: string; order: number; unit: string; status: UnitAttempts["status"]; note: string;
  /** null: not decidable yet (the unit must run again); false for missing units. */
  qualifies: boolean | null;
  checks?: { notStop: boolean; routeCompliant: boolean; artifact: boolean; f2pFails: boolean | null; decisiveUntouched: boolean };
  terminal?: string; routeViolations?: number; diffFiles?: string[]; decisive?: string[]; untouched?: string[];
  failToPass?: { passed: boolean | null; detail?: string }; runner?: { passed: boolean | null; detail?: string }; gradeError?: string;
  reasons: string[];
}

/** The facts H2-A1 item 5 reads from one calibration outcome directory. */
export interface CalibrationFacts {
  terminal?: string; routeViolations: number | null; diffFiles: string[]; decisive: string[] | null;
  failToPass?: { passed?: unknown; detail?: unknown }; runner?: { passed?: unknown; detail?: unknown }; gradeError?: string;
}

export async function calibrationFacts(dir: string): Promise<CalibrationFacts> {
  const meta = readJson(join(dir, "meta.json")) ?? {};
  const grade = readJson(join(dir, "grade.json"))?.grade;
  let decisive: string[] | null = null;
  try { const reference = referenceOf(await unitTask(meta)); decisive = reference ? reference.files.filter(file => file.kind === "source").map(file => file.path) : null; } catch { decisive = null; }
  // The wire summary's count, and the listed violations when there are more of them; unknown without a wire summary.
  const violations = typeof meta.wire?.routeViolations === "number" ? Math.max(meta.wire.routeViolations, Array.isArray(meta.routeViolations) ? meta.routeViolations.length : 0) : null;
  return {
    ...(typeof meta.terminal === "string" ? { terminal: meta.terminal } : {}), routeViolations: violations,
    diffFiles: diffFiles(existsSync(join(dir, "final.diff")) ? readFileSync(join(dir, "final.diff"), "utf8") : ""), decisive,
    ...(grade?.checks?.failToPass ? { failToPass: grade.checks.failToPass } : {}), ...(grade?.checks?.runner ? { runner: grade.checks.runner } : {}),
    ...(grade?.error ? { gradeError: clip(String(grade.error), 500) } : !grade ? { gradeError: "no grade.json grade" } : {}),
  };
}

/**
 * H2-A1 item 5, literally: not a provider or infrastructure stop (H2-A2 status outcome), every request route-compliant, an artifact
 * (a non-empty final diff), hidden fail-to-pass tests that do not all pass (graded: the runner ran and no grading error), and at
 * least one decisive file (changed by the reference fix in non-test, non-doc source) that the final diff leaves untouched.
 * Missing grades, runner failures and integrity-only failures never make headroom.
 */
export function qualify(facts: CalibrationFacts): { qualifies: boolean; checks: NonNullable<Qualification["checks"]>; untouched: string[]; reasons: string[] } {
  const reasons: string[] = [];
  const routeCompliant = facts.routeViolations === 0;
  if (!routeCompliant) reasons.push(facts.routeViolations === null ? "route compliance unknown" : `${facts.routeViolations} route violation(s)`);
  const artifact = facts.diffFiles.length > 0;
  if (!artifact) reasons.push("no artifact (empty final diff)");
  const graded = !facts.gradeError && facts.runner?.passed === true && typeof facts.failToPass?.passed === "boolean";
  const f2pFails = graded ? facts.failToPass!.passed === false : null;
  if (f2pFails === null) reasons.push(`not graded (${facts.gradeError ?? (facts.runner?.passed !== true ? "the test runner failed" : "no fail-to-pass result")})`);
  else if (!f2pFails) reasons.push("hidden fail-to-pass tests all pass");
  const untouched = (facts.decisive ?? []).filter(path => !facts.diffFiles.includes(path));
  const decisiveUntouched = untouched.length > 0;
  if (facts.decisive === null) reasons.push("no reference fix found");
  else if (!facts.decisive.length) reasons.push("the reference fix changes no non-test source file");
  else if (!decisiveUntouched) reasons.push("the final diff touches every decisive file");
  const checks = { notStop: true, routeCompliant, artifact, f2pFails, decisiveUntouched };
  return { qualifies: routeCompliant && artifact && f2pFails === true && decisiveUntouched, checks, untouched, reasons };
}

export interface Selection {
  rule: string; plan: string; out: string; tasks: Qualification[];
  /** determined: no task before the third qualifier still needs a run; final: determined and every planned unit is accounted for. */
  selected: string[]; determined: boolean; final: boolean; pending?: string; fewerThanThree?: string;
}

const settled = (row: Pick<Qualification, "status">) => row.status === "outcome" || row.status === "missing";

/**
 * The first three qualifying tasks in pool order. `determined` once no task before the third qualifier still needs a run; `final`
 * only when, in addition, every planned calibration unit is accounted for (an outcome or MISSING): the finite run list is complete.
 */
export function selectTasks(rows: readonly Qualification[], limit = 3): Pick<Selection, "selected" | "determined" | "final" | "pending" | "fewerThanThree"> {
  const ordered = [...rows].sort((a, b) => a.order - b.order);
  const selected: string[] = [];
  let determined = true;
  for (const row of ordered) {
    if (selected.length >= limit) break;
    if (!settled(row)) { determined = false; break; }
    if (row.qualifies) selected.push(row.task);
  }
  const open = ordered.filter(row => !settled(row));
  return {
    selected, determined, final: determined && open.length === 0, ...(open.length ? { pending: open.map(row => `${row.task}: ${row.note}`).join("; ") } : {}),
    ...(determined && selected.length < limit ? { fewerThanThree: selected.length ? `${selected.length} qualifying task(s): validated as preregistered (at most 3)` : "no qualifying task: H2 efficacy is UNRESOLVED (no measured headroom); the mechanism and control units still run" } : {}),
  };
}

export async function calibrationSelection(outInput: string, planFile: string): Promise<Selection> {
  const out = resolveOut(outInput);
  const plan = parsePlan(JSON.parse(readFileSync(planFile, "utf8")));
  const units = studyAttempts(out);
  const rows: Qualification[] = [];
  for (const [index, item] of plan.tasks.entries()) {
    const unit = units.find(entry => entry.task === item.task);
    if (!unit) { rows.push({ task: item.task, order: index + 1, unit: "-", status: "pending", note: "no unit in the manifests", qualifies: null, reasons: ["not run"] }); continue; }
    const base = { task: item.task, order: index + 1, unit: unit.unit, status: unit.status, note: unit.note };
    if (unit.status !== "outcome") { rows.push({ ...base, qualifies: unit.status === "missing" ? false : null, reasons: [unit.note] }); continue; }
    const facts = await calibrationFacts(unit.current!.dir);
    const verdict = qualify(facts);
    rows.push({
      ...base, qualifies: verdict.qualifies, checks: verdict.checks, ...(facts.terminal ? { terminal: facts.terminal } : {}), ...(facts.routeViolations !== null ? { routeViolations: facts.routeViolations } : {}),
      diffFiles: facts.diffFiles, ...(facts.decisive ? { decisive: facts.decisive } : {}), untouched: verdict.untouched,
      failToPass: { passed: typeof facts.failToPass?.passed === "boolean" ? facts.failToPass.passed as boolean : null, ...(facts.failToPass?.detail !== undefined ? { detail: clip(String(facts.failToPass.detail), 600) } : {}) },
      runner: { passed: typeof facts.runner?.passed === "boolean" ? facts.runner.passed as boolean : null, ...(facts.runner?.detail !== undefined ? { detail: clip(String(facts.runner.detail), 200) } : {}) },
      ...(facts.gradeError ? { gradeError: facts.gradeError } : {}), reasons: verdict.reasons,
    });
  }
  return { rule: "PREREGISTRATION.md Calibration + H2-A1 item 5 + H2-A2; the first three qualifying tasks in pool order", plan: planFile, out, tasks: rows, ...selectTasks(rows) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Validation: the decision rules

/** The exposed mechanism task and its TOML site; the passing controls (PREREGISTRATION.md "Validation units"). */
export const MECHANISM_TASK = "tox-dev__tox-3904";
export const TOML_SITE = "src/tox/config/loader/toml/_replace.py";
export const CONTROL_TASKS = ["stravalib__stravalib-709_interface", "tobymao__sqlglot-7187"] as const;

/** What the decision rules read from one validation unit. */
export interface UnitFacts {
  unit: string; task: string; arm: string; status: UnitAttempts["status"]; note: string;
  terminal?: string; primaryPass?: boolean; gradePassed?: boolean | null; integrityViolations?: string[];
  /** Mechanism (tox): the TOML site's best hand-off class, whether a refusal named it and the gate transferred it, whether the final diff touched it. */
  toml?: { reported: boolean; class?: string; gateTransferred: boolean; touched: boolean };
  /** The unit ended blocked or failed because of a hand-off refusal: its last candidates call was a hand-off refusal with no accepted call after it, or its last orche task's failure names the hand-off. */
  handoffEnding?: boolean; handoffRefusals?: number;
  requests?: number; costUSD?: number;
}

export function unitFactsOf(attempts: UnitAttempts, meta: any, chain: UnitChain | undefined, failure: string | undefined): UnitFacts {
  const base: UnitFacts = { unit: attempts.unit, task: attempts.task, arm: attempts.arm, status: attempts.status, note: attempts.note };
  if (attempts.status !== "outcome") return base;
  const candidates = chain?.candidates ?? [];
  const last = candidates.at(-1);
  const refusedLast = !!last && last.status === "refused" && HANDOFF_REFUSAL.test(last.message ?? "") && !candidates.slice(candidates.indexOf(last) + 1).some(isAccepted);
  const ended = meta?.terminal === "blocked" || meta?.terminal === "failed";
  const tomlFindings = (chain?.findings ?? []).filter(entry => entry.path === TOML_SITE);
  const rank = ["assigned", "reference", "excluded", "out-of-scope", "mention-only", "owned-only", "dropped"];
  const bestToml = tomlFindings.map(entry => entry.class).sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
  return {
    ...base, ...(typeof meta?.terminal === "string" ? { terminal: meta.terminal } : {}), primaryPass: meta?.primaryPass === true,
    gradePassed: chain ? chain.correctness.gradePassed : typeof meta?.grade?.passed === "boolean" ? meta.grade.passed : null,
    integrityViolations: (chain?.correctness.integrityViolations ?? meta?.integrity?.violations ?? []).map(String),
    ...(attempts.task === MECHANISM_TASK && chain ? { toml: { reported: tomlFindings.length > 0, ...(bestToml ? { class: bestToml } : {}), gateTransferred: tomlFindings.some(entry => entry.gateTransferred), touched: chain.implementation.diffFiles.includes(TOML_SITE) } } : {}),
    handoffEnding: ended && (refusedLast || (!!failure && /hand-off|handoff/i.test(failure))), handoffRefusals: chain?.chain.handoffRefusals ?? 0,
    ...(typeof meta?.wire?.requests === "number" ? { requests: meta.wire.requests } : {}), ...(typeof meta?.wire?.costUSD === "number" ? { costUSD: meta.wire.costUSD } : {}),
  };
}

export interface ArmCount { units: number; outcomes: number; missing: number; primary: number; terminalLoss: number; integrity: number; f2pOrGradePassed: number }
const countArm = (units: readonly UnitFacts[]): ArmCount => ({
  units: units.length, outcomes: units.filter(unit => unit.status === "outcome").length, missing: units.filter(unit => unit.status === "missing").length,
  primary: units.filter(unit => unit.primaryPass).length, terminalLoss: units.filter(unit => unit.status === "outcome" && unit.terminal !== "done").length,
  integrity: units.filter(unit => (unit.integrityViolations?.length ?? 0) > 0).length, f2pOrGradePassed: units.filter(unit => unit.gradePassed === true).length,
});

export interface Decision {
  final: boolean; pending: string[];
  /** The finite run list: 4k + 4 units for k selected tasks (F and H2 × 2 per headroom task, tox H2 × 2, each control H2 × 1). */
  completeness: { expected: number; found: number; absent: string[]; unexpected: string[] };
  efficacy: { result: "supported on these tasks" | "not demonstrated" | "inconclusive" | "unresolved"; tasks: string[]; F: ArmCount; H2: ArmCount; byTask: Record<string, { F: ArmCount; H2: ArmCount }>; reasons: string[] };
  mechanism: { shown: boolean; gateCaused: boolean; missing: number; units: { unit: string; status: string; reported: boolean; class?: string; touched: boolean; gradePassed: boolean | null; primaryPass: boolean; gateTransferred: boolean }[] };
  /** `unknown`: MISSING H2 control or headroom units, whose outcome could have raised the flag (a flag not raised is then incomplete). */
  regression: { flag: boolean; controlFailures: string[]; handoffEndings: string[]; moreIntegrityOnHeadroom: boolean; unknown: string[] };
  weakerGate: string;
}

/** The preregistered validation units for the selected tasks (PREREGISTRATION.md "Validation units"), as unit ids. */
export function expectedValidationUnits(selected: readonly string[]): string[] {
  return [
    ...selected.flatMap(task => ["F", "H2"].flatMap(arm => [1, 2].map(repeat => `${task}/${arm}/r${repeat}`))),
    `${MECHANISM_TASK}/H2/r1`, `${MECHANISM_TASK}/H2/r2`, ...CONTROL_TASKS.map(task => `${task}/H2/r1`),
  ];
}

/** The three efficacy conditions of PREREGISTRATION.md "Decision rules". */
const efficacyHolds = (h2Primary: number, fPrimary: number, h2Loss: number, fLoss: number, h2Integrity: number, fIntegrity: number) => h2Primary - fPrimary >= 2 && h2Loss <= fLoss && h2Integrity <= fIntegrity;

/**
 * PREREGISTRATION.md "Decision rules" on the validation units (pure: the facts are gathered by `validationDecision`). A MISSING unit
 * is not an outcome (H2-A2): "supported" must hold with every missing F unit counted as a primary pass and every missing H2 unit as a
 * terminal loss with an integrity violation; when only the opposite assumption would make it hold, the result is inconclusive.
 */
export function decisionRules(units: readonly UnitFacts[], selected: readonly string[]): Decision {
  const pending = units.filter(unit => unit.status === "rerun" || unit.status === "pending" || unit.status === "running").map(unit => `${unit.unit}: ${unit.note}`);
  const expected = expectedValidationUnits(selected);
  const ids = new Set(units.map(unit => unit.unit));
  const completeness = { expected: expected.length, found: ids.size, absent: expected.filter(id => !ids.has(id)), unexpected: [...ids].filter(id => !expected.includes(id)) };
  const headroom = units.filter(unit => selected.includes(unit.task));
  const arm = (name: string, list: readonly UnitFacts[]) => list.filter(unit => unit.arm === name);
  const F = countArm(arm("F", headroom)), H2 = countArm(arm("H2", headroom));
  const byTask = Object.fromEntries(selected.map(task => [task, { F: countArm(arm("F", headroom.filter(unit => unit.task === task))), H2: countArm(arm("H2", headroom.filter(unit => unit.task === task))) }]));
  const reasons: string[] = [];
  let result: Decision["efficacy"]["result"];
  if (!selected.length) { result = "unresolved"; reasons.push("no headroom task qualified in calibration"); }
  else {
    const gain = H2.primary - F.primary;
    reasons.push(`primary passes H2 ${H2.primary} vs F ${F.primary} (difference ${gain}; at least 2 needed)`, `terminal loss H2 ${H2.terminalLoss} vs F ${F.terminalLoss} (H2 must not be higher)`, `integrity violations H2 ${H2.integrity} vs F ${F.integrity} (H2 must not have more)`);
    if (F.missing || H2.missing) reasons.push(`missing units (not outcomes, H2-A2): F ${F.missing}, H2 ${H2.missing}; "supported" must hold with each missing F unit a primary pass and each missing H2 unit a terminal loss with an integrity violation`);
    const robust = efficacyHolds(H2.primary, F.primary + F.missing, H2.terminalLoss + H2.missing, F.terminalLoss, H2.integrity + H2.missing, F.integrity);
    const possible = efficacyHolds(H2.primary + H2.missing, F.primary, H2.terminalLoss, F.terminalLoss + F.missing, H2.integrity, F.integrity + F.missing);
    result = robust ? "supported on these tasks" : possible ? "inconclusive" : "not demonstrated";
  }
  const tox = units.filter(unit => unit.task === MECHANISM_TASK && unit.arm === "H2");
  const mechanismUnits = tox.map(unit => ({ unit: unit.unit, status: unit.status, reported: unit.toml?.reported ?? false, ...(unit.toml?.class ? { class: unit.toml.class } : {}), touched: unit.toml?.touched ?? false, gradePassed: unit.gradePassed ?? null, primaryPass: unit.primaryPass === true, gateTransferred: unit.toml?.gateTransferred ?? false }));
  const shownUnits = mechanismUnits.filter(unit => unit.status === "outcome" && unit.class === "assigned" && unit.touched && unit.gradePassed === true);
  const controlFailures = units.filter(unit => (CONTROL_TASKS as readonly string[]).includes(unit.task) && unit.arm === "H2" && unit.status === "outcome" && !unit.primaryPass).map(unit => unit.unit);
  const handoffEndings = units.filter(unit => unit.arm === "H2" && unit.handoffEnding).map(unit => unit.unit);
  const moreIntegrityOnHeadroom = selected.length > 0 && H2.integrity > F.integrity;
  const unknown = units.filter(unit => unit.arm === "H2" && unit.status === "missing" && ((CONTROL_TASKS as readonly string[]).includes(unit.task) || selected.includes(unit.task))).map(unit => unit.unit);
  return {
    final: pending.length === 0 && completeness.absent.length === 0 && completeness.unexpected.length === 0, pending, completeness,
    efficacy: { result, tasks: [...selected], F, H2, byTask, reasons },
    mechanism: { shown: shownUnits.length > 0, gateCaused: shownUnits.some(unit => unit.gateTransferred), missing: tox.filter(unit => unit.status === "missing").length, units: mechanismUnits },
    regression: { flag: controlFailures.length > 0 || handoffEndings.length > 0 || moreIntegrityOnHeadroom, controlFailures, handoffEndings, moreIntegrityOnHeadroom, unknown },
    weakerGate: "not computed here: results/ultra-ho/stage3-r2/runtime-diff-vs-fixed.patch is checked by hand (it may only add refusal conditions and dispositions)",
  };
}

export async function validationDecision(outInput: string, selectionFile: string): Promise<{ out: string; selection: string; units: UnitFacts[]; decision: Decision }> {
  const out = resolveOut(outInput);
  const selected: string[] = readJson(selectionFile)?.selected ?? [];
  const units: UnitFacts[] = [];
  for (const attempts of studyAttempts(out)) {
    if (attempts.status !== "outcome") { units.push(unitFactsOf(attempts, undefined, undefined, undefined)); continue; }
    const dir = attempts.current!.dir;
    const meta = readJson(join(dir, "meta.json"));
    let chain: UnitChain | undefined;
    try { chain = await unitChain(dir); } catch { chain = undefined; }
    units.push(unitFactsOf(attempts, meta, chain, lastTaskFailure(dir, meta)));
  }
  return { out, selection: selectionFile, units, decision: decisionRules(units, selected) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Requests, routes and list-price cost of every attempt (current and kept), from the wire logs

export interface AttemptCost { attempt: string; class: AttemptClass; requests: number; ok: number; providerErrors: number; capacityErrors: number; offRoute: number; unpriced: number; costUSD: number }
export interface CostTotals { attempts: number; requests: number; ok: number; providerErrors: number; capacityErrors: number; offRoute: number; unpriced: number; costUSD: number }

/** One attempt's model requests: off-route means a model other than gpt-6.1-sol, an effort other than high, or another response model. */
export function attemptCost(dir: string, kind: AttemptClass, label: string): AttemptCost {
  const posts = readJsonl<any>(join(dir, "wire.jsonl")).filter(entry => entry?.method === "POST" && entry.model);
  const offRoute = posts.filter(entry => entry.model !== "gpt-6.1-sol" || entry.effort !== "high" || (entry.respModel !== undefined && entry.respModel !== "gpt-6.1-sol")).length;
  const priced = posts.filter(entry => typeof entry.costUSD === "number");
  return {
    attempt: label, class: kind, requests: posts.length, ok: posts.filter(entry => entry.status === 200 && !entry.providerError).length, providerErrors: posts.filter(entry => entry.providerError).length,
    capacityErrors: posts.filter(isCapacityError).length, offRoute, unpriced: posts.length - priced.length, costUSD: Math.round(priced.reduce((sum, entry) => sum + entry.costUSD, 0) * 1e6) / 1e6,
  };
}

/** Every attempt directory under `out`/runs (any manifest), grouped by its H2-A2 class, with totals. */
export function studyCosts(outInput: string): { out: string; attempts: AttemptCost[]; byClass: Record<string, CostTotals>; total: CostTotals } {
  const out = resolveOut(outInput);
  const attempts = studyAttempts(out).flatMap(unit => unit.attempts.map(item => attemptCost(item.dir, item.class, `${unit.unit.split("/").slice(0, 2).join("/")}/${item.name}`)));
  const empty = (): CostTotals => ({ attempts: 0, requests: 0, ok: 0, providerErrors: 0, capacityErrors: 0, offRoute: 0, unpriced: 0, costUSD: 0 });
  const add = (total: CostTotals, item: AttemptCost) => { total.attempts++; for (const key of ["requests", "ok", "providerErrors", "capacityErrors", "offRoute", "unpriced"] as const) total[key] += item[key]; total.costUSD = Math.round((total.costUSD + item.costUSD) * 1e6) / 1e6; };
  const byClass: Record<string, CostTotals> = {};
  const total = empty();
  for (const item of attempts) { add(byClass[item.class] ??= empty(), item); add(total, item); }
  return { out, attempts, byClass, total };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Grounding audit (descriptive, not a decision rule): what each H2 `reference`/`excluded` disposition's cited check really was

/** A bash command that only lists files (names paths without reading them). */
const LISTING = /\bgit\s+ls-files\b|(^|[;&|(]\s*)(ls|find|stat|wc|du|realpath|readlink|file)\b|\btest\s+-[efd]\b|\bgit\s+(status|diff\s+--name-only|diff\s+--stat)\b/;
/** A bash command that reads or runs file content. */
const CONTENT = /\b(cat|sed|head|tail|grep|rg|awk|nl|less|python3?|pytest|uv|ruff|mypy|pyright|node|npm|npx|tox|make|go|cargo)\b|\bgit\s+(diff(?!\s+--name-only|\s+--stat)|show|blame|log\s+-p)\b/;

export type CitedKind = "content" | "listing" | "unrelated" | "unresolved";
export interface CitedCheck { ref: string; tool?: string; at?: string; ok?: boolean; afterRound?: boolean; namesPath?: boolean; kind: CitedKind; detail?: string }
export interface GroundingEntry {
  unit: string; orchestrator: string; at?: string; path: string; exploration?: number; disposition: "reference" | "excluded"; decisive: boolean; reason?: string;
  cited: CitedCheck[]; verdict: "content check" | "listing only" | "unverified"; sharedRefs: number;
}

interface CallRecord { tool: string; args: any; text: string; isError: boolean; at?: number }

/** Classifies one cited call for one path: a read of the file, or a command that names it and reads or runs content, is a content check. */
export function citedKind(call: Pick<CallRecord, "tool" | "args" | "text">, path: string): { kind: CitedKind; namesPath: boolean } {
  const argText = JSON.stringify(call.args ?? {});
  const names = (text: string) => text.includes(path);
  const namesPath = names(argText) || names(call.text);
  if (!namesPath) return { kind: "unrelated", namesPath };
  if (call.tool === "read") return { kind: typeof call.args?.path === "string" && (call.args.path === path || call.args.path.endsWith(`/${path}`)) ? "content" : "unrelated", namesPath };
  if (call.tool === "bash") {
    const command = String(call.args?.command ?? "");
    if (!names(command)) return { kind: "unrelated", namesPath };
    return { kind: CONTENT.test(command) ? "content" : LISTING.test(command) ? "listing" : "content", namesPath };
  }
  if (call.tool === "grep" || call.tool === "ast_search" || call.tool === "lsp" || call.tool === "diagnostics") return { kind: names(argText) ? "content" : "listing", namesPath };
  if (call.tool === "find" || call.tool === "ls") return { kind: "listing", namesPath };
  return { kind: "content", namesPath };
}

/** The orchestrators' transcripts of a unit: every tool call with its result and `[orche ref Tn]`, and each candidates call's ref table at that point. */
function orchestratorCalls(dir: string): Map<string, { candidates: { at?: number; refs: Map<string, CallRecord> }[] }> {
  const byAgent = new Map<string, { candidates: { at?: number; refs: Map<string, CallRecord> }[] }>();
  const roots = existsSync(join(dir, "records")) ? readdirSync(join(dir, "records")).map(name => join(dir, "records", name, "workers")).filter(path => existsSync(path)) : [];
  for (const root of roots) for (const name of readdirSync(root).filter(item => /^W\d+-.*\.jsonl$/.test(item)).sort()) {
    const agent = name.split("-")[0]!;
    const entry = byAgent.get(agent) ?? { candidates: [] };
    byAgent.set(agent, entry);
    const pending = new Map<string, { tool: string; args: any; at?: number }>();
    const refs = new Map<string, CallRecord>();
    for (const line of readJsonl<any>(join(root, name))) {
      if (line?.type !== "message") continue;
      const message = line.message ?? {};
      const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : undefined;
      if (message.role === "assistant") for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== "toolCall") continue;
        pending.set(String(part.id), { tool: String(part.name), args: part.arguments, ...(at !== undefined ? { at } : {}) });
        if (part.name === "orche_spawn" && part.arguments?.reason === "candidates") entry.candidates.push({ ...(at !== undefined ? { at } : {}), refs: new Map(refs) });
      }
      if (message.role === "toolResult") {
        const call = pending.get(String(message.toolCallId));
        const text = (Array.isArray(message.content) ? message.content : []).map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
        for (const match of text.matchAll(/\[orche ref (T\d+)\]/g)) refs.set(match[1]!, { tool: call?.tool ?? String(message.toolName ?? ""), args: call?.args, text, isError: message.isError === true, ...(call?.at !== undefined ? { at: call.at } : {}) });
      }
    }
  }
  return byAgent;
}

/** The audit of one unit: each accepted call's `reference`/`excluded` dispositions (runtime handoff events) against the cited calls. */
export function groundingOf(dir: string, unit: string, decisive: ReadonlySet<string>): GroundingEntry[] {
  const events = existsSync(join(dir, "records")) ? readdirSync(join(dir, "records")).flatMap(session => {
    const root = join(dir, "records", session);
    return existsSync(root) && !session.endsWith(".jsonl") ? readdirSync(root).filter(item => existsSync(join(root, item, "events.jsonl"))).flatMap(item => readJsonl<any>(join(root, item, "events.jsonl"))) : [];
  }) : [];
  const handoff = events.filter(event => event?.type === "ultra" && event.stage === "handoff");
  const roundEnd = new Map<string, number>();
  for (const event of handoff) if (typeof event.exploration === "number" && Array.isArray(event.findings)) roundEnd.set(`${event.worker} ${event.exploration}`, Number(event.timestamp));
  const calls = orchestratorCalls(dir);
  const out: GroundingEntry[] = [];
  for (const event of handoff.filter(item => Array.isArray(item.dispositions))) {
    const at = Number(event.timestamp);
    const snapshot = [...(calls.get(String(event.worker))?.candidates ?? [])].filter(item => (item.at ?? 0) <= at + 1000).at(-1);
    const entries = (event.dispositions as any[]).filter(item => item?.disposition === "reference" || item?.disposition === "excluded");
    for (const item of entries) {
      const path = String(item.path);
      const evidence: string[] = (Array.isArray(item.evidence) ? item.evidence : [item.evidence]).filter((ref: unknown) => typeof ref === "string").flatMap((ref: string) => [...ref.matchAll(/T\d+/g)].map(match => match[0]));
      const end = roundEnd.get(`${event.worker} ${item.exploration}`);
      const cited = evidence.map((ref): CitedCheck => {
        const call = snapshot?.refs.get(ref);
        if (!call) return { ref, kind: "unresolved" };
        const { kind, namesPath } = citedKind(call, path);
        return { ref, tool: call.tool, ...(call.at !== undefined ? { at: new Date(call.at).toISOString() } : {}), ok: !call.isError, ...(end !== undefined && call.at !== undefined ? { afterRound: call.at >= end } : {}), namesPath, kind, detail: clip(call.tool === "bash" ? String(call.args?.command ?? "") : JSON.stringify(call.args ?? {}), 160) };
      });
      const valid = cited.filter(check => check.ok && check.afterRound !== false);
      const verdict = valid.some(check => check.kind === "content") ? "content check" : valid.length && valid.every(check => check.kind === "listing" || check.kind === "unrelated") && valid.some(check => check.kind === "listing") ? "listing only" : "unverified";
      const sharedRefs = entries.filter(other => other !== item && (Array.isArray(other.evidence) ? other.evidence : [other.evidence]).some((ref: unknown) => typeof ref === "string" && evidence.some(own => ref.includes(own)))).length;
      out.push({ unit, orchestrator: String(event.worker), ...(Number.isFinite(at) ? { at: new Date(at).toISOString() } : {}), path, ...(typeof item.exploration === "number" ? { exploration: item.exploration } : {}), disposition: item.disposition, decisive: decisive.has(path), ...(typeof item.reason === "string" ? { reason: clip(item.reason, 200) } : {}), cited, verdict, sharedRefs });
    }
  }
  return out;
}

export async function studyGrounding(outInput: string): Promise<GroundingEntry[]> {
  const out = resolveOut(outInput);
  const entries: GroundingEntry[] = [];
  for (const unit of studyAttempts(out).filter(item => item.status === "outcome")) {
    const dir = unit.current!.dir;
    let decisive = new Set<string>();
    try { const reference = referenceOf(await unitTask(readJson(join(dir, "meta.json")))); decisive = new Set((reference?.files ?? []).filter(file => file.kind === "source").map(file => file.path)); } catch { /* no reference: nothing decisive */ }
    entries.push(...groundingOf(dir, unit.unit, decisive));
  }
  return entries;
}

export function formatGrounding(entries: readonly GroundingEntry[]): string {
  const lines = ["# Stage 3 round 2: grounding audit of H2 reference/excluded dispositions (descriptive)", "",
    "Each disposition's cited [orche ref Tn] resolved in the orchestrator's transcript (the ref table at its candidates call). content check: a successful",
    "call after the finding's exploration round that reads the file or runs a command naming it that reads or runs content; listing only: every valid cited",
    "call only lists files (git ls-files, ls, find, stat ...); unverified: otherwise. Not a decision rule of PREREGISTRATION.md.", "",
    "| unit | path | decisive | disposition | reason | cited | verdict | entries sharing a ref |", "|---|---|---|---|---|---|---|---|"];
  for (const entry of entries) lines.push(`| ${entry.unit} | ${entry.path} | ${yes(entry.decisive)} | ${entry.disposition} | ${(entry.reason ?? "").replace(/\|/g, "/")} | ${entry.cited.map(check => `${check.ref} ${check.tool ?? "?"} ${check.kind}${check.ok === false ? " (failed)" : ""}${check.afterRound === false ? " (before the round)" : ""}`).join("; ") || "none"} | ${entry.verdict} | ${entry.sharedRefs} |`);
  const count = (verdict: GroundingEntry["verdict"], decisiveOnly = false) => entries.filter(entry => entry.verdict === verdict && (!decisiveOnly || entry.decisive)).length;
  lines.push("", `Totals: ${entries.length} dispositions; content check ${count("content check")}, listing only ${count("listing only")}, unverified ${count("unverified")}. Decisive files: ${entries.filter(entry => entry.decisive).length} (content check ${count("content check", true)}, listing only ${count("listing only", true)}, unverified ${count("unverified", true)}).`);
  return `${lines.join("\n")}\n`;
}


// ---------------------------------------------------------------------------------------------------------------------------
// Text

const yes = (value: boolean | null | undefined) => value === true ? "yes" : value === false ? "no" : "–";

export function formatSelection(selection: Selection): string {
  const lines = [`# Stage 3 round 2 calibration: qualification and selection`, "", `Rule: ${selection.rule}. Plan: \`${selection.plan}\`.`, "",
    "| order | task | H2-A2 status | terminal | route ok | artifact | F2P fails | decisive untouched | qualifies | reasons |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const row of selection.tasks) lines.push(`| ${row.order} | ${row.task} | ${row.status} | ${row.terminal ?? "–"} | ${yes(row.checks?.routeCompliant)} | ${row.checks ? `${yes(row.checks.artifact)} (${row.diffFiles?.length ?? 0} files)` : "–"} | ${yes(row.checks?.f2pFails)} | ${row.untouched?.length ? row.untouched.join(", ") : row.checks ? "none" : "–"} | ${yes(row.qualifies)} | ${row.reasons.join("; ")} |`);
  lines.push("", `Selected (pool order): ${selection.selected.length ? selection.selected.join(", ") : "none"}. Determined: ${yes(selection.determined)}. Final (every planned unit accounted for): ${selection.final ? "yes" : `no (${selection.pending})`}.${selection.fewerThanThree ? ` ${selection.fewerThanThree}.` : ""}`);
  return `${lines.join("\n")}\n`;
}

export function formatDecision(result: { units: UnitFacts[]; decision: Decision }): string {
  const { decision } = result;
  const count = (value: ArmCount) => `${value.primary}/${value.units} primary, terminal loss ${value.terminalLoss}, integrity ${value.integrity}, missing ${value.missing}`;
  const lines = ["# Stage 3 round 2 validation: decision rules", "", `Final: ${decision.final ? "yes" : `no (${[...decision.pending, ...decision.completeness.absent.map(id => `${id}: absent from the manifests`), ...decision.completeness.unexpected.map(id => `${id}: not preregistered`)].join("; ")})`}. Units: ${decision.completeness.found} of ${decision.completeness.expected} preregistered.`, "",
    `## Efficacy on the headroom tasks: ${decision.efficacy.result}`, "", `Tasks: ${decision.efficacy.tasks.join(", ") || "none"}.`, "", `- F: ${count(decision.efficacy.F)}`, `- H2: ${count(decision.efficacy.H2)}`,
    ...Object.entries(decision.efficacy.byTask).map(([task, value]) => `- ${task}: F ${count(value.F)}; H2 ${count(value.H2)}`), ...decision.efficacy.reasons.map(reason => `- ${reason}`), "",
    `## Mechanism (${MECHANISM_TASK}, ${TOML_SITE}): ${decision.mechanism.shown ? "shown" : "not shown"}${decision.mechanism.shown ? `, gate-caused: ${yes(decision.mechanism.gateCaused)}` : ""}`, "",
    ...decision.mechanism.units.map(unit => `- ${unit.unit}: ${unit.status}; reported ${yes(unit.reported)}, class ${unit.class ?? "–"}, touched ${yes(unit.touched)}, grade ${yes(unit.gradePassed)}, primary ${yes(unit.primaryPass)}, gate-transferred ${yes(unit.gateTransferred)}`), ...(decision.mechanism.missing ? [`- missing tox units: ${decision.mechanism.missing}`] : []), "",
    `## Regression flag: ${decision.regression.flag ? "RAISED" : "not raised"}`, "", `- control failures under H2: ${decision.regression.controlFailures.join(", ") || "none"}`,
    `- H2 units ended blocked/failed because of a hand-off refusal: ${decision.regression.handoffEndings.join(", ") || "none"}`, `- more integrity violations under H2 on the headroom tasks: ${yes(decision.regression.moreIntegrityOnHeadroom)}`,
    ...(decision.regression.unknown.length ? [`- incomplete: MISSING H2 units whose outcome could raise the flag: ${decision.regression.unknown.join(", ")}`] : []), "",
    `Weaker gate: ${decision.weakerGate}.`, "", "## Units", "", "| unit | status | terminal | grade | primary | integrity | hand-off refusals | hand-off ending | requests | USD |", "|---|---|---|---|---|---|---|---|---|---|",
    ...result.units.map(unit => `| ${unit.unit} | ${unit.status} | ${unit.terminal ?? "–"} | ${yes(unit.gradePassed)} | ${yes(unit.primaryPass)} | ${unit.integrityViolations?.length ?? "–"} | ${unit.handoffRefusals ?? "–"} | ${yes(unit.handoffEnding)} | ${unit.requests ?? "–"} | ${unit.costUSD ?? "–"} |`)];
  return `${lines.join("\n")}\n`;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const write = rest.includes("--write");
  const args = rest.filter(item => item !== "--write");
  if (command === "attempts" && args[0]) {
    const units = studyAttempts(args[0]);
    console.log(JSON.stringify({ units: units.map(unit => ({ unit: unit.unit, status: unit.status, note: unit.note, capacityStops: unit.capacityStops, attempts: unit.attempts.map(item => ({ name: item.name, class: item.class, terminal: item.terminal, requests: item.requests, costUSD: item.costUSD, reason: item.reason })) })), rerun: units.filter(unit => unit.status === "rerun").map(unit => unit.unit).join(",") }, null, 2));
    return 0;
  }
  if (command === "select" && args[0] && args[1]) {
    const selection = await calibrationSelection(args[0], args[1]);
    if (write && !selection.final) { console.error(`selection not final (${selection.pending}); nothing written`); return 1; }
    if (write) { await writeFile(join(selection.out, "selection.json"), `${JSON.stringify(selection, null, 2)}\n`); await writeFile(join(selection.out, "selection.md"), formatSelection(selection)); }
    console.log(formatSelection(selection));
    return 0;
  }
  if (command === "decide" && args[0] && args[1]) {
    const result = await validationDecision(args[0], args[1]);
    if (write) { await writeFile(join(result.out, "decision.json"), `${JSON.stringify(result, null, 2)}\n`); await writeFile(join(result.out, "decision.md"), formatDecision(result)); }
    console.log(formatDecision(result));
    return 0;
  }
  if (command === "grounding" && args[0]) {
    const entries = await studyGrounding(args[0]);
    if (write) { const out = resolveOut(args[0]); await writeFile(join(out, "grounding.json"), `${JSON.stringify(entries, null, 2)}\n`); await writeFile(join(out, "grounding.md"), formatGrounding(entries)); }
    console.log(formatGrounding(entries));
    return 0;
  }
  if (command === "costs" && args.length) {
    const results = args.map(studyCosts);
    console.log(JSON.stringify(results.map(item => ({ out: item.out, total: item.total, byClass: item.byClass, attempts: item.attempts })), null, 2));
    return results.some(item => item.total.offRoute > 0) ? 1 : 0;
  }
  console.error("usage: r2.ts attempts <out> | select <calibration out> <plan.json> [--write] | decide <validation out> <selection.json> [--write] | costs <out>...");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
