/**
 * Model-free replay of the regression_check calls the S5/S6/S7 workers made (change #5 revision): for each non-clean call on a
 * SWE task, a fresh workspace at the task's starting state is captured as the starting state, the run's final diff is applied, and
 * the SAME command is checked with an old and a new src/tools/regression-check.ts. The final workspace stands in for the state at
 * the time of the call (the call itself happened mid-assignment), so this measures the tool's classification, not the worker.
 *
 *   ADVISOR_BENCH_SWE_CACHE=<cache> npx tsx experiments/stage-eval/regression-replay.ts <study dir> <old regression-check.ts> <new regression-check.ts> <out.json> [--tasks a,b] [--limit n]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTask, prepareWorkspace, pythonWrappers } from "./env.js";

interface Call { run: string; task: string; command: string; dir?: string; seen: string }

function calls(study: string, tasks: Set<string>): Call[] {
  const out: Call[] = [];
  const runs = join(study, "runs");
  for (const task of readdirSync(runs)) {
    if (tasks.size && !tasks.has(task)) continue;
    for (const arm of readdirSync(join(runs, task))) {
      if (!/^S[567]$/.test(arm)) continue;
      for (const repeat of readdirSync(join(runs, task, arm))) {
        const dir = join(runs, task, arm, repeat);
        const records = join(dir, "records");
        if (!existsSync(records)) continue;
        for (const session of readdirSync(records)) {
          const workers = join(records, session, "workers");
          if (!existsSync(workers)) continue;
          for (const file of readdirSync(workers).filter(name => /^W\d+-.*\.jsonl$/.test(name))) {
            const pending = new Map<string, { command: string; dir?: string }>();
            for (const line of readFileSync(join(workers, file), "utf8").split("\n")) {
              if (!line.includes('"type":"message"')) continue;
              const message = JSON.parse(line).message;
              if (message.role === "assistant") for (const part of message.content ?? []) if (part.type === "toolCall" && part.name === "regression_check") pending.set(part.id, part.arguments);
              if (message.role === "toolResult" && pending.has(message.toolCallId)) {
                const text = (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
                const args = pending.get(message.toolCallId)!;
                if (!/^Regression check: no new failures/.test(text)) out.push({ run: `${task}/${arm}/${repeat}`, task, command: args.command, ...(args.dir ? { dir: args.dir } : {}), seen: text.split("\n")[0]! });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const tasks = new Set((option("--tasks") ?? "").split(",").filter(Boolean));
const limit = Number(option("--limit") ?? Infinity);
const [study, oldFile, newFile, outFile] = args as [string, string, string, string];
const oldModule = await import(pathToFileURL(oldFile).href);
const newModule = await import(pathToFileURL(newFile).href);
const rows: unknown[] = [];
for (const call of calls(study, tasks).slice(0, limit)) {
  const task = await loadTask(call.task);
  if (task.kind !== "swe") continue;
  const temp = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "regression-replay-"));
  try {
    const workspace = await prepareWorkspace(task, temp);
    const bin = join(temp, "pybin");
    await pythonWrappers(task, workspace, bin);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const row: Record<string, unknown> = { run: call.run, command: call.command, seenDuringRun: call.seen };
    const diff = resolve(study, "runs", call.run, "final.diff");
    for (const [name, module] of [["old", oldModule], ["new", newModule]] as const) {
      // Each module captures its own starting state of the same clean workspace, then the final diff is applied.
      execFileSync("git", ["checkout", "-q", "--", "."], { cwd: workspace }); execFileSync("git", ["clean", "-qfdx", "-e", ".orche"], { cwd: workspace });
      const state = await module.StartingState.capture(workspace, join(temp, `start-${name}`));
      if (readFileSync(diff, "utf8").trim()) execFileSync("git", ["apply", "--whitespace=nowarn", diff], { cwd: workspace });
      const started = Date.now();
      const result = await state.check(call.command, { ...(call.dir ? { dir: call.dir.startsWith("/") ? call.dir : join(workspace, call.dir) } : {}), timeoutMs: 900_000, env });
      row[name] = { verdict: result.verdict, seconds: Math.round((Date.now() - started) / 1000), summary: result.text.split("\n").slice(0, 8).map((line: string) => line.slice(0, 300)) };
      await state.close();
    }
    rows.push(row);
    console.log(JSON.stringify({ run: call.run, seen: call.seen.slice(0, 40), old: (row.old as any).verdict, new: (row.new as any).verdict }));
  } catch (error) {
    rows.push({ run: call.run, command: call.command, error: String(error).slice(0, 500) });
    console.log(JSON.stringify({ run: call.run, error: String(error).slice(0, 200) }));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await writeFile(outFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), study, oldFile, newFile, rows }, null, 2)}\n`);
}
