/**
 * Model-run harness of the cb-ab study (results/cb-ab/PROTOCOL.md; arms, texts, config, limits and schedule from protocol.ts).
 *
 *   node --import tsx experiments/cb-ab/run.ts prepare <studyDir>
 *   node --import tsx experiments/cb-ab/run.ts unit <studyDir> <caseDir> <A|B|C> <repeat> [--preflight]
 *   node --import tsx experiments/cb-ab/run.ts driver <studyDir> --cases <dir,...> --concurrency N [--preflight]
 *   node --import tsx experiments/cb-ab/run.ts status <studyDir>
 *   node --import tsx experiments/cb-ab/run.ts summarize <studyDir>
 *   node --import tsx experiments/cb-ab/run.ts toy-case <caseDir>              (the preflight's toy case, written once)
 *   node --import tsx experiments/cb-ab/run.ts selfcheck                       (which copy runs, its harness intact)
 *
 * prepare freezes the study's inputs: runtime = orche exactly as committed at HEAD (`git archive`), the CLIProxyAPI provider package,
 * the harness (every experiments/cb-ab/*.ts and the experiments files they import, hashed from the copied bytes), the catalog, and
 * environment.json. `unit` and `driver` always execute the study's FROZEN harness (<study>/harness/experiments/cb-ab/run.ts): started
 * from the live file they re-run themselves from that copy (signals forwarded), so a later edit of the live files never reaches a run.
 *
 * One unit = one fresh plain-directory copy of the case's pre-fix snapshot (no .git, no commit) at ~/Code/<projectDir>, its venv
 * read-only at ~/.venvs/<projectDir> with python/pytest wrappers, a private agent dir (Sol/high, protocol.ts orcheConfig(), no stored
 * login), a logging proxy pricing every request (no envelope), and the real `pi` in JSON mode with protocol.ts oneShot(arm, prompt)
 * inside bubblewrap, guarded by LIMITS.piGuardMs. Its evidence lands in <study>/runs/<caseId>/<arm>/r<repeat> (evidence.ts).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, runGuarded, sha, startProxy, taskRuns } from "../mdsd-ab/run.js";
import { driverStatus, runDriver } from "./driver.js";
import {
  AGENT, FROZEN_ROOT, HARNESS_ENTRY, HARNESS_FILE, NODE, PI_CLI, PROTOCOL_HEAD, PROVIDER_PKG, REPO, allFiles, agentDir, catalogEntry, copyProvider, liveSecrets,
  display, freezeHarness, freezeRuntime, harnessIntact, loadCase, makeTarget, piArgs, pythonWrappers, readJson, rootAnchors, sandboxArgs, sandboxCommand, sandboxEnv, targetMount,
  unitDir, venvMount, writeJson, type LoadedCase,
} from "./env.js";
import {
  auditTranscripts, briefOf, compliance, contentHashes, explorerIds, finalReport, finalText, redactTree, routeFidelity, sessionTranscripts, successful,
  targetCheck, taskStatuses, usageByRole, wireStats, type WireEntry,
} from "./evidence.js";
import { ARMS, LIMITS, MODEL, MODEL_REF, THINKING, diagnosisPrompt, oneShot, orcheConfig, type Arm } from "./protocol.js";
import { summarize } from "./summarize.js";

// ---- prepare -------------------------------------------------------------------------------------------------------------------------

export interface PrepareOptions { repo?: string; provider?: string; agent?: string }
/** Freeze a study's inputs once (runtime, provider, harness, catalog) and write environment.json last. */
export function prepare(studyDir: string, options: PrepareOptions = {}): Record<string, unknown> {
  const study = resolve(studyDir), repo = options.repo ?? REPO, live = options.agent ?? AGENT;
  const present = ["environment.json", "runtime", "provider", "harness", "catalog"].filter(name => existsSync(join(study, name)));
  if (present.length) throw new Error(`${study} is already prepared (${present.join(", ")} present): use a fresh study directory`);
  mkdirSync(study, { recursive: true });
  const runtime = freezeRuntime(repo, join(study, "runtime"));
  const provider = copyProvider(options.provider ?? PROVIDER_PKG, join(study, "provider"));
  const harness = freezeHarness(repo, join(study, "harness"));
  mkdirSync(join(study, "catalog"));
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(live, name))) cpSync(join(live, name), join(study, "catalog", name));
  const catalog = catalogEntry(join(study, "catalog/cliproxyapi-models.json"));
  const config = orcheConfig();
  const environment = {
    preparedAt: new Date().toISOString(), study, repo,
    pi: { cli: PI_CLI, version: run(NODE, [PI_CLI, "--version"]) },
    node: process.version, bwrap: run("bwrap", ["--version"]),
    model: MODEL_REF, thinking: THINKING,
    catalog: { file: "catalog/cliproxyapi-models.json", sha256: catalog.sha256, models: existsSync(join(study, "catalog/models.json")) ? sha(readFileSync(join(study, "catalog/models.json"))) : null, entry: catalog.entry },
    prices: catalog.prices,
    runtime: { source: "git archive HEAD", head: runtime.head, protocolHead: PROTOCOL_HEAD, matchesProtocolHead: runtime.head.startsWith(PROTOCOL_HEAD), digest: runtime.digest, files: Object.keys(runtime.files).length },
    provider: { source: options.provider ?? PROVIDER_PKG, ...provider },
    harness: { digest: harness.digest, files: harness.files },
    orche: { config, sha256: sha(JSON.stringify(config)) },
    limits: LIMITS,
  };
  writeJson(join(study, "environment.json"), environment);
  return environment;
}
const run = (command: string, args: string[]) => { try { return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); } catch (error) { return `unavailable: ${String(error).slice(0, 120)}`; } };

