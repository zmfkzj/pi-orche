/**
 * One arm of one unit of the strong-reflection hard-task bench, in its own process (protocol.ts, PREREGISTRATION.md).
 *
 *   node --import tsx experiments/strong-reflection/bench/run-arm.ts <bench dir> <unit> <task> <O|R0|R1> <live dir>
 *   node --import tsx experiments/strong-reflection/bench/run-arm.ts <pilot dir> <unit> <task> <A|B|C0> <live dir> <source bench dir>
 *
 * The second form is a decision-audit pilot arm (pilot/protocol.ts, pilot/PREREGISTRATION.md): it replays the SOURCE bench's O
 * recording with the source bench's frozen runtime and writes only under <pilot dir>. Its proxy is strict (no new history before the
 * reflection point), every forward passes the model/effort and budget gate, and the request at the reflection point must pass the
 * fidelity gate (pilot/fidelity.ts) before it goes live. SRB_DRY=1: offline, stop at the reflection point (zero cost).
 *
 * The live dir is the same absolute path for every arm of a unit (replayed tool calls carry O's absolute paths); it is rebuilt from
 * scratch for each arm (workspace, wrappers, agent dir, TMPDIR, scratch, records). Outputs: <bench>/units/<unit>/<arm>/ (meta.json,
 * wire.jsonl, checkpoint-*.json, final.diff, records/).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT, gradeWorkspace, loadTask, pythonWrappers, UPSTREAM } from "../../ultra-ab/env.js";
import { leakHits } from "../../ultra-ab/protocol.js";
import { MODEL_REF, THINKING, costOf, handoff, orcheConfig, primaryPass, type Arm } from "./protocol.js";
import { deepReplace, loadWire, WireProxy, type Checkpoint, type ForwardGate, type WireRecord } from "./wire.js";
import { BUDGET, configArmOf, FOUR_LINES, isPilotArm, PATH_MAP, PILOT_LIVE_ROOT, PILOT_SAME_RESPONSE, pilotLivePath, pilotReportText, pilotText, requestReservationUsd, settlementUsd, sha256, WIRE_EFFORT, WIRE_MODEL, type PilotArm } from "./pilot/protocol.js";
import { Ledger } from "./pilot/budget.js";
import { compareCheckpoint } from "./pilot/fidelity.js";

const PROVIDER = join(AGENT, "git/github.com/zmfkzj/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider");
const [bench, unit, taskId, arm, live, sourceBench] = process.argv.slice(2) as [string, string, string, Arm | PilotArm, string, string | undefined];
const pilot = isPilotArm(arm);
if (!bench || !unit || !taskId || !((["O", "R0", "R1"] as string[]).includes(arm) || pilot) || !live || (pilot && !sourceBench)) throw new Error("usage: run-arm.ts <bench> <unit> <task> <O|R0|R1> <live> | <pilot> <unit> <task> <A|B|C0> <live> <source bench>");
const dry = pilot && process.env.SRB_DRY === "1";
/** The configuration the arm runs with: its own, or for a pilot arm the source arm it extends (A/B: R1 with the texts patched; C0: R0). */
const configArm: Arm = pilot ? configArmOf(arm) : arm;
/** Where O's recording, its checkpoint request and the frozen runtime come from (read only for a pilot arm). */
const sourceUnitDir = join(pilot ? sourceBench! : bench, "units", unit);
/** A pilot arm's state hashes map its live root back to the source bench's, so they compare with O's recorded hashes. */
const BACK = { from: PATH_MAP.to, to: PATH_MAP.from };
const unitDir = join(bench, "units", unit);
const armDir = join(unitDir, arm);
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).toString();

/**
 * Hash of the workspace state (tracked diff + untracked files; .orche excluded: its artifact names are run-specific). A pilot arm
 * hashes its state with its live root mapped back to the source bench's (`back`), so the hash compares with O's recorded one.
 */
