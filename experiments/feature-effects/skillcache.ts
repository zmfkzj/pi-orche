/**
 * SkillCache auto mode (pi-skillcache), measured with the provider's real engine (`createAutoEngine`) against a fixture project, with
 * every setting and cache file in a private scratch home (`PI_SKILLCACHE_HOME`), never the user's `~/.pi/agent/skillcache`.
 *
 * What it measures: the engine's own cold -> compile -> warm path (hit, miss, fallback, compile and replay times, injected bytes), the
 * fidelity of the replayed evidence against independent direct reads, the cases that must not compile or replay, and how often the
 * user's recorded workload could ever hit (exact prompt repeats with a compilable read-only trace). It does NOT measure what a model
 * does with the injected evidence: any "calls avoided" figure is the ceiling under a fixed consumer policy, not a measured saving, and
 * model tokens, cost and answer quality are not measured.
 *
 * The provider is the sibling development checkout (default `../pi-skillcache`, or `ORCHE_SKILLCACHE_DIR`), imported read-only.
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export interface AutoEngine {
  before(event: unknown, ctx: unknown): Promise<{ message: { customType: string; content: string } } | undefined>;
  toolCall(event: unknown, ctx: unknown): void;
  toolResult(event: unknown, ctx: unknown): void;
  settlement(event: unknown): void;
  settled(event: unknown, ctx: unknown): Promise<void>;
  metrics: { compiled: number; hits: number; misses: number; fallbacks: number; skipped: number };
}
export interface SkillCacheProvider {
  dir: string;
  revision?: string;
  createAutoEngine(options?: { now?: () => number }): AutoEngine;
  setAutoEnabled(cwd: string, enabled: boolean): Promise<boolean>;
  autoCacheStatus(cwd: string): Promise<{ enabled: boolean; count: number }>;
  compileToolCall(event: unknown): unknown;
  createSkillCacheExtension(options?: { trustedCwd?: string }): unknown;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROVIDER_DIR = resolve(HERE, "../../../pi-skillcache");

/** Load the provider's real modules, or undefined when the sibling checkout is absent. */
export async function loadProvider(dir = process.env.ORCHE_SKILLCACHE_DIR ?? DEFAULT_PROVIDER_DIR): Promise<SkillCacheProvider | undefined> {
  if (!existsSync(join(dir, "src", "auto.js")) || !existsSync(join(dir, "src", "extension.js"))) return undefined;
  const auto = await import(pathToFileURL(join(dir, "src", "auto.js")).href) as Record<string, unknown>;
  const extension = await import(pathToFileURL(join(dir, "src", "extension.js")).href) as Record<string, unknown>;
  return { dir, ...(auto as object), createSkillCacheExtension: extension.createSkillCacheExtension } as SkillCacheProvider;
}

