/**
 * Session runtime of the delivery-only validation (results/delivery-validation/protocol.md). Experiment-local: it reuses leaf helpers
 * of the earlier studies (sandbox, logging proxy, model-identity guard, catalogue filtering) without changing them, and keeps every
 * essential record in the result namespace (turn records, pins, provider copy); only agent directories holding credentials stay in
 * the worker scratch. Every turn is a fresh `pi` process (or a continuation of the same session id) in a bubblewrap sandbox with an
 * EMPTY working directory, pinned to one model at one thinking level; the guard refuses any other model before dispatch.
 *
 * Variants (DELIVERY_VARIANT, read once at import, before any entry point uses ROOT): `max` (default) is the completed study;
 * `effort-high` is its effort-only replication (results/delivery-validation-high/protocol.md): the measured turns (compose, audit,
 * revise, recheck and every fix continuation) run at thinking high, the instruments (judges, pairwise) stay at max, and the max
 * study's frozen inputs, pins and provider copy are read in place (never rewritten).
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { AGENT, HOME, NODE, REPO, agentDir, catalogEntries, readJsonl, runGuarded, sha, startProxy, write } from "./run.js";
import { contentHashes, hashDiff, piArgs, redact, sandboxEnv, sessionTranscripts, wireStats } from "./matrix.js";
import { Gate, treeHashes } from "./synthesis.js";
import { ROUTE_ALIASES, canonicalModel, catalogueIds, filterCatalogue, safeSandbox } from "./qualification-runtime.js";
import { json, listFiles, text } from "./qualification-inputs.js";
import { guardStats } from "./qualification-guard.mjs";

/** The completed max study and its effort-only replication; nothing else may be selected. */
export const VARIANTS = {
  max: { root: "results/delivery-validation", inputs: "results/delivery-validation", measuredEffort: "max", sessionPrefix: "dv", baseline: undefined },
  "effort-high": { root: "results/delivery-validation-high", inputs: "results/delivery-validation", measuredEffort: "high", sessionPrefix: "dvh", baseline: "results/delivery-validation" },
} as const;
export type VariantName = keyof typeof VARIANTS;
export function variantOf(name: string | undefined): { name: VariantName; root: string; inputs: string; measuredEffort: string; sessionPrefix: string; baseline?: string } {
  const key = name?.trim() || "max";
  if (!Object.hasOwn(VARIANTS, key)) throw new Error(`unknown DELIVERY_VARIANT ${key} (max | effort-high)`);
  return { name: key as VariantName, ...VARIANTS[key as VariantName] };
}
export const VARIANT = variantOf(process.env.DELIVERY_VARIANT);
export const ROOT = join(REPO, VARIANT.root);
/** Where the frozen inputs, pins and provider copy live: the max study's own files for both variants. */
export const INPUT_ROOT = join(REPO, VARIANT.inputs);
export const MODEL = "cliproxyapi/gpt-6-astra";
export const JUDGES = ["cliproxyapi/claude-opus-5-5", MODEL] as const;
/** Thinking level of the measured turns (compose, audit, revise, recheck and their fix continuations): the variant's only treatment. */
export const MEASURED_EFFORT: string = VARIANT.measuredEffort;
/** Thinking level of the instruments (judges, pairwise), unchanged across variants. */
export const INSTRUMENT_EFFORT = "max";
export const PINNED_IDS = ["gpt-6-astra", "claude-opus-5-5"];
export const MIN = 60_000;
/** Anti-loop time guards only (no money, request or output ceiling). */
export const GUARDS = { compose: 180 * MIN, audit: 150 * MIN, revise: 120 * MIN, recheck: 120 * MIN, fix: 60 * MIN, judge: 180 * MIN, pairwise: 120 * MIN };
/** Files whose hashes every measured or instrument turn records (the measured runtime). */
export const RUNTIME_SOURCES = ["delivery-runtime.ts", "delivery.ts", "delivery-render.mjs", "qualification-runtime.ts", "qualification-inputs.ts", "qualification-guard.mjs", "synthesis.ts", "run.ts", "matrix.ts", "proxy.mjs"];
const UPSTREAM_MODELS = "http://127.0.0.1:8317/v1/models?client_version=pi";
export const PROVIDER_SOURCE = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
export const PINS = join(INPUT_ROOT, "pins");
export const PROVIDER = join(INPUT_ROOT, "runtime/provider");
let study = "";
/** The worker scratch directory of this study (agent dirs with credentials, private sandbox dirs, full event streams). */
export const setStudy = (dir: string) => { study = dir; };
export const studyDir = () => { if (!study) throw new Error("study scratch directory not set"); return study; };
export const pool = new Gate(12);
export const sourceHashes = (): Record<string, string> => Object.fromEntries(RUNTIME_SOURCES.map(name => [name, sha(readFileSync(join(REPO, "experiments/mdsd-ab", name)))]));

