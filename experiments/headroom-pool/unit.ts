/**
 * One baseline calibration attempt of the headroom-pool study (experiments/headroom-pool/README.md "Baseline unit"): ordinary,
 * unmodified solving of one qualified case by Pi with cliproxyapi/gpt-6.1-sol at effort high.
 *   - Workspace: a fresh copy of the frozen pre-fix snapshot; `git init` + `git add -A` (no commit anywhere); the initial tree id.
 *   - Prompt: the frozen packet prompt (the issue verbatim in the earlier studies' ordinary instruction); no witness, no hint.
 *   - Sandbox (witness-replay sandbox.ts): no network except the bridge to this unit's proxy; /home, /tmp, /var/tmp, ... hidden;
 *     only the workspace (rw), the sealed venv and its Python install (ro), Node and Pi (ro) and the frozen provider (ro) are visible.
 *     The grader data, other cases, other units and the repository are not.
 *   - Unit proxy (witness-replay proxy.mjs, outside the sandbox): fails closed on any other model or effort, journals every request
 *     start before forwarding, verifies the response model, enforces CAL_BUDGET.maxRequests, substitutes the real key.
 *   - One Pi invocation under the wall-time guard CAL_BUDGET.wallMs; the attempt ends when Pi ends (no gate, no continuation).
 * Evidence goes to the attempt directory; meta.json is written last with status "completed". Scoring is score.ts (model-free).
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { AGENT, BRIDGE_MOUNT, BRIDGE_PORT, LAUNCH_MOUNT, NODE, NODE_DIR, PI_CLI, PI_MODULES, PLACEHOLDER_KEY, PROVIDER_MOUNT, SOCKET_MOUNT, dirDigest, pythonWrappers, writeJson } from "../witness-replay/env.js";
import { runSandboxed, type Bind } from "../witness-replay/sandbox.js";
import { copyCandidate, fileSha256, treeDigest } from "../witness-replay/witness-run.js";
import { CAL_BUDGET, EFFORT, MODEL_REF, classifyAttempt, piSettings, refusalSuspected, stopOf, type WireTotals } from "./protocol.js";

const WR = new URL("../witness-replay/", import.meta.url).pathname;

export interface FrozenCase {
  id: string; repo: string; pool: string; src: string; srcDigest: string; venv: string; venvDigest: string; pythonPath: string;
  pythonInstallDir: string; pythonSha256: string; pythonExecutable: string; prompt: { path: string; sha256: string };
  witness: { path: string; sha256: string }; testCmd: string;
}
export interface FrozenRuntime {
  upstream: string; route: { model: string; effort: string }; budget: { maxRequests: number; wallMs: number };
  piCli: { path: string; sha256: string; version: string }; node: { path: string; version: string; sha256: string }; piModules: { path: string; digest: string };
  provider: { dir: string; digest: string; version?: string }; catalog: { sha256: string; prices: Record<string, unknown> }; bwrap: string;
}
export interface AttemptInput { runtime: FrozenRuntime; c: FrozenCase; unit: string; attempt: number; outDir: string; scratch: string; checkModules?: boolean }

const now = () => Date.now();
/** Kill functions of every live unit proxy and sandbox process group (the driver stops them on SIGINT/SIGTERM). */
export const liveChildren = new Map<string, () => void>();

/** Frozen-input checks before a unit runs (a mismatch makes the attempt invalid without any model request). */
export function frozenChecks(runtime: FrozenRuntime, c: FrozenCase, checkModules = true): Record<string, boolean> {
  return {
    prompt: existsSync(c.prompt.path) && fileSha256(c.prompt.path) === c.prompt.sha256,
    snapshot: treeDigest(c.src) === c.srcDigest,
    venv: dirDigest(c.venv) === c.venvDigest,
    python: existsSync(c.pythonExecutable) && fileSha256(c.pythonExecutable) === c.pythonSha256,
    piCli: fileSha256(PI_CLI) === runtime.piCli.sha256,
    node: fileSha256(NODE) === runtime.node.sha256,
    piModules: !checkModules || dirDigest(PI_MODULES) === runtime.piModules.digest,
    provider: existsSync(join(runtime.provider.dir, "extensions/index.ts")) && providerDigest(runtime.provider.dir) === runtime.provider.digest,
  };
}

