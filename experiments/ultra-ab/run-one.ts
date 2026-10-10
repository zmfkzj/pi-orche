/**
 * One Pi run of the ultra-vs-single study (a condition A or B run, or one attempt of C), in its own process started by driver.ts:
 * a fresh workspace from the task's pristine snapshot, a private agent dir (orche config of protocol.ts), its own logging proxy, the
 * real `pi` CLI in JSON mode with the one-shot `/orche strong|ultra <prompt>`, then the evidence (orche records, transcripts, wire
 * log, final diff and workspace) and, except for C attempts (graded by select.ts after the choice is sealed), the independent grade.
 *
 *   node --import tsx experiments/ultra-ab/run-one.ts <input.json>
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM, gradeWorkspace, loadTask, overlay, piArgs, piEnv, prepareWorkspace, pythonWrappers, textFiles, type Task } from "./env.js";
import { readable } from "../advisor-reviewer/tasks.js";
import {
  LIMITS, MODE_OF, THINKING, leakHits, oneShot, primaryPass, redact, sessionToolCalls, sessionUsage, summarizeWire, terminalOf,
  type Condition, type WireEntry,
} from "./protocol.js";

export interface RunInput { out: string; runtime: string; task: string; condition: Condition; repeat: number; attempt?: number; temp: string; unit: string; deferGrade?: boolean }

const HERE = fileURLToPath(new URL(".", import.meta.url));
const now = () => Date.now();
const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** Start this run's logging proxy; resolves with its URL. */
export function startProxy(wireLog: string): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HERE, "proxy.mjs"), "0", UPSTREAM, wireLog], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`proxy did not start: ${text}`)); }, 15_000);
    child.stdout!.on("data", chunk => {
      text += String(chunk);
      const match = /PORT (\d+)/.exec(text);
      if (match) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${match[1]}`, child }); }
    });
    child.stderr!.on("data", chunk => { text += String(chunk); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${text}`)); });
  });
}

/** Run a command in its own process group with a hard guard; stdout/stderr appended to files. */
export function runGuarded(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string; guardMs: number }): Promise<{ code: number | null; signal: NodeJS.Signals | null; guardFired: boolean; ms: number }> {
  return new Promise(resolve => {
    const started = now();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let guardFired = false;
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* gone */ } };
    // If this runner is stopped, its process group (pi and the agent's shells) goes with it.
    const onStop = () => { kill("SIGKILL"); process.exit(143); };
    process.once("SIGTERM", onStop); process.once("SIGINT", onStop);
    const timer = setTimeout(() => { guardFired = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10_000).unref(); }, options.guardMs);
    let chain = Promise.resolve();
    child.stdout!.on("data", chunk => { chain = chain.then(() => appendFile(options.stdout, chunk)); });
    child.stderr!.on("data", chunk => { chain = chain.then(() => appendFile(options.stderr, chunk)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGTERM", onStop); process.off("SIGINT", onStop);
      kill("SIGKILL"); // leftovers of the group (background shells of the agent)
      void chain.then(() => resolve({ code, signal, guardFired, ms: now() - started }));
    });
    child.once("error", error => { clearTimeout(timer); void appendFile(options.stderr, `spawn error: ${String(error)}\n`).then(() => resolve({ code: -1, signal: null, guardFired, ms: now() - started })); });
  });
}

export const readJsonl = <T>(file: string): T[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as T]; } catch { return []; } }) : [];

/** Every *.jsonl below a directory. */
export function jsonlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith(".jsonl")) out.push(path); } };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** orche task records (run.json) of a records tree in start order. */
export function taskRecords(root: string): { dir: string; status: string; start: number; mode?: string; tier?: string; model?: string; thinking?: string; requests?: number; durationMs?: number; requestMode?: unknown; models?: unknown }[] {
  const out: ReturnType<typeof taskRecords> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "run.json") {
        try {
          const run = JSON.parse(readFileSync(path, "utf8"));
          if (run.kind !== "task") continue;
          out.push({ dir: dir.slice(root.length + 1), status: run.outcome?.status ?? run.status, start: Date.parse(run.start ?? "") || 0, mode: run.assignment?.mode, tier: run.assignment?.tier, model: run.assignment?.model, thinking: run.assignment?.thinking, requests: run.outcome?.requests, durationMs: run.durationMs ?? run.outcome?.durationMs, requestMode: run.assignment?.requestMode, models: run.outcome?.models });
        } catch { /* partial */ }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => a.start - b.start);
}