/** Refuse to run unless the provider's state home is the given private directory (and not the user's agent home). */
export function assertScratchHome(home: string) {
  const configured = process.env.PI_SKILLCACHE_HOME;
  if (!configured || resolve(configured) !== resolve(home)) throw new Error(`PI_SKILLCACHE_HOME must be ${home} (is ${configured ?? "unset"})`);
  const userHome = resolve(process.env.HOME ?? "/nonexistent", ".pi", "agent");
  if (resolve(home) === userHome || resolve(home).startsWith(userHome + "/")) throw new Error("refusing to use the user's agent home");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixture project and traces.

export async function makeProject(root: string): Promise<string> {
  const cwd = join(root, "project");
  await rm(cwd, { recursive: true, force: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Demo\nSee docs/design.md.\nTODO: document the cache\n");
  await writeFile(join(cwd, "docs", "design.md"), Array.from({ length: 60 }, (_, i) => `Design line ${i}: the router keeps state ${i % 7}.`).join("\n") + "\n");
  await writeFile(join(cwd, "src", "app.ts"), Array.from({ length: 120 }, (_, i) => i % 15 === 0 ? `// TODO step ${i}` : `export const value${i} = ${i};`).join("\n") + "\n");
  await writeFile(join(cwd, "src", "util.ts"), "export const add = (a: number, b: number) => a + b;\n");
  return cwd;
}

export interface TraceCall { name: string; input: Record<string, unknown>; isError?: boolean; content?: unknown[] }

/** A representative read-only exploration: list, read, literal grep, plus a `find` the engine ignores (and never replays). */
export const EXPLORE_TRACE: TraceCall[] = [
  { name: "ls", input: { path: "." } },
  { name: "read", input: { path: "README.md" } },
  { name: "read", input: { path: "docs/design.md" } },
  { name: "ls", input: { path: "src" } },
  { name: "grep", input: { path: "src/app.ts", pattern: "TODO", literal: true } },
  { name: "find", input: { pattern: "*.ts" } },
];

/** The direct (independent) result of a traced call, from the file system. */
export async function direct(cwd: string, call: TraceCall): Promise<unknown> {
  const path = join(cwd, String(call.input.path ?? "."));
  if (call.name === "read") return { text: await readFile(path, "utf8") };
  if (call.name === "ls") return { names: (await readdir(path)).sort((a, b) => a.localeCompare(b)) };
  if (call.name === "grep") {
    const pattern = String(call.input.pattern);
    return { lines: (await readFile(path, "utf8")).split(/\r?\n/).flatMap((text, i) => text.includes(pattern) ? [i + 1] : []) };
  }
  return { ignored: call.name };
}

const ctxOf = (cwd: string, trusted = true) => ({ cwd, isProjectTrusted: () => trusted });

/** One agent run as Pi drives the engine: before_agent_start, every tool call/result, the settlement and agent_settled. */
export async function drive(engine: AutoEngine, cwd: string, prompt: string, trace: readonly TraceCall[], options: { trusted?: boolean; outcome?: string; aborted?: boolean } = {}) {
  const ctx = ctxOf(cwd, options.trusted ?? true);
  const t0 = performance.now();
  const replay = await engine.before({ messageType: "user", prompt }, ctx);
  const beforeMs = performance.now() - t0;
  for (const [index, call] of trace.entries()) {
    const event = { toolCallId: `call-${index}`, toolName: call.name, input: call.input };
    engine.toolCall(event, ctx);
    const content = call.content ?? [{ type: "text", text: JSON.stringify(await direct(cwd, call).catch(() => ({ error: true }))) }];
    engine.toolResult({ ...event, content, isError: call.isError === true }, ctx);
  }
  engine.settlement({ outcome: options.outcome ?? "completed" });
  const t1 = performance.now();
  await engine.settled({ aborted: options.aborted === true }, ctx);
  const settleMs = performance.now() - t1;
  return { replay, beforeMs, settleMs };
}

/** Compare replayed evidence with independent direct reads of the same files. */
export async function fidelity(cwd: string, content: string, trace: readonly TraceCall[]) {
  const json = content.split("\n").find(line => line.startsWith("{\"schema\"")) ?? "{}";
  const steps = (JSON.parse(json) as { steps?: Array<{ op: string; path: string; text?: string; entries?: Array<{ name: string }>; matches?: Array<{ line: number }> }> }).steps ?? [];
  const replayable = trace.filter(call => ["read", "ls", "grep"].includes(call.name));
  let agree = 0;
  for (const [index, call] of replayable.entries()) {
    const step = steps[index];
    const truth = await direct(cwd, call) as { text?: string; names?: string[]; lines?: number[] };
    if (!step) continue;
    if (call.name === "read" && step.text === truth.text) agree++;
    else if (call.name === "ls" && JSON.stringify(step.entries?.map(e => e.name)) === JSON.stringify(truth.names)) agree++;
    else if (call.name === "grep" && JSON.stringify(step.matches?.map(m => m.line)) === JSON.stringify(truth.lines)) agree++;
  }
  return { tracedCalls: trace.length, replayableCalls: replayable.length, replayedSteps: steps.length, agreeWithDirect: agree };
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]! * 1000) / 1000;
};
const stats = (values: number[]) => ({ n: values.length, median: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) });

// ---------------------------------------------------------------------------------------------------------------------------------
// The controlled benchmark.

export interface BenchOptions { home: string; repetitions?: number }