// ---- one unit ------------------------------------------------------------------------------------------------------------------------

export interface UnitOptions { preflight: boolean }
const isArm = (value: string): value is Arm => (ARMS as readonly string[]).includes(value);

/** A failed evidence step is recorded, never fatal: the run already happened and its evidence must be kept. */
function stepper(errors: string[]) {
  return <T>(name: string, fn: () => T): T | undefined => { try { return fn(); } catch (error) { errors.push(`${name}: ${String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 800)}`); return undefined; } };
}

/** Stop the proxy and wait for it, so wire.jsonl and its totals are final. */
function stopProxy(child: ChildProcess): Promise<void> {
  return new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); done(); }
  });
}

/** Model-free check of the sandbox before Pi starts: the home and /tmp it sees, the wrappers, the venv, no git work tree, pip refused. */
export function sandboxCheckScript(): string {
  return [
    'echo "home: $(ls -A "$HOME" | tr "\\n" " ")"',
    'echo "home-local: $(ls -A "$HOME/.local" "$HOME/.local/share" 2>/dev/null | tr "\\n" " ")"',
    'echo "tmp: $(ls -A /tmp | tr "\\n" " ")"',
    'echo "pwd: $PWD"',
    'echo "python: $(command -v python) $(command -v pytest)"',
    "python -c 'import sys, os; print(\"prefix:\", sys.prefix); print(\"pythonpath:\", os.environ.get(\"PYTHONPATH\")); print(\"nobytecode:\", sys.dont_write_bytecode)'",
    'echo "pytest: $(pytest --version 2>&1 | head -1)"',
    'pip --version >/dev/null 2>&1; echo "pip-exit: $?"',
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1; echo "git-worktree-exit: $?"',
    'echo "agent: $(ls -A "$HOME/.pi/agent" | tr "\\n" " ")"',
    'echo "processes: $(ls -d /proc/[0-9]* | wc -l)"',
    'echo "repo-visible: $(test -e /home/arthur/Code/oh-my-pi-extensions && echo yes || echo no)"',
    // bubblewrap's own options as PID 1 shows them (only `--args 3` when they came through the descriptor; never host paths).
    'echo "pid1-options: $(tr "\\000" "\\n" < /proc/1/cmdline | sed -n "2,/^--\\$/p" | tr "\\n" " ")"',
  ].join("\n");
}
export function parseSandboxCheck(output: string, projectDir: string): { ok: boolean; problems: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) { const match = /^([a-z0-9-]+): ?(.*)$/.exec(line.trim()); if (match) values[match[1]!] = match[2]!.trim(); }
  const problems: string[] = [];
  const home = (values.home ?? "").split(/\s+/).filter(Boolean).sort();
  if (home.join(" ") !== [".bun", ".local", ".nvm", ".pi", ".venvs", "Code"].sort().join(" ")) problems.push(`home shows ${home.join(" ") || "nothing"}`);
  if ((values.tmp ?? "").split(/\s+/).filter(Boolean).join(" ") !== "pi-orche") problems.push(`/tmp shows ${values.tmp}`);
  if (values.pwd !== targetMount(projectDir)) problems.push(`cwd ${values.pwd}`);
  if (values.prefix !== venvMount(projectDir)) problems.push(`python prefix ${values.prefix}`);
  if (!(values.pythonpath ?? "").startsWith(targetMount(projectDir))) problems.push(`PYTHONPATH ${values.pythonpath}`);
  if (values.nobytecode !== "True") problems.push("bytecode writing on");
  if (!/^pytest \d/.test(values.pytest ?? "")) problems.push(`pytest ${values.pytest}`);
  if (values["pip-exit"] === "0") problems.push("pip runs");
  if (values["git-worktree-exit"] === "0") problems.push("the target is inside a git work tree");
  if (values["repo-visible"] !== "no") problems.push("the repository is visible");
  if (values["pid1-options"] !== "--args 3 --") problems.push(`host paths in the sandbox's process list (bwrap options ${(values["pid1-options"] ?? "unknown").slice(0, 160)})`);
  return { ok: problems.length === 0, problems, values };
}

