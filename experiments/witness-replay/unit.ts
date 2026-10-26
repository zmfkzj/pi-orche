/**
 * One counted revision session (a unit = seed × arm, one attempt) of the witness-replay pilot (README.md "One unit").
 *
 * Both arms: the frozen seed workspace (original snapshot indexed, candidate files in the working tree), the frozen prompt (the
 * same bytes for C and T), the same tools, sandbox, model route, request budget and wall time. Pi runs in JSON print mode
 * inside the sandbox; the unit proxy (outside) guards the route and the request budget across every invocation of the session.
 *   C: the session ends when the model ends its turn (the candidate is accepted as it is).
 *   T: when the model ends its turn the harness runs the retained reproducer itself (witness-run.ts) against the exact
 *      workspace; a pass accepts the candidate; a failure is NOT accepted: the model receives the run's output (gateMessage) in
 *      the same session and continues within the SAME remaining budget, at most BUDGET.maxGateRounds failed gate runs.
 * Evidence goes to the unit's attempt directory; meta.json is written last with status "completed".
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT, BRIDGE_MOUNT, BRIDGE_PORT, HERE, LAUNCH_MOUNT, NODE, NODE_DIR, PI_CLI, PI_MODULES, PLACEHOLDER_KEY, PROVIDER_MOUNT, REPO, SOCKET_MOUNT, UPSTREAM, dirDigest, finalDiff, pythonPathOf, pythonWrappers, sourceOf, stageVenv, stageWorkspace, taskManifest, writeJson } from "./env.js";
import { BUDGET, EFFORT, MODEL_REF, acceptanceHolds, afterTurnEnd, classifyAttempt, gateMessage, piSettings, type Arm, type StopKind, type Terminal } from "./protocol.js";
import { runSandboxed, type Bind } from "./sandbox.js";
import { WITNESS_MOUNT, copyCandidate, fileSha256, runWitness, treeDigest, type WitnessRecord } from "./witness-run.js";

export interface FrozenSeed {
  id: string; role: "failure" | "control"; family: string; task: string; fixtures: string; cache: string; artifact: string; pythonPath: string;
  seedTree: string; seedDigest: string; witness: { path: string; sha256: string }; heldout?: { path: string; sha256: string };
  prompt: { path: string; sha256: string }; venvDigest: string;
}
export interface FrozenPlan {
  createdAt: string; planDigest?: string; route: { model: string; effort: string }; budget: typeof BUDGET; maxReruns: number; upstream: string;
  piCli: { path: string; sha256: string; version: string }; node: { path: string; version: string; sha256?: string }; piModules?: { path: string; digest: string }; bwrap: string;
  provider: { dir: string; digest: string; version?: string }; catalog: { sha256: string; prices: Record<string, unknown> };
  harness: Record<string, string>; seeds: FrozenSeed[]; schedule: { name: string; seed: string; arm: Arm; pair: number; position: number }[];
}

export interface UnitRun { plan: FrozenPlan; frozenDir: string; unit: string; attempt: number; outDir: string; scratch: string; envRoot: string }

const now = () => Date.now();

/** How one Pi invocation ended (pure over its JSON events and the proxy-total deltas). */
export function stopOf(events: string, run: { code: number | null; guardFired: boolean }, delta: { forwarded: number; budget: number; route: number; unverifiable: number; providerErrors: number }): { stop: StopKind; detail: string } {
  if (run.guardFired) return { stop: "time", detail: "wall-time guard" };
  let last: any;
  let assistantSeen = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "message_end" && event.message?.role === "assistant") { last = event.message; assistantSeen = true; }
  }
  if (delta.route + delta.unverifiable > 0) return { stop: "route-refused", detail: `${delta.route} route / ${delta.unverifiable} unverifiable refusal(s)` };
  if (!assistantSeen) return delta.forwarded === 0 ? { stop: "no-model", detail: `no assistant message, exit ${run.code}` } : { stop: "crash", detail: `no assistant message after ${delta.forwarded} request(s), exit ${run.code}` };
  const reason = String(last.stopReason ?? "");
  const error = String(last.errorMessage ?? "");
  if (reason === "stop" || reason === "length") return { stop: "turn-end", detail: reason };
  if (reason === "error") {
    if (delta.budget > 0 || /request budget of \d+ model requests/.test(error)) return { stop: "budget", detail: error.slice(0, 300) };
    if (/pinned route/.test(error)) return { stop: "route-refused", detail: error.slice(0, 300) };
    if (delta.providerErrors > 0 || /\b(429|5\d\d)\b|overloaded|capacity|rate.?limit|network error|ECONN|timed? ?out/i.test(error)) return { stop: "provider-error", detail: error.slice(0, 300) };
    return { stop: "crash", detail: error.slice(0, 300) };
  }
  return { stop: "crash", detail: `stopReason ${reason || "none"}, exit ${run.code}` };
}