export async function runBench(provider: SkillCacheProvider, options: BenchOptions) {
  assertScratchHome(options.home);
  const reps = options.repetitions ?? 30;
  const cwd = await makeProject(join(options.home, "fixture"));
  const offCwd = await makeProject(join(options.home, "fixture-off"));
  await provider.setAutoEnabled(cwd, true);
  const prompt = "Explain how the router keeps state and list the TODOs in src/app.ts";

  // Cold: the first run misses and compiles at settle.
  const coldEngine = provider.createAutoEngine();
  const cold = await drive(coldEngine, cwd, prompt, EXPLORE_TRACE);
  // Warm: a new session (new engine) with the identical prompt gets the replay before the model's first request.
  const warmEngine = provider.createAutoEngine();
  const warm = await warmEngine.before({ messageType: "user", prompt }, ctxOf(cwd));
  const warmContent = warm?.message.content ?? "";
  const check = warm ? await fidelity(cwd, warmContent, EXPLORE_TRACE) : undefined;
  const rawToolOutputBytes = (await Promise.all(EXPLORE_TRACE.map(call => direct(cwd, call)))).reduce<number>((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);

  // Timing: interleaved, rotating order (off / miss / hit) to spread warm-up and file-cache effects over the arms.
  const timing: Record<"off" | "miss" | "hit", number[]> = { off: [], miss: [], hit: [] };
  const injected: number[] = [];
  const arms = ["off", "miss", "hit"] as const;
  for (let rep = 0; rep < reps; rep++) {
    for (let k = 0; k < arms.length; k++) {
      const arm = arms[(rep + k) % arms.length]!;
      const engine = provider.createAutoEngine();
      const target = arm === "off" ? offCwd : cwd;
      const text = arm === "miss" ? `${prompt} (variant ${rep})` : prompt;
      const start = performance.now();
      const result = await engine.before({ messageType: "user", prompt: text }, ctxOf(target));
      timing[arm].push(performance.now() - start);
      if (arm === "hit") {
        if (!result) throw new Error("warm hit expected");
        injected.push(Buffer.byteLength(result.message.content));
      } else if (result) throw new Error(`no replay expected for ${arm}`);
    }
  }
  // Cold compile cost at agent_settled, over fresh prompts (each a new compiled record).
  const compile: number[] = [];
  for (let rep = 0; rep < Math.min(reps, 20); rep++) {
    const engine = provider.createAutoEngine();
    const run = await drive(engine, cwd, `${prompt} #compile-${rep}`, EXPLORE_TRACE);
    if (engine.metrics.compiled !== 1) throw new Error("compile expected");
    compile.push(run.settleMs);
  }

  return {
    provider: { dir: provider.dir },
    conditions: { repetitions: reps, compileRepetitions: compile.length, independentScenarios: 1, trace: EXPLORE_TRACE.map(call => call.name), node: process.version },
    functional: {
      coldHit: !!cold.replay, coldCompiled: coldEngine.metrics.compiled, warmHit: !!warm,
      fidelity: check, injectedBytes: Buffer.byteLength(warmContent), rawToolOutputBytes,
    },
    timingMs: { beforeOff: stats(timing.off), beforeMiss: stats(timing.miss), beforeHit: stats(timing.hit), compileAtSettle: stats(compile) },
    injectedBytes: stats(injected),
    /** NOT a measurement of a model: the traced calls a consumer that fully trusts the replay could skip on an exact repeat. */
    fixedPolicyCallCeiling: check ? { replayedCalls: check.replayedSteps, tracedCalls: check.tracedCalls } : undefined,
  };
}

export interface NegativeResult { case: string; compiled: number; hit: boolean; fallbacks: number; note: string }

/** Cases that must not compile or must not replay; each runs on its own fresh fixture project. */
export async function runNegatives(provider: SkillCacheProvider, options: BenchOptions): Promise<NegativeResult[]> {
  assertScratchHome(options.home);
  const results: NegativeResult[] = [];
  const base = "Summarise the design and the TODOs";
  let n = 0;
  const twice = async (label: string, note: string, trace: readonly TraceCall[], options2: {
    mutate?: (cwd: string) => Promise<void>; second?: { prompt?: string; trusted?: boolean; now?: () => number }; first?: { outcome?: string; aborted?: boolean; prompt?: string };
  } = {}) => {
    const cwd = await makeProject(join(options.home, `neg-${n++}`));
    await provider.setAutoEnabled(cwd, true);
    const a = provider.createAutoEngine();
    await drive(a, cwd, options2.first?.prompt ?? base, trace, options2.first ?? {});
    if (options2.mutate) await options2.mutate(cwd);
    const b = provider.createAutoEngine(options2.second?.now ? { now: options2.second.now } : {});
    const replay = await b.before({ messageType: "user", prompt: options2.second?.prompt ?? options2.first?.prompt ?? base }, ctxOf(cwd, options2.second?.trusted ?? true));
    results.push({ case: label, compiled: a.metrics.compiled, hit: !!replay, fallbacks: b.metrics.fallbacks, note });
  };
  await twice("control: identical prompt, unchanged files", "positive control", EXPLORE_TRACE);
  await twice("prompt differs by one trailing space", "exact-match key (HMAC of the prompt)", EXPLORE_TRACE, { second: { prompt: base + " " } });
  await twice("traced file edited after compile", "file guard mismatch -> fallback to the ordinary agent", EXPLORE_TRACE, { mutate: cwd => writeFile(join(cwd, "README.md"), "# Demo\nchanged\n") });
  await twice("file added to a listed directory", "directory guard mismatch -> fallback", EXPLORE_TRACE, { mutate: cwd => writeFile(join(cwd, "src", "new.ts"), "export {};\n") });
  await twice("record older than 14 days", "age bound -> fallback", EXPLORE_TRACE, { second: { now: () => Date.now() + 15 * 24 * 3600 * 1000 } });
  await twice("untrusted project on the second run", "no engagement without trust", EXPLORE_TRACE, { second: { trusted: false } });
  await twice("trace contains bash", "unsupported tool -> never compiled", [...EXPLORE_TRACE, { name: "bash", input: { command: "cat README.md" } }]);
  await twice("trace contains an edit", "mutating tool -> never compiled", [...EXPLORE_TRACE, { name: "edit", input: { path: "src/util.ts", edits: [] } }]);
  await twice("read with offset/limit", "only whole-file reads compile", [{ name: "read", input: { path: "docs/design.md", offset: 10, limit: 20 } }]);
  await twice("regex grep", "only literal or word patterns compile", [{ name: "grep", input: { path: "src/app.ts", pattern: "TODO.*step" } }]);
  await twice("absolute path read", "only project-relative paths compile", [{ name: "read", input: { path: "/etc/hostname" } }]);
  await twice("a failed tool result", "errors are never compiled", [...EXPLORE_TRACE.slice(0, 2), { name: "read", input: { path: "missing.md" }, isError: true }]);
  await twice("aborted run", "only completed runs compile", EXPLORE_TRACE, { first: { outcome: "aborted", aborted: true } });
  await twice("only ignorable tools (find, diagnostics)", "nothing replayable -> nothing compiled", [{ name: "find", input: { pattern: "*.ts" } }, { name: "diagnostics", input: {} }]);
  await twice("prompt over 8 KB", "prompt size bound -> never engages", EXPLORE_TRACE, { first: { prompt: base + " " + "x".repeat(9000) } });
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Workload ceiling from the user's recorded sessions (aggregates only; no prompt text or tool output is stored).

const IGNORABLE = new Set(["task_plan", "report_result", "diagnostics", "find", "ast_search", "codegraph_explore"]); // pi-skillcache src/auto.js:18
const MAX_PROMPT_BYTES = 8 * 1024; // pi-skillcache src/auto.js:22
const MAX_TRACE_CALLS = 48; // pi-skillcache src/auto.js:17
const SAFE_AGE_MS = 14 * 24 * 3600 * 1000; // pi-skillcache src/auto.js:24

interface RecordedCall { name: string; input: unknown; isError: boolean; textOnly: boolean }
interface PromptRun { cwd: string; hash: string; bytes: number; time: number; calls: number; compilable: boolean; reason: string }

/** Mirror of the engine's trace acceptance (src/auto.js toolCall/toolResult/settled) on a recorded run, with the provider's compiler. */
export function traceVerdict(provider: SkillCacheProvider, calls: readonly RecordedCall[]): { compilable: boolean; reason: string } {
  if (!calls.length) return { compilable: false, reason: "no tool calls" };
  if (calls.length > MAX_TRACE_CALLS) return { compilable: false, reason: "more than 48 calls" };
  let steps = 0;
  for (const call of calls) {
    const step = provider.compileToolCall({ toolName: call.name, input: call.input });
    if (!step && !IGNORABLE.has(call.name)) return { compilable: false, reason: `uncompilable call: ${["bash", "edit", "write", "read", "grep", "ls"].includes(call.name) ? call.name : "other tool"}` };
    if (call.isError || !call.textOnly) return { compilable: false, reason: "failed or non-text result" };
    if (step) steps++;
  }
  return steps ? { compilable: true, reason: "compilable" } : { compilable: false, reason: "only ignorable calls" };
}

async function promptRuns(provider: SkillCacheProvider, file: string): Promise<PromptRun[]> {
  const runs: PromptRun[] = [];
  let cwd = "";
  let current: { hash: string; bytes: number; time: number; calls: RecordedCall[]; pending: Map<string, { name: string; input: unknown }> } | undefined;
  const close = () => {
    if (!current) return;
    runs.push({ cwd, hash: current.hash, bytes: current.bytes, time: current.time, calls: current.calls.length, ...traceVerdict(provider, current.calls) });
    current = undefined;
  };
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let entry: { type?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; timestamp?: number } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
    const message = entry.message;
    if (entry.type !== "message" || !message) continue;
    if (message.role === "user") {
      close();
      const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content as Array<{ type: string; text?: string }> : [];
      if (parts.some(part => part.type !== "text")) continue; // images: the engine never engages
      const text = parts.map(part => part.text ?? "").join("");
      if (!text.trim()) continue;
      current = { hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), time: Date.parse(entry.timestamp ?? "") || (message.timestamp ?? 0), calls: [], pending: new Map() };
    } else if (current && message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) if (part?.type === "toolCall" && part.id) current.pending.set(part.id, { name: part.name ?? "", input: part.arguments });
    } else if (current && message.role === "toolResult" && message.toolCallId) {
      const call = current.pending.get(message.toolCallId);
      const content = Array.isArray(message.content) ? message.content as Array<{ type: string }> : [];
      current.calls.push({ name: message.toolName ?? call?.name ?? "", input: call?.input, isError: message.isError === true, textOnly: content.every(part => part.type === "text") });
    }
  }
  close();
  return runs;
}