/** The final assistant text of a pi JSON-mode event stream. */
export function finalText(eventsFile: string): string {
  let text = "";
  for (const event of readJsonl<any>(eventsFile)) {
    const message = event?.message;
    if ((event?.type === "message_end" || event?.type === "turn_end") && message?.role === "assistant" && Array.isArray(message.content)) {
      const parts = message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("");
      if (parts.trim()) text = parts;
    }
  }
  return text;
}

/** Redact secrets in every text file below `root`. */
export async function redactTree(root: string, secrets: string[]): Promise<number> {
  let changed = 0;
  for (const file of textFiles(root)) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined || !secrets.some(secret => secret && text.includes(secret))) continue;
    await writeFile(file, redact(text, secrets)); changed++;
  }
  return changed;
}

/** Collect the run's evidence and grade (shared with tests through a fake pi). */
export async function collect(input: RunInput, task: Task, workspace: string, paths: { agentDir: string; sessionDir: string }, meta: any): Promise<void> {
  const { out } = input;
  await cp(join(paths.agentDir, "orche/records"), join(out, "records"), { recursive: true }).catch(() => undefined);
  await cp(paths.sessionDir, join(out, "sessions"), { recursive: true }).catch(() => undefined);
  const records = taskRecords(join(out, "records"));
  meta.tasks = records;
  try {
    execFileSync("git", ["add", "-A"], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    await writeFile(join(out, "final.diff"), execFileSync("git", ["diff", "--cached", "HEAD", "--", ".", ":(exclude).orche"], { cwd: workspace, maxBuffer: 256 * 1024 * 1024 }));
    meta.diffStat = execFileSync("git", ["diff", "--cached", "--stat", "HEAD", "--", ".", ":(exclude).orche"], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 }).toString().slice(-4000);
  } catch (error) { meta.diffError = String(error).slice(0, 1000); }
  await cp(workspace, join(out, "workspace-final"), { recursive: true, filter: path => !/\/(\.git|\.orche|node_modules|__pycache__|\.pytest_cache)$/.test(path) && readable(path) }).catch(error => { meta.preservationError = String(error); });

  const wire = readJsonl<WireEntry>(join(out, "wire.jsonl"));
  meta.wire = summarizeWire(wire, { main: THINKING.main, worker: THINKING.orchestrator, mainSession: meta.sessionId });
  const usage: Record<string, ReturnType<typeof sessionUsage>[string]> = {};
  const leaks: string[] = [];
  let toolCalls = 0;
  for (const file of [...jsonlFiles(join(out, "records")), ...jsonlFiles(join(out, "sessions"))]) {
    const text = await readFile(file, "utf8");
    for (const [key, value] of Object.entries(sessionUsage(text))) {
      const total = usage[key] ??= { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0 };
      total.requests += value.requests; total.errors += value.errors; total.input += value.input; total.output += value.output; total.cacheRead += value.cacheRead;
    }
    const calls = sessionToolCalls(text);
    toolCalls += calls.length;
    leaks.push(...leakHits(calls).map(hit => `${file.slice(out.length + 1)}: ${hit}`));
  }
  meta.sessionUsage = usage;
  meta.toolCalls = toolCalls;
  meta.leakAudit = { hits: leaks };
  const ok = wire.filter(entry => entry.method === "POST" && entry.model && entry.status === 200).length;
  if (!meta.infra && ok === 0) meta.infra = `no successful model request (pi exit ${meta.pi?.code}${meta.pi?.signal ? ` ${meta.pi.signal}` : ""})`;
  meta.terminal = terminalOf({ guardFired: !!meta.pi?.guardFired, taskStatuses: records.map(record => record.status), infra: meta.infra });
  meta.finalText = finalText(join(out, "events.jsonl")).slice(-6000);
  if (!input.deferGrade) await gradeInto(task, join(out, "workspace-final"), out, meta);
}