interface ProxyHandle { child: ChildProcess; totals: () => any }
async function startUnitProxy(dir: string, outDir: string, plan: FrozenPlan): Promise<ProxyHandle & { socket: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const socket = join(dir, "proxy.sock");
  const keyFile = join(dir, "key");
  const connection = JSON.parse(readFileSync(join(AGENT, "cliproxyapi.json"), "utf8"));
  await writeFile(keyFile, String(connection.apiKey ?? ""), { mode: 0o600 });
  const envelope = join(dir, "envelope.json");
  await writeJson(envelope, { route: plan.route, maxRequests: plan.budget.maxRequests, placeholderKey: PLACEHOLDER_KEY, prices: plan.catalog.prices });
  const log = join(outDir, "wire.jsonl");
  const child = spawn(NODE, [join(HERE, "proxy.mjs"), "--listen", socket, "--target", plan.upstream, "--log", log, "--envelope", envelope, "--key-file", keyFile], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`proxy did not start: ${text}`)); }, 15_000);
    child.stdout!.on("data", chunk => { text += String(chunk); if (/LISTENING /.test(text)) { clearTimeout(timer); resolve(); } });
    child.stderr!.on("data", chunk => { text += String(chunk); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${text}`)); });
  });
  await rm(keyFile, { force: true }); // read at start; never left on disk
  return { child, socket, totals: () => { try { return JSON.parse(readFileSync(`${log}.totals.json`, "utf8")); } catch { return {}; } } };
}

const LAUNCH = [
  "#!/bin/sh",
  "# witness-replay sandbox launcher: the bridge to the unit proxy, then Pi.",
  `"$WR_NODE" ${BRIDGE_MOUNT} ${BRIDGE_PORT} ${SOCKET_MOUNT} "$WR_BRIDGE_READY" &`,
  'i=0; while [ ! -s "$WR_BRIDGE_READY" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done',
  'exec "$WR_NODE" "$@"', "",
].join("\n");

interface Prepared {
  seed: FrozenSeed; arm: Arm; prompt: string; ws: string; sessions: string; venv: string; manifest: ReturnType<typeof taskManifest>;
  staged: { originalTree: string; head: string; digest: string }; binds: Bind[]; env: Record<string, string>; frozen: (path: string) => string;
}

/** Verify the frozen inputs and stage the unit's sandbox (workspace, wrappers, agent dir, reproducer mount). Undefined: a frozen input does not match. */
async function prepare(input: UnitRun, meta: any): Promise<Prepared | undefined> {
  const { plan, unit, scratch } = input;
  const scheduled = plan.schedule.find(item => item.name === unit);
  if (!scheduled) throw new Error(`unit ${unit} is not in the frozen schedule`);
  const seed = plan.seeds.find(item => item.id === scheduled.seed)!;
  const frozen = (path: string) => join(input.frozenDir, path);
  const checks: Record<string, boolean> = {
    witness: fileSha256(frozen(seed.witness.path)) === seed.witness.sha256,
    prompt: fileSha256(frozen(seed.prompt.path)) === seed.prompt.sha256,
    seedTree: treeDigest(frozen(seed.seedTree)) === seed.seedDigest,
    piCli: fileSha256(PI_CLI) === plan.piCli.sha256,
    // The mounted global node_modules (Pi and its dependencies) and the node binary must be the frozen ones (no drift between arms).
    piModules: plan.piModules === undefined || dirDigest(PI_MODULES) === plan.piModules.digest,
    node: plan.node.sha256 === undefined || fileSha256(NODE) === plan.node.sha256,
  };
  meta.frozenChecks = checks;
  if (Object.values(checks).some(ok => !ok)) return undefined;
  const prompt = readFileSync(frozen(seed.prompt.path), "utf8");
  const box = join(scratch, "box"), ws = join(box, "ws"), agent = join(box, "agent"), sessions = join(box, "sessions"), home = join(box, "home"), tmp = join(box, "tmp"), bin = join(box, "bin");
  await rm(scratch, { recursive: true, force: true });
  for (const dir of [agent, sessions, home, tmp, bin]) await mkdir(dir, { recursive: true });
  const staged = await stageWorkspace(sourceOf(seed.cache, seed.task), frozen(seed.seedTree), ws);
  meta.originalTree = staged.originalTree; meta.originalHead = staged.head; meta.seedDigest = staged.digest;
  if (staged.digest !== seed.seedDigest) throw new Error(`staged workspace digest ${staged.digest} != frozen ${seed.seedDigest}`);
  const { venv, digest: venvDigest } = await stageVenv(seed.cache, seed.task, input.envRoot);
  meta.venv = venv; meta.venvDigest = venvDigest;
  if (venvDigest !== seed.venvDigest) throw new Error(`venv digest ${venvDigest} != frozen ${seed.venvDigest}`);
  const manifest = taskManifest(seed.fixtures, seed.task);
  await pythonWrappers(bin, venv, sourceOf(seed.cache, seed.task), pythonPathOf(manifest), ws);
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) copyFileSync(join(AGENT, name), join(agent, name));
  const connection = JSON.parse(readFileSync(join(AGENT, "cliproxyapi.json"), "utf8"));
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  await writeFile(join(agent, "cliproxyapi.json"), JSON.stringify({ ...connection, apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl }), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), `${JSON.stringify(piSettings(), null, 2)}\n`);
  const harnessDir = join(scratch, "harness");
  await mkdir(harnessDir, { recursive: true });
  const witnessCopy = join(harnessDir, "reproducer.py");
  copyFileSync(frozen(seed.witness.path), witnessCopy);
  await chmod(witnessCopy, 0o444);
  if (fileSha256(witnessCopy) !== seed.witness.sha256) throw new Error("mounted reproducer copy differs from the frozen one");
  const launch = join(harnessDir, "launch.sh");
  await writeFile(launch, LAUNCH, { mode: 0o555 });
  const binds: Bind[] = [
    { from: NODE_DIR }, { from: PI_MODULES }, { from: venv }, { from: box, rw: true },
    { from: witnessCopy, to: WITNESS_MOUNT }, { from: join(input.frozenDir, plan.provider.dir), to: PROVIDER_MOUNT }, { from: join(HERE, "bridge.mjs"), to: BRIDGE_MOUNT },
    { from: launch, to: LAUNCH_MOUNT },
  ];
  const env = {
    PATH: `${bin}:${NODE_DIR}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1",
    CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0", WR_NODE: NODE, WR_BRIDGE_READY: join(tmp, ".bridge-ready"),
  };
  return { seed, arm: scheduled.arm, prompt, ws, sessions, venv, manifest, staged, binds, env, frozen };
}