const mapBytes = (data: Buffer, back?: { from: string; to: string }): Buffer => {
  if (!back) return data;
  const from = Buffer.from(back.from), to = Buffer.from(back.to), out = Buffer.from(data);
  for (let at = out.indexOf(from); at >= 0; at = out.indexOf(from, at + from.length)) to.copy(out, at);
  return out;
};
function stateHash(ws: string, back?: { from: string; to: string }): { hash: string; files: number; stat: string } {
  const text = (value: string) => back ? value.split(back.from).join(back.to) : value;
  const hash = createHash("sha256");
  const status = git(ws, ["status", "--porcelain=v1", "-uall", "--", ".", ":(exclude).orche"]);
  hash.update(text(status));
  hash.update(mapBytes(Buffer.from(git(ws, ["diff", "HEAD", "--binary", "--", ".", ":(exclude).orche"])), back));
  const untracked = status.split("\n").filter(line => line.startsWith("?? ")).map(line => line.slice(3));
  for (const file of untracked) { try { hash.update(text(file)); hash.update(mapBytes(readFileSync(join(ws, file)), back)); } catch { /* gone */ } }
  return { hash: hash.digest("hex"), files: status.split("\n").filter(Boolean).length, stat: git(ws, ["diff", "HEAD", "--stat", "--", ".", ":(exclude).orche"]).slice(-2000) };
}

async function overlay(dir: string, proxyUrl: string, recordsDir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(AGENT, name))) await copyFile(join(AGENT, name), join(dir, name));
  const connection = JSON.parse(await readFile(join(AGENT, "cliproxyapi.json"), "utf8"));
  await writeFile(join(dir, "cliproxyapi.json"), JSON.stringify({ ...connection, baseUrl: proxyUrl }), { mode: 0o600 });
  await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "cliproxyapi", defaultModel: "gpt-6-astra", defaultThinkingLevel: THINKING, quietStartup: true, transport: "sse" }, null, 2));
  await writeFile(join(dir, "orche.config.json"), JSON.stringify(orcheConfig(configArm, recordsDir), null, 2));
  await mkdir(join(dir, "npm/node_modules/@router-for-me"), { recursive: true });
  await symlink(PROVIDER, join(dir, "npm/node_modules/@router-for-me/pi-cliproxyapi-provider"), "dir");
  await writeFile(join(dir, "npm/package.json"), JSON.stringify({ name: "pi-npm", private: true, dependencies: { "@router-for-me/pi-cliproxyapi-provider": "*" } }));
  return String(connection.apiKey ?? "");
}

const jsonl = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? jsonl(join(dir, entry.name)) : entry.name.endsWith(".jsonl") ? [join(dir, entry.name)] : []);

/**
 * Pilot arm: writes only under its own output and its unit's recorded live path, never into the source bench; one arm per live
 * path at a time (`<live>.lock` holds the pid).
 */