export function listJsonl(dir: string, filter: (path: string) => boolean = () => true, depth = 2): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) out.push(...listJsonl(path, filter, depth - 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && filter(path)) out.push(path);
  }
  return out;
}

/** Potential hits: a prompt (<= 8 KB) whose exact text ran earlier in the same cwd within 14 days with a compilable trace. */
export async function workload(provider: SkillCacheProvider, files: readonly string[]) {
  const runs: PromptRun[] = [];
  for (const file of files) runs.push(...await promptRuns(provider, file));
  runs.sort((a, b) => a.time - b.time);
  const seen = new Map<string, PromptRun[]>();
  let duplicates = 0, potentialHits = 0, small = 0, compilable = 0;
  const reasons = new Map<string, number>();
  for (const run of runs) {
    if (run.bytes <= MAX_PROMPT_BYTES) small++;
    if (run.compilable) compilable++;
    reasons.set(run.reason, (reasons.get(run.reason) ?? 0) + 1);
    const key = `${run.cwd}\0${run.hash}`;
    const earlier = seen.get(key) ?? [];
    if (earlier.length) duplicates++;
    if (run.bytes <= MAX_PROMPT_BYTES && earlier.some(prior => prior.compilable && run.time - prior.time <= SAFE_AGE_MS)) potentialHits++;
    seen.set(key, [...earlier, run]);
  }
  const pct = (x: number) => runs.length ? Math.round((x / runs.length) * 10000) / 100 : 0;
  return {
    files: files.length, prompts: runs.length,
    promptsWithin8KB: small, promptsWithin8KBPct: pct(small),
    compilableTraces: compilable, compilableTracesPct: pct(compilable),
    exactRepeatsSameCwd: duplicates, exactRepeatsPct: pct(duplicates),
    potentialHits, potentialHitsPct: pct(potentialHits),
    traceVerdicts: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])),
    medianPromptBytes: quantile(runs.map(run => run.bytes), 0.5),
  };
}

export const isWorkerTranscript = (path: string) => /^W\d+-/.test(basename(path));
