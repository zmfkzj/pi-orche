/**
 * Selection step of condition C (experiments/ultra-ab): after the k strong attempts of one (task, repeat) ended, a fresh Pi session
 * on the same model (no orche, read/bash tools) sees ONLY visible evidence: the starting snapshot, each attempt's final files and
 * diff, its terminal status, and whatever visible checks it runs itself. It never sees transcripts, reports, grades or hidden tests.
 * The choice (or the pre-registered fallback) is written and sealed (sha256 in select.json) BEFORE any attempt is graded; then every
 * attempt is graded (the chosen one is C's result, the others give the oracle reference only).
 *
 *   node --import tsx experiments/ultra-ab/select.ts <input.json>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask, overlay, piArgs, piEnv, pythonWrappers } from "./env.js";
import { readable } from "../advisor-reviewer/tasks.js";
import { LIMITS, THINKING, fallbackChoice, leakHits, parseChoice, primaryPass, selectorPrompt, sessionToolCalls, summarizeWire, type SelectorCandidate, type WireEntry } from "./protocol.js";
import { finalText, gradeInto, jsonlFiles, readJsonl, redactTree, runGuarded, startProxy } from "./run-one.js";

export interface SelectInput { out: string; task: string; repeat: number; attempts: string[]; temp: string; unit: string }

const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** The selector's directory: base/, cand-<n>/ and cand-<n>.diff only (no meta, grade or transcript). */
export async function selectionDir(dir: string, source: string, attempts: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await cp(source, join(dir, "base"), { recursive: true, filter: path => !path.endsWith("/.git") });
  for (const [index, attempt] of attempts.entries()) {
    const final = join(attempt, "workspace-final");
    if (existsSync(final)) await cp(final, join(dir, `cand-${index + 1}`), { recursive: true, filter: path => readable(path) });
    else await mkdir(join(dir, `cand-${index + 1}`));
    await writeFile(join(dir, `cand-${index + 1}.diff`), existsSync(join(attempt, "final.diff")) ? await readFile(join(attempt, "final.diff")) : "");
  }
}

async function main(input: SelectInput): Promise<void> {
  const { out } = input;
  await mkdir(out, { recursive: true });
  const started = Date.now();
  const meta: any = { ...input, kind: "select", startedAt: started, status: "running" };
  const save = () => write(join(out, "meta.json"), meta);
  await save();
  const task = await loadTask(input.task);
  const attemptsMeta = input.attempts.map(dir => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")));
  const candidates: SelectorCandidate[] = attemptsMeta.map((attempt, index) => ({ index: index + 1, terminal: attempt.terminal ?? "infra", diffStat: attempt.diffStat ?? "" }));
  const dir = join(input.temp, "selection");
  await selectionDir(dir, task.source, input.attempts);
  let pathPrefix: string | undefined;
  if (task.kind === "swe") { pathPrefix = join(input.temp, "pybin"); await pythonWrappers(task, join(dir, "base"), pathPrefix); }
  const agentDir = join(input.temp, "agent"), sessionDir = join(input.temp, "sessions");
  let secrets: string[] = [];
  let choice: number | undefined, source: "selector" | "fallback" = "fallback", reason = "";
  const proxy = await startProxy(join(out, "wire.jsonl")).catch(error => { meta.proxyError = String(error); return undefined; });
  if (proxy) {
    try {
      const { apiKey } = await overlay(agentDir, proxy.url, { orche: false });
      secrets = [apiKey];
      await mkdir(sessionDir, { recursive: true });
      const prompt = selectorPrompt(task, candidates);
      await writeFile(join(out, "prompt.txt"), prompt);
      const args = piArgs(undefined, THINKING.selector, ["--tools", "read,bash,grep,find,ls", "--mode", "json", "--session-id", `ab-${input.unit.replace(/[^A-Za-z0-9]+/g, "-")}`, prompt]);
      meta.pi = await runGuarded("pi", args, { cwd: dir, env: piEnv(process.env, agentDir, sessionDir, input.temp, proxy.url, apiKey, pathPrefix), stdout: join(out, "events.jsonl"), stderr: join(out, "stderr.txt"), guardMs: LIMITS.selectorGuardMs });
      const text = finalText(join(out, "events.jsonl"));
      choice = parseChoice(text, candidates.length);
      if (choice) { source = "selector"; reason = text.split("\n").filter(Boolean).at(-1)?.slice(0, 800) ?? ""; }
    } catch (error) { meta.selectorError = String(error).slice(0, 2000); }
    finally { proxy.child.kill("SIGTERM"); }
  }
  if (!choice) { choice = fallbackChoice(candidates); reason = "pre-registered fallback: the selector gave no valid choice"; }
  await cp(sessionDir, join(out, "sessions"), { recursive: true }).catch(() => undefined);
  meta.wire = summarizeWire(readJsonl<WireEntry>(join(out, "wire.jsonl")), { selector: THINKING.selector });
  const leaks: string[] = [];
  for (const file of jsonlFiles(join(out, "sessions"))) leaks.push(...leakHits(sessionToolCalls(await readFile(file, "utf8"))));
  meta.leakAudit = { hits: leaks };
  meta.selectionMs = Date.now() - started;
  // Seal the choice before any grade exists.
  const selection = { choice, source, reason, candidates, attempts: input.attempts.map(path => path.slice(path.lastIndexOf("/C/") + 1)), sealedAt: new Date().toISOString() };
  const seal = createHash("sha256").update(JSON.stringify(selection)).digest("hex");
  await write(join(out, "selection.json"), { ...selection, sha256: seal });
  meta.selection = { ...selection, sha256: seal };
  await save();

  // Grade every attempt (C's result = the chosen one; the others are the oracle reference).
  const graded: any[] = [];
  for (const [index, attempt] of input.attempts.entries()) {
    const attemptMeta = attemptsMeta[index];
    if (!attemptMeta.grade) {
      await gradeInto(task, join(attempt, "workspace-final"), attempt, attemptMeta);
      await write(join(attempt, "meta.json"), attemptMeta);
    }
    graded.push({ index: index + 1, terminal: attemptMeta.terminal, gradePassed: attemptMeta.grade?.passed, primaryPass: attemptMeta.primaryPass });
  }
  const chosen = attemptsMeta[choice - 1];
  meta.attempts = graded;
  meta.terminal = chosen.terminal;
  meta.grade = chosen.grade;
  meta.integrity = chosen.integrity;
  meta.primaryPass = primaryPass({ terminal: chosen.terminal, gradePassed: chosen.grade?.error ? undefined : chosen.grade?.passed, integrity: chosen.integrity });
  meta.oraclePass = graded.some(item => item.primaryPass);
  meta.redactedFiles = await redactTree(out, secrets);
  meta.finishedAt = Date.now();
  meta.status = "completed";
  await save();
  console.log(`SELECT ${input.unit}: choice ${choice} (${source}) primary ${meta.primaryPass} oracle ${meta.oraclePass}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input: SelectInput = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  try { await main(input); } finally { await rm(input.temp, { recursive: true, force: true }).catch(() => undefined); }
  process.exit(0);
}