export async function runUnit(studyDir: string, caseDir: string, arm: string, repeat: number, options: UnitOptions): Promise<Record<string, any>> {
  const study = resolve(studyDir);
  if (!isArm(arm)) throw new Error(`arm must be one of ${ARMS.join(", ")}`);
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error("repeat must be a positive integer");
  if (!existsSync(join(study, "environment.json"))) throw new Error(`${study} is not prepared (no environment.json)`);
  if (!options.preflight && !existsSync(join(study, "manifest.json"))) throw new Error(`${study}/manifest.json is missing: measured units run only after the task manager wrote it (--preflight is for preflight units only)`);
  const spec = loadCase(caseDir);
  const environment = readJson(join(study, "environment.json"));
  const unit = `${spec.id}/${arm}/r${repeat}`, dir = unitDir(study, spec.id, arm, repeat);
  if (existsSync(dir)) {
    const earlier = existsSync(join(dir, "meta.json")) ? readJson(join(dir, "meta.json")) : undefined;
    if (earlier?.status === "completed") throw new Error(`${unit} is completed (${display(dir)}): a completed unit is never overwritten`);
    throw new Error(`${unit}: an earlier attempt is in ${display(dir)} (status ${earlier?.status ?? "none"}); the driver renames it .interrupted-<n> before rerunning`);
  }
  mkdirSync(dir, { recursive: true });
  const revision = readJson(join(study, "runtime/REVISION.json"));
  const harnessDir = join(study, "harness");
  const meta: Record<string, any> = {
    unit, caseId: spec.id, caseOrder: spec.order, arm, repeat, preflight: options.preflight, status: "running", pid: process.pid, startedAt: new Date().toISOString(),
    case: { dir: display(spec.dir), sha256: spec.sha256, task: spec.task, repo: spec.repo, baseCommit: spec.baseCommit, projectDir: spec.projectDir, pythonPath: spec.pythonPath, promptSha256: spec.promptSha256, source: display(spec.sourceDir), venv: display(spec.venvDir) },
    harness: { running: FROZEN_ROOT ? display(FROZEN_ROOT) : "live files (not a frozen copy)", frozen: FROZEN_ROOT === harnessDir, digest: readJson(join(harnessDir, HARNESS_FILE)).digest, changed: harnessIntact(harnessDir) },
    runtime: { head: revision.head, digest: revision.digest }, provider: { digest: environment.provider?.digest },
    manifestSha256: existsSync(join(study, "manifest.json")) ? sha(readFileSync(join(study, "manifest.json"))) : null,
    model: MODEL_REF, thinking: THINKING, guardMs: LIMITS.piGuardMs,
  };
  const save = () => writeJson(join(dir, "meta.json"), meta);
  save();
  let proxyChild: ChildProcess | undefined, inGuard = false;
  // Stopped (driver stop, Ctrl-C): mark the unit interrupted, stop the proxy, redact what is there; inside runGuarded its own handler
  // (registered after this one, so it runs second) kills the Pi process group and exits.
  const onSignal = (signal: NodeJS.Signals) => {
    meta.status = "interrupted"; meta.interrupted = { signal, at: new Date().toISOString() };
    try { save(); } catch { /* best effort */ }
    try { proxyChild?.kill("SIGTERM"); } catch { /* gone */ }
    try { redactTree(dir, liveSecrets()); } catch { /* the driver redacts a kept attempt again */ }
    if (!inGuard) process.exit(128 + (constants.signals[signal] ?? 15));
  };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  // Started by the driver: stop when the driver is gone (its children never outlive it).
  const driverPid = Number(process.env.CB_AB_DRIVER_PID ?? 0);
  const watch = driverPid ? setInterval(() => { if (process.ppid !== driverPid) { clearInterval(watch); process.kill(process.pid, "SIGTERM"); } }, 5_000) : undefined;
  watch?.unref();
  try {
    return await unitBody(study, spec, arm, repeat, dir, meta, save, environment, child => { proxyChild = child; }, value => { inGuard = value; });
  } catch (error) {
    if (meta.status !== "interrupted") { meta.status = "error"; meta.error = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000); meta.endedAt = new Date().toISOString(); save(); }
    try { redactTree(dir, liveSecrets()); } catch { /* the driver redacts kept attempts again */ }
    throw error;
  } finally {
    if (watch) clearInterval(watch);
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    if (proxyChild) await stopProxy(proxyChild);
  }
}

