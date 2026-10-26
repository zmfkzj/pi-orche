/**
 * Private session runtime for qualification validation (technical retry 1); preserves every physical attempt and hides all host /tmp.
 * Model identity is pinned for the whole staged session lifecycle: every turn's provider sees the frozen filtered catalogue (pinned/),
 * served by qualification-guard.mjs, which also refuses any request for another model before it leaves the machine.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT, HOME, NODE, PI_CLI, REPO, TARGET_MOUNT, agentDir, catalogEntries, readJsonl, runGuarded, sandboxArgs, sha, startProxy, write } from "./run.js";
import { contentHashes, hashDiff, piArgs, redact, sandboxEnv, sessionTranscripts, snapshot, wireStats } from "./matrix.js";
import { Gate, treeHashes } from "./synthesis.js";
import { FIRST, ROOT, json, listFiles, text } from "./qualification-inputs.js";
import { guardStats } from "./qualification-guard.mjs";
export const MODEL = "cliproxyapi/gpt-6-astra";
export const JUDGES = ["cliproxyapi/claude-opus-5-5", MODEL];
export const MIN = 60_000;
export const guards = { prepare: 180 * MIN, compose: 180 * MIN, audit: 150 * MIN, repair: 120 * MIN, recheck: 120 * MIN, fix: 60 * MIN, judge: 180 * MIN };
export const runtimeSources = ["qualification-inputs.ts", "qualification-runtime.ts", "qualification.ts", "qualification-guard.mjs", "synthesis.ts", "run.ts", "matrix.ts", "proxy.mjs"];
/**
 * User-confirmed route aliases of the same model (clarification relayed by main 2026-10-18, retry-protocol-addendum-1.md): only
 * bts/gpt-6-astra = gpt-6-astra. Raw route names stay in every record; only identity comparisons are normalized.
 */
