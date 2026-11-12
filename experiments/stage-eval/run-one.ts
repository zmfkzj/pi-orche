/**
 * One Pi run of the stage evaluation (experiments/stage-eval), in its own process started by driver.ts: a fresh workspace from the
 * task's pristine snapshot, a private agent dir, its own logging proxy, the real `pi` CLI in JSON mode with the task prompt as a
 * plain message (orche arms: the session's configured mode handles it, exactly as a user's message), then the evidence (wire
 * log, transcripts, orche records, tool-event log, final diff and workspace) and the independent grade.
 *
 *   node --import tsx experiments/stage-eval/run-one.ts <input.json>
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM, catalogRates, gradeWorkspace, loadTask, overlay, piArgs, piEnv, prepareWorkspace, pythonWrappers, textFiles, type Task } from "./env.js";
import { readable } from "../advisor-reviewer/tasks.js";
import {
  LIMITS, leakHits, primaryPass, redact, roleOfTranscript, sessionToolCalls, summarizeWire, terminalOf, toolEventStats, transcriptSessionId,
  transcriptStats, userPrompt, type Arm, type Role, type TranscriptStats, type WireEntry,
} from "./protocol.js";

export interface RunInput { out: string; runtime?: string; runtimeLabel?: string; task: string; arm: Arm; repeat: number; temp: string; unit: string }

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** The Pi CLI under test: the user's installed CLI (absolute path from the plan), never a node_modules/.bin copy found through npx. */
const PI = process.env.STAGE_EVAL_PI || "pi";
const now = () => Date.now();
const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

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
    const onStop = () => { kill("SIGKILL"); process.exit(143); };
    process.once("SIGTERM", onStop); process.once("SIGINT", onStop);
    const timer = setTimeout(() => { guardFired = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10_000).unref(); }, options.guardMs);
    let chain = Promise.resolve();
    child.stdout!.on("data", chunk => { chain = chain.then(() => appendFile(options.stdout, chunk)); });
    child.stderr!.on("data", chunk => { chain = chain.then(() => appendFile(options.stderr, chunk)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGTERM", onStop); process.off("SIGINT", onStop);
      kill("SIGKILL");
      void chain.then(() => resolve({ code, signal, guardFired, ms: now() - started }));
    });
    child.once("error", error => { clearTimeout(timer); void appendFile(options.stderr, `spawn error: ${String(error)}\n`).then(() => resolve({ code: -1, signal: null, guardFired, ms: now() - started })); });
  });
}

export const readJsonl = <T>(file: string): T[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as T]; } catch { return []; } }) : [];

