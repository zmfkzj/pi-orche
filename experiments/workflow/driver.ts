/**
 * Benchmark driver of docs/workflow-policy.md 4 (G-E1, G-I2, G-C2). One native Pi CLI `--mode rpc` process per session, the orche
 * extension of a frozen runtime snapshot and the cliproxyapi provider loaded explicitly (`--no-extensions`), a private agent dir
 * (credentials copied read-only, settings and orche.config.json per arm), records on. Accounting comes from the session files
 * themselves (the main session plus every orche worker/specialist transcript in the records), so it does not depend on a provider's
 * wire format; a request without usage counts as unknown usage. Grading never enters the Pi conversation.
 *
 *   node --import tsx experiments/workflow/driver.ts <plan.json>
 *
 * plan.json: { out, suite, concurrency, provider, model, thinking, sessions: [{ id, arm, runtime, single, tasks: [ids], mode: "long" | "fresh" }] }
 * `long`: one session works through the tasks in order (packages/<id>/); `fresh`: one session per task.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PiRpc } from "./rpc.js";

const AGENT = path.join(os.homedir(), ".pi/agent");
const PROVIDER_PACKAGE = "npm:@router-for-me/pi-cliproxyapi-provider";
const PROVIDER_DIR = path.join(AGENT, "npm/node_modules/@router-for-me/pi-cliproxyapi-provider");
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(`${file}.tmp`, file); };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

export interface SessionPlan { id: string; arm: string; runtime: string; single: Record<string, unknown>; tasks: string[]; mode: "long" | "fresh" }
export interface Plan { out: string; suite: string; concurrency: number; provider: string; model: string; thinking: string; judge?: { model: string; thinking: string }; images?: { model: string; timeoutMs?: number }; sessions: SessionPlan[] }

/** Usage of every assistant message in the given session JSONL files. */
export function sessionUsage(files: readonly string[]) {
  const total = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownUsage: 0, models: {} as Record<string, number>, maxInput: 0 };
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: any; try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.role !== "assistant") continue;
      total.requests++;
      const key = `${message.provider}/${message.model}`;
      total.models[key] = (total.models[key] ?? 0) + 1;
      const usage = message.usage;
      if (!usage || typeof usage.input !== "number") { total.unknownUsage++; continue; }
      total.input += usage.input; total.output += usage.output ?? 0; total.cacheRead += usage.cacheRead ?? 0; total.cacheWrite += usage.cacheWrite ?? 0;
      total.cost += usage.cost?.total ?? 0;
      total.maxInput = Math.max(total.maxInput, usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
    }
  }
  total.cost = Math.round(total.cost * 1e6) / 1e6;
  return total;
}
const jsonl = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? jsonl(path.join(dir, entry.name)) : entry.name.endsWith(".jsonl") && entry.name !== "events.jsonl" ? [path.join(dir, entry.name)] : []);

/** orche_task calls of the main session, with their arguments (front behaviour: role, type, candidates, then). */
export function frontCalls(file: string): { role?: string; type?: string; candidates?: number; then?: string; worker?: string; task?: string }[] {
  const calls: any[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (part.type === "toolCall" && part.name === "orche_task") {
      const { role, type, candidates, then, worker, task } = part.arguments ?? {};
      calls.push({ role, ...(type ? { type } : {}), ...(candidates !== undefined ? { candidates } : {}), ...(then ? { then } : {}), ...(worker ? { worker } : {}), ...(task ? { task } : {}) });
    }
  }
  return calls;
}

async function overlay(dir: string, plan: Plan, session: SessionPlan, records: string) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "cliproxyapi.json", "cliproxyapi-models.json"]) if (fs.existsSync(path.join(AGENT, name))) await fsp.copyFile(path.join(AGENT, name), path.join(dir, name));
  // Pi resolves user-scope packages under <agent dir>/npm: orche's worker runtime loads the provider from there.
  await fsp.symlink(path.join(AGENT, "npm"), path.join(dir, "npm"), "dir");
  const settings = { defaultProvider: plan.provider, defaultModel: plan.model, defaultThinkingLevel: plan.thinking, enableInstallTelemetry: false, enableAnalytics: false };
  const config = { mainMode: "single", providerExtensions: [PROVIDER_PACKAGE], default: { model: `${plan.provider}/${plan.model}`, thinking: plan.thinking }, routes: {}, ...(plan.images ? { images: plan.images } : {}), records: { enabled: true, dir: records }, single: session.single };
  await fsp.writeFile(path.join(dir, "settings.json"), JSON.stringify(settings));
  await fsp.writeFile(path.join(dir, "orche.config.json"), JSON.stringify(config));
  return { settings, config };
}

