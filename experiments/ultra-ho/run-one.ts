/**
 * One unit of an ultra-ho plan, in its own process started by driver.ts: a fresh workspace from the task's visible snapshot (no
 * commit), a private agent dir (this harness's pinned config), its own pricing proxy, the real Pi CLI in JSON mode running the
 * FROZEN orche runtime with the one-shot `/orche ultra|strong <prompt>`, then the evidence: records, sessions, events, wire and
 * totals, wire fidelity, orche tasks (assignments, carry, gates, adoptions), final diff, workspace-final, the independent grade and
 * integrity (ultra-ab gradeWorkspace), terminal status and primary pass. Secrets are redacted; meta.json says completed last.
 *
 *   node --import tsx experiments/ultra-ho/run-one.ts <input.json>
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeWorkspace } from "../ultra-ab/env.js";
import { SWE_CACHE } from "../advisor-reviewer/tasks.js";
import { leakHits, sessionToolCalls } from "../ultra-ab/protocol.js";
import { finalText, jsonlFiles, readJsonl, redactTree, taskRecords } from "../ultra-ab/run-one.js";
import { PI_CLI, catalogInfo, commitsOf, finalDiff, loadTask, overlay, piArgs, piEnv, prepareWorkspace, preserveWorkspace, pythonWrappers, sha256, startProxy, upstream, verifyRuntime, type Task } from "./env.js";
import { assignmentLine, assignments, sessionMap } from "./evidence.js";
import { COLLECT_GUARD_MS, MODEL, MODEL_REF, THINKING, classifyWire, oneShot, orcheConfig, piSettings, primaryPass, terminalOf, type ArmSpec, type WireEntry } from "./protocol.js";

export interface RunInput {
  /** The unit's directory (results). */
  out: string;
  unit: string;
  task: string;
  arm: ArmSpec;
  runtime: { name: string; dir: string; digest: string };
  provider: { dir: string; digest: string; version?: string };
  limits: Record<string, number>;
  piGuardMs: number;
  /** This attempt's scratch directory (workspace, agent dir, sessions, TMPDIR); removed afterwards. */
  temp: string;
  attempt: number;
  /** The driver: when it is gone, this unit stops its Pi process group (children stop with the driver). */
  driverPid?: number;
  harness?: string;
  /** The plan's SWE fixture root and the cache its environments were staged from (driver.ts sweRoots), absolute: recorded in meta.json. */
  sweFixtures?: string;
  sweCacheSource?: string;
}

const now = () => Date.now();
const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** Run a command in its own process group with a hard guard (ultra-ab run-one.ts runGuarded, plus `onSpawn` with the group's pid). */
export function runGuarded(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string; guardMs: number; onSpawn?: (pid: number) => void }): Promise<{ code: number | null; signal: NodeJS.Signals | null; guardFired: boolean; ms: number; pid?: number }> {
  return new Promise(resolve => {
    const started = now();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let guardFired = false;
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* gone */ } };
    // If this runner is stopped, its process group (pi and the agents' shells) goes with it.
    const onStop = () => { kill("SIGKILL"); process.exit(143); };
    process.once("SIGTERM", onStop); process.once("SIGINT", onStop);
    if (child.pid) options.onSpawn?.(child.pid);
    const timer = setTimeout(() => { guardFired = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10_000).unref(); }, options.guardMs);
    let chain = Promise.resolve();
    child.stdout!.on("data", chunk => { chain = chain.then(() => appendFile(options.stdout, chunk)); });
    child.stderr!.on("data", chunk => { chain = chain.then(() => appendFile(options.stderr, chunk)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGTERM", onStop); process.off("SIGINT", onStop);
      kill("SIGKILL"); // leftovers of the group (background shells of the agents)
      void chain.then(() => resolve({ code, signal, guardFired, ms: now() - started, ...(child.pid ? { pid: child.pid } : {}) }));
    });
    child.once("error", error => { clearTimeout(timer); process.off("SIGTERM", onStop); process.off("SIGINT", onStop); void appendFile(options.stderr, `spawn error: ${String(error)}\n`).then(() => resolve({ code: -1, signal: null, guardFired, ms: now() - started })); });
  });
}