/** Provider copy (read-only mount of every turn) inside the result namespace, and the scratch runtime mount point. */
export async function setup(scratch: string): Promise<void> {
  setStudy(scratch);
  await mkdir(join(scratch, "runtime/node_modules"), { recursive: true });
  if (VARIANT.baseline && !existsSync(PROVIDER)) throw new Error(`${PROVIDER} missing: the replication reads the max study's provider copy and never creates it`);
  if (!existsSync(PROVIDER)) { await mkdir(join(ROOT, "runtime"), { recursive: true }); await cp(PROVIDER_SOURCE, PROVIDER, { recursive: true }); }
}
/** Captures the upstream catalogue once and freezes the filtered response, catalogue cache and overrides (no credentials in them). */
export async function freezePins(): Promise<Record<string, string>> {
  if (existsSync(join(PINS, "pins.json"))) return json(join(PINS, "pins.json")).hashes;
  if (VARIANT.baseline) throw new Error(`${PINS}/pins.json missing: the replication reuses the max study's pins and never captures a new catalogue`);
  await mkdir(PINS, { recursive: true });
  const key = json(join(AGENT, "cliproxyapi.json")).apiKey;
  const response = await fetch(UPSTREAM_MODELS, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`catalogue capture failed: HTTP ${response.status}`);
  const captured = await response.json();
  const overrides = json(join(AGENT, "models.json")), mo = overrides?.providers?.cliproxyapi?.modelOverrides ?? {};
  const files: Record<string, string> = {
    "models-response.json": JSON.stringify(filterCatalogue(captured, PINNED_IDS)),
    "cliproxyapi-models.json": JSON.stringify(filterCatalogue(json(join(AGENT, "cliproxyapi-models.json")), PINNED_IDS), null, 2),
    "models.json": JSON.stringify({ ...overrides, providers: { ...overrides.providers, cliproxyapi: { ...overrides.providers?.cliproxyapi, modelOverrides: Object.fromEntries(Object.entries(mo).filter(([id]) => PINNED_IDS.includes(id))) } } }, null, 2),
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(PINS, name), body);
  const cache = catalogEntries(json(join(PINS, "cliproxyapi-models.json")));
  for (const id of PINNED_IDS) { const m = cache.find((e: any) => e.id === id); if (!m || m.thinkingLevelMap?.max !== "max" || !m.cost) throw new Error(`${id}: pinned cache lacks max thinking or price`); }
  const hashes = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha(body)]));
  await write(join(PINS, "pins.json"), { capturedAt: new Date().toISOString(), from: UPSTREAM_MODELS, upstreamIds: catalogueIds(captured).length, aliasesDropped: catalogueIds(captured).filter(id => !PINNED_IDS.includes(id) && PINNED_IDS.some(p => id.endsWith(`/${p}`))), ids: PINNED_IDS, hashes });
  return hashes;
}
/** Pinned files must match pins.json and, once frozen, the manifest. */
export function checkPins(): void {
  const pins = json(join(PINS, "pins.json"));
  const manifest = existsSync(join(ROOT, "manifest.json")) ? json(join(ROOT, "manifest.json")) : undefined;
  if (manifest && JSON.stringify(manifest.pins) !== JSON.stringify(pins.hashes)) throw new Error("pins.json differs from the frozen manifest");
  for (const [name, hash] of Object.entries(manifest?.pins ?? pins.hashes)) if (sha(readFileSync(join(PINS, name))) !== hash) throw new Error(`pinned ${name} changed`);
}
async function pinAgent(dir: string): Promise<void> {
  for (const name of ["cliproxyapi-models.json", "models.json"]) await copyFile(join(PINS, name), join(dir, name));
  const ids = catalogueIds(json(join(dir, "cliproxyapi-models.json")));
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...PINNED_IDS].sort())) throw new Error("agent catalogue is not the pinned catalogue");
}
function startGuardProcess(target: string, log: string, model: string): Promise<{ url: string; child: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [join(REPO, "experiments/mdsd-ab/qualification-guard.mjs"), "0", target, log, model, join(PINS, "models-response.json"), (ROUTE_ALIASES[model] ?? []).join(",")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`guard did not start: ${out}`)); }, 15_000);
    child.stdout!.on("data", chunk => { out += String(chunk); const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${m[1]}`, child }); } });
    child.stderr!.on("data", chunk => { out += String(chunk); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`guard exited ${code}: ${out}`)); });
  });
}
export interface Turn { label: string; number: number; record: string; ok: boolean; technical: string[]; startedAt: string; endedAt: string; ms: number; reply: string; model: string; thinking: string; promptSha256: string; inputHashes: Record<string, string>; outputHashes: Record<string, string>; sourceHashes: Record<string, string>; routeOk: boolean; responseModels: string[]; target: any; inputsAfter: any; wire: any; eventCostUSD: number; pi: any; finalStop: string; stopReasons: string[]; providerErrors: string[]; identity: any; interrupted?: boolean }
export interface TurnSpec { session: string; record: string; label: string; number: number; model: string; effort: string; prompt: string; inputs: Record<string, string>; guard: number; pinModel?: string }
/** Pi's argument vector with the turn's thinking level (matrix.piArgs always passes the shared default, max). */
export function withThinking(argv: string[], effort: string): string[] {
  const i = argv.indexOf("--thinking");
  if (i < 0 || i + 1 >= argv.length) throw new Error("pi arguments have no --thinking value");
  return [...argv.slice(0, i + 1), effort, ...argv.slice(i + 2)];
}
/**
 * Effort identity of one turn: every request and every mid-conversation configuration update at the turn's effort (Claude turns: model
 * identity only on the wire, as in the max study), and every thinking level of the session transcript.
 */
export function effortOk(wire: any[], thinking: string[], effort: string, claude: boolean): boolean {
  return wire.every(e => claude || (e.effort === effort && (e.updateEfforts ?? []).every((x: string) => x === effort))) && thinking.every(t => t === effort);
}
/** The sandbox agent's settings default follows the turn's thinking level too (no-op at max, the shared default). */
async function alignThinking(dir: string, effort: string): Promise<void> {
  const settings = json(join(dir, "settings.json"));
  if (settings.defaultThinkingLevel !== effort) await write(join(dir, "settings.json"), { ...settings, defaultThinkingLevel: effort });
}
/** completed (result.json), interrupted (started without result), queued, fresh — judged from the RESULT record, not the scratch. */
export function stateOf(record: string): "fresh" | "queued" | "completed" | "interrupted" {
  if (existsSync(join(record, "result.json"))) return "completed";
  if (!existsSync(join(record, "meta.json"))) return "fresh";
  return json(join(record, "meta.json")).startedAt ? "interrupted" : "queued";
}
export const outputOf = (t: Turn, file: string): string => existsSync(join(t.record, "outputs", file)) ? text(join(t.record, "outputs", file)) : "";
export function verifyCached(t: Turn, spec: TurnSpec): void {
  if (sha(spec.prompt) !== t.promptSha256 || JSON.stringify(Object.fromEntries(Object.entries(spec.inputs).map(([n, v]) => [n, sha(v)]))) !== JSON.stringify(t.inputHashes)) throw new Error(`cached turn prompt/input mismatch: ${t.record}`);
  if (t.model !== spec.model || t.thinking !== spec.effort) throw new Error(`cached turn ran ${t.model}/${t.thinking}, not ${spec.model}/${spec.effort}: ${t.record}`);
  if (JSON.stringify(t.sourceHashes) !== JSON.stringify(sourceHashes())) throw new Error(`measured runtime changed after turn ${t.record}`);
  for (const [file, hash] of Object.entries(t.outputHashes)) if (sha(readFileSync(join(t.record, "outputs", file))) !== hash) throw new Error(`cached output changed: ${t.record}/${file}`);
}
/** One turn. The caller decides what a technical failure means for its cell; nothing here reruns anything. */
export async function turn(spec: TurnSpec): Promise<Turn> {
  const record = join(spec.record, `turn-${spec.number}`), scratchTurn = join(spec.session, `turn-${spec.number}`), state = stateOf(record);
  if (state === "completed") { const done: Turn = json(join(record, "result.json")); verifyCached(done, spec); return done; }
  if (state === "interrupted") return { ...json(join(record, "meta.json")), record, ok: false, interrupted: true, technical: ["interrupted (started without a result; never rerun in place)"] } as Turn;
  await mkdir(record, { recursive: true });
  if (state === "fresh") await write(join(record, "meta.json"), { queuedAt: new Date().toISOString(), label: spec.label, number: spec.number });
  return pool.run(async () => {
    const scratch = join(spec.session, "private"), target = join(spec.session, "target");
    for (const sub of ["input", "work", "tmp", "out"]) await mkdir(join(scratch, sub), { recursive: true });
    for (const [name, body] of Object.entries(spec.inputs)) { if (name.includes("..") || name.includes("/")) throw new Error("input filename traversal"); await writeFile(join(scratch, "input", name), body); }
    await mkdir(target, { recursive: true });
    if (!existsSync(join(spec.session, "target-before.json"))) await write(join(spec.session, "target-before.json"), contentHashes(target));
    const inputsBefore = contentHashes(join(scratch, "input"));
    checkPins();
    const catalog = catalogEntries(json(join(PINS, "cliproxyapi-models.json"))), id = spec.model.split("/")[1]!;
    const selected = catalog.find((m: any) => m.id === id);
    if (!selected || selected.thinkingLevelMap?.[spec.effort] !== spec.effort) throw new Error(`${spec.model}: not pinned or ${spec.effort} unsupported; no downgrade`);
    await mkdir(scratchTurn, { recursive: true });
    await write(join(scratchTurn, "envelope.json"), { prices: Object.fromEntries(catalog.map((m: any) => [m.id, m.cost])) });
    const proxy = await startProxy(join(scratchTurn, "wire.jsonl"), join(scratchTurn, "envelope.json"));
    let guardProc: { url: string; child: any } | undefined, agent!: Awaited<ReturnType<typeof agentDir>>, startedAt = "", pi: any;
    const inputHashes = Object.fromEntries(Object.entries(spec.inputs).map(([n, v]) => [n, sha(v)]));
    const sessionId = `${VARIANT.sessionPrefix}-${spec.label.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    try {
      // pinModel exists only for the fail-closed preflight: the guard then expects a different model than Pi requests.
      guardProc = await startGuardProcess(proxy.url, join(scratchTurn, "guard.jsonl"), (spec.pinModel ?? spec.model).split("/")[1]!);
      agent = await agentDir(spec.session, guardProc.url, { routes: {} });
      await pinAgent(agent.dir);
      await alignThinking(agent.dir, spec.effort);
      const argv = [...safeSandbox({ agent: agent.dir, target, runtime: join(studyDir(), "runtime"), provider: PROVIDER, scratch, mount: join(HOME, "work"), extra: [], targetNodeModules: false }), "--", ...withThinking(piArgs(spec.model, sessionId, spec.prompt, false), spec.effort)];
      // --no-approve declines project trust; it is not an execution-approval bypass. Context-file discovery is disabled too.
      argv.splice(argv.length - 1, 0, "--no-context-files");
      startedAt = new Date().toISOString();
      await write(join(record, "meta.json"), { startedAt, label: spec.label, number: spec.number, model: spec.model, pinnedTo: spec.pinModel ?? spec.model, thinking: spec.effort, sessionId, promptSha256: sha(spec.prompt), inputHashes, sourceHashes: sourceHashes(), pid: process.pid });
      await writeFile(join(record, "prompt.md"), spec.prompt);
      console.log(`${startedAt} start ${spec.label}/${spec.number} ${spec.model}`);
      pi = await runGuarded("bwrap", argv, { env: sandboxEnv(guardProc.url, agent.apiKey), stdout: join(scratchTurn, "events.jsonl"), stderr: join(scratchTurn, "stderr.txt"), guardMs: spec.guard });
    } finally { guardProc?.child.kill("SIGTERM"); proxy.child.kill("SIGTERM"); }
    const guardLog = guardStats(join(scratchTurn, "guard.jsonl"));
    const cacheAfter = existsSync(join(agent.dir, "cliproxyapi-models.json")) ? catalogueIds(json(join(agent.dir, "cliproxyapi-models.json"))) : [];
    const pinnedSession = guardLog.refused === 0 && guardLog.models > 0 && cacheAfter.every(m => PINNED_IDS.includes(m));
    const events = readJsonl(join(scratchTurn, "events.jsonl")), ends = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    const wire = readJsonl(join(scratchTurn, "wire.jsonl")).filter(e => e.method === "POST" && e.model), stats = wireStats(wire);
    const responseModels = [...new Set(ends.map(e => `${e.message.provider}/${e.message.model}`))];
    const transcript = [...sessionTranscripts(join(agent.dir, "sessions")).values()].find(s => s.id === sessionId);
    const claude = id.startsWith("claude");
    // Identity is compared after normalizing only the user-confirmed alias; the raw route names are kept (identity.routes).
    const routeOk = pinnedSession && ends.length > 0 && wire.length > 0 && wire.length === guardLog.forwarded && wire.every(e => canonicalModel(String(e.model)) === id) && responseModels.every(m => canonicalModel(m) === spec.model) && !!transcript && transcript.models.every(m => canonicalModel(m) === spec.model) && effortOk(wire, transcript.thinking, spec.effort, claude);
    const routes = { wire: [...new Set(wire.map(e => String(e.model)))], response: responseModels, transcript: transcript?.models ?? [] };
    const stopReasons = ends.map(e => String(e.message?.stopReason ?? "")), finalStop = stopReasons.at(-1) ?? "";
    const providerErrors = ends.filter(e => e.message?.stopReason === "error").map(e => String(e.message?.errorMessage ?? "").slice(0, 300));
    const reply = (ends.at(-1)?.message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    const targetDiff = hashDiff(json(join(spec.session, "target-before.json")), contentHashes(target));
    const inputsAfter = hashDiff(inputsBefore, contentHashes(join(scratch, "input")));
    const technical = [
      ...(pi?.code === 0 ? [] : [`exit ${pi?.code}${pi?.signal ? ` (${pi.signal})` : ""}`]), ...(pi?.guardFired ? ["time guard fired"] : []),
      ...(!finalStop || ["error", "aborted"].includes(finalStop) ? [`final stop ${finalStop || "none"}${providerErrors.length ? `: ${providerErrors.at(-1)}` : ""}`] : []),
      // The working directory is an empty directory (no repository); writes there are recorded in result.target, not a failure.
      ...(routeOk ? [] : ["route identity check failed"]), ...(inputsAfter.unchanged ? [] : ["read-only inputs changed"]), ...(transcript ? [] : ["no session transcript"]),
    ];
    await mkdir(join(record, "outputs"), { recursive: true });
    for (const sub of ["work", "out"]) for (const file of listFiles(join(scratch, sub))) { const dst = join(record, "outputs", file.slice(join(scratch, sub).length + 1)); await mkdir(join(dst, ".."), { recursive: true }); await cp(file, dst); }
    for (const name of ["envelope.json", "wire.jsonl", "wire.jsonl.totals.json", "guard.jsonl", "stderr.txt"]) if (existsSync(join(scratchTurn, name))) await copyFile(join(scratchTurn, name), join(record, name));
    await writeFile(join(record, "reply.md"), reply);
    await writeFile(join(record, "events.slim.jsonl"), events.filter(e => e.type !== "message_update").map(e => JSON.stringify(e)).join("\n"));
    // Credentials are redacted from every kept record BEFORE output hashes are taken (so a resumed turn verifies the kept bytes).
    await redact(record, agent.secrets);
    const keptReply = text(join(record, "reply.md"));
    const result: Turn = { label: spec.label, number: spec.number, record, ok: technical.length === 0, technical, startedAt, endedAt: new Date().toISOString(), ms: (pi?.endedAt ?? 0) - (pi?.startedAt ?? 0), reply: keptReply, model: spec.model, thinking: spec.effort, promptSha256: sha(spec.prompt), inputHashes, outputHashes: treeHashes(join(record, "outputs")), sourceHashes: sourceHashes(), routeOk, responseModels, target: { ...targetDiff, after: contentHashes(target) }, inputsAfter, wire: stats, eventCostUSD: ends.reduce((s, e) => s + (e.message?.usage?.cost?.total ?? 0), 0), pi, finalStop, stopReasons, providerErrors, identity: { guard: guardLog, cacheAfter, pinnedSession, routes, thinking: transcript?.thinking ?? [], aliasUsed: [...routes.wire, ...routes.response, ...routes.transcript].some(m => canonicalModel(m) !== m) } };
    await write(join(record, "result.json"), result);
    if (agent.secrets.some(s => s && readFileSync(join(record, "result.json"), "utf8").includes(s))) throw new Error(`credential in ${record}/result.json`);
    console.log(`${result.endedAt} done ${spec.label}/${spec.number} ok=${result.ok} $${stats.costUSD} ${Math.round(result.ms / 1000)}s${technical.length ? ` technical: ${technical.join("; ")}` : ""}`);
    return result;
  });
}
/** Copies a session's transcripts into its record (credentials redacted); the full event streams stay in scratch. */
export async function retainSession(session: string, record: string): Promise<void> {
  if (!existsSync(join(session, "agent/sessions"))) return;
  await mkdir(record, { recursive: true });
  await cp(join(session, "agent/sessions"), join(record, "sessions"), { recursive: true });
  await redact(join(record, "sessions"), secretsOf());
}
/** The credentials an agent directory can hold (CLIProxyAPI key, TypeSafe values), for redaction of kept records. */
export function secretsOf(): string[] {
  const out: string[] = [];
  try { out.push(String(json(join(AGENT, "cliproxyapi.json")).apiKey ?? "")); } catch { /* none */ }
  try { for (const item of Object.values(json(join(AGENT, "auth.json")) as Record<string, any>)) if (item && typeof item === "object") for (const value of Object.values(item)) if (typeof value === "string" && value.length > 12) out.push(value); } catch { /* none */ }
  return out.filter(Boolean);
}
export const providerHashes = () => treeHashes(PROVIDER);