export const ROUTE_ALIASES: Record<string, string[]> = { "gpt-6-astra": ["bts/gpt-6-astra"] };
/** Canonical model identity for comparisons ("cliproxyapi/bts/gpt-6-astra" -> "cliproxyapi/gpt-6-astra"); nothing else changes. */
export const canonicalModel = (id: string) => id.replace(/(^|\/)bts\/gpt-6-astra$/, "$1gpt-6-astra");
/** The only model ids any session of this study may see or call. */
export const PINNED_IDS = [MODEL, ...JUDGES].map(m => m.split("/")[1]!).filter((id, i, all) => all.indexOf(id) === i);
const UPSTREAM_MODELS = "http://127.0.0.1:8317/v1/models?client_version=pi";
const providerSource = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
let study = "";
export const setStudy = (dir: string) => { study = dir; };
const pool = new Gate(16);
export function safeSandbox(paths: Parameters<typeof sandboxArgs>[0]): string[] {
  const args = sandboxArgs(paths);
  const at = args.indexOf(paths.scratch) - 1;
  if (at < 0 || args[at] !== "--bind") throw new Error("private scratch bind not found");
  args.splice(at, 0, "--tmpfs", "/tmp");
  // Read-only input mount; private work/tmp/out remain writable.
  args.push("--ro-bind", join(paths.scratch, "input"), "/tmp/pi-orche/input");
  return args;
}
export const sourceHashes = () => Object.fromEntries(runtimeSources.map(name => [name, sha(readFileSync(join(REPO, "experiments/mdsd-ab", name)))]));
export function stateOf(dir: string): "fresh" | "queued" | "completed" | "interrupted" {
  if (existsSync(join(dir, "result.json"))) return "completed";
  if (!existsSync(join(dir, "meta.json"))) return "fresh";
  return json(join(dir, "meta.json")).startedAt ? "interrupted" : "queued";
}
export interface Turn { identity?: any; finalStop?: string; stopReasons?: string[]; providerErrors?: string[]; dir: string; label: string; number: number; ok: boolean; startedAt: string; endedAt: string; ms: number; reply: string; model: string; thinking: string; promptSha256: string; inputHashes: Record<string, string>; outputHashes: Record<string, string>; sourceHashes: Record<string, string>; routeOk: boolean; responseModels: string[]; target: any; wire: any; eventCostUSD: number; pi: any }
export async function setup(studyDir: string): Promise<void> {
  setStudy(studyDir);
  await mkdir(join(study, "runtime/node_modules"), { recursive: true });
  if (!existsSync(join(study, "provider"))) await cp(providerSource, join(study, "provider"), { recursive: true });
}
export const pinDir = () => join(study, "pinned");
/** Model ids listed in a catalogue response or cache file ("models" or "data" arrays). */
export function catalogueIds(value: any): string[] { return (value?.models ?? value?.data ?? []).map((m: any) => String(m.id ?? m.slug)); }
/** Keeps exactly the pinned ids; throws when one is missing (no fallback to an alias). */
export function filterCatalogue(value: any, ids = PINNED_IDS): any {
  const key = Array.isArray(value?.models) ? "models" : "data";
  const kept = (value?.[key] ?? []).filter((m: any) => ids.includes(String(m.id ?? m.slug)));
  for (const id of ids) if (!kept.some((m: any) => String(m.id ?? m.slug) === id)) throw new Error(`pinned model ${id} missing from the catalogue`);
  const out = { ...value, [key]: kept };
  if (Array.isArray(value?.fastModelIds)) out.fastModelIds = value.fastModelIds.filter((id: string) => ids.includes(id));
  return out;
}
/** Captures the upstream catalogue once and freezes the filtered response, cache file and overrides for every later turn. */
export async function freezePins(studyDir: string): Promise<Record<string, string>> {
  setStudy(studyDir);
  if (existsSync(join(pinDir(), "pins.json"))) return json(join(pinDir(), "pins.json")).hashes;
  await mkdir(pinDir(), { recursive: true });
  const key = json(join(AGENT, "cliproxyapi.json")).apiKey;
  const response = await fetch(UPSTREAM_MODELS, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`catalogue capture failed: HTTP ${response.status}`);
  const captured = await response.json();
  const files: Record<string, string> = {
    "models-response.json": JSON.stringify(filterCatalogue(captured)),
    "cliproxyapi-models.json": JSON.stringify(filterCatalogue(json(join(AGENT, "cliproxyapi-models.json"))), null, 2),
  };
  const overrides = json(join(AGENT, "models.json"));
  const mo = overrides?.providers?.cliproxyapi?.modelOverrides ?? {};
  files["models.json"] = JSON.stringify({ ...overrides, providers: { ...overrides.providers, cliproxyapi: { ...overrides.providers?.cliproxyapi, modelOverrides: Object.fromEntries(Object.entries(mo).filter(([id]) => PINNED_IDS.includes(id))) } } }, null, 2);
  for (const [name, body] of Object.entries(files)) await writeFile(join(pinDir(), name), body);
  const cache = catalogEntries(json(join(pinDir(), "cliproxyapi-models.json")));
  for (const id of PINNED_IDS) { const m = cache.find((e: any) => e.id === id); if (!m || m.thinkingLevelMap?.max !== "max" || !m.cost) throw new Error(`${id}: pinned cache lacks max thinking or price`); }
  const hashes = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha(body)]));
  await write(join(pinDir(), "pins.json"), { capturedAt: new Date().toISOString(), from: UPSTREAM_MODELS, upstreamIds: catalogueIds(captured).length, aliasesDropped: catalogueIds(captured).filter(id => !PINNED_IDS.includes(id) && PINNED_IDS.some(p => id.endsWith(`/${p}`))), ids: PINNED_IDS, hashes });
  return hashes;
}
/** Pinned files must match pins.json and, once frozen, the manifest (the manifest is the authority, pins.json is only a scratch record). */
export function checkPins(): void {
  const pins = json(join(pinDir(), "pins.json"));
  const manifest = existsSync(join(ROOT, "manifest.json")) ? json(join(ROOT, "manifest.json")) : undefined;
  if (manifest && JSON.stringify(manifest.pins) !== JSON.stringify(pins.hashes)) throw new Error("pins.json differs from the frozen manifest");
  for (const [name, hash] of Object.entries(manifest?.pins ?? pins.hashes)) if (sha(readFileSync(join(pinDir(), name))) !== hash) throw new Error(`pinned ${name} changed`);
}
export async function startGuardProcess(target: string, log: string, model: string): Promise<{ url: string; child: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [join(REPO, "experiments/mdsd-ab/qualification-guard.mjs"), "0", target, log, model, join(pinDir(), "models-response.json"), (ROUTE_ALIASES[model] ?? []).join(",")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`guard did not start: ${out}`)); }, 15_000);
    child.stdout!.on("data", chunk => { out += String(chunk); const m = /PORT (\d+)/.exec(out); if (m) { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${m[1]}`, child }); } });
    child.stderr!.on("data", chunk => { out += String(chunk); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`guard exited ${code}: ${out}`)); });
  });
}
/** Puts the frozen catalogue files into a session's agent dir (overwriting agentDir's copies of the live files) and checks them. */
export async function pinAgent(agentDirPath: string): Promise<void> {
  for (const name of ["cliproxyapi-models.json", "models.json"]) await copyFile(join(pinDir(), name), join(agentDirPath, name));
  const ids = catalogueIds(json(join(agentDirPath, "cliproxyapi-models.json")));
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...PINNED_IDS].sort())) throw new Error("agent catalogue is not the pinned catalogue");
}
export async function targetFor(dir: string, kind: string): Promise<any> {
  if (existsSync(join(dir, "target.json"))) return json(join(dir, "target.json"));
  let t: any;
  if (kind === "dev" || kind === "toy") { const s = await snapshot(dir, kind === "toy"); t = { dir: s.dir, mount: TARGET_MOUNT, extra: [], targetNodeModules: true }; }
  else if (kind === "isort") {
    const cache = join(REPO, "results/advisor-reviewer/cache/swe/pycqa__isort-2491");
    await cp(join(cache, "src"), join(dir, "target"), { recursive: true });
    t = { dir: join(dir, "target"), mount: join(HOME, "Code/isort"), extra: ["--ro-bind", join(cache, "venv"), join(HOME, ".venvs/isort")], targetNodeModules: false };
  } else { await mkdir(join(dir, "target"), { recursive: true }); t = { dir: join(dir, "target"), mount: join(HOME, "work"), extra: [], targetNodeModules: false }; }
  await write(join(dir, "target.json"), t); await write(join(dir, "target-before.json"), contentHashes(t.dir)); return t;
}
export const readOutput = (turn: Turn, file: string): string => existsSync(join(turn.dir, "outputs", file)) ? text(join(turn.dir, "outputs", file)) : "";
export function verifyCached(turn: Turn, prompt: string, inputs: Record<string, string>): void {
  if (sha(prompt) !== turn.promptSha256 || JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([n, v]) => [n, sha(v)]))) !== JSON.stringify(turn.inputHashes)) throw new Error("cached turn prompt/input mismatch");
  if (JSON.stringify(turn.sourceHashes) !== JSON.stringify(sourceHashes())) throw new Error("measured runtime changed after a turn");
  for (const [file, hash] of Object.entries(turn.outputHashes)) if (sha(readFileSync(join(turn.dir, "outputs", file))) !== hash) throw new Error(`cached output changed: ${file}`);
}
export async function turn(spec: { dir: string; label: string; number: number; model?: string; kind: string; prompt: string; inputs: Record<string, string>; guard: number; pinModel?: string }): Promise<Turn> {
  const tdir = join(spec.dir, `turn-${spec.number}`), state = stateOf(tdir);
  if (state === "completed") { const done: Turn = json(join(tdir, "result.json")); verifyCached(done, spec.prompt, spec.inputs); return done; }
  if (state === "interrupted") throw new Error(`INTERRUPTED attempt retained, no automatic rerun: ${tdir}`);
  await mkdir(tdir, { recursive: true });
  if (state === "fresh") await write(join(tdir, "meta.json"), { queuedAt: new Date().toISOString(), label: spec.label, number: spec.number });
  return pool.run(async () => {
    const scratch = join(spec.dir, "private");
    for (const sub of ["input", "work", "tmp", "out"]) await mkdir(join(scratch, sub), { recursive: true });
    for (const [name, body] of Object.entries(spec.inputs)) { if (name.includes("..") || name.includes("/")) throw new Error("input filename traversal"); await writeFile(join(scratch, "input", name), body); }
    const target = await targetFor(spec.dir, spec.kind), model = spec.model ?? MODEL;
    checkPins();
    const catalog = catalogEntries(json(join(pinDir(), "cliproxyapi-models.json")));
    const selected = catalog.find((m: any) => m.id === model.split("/")[1]);
    if (!selected || selected.thinkingLevelMap?.max !== "max") throw new Error(`${model}: not pinned or max unsupported; no downgrade`);
    await write(join(tdir, "envelope.json"), { prices: Object.fromEntries(catalog.map((m: any) => [m.id, m.cost])) });
    const proxy = await startProxy(join(tdir, "wire.jsonl"), join(tdir, "envelope.json"));
    let guardProc: { url: string; child: any } | undefined, agent!: Awaited<ReturnType<typeof agentDir>>, startedAt = "", inputHashes: Record<string, string> = {}, sessionId = "";
    let pi: any;
    try {
      // pinModel exists only for the fail-closed preflight: the guard then expects a different model than Pi requests.
      guardProc = await startGuardProcess(proxy.url, join(tdir, "guard.jsonl"), (spec.pinModel ?? model).split("/")[1]!);
      agent = await agentDir(spec.dir, guardProc.url, { routes: {} });
      await pinAgent(agent.dir);
      sessionId = `qual-${spec.label}`;
      const argv = [...safeSandbox({ agent: agent.dir, target: target.dir, runtime: join(study, "runtime"), provider: join(study, "provider"), scratch, mount: target.mount, extra: target.extra, targetNodeModules: target.targetNodeModules }), "--", ...piArgs(model, sessionId, spec.prompt, false)];
      // --no-approve declines project trust; it is not an execution-approval bypass. Disable snapshot context-file discovery too.
      argv.splice(argv.length - 1, 0, "--no-context-files");
      startedAt = new Date().toISOString(); inputHashes = Object.fromEntries(Object.entries(spec.inputs).map(([n, v]) => [n, sha(v)]));
      await write(join(tdir, "meta.json"), { startedAt, label: spec.label, number: spec.number, model, pinnedTo: (spec.pinModel ?? model), thinking: "max", sessionId, promptSha256: sha(spec.prompt), inputHashes, sourceHashes: sourceHashes(), pid: process.pid });
      await writeFile(join(tdir, "prompt.md"), spec.prompt);
      console.log(`${startedAt} start ${spec.label}/${spec.number} ${model}`);
      pi = await runGuarded("bwrap", argv, { env: sandboxEnv(guardProc.url, agent.apiKey), stdout: join(tdir, "events.jsonl"), stderr: join(tdir, "stderr.txt"), guardMs: spec.guard });
    } finally { guardProc?.child.kill("SIGTERM"); proxy.child.kill("SIGTERM"); }
    const guardLog = guardStats(join(tdir, "guard.jsonl"));
    const cacheAfter = existsSync(join(agent.dir, "cliproxyapi-models.json")) ? catalogueIds(json(join(agent.dir, "cliproxyapi-models.json"))) : [];
    const pinnedSession = guardLog.refused === 0 && guardLog.models > 0 && cacheAfter.every(id => PINNED_IDS.includes(id));
    const events = readJsonl(join(tdir, "events.jsonl")), ends = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    const wire = readJsonl(join(tdir, "wire.jsonl")).filter(e => e.method === "POST" && e.model), stats = wireStats(wire);
    const responseModels = [...new Set(ends.map(e => `${e.message.provider}/${e.message.model}`))];
    const transcript = [...sessionTranscripts(join(agent.dir, "sessions")).values()].find(s => s.id === sessionId);
    // Identity is compared after normalizing only the user-confirmed alias; the raw route names are kept (identity.routes).
    const routeOk = pinnedSession && ends.length > 0 && wire.length > 0 && wire.length === guardLog.forwarded && wire.every(e => canonicalModel(String(e.model)) === model.split("/")[1] && (model.includes("claude") || e.effort === "max")) && responseModels.every(m => canonicalModel(m) === model) && !!transcript && transcript.models.every(m => canonicalModel(m) === model) && transcript.thinking.every(t => t === "max");
    const routes = { wire: [...new Set(wire.map(e => String(e.model)))], response: responseModels, transcript: transcript?.models ?? [] };
    // A turn that the provider ended with an error (or that was aborted) is a technical failure, never a completed deliverable:
    // in the first attempt such truncated turns passed as ok and were sent to schema-fix continuations.
    const stopReasons = ends.map(e => String(e.message?.stopReason ?? "")), finalStop = stopReasons.at(-1) ?? "";
    const providerErrors = ends.filter(e => e.message?.stopReason === "error").map(e => String(e.message?.errorMessage ?? "").slice(0, 300));
    const completedNormally = !!finalStop && !["error", "aborted"].includes(finalStop);
    const reply = (ends.at(-1)?.message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    await mkdir(join(tdir, "outputs"), { recursive: true });
    for (const sub of ["work", "out"]) for (const file of listFiles(join(scratch, sub))) { const name = file.slice(join(scratch, sub).length + 1); const dst = join(tdir, "outputs", name); await mkdir(join(dst, ".."), { recursive: true }); await cp(file, dst); }
    await writeFile(join(tdir, "reply.md"), reply);
    await writeFile(join(tdir, "events.slim.jsonl"), events.filter(e => e.type !== "message_update").map(e => JSON.stringify(e)).join("\n"));
    const result: Turn = { dir: tdir, label: spec.label, number: spec.number, ok: pi.code === 0 && !pi.guardFired && routeOk && completedNormally, startedAt, endedAt: new Date().toISOString(), ms: pi.endedAt - pi.startedAt, reply, model, thinking: "max", promptSha256: sha(spec.prompt), inputHashes, outputHashes: treeHashes(join(tdir, "outputs")), sourceHashes: sourceHashes(), routeOk, responseModels, target: hashDiff(json(join(spec.dir, "target-before.json")), contentHashes(target.dir)), wire: stats, eventCostUSD: ends.reduce((s, e) => s + (e.message?.usage?.cost?.total ?? 0), 0), pi, finalStop, stopReasons, providerErrors, identity: { guard: guardLog, cacheAfter, pinnedSession, routes, aliasUsed: [...routes.wire, ...routes.response, ...routes.transcript].some(m => canonicalModel(m) !== m) } } as Turn;
    await write(join(tdir, "result.json"), result);
    await redact(tdir, agent.secrets);
    console.log(`${result.endedAt} done ${spec.label}/${spec.number} ok=${result.ok} $${stats.costUSD} ${Math.round(result.ms / 1000)}s`);
    return result;
  });
}
export async function retainSession(dir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const name of readdirSync(dir)) if (/^turn-\d+$/.test(name)) await cp(join(dir, name), join(dest, name), { recursive: true });
  if (existsSync(join(dir, "agent/sessions"))) await cp(join(dir, "agent/sessions"), join(dest, "sessions"), { recursive: true });
}
export async function freezeManifest(studyDir: string, prompts: Record<string, string>): Promise<void> {
  if (existsSync(join(ROOT, "manifest.json"))) throw new Error("manifest already frozen");
  // The retry may start only after a passed real preflight on the final runtime, with the frozen evaluation material in place.
  for (const file of ["preflight.json", "round2-instructions.md", "route-diagnosis.json", "retry-protocol-addendum-1.md", "first-attempt-reassessment.json"]) if (!existsSync(join(ROOT, file))) throw new Error(`${file} required before the manifest`);
  const preflight = json(join(ROOT, "preflight.json"));
  if (preflight.passed !== true || JSON.stringify(preflight.sourceHashes) !== JSON.stringify(sourceHashes())) throw new Error("preflight did not pass on the current runtime sources");
  await setup(studyDir);
  const pins = await freezePins(studyDir);
  const references = json(join(ROOT, "references-frozen.json"));
  const catalog = catalogEntries(json(join(pinDir(), "cliproxyapi-models.json")));
  const hashOf = (file: string) => sha(text(join(ROOT, file)));
  await write(join(ROOT, "manifest.json"), { frozenAt: new Date().toISOString(), attempt: "technical retry 1", firstAttempt: { root: "results/qualification-validation", manifestSha256: sha(text(join(FIRST, "manifest.json"))), technicalStopSha256: sha(text(join(FIRST, "technical-stop.json"))) }, sources: sourceHashes(), protocol: hashOf("protocol.md"), retryProtocol: hashOf("retry-protocol.md"), inputs: hashOf("inputs-frozen.json"), references, referencesSha256: hashOf("references-frozen.json"), preflightSha256: hashOf("preflight.json"), round2InstructionsSha256: hashOf("round2-instructions.md"), routeDiagnosisSha256: hashOf("route-diagnosis.json"), addendum1Sha256: hashOf("retry-protocol-addendum-1.md"), firstAttemptReassessmentSha256: hashOf("first-attempt-reassessment.json"), routeAliases: ROUTE_ALIASES, evaluationSha256: sha(readFileSync(join(REPO, "experiments/mdsd-ab/qualification-eval.ts"))), prompts: Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, sha(v)])), pins, provider: treeHashes(join(studyDir, "provider")), runtime: treeHashes(join(studyDir, "runtime")), runtimeNodeModules: treeHashes(join(REPO, "node_modules/@earendil-works/pi-ai")), piVersion: execFileSync(NODE, [PI_CLI, "--version"]).toString().trim(), piCliSha256: sha(readFileSync(PI_CLI)), models: catalog, liveConfig: sha(readFileSync(join(AGENT, "orche.config.json"))), dirty: execFileSync("git", ["status", "--porcelain=v1"]).toString(), guards });
}