/** The frozen provider copy's digest as ultra-ho freezeProvider computes it (relative path + file sha256; FROZEN.json excluded). */
export function providerDigest(dir: string): string {
  const files: string[] = [];
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) { if (!/^(node_modules|\.git)$/.test(entry.name)) walk(child); } else if (entry.isFile()) files.push(child); } };
  if (existsSync(dir)) walk(dir);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const rel = relative(dir, file);
    if (rel !== "FROZEN.json") hash.update(`${rel}\0${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

interface ProxyHandle { child: ChildProcess; socket: string; log: string; totals: () => any }
/** Unix socket paths are limited to 107 bytes: a unit proxy listens on <HEADROOM_SOCKET_DIR>/<12 hex of its dir>.sock. */
export function socketPath(dir: string): string {
  const path = join(process.env.HEADROOM_SOCKET_DIR ?? dir, `${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.sock`);
  if (Buffer.byteLength(path) > 100) throw new Error(`unit proxy socket path is too long (${Buffer.byteLength(path)} bytes): ${path}; set HEADROOM_SOCKET_DIR to a short directory`);
  return path;
}
async function startUnitProxy(dir: string, outDir: string, runtime: FrozenRuntime): Promise<ProxyHandle> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const socket = socketPath(dir), keyFile = join(dir, "key"), envelope = join(dir, "envelope.json"), log = join(outDir, "wire.jsonl");
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  await rm(socket, { force: true });
  const connection = JSON.parse(readFileSync(join(AGENT, "cliproxyapi.json"), "utf8"));
  await writeFile(keyFile, String(connection.apiKey ?? ""), { mode: 0o600 });
  await writeJson(envelope, { route: runtime.route, maxRequests: runtime.budget.maxRequests, placeholderKey: PLACEHOLDER_KEY, prices: runtime.catalog.prices });
  const child = spawn(NODE, [join(WR, "proxy.mjs"), "--listen", socket, "--target", runtime.upstream, "--log", log, "--envelope", envelope, "--key-file", keyFile], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`proxy did not start: ${text}`)); }, 15_000);
      child.stdout!.on("data", chunk => { text += String(chunk); if (/LISTENING /.test(text)) { clearTimeout(timer); resolve(); } });
      child.stderr!.on("data", chunk => { text += String(chunk); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${text}`)); });
    });
  } finally { await rm(keyFile, { force: true }); }
  return { child, socket, log, totals: () => { try { return JSON.parse(readFileSync(`${log}.totals.json`, "utf8")); } catch { return {}; } } };
}

/** Wire totals in the protocol's shape (missing numbers are 0; unknown usage is kept as a count, never as zero cost). */
export function wireOf(totals: any): WireTotals {
  return {
    forwarded: totals.forwarded ?? 0, completed: totals.completed ?? 0, refusedRoute: totals.refused?.route ?? 0, refusedUnverifiable: totals.refused?.unverifiable ?? 0,
    refusedBudget: totals.refused?.budget ?? 0, providerErrors: totals.providerErrors ?? 0, offRouteResponses: totals.offRouteResponses ?? 0, unknownUsage: totals.unknownUsage ?? 0,
  };
}

/** Age (ms) at `endedAt` of the oldest request that started and never ended (wire.jsonl), 0 when none. */
export function inFlightAt(wireLog: string, endedAt: number): { count: number; oldestMs: number } {
  if (!existsSync(wireLog)) return { count: 0, oldestMs: 0 };
  const started = new Map<number, number>();
  for (const line of readFileSync(wireLog, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.phase === "start") started.set(entry.id, Date.parse(entry.at));
    else if (entry.phase === "end") started.delete(entry.id);
  }
  const ages = [...started.values()].map(at => endedAt - at);
  return { count: ages.length, oldestMs: ages.length ? Math.max(...ages) : 0 };
}

/** Text of the last assistant message of a Pi JSON event stream. */
export function finalText(events: string): string {
  let text = "";
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
    const content = event.message.content;
    text = Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") : String(content ?? "");
  }
  return text;
}