async function unitBody(study: string, spec: LoadedCase, arm: Arm, repeat: number, dir: string, meta: Record<string, any>, save: () => void, environment: any, onProxy: (child: ChildProcess) => void, guard: (on: boolean) => void): Promise<Record<string, any>> {
  // Target: a fresh plain-directory copy (no .git, no commit), hashed before the run.
  const target = join(dir, "target");
  makeTarget(spec.sourceDir, target);
  const before = contentHashes(target);
  writeJson(join(dir, "target-before.json"), before);
  meta.target = { files: Object.keys(before).length, digest: sha(JSON.stringify(before)), mount: targetMount(spec.projectDir), git: "none: a plain directory without .git and without any commit" };
  const bin = join(dir, "bin");
  pythonWrappers(bin, { venv: venvMount(spec.projectDir), fallbackRoot: targetMount(spec.projectDir), anchors: rootAnchors(spec.sourceDir), pythonPath: spec.pythonPath });
  const scratch = join(dir, "pi-orche");
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  // Proxy without an envelope (no capUSD): nothing is refused, every request is logged and priced at the catalog's list price.
  writeJson(join(dir, "envelope.json"), { prices: environment.prices });
  const proxy = await startProxy(join(dir, "wire.jsonl"), join(dir, "envelope.json"));
  onProxy(proxy.child);
  meta.proxy = proxy.url;
  const agent = agentDir(dir, join(study, "catalog"), proxy.url);
  const box = sandboxArgs({ agent: agent.dir, target, projectDir: spec.projectDir, venv: spec.venvDir, runtime: join(study, "runtime"), nodeModules: join(REPO, "node_modules"), provider: join(study, "provider"), scratch, bin });
  const env = sandboxEnv(proxy.url, agent.apiKey);
  const argsFile = join(dir, "sandbox.args");
  // The sandbox as Pi will see it (no model involved).
  const probe = sandboxCommand(box, argsFile, ["/bin/sh", "-c", sandboxCheckScript()]);
  const check = await runGuarded(probe.command, probe.args, { env, stdout: join(dir, "sandbox-check.txt"), stderr: join(dir, "sandbox-check.txt"), guardMs: 60_000 });
  meta.sandboxCheck = { exit: check.code, ...parseSandboxCheck(existsSync(join(dir, "sandbox-check.txt")) ? readFileSync(join(dir, "sandbox-check.txt"), "utf8") : "", spec.projectDir) };
  save();
  if (!meta.sandboxCheck.ok) throw new Error(`sandbox check failed: ${meta.sandboxCheck.problems.join("; ")}`);
  // The run.
  const prompt = oneShot(arm, spec.prompt);
  writeFileSync(join(dir, "prompt.txt"), prompt);
  // Arm- and study-neutral: the session id names the run's scratch and records, which the workers see and quote in their reports.
  const sessionId = randomUUID();
  const command = piArgs(sessionId, prompt);
  meta.sessionId = sessionId;
  meta.command = { bwrap: box, argsFile: "sandbox.args", pi: [...command.slice(0, -1), "<prompt.txt>"], promptSha256: sha(prompt), env: Object.keys(env).sort() };
  save();
  guard(true);
  try {
    const pi = sandboxCommand(box, argsFile, command);
    meta.pi = await runGuarded(pi.command, pi.args, { env, stdout: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt"), guardMs: LIMITS.piGuardMs });
  } finally { guard(false); await stopProxy(proxy.child); }
  meta.wallMs = meta.pi.endedAt - meta.pi.startedAt;
  save();
  // Evidence (every step recorded; a failing step never loses the others).
  const errors: string[] = [];
  const step = stepper(errors);
  step("target", () => { const after = contentHashes(target); writeJson(join(dir, "target-after.json"), after); meta.targetCheck = targetCheck(before, after); });
  step("records", () => { if (existsSync(join(agent.dir, "orche/records"))) cpSync(join(agent.dir, "orche/records"), join(dir, "records"), { recursive: true, verbatimSymlinks: true }); });
  step("sessions", () => { if (existsSync(join(agent.dir, "sessions"))) cpSync(join(agent.dir, "sessions"), join(dir, "sessions"), { recursive: true, verbatimSymlinks: true }); });
  step("config", () => { mkdirSync(join(dir, "config"), { recursive: true }); for (const name of ["settings.json", "orche.config.json"]) cpSync(join(agent.dir, name), join(dir, "config", name)); meta.configSha256 = sha(readFileSync(join(dir, "config/orche.config.json"))); });
  const wire = (step("wire", () => readJsonl(join(dir, "wire.jsonl"))) ?? []) as WireEntry[];
  const transcripts = step("transcripts", () => sessionTranscripts(sessionId, join(dir, "records"), join(dir, "sessions"))) ?? new Map();
  const tasks = step("tasks", () => taskRuns(join(dir, "records"))) ?? [];
  const explorers = step("explorers", () => explorerIds(arm, transcripts, tasks)) ?? new Set<string>();
  step("final", () => {
    const report = finalReport(tasks, transcripts);
    const text = finalText(readJsonl(join(dir, "events.jsonl")));
    const final = { report, text, reportSha256: report ? sha(JSON.stringify(report)) : null, textSha256: sha(text), frozenAt: new Date().toISOString() };
    writeJson(join(dir, "final.json"), final);
    meta.final = { report: !!report, reportChars: report ? JSON.stringify(report).length : 0, textChars: text.length, reportSha256: final.reportSha256, textSha256: final.textSha256 };
  });
  step("route", () => {
    const route = routeFidelity(wire, transcripts, explorers, dir);
    writeJson(join(dir, "route.json"), route);
    meta.route = { ok: route.ok, requests: route.requests, posts: route.posts, violations: route.violations.length, byKind: route.byKind, byRole: route.byRole, sessions: route.sessions, first: route.violations.slice(0, 20) };
  });
  step("compliance", () => { meta.compliance = compliance(arm, spec.prompt, transcripts, tasks, wire); });
  step("audit", () => {
    const audit = auditTranscripts(transcripts, [spec.prompt, ...(arm === "A" ? [] : [briefOf(arm)])]);
    writeJson(join(dir, "audit.json"), audit);
    meta.audit = { calls: audit.calls, hits: audit.hits.length, byRule: audit.byRule, clean: audit.clean, first: audit.hits.slice(0, 20) };
  });
  step("usage", () => { meta.usage = usageByRole(wire, transcripts, explorers); });
  step("tasks", () => { meta.tasks = taskStatuses(tasks); });
  step("wire", () => {
    const requests = wire.filter(entry => entry.method === "POST" && entry.model);
    meta.wire = { ...wireStats(requests), totals: existsSync(join(dir, "wire.jsonl.totals.json")) ? readJson(join(dir, "wire.jsonl.totals.json")) : undefined };
    meta.successfulRequests = requests.filter(successful).length;
    meta.infra = meta.successfulRequests === 0;
  });
  // Credentials never stay in the evidence: the agent dir (provider connection with the API key) is removed after its records and
  // sessions were copied; an unchanged target copy is removed (its hashes stay); the runtime's compile caches (jiti, node) in the
  // scratch TMPDIR are dropped, and so is any other scratch file above 5 MB (listed).
  step("cleanup", () => {
    rmSync(agent.dir, { recursive: true, force: true });
    if (meta.targetCheck?.unchanged) rmSync(target, { recursive: true, force: true });
    for (const name of ["jiti", "node-compile-cache"]) rmSync(join(scratch, "tmp", name), { recursive: true, force: true });
    const pruned: string[] = [];
    for (const file of allFiles(scratch)) { try { if (lstatSync(file).isFile() && lstatSync(file).size > 5 * 1024 * 1024) { rmSync(file); pruned.push(relative(dir, file)); } } catch { /* gone */ } }
    meta.scratchPruned = pruned;
  });
  step("redaction", () => { const result = redactTree(dir, agent.secrets); meta.redaction = { files: result.files.map(file => relative(dir, file)), remaining: result.remaining.map(file => relative(dir, file)), secrets: agent.secrets.length }; });
  meta.evidenceErrors = errors;
  meta.endedAt = new Date().toISOString();
  meta.status = "completed";
  save();
  console.log(`END ${meta.unit}: exit ${meta.pi.code}${meta.pi.signal ? ` ${meta.pi.signal}` : ""}${meta.pi.guardFired ? " (guard)" : ""}, ${Math.round(meta.wallMs / 1000)} s, ${meta.usage?.total?.requests ?? "?"} requests, $${meta.usage?.total?.costUSD ?? "?"}, route violations ${meta.route?.violations ?? "?"}, audit hits ${meta.audit?.hits ?? "?"}, report ${meta.final?.report ? "yes" : "no"}, target unchanged ${meta.targetCheck?.unchanged}`);
  return meta;
}

// ---- toy case (preflight) ------------------------------------------------------------------------------------------------------------

export const TOY = {
  id: "toy", order: 1, task: "toy-tinystats", repo: "example/tinystats", baseCommit: "5f0c2a91d3e7b48c6a1f9e2d0b7c3a8e4f6d1b29", projectDir: "tinystats", pythonPath: ".",
  /** The isort task's venv (stdlib + pytest suffice for the toy; its installed isort is irrelevant). */
  venv: "results/advisor-reviewer/cache/swe/pycqa__isort-2491/venv",
  problemStatement: [
    "median() returns the wrong value for lists with an even number of elements",
    "",
    "`median([1, 2, 3, 4])` returns `3`. The docstring says that for an even number of values the median is the mean of the two middle values, so I expected `2.5`. `median([3, 1, 2])` returns `2` as expected.",
  ].join("\n"),
  files: {
    "pyproject.toml": "[project]\nname = \"tinystats\"\nversion = \"0.1.0\"\ndescription = \"Tiny descriptive statistics helpers.\"\nrequires-python = \">=3.9\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
    "README.md": "# tinystats\n\nTiny descriptive statistics helpers: `mean` and `median` of a list of numbers.\n",
    "tinystats/__init__.py": "from .core import mean, median\n\n__all__ = [\"mean\", \"median\"]\n",
    "tinystats/core.py": "\"\"\"Descriptive statistics for small lists of numbers.\"\"\"\n\n\ndef mean(values):\n    \"\"\"Arithmetic mean of a non-empty sequence of numbers.\"\"\"\n    if not values:\n        raise ValueError(\"mean() of an empty sequence\")\n    return sum(values) / len(values)\n\n\ndef median(values):\n    \"\"\"Median of a non-empty sequence of numbers.\n\n    For an even number of values the median is the mean of the two middle values.\n    \"\"\"\n    if not values:\n        raise ValueError(\"median() of an empty sequence\")\n    ordered = sorted(values)\n    middle = len(ordered) // 2\n    return ordered[middle]\n",
    "tests/test_core.py": "from tinystats import mean, median\n\n\ndef test_mean():\n    assert mean([1, 2, 3]) == 2\n\n\ndef test_median_odd():\n    assert median([3, 1, 2]) == 2\n",
  } as Record<string, string>,
};

/** Write the toy case directory (a tiny package with one planted defect: median of an even-length list) with its case.json. */
export function writeToyCase(caseDir: string, repo = REPO): Record<string, unknown> {
  const dir = resolve(caseDir);
  if (existsSync(join(dir, "case.json"))) throw new Error(`${dir}/case.json exists: the toy case is written once`);
  for (const [path, text] of Object.entries(TOY.files)) { mkdirSync(dirname(join(dir, "src", path)), { recursive: true }); writeFileSync(join(dir, "src", path), text); }
  const prompt = diagnosisPrompt({ repo: TOY.repo, baseCommit: TOY.baseCommit, problemStatement: TOY.problemStatement });
  const spec = { id: TOY.id, order: TOY.order, task: TOY.task, repo: TOY.repo, baseCommit: TOY.baseCommit, projectDir: TOY.projectDir, pythonPath: TOY.pythonPath, prompt, promptSha256: sha(prompt), source: relative(repo, join(dir, "src")), venv: TOY.venv };
  writeJson(join(dir, "case.json"), spec);
  return spec;
}

// ---- the frozen copy -----------------------------------------------------------------------------------------------------------------

/**
 * `unit` and `driver` run the study's frozen harness. Started from anywhere else, this re-runs the same command from
 * <study>/harness/experiments/cb-ab/run.ts (cwd = the repository, for tsx) and returns its exit code; signals are forwarded.
 */
export function delegateToFrozen(studyDir: string, argv: readonly string[]): Promise<number> | undefined {
  const harness = join(resolve(studyDir), "harness");
  if (FROZEN_ROOT === harness) return undefined;
  if (FROZEN_ROOT) throw new Error(`this is the frozen harness of ${dirname(FROZEN_ROOT)}, not of ${resolve(studyDir)}`);
  const entry = join(harness, HARNESS_ENTRY);
  if (!existsSync(entry) || !existsSync(join(harness, HARNESS_FILE))) throw new Error(`${resolve(studyDir)} has no frozen harness (run prepare first)`);
  const changed = harnessIntact(harness);
  if (changed.length) throw new Error(`the frozen harness differs from its harness.json: ${changed.join(", ")}`);
  return new Promise(done => {
    const child = spawn(NODE, ["--import", "tsx", entry, ...argv], { cwd: REPO, stdio: "inherit", env: process.env });
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* gone */ } };
    process.on("SIGTERM", forward); process.on("SIGINT", forward);
    child.once("close", (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] ?? 15 : 1)));
  });
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------------------