export function jsonlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith(".jsonl")) out.push(path); } };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** orche task records (run.json) of a records tree in start order. */
export function taskRecords(root: string): any[] {
  const out: any[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "run.json") {
        try {
          const run = JSON.parse(readFileSync(path, "utf8"));
          if (run.kind !== "task") continue;
          const outcome = run.outcome ?? {};
          out.push({
            dir: dir.slice(root.length + 1), status: outcome.status ?? run.status, start: Date.parse(run.start ?? "") || 0, role: run.assignment?.role, mode: run.assignment?.mode,
            model: run.assignment?.model, thinking: run.assignment?.thinking, requests: outcome.requests, durationMs: run.durationMs ?? outcome.durationMs,
            advisor: run.advisor ? { status: run.advisor.status, requests: run.advisor.requests, costUSD: run.advisor.costUSD, durationMs: run.advisor.durationMs, model: run.advisor.model, handling: run.advisor.handling, finalizationPrompts: run.advisor.finalizationPrompts } : undefined,
            split: outcome.split, rereads: outcome.rereads, compactions: outcome.compactions, plan: outcome.plan ? { nodes: outcome.plan.nodes?.length, read: outcome.plan.nodes?.filter((node: any) => node.read).length } : undefined,
            thinkingPolicy: outcome.thinkingPolicy,
          });
        } catch { /* partial */ }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => a.start - b.start);
}

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

  // Roles of every Pi session of the run (main = the run's --session-id; orche transcripts by file name).
  const roles = new Map<string, Role>([[meta.sessionId, "main"]]);
  const transcripts: { file: string; role: Role; session?: string; stats: TranscriptStats }[] = [];
  const leaks: string[] = [];
  for (const file of [...jsonlFiles(join(out, "sessions")), ...jsonlFiles(join(out, "records")).filter(path => path.includes("/workers/"))]) {
    const text = await readFile(file, "utf8");
    const session = transcriptSessionId(text);
    const role: Role = file.includes("/workers/") ? roleOfTranscript(basename(file)) : session === meta.sessionId ? "main" : "other";
    if (session && !roles.has(session)) roles.set(session, role);
    transcripts.push({ file: file.slice(out.length + 1), role, ...(session ? { session } : {}), stats: transcriptStats(text) });
    leaks.push(...leakHits(sessionToolCalls(text)).map(hit => `${file.slice(out.length + 1)}: ${hit}`));
  }
  meta.transcripts = transcripts;
  meta.leakAudit = { hits: leaks };
  const wire = readJsonl<WireEntry>(join(out, "wire.jsonl"));
  meta.wire = summarizeWire(wire, { roles, rates: meta.rates, expectAdvisor: input.arm.kind === "single-advisor" });
  meta.toolEvents = toolEventStats(readJsonl<any>(join(out, "tool-events.jsonl")));
  const ok = wire.filter(entry => entry.method === "POST" && entry.model && entry.status === 200).length;
  if (!meta.infra && ok === 0) meta.infra = `no successful model request (pi exit ${meta.pi?.code}${meta.pi?.signal ? ` ${meta.pi.signal}` : ""})`;
  meta.terminal = terminalOf({ kind: input.arm.kind, infra: meta.infra, guardFired: !!meta.pi?.guardFired, code: meta.pi?.code ?? null, signal: meta.pi?.signal ?? null, taskStatuses: records.map(record => record.status) });
  meta.finalText = finalText(join(out, "events.jsonl")).slice(-6000);
  const started = now();
  const { grade, integrity } = existsSync(join(out, "workspace-final")) ? await gradeWorkspace(task, join(out, "workspace-final")) : { grade: { passed: false, error: "no final workspace", checks: {} }, integrity: { violations: [], suspicious: [] } };
  await write(join(out, "grade.json"), { grade, integrity, gradedAt: new Date().toISOString(), ms: now() - started });
  meta.grade = { passed: grade.passed, ...(grade.error ? { error: grade.error } : {}), checks: Object.fromEntries(Object.entries(grade.checks).map(([name, check]) => [name, check.passed])) };
  meta.integrity = integrity;
  meta.primaryPass = primaryPass({ terminal: meta.terminal, gradePassed: grade.error ? undefined : grade.passed, integrity });
}

async function main(input: RunInput): Promise<void> {
  const { out } = input;
  await mkdir(out, { recursive: true });
  const meta: any = { ...input, startedAt: now(), status: "running", limits: LIMITS, node: process.version, rates: catalogRates() };
  if (input.runtime) meta.runtimeRevision = JSON.parse(readFileSync(join(input.runtime, "REVISION.json"), "utf8"));
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
    const { apiKey, secrets: overlaySecrets } = await overlay(agentDir, proxy.url, input.arm.kind);
    secrets = overlaySecrets;
    await mkdir(sessionDir, { recursive: true });
    const prompt = userPrompt(task);
    await writeFile(join(out, "prompt.txt"), prompt);
    meta.sessionId = `se-${input.unit.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const args = piArgs(input.runtime, ["--mode", "json", "--session-id", meta.sessionId, prompt]);
    meta.piArgs = args.slice(0, -1);
    meta.workspace = workspace;
    meta.agentDirFiles = readdirSync(agentDir).sort();
    meta.piVersion = execFileSync(PI, ["--version"], { env: piEnv(process.env, { agentDir, sessionDir, temp: input.temp, proxyUrl: proxy.url, apiKey }) }).toString().trim();
    await save();
    meta.piBin = PI;
    meta.pi = await runGuarded(PI, args, { cwd: workspace, env: piEnv(process.env, { agentDir, sessionDir, temp: input.temp, proxyUrl: proxy.url, apiKey, ...(pathPrefix ? { pathPrefix } : {}), toolEvents: join(out, "tool-events.jsonl") }), stdout: join(out, "events.jsonl"), stderr: join(out, "stderr.txt"), guardMs: LIMITS.piGuardMs });
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
  console.log(`RUN ${input.unit}: ${meta.terminal} grade ${meta.grade?.passed} primary ${meta.primaryPass} (${Math.round(meta.wallMs / 1000)}s, ${meta.wire?.total?.requests ?? 0} requests, $${(meta.wire?.total?.costUsd ?? 0).toFixed(3)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input: RunInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  const guard = setTimeout(() => { console.error("run-one outer guard expired"); process.exit(3); }, LIMITS.piGuardMs + 40 * 60_000);
  try { await main(input); } finally { clearTimeout(guard); await rm(input.temp, { recursive: true, force: true }).catch(() => undefined); }
  process.exit(0);
}