/** Copy the workspace's .orche/artifacts (full texts of spilled tool results, e.g. main's orche_task results); files up to 16 MiB. */
async function preserveArtifacts(workspace: string, target: string): Promise<number> {
  const dir = join(workspace, ".orche/artifacts");
  if (!existsSync(dir)) return 0;
  let copied = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    try { if (statSync(path).size > 16 * 1024 * 1024) continue; } catch { continue; }
    await mkdir(target, { recursive: true });
    await copyFile(path, join(target, entry.name)); copied++;
  }
  return copied;
}

/** fidelity.json and meta.wire / meta.routeViolations from the unit's wire log and recorded sessions. */
async function deriveFidelity(out: string, meta: any): Promise<ReturnType<typeof classifyWire>> {
  const wire = readJsonl<WireEntry>(join(out, "wire.jsonl"));
  const sessions = meta.sessionId ? sessionMap(out, meta.sessionId) : new Map();
  const fidelity = classifyWire(wire, sessions);
  await write(join(out, "fidelity.json"), { sessions: Object.fromEntries([...sessions].map(([key, info]) => [key, info])), ...fidelity });
  meta.wire = {
    requests: fidelity.requests, ok: fidelity.ok, costUSD: fidelity.costUSD, routeViolations: fidelity.violations.length, unattributed: fidelity.unattributed.length,
    providerErrors: fidelity.providerErrors.length, upgradesRefused: fidelity.upgradesRefused, efforts: fidelity.efforts, updateEfforts: fidelity.updateEfforts, models: fidelity.models, respModels: fidelity.respModels,
    byRole: Object.fromEntries(Object.entries(fidelity.byRole).map(([role, usage]) => [role, { requests: usage.requests, costUSD: usage.costUSD, input: usage.input, cached: usage.cached, output: usage.output, reasoning: usage.reasoning, unpriced: usage.unpriced, unknownUsage: usage.unknownUsage }])),
    bySession: Object.fromEntries(Object.entries(fidelity.bySession).map(([agent, usage]) => [agent, { role: usage.role, requests: usage.requests, costUSD: usage.costUSD }])),
  };
  meta.routeViolations = fidelity.violations.slice(0, 200);
  return fidelity;
}

/** tasks.json and meta.orcheTasks from main's session, the records and the worker transcripts. */
async function deriveTasks(out: string, meta: any): Promise<void> {
  if (!meta.sessionId) return;
  try {
    const items = assignments(out, meta.sessionId);
    await write(join(out, "tasks.json"), items);
    meta.orcheTasks = items.map(item => ({
      index: item.index, worker: item.worker, task: item.task, assignment: item.assignment, passedTask: item.passedTask, requested: item.requested, carried: item.carried, carriedLine: item.carriedLine, carriedCandidates: item.carriedCandidates,
      status: item.status, stage: item.ultra?.stage, gate: item.gate.result, adoptions: item.adoptions.map(adoption => ({ candidate: adoption.candidate, check: adoption.check?.ref })),
      carriedAdoptions: item.carriedAdoptions.map(adoption => ({ candidate: adoption.candidate, freshChecks: adoption.freshChecks.map(check => check.ref) })),
      stageClaims: [...item.stageClaims.report, ...item.stageClaims.line], line: assignmentLine(item),
    }));
    delete meta.orcheTasksError;
  } catch (error) { meta.orcheTasksError = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000); }
}

/**
 * Re-derive the evidence of a completed unit from what it preserved (wire log, sessions, records, artifacts): fidelity.json, tasks.json
 * and their meta.json fields; no model, no rerun, the outcome (terminal, grade) untouched. The as-collected files are kept once as
 * `*.collected.json`, and meta.reextracted says when and with which harness.
 */