const LAUNCH = [
  "#!/bin/sh",
  "# headroom-pool sandbox launcher: the bridge to the unit proxy, then Pi.",
  `"$WR_NODE" ${BRIDGE_MOUNT} ${BRIDGE_PORT} ${SOCKET_MOUNT} "$WR_BRIDGE_READY" &`,
  'i=0; while [ ! -s "$WR_BRIDGE_READY" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done',
  'exec "$WR_NODE" "$@"', "",
].join("\n");

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => execFileSync("git", args, { cwd, ...(env ? { env } : {}), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 }).toString();

/** The final diff of a workspace against its initial tree (a private index; nothing is committed). */
export function finalDiff(workspace: string, initialTree: string, scratch: string): { tree: string; diff: Buffer; files: string[] } {
  const index = join(scratch, `final-index-${process.pid}-${now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(workspace, ["read-tree", initialTree], env);
    git(workspace, ["add", "-A", "--", ".", ":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/.pytest_cache/**", ":(exclude,glob)**/.hypothesis/**", ":(exclude,glob)**/.mypy_cache/**", ":(exclude,glob)**/.ruff_cache/**"], env);
    const tree = git(workspace, ["write-tree"], env).trim();
    const diff = execFileSync("git", ["diff", "--binary", initialTree, tree], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
    const files = git(workspace, ["diff", "--name-status", initialTree, tree]).split("\n").filter(Boolean);
    return { tree, diff, files };
  } finally { rmIndex(index); }
}
function rmIndex(path: string) { try { execFileSync("rm", ["-f", path]); } catch { /* gone */ } }

/** Run one attempt end to end; returns meta (also <outDir>/meta.json, written last). */
export async function runAttempt(input: AttemptInput & { commandOverride?: string[] }): Promise<any> {
  const { runtime, c, unit, attempt, outDir, scratch } = input;
  const meta: any = { unit, case: c.id, attempt, startedAt: new Date().toISOString(), status: "running", route: runtime.route, budget: runtime.budget };
  await mkdir(outDir, { recursive: true });
  await writeJson(join(outDir, "meta.json"), meta);
  meta.frozenChecks = frozenChecks(runtime, c, input.checkModules !== false);
  if (Object.values(meta.frozenChecks).some(ok => !ok)) {
    Object.assign(meta, { status: "completed", valid: false, invalid: "infrastructure", invalidDetail: `frozen input mismatch: ${JSON.stringify(meta.frozenChecks)}`, endedAt: new Date().toISOString() });
    await writeJson(join(outDir, "meta.json"), meta);
    return meta;
  }
  // Stage the sandbox.
  const box = join(scratch, "box"), ws = join(box, "ws"), agent = join(box, "agent"), sessions = join(box, "sessions"), home = join(box, "home"), tmp = join(box, "tmp"), bin = join(box, "bin");
  await rm(scratch, { recursive: true, force: true });
  for (const dir of [ws, agent, sessions, home, tmp, bin]) await mkdir(dir, { recursive: true });
  await copyCandidate(c.src, ws);
  execFileSync("chmod", ["-R", "u+w", ws]);
  meta.workspaceDigest = treeDigest(ws);
  if (meta.workspaceDigest !== c.srcDigest) throw new Error(`staged workspace digest ${meta.workspaceDigest} != frozen ${c.srcDigest}`);
  git(ws, ["init", "--quiet"]);
  git(ws, ["add", "-A"]);
  meta.initialTree = git(ws, ["write-tree"]).trim();
  await pythonWrappers(bin, c.venv, c.src, c.pythonPath, ws);
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) copyFileSync(join(AGENT, name), join(agent, name));
  const connection = JSON.parse(readFileSync(join(AGENT, "cliproxyapi.json"), "utf8"));
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  await writeFile(join(agent, "cliproxyapi.json"), JSON.stringify({ ...connection, apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl }), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), `${JSON.stringify(piSettings(), null, 2)}\n`);
  const harness = join(scratch, "harness");
  await mkdir(harness, { recursive: true });
  await writeFile(join(harness, "launch.sh"), LAUNCH, { mode: 0o555 });
  const prompt = readFileSync(c.prompt.path, "utf8");
  const proxy = await startUnitProxy(join(scratch, "proxy"), outDir, runtime);
  const proxyKey = `proxy-${unit}-${attempt}`, groupKey = `sandbox-${unit}-${attempt}`;
  liveChildren.set(proxyKey, () => proxy.child.kill("SIGKILL"));
  const sessionId = `hp-${unit}-a${attempt}`;
  meta.sessionId = sessionId;
  const binds: Bind[] = [
    { from: NODE_DIR }, { from: PI_MODULES }, { from: c.venv }, { from: c.pythonInstallDir }, { from: box, rw: true },
    { from: runtime.provider.dir, to: PROVIDER_MOUNT }, { from: join(WR, "bridge.mjs"), to: BRIDGE_MOUNT }, { from: join(harness, "launch.sh"), to: LAUNCH_MOUNT },
    { from: proxy.socket, to: SOCKET_MOUNT, rw: true },
  ];
  const env = {
    PATH: `${bin}:${NODE_DIR}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1",
    CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0", WR_NODE: NODE, WR_BRIDGE_READY: join(tmp, ".bridge-ready"),
  };
  const piArgs = [PI_CLI, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--offline",
    "-e", `${PROVIDER_MOUNT}/extensions/index.ts`, "--model", MODEL_REF, "--thinking", EFFORT, "--session-dir", sessions, "--session-id", sessionId, "--", prompt];
  const started = now();
  const events = join(outDir, "events.jsonl");
  let run: Awaited<ReturnType<typeof runSandboxed>>;
  try {
    run = await runSandboxed({ binds, env, cwd: ws, command: input.commandOverride ?? ["/bin/sh", LAUNCH_MOUNT, ...piArgs] }, { guardMs: runtime.budget.wallMs, stdout: events, stderr: join(outDir, "stderr.txt"), keep: 64 * 1024, onSpawn: pid => liveChildren.set(groupKey, () => process.kill(-pid, "SIGKILL")) });
  } finally {
    liveChildren.delete(groupKey);
    proxy.child.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 500));
    if (proxy.child.exitCode === null) proxy.child.kill("SIGKILL");
    await rm(proxy.socket, { force: true });
    liveChildren.delete(proxyKey);
  }
  const endedAt = now();
  meta.wallMs = endedAt - started;
  meta.exit = run.code; meta.signal = run.signal; meta.guardFired = run.guardFired;
  const totals = proxy.totals();
  meta.wire = totals;
  const wire = wireOf(totals);
  const eventsText = existsSync(events) ? readFileSync(events, "utf8") : "";
  const { stop, detail } = stopOf(eventsText, run, wire);
  meta.stop = stop; meta.stopDetail = detail;
  meta.inFlight = inFlightAt(proxy.log, endedAt);
  meta.startedCompleted = { started: wire.forwarded, completed: wire.completed, reconciled: wire.forwarded === wire.completed };
  // Final state of the workspace.
  try { meta.commits = Number(git(ws, ["rev-list", "--count", "--all"]).trim()); } catch { meta.commits = 0; }
  const diff = finalDiff(ws, meta.initialTree, scratch);
  await writeFile(join(outDir, "final.diff"), diff.diff);
  meta.finalTree = diff.tree; meta.changedFiles = diff.files;
  meta.finalText = finalText(eventsText).slice(-4000);
  const verdict = classifyAttempt({ stop, wire, inFlightAtEndMs: meta.inFlight.oldestMs, refusalSuspected: refusalSuspected(meta.finalText, diff.files.length) });
  meta.valid = verdict.valid;
  if (verdict.valid) meta.terminal = verdict.terminal; else { meta.invalid = verdict.invalid; meta.invalidDetail = verdict.detail; }
  await rm(join(outDir, "workspace-final"), { recursive: true, force: true });
  await copyCandidate(ws, join(outDir, "workspace-final"));
  meta.finalDigest = treeDigest(join(outDir, "workspace-final"));
  await cp(sessions, join(outDir, "sessions"), { recursive: true });
  meta.endedAt = new Date().toISOString();
  meta.status = "completed";
  await writeJson(join(outDir, "meta.json"), meta);
  return meta;
}