async function runSession(plan: Plan, session: SessionPlan, out: string, suiteMod: any, judge: any) {
  if (fs.existsSync(path.join(out, "meta.json"))) throw new Error(`Refusing to overwrite ${out}`);
  const all = await suiteMod.loadSuite(plan.suite);
  const tasks = session.tasks.map(id => { const task = all.find((item: any) => item.id === id); if (!task) throw new Error(`Unknown task ${id}`); return task; });
  const meta: any = { ...session, startedAt: Date.now(), status: "running", turns: [], provider: plan.provider, model: plan.model, thinking: plan.thinking };
  const save = () => write(path.join(out, "meta.json"), meta);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "wf-"));
  const workspace = path.join(temp, "workspace"), agentDir = path.join(temp, "agent"), records = path.join(out, "orche-records");
  let rpc: PiRpc | undefined;
  save();
  try {
    await fsp.mkdir(workspace, { recursive: true });
    for (const task of tasks) await fsp.cp(path.join(task.dir, "repo"), path.join(workspace, "packages", task.id), { recursive: true, filter: source => path.basename(source) !== ".git" });
    for (const args of [["init", "--quiet"], ["add", "--force", "."], ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "starters"]]) git(workspace, args);
    meta.overlay = await overlay(agentDir, plan, session, records);
    const args = [path.join(session.runtime, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--mode", "rpc", "--provider", plan.provider, "--model", plan.model, "--thinking", plan.thinking,
      "--session-dir", path.join(out, "sessions"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "--extension", PROVIDER_DIR, "--extension", path.join(session.runtime, "src/extension/index.ts")];
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, PI_CODING_AGENT_DIR: agentDir };
    for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_SESSION_BUS_ID", "PI_SESSION_BUS_SOCKET"]) delete env[name];
    rpc = new PiRpc(args, workspace, env, path.join(out, "events.jsonl"), path.join(out, "stderr.txt"));
    meta.solverStartedAt = Date.now();
    const state = await rpc.command("get_state");
    meta.sessionFile = state.sessionFile;
    if (state.model?.id !== plan.model || state.thinkingLevel !== plan.thinking) throw new Error(`Runtime identity mismatch: ${state.model?.provider}/${state.model?.id} ${state.thinkingLevel}`);
    save();
    for (const [index, task] of tasks.entries()) {
      const turn: any = { position: index + 1, taskId: task.id, startedAt: Date.now() };
      meta.turns.push(turn); save();
      const events = await rpc.prompt(`Work in packages/${task.id}/.\n\n${task.instruction}`);
      turn.finishedAt = Date.now(); turn.wallClockMs = turn.finishedAt - turn.startedAt;
      const final = [...events].reverse().find(event => event.type === "message_end" && event.message?.role === "assistant");
      turn.stopReason = final?.message?.stopReason ?? null;
      const answer = typeof final?.message?.content === "string" ? final.message.content : (final?.message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text ?? "").join("\n");
      await fsp.mkdir(path.join(out, "turns", task.id), { recursive: true });
      await fsp.writeFile(path.join(out, "turns", task.id, "answer.txt"), answer);
      turn.grade = await suiteMod.gradeTask(task, path.join(workspace, "packages", task.id), answer, { judge, timeoutMs: 300_000 });
      write(path.join(out, "turns", task.id, "grade.json"), turn.grade);
      console.log(`TURN ${session.id} ${index + 1}/${tasks.length} ${task.id}: grade=${turn.grade.passed} ${Math.round(turn.wallClockMs / 1000)}s`);
      save();
    }
    meta.solverFinishedAt = Date.now(); meta.solverWallClockMs = meta.solverFinishedAt - meta.solverStartedAt;
    meta.shutdown = await rpc.stop();
    meta.status = meta.turns.every((turn: any) => turn.stopReason && !["error", "aborted"].includes(turn.stopReason)) ? "done" : "failed";
  } catch (error) {
    meta.status = "failed"; meta.error = String(error); rpc?.kill();
  } finally {
    if (rpc) await rpc.stop().catch(() => rpc?.kill());
    const mainFiles = jsonl(path.join(out, "sessions"));
    meta.usage = { main: sessionUsage(mainFiles), orche: sessionUsage(jsonl(records)) };
    const models = { ...meta.usage.main.models };
    for (const [key, count] of Object.entries(meta.usage.orche.models as Record<string, number>)) models[key] = (models[key] ?? 0) + count;
    meta.parity = { expected: `${plan.provider}/${plan.model}`, models, passed: Object.keys(models).every(key => key === `${plan.provider}/${plan.model}`) };
    meta.front = mainFiles.flatMap(file => frontCalls(file));
    meta.finishedAt = Date.now();
    await fsp.cp(workspace, path.join(out, "workspace-final"), { recursive: true, filter: source => path.basename(source) !== ".git" }).catch(error => { meta.preservationError = String(error); });
    await fsp.rm(temp, { recursive: true, force: true });
    save();
  }
  return meta;
}