export async function reextract(dir: string, harness?: string): Promise<{ unit: string; violations: number; tasks: number }> {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  if (meta.status !== "completed" || !meta.sessionId) throw new Error(`${dir}: not a completed unit with a Pi session`);
  for (const name of ["tasks.json", "fidelity.json"]) {
    const kept = join(dir, name.replace(/\.json$/, ".collected.json"));
    if (existsSync(join(dir, name)) && !existsSync(kept)) await copyFile(join(dir, name), kept);
  }
  const fidelity = await deriveFidelity(dir, meta);
  await deriveTasks(dir, meta);
  meta.reextracted = [...(Array.isArray(meta.reextracted) ? meta.reextracted : []), { at: new Date().toISOString(), ...(harness ? { harness } : {}) }];
  await writeFile(join(dir, "meta.json.tmp"), `${JSON.stringify(meta, null, 2)}\n`);
  await rename(join(dir, "meta.json.tmp"), join(dir, "meta.json"));
  return { unit: String(meta.unit), violations: fidelity.violations.length, tasks: meta.orcheTasks?.length ?? 0 };
}

/** Collect the run's evidence, wire fidelity, orche tasks, terminal status and grade into `meta` and the unit directory. */
export async function collect(input: RunInput, task: Task | undefined, workspace: { dir: string; tree: string } | undefined, paths: { agentDir: string; sessionDir: string }, meta: any): Promise<void> {
  const { out } = input;
  await cp(join(paths.agentDir, "orche/records"), join(out, "records"), { recursive: true }).catch(() => undefined);
  await cp(paths.sessionDir, join(out, "sessions"), { recursive: true }).catch(() => undefined);
  if (workspace) {
    meta.mainArtifacts = await preserveArtifacts(workspace.dir, join(out, "main-artifacts")).catch(error => `failed: ${String(error).slice(0, 300)}`);
    try {
      const result = finalDiff(workspace.dir, workspace.tree, input.temp);
      await writeFile(join(out, "final.diff"), result.diff);
      meta.finalTree = result.tree;
      meta.diffStat = result.stat.slice(-4000);
      meta.changedFiles = result.files.slice(0, 200);
    } catch (error) { meta.diffError = String(error).slice(0, 1000); }
    meta.commits = commitsOf(workspace.dir);
    await preserveWorkspace(workspace.dir, join(out, "workspace-final")).catch(error => { meta.preservationError = String(error).slice(0, 1000); });
  }

  // Wire: every request of the Pi process (main, orche workers, sub-workers, helpers) by its prompt_cache_key's session.
  const fidelity = await deriveFidelity(out, meta);
  if (existsSync(join(out, "wire.jsonl.totals.json"))) { try { meta.proxyTotals = JSON.parse(readFileSync(join(out, "wire.jsonl.totals.json"), "utf8")); } catch { /* partial */ } }
  // orche tasks: what main asked, what came back, what the records show.
  await deriveTasks(out, meta);
  const records = taskRecords(join(out, "records"));
  meta.tasks = records;
  if (!meta.infra && fidelity.ok === 0) meta.infra = `no successful model request (pi exit ${meta.pi?.code ?? "none"}${meta.pi?.signal ? ` ${meta.pi.signal}` : ""})`;
  meta.terminal = terminalOf({ guardFired: !!meta.pi?.guardFired, taskStatuses: records.map(record => record.status), ...(meta.infra ? { infra: meta.infra } : {}) });
  meta.finalText = finalText(join(out, "events.jsonl")).slice(-6000);
  const leaks: string[] = [];
  let toolCalls = 0;
  for (const file of [...jsonlFiles(join(out, "records")), ...jsonlFiles(join(out, "sessions"))]) {
    const calls = sessionToolCalls(await readFile(file, "utf8"));
    toolCalls += calls.length;
    leaks.push(...leakHits(calls).map(hit => `${file.slice(out.length + 1)}: ${hit}`));
  }
  meta.toolCalls = toolCalls;
  meta.leakAudit = { hits: leaks.slice(0, 100), count: leaks.length };

  // The independent grade (never any model): ultra-ab's grader on the preserved final workspace.
  if (task) {
    const started = now();
    const finalWorkspace = join(out, "workspace-final");
    const { grade, integrity } = existsSync(finalWorkspace) ? await gradeWorkspace(task, finalWorkspace) : { grade: { passed: false, error: "no final workspace", checks: {} }, integrity: { violations: [], suspicious: [] } };
    await write(join(out, "grade.json"), { grade, integrity, gradedAt: new Date().toISOString(), ms: now() - started });
    meta.grade = { passed: grade.passed, ...(grade.error ? { error: grade.error } : {}), checks: Object.fromEntries(Object.entries(grade.checks).map(([name, check]) => [name, check.passed])) };
    meta.integrity = integrity;
    meta.primaryPass = primaryPass({ terminal: meta.terminal, ...(grade.error ? {} : { gradePassed: grade.passed }), integrity });
  } else meta.primaryPass = false;
}