/** Grade a preserved final workspace into grade.json and meta (A/B by run-one, C attempts by select.ts after sealing). */
export async function gradeInto(task: Task, finalWorkspace: string, out: string, meta: any): Promise<void> {
  const started = now();
  const { grade, integrity } = existsSync(finalWorkspace) ? await gradeWorkspace(task, finalWorkspace) : { grade: { passed: false, error: "no final workspace", checks: {} }, integrity: { violations: [], suspicious: [] } };
  await write(join(out, "grade.json"), { grade, integrity, gradedAt: new Date().toISOString(), ms: now() - started });
  meta.grade = { passed: grade.passed, ...(grade.error ? { error: grade.error } : {}), checks: Object.fromEntries(Object.entries(grade.checks).map(([name, check]) => [name, check.passed])) };
  meta.integrity = integrity;
  meta.primaryPass = primaryPass({ terminal: meta.terminal, gradePassed: grade.error ? undefined : grade.passed, integrity });
}

async function main(input: RunInput): Promise<void> {
  const { out } = input;
  await mkdir(out, { recursive: true });
  const meta: any = { ...input, mode: MODE_OF[input.condition], startedAt: now(), status: "running", limits: LIMITS, runtimeRevision: JSON.parse(readFileSync(join(input.runtime, "REVISION.json"), "utf8")).digest, node: process.version };
  const save = () => write(join(out, "meta.json"), meta);
  await save();
  const task = await loadTask(input.task);
  const agentDir = join(input.temp, "agent"), sessionDir = join(input.temp, "sessions");
  const workspace = await prepareWorkspace(task, input.temp);
  let pathPrefix: string | undefined;
  if (task.kind === "swe") { pathPrefix = join(input.temp, "pybin"); await pythonWrappers(task, workspace, pathPrefix); }
  let secrets: string[] = [];
  let proxy: { url: string; child: ChildProcess } | undefined;
  try {
    proxy = await startProxy(join(out, "wire.jsonl"));
    const { apiKey } = await overlay(agentDir, proxy.url, { orche: true });
    secrets = [apiKey];
    await mkdir(sessionDir, { recursive: true });
    const prompt = oneShot(input.condition, task);
    await writeFile(join(out, "prompt.txt"), prompt);
    meta.sessionId = `ab-${input.unit.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const args = piArgs(input.runtime, THINKING.main, ["--mode", "json", "--session-id", meta.sessionId, prompt]);
    meta.piArgs = args.slice(0, -1);
    meta.workspace = workspace;
    await save();
    meta.pi = await runGuarded("pi", args, { cwd: workspace, env: piEnv(process.env, agentDir, sessionDir, input.temp, proxy.url, apiKey, pathPrefix), stdout: join(out, "events.jsonl"), stderr: join(out, "stderr.txt"), guardMs: LIMITS.piGuardMs });
  } catch (error) {
    meta.infra = `harness: ${String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000)}`;
  } finally {
    proxy?.child.kill("SIGTERM");
  }
  meta.solverFinishedAt = now();
  meta.wallMs = meta.solverFinishedAt - meta.startedAt;
  await save();
  await collect(input, task, workspace, { agentDir, sessionDir }, meta);
  meta.redactedFiles = await redactTree(out, secrets);
  meta.finishedAt = now();
  meta.status = "completed";
  await save();
  console.log(`RUN ${input.unit}: ${meta.terminal}${meta.grade ? ` grade ${meta.grade.passed}` : " (grade deferred)"} primary ${meta.primaryPass ?? "-"} (${Math.round(meta.wallMs / 1000)}s, ${meta.wire?.requests ?? 0} requests)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input: RunInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  const guard = setTimeout(() => { console.error("run-one outer guard expired"); process.exit(3); }, LIMITS.piGuardMs + 40 * 60_000);
  try { await main(input); } finally { clearTimeout(guard); await rm(input.temp, { recursive: true, force: true }).catch(() => undefined); }
  process.exit(0);
}