const USAGE = "usage: run.ts prepare <study> | unit <study> <caseDir> <A|B|C> <repeat> [--preflight] | driver <study> --cases <dir,...> --concurrency N [--preflight] [--arms A[,B,C]] | status <study> | summarize <study> | toy-case <caseDir> | selfcheck";
const option = (argv: readonly string[], name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };

export async function main(argv: readonly string[]): Promise<number> {
  const [command, first] = argv;
  const preflight = argv.includes("--preflight");
  if (command === "selfcheck") { console.log(JSON.stringify({ running: fileURLToPath(import.meta.url), frozenRoot: FROZEN_ROOT ?? null, repo: REPO, changed: FROZEN_ROOT ? harnessIntact(FROZEN_ROOT) : null, arms: ARMS, model: MODEL.id })); return 0; }
  if (!first) throw new Error(USAGE);
  if (command === "prepare") { const environment = prepare(first) as any; console.log(`prepared ${first}: runtime ${environment.runtime.head.slice(0, 12)} (${environment.runtime.files} files, digest ${environment.runtime.digest.slice(0, 12)}, matches protocol head ${environment.runtime.matchesProtocolHead}), harness ${environment.harness.digest.slice(0, 12)} (${Object.keys(environment.harness.files).length} files), provider ${environment.provider.version}, pi ${environment.pi.version}`); return 0; }
  if (command === "toy-case") { const spec = writeToyCase(first) as any; console.log(`toy case ${first}: prompt ${spec.promptSha256.slice(0, 12)} (${spec.prompt.length} chars)`); return 0; }
  if (command === "status") { console.log(driverStatus(first)); return 0; }
  if (command === "summarize") { const out = summarize(first); console.log(out.markdown); return 0; }
  if (command === "unit" || command === "driver") {
    const delegated = delegateToFrozen(first, argv);
    if (delegated) return delegated;
    if (command === "unit") {
      const [, , caseDir, arm, repeat] = argv;
      if (!caseDir || !arm || !repeat) throw new Error(USAGE);
      const meta = await runUnit(first, caseDir, arm, Number(repeat), { preflight });
      return meta.status === "completed" ? 0 : 1;
    }
    const cases = option(argv, "--cases"), concurrency = Number(option(argv, "--concurrency") ?? "");
    if (!cases || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error(USAGE);
    // --arms: only these arms' units (round-2 calibration runs arm A only); without it every arm runs, as in round 1.
    const armsOption = option(argv, "--arms");
    const arms = armsOption === undefined ? undefined : armsOption.split(",").filter(Boolean);
    if (arms && (!arms.length || arms.some(arm => !isArm(arm)))) throw new Error(`--arms must list arms of ${ARMS.join(", ")}`);
    const result = await runDriver({ study: first, caseDirs: cases.split(",").filter(Boolean), concurrency, preflight, signals: true, ...(arms ? { arms: arms as Arm[] } : {}) });
    return result.stopped ? 143 : result.failed ? 1 : 0;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