/** Model-free probe of a unit's sandbox: the same staging, binds and environment, one shell command (README.md "Probe"). */
export async function probeUnit(input: UnitRun, command: string): Promise<{ text: string; code: number | null }> {
  const meta: any = {};
  const prepared = await prepare(input, meta);
  if (!prepared) throw new Error(`frozen input mismatch: ${JSON.stringify(meta.frozenChecks)}`);
  const run = await runSandboxed({ binds: prepared.binds, env: prepared.env, cwd: prepared.ws, command: ["/bin/sh", "-c", command] }, { guardMs: 600_000 });
  return { text: run.text, code: run.code };
}

/** Run one attempt of one unit end to end. Returns meta (also written to <outDir>/meta.json). */
export async function runUnit(input: UnitRun): Promise<any> {
  const { plan, unit, attempt, outDir, scratch } = input;
  const scheduled = plan.schedule.find(item => item.name === unit);
  if (!scheduled) throw new Error(`unit ${unit} is not in the frozen schedule`);
  const meta: any = { unit, seed: scheduled.seed, arm: scheduled.arm, attempt, startedAt: new Date().toISOString(), status: "running", route: plan.route, budget: plan.budget };
  await mkdir(outDir, { recursive: true });
  await writeJson(join(outDir, "meta.json"), meta);
  const prepared = await prepare(input, meta);
  if (!prepared) { meta.status = "completed"; meta.valid = false; meta.terminal = "invalid"; meta.invalid = "infrastructure"; meta.error = `frozen input mismatch: ${JSON.stringify(meta.frozenChecks)}`; await writeJson(join(outDir, "meta.json"), meta); return meta; }
  const { seed, arm, prompt, ws, sessions, venv, manifest, staged, env, frozen } = prepared;
  Object.assign(meta, { role: seed.role, family: seed.family, task: seed.task });
  const proxy = await startUnitProxy(join(scratch, "proxy"), outDir, plan);
  const sessionId = `wr-${unit}-a${attempt}`;
  meta.sessionId = sessionId;
  const binds: Bind[] = [...prepared.binds, { from: proxy.socket, to: SOCKET_MOUNT, rw: true }];
  const piArgs = (message: string) => [PI_CLI, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--offline",
    "-e", `${PROVIDER_MOUNT}/extensions/index.ts`, "--model", MODEL_REF, "--thinking", EFFORT, "--session-dir", sessions, "--session-id", sessionId, "--", message];
  const started = now();
  const invocations: any[] = [];
  const gates: WitnessRecord[] = [];
  let terminal: Terminal | undefined;
  let accepted: string | undefined;
  let message = prompt;
  try {
    for (let index = 0; ; index++) {
      const remaining = plan.budget.wallMs - (now() - started);
      if (remaining <= 0) { terminal = "time-exhausted"; break; }
      const before = proxy.totals();
      const events = join(outDir, `events-${index}.jsonl`);
      const run = await runSandboxed({ binds, env, cwd: ws, command: ["/bin/sh", LAUNCH_MOUNT, ...piArgs(message)] }, { guardMs: remaining, stdout: events, stderr: join(outDir, `stderr-${index}.txt`), keep: 64 * 1024 });
      const after = proxy.totals();
      const delta = {
        forwarded: (after.forwarded ?? 0) - (before.forwarded ?? 0), budget: (after.refused?.budget ?? 0) - (before.refused?.budget ?? 0), route: (after.refused?.route ?? 0) - (before.refused?.route ?? 0),
        unverifiable: (after.refused?.unverifiable ?? 0) - (before.refused?.unverifiable ?? 0), providerErrors: (after.providerErrors ?? 0) - (before.providerErrors ?? 0),
      };
      const { stop, detail } = stopOf(existsSync(events) ? readFileSync(events, "utf8") : "", run, delta);
      const record: any = { index, startedAt: new Date(now() - run.ms).toISOString(), ms: run.ms, exit: run.code, signal: run.signal, guardFired: run.guardFired, stop, detail, delta, message: index === 0 ? "prompt" : "gate" };
      invocations.push(record);
      await writeJson(join(outDir, "invocations.json"), invocations);
      if (stop === "time") { terminal = "time-exhausted"; break; }
      if (stop === "budget") { terminal = "budget-exhausted"; break; }
      if (stop !== "turn-end") { terminal = "invalid"; break; }
      if (arm === "C") { afterTurnEnd(arm, { gateRounds: 0, forwarded: 0, remainingMs: 1 }); accepted = treeDigest(ws); terminal = "accepted"; break; }
      // Arm T: the harness's own acceptance run of the unchanged reproducer against this exact workspace.
      const gate = await runWitness({ name: `${seed.id}-gate-${gates.length + 1}`, file: frozen(seed.witness.path), expectedSha256: seed.witness.sha256, candidate: ws, venv, pythonPath: pythonPathOf(manifest), scratch: join(scratch, "gate-runs") });
      gates.push(gate);
      await writeJson(join(outDir, "gate.json"), gates);
      record.gate = { status: gate.status, candidateDigest: gate.candidateDigest, ...(gate.reason ? { reason: gate.reason } : {}) };
      await writeJson(join(outDir, "invocations.json"), invocations);
      const next = afterTurnEnd(arm, { gate, gateRounds: gates.length, forwarded: proxy.totals().forwarded ?? 0, remainingMs: plan.budget.wallMs - (now() - started) }, plan.budget);
      record.next = next;
      await writeJson(join(outDir, "invocations.json"), invocations);
      if (next === "accept") { accepted = gate.candidateDigest; terminal = "accepted"; break; }
      if (next !== "continue") { terminal = next; break; }
      message = gateMessage(WITNESS_MOUNT, gate);
    }
  } finally {
    proxy.child.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 500));
    if (proxy.child.exitCode === null) proxy.child.kill("SIGKILL");
  }
  meta.wallMs = now() - started;
  meta.invocations = invocations.length;
  meta.gateRuns = gates.map(gate => ({ status: gate.status, candidateDigest: gate.candidateDigest, ms: gate.ms, ...(gate.reason ? { reason: gate.reason } : {}) }));
  const totals = proxy.totals();
  meta.wire = totals;
  const verdict = classifyAttempt(invocations.map(item => item.stop as StopKind), { forwarded: totals.forwarded ?? 0, refusedRoute: (totals.refused?.route ?? 0) + (totals.refused?.unverifiable ?? 0), offRouteResponses: totals.offRouteResponses ?? 0 });
  meta.valid = verdict.valid;
  if (!verdict.valid) { meta.invalid = verdict.invalid; terminal = "invalid"; }
  meta.terminal = terminal;
  const finalDigest = treeDigest(ws);
  meta.finalDigest = finalDigest;
  if (accepted !== undefined) {
    meta.acceptedDigest = accepted;
    meta.acceptanceIntact = acceptanceHolds(accepted, finalDigest);
    if (!meta.acceptanceIntact) { meta.valid = false; meta.invalid = "infrastructure"; meta.terminal = "invalid"; meta.error = "the final workspace is not the accepted candidate"; }
  }
  try { meta.commits = Number(execFileSync("git", ["rev-list", "--count", "--all"], { cwd: ws }).toString().trim()); meta.head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws }).toString().trim(); } catch { /* unreadable */ }
  const diff = finalDiff(ws, staged.originalTree, scratch);
  await writeFile(join(outDir, "final.diff"), diff.diff);
  meta.finalTree = diff.tree; meta.changedFiles = diff.files;
  await rm(join(outDir, "workspace-final"), { recursive: true, force: true });
  await copyCandidate(ws, join(outDir, "workspace-final"));
  await cp(sessions, join(outDir, "sessions"), { recursive: true });
  meta.endedAt = new Date().toISOString();
  meta.status = "completed";
  await writeJson(join(outDir, "meta.json"), meta);
  return meta;
}

/** Names of the attempt directories of a unit (attempt-1, attempt-2, ...). */
export const attemptsOf = (unitDir: string): string[] => existsSync(unitDir) ? readdirSync(unitDir).filter(name => /^attempt-\d+$/.test(name)).sort() : [];
export { REPO };