function guardPilotPaths(oMeta: any): void {
  const out = resolve(bench), src = resolve(sourceBench!);
  if (out === src || out.startsWith(`${src}/`) || src.startsWith(`${out}/`)) throw new Error(`pilot output ${out} must be separate from the source bench ${src}`);
  if (resolve(live) !== pilotLivePath(String(oMeta.live)) || !resolve(live).startsWith(`${PILOT_LIVE_ROOT}/`)) throw new Error(`pilot live path ${live} must be O's recorded ${oMeta.live} moved under ${PILOT_LIVE_ROOT}`);
  const lock = `${resolve(live)}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch (error: any) {
      if (error?.code !== "EEXIST" || attempt > 0) throw new Error(`live path ${live} is locked (${lock}): ${String(error?.message ?? error)}`);
      const holder = Number(readFileSync(lock, "utf8"));
      let alive = false;
      try { process.kill(holder, 0); alive = true; } catch { /* holder gone */ }
      if (alive) throw new Error(`live path ${live} is in use by pid ${holder}`);
      rmSync(lock, { force: true });
    }
  }
  process.on("exit", () => { try { if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true }); } catch { /* gone */ } });
}

async function main() {
  const task = await loadTask(taskId);
  const oMeta = pilot ? JSON.parse(readFileSync(join(sourceUnitDir, "O/meta.json"), "utf8")) : undefined;
  if (pilot) guardPilotPaths(oMeta);
  await rm(live, { recursive: true, force: true });
  await rm(armDir, { recursive: true, force: true });
  await mkdir(armDir, { recursive: true });
  const ws = join(live, "ws"), bin = join(live, "bin"), tmp = join(live, "tmp"), records = join(live, "records"), scratch = join(live, "scratch"), agentDir = join(live, "agent");
  for (const dir of [tmp, records, scratch]) await mkdir(dir, { recursive: true });
  await cp(task.source, ws, { recursive: true, filter: path => !path.endsWith("/.git") });
  for (const args of [["init", "--quiet"], ["add", "--force", "."], ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Starting state"]]) git(ws, args);
  if (task.kind === "swe") await pythonWrappers(task, ws, bin);

  let recording: WireRecord[] | undefined, checkpoint: Checkpoint | undefined;
  if (arm !== "O") {
    const o = oMeta ?? JSON.parse(await readFile(join(unitDir, "O/meta.json"), "utf8"));
    if (!o.checkpoint) throw new Error(`${unit}: O has no reflection point; nothing to replay`);
    recording = loadWire(join(sourceUnitDir, "O/wire.jsonl"));
    checkpoint = o.checkpoint;
  }
  let checkpointState: ReturnType<typeof stateHash> | undefined;
  // Pilot: every forward passes the model/effort and budget gate (pilot/budget.ts); a dry arm forwards nothing at all.
  const ledger = pilot && !dry ? new Ledger(join(resolve(bench), "budget"), BUDGET.capUsd, BUDGET.gateMarginUsd) : undefined;
  const firstSeen = new Set<string>();
  const gate: ForwardGate | undefined = ledger ? (request, info) => {
    if (request?.model !== WIRE_MODEL || request?.reasoning?.effort !== WIRE_EFFORT) return { ok: false, reason: `model/effort ${request?.model}/${request?.reasoning?.effort} is not ${WIRE_MODEL}/${WIRE_EFFORT}` };
    const usd = requestReservationUsd(Buffer.byteLength(JSON.stringify(request), "utf8"), !firstSeen.has(info.session));
    firstSeen.add(info.session);
    const id = `${unit}/${arm}/${process.pid}/${info.seq}`;
    const verdict = ledger.reserve({ id, unit, arm, usd, armCapUsd: BUDGET.armCapUsd });
    return verdict.ok ? { ok: true, settle: (usage, status) => ledger.settle(id, settlementUsd(usage, status, usd)) } : verdict;
  } : undefined;
  let fidelity: any;
  /** Pilot fidelity gate at the reflection point (pilot/fidelity.ts): false refuses the switch request; a dry arm always stops here. */
  const pilotGate = (request: any, ordinal: number): boolean => {
    const recorded = JSON.parse(readFileSync(join(sourceUnitDir, "O/checkpoint-request.json"), "utf8"));
    // O's request with its live root moved like this arm's (the only systematic difference besides the intended text).
    const report = compareCheckpoint(request, deepReplace(recorded.request, PATH_MAP.from, PATH_MAP.to), arm as PilotArm, checkpoint?.node ?? "");
    const sameState = !!checkpointState && checkpointState.hash === oMeta.checkpointState?.hash;
    const ok = report.ok && sameState && ordinal === checkpoint?.ordinal;
    fidelity = { ...report, ok, requestOk: report.ok, sameState, state: checkpointState?.hash, oState: oMeta.checkpointState?.hash, ordinal, expectedOrdinal: checkpoint?.ordinal };
    writeFileSync(join(armDir, "fidelity.json"), `${JSON.stringify(fidelity, null, 2)}\n`);
    if (dry || !ok) {
      writeFileSync(join(armDir, dry ? "dry.json" : "gate-failed.json"), `${JSON.stringify({ unit, arm, dry, ok, sameState, problems: report.problems, outputs: { raw: report.outputs.raw, normalized: report.outputs.normalized, orderOnly: report.outputs.orderOnly }, events: proxy.events, at: new Date().toISOString() }, null, 2)}\n`);
      setTimeout(() => process.exit(ok ? 0 : 3), 500);
      return false;
    }
    return true;
  };
  const proxy = new WireProxy({
    mode: arm === "O" ? "record" : "replay", upstream: UPSTREAM, wireFile: join(armDir, "wire.jsonl"), recording, checkpoint,
    ...(pilot ? { strictPrefix: true, offline: dry, gate, pathMap: PATH_MAP, ...(dry && process.env.SRB_MODELS_SNAPSHOT ? { offlineModels: JSON.parse(readFileSync(process.env.SRB_MODELS_SNAPSHOT, "utf8")) } : {}) } : {}),
    onCheckpointRequest: (request, ordinal) => {
      try { checkpointState = stateHash(ws, pilot ? BACK : undefined); } catch (error) { checkpointState = { hash: `error ${String(error).slice(0, 80)}`, files: -1, stat: "" }; }
      // The pre-review work state as a patch (a private index, so the worker's own git index is untouched), graded later (grade-checkpoints.ts).
      try {
        const env = { ...process.env, GIT_INDEX_FILE: join(live, "checkpoint.index") };
        execFileSync("git", ["read-tree", "HEAD"], { cwd: ws, env, stdio: "ignore" });
        execFileSync("git", ["add", "-A", "--", ".", ":(exclude).orche"], { cwd: ws, env, stdio: "ignore" });
        writeFileSync(join(armDir, "checkpoint.diff"), execFileSync("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: ws, env, maxBuffer: 256 * 1024 * 1024 }));
      } catch (error) { writeFileSync(join(armDir, "checkpoint.diff.error"), String(error)); }
      if (!pilot) { void writeFile(join(armDir, "checkpoint-request.json"), JSON.stringify({ ordinal, state: checkpointState, request })); return; }
      writeFileSync(join(armDir, "checkpoint-request.json"), JSON.stringify({ ordinal, state: checkpointState, request }));
      return pilotGate(request, ordinal);
    },
  });
  if (pilot) {
    // A refusal before the reflection point (strict prefix) means the replay cannot be faithful: report the arm invalid and stop.
    const watchdog = setInterval(() => {
      if (!proxy.halted || proxy.switched) return;
      clearInterval(watchdog);
      writeFileSync(join(armDir, dry ? "dry.json" : "gate-failed.json"), `${JSON.stringify({ unit, arm, dry, ok: false, problems: [`proxy halted before the reflection point: ${proxy.halted}`], events: proxy.events, at: new Date().toISOString() }, null, 2)}\n`);
      setTimeout(() => process.exit(3), 500);
    }, 2000);
    watchdog.unref();
  }
  const proxyUrl = await proxy.listen();
  const apiKey = await overlay(agentDir, proxyUrl, records);
  for (const name of Object.keys(process.env)) if (/^(PI_|CLIPROXYAPI_|ORCHE_)/.test(name)) delete process.env[name];
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir, TMPDIR: tmp, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    CLIPROXYAPI_BASE_URL: proxyUrl, CLIPROXYAPI_API_KEY: apiKey, CLIPROXYAPI_FAST: "0",
    ...(task.kind === "swe" ? { PATH: `${bin}:${process.env.PATH ?? ""}` } : {}),
  });

  const rt = join(pilot ? sourceBench! : bench, "rt");
  const reflection = await import(pathToFileURL(join(rt, "src/single/reflection.ts")).href);
  if (arm === "O") {
    // Observe only: the same delivery rule as the real class, but nothing reaches the model; it only marks the reflection point.
    const proto = reflection.StrongReflection.prototype;
    proto.onPlan = function (this: any, plan: any) {
      if (this.__seen) return [];
      const node = plan.nodes.find((item: any) => item.phase === "integrate" && item.status === "running");
      if (node) { this.__seen = true; proxy.markCheckpoint("integrate", node.id); }
      return [];
    };
    proto.beforeReport = function (this: any) { if (!this.__seen) { this.__seen = true; proxy.markCheckpoint("report"); } return undefined; };
    proto.summary = () => ({ delivered: "none" });
  }
  if (arm === "A" || arm === "B") {
    if (reflection.STRONG_REFLECTION_PROMPT !== FOUR_LINES) throw new Error("the frozen runtime's four-line prompt differs from pilot/protocol.ts FOUR_LINES");
    // The original class's delivery rule (rt/src/single/reflection.ts onPlan/beforeReport: once, at the first accepted plan that starts
    // an integration node, else holding the first report; a report of the delivering response held), with the arm's text instead.
    const proto = reflection.StrongReflection.prototype;
    proto.onPlan = function (this: any, plan: any) {
      if (this.given) return [];
      const node = plan.nodes.find((item: any) => item.phase === "integrate" && item.status === "running");
      if (!node) return [];
      this.deliver({ delivered: "integrate", node: node.id, at: Date.now() });
      return [pilotText(arm, node.id)];
    };
    proto.beforeReport = function (this: any, toolCallId?: string) {
      if (!this.given) { this.deliver({ delivered: "report", at: Date.now() }); return pilotReportText(arm); }
      if (toolCallId && this.given.calls.includes(toolCallId)) { this.holds++; return PILOT_SAME_RESPONSE; }
      return undefined;
    };
  }
  const { OrcheController } = await import(pathToFileURL(join(rt, "src/extension/controller.ts")).href);
  const { WorkerPool } = await import(pathToFileURL(join(rt, "src/extension/workers.ts")).href);
  const pool = new WorkerPool({ controller: new OrcheController({ agentDir }), agentDir, scratchBase: scratch });
  const request = handoff(task);
  const started = Date.now();
  const meta: any = { unit, task: taskId, kind: task.kind, arm, model: MODEL_REF, thinking: THINKING, startedAt: new Date(started).toISOString(), config: orcheConfig(configArm, records), live };
  if (pilot) meta.pilot = { configArm, sourceBench: resolve(sourceBench!), runtime: rt, dry, pathMap: PATH_MAP, textSha256: sha256(pilotText(arm as PilotArm, checkpoint?.node ?? "")) };
  try {
    const result = await pool.execute({ role: "implement", request, cwd: ws, projectTrusted: false, mainMode: "strong", thinking: THINKING, currentSession: { id: `srb-${unit}` } });
    meta.terminal = result.details.status; meta.reflection = result.details.reflection; meta.requests = result.details.requests; meta.plan = result.details.plan; meta.checklist = result.details.checklist;
    meta.models = result.details.models; meta.resultText = String(result.text ?? "").slice(0, 20000);
  } catch (error: any) {
    meta.terminal = /timed? ?out|time limit|budget/i.test(String(error?.message)) ? "timeout" : "failed";
    meta.error = String(error?.message ?? error).slice(0, 4000);
    meta.reflection = error?.details?.reflection;
  } finally {
    try { await pool.dispose(); } catch { /* best effort */ }
    await proxy.close();
  }
  meta.durationMs = Date.now() - started;
  meta.checkpoint = arm === "O" ? proxy.checkpoint : checkpoint;
  meta.checkpointState = checkpointState;
  meta.replay = { switched: proxy.switched, events: proxy.events };
  if (pilot) { meta.fidelity = fidelity && { ok: fidelity.ok, sameState: fidelity.sameState, problems: fidelity.problems, outputs: { raw: fidelity.outputs.raw, normalized: fidelity.outputs.normalized, orderOnly: fidelity.outputs.orderOnly }, items: fidelity.items }; meta.proxyHalted = proxy.halted; meta.ledger = ledger?.state(); }
  const { grade, integrity } = await gradeWorkspace(task, ws);
  meta.grade = grade; meta.integrity = integrity;
  meta.primaryPass = primaryPass({ terminal: meta.terminal, gradePassed: grade.passed, violations: integrity.violations.length });
  // Wire summary: live (billed) vs replayed; models and efforts actually requested.
  const wire = existsSync(join(armDir, "wire.jsonl")) ? loadWire(join(armDir, "wire.jsonl")) : [];
  const liveRecords = wire.filter(entry => entry.mode === "live");
  const sum = (items: WireRecord[]) => items.reduce((acc, entry) => ({ input: acc.input + (entry.usage?.input ?? 0), cached: acc.cached + (entry.usage?.cached ?? 0), output: acc.output + (entry.usage?.output ?? 0), reasoning: acc.reasoning + (entry.usage?.reasoning ?? 0) }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  const live_ = sum(liveRecords);
  meta.wire = {
    requests: wire.length, live: liveRecords.length, replayed: wire.length - liveRecords.length, errors: wire.filter(entry => entry.status !== 200 || entry.error).length,
    sessions: new Set(wire.map(entry => entry.session)).size,
    liveUsage: live_, liveCostUsd: Number(costOf(live_).toFixed(4)),
    requested: [...new Set(wire.map(entry => `${entry.request?.model}/${entry.request?.reasoning?.effort ?? "?"}`))],
    liveAfterSwitch: liveRecords.filter(entry => entry.top).length,
  };
  // Leak check over every tool call of every session record; final diff.
  const calls: { name: string; arguments: unknown }[] = [];
  for (const file of jsonl(records)) for (const line of readFileSync(file, "utf8").split("\n")) {
    try { const entry = JSON.parse(line); const message = entry.type === "message" ? entry.message : undefined; if (message?.role === "assistant") for (const part of message.content ?? []) if (part.type === "toolCall") calls.push({ name: part.name, arguments: part.arguments }); } catch { /* partial */ }
  }
  meta.leaks = leakHits(calls);
  meta.toolCalls = calls.length;
  git(ws, ["add", "-A", "--", ".", ":(exclude).orche"]);
  await writeFile(join(armDir, "final.diff"), git(ws, ["diff", "--cached", "--binary", "HEAD"]));
  meta.finalState = stateHash(ws, pilot ? BACK : undefined);
  await cp(records, join(armDir, "records"), { recursive: true });
  await writeFile(join(armDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify({ unit, arm, terminal: meta.terminal, pass: meta.primaryPass, grade: grade.passed, violations: integrity.violations.length, checkpoint: meta.checkpoint, switched: proxy.switched, divergences: proxy.events.filter(event => event.type === "divergence").length, liveCostUsd: meta.wire.liveCostUsd, durationMs: meta.durationMs }));
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
void relative; void statSync;