/**
 * Where a unit's task came from, for its meta.json: the fixture root it was read from (the plan's, else the canonical one) and, for a
 * SWE task, the cache its environment was staged from and the staged copy it runs on. Throws when a SWE task was not read from the
 * plan's fixture root (`input.sweFixtures`): the unit would run another task than planned.
 */
export function fixtureEvidence(task: Pick<Task, "id" | "kind" | "dir">, input: Pick<RunInput, "sweFixtures" | "sweCacheSource">, sweCache = SWE_CACHE): { fixtureRoot: string; sweCacheSource?: string; sweCache?: string } {
  const fixtureRoot = dirname(task.dir);
  if (task.kind !== "swe") return { fixtureRoot };
  if (input.sweFixtures && resolve(fixtureRoot) !== resolve(input.sweFixtures)) throw new Error(`SWE task ${task.id} was read from ${fixtureRoot}, not from the plan's fixture root ${input.sweFixtures} (ADVISOR_BENCH_SWE_DIR)`);
  return { fixtureRoot, ...(input.sweCacheSource ? { sweCacheSource: input.sweCacheSource } : {}), sweCache };
}

export async function runUnit(input: RunInput): Promise<any> {
  const { out } = input;
  await mkdir(out, { recursive: true });
  const meta: any = {
    unit: input.unit, task: input.task, arm: input.arm.name, mode: input.arm.mode, attempt: input.attempt, status: "running", startedAt: now(),
    model: MODEL_REF, thinking: THINKING, limits: input.limits, piGuardMs: input.piGuardMs, runtime: input.runtime, provider: input.provider,
    ...(input.harness ? { harness: input.harness } : {}), upstream: upstream(), node: process.version,
  };
  const save = () => write(join(out, "meta.json"), meta);
  await save();
  const agentDir = join(input.temp, "agent"), sessionDir = join(input.temp, "sessions");
  const secrets: string[] = [];
  let task: Task | undefined;
  let workspace: { dir: string; tree: string } | undefined;
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    const changed = verifyRuntime(input.runtime.dir);
    if (changed.length) throw new Error(`frozen runtime ${input.runtime.name} differs from its REVISION.json: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}`);
    task = await loadTask(input.task);
    meta.kind = task.kind;
    // Where the task came from (the plan's fixture root, else the canonical one) and, for SWE, where its environment came from and runs.
    Object.assign(meta, fixtureEvidence(task, input));
    workspace = await prepareWorkspace(task, input.temp);
    meta.initialTree = workspace.tree;
    meta.workspace = workspace.dir;
    let pathPrefix: string | undefined;
    if (task.kind === "swe") { pathPrefix = join(input.temp, "pybin"); await pythonWrappers(task, workspace.dir, pathPrefix); }
    const catalog = catalogInfo();
    meta.catalog = { sha256: catalog.sha256, model: MODEL.id, cost: catalog.entry.cost };
    // List prices of the route; no cap (the proxy refuses nothing).
    // route: the proxy refuses any model request off the pinned route (another model id, request or configuration_update effort).
    await write(join(out, "envelope.json"), { capUSD: null, prices: { [MODEL.id]: catalog.entry.cost }, route: { model: MODEL.id, effort: THINKING } });
    proxy = await startProxy(join(out, "wire.jsonl"), join(out, "envelope.json"));
    const config = orcheConfig(input.limits);
    const { apiKey } = await overlay(agentDir, proxy.url, config);
    secrets.push(apiKey);
    await write(join(out, "orche.config.json"), config);
    await write(join(out, "settings.json"), piSettings());
    await mkdir(sessionDir, { recursive: true });
    const prompt = oneShot(input.arm.mode, task);
    await writeFile(join(out, "prompt.txt"), prompt);
    meta.sessionId = `uho-${input.unit.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const args = piArgs(input.runtime.dir, input.provider.dir, ["--mode", "json", "--session-id", meta.sessionId, prompt]);
    meta.command = { node: process.execPath, cli: PI_CLI, args: args.slice(0, -1), promptSha256: sha256(prompt), cwd: workspace.dir };
    await save();
    // Pi and the agents do not get the fixture root's variable (the hidden tests and the reference fix live there).
    const { ADVISOR_BENCH_SWE_DIR: _fixtures, ...base } = process.env;
    meta.pi = await runGuarded(process.execPath, [PI_CLI, ...args], {
      cwd: workspace.dir, env: piEnv(base, agentDir, sessionDir, input.temp, proxy.url, apiKey, pathPrefix),
      stdout: join(out, "events.jsonl"), stderr: join(out, "stderr.txt"), guardMs: input.piGuardMs,
      onSpawn: pid => { meta.piPid = pid; void save(); },
    });
  } catch (error) {
    meta.infra = `harness: ${String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000)}`;
  } finally {
    // In-flight streams cut by the end of Pi are logged on their close; then the proxy goes.
    if (proxy) { await new Promise(resolve => setTimeout(resolve, 2_000)); proxy.child.kill("SIGTERM"); }
  }
  meta.solverFinishedAt = now();
  meta.wallMs = meta.solverFinishedAt - meta.startedAt;
  await save();
  await collect(input, task, workspace, { agentDir, sessionDir }, meta);
  meta.redactedFiles = await redactTree(out, secrets);
  meta.finishedAt = now();
  meta.status = "completed";
  await save();
  return meta;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input: RunInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  const guard = setTimeout(() => { console.error("run-one outer guard expired"); process.exit(3); }, input.piGuardMs + COLLECT_GUARD_MS);
  // Children stop with the driver: when it is gone (even killed outright), stop Pi's process group and exit (resume reruns the unit).
  const watch = input.driverPid ? setInterval(() => {
    let alive = true;
    try { process.kill(input.driverPid!, 0); } catch { alive = false; }
    if (!alive || process.ppid !== input.driverPid) { console.error(`driver ${input.driverPid} is gone: stopping this unit`); process.kill(process.pid, "SIGTERM"); }
  }, 5_000) : undefined;
  watch?.unref();
  try {
    const meta = await runUnit(input);
    console.log(`RUN ${input.unit}: ${meta.terminal} grade ${meta.grade?.passed ?? "-"} primary ${meta.primaryPass} (${Math.round(meta.wallMs / 1000)}s, ${meta.wire?.requests ?? 0} requests, $${meta.wire?.costUSD ?? 0}, route violations ${meta.wire?.routeViolations ?? "?"})`);
  } finally {
    clearTimeout(guard);
    if (watch) clearInterval(watch);
    await rm(input.temp, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(0);
}