async function main() {
  if (process.argv[2] === "--session") {
    const input = JSON.parse(fs.readFileSync(process.argv[3]!, "utf8"));
    const suiteMod = await import(pathToFileURL(path.join(input.session.runtime, "src/eval/suite.ts")).href);
    let judge: any = async () => { throw new Error("No rubric judge configured"); };
    if (input.plan.judge) {
      // The rubric judge runs in this harness process on its own runtime with the provider loaded (blind: no arm, no system),
      // with a private agent dir so nothing (e.g. an OAuth refresh) writes to the user's.
      const judgeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wf-judge-"));
      for (const name of ["auth.json", "cliproxyapi.json", "cliproxyapi-models.json"]) if (fs.existsSync(path.join(AGENT, name))) await fsp.copyFile(path.join(AGENT, name), path.join(judgeDir, name));
      await fsp.symlink(path.join(AGENT, "npm"), path.join(judgeDir, "npm"), "dir");
      process.env.PI_CODING_AGENT_DIR = judgeDir;
      const { ModelRuntime } = await import(pathToFileURL(path.join(input.session.runtime, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
      const { loadProviderExtensions } = await import(pathToFileURL(path.join(input.session.runtime, "src/pi/provider-extensions.ts")).href);
      const runtime = await ModelRuntime.create();
      await loadProviderExtensions(runtime, [PROVIDER_PACKAGE], { cwd: os.tmpdir(), agentDir: judgeDir });
      judge = suiteMod.createPiJudge({ model: input.plan.judge.model, thinking: input.plan.judge.thinking, modelRuntime: runtime, sessionDir: path.join(input.out, "judge") });
    }
    await runSession(input.plan, input.session, input.out, suiteMod, judge);
    return;
  }
  const plan: Plan = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
  write(path.join(plan.out, "plan.json"), { ...plan, startedAt: Date.now() });
  const jobs = plan.sessions.flatMap(session => session.mode === "fresh" ? session.tasks.map(task => ({ ...session, id: `${session.id}-${task}`, tasks: [task] })) : [session]);
  let next = 0;
  const runner = async () => {
    while (next < jobs.length) {
      const session = jobs[next++]!;
      const out = path.join(plan.out, "sessions", session.id);
      write(path.join(out, "input.json"), { plan, session, out });
      await new Promise<void>(resolve => {
        const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--session", path.join(out, "input.json")], { cwd: session.runtime, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", chunk => { process.stdout.write(chunk); fs.appendFileSync(path.join(out, "driver-stdout.txt"), chunk); });
        child.stderr.on("data", chunk => fs.appendFileSync(path.join(out, "driver-stderr.txt"), chunk));
        child.once("close", code => { console.log(`SESSION ${session.id} exited ${code}`); resolve(); });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, plan.concurrency) }, runner));
  console.log(`DRIVER done: ${jobs.length} sessions`);
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
